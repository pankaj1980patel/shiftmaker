/** Shared date/time helpers (local time throughout). */

/** Local calendar date as "YYYY-MM-DD". */
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "HH:MM" → minutes since midnight, or null if invalid. */
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
}

/** minutes since midnight → "HH:MM". */
export function minutesToHHMM(min) {
  const total = Math.max(0, Math.min(23 * 60 + 59, parseInt(min, 10) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Minutes since local midnight for a Date. */
export function minutesOfDay(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/** 5h 12m */
export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.floor((ms || 0) / 60000));
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

/** Clock time in the user's locale (12h or 24h as their system prefers). */
export function formatClock(value) {
  if (!value) return '--:--';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Sum of IN→OUT spans; an open IN counts until now. */
export function calculateDurationMs(entries) {
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
  if (inTime) total += Date.now() - inTime;
  return total;
}

/** Keka wraps most responses as { data, succeeded, … }. */
export function unwrap(json) {
  return json && typeof json === 'object' && !Array.isArray(json) && 'data' in json ? json.data : json;
}
