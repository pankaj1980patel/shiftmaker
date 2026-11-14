import { Storage, cached } from './storage.js';
import { unwrap } from './time.js';
import { refreshFromKekaTab } from './grab-tokens.js';
import { ensureClientId } from './auth-login.js';
import { tenantUrl } from './tenant.js';
import { getCurrentLocation } from './location.js';

// Fired when API.request can't recover authentication — popup registers a
// handler that shows the login UI; background just lets the failure surface.
let authRequiredHandler = null;
export function onAuthRequired(handler) {
  authRequiredHandler = handler;
}
async function notifyAuthRequired() {
  if (typeof authRequiredHandler !== 'function') return;
  try { await authRequiredHandler(); }
  catch (e) { console.error('onAuthRequired handler threw', e); }
}

const REFRESH_LOCK = 'shiftmate-token-refresh';

// Auth failures come in two kinds. Only a dead session (Keka rejected the
// refresh token, or there is none) may send the user back to sign-in; a
// network blip, 5xx or 429 keeps the token and just fails this request.
const KEKA_DOWN_MSG = 'Keka is having a moment 🫠 Try again in a bit.';
function authError(message, dead) {
  const e = new Error(message);
  e.sessionDead = dead;
  return e;
}
const isDead = (e) => e?.sessionDead !== false;

// Run fn under a lock shared by the popup and the service worker (same
// extension origin), so only one token refresh happens at a time.
function withRefreshLock(fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(REFRESH_LOCK, fn);
  }
  return fn();
}

async function readTokens() {
  const s = await Storage.get([
    Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.EXPIRES_AT,
    Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.TOKEN_SOURCE
  ]);
  return {
    access: s[Storage.KEYS.ACCESS_TOKEN] || null,
    expiresAt: s[Storage.KEYS.EXPIRES_AT] || 0,
    refresh: s[Storage.KEYS.REFRESH_TOKEN] || null,
    source: s[Storage.KEYS.TOKEN_SOURCE] || 'own'
  };
}

export const API = {
  /**
   * refresh_token grant. Keka rotates the refresh token on every use, so this
   * must only run inside the refresh lock (see ensureValidToken).
   */
  refreshToken: async () => {
    const { refresh: refreshToken } = await readTokens();
    if (!refreshToken) throw authError('No refresh token available', true);

    const clientId = await ensureClientId();
    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('refresh_token', refreshToken);
    body.append('client_id', clientId);

    let response;
    try {
      response = await fetch('https://app.keka.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
    } catch (_) {
      throw authError(KEKA_DOWN_MSG, false); // offline / DNS / CORS blip
    }
    // 400/401 (invalid_grant etc.) = the refresh token is dead. Anything
    // else (5xx, 429) is Keka's problem, not the session's.
    if (response.status === 400 || response.status === 401) throw authError('Session expired', true);
    if (!response.ok) throw authError(KEKA_DOWN_MSG, false);

    const data = await response.json();
    if (!data.access_token) throw authError(KEKA_DOWN_MSG, false);
    // Refresh slightly before the real expiry.
    const expiresAt = Date.now() + (data.expires_in * 1000) - 60000;
    await Storage.set({
      [Storage.KEYS.ACCESS_TOKEN]: data.access_token,
      // Rotation — but never overwrite ours with nothing.
      [Storage.KEYS.REFRESH_TOKEN]: data.refresh_token || refreshToken,
      [Storage.KEYS.EXPIRES_AT]: expiresAt,
      // Once we've used the refresh token ourselves, the session is ours.
      [Storage.KEYS.TOKEN_SOURCE]: 'own'
    });
    return data.access_token;
  },

  /**
   * Get a usable access token, refreshing at most once across all callers.
   * @param {string|null} staleToken  the token a caller just saw rejected (401)
   *
   * Inside the lock we re-read storage: if another caller already refreshed
   * (token differs from staleToken and isn't expired), reuse it.
   *
   * Sessions copied from an open Keka tab ('grabbed') share the Keka web
   * app's refresh token; using it would revoke the tab's copy and log the
   * user out of Keka. So for those we re-read fresh tokens from the tab (the
   * web app renews them itself). If a Keka tab is open but holds nothing
   * fresh yet, we wait for it rather than spend its refresh token. Only with
   * no Keka tab at all do we use the grant, so overnight automation keeps
   * working (Keka in the browser then asks you to sign in on your next visit).
   */
  ensureValidToken: async (staleToken = null) => withRefreshLock(async () => {
    const t = await readTokens();
    if (t.access && t.access !== staleToken && Date.now() < t.expiresAt) return t.access;

    if (t.source === 'grabbed') {
      const tab = await refreshFromKekaTab(staleToken).catch(() => ({ token: null, tabOpen: false }));
      if (tab.token) return tab.token;
      if (tab.tabOpen) throw authError(KEKA_DOWN_MSG, false);
    }
    try {
      return await API.refreshToken();
    } catch (e) {
      if (t.source !== 'grabbed') {
        // Our own session failed to refresh; a live Keka tab may still help.
        const tab = await refreshFromKekaTab(staleToken).catch(() => ({ token: null }));
        if (tab.token) return tab.token;
      }
      throw e;
    }
  }),

  /**
   * Authenticated fetch wrapper
   */
  request: async (url, options = {}) => {
    let { [Storage.KEYS.ACCESS_TOKEN]: token, [Storage.KEYS.EXPIRES_AT]: expiresAt } = await Storage.get([
      Storage.KEYS.ACCESS_TOKEN,
      Storage.KEYS.EXPIRES_AT
    ]);

    // Check if token is missing or expired
    if (!token || !expiresAt || Date.now() > expiresAt) {
      try {
        token = await API.ensureValidToken(token);
      } catch (e) {
        // Fall back to whatever access token we already have — let the
        // server decide if it's still valid.
        console.warn('Token refresh failed, falling back to cached access token', e);
        if (!token) {
          if (!isDead(e)) throw e;
          await notifyAuthRequired();
          throw new Error('AUTH_REQUIRED');
        }
      }
    }

    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };

    let response = await fetch(url, { ...options, headers });

    // If 401, try one more refresh (including a tab rescan); on failure, surface the 401
    if (response.status === 401) {
      try {
        token = await API.ensureValidToken(token);
      } catch (e) {
        console.warn('Token refresh after 401 failed', e);
        if (!isDead(e)) throw e; // Keka hiccup: keep the session
        await notifyAuthRequired();
        return response;
      }
      headers['Authorization'] = `Bearer ${token}`;
      response = await fetch(url, { ...options, headers });
      // Refreshed token still rejected — credentials are truly dead.
      if (response.status === 401) {
        await notifyAuthRequired();
      }
    }

    return response;
  },

  /**
   * Performs Clock In or Clock Out
   * @param {string} action 'in' or 'out'
   */
  clockInOrOut: async (action) => {
    const punchStatus = action.toLowerCase() === "in" ? 0 : 1;

    // Like Keka's web app: attach the real device location only when the
    // company's capture scheme asks for it; punch without it if unavailable.
    const locationRequired = await API.isLocationRequired();
    const locationAddress = locationRequired ? await getCurrentLocation() : null;

    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      attendanceLogSource: 1,
      manualClockinType: 1,
      note: "",
      originalPunchStatus: punchStatus,
      locationAddress
    });

    const url = await tenantUrl('/k/attendance/api/mytime/attendance/webclockin');
    const response = await API.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    });
    // Lets callers tell the user when a required location couldn't be sent.
    response.locationMissing = locationRequired && !locationAddress;
    return response;
  },

  /**
   * Whether the company requires a location with web clock-in
   * (attendanceCaptureScheme → requireLocationForWebClockIn).
   * If the setting can't be read, assume it's required: sending the real
   * location is the safe side.
   */
  isLocationRequired: async () => {
    try {
      // Company policy rarely changes: reuse the answer for an hour
      // (session cache survives the service worker shutting down).
      return await cached('location-policy', 60 * 60 * 1000, async () => {
        const url = await tenantUrl('/k/dashboard/api/mytime/attendance/attendancecapturescheme');
        const r = await API.request(url);
        if (!r.ok) throw new Error('capture scheme unavailable');
        const flag = unwrap(await r.json())?.configuration?.attendanceCapture?.requireLocationForWebClockIn;
        if (typeof flag !== 'boolean') throw new Error('capture scheme has no location flag');
        return flag;
      });
    } catch (_) {
      return true; // unknown → send the real location (the safe side); not cached
    }
  }
};
