import { API } from './api.js';
import { tenantUrl } from './tenant.js';
import { calculateDurationMs, unwrap } from './time.js';

// Every punch source Keka's own dashboard considers for "today"
// (see its getCurrentDayRequests): web, remote/mobile, work-from-home,
// on-duty and forgot-ID-card entries. Office biometric logs are not part of
// this response.
const SOURCES = ['webclockin', 'remoteclockin', 'workfromhome', 'onduty', 'forgotidcard'];

/**
 * Today's punches from /attendancedayrequests.
 * @returns {Promise<{ entries: Array<{timestamp:string, punchStatus:number}>,
 *                     durationMs: number, isClockedIn: boolean,
 *                     lastIn: Date|null }>}
 * Throws on a failed request.
 */
export async function fetchTodayAttendance() {
  const r = await API.request(await tenantUrl('/k/attendance/api/mytime/attendance/attendancedayrequests'));
  if (!r.ok) throw new Error(`Attendance request failed (${r.status})`);
  const d = unwrap(await r.json()) || {};
  const entries = SOURCES
    .flatMap(k => (Array.isArray(d[k]) ? d[k] : []).flatMap(x => x?.timeEntries || []))
    .filter(e => e && e.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const last = entries[entries.length - 1];
  const lastInEntry = [...entries].reverse().find(e => e.punchStatus === 0);
  return {
    entries,
    durationMs: calculateDurationMs(entries),
    isClockedIn: !!last && last.punchStatus === 0,
    lastIn: lastInEntry ? new Date(lastInEntry.timestamp) : null
  };
}
