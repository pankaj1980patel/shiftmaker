import { API } from './utils/api.js';
import { Storage, DEFAULT_AUTO_CONFIG } from './utils/storage.js';
import { tenantUrl, getTenantSubdomain } from './utils/tenant.js';

const TARGET_HOURS = 8;
const BADGE_REFRESH_MIN = 1;
const ALARM_AUTO_CLOCK_IN = 'auto_clock_in';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  await scheduleAutoClockInAlarm();
  await tick();
});
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  await scheduleAutoClockInAlarm();
  await tick();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'break_end') {
    await endBreak();
    await refreshBadge();
  } else if (alarm.name === 'badge_refresh') {
    await tick();
  } else if (alarm.name === ALARM_AUTO_CLOCK_IN) {
    await runAutoClockIn();
    // Reschedule for the next occurrence (next day at configured time)
    await scheduleAutoClockInAlarm();
    await tick();
  }
});

// Action buttons on the "still clocked in after auto-out" reprompt.
const NOTIF_AUTO_OUT_REPROMPT = 'auto_out_reprompt';
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (notificationId !== NOTIF_AUTO_OUT_REPROMPT) return;
  chrome.notifications.clear(notificationId);
  if (buttonIndex !== 0) return; // 1 = "I'll do it manually" — leave the user alone
  try {
    const res = await API.clockInOrOut('OUT');
    if (res.ok) {
      notifyUser('Punched Out', 'You are clocked OUT.');
      await tick();
    } else {
      notifyUser('Punch Out Failed', 'Could not punch out. Please punch out manually.');
    }
  } catch (e) {
    notifyUser('Punch Out Error', e.message || 'Unexpected error');
  }
});
chrome.notifications.onClosed.addListener((notificationId) => {
  if (notificationId === NOTIF_AUTO_OUT_REPROMPT) {
    // No-op — the daily marker already prevents another prompt today.
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
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
  if (area !== 'sync') return;
  if (changes[Storage.KEYS.AUTO_CONFIG]) {
    scheduleAutoClockInAlarm();
  }
});

async function endBreak() {
  try {
    const response = await API.clockInOrOut('IN');
    if (response.ok) {
      notifyUser('Break Over', 'Welcome back — you have been auto clocked IN.');
    } else {
      notifyUser('Break Over — Punch Failed', 'Auto clock-in failed. Please punch in manually.');
    }
  } catch (error) {
    notifyUser('Break Over — Error', error.message);
  }
  await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
}

async function refreshBadge() {
  const snapshot = await fetchTodaySnapshot();
  if (!snapshot) return;
  applyBadge(snapshot.durationMs);
}

// Combined per-minute task: refresh the badge AND check auto clock-out.
// Both need the same attendance fetch, so we share one round-trip.
async function tick() {
  const snapshot = await fetchTodaySnapshot();
  if (!snapshot) return;
  applyBadge(snapshot.durationMs);
  await maybeAutoClockOut(snapshot);
}

async function fetchTodaySnapshot() {
  try {
    const { [Storage.KEYS.REFRESH_TOKEN]: token } = await Storage.get(Storage.KEYS.REFRESH_TOKEN);
    if (!token) {
      chrome.action.setBadgeText({ text: '' });
      return null;
    }
    // No tenant configured yet → can't fetch. Stay silent (popup will guide
    // the user through setup).
    if (!(await getTenantSubdomain())) return null;
    const url = await tenantUrl('/k/attendance/api/mytime/attendance/attendancedayrequests');
    const r = await API.request(url);
    if (!r.ok) return null;
    let d = await r.json();
    if (d.data) d = d.data;
    const entries = [
      ...(d.webclockin?.flatMap(x => x.timeEntries || []) || []),
      ...(d.remoteclockin?.flatMap(x => x.timeEntries || []) || [])
    ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const durationMs = calculateDurationMs(entries);
    const last = entries[entries.length - 1];
    const isClockedIn = !!last && last.punchStatus === 0;
    return { entries, durationMs, isClockedIn };
  } catch (_) {
    return null;
  }
}

function calculateDurationMs(entries) {
  let total = 0;
  let inTime = null;
  for (const e of entries) {
    if (e.punchStatus === 0) {
      inTime = new Date(e.timestamp);
    } else if (e.punchStatus === 1 && inTime) {
      total += new Date(e.timestamp) - inTime;
      inTime = null;
    }
  }
  if (inTime) total += Date.now() - inTime; // still clocked in
  return total;
}

function applyBadge(durationMs) {
  if (!durationMs || durationMs <= 0) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  // Red (239,83,80) at 0h → Green (102,187,106) at TARGET_HOURS
  const t = Math.max(0, Math.min(1, durationMs / (TARGET_HOURS * 3600000)));
  const r = Math.round(239 + (102 - 239) * t);
  const g = Math.round(83  + (187 - 83)  * t);
  const b = Math.round(80  + (106 - 80)  * t);

  const totalMin = Math.floor(durationMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  // Badge max ~4 chars. h:mm fits up to 9:59; for 10h+ fall back to "10h"
  const text = h >= 10 ? `${h}h` : `${h}:${m.toString().padStart(2, '0')}`;

  chrome.action.setBadgeBackgroundColor({ color: [r, g, b, 255] });
  chrome.action.setBadgeText({ text });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

function notifyUser(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/bone-128.png'),
    title,
    message
  });
}

function formatThreshold(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
}

function promptReclockOut(thresholdMin) {
  chrome.notifications.create(NOTIF_AUTO_OUT_REPROMPT, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('src/icons/bone-128.png'),
    title: 'Still clocked in',
    message: `You’re past the ${formatThreshold(thresholdMin)} auto clock-out and have re-punched in. Punch out now, or handle it yourself?`,
    buttons: [{ title: 'Punch Out Now' }, { title: "I'll do it manually" }],
    requireInteraction: true,
    priority: 2
  });
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

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parse "HH:MM" and return the next Date at that local time (today if still
// in the future, otherwise tomorrow).
function nextOccurrenceOf(hhmm) {
  const [hStr, mStr] = String(hhmm || '').split(':');
  const hh = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const mm = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

async function scheduleAutoClockInAlarm() {
  await chrome.alarms.clear(ALARM_AUTO_CLOCK_IN);
  const cfg = await getAutoConfig();
  if (!cfg.inEnabled || !cfg.inTime) return;
  const when = nextOccurrenceOf(cfg.inTime).getTime();
  chrome.alarms.create(ALARM_AUTO_CLOCK_IN, { when });
}

async function runAutoClockIn() {
  try {
    const cfg = await getAutoConfig();
    if (!cfg.inEnabled) return;

    const markers = await getMarkers();
    const today = todayKey();
    if (markers.lastAutoInDate === today) return; // safety against double-fire

    const snapshot = await fetchTodaySnapshot();
    if (!snapshot) return; // no auth or fetch failed; skip silently

    // Smart rule: only auto clock-in if there are ZERO punches today.
    if (snapshot.entries.length > 0) {
      await setMarker('lastAutoInDate', today); // don't reconsider today
      return;
    }

    const res = await API.clockInOrOut('IN');
    if (res.ok) {
      await setMarker('lastAutoInDate', today);
      notifyUser('Auto Clock-In', `Punched IN at your scheduled time (${cfg.inTime}).`);
    } else {
      notifyUser('Auto Clock-In Failed', 'Could not punch in automatically. Please punch in manually.');
    }
  } catch (e) {
    notifyUser('Auto Clock-In Error', e.message || 'Unexpected error');
  }
}

async function maybeAutoClockOut(snapshot) {
  const cfg = await getAutoConfig();
  if (!cfg.outEnabled) return;
  if (!snapshot.isClockedIn) return;

  const thresholdMs = (cfg.outThresholdMin || DEFAULT_AUTO_CONFIG.outThresholdMin) * 60 * 1000;
  if (snapshot.durationMs < thresholdMs) return;

  // Prevent re-firing if user manually punches back in after auto clock-out.
  const markers = await getMarkers();
  const today = todayKey();
  if (markers.lastAutoOutDate === today) {
    // Already auto-clocked-out today, but the user re-punched in and is
    // still past the threshold. Don't silently punch them again — surface a
    // notification with action buttons and let them decide. Throttled to one
    // prompt per day so we don't spam every minute.
    if (markers.lastAutoOutPromptDate !== today) {
      await setMarker('lastAutoOutPromptDate', today);
      promptReclockOut(cfg.outThresholdMin);
    }
    return;
  }

  try {
    const res = await API.clockInOrOut('OUT');
    if (res.ok) {
      await setMarker('lastAutoOutDate', today);
      const h = Math.floor(cfg.outThresholdMin / 60);
      const m = cfg.outThresholdMin % 60;
      notifyUser('Auto Clock-Out', `You crossed ${h}h ${m.toString().padStart(2, '0')}m today — punched OUT automatically.`);
    } else {
      notifyUser('Auto Clock-Out Failed', 'Could not punch out automatically. Please punch out manually.');
    }
  } catch (e) {
    notifyUser('Auto Clock-Out Error', e.message || 'Unexpected error');
  }
}
