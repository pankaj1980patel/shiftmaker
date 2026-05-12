import { API } from './utils/api.js';
import { Storage } from './utils/storage.js';

const TARGET_HOURS = 8;
const BADGE_REFRESH_MIN = 1;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('badge_refresh', { periodInMinutes: BADGE_REFRESH_MIN, delayInMinutes: 0.05 });
  refreshBadge();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'break_end') {
    await endBreak();
    await refreshBadge();
  } else if (alarm.name === 'badge_refresh') {
    await refreshBadge();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'badge_refresh') {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true; // async response
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
  const ms = await fetchTodayDurationMs();
  if (ms === null) return;
  applyBadge(ms);
}

async function fetchTodayDurationMs() {
  try {
    const { [Storage.KEYS.REFRESH_TOKEN]: token } = await Storage.get(Storage.KEYS.REFRESH_TOKEN);
    if (!token) {
      chrome.action.setBadgeText({ text: '' });
      return null;
    }
    const r = await API.request('https://zujo.keka.com/k/attendance/api/mytime/attendance/attendancedayrequests');
    if (!r.ok) return null;
    let d = await r.json();
    if (d.data) d = d.data;
    const entries = [
      ...(d.webclockin?.flatMap(x => x.timeEntries || []) || []),
      ...(d.remoteclockin?.flatMap(x => x.timeEntries || []) || [])
    ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return calculateDurationMs(entries);
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
