import { API } from './api.js';
import { tenantUrl } from './tenant.js';
import { dateKey, unwrap } from './time.js';

/**
 * Upcoming colleague birthdays, from the same endpoints Keka's dashboard
 * "Birthdays" wall widget uses.
 *
 *   GET /k/dashboard/api/dashboard/wall/wallsettings          → isBirthdayWidgetHidden
 *   GET /k/dashboard/api/dashboard/wall/birthdays?currentDate=YYYY-MM-DD
 *       → [{ displayName, jobTitle, profileImageUrl, dateOfBirth: "0004-11-20…" }]
 *
 * Keka hides the birth year (it sends year 0004), so only month/day is used.
 */

// Days from today until the next occurrence of month/day (0 = today).
function daysUntil(month, day, today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const occurrence = (y) => {
    // Feb 29 birthdays fall on Feb 28 in non-leap years.
    const d = month === 2 && day === 29 && !isLeap(y) ? 28 : day;
    return new Date(y, month - 1, d);
  };
  let next = occurrence(start.getFullYear());
  if (next < start) next = occurrence(start.getFullYear() + 1);
  return Math.round((next - start) / 86400000);
}

/**
 * @returns {Promise<{ hidden: boolean, items: Array<{
 *   name: string, jobTitle: string, imagePath: string|null,
 *   daysAway: number, date: Date
 * }> }>}
 */
export async function fetchBirthdays() {
  // Respect the company's choice to hide the birthday widget.
  try {
    const s = await API.request(await tenantUrl('/k/dashboard/api/dashboard/wall/wallsettings'));
    if (s.ok && unwrap(await s.json())?.isBirthdayWidgetHidden) return { hidden: true, items: [] };
  } catch (_) { /* fall through and try the list */ }

  const today = new Date();
  const url = await tenantUrl(`/k/dashboard/api/dashboard/wall/birthdays?currentDate=${dateKey(today)}`);
  const r = await API.request(url);
  if (!r.ok) throw new Error(`Birthdays request failed (${r.status})`);
  const list = unwrap(await r.json());
  if (!Array.isArray(list)) return { hidden: false, items: [] };

  const items = list
    .map((p) => {
      const m = /^\d{1,4}-(\d{2})-(\d{2})/.exec(p.dateOfBirth || '');
      if (!m) return null;
      const month = parseInt(m[1], 10);
      const day = parseInt(m[2], 10);
      const daysAway = daysUntil(month, day, today);
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAway);
      return {
        name: p.displayName || 'A colleague',
        jobTitle: p.jobTitle || '',
        imagePath: p.profileImageUrl || null,
        daysAway,
        date
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name));

  return { hidden: false, items };
}

export function birthdayWhen(item) {
  if (item.daysAway === 0) return 'Today';
  if (item.daysAway === 1) return 'Tomorrow';
  return item.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
