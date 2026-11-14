/**
 * Real device location for clock-in/out, in the shape Keka's web app sends:
 *   { latitude, longitude }
 *
 * Mirrors Keka's own behaviour: ask the browser for the current position with
 * a short timeout; if it's unavailable or denied, punch without a location
 * (Keka's web app does the same after showing a notice).
 *
 * - Extension pages (popup) can call navigator.geolocation directly.
 * - The service worker has no geolocation API, so it asks an offscreen
 *   document (src/offscreen.html) to do it.
 */

const TIMEOUT_MS = 8000;
const MAX_AGE_MS = 5 * 60 * 1000; // accept a fix up to 5 minutes old

export function readPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => {
        console.warn('[ShiftMate] location unavailable:', err && err.message);
        resolve(null);
      },
      { timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS, enableHighAccuracy: false }
    );
  });
}

// #chrome-only-start (stripped from the Firefox build, which has no offscreen API)
const OFFSCREEN_URL = 'src/offscreen.html';
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['GEOLOCATION'],
      justification: 'Attach your current location to Keka clock-in/out, as your company requires.'
    }).finally(() => { creating = null; });
  }
  await creating;
}

async function offscreenLocation() {
  if (!chrome.offscreen) return null;
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'get_location' });
  return res && typeof res.latitude === 'number' ? res : null;
}
// #chrome-only-end

/**
 * @returns {Promise<{latitude:number, longitude:number} | null>}
 */
export async function getCurrentLocation() {
  try {
    // Extension pages (popup) have a DOM and geolocation.
    if (typeof document !== 'undefined' && navigator.geolocation) {
      return await readPosition();
    }
    return await offscreenLocation();
  } catch (e) {
    console.warn('[ShiftMate] could not get location', e);
    return null;
  }
}
