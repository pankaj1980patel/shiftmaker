import { Storage } from './storage.js';
import { refreshFromKekaTab } from './grab-tokens.js';
import { ensureClientId } from './auth-login.js';
import { tenantUrl } from './tenant.js';

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

export const API = {
  /**
   * Refreshes the access token using the refresh token
   */
  refreshToken: async () => {
    const stored = await Storage.get(Storage.KEYS.REFRESH_TOKEN);
    const refreshToken = stored[Storage.KEYS.REFRESH_TOKEN];

    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const clientId = await ensureClientId();

    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('refresh_token', refreshToken);
    body.append('client_id', clientId);

    const response = await fetch('https://app.keka.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = await response.json();
    
    // Calculate new expiry time (ensure we refresh slightly before actual expiry)
    const expiresAt = Date.now() + (data.expires_in * 1000) - 60000; 

    await Storage.set({
      [Storage.KEYS.ACCESS_TOKEN]: data.access_token,
      [Storage.KEYS.REFRESH_TOKEN]: data.refresh_token, // Rotation
      [Storage.KEYS.EXPIRES_AT]: expiresAt
    });

    return data.access_token;
  },

  /**
   * Try /connect/token refresh; if that fails, scrape the open Keka tab for
   * a fresh access token (the SPA's oidc-client-ts silently renews in the
   * background, so tab storage is often fresher than ours).
   */
  ensureValidToken: async () => {
    try {
      return await API.refreshToken();
    } catch (e) {
      console.warn('refresh_token grant failed, trying live Keka tab', e);
      const grabbed = await refreshFromKekaTab();
      if (grabbed) return grabbed;
      throw e;
    }
  },

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
        token = await API.ensureValidToken();
      } catch (e) {
        // Fall back to whatever access token we already have — let the
        // server decide if it's still valid.
        console.warn('Token refresh failed entirely, falling back to cached access token', e);
        if (!token) {
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
        token = await API.ensureValidToken();
      } catch (e) {
        console.warn('Token refresh after 401 failed', e);
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
    const body = JSON.stringify({
      timestamp: new Date().toISOString(),
      attendanceLogSource: 1,
      manualClockinType: 1,
      note: "",
      originalPunchStatus: punchStatus,
      locationAddress: null
    });

    const url = await tenantUrl('/k/attendance/api/mytime/attendance/webclockin');
    return API.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body
    });
  }
};
