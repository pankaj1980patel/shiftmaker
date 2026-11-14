import { API } from './api.js';
import { tenantUrl } from './tenant.js';
import { cached } from './storage.js';
import { dateKey, unwrap } from './time.js';

export { dateKey };

/**
 * Work-day context from the endpoints Keka's own dashboard uses:
 *
 *   /k/dashboard/api/mytime/attendance/shiftweekoffdetails
 *       → this week, per date: weekOffType (0 working, 1 holiday, 2 weekly off),
 *         shiftTime { shiftStartTime {hours,minutes}, shiftEndTime, shiftDuration (h), breakDuration (min) }
 *   /k/dashboard/api/dashboard/holidays            → [{ date: "YYYY-MM-DD", name, isFloater }]
 *   /k/dashboard/api/me/leave/summary?forDate=…    → balances per leave type, plus one
 *         leaveBalanceTransactions entry per leave day (transactionType 1 = consumed)
 *   /k/dashboard/api/dashboard/onleavetoday        → colleagues on leave today (paged)
 *   /k/dashboard/api/inbox/pendingapprovalscount   → { leaveRequestCount, … } (summed)
 *   /notifications/api/v1/in-app-notifications/unread-count → number
 */

export const WEEK_OFF = { WORKING: 0, HOLIDAY: 1, WEEKLY_OFF: 2 };

export const KEKA_ROUTES = {
  dashboard: '/#/home/dashboard',
  approvals: '/#/inbox/action',
  notifications: '/#/inbox/notifications',
  leave: '/#/me/leave/summary',
  attendance: '/#/me/attendance/logs'
};

async function getJson(path) {
  const r = await API.request(await tenantUrl(path));
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return unwrap(await r.json());
}

// Cached in chrome.storage.session (see storage.js): the background ticks
// every minute and its worker is often restarted, but this data changes rarely.
const HOUR = 60 * 60 * 1000;

const toHHMM = (t) => (t && typeof t.hours === 'number')
  ? `${String(t.hours).padStart(2, '0')}:${String(t.minutes || 0).padStart(2, '0')}`
  : null;

/**
 * This week's schedule, keyed by local date "YYYY-MM-DD".
 * @returns {Promise<Record<string, {
 *   weekOffType: number, shiftName: string|null,
 *   start: string|null, end: string|null,   // "HH:MM"
 *   flexible: boolean,                      // 00:00–23:59 style shift
 *   durationHours: number|null, breakMinutes: number|null
 * }>>}
 */
export function getWeekSchedule() {
  return cached(`schedule:${dateKey()}`, 6 * HOUR, async () => {
    const d = await getJson('/k/dashboard/api/mytime/attendance/shiftweekoffdetails');
    const days = d?.shiftWeekoffDetails || {};
    const out = {};
    for (const [iso, v] of Object.entries(days)) {
      const st = v?.shiftTime || {};
      const start = toHHMM(st.shiftStartTime);
      const end = toHHMM(st.shiftEndTime);
      out[iso.slice(0, 10)] = {
        weekOffType: typeof v?.weekOffType === 'number' ? v.weekOffType : WEEK_OFF.WORKING,
        shiftName: v?.shiftName || null,
        start,
        end,
        flexible: !start || !end || (start === '00:00' && end === '23:59'),
        durationHours: typeof st.shiftDuration === 'number' ? st.shiftDuration : null,
        breakMinutes: typeof st.breakDuration === 'number' ? st.breakDuration : null
      };
    }
    return out;
  });
}

/**
 * Days of the week that are always off (0 = Sunday … 6 = Saturday), from the
 * weekly-off policy. Used for dates outside the current week's schedule.
 * Only "every week" rules (dayFrequencyType 0) count; alternate-week rules
 * are ignored rather than guessed.
 */
export function getWeeklyOffDays() {
  return cached('weeklyoff', 12 * HOUR, async () => {
    const d = await getJson('/k/dashboard/api/me/weeklyoffpolicy');
    const days = [];
    for (const w of d?.weeklyOff?.weekOffs || []) {
      if ((w?.dayOffs || []).some(o => o?.dayFrequencyType === 0)) days.push(w.dayOfWeek);
    }
    return days; // array, so it survives JSON storage
  });
}

/** @returns {Promise<Array<{ date: string, name: string, isFloater: boolean }>>} sorted */
export function getHolidays() {
  return cached('holidays', 12 * HOUR, async () => {
    const list = await getJson('/k/dashboard/api/dashboard/holidays');
    return (Array.isArray(list) ? list : [])
      .map(h => ({ date: String(h.date || '').slice(0, 10), name: h.name || 'Holiday', isFloater: !!h.isFloater }))
      .filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h.date))
      .sort((a, b) => a.date.localeCompare(b.date));
  });
}

/**
 * @returns {Promise<{
 *   balances: Array<{ name: string, code: string, available: number, consumed: number,
 *                     quota: number|null, isPaid: boolean, label: string }>,
 *   leaveDays: Record<string, { duration: number, typeName: string }>
 * }>}
 */
export function getLeave() {
  const today = dateKey();
  return cached(`leave:${today}`, 1 * HOUR, async () => {
    const d = await getJson(`/k/dashboard/api/me/leave/summary?forDate=${today}`);
    const names = {};
    const balances = (d?.leaveSummaries || []).map(s => {
      const lt = s?.leaveTypeConfig?.leaveType || {};
      names[s.typeId] = lt.name || 'Leave';
      const quota = s?.annualQuota?.duration;
      return {
        name: lt.name || 'Leave',
        code: lt.code || '',
        isPaid: lt.isPaid !== false,
        available: s?.availableBalance?.duration ?? 0,
        consumed: s?.consumedBalance?.duration ?? 0,
        quota: typeof quota === 'number' && quota >= 0 ? quota : null, // -1 = unlimited
        label: s?.availableBalance?.durationString || ''
      };
    });

    // One "consumed" transaction per leave day; half days have duration < 1.
    const leaveDays = {};
    for (const t of d?.leaveBalanceTransactions || []) {
      if (t?.transactionType !== 1 || !t.transactionDate) continue;
      const k = String(t.transactionDate).slice(0, 10);
      const prev = leaveDays[k];
      leaveDays[k] = {
        duration: (prev?.duration || 0) + (t?.duration?.duration || 0),
        typeName: prev?.typeName || names[t.typeId] || 'Leave'
      };
    }
    return { balances, leaveDays };
  });
}

/**
 * Is the given day a day off for auto clock-in purposes?
 * Each source is optional: if one request fails, the others still count.
 * @returns {Promise<{ off: boolean, reason: string|null, schedule: object|null }>}
 */
export async function getDayStatus(day = new Date()) {
  const key = dateKey(day);
  const [schedule, holidays, leave, weeklyOff] = await Promise.all([
    getWeekSchedule().catch(() => null),
    getHolidays().catch(() => null),
    getLeave().catch(() => null),
    getWeeklyOffDays().catch(() => null)
  ]);
  const sched = schedule?.[key] || null;

  const holiday = holidays?.find(h => h.date === key && !h.isFloater);
  if (sched?.weekOffType === WEEK_OFF.HOLIDAY || holiday) {
    return { off: true, reason: `Holiday${holiday ? `: ${holiday.name}` : ''}`, schedule: sched };
  }
  if (sched?.weekOffType === WEEK_OFF.WEEKLY_OFF || (!sched && weeklyOff?.includes(day.getDay()))) {
    return { off: true, reason: 'Weekly off', schedule: sched };
  }
  const leaveDay = leave?.leaveDays?.[key];
  if (leaveDay && leaveDay.duration >= 1) {
    return { off: true, reason: `On leave (${leaveDay.typeName})`, schedule: sched };
  }
  if (leaveDay) {
    return { off: false, reason: `Half day (${leaveDay.typeName})`, schedule: sched };
  }
  return { off: false, reason: null, schedule: sched };
}

/** Today's target hours from the shift (e.g. 8.5), or null if unknown. */
export async function getTargetHours() {
  try {
    const s = (await getWeekSchedule())[dateKey()];
    return s?.durationHours > 0 ? s.durationHours : null;
  } catch (_) {
    return null;
  }
}

/** Colleagues on leave today. Shape isn't documented, so read defensively. */
export async function getOnLeaveToday() {
  const d = await getJson('/k/dashboard/api/dashboard/onleavetoday?pageSize=20');
  const items = Array.isArray(d?.items) ? d.items : Array.isArray(d) ? d : [];
  return items.map(x => {
    const e = x?.employee || x;
    return {
      name: e?.displayName || e?.employeeName || e?.name || 'A colleague',
      detail: x?.leaveTypeName || x?.leaveType?.name || e?.jobTitle || ''
    };
  });
}

/** @returns {Promise<{ approvals: number|null, notifications: number|null }>} */
export async function getInboxCounts() {
  const [approvals, notifications] = await Promise.all([
    getJson('/k/dashboard/api/inbox/pendingapprovalscount')
      .then(d => (d && typeof d === 'object')
        ? Object.values(d).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
        : null)
      .catch(() => null),
    getJson('/notifications/api/v1/in-app-notifications/unread-count')
      .then(n => (typeof n === 'number' ? n : null))
      .catch(() => null)
  ]);
  return { approvals, notifications };
}
