import { API } from './utils/api.js';
import { Storage, DEFAULT_AUTO_CONFIG } from './utils/storage.js';
import { tenantUrl, getTenantSubdomain } from './utils/tenant.js';
import { fetchBirthdays } from './utils/birthdays.js';
import { fetchTodayAttendance } from './utils/attendance.js';
import { getDayStatus, getTargetHours, getInboxCounts, KEKA_ROUTES } from './utils/workday.js';
import { dateKey, hhmmToMinutes, minutesToHHMM, minutesOfDay, formatDuration, formatClock } from './utils/time.js';

const DEFAULT_TARGET_HOURS = 8; // used until the shift length is known
const BADGE_REFRESH_MIN = 1;
const ALARM_AUTO_CLOCK_IN = 'auto_clock_in';
const ALARM_BREAK_END = 'break_end';
// A break_end alarm that fires later than this (e.g. Chrome was closed or the
// laptop slept through it) must not punch you in hours later.
const BREAK_END_GRACE_MS = 10 * 60 * 1000;
// If Chrome starts after your auto clock-in time, catch up within this window;
// later than that, skip the day and say so.
const AUTO_IN_CATCH_UP_MIN = 60;

// All punching automation (tick, auto clock-in, break end, notification
// buttons) runs one at a time. Each guard reads a "done today" marker and
// then punches; without this, two runs could both pass the guard.
function withAutomationLock(fn) {
  return navigator.locks.request('shiftmate-automation', fn);
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  await scheduleAutoClockInAlarm();
  await tick();
});
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  // May replace today's pending alarm with tomorrow's; tick() catches up.
  await scheduleAutoClockInAlarm();
  await tick();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_BREAK_END) {
    await withAutomationLock(endBreak);
    await tick();
  } else if (alarm.name === 'badge_refresh') {
    await tick();
  } else if (alarm.name === ALARM_AUTO_CLOCK_IN) {
    // Chrome fires a missed alarm when the laptop wakes — possibly hours
    // late. Only punch inside the catch-up window; beyond it, tick() skips
    // the day and says so.
    await withAutomationLock(async () => {
      const cfg = await getAutoConfig();
      const late = minutesOfDay() - (hhmmToMinutes(cfg.inTime) ?? 0);
      if (late >= 0 && late <= AUTO_IN_CATCH_UP_MIN) await runAutoClockIn(cfg);
    });
    await scheduleAutoClockInAlarm(); // next day
    await tick();
  }
});

// Action buttons on the "still clocked in after auto-out" reprompt.
const NOTIF_AUTO_OUT_REPROMPT = 'auto_out_reprompt';
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId !== NOTIF_AUTO_OUT_REPROMPT) return;
  chrome.notifications.clear(notificationId);
  if (buttonIndex !== 0) return; // 1 = "I'll do it manually" — leave the user alone
  await withAutomationLock(async () => {
    try {
      // The notification stays up until clicked — maybe the next morning.
      // Only punch out if it's still that day and you're still clocked in.
      const markers = await getMarkers();
      if (markers.lastAutoOutPromptDate !== dateKey()) return;
      if (!(await fetchTodayAttendance()).isClockedIn) return;
      const res = await API.clockInOrOut('OUT');
      if (res.ok) notifyUser('Peace out ✌️', 'You’re clocked OUT. See you tomorrow!');
      else notifyUser('Punch out failed 😬', 'Could not punch out. Please do it manually.');
    } catch (e) {
      notifyUser('Punch Out Error', e.message || 'Unexpected error');
    }
  });
  await tick();
});

// Clicking an informational notification opens the matching Keka page.
const NOTIF_BIRTHDAYS = 'birthdays_today';
const NOTIF_APPROVALS = 'pending_approvals';
const NOTIF_ROUTES = {
  [NOTIF_BIRTHDAYS]: KEKA_ROUTES.dashboard,
  [NOTIF_APPROVALS]: KEKA_ROUTES.approvals
};
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const route = NOTIF_ROUTES[notificationId];
  if (!route) return;
  chrome.notifications.clear(notificationId);
  try {
    chrome.tabs.create({ url: await tenantUrl(route) });
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  if (msg.type === 'badge_refresh') {
    tick().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'auto_config_changed') {
    scheduleAutoClockInAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Reschedule when settings change from any context (popup writing to sync storage).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[Storage.KEYS.AUTO_CONFIG]) scheduleAutoClockInAlarm();
});

// === Break end ===

async function endBreak() {
  const { [Storage.KEYS.ACTIVE_BREAK]: active } = await Storage.get(Storage.KEYS.ACTIVE_BREAK);
  // No record → the user already returned ("Return now" clears it).
  if (!active || !active.returnAt) return;

  if (Date.now() - active.returnAt > BREAK_END_GRACE_MS) {
    await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
    notifyUser('Break ended while you were away 👻',
      `Your break was due to end at ${formatClock(active.returnAt)}, but Chrome was asleep too. We didn't punch you in — do it yourself if you're working.`);
    return;
  }

  try {
    // Already back (punched in by hand, on another device or in Keka)?
    const now = await fetchTodayAttendance();
    if (now.isClockedIn) {
      await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
      return;
    }
    // Break runs past auto clock-out (e.g. 18:00 + 45 min, auto-out 18:30)?
    // Punching back in would look like deliberate overtime to the auto-out
    // rule and leave you clocked in all night — so call it a day instead.
    const cfg = await getAutoConfig();
    const outMin = cfg.outThresholdMin || DEFAULT_AUTO_CONFIG.outThresholdMin;
    if (cfg.outEnabled && minutesOfDay() >= outMin) {
      await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
      await setMarker('lastAutoOutDate', dateKey());
      notifyUser('Break → home time 🏠',
        `Your break ran past your ${minutesToHHMM(outMin)} clock-out, so we left you punched OUT. Smooth exit 😎`);
      return;
    }
    const response = await API.clockInOrOut('IN');
    if (response.ok) {
      notifyUser('Break’s over ⏰', 'I’ll be back… and you are! Auto punched IN 🤖');
    } else {
      notifyUser('Break’s over — punch failed 😬', 'We couldn’t punch you back IN. Please do it manually.');
    }
  } catch (error) {
    notifyUser('Break’s over — something broke 🛠️', error.message || 'Unexpected error');
  }
  await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
}

// === Toolbar badge / tooltip ===

// Fetch today's attendance and update the toolbar (badge, tooltip).
// Returns the snapshot, or null when the state couldn't be determined.
async function refreshBadge() {
  const { snapshot, reason } = await loadTodaySnapshot();
  await applyActionUi(snapshot, reason);
  return snapshot;
}

// Per-minute task. Overlapping callers (alarm + popup message) share one run.
let tickInFlight = null;
function tick() {
  if (!tickInFlight) {
    tickInFlight = withAutomationLock(runTick).finally(() => { tickInFlight = null; });
  }
  return tickInFlight;
}

async function runTick() {
  const snapshot = await refreshBadge();
  if (!snapshot) return;
  const cfg = await getAutoConfig(); // read settings once per tick
  await maybeCatchUpAutoClockIn(snapshot, cfg);
  // A break that just started makes this snapshot stale (we're now clocked
  // out), so skip auto clock-out until the next tick.
  if (!(await maybeAutoBreak(snapshot, cfg))) await maybeAutoClockOut(snapshot, cfg);
  await maybeNotifyBirthdays(cfg);
  await maybeCheckInbox(cfg);
}

// Returns { snapshot } on success, or { snapshot: null, reason } where reason
// is one of 'signed_out' | 'no_tenant' | 'error'.
async function loadTodaySnapshot() {
  try {
    const { [Storage.KEYS.REFRESH_TOKEN]: token } = await Storage.get(Storage.KEYS.REFRESH_TOKEN);
    if (!token) return { snapshot: null, reason: 'signed_out' };
    // No tenant configured yet → can't fetch (popup will guide the user).
    if (!(await getTenantSubdomain())) return { snapshot: null, reason: 'no_tenant' };
    return { snapshot: await fetchTodayAttendance() };
  } catch (_) {
    return { snapshot: null, reason: 'error' };
  }
}

const UNKNOWN_TITLES = {
  signed_out: 'Not signed in — click me to sign in 👋',
  no_tenant: 'Set up your Keka company URL to get started',
  error: "Couldn't reach Keka — this is fine 🔥"
};

async function applyActionUi(snapshot, reason) {
  let title;
  if (snapshot) {
    // Target = today's shift length from Keka (e.g. 8.5h), else 8h.
    const target = (await getTargetHours()) || DEFAULT_TARGET_HOURS;
    title = `${snapshot.isClockedIn ? 'Clocked in' : 'Clocked out'} · ${formatDuration(snapshot.durationMs)} of ${target}h today`;
    applyBadge(snapshot.durationMs, target);
  } else {
    // Don't keep showing hours we can't verify.
    title = UNKNOWN_TITLES[reason] || UNKNOWN_TITLES.error;
    chrome.action.setBadgeText({ text: '' });
  }
  // The toolbar icon stays the pumpkin (enlarged so its eyes show above the
  // badge, which sits where the mouth is); state is in the tooltip and badge.
  chrome.action.setTitle({ title: `ShiftMate — ${title}` });
}

function applyBadge(durationMs, targetHours = DEFAULT_TARGET_HOURS) {
  // Nothing worked yet (or under a minute): no "0:00" badge covering the icon.
  if (!durationMs || durationMs < 60000) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  // Red (239,83,80) at 0h → Green (102,187,106) at the target
  const t = Math.max(0, Math.min(1, durationMs / (targetHours * 3600000)));
  const r = Math.round(239 + (102 - 239) * t);
  const g = Math.round(83 + (187 - 83) * t);
  const b = Math.round(80 + (106 - 80) * t);

  const totalMin = Math.floor(durationMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  // Badge max ~4 chars. h:mm fits up to 9:59; for 10h+ fall back to "10h"
  const text = h >= 10 ? `${h}h` : `${h}:${m.toString().padStart(2, '0')}`;

  chrome.action.setBadgeBackgroundColor({ color: [r, g, b, 255] });
  chrome.action.setBadgeText({ text });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

function notifyUser(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/smily-pumpkin-128.png'),
    title,
    message
  });
}

function promptReclockOut(thresholdMin) {
  chrome.notifications.create(NOTIF_AUTO_OUT_REPROMPT, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/smily-pumpkin-128.png'),
    title: 'Still here? 👀',
    message: `It's past your ${minutesToHHMM(thresholdMin)} clock-out and you punched back in. Workaholic much? Punch out now, or handle it yourself?`,
    buttons: [{ title: 'Punch me out 🏃' }, { title: "I'm on it, leave me be" }],
    requireInteraction: true,
    priority: 2
  });
}

// === Birthday reminders ===

const BIRTHDAY_NOTIFY_FROM_MIN = 9 * 60; // not before 09:00 local

// At most one check per day: on the first tick at/after 09:00, fetch today's
// birthdays and show a single notification if there are any.
async function maybeNotifyBirthdays(cfg) {
  if (cfg.birthdayNotify === false) return;
  if (minutesOfDay() < BIRTHDAY_NOTIFY_FROM_MIN) return;

  const today = dateKey();
  const markers = await getMarkers();
  if (markers.lastBirthdayCheckDate === today) return;

  try {
    const { hidden, items } = await fetchBirthdays();
    await setMarker('lastBirthdayCheckDate', today);
    if (hidden) return;
    const todays = items.filter(b => b.daysAway === 0);
    if (!todays.length) return;

    const names = todays.map(b => b.name);
    const message = names.length === 1
      ? `${names[0]}${todays[0].jobTitle ? ` (${todays[0].jobTitle})` : ''} has a birthday today. Click to wish them on Keka.`
      : names.length === 2
        ? `${names[0]} and ${names[1]} have birthdays today.`
        : `${names[0]}, ${names[1]} and ${names.length - 2} more have birthdays today.`;
    chrome.notifications.create(NOTIF_BIRTHDAYS, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/icons/smily-pumpkin-128.png'),
      title: names.length === 1 ? '🎂 Birthday today' : `🎂 ${names.length} birthdays today`,
      message
    });
  } catch (e) {
    // Leave the marker unset so the next tick retries.
    console.warn('[ShiftMate] birthday check failed', e);
  }
}

// === Auto break ===

// Once a day, inside the configured window, punch OUT and schedule the
// break_end alarm to punch back IN after breakMinutes. The break is kept
// inside the window: it only starts while there's still room for the full
// length (latest start = breakTo − breakMinutes).
// Resolves to true only when a break was started.
async function maybeAutoBreak(snapshot, cfg, now = new Date()) {
  if (!cfg.breakEnabled || !snapshot.isClockedIn) return false;
  const from = hhmmToMinutes(cfg.breakFrom);
  const to = hhmmToMinutes(cfg.breakTo);
  const minutes = Math.max(1, parseInt(cfg.breakMinutes, 10) || 0);
  if (from === null || to === null || to - from < minutes) return false;

  const nowMin = minutesOfDay(now);
  if (nowMin < from || nowMin > to - minutes) return false;

  const today = dateKey(now);
  const markers = await getMarkers();
  if (markers.lastAutoBreakDate === today) return false;

  // Already on a (manual) break, or already took one in this window today
  // (an OUT punch inside the window) → don't add another.
  const { [Storage.KEYS.ACTIVE_BREAK]: active } = await Storage.get(Storage.KEYS.ACTIVE_BREAK);
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, from).getTime();
  const tookBreak = snapshot.entries.some(e =>
    e.punchStatus === 1 && new Date(e.timestamp).getTime() >= windowStart);
  if ((active && active.returnAt > Date.now()) || tookBreak) {
    await setMarker('lastAutoBreakDate', today);
    return false;
  }

  // Mark first so a slow punch can't trigger a second break next minute.
  await setMarker('lastAutoBreakDate', today);
  try {
    const res = await API.clockInOrOut('OUT');
    if (!res.ok) {
      notifyUser('Lunch plans ruined 😩', 'Couldn’t punch you OUT for your auto break. Take it manually if you need to.');
      return false;
    }
    const returnAt = Date.now() + minutes * 60 * 1000;
    await Storage.set({
      [Storage.KEYS.ACTIVE_BREAK]: { startedAt: Date.now(), returnAt, durationMin: minutes, auto: true }
    });
    chrome.alarms.create(ALARM_BREAK_END, { when: returnAt });
    notifyUser('Lunch time! 🍝', `Punched OUT for ${minutes} min — back IN at ${formatClock(returnAt)}. Enjoy!`);
    await refreshBadge();
    return true;
  } catch (e) {
    notifyUser('Auto break hiccup 🛠️', e.message || 'Unexpected error');
    return false;
  }
}

// === Pending approvals & unread notifications ===

const INBOX_POLL_MS = 5 * 60 * 1000;

// Every 5 minutes: refresh the counts the popup shows, and notify when the
// number of requests waiting for your approval goes up.
async function maybeCheckInbox(cfg) {
  const { [Storage.KEYS.INBOX_STATE]: prev } = await Storage.get(Storage.KEYS.INBOX_STATE);
  if (prev && Date.now() - (prev.checkedAt || 0) < INBOX_POLL_MS) return;

  const counts = await getInboxCounts();
  await Storage.set({ [Storage.KEYS.INBOX_STATE]: { ...counts, checkedAt: Date.now() } });

  const before = prev?.approvals;
  if (cfg.approvalNotify !== false && typeof counts.approvals === 'number'
      && typeof before === 'number' && counts.approvals > before) {
    const n = counts.approvals;
    chrome.notifications.create(NOTIF_APPROVALS, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('src/icons/smily-pumpkin-128.png'),
      title: 'Someone needs your blessing 🙏',
      message: n === 1 ? '1 request is waiting for your approval.' : `${n} requests are waiting for your approval. Main character energy ✨`
    });
  }
}

// === Automation: auto clock-in / auto clock-out ===

async function getAutoConfig() {
  const { [Storage.KEYS.AUTO_CONFIG]: cfg } = await Storage.get(Storage.KEYS.AUTO_CONFIG);
  return { ...DEFAULT_AUTO_CONFIG, ...(cfg || {}) };
}

async function getMarkers() {
  const { [Storage.KEYS.AUTO_MARKERS]: m } = await Storage.get(Storage.KEYS.AUTO_MARKERS);
  return m || {};
}

async function setMarker(key, value) {
  const markers = await getMarkers();
  markers[key] = value;
  await Storage.set({ [Storage.KEYS.AUTO_MARKERS]: markers });
}

// A rejected automatic punch (e.g. 403: web clock-in disabled, location
// rule) would otherwise retry — and notify — every minute. Retry quietly
// after 5 and 15 minutes, then give up for the day. Notify on the first only.
const RETRY_AFTER_MIN = [5, 15];
async function mayAttempt(kind, today) {
  const f = (await getMarkers())[`${kind}Fail`];
  if (!f || f.date !== today) return true;
  if (f.count > RETRY_AFTER_MIN.length) return false;
  return Date.now() - f.at >= RETRY_AFTER_MIN[f.count - 1] * 60000;
}
// Returns true when this is today's first failure (→ tell the user).
async function recordFailure(kind, today) {
  const f = (await getMarkers())[`${kind}Fail`];
  const count = f && f.date === today ? f.count + 1 : 1;
  await setMarker(`${kind}Fail`, { date: today, count, at: Date.now() });
  return count === 1;
}
const RETRY_NOTE = 'We’ll quietly retry twice, then leave it to you.';

// Parse "HH:MM" and return the next Date at that local time (today if still
// in the future, otherwise tomorrow).
function nextOccurrenceOf(hhmm) {
  const min = hhmmToMinutes(hhmm) ?? 0;
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, min, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

async function scheduleAutoClockInAlarm() {
  await chrome.alarms.clear(ALARM_AUTO_CLOCK_IN);
  const cfg = await getAutoConfig();
  if (!cfg.inEnabled || !cfg.inTime) return;
  chrome.alarms.create(ALARM_AUTO_CLOCK_IN, { when: nextOccurrenceOf(cfg.inTime).getTime() });
}

// Chrome started (or woke) after today's clock-in time and the alarm was
// rescheduled for tomorrow: catch up shortly after, or skip the day openly.
async function maybeCatchUpAutoClockIn(snapshot, cfg) {
  if (!cfg.inEnabled) return;
  const inMin = hhmmToMinutes(cfg.inTime);
  if (inMin === null) return;
  const nowMin = minutesOfDay();
  if (nowMin < inMin) return;
  const today = dateKey();
  const markers = await getMarkers();
  if (markers.lastAutoInDate === today) return;

  if (nowMin - inMin <= AUTO_IN_CATCH_UP_MIN) {
    await runAutoClockIn(cfg, snapshot);
    return;
  }
  await setMarker('lastAutoInDate', today);
  if (snapshot.entries.length === 0) {
    const day = await getDayStatus().catch(() => ({ off: false }));
    if (day.off) return; // weekend / holiday / leave: sleeping in is allowed
    notifyUser('Overslept? 😴',
      `Chrome wasn't running at your ${cfg.inTime} clock-in time, so we didn't punch you in. Do it yourself if you're working.`);
  }
}

// Call only while holding the automation lock.
async function runAutoClockIn(cfg, snapshot = null) {
  try {
    if (!cfg.inEnabled) return;
    const today = dateKey();
    const markers = await getMarkers();
    if (markers.lastAutoInDate === today) return; // safety against double-fire
    if (!(await mayAttempt('autoIn', today))) return;

    // Don't punch in on holidays, weekly offs or full-day leave.
    if (cfg.skipDaysOff !== false) {
      const day = await getDayStatus();
      if (day.off) {
        await setMarker('lastAutoInDate', today); // don't reconsider today
        notifyUser('Day off detected 🏖️', `${day.reason} — no punch today. Go touch grass 🌿`);
        return;
      }
    }

    const current = snapshot || (await loadTodaySnapshot()).snapshot;
    if (!current) return; // no auth or fetch failed; retry on a later tick

    // Smart rule: only auto clock-in if there are ZERO punches today.
    if (current.entries.length > 0) {
      await setMarker('lastAutoInDate', today);
      return;
    }

    const res = await API.clockInOrOut('IN');
    if (res.ok) {
      await setMarker('lastAutoInDate', today);
      notifyUser('Ah, here we go again ☀️', `Auto punched IN at ${formatClock(Date.now())}. Coffee’s on you ☕`);
    } else if (await recordFailure('autoIn', today)) {
      notifyUser('Auto clock-in failed 😬', `Keka said no (${res.status}). Please punch IN manually. ${RETRY_NOTE}`);
    }
  } catch (e) {
    if (await recordFailure('autoIn', dateKey())) {
      notifyUser('Auto clock-in hiccup 🛠️', `${e.message || 'Unexpected error'}. ${RETRY_NOTE}`);
    }
  }
}

async function maybeAutoClockOut(snapshot, cfg) {
  if (!cfg.outEnabled || !snapshot.isClockedIn) return;

  // outThresholdMin is a wall-clock time stored as minutes-since-midnight
  // (so 1080 = 18:00 local). Fire once we cross that time today.
  const thresholdMin = cfg.outThresholdMin || DEFAULT_AUTO_CONFIG.outThresholdMin;
  const now = new Date();
  if (minutesOfDay(now) < thresholdMin) return;

  const markers = await getMarkers();
  const today = dateKey(now);
  if (markers.lastAutoOutDate === today) {
    // Already auto-clocked-out today, but the user re-punched in and is
    // still past the threshold. Don't silently punch them again — ask once.
    if (markers.lastAutoOutPromptDate !== today) {
      await setMarker('lastAutoOutPromptDate', today);
      promptReclockOut(thresholdMin);
    }
    return;
  }

  // Punched in at/after the clock-out time (e.g. out at 18:00 by hand, back
  // at 21:00 to work) → that's deliberate; leave it alone.
  const lastIn = snapshot.lastIn;
  if (lastIn && dateKey(lastIn) === today && minutesOfDay(lastIn) >= thresholdMin) return;
  if (!(await mayAttempt('autoOut', today))) return;

  try {
    const res = await API.clockInOrOut('OUT');
    if (res.ok) {
      await setMarker('lastAutoOutDate', today);
      notifyUser('It ain’t much, but it’s honest work 🧑‍🌾', `It’s ${minutesToHHMM(thresholdMin)} — auto punched OUT. Go home! 🏠`);
    } else if (await recordFailure('autoOut', today)) {
      notifyUser('Auto clock-out failed 😬', `Keka said no (${res.status}). Please punch OUT manually. ${RETRY_NOTE}`);
    }
  } catch (e) {
    if (await recordFailure('autoOut', today)) {
      notifyUser('Auto clock-out hiccup 🛠️', `${e.message || 'Unexpected error'}. ${RETRY_NOTE}`);
    }
  }
}
