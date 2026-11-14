import { Storage } from './storage.js';
import { normalizeTenant } from './tenant.js';

/**
 * Scans an open Keka tab's localStorage / sessionStorage / cookies for OIDC
 * artefacts (refresh_token, access_token, expires_at, client_id).
 *
 * The Keka SPA uses oidc-client-ts, which silently renews tokens in the
 * background — so tokens read from the tab are usually fresher than what
 * we've cached. Use this as a fallback when our stored tokens stop working.
 *
 * @returns {Promise<null | {
 *   token: string | null,
 *   accessToken: string | null,
 *   expiresAt: number | null,  // seconds since epoch (oidc-client-ts convention)
 *   clientId: string | null,
 *   tenant: string | null,     // e.g. "acme.keka.com", null for the identity host
 *   source: string | null,
 *   seenKeys: string[]
 * }>}
 */
export async function grabTokensFromKekaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.keka.com/*' });
  if (!tabs.length) return null;

  // Any *.keka.com tab matches — including www.keka.com, help pages or a
  // sign-in screen that hold no session. Scan them all (tenant tabs first,
  // so we capture the tenant host) and use the first one with tokens.
  const tenantOf = (t) => { try { return normalizeTenant(new URL(t.url).host); } catch (_) { return null; } };
  const ordered = [...tabs].sort((a, b) => (tenantOf(b) ? 1 : 0) - (tenantOf(a) ? 1 : 0));

  let fallback = null;
  for (const tab of ordered) {
    if (tab.discarded) continue; // can't inject into a discarded tab
    let storageResult;
    try {
      [{ result: storageResult } = {}] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scanTabStorage
      });
    } catch (_) { continue; } // error page, still loading, etc.
    if (!storageResult) continue;
    storageResult.tenant = tenantOf(tab);
    storageResult.tabId = tab.id;
    if (storageResult.token || storageResult.accessToken) return storageResult;
    fallback = fallback || storageResult;
  }
  return fallback || { token: null, accessToken: null, expiresAt: null, clientId: null, tenant: null, source: null, seenKeys: [] };
}

// Runs inside the Keka tab (serialised by chrome.scripting — no closures).
const scanTabStorage = () => {
      const out = {
        token: null,
        accessToken: null,
        expiresAt: null,
        source: null,
        clientId: null,
        seenKeys: []
      };

      const walk = (obj, depth = 0) => {
        if (!obj || depth > 5) return;
        if (typeof obj === 'string') {
          if (obj.startsWith('{') || obj.startsWith('[')) {
            try { walk(JSON.parse(obj), depth + 1); } catch (_) {}
          }
          return;
        }
        if (typeof obj !== 'object') return;

        for (const k of Object.keys(obj)) {
          const v = obj[k];

          if (!out.token && /refresh.?token/i.test(k) && typeof v === 'string' && v.length > 10) {
            out.token = v;
          }
          if (!out.accessToken && /^access.?token$/i.test(k) && typeof v === 'string' && v.length > 10) {
            out.accessToken = v;
          }
          if (/^expires_at$/i.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) {
            const n = typeof v === 'number' ? v : parseInt(v, 10);
            if (n > (out.expiresAt || 0)) out.expiresAt = n;
          }
          if (!out.clientId && /id_token_claims/i.test(k)) {
            try {
              const claims = typeof v === 'string' ? JSON.parse(v) : v;
              if (claims && typeof claims.aud === 'string') out.clientId = claims.aud;
            } catch (_) {}
          }
          if (!out.clientId && /^client[_-]?id$/i.test(k) && typeof v === 'string' && v.length > 8) {
            out.clientId = v;
          }
        }

        for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
      };

      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key) continue;
          out.seenKeys.push(key);
          const raw = store.getItem(key);
          if (!raw) continue;

          try {
            const data = JSON.parse(raw);
            const before = out.token;
            walk(data);
            if (!before && out.token) out.source = 'storage:' + key;
          } catch (_) {
            if (!out.token && /refresh.?token/i.test(key) && raw.length > 10 && raw.length < 4096) {
              out.token = raw.replace(/^"|"$/g, '');
              out.source = 'storage:' + key;
            }
          }
        }
      }

      return out;
    };

/**
 * Hand a token pair we renewed back to the Keka tab, so its oidc-client-ts
 * user entry holds the new (rotated) refresh token and the tab stays signed
 * in. oidc-client-ts reloads the user from storage before each renewal.
 * @returns {Promise<boolean>} true if the tab's entry was updated
 */
export async function writeBackToKekaTab(tabId, storageKey, data) {
  if (!tabId || !storageKey) return false;
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [storageKey, data],
      func: (key, d) => {
        for (const store of [localStorage, sessionStorage]) {
          const raw = store.getItem(key);
          if (!raw) continue;
          let user;
          try { user = JSON.parse(raw); } catch (_) { return false; }
          if (!user || typeof user !== 'object' || !('refresh_token' in user)) return false;
          user.access_token = d.access_token;
          if (d.refresh_token) user.refresh_token = d.refresh_token;
          if (d.id_token) user.id_token = d.id_token;
          user.expires_at = Math.floor(Date.now() / 1000) + (d.expires_in || 0);
          store.setItem(key, JSON.stringify(user));
          return true;
        }
        return false;
      }
    });
    return result === true;
  } catch (_) {
    return false;
  }
}

/**
 * Persist tokens read from a Keka tab. The session is marked 'grabbed': it
 * shares the Keka web app's refresh token, so API.ensureValidToken re-reads
 * the tab instead of spending that token (which would log the tab out).
 * @returns {Promise<string|null>} the stored access token, if any
 */
export async function saveGrabbedTokens(result) {
  if (!result) return null;
  const updates = {};
  if (result.token) {
    updates[Storage.KEYS.REFRESH_TOKEN] = result.token;
    updates[Storage.KEYS.TOKEN_SOURCE] = 'grabbed';
  }
  if (result.clientId) updates[Storage.KEYS.CLIENT_ID] = result.clientId;
  if (result.tenant) updates[Storage.KEYS.TENANT_SUBDOMAIN] = result.tenant;
  if (result.accessToken) {
    updates[Storage.KEYS.ACCESS_TOKEN] = result.accessToken;
    const expiresAtMs = result.expiresAt
      ? result.expiresAt * 1000
      : Date.now() + 5 * 60 * 1000;
    updates[Storage.KEYS.EXPIRES_AT] = expiresAtMs - 60000; // 1-min safety margin
  }
  if (Object.keys(updates).length) await Storage.set(updates);
  return result.accessToken || null;
}

/**
 * Read the open Keka tab and persist its tokens if they're usable (no token
 * refresh). Tokens equal to `rejectToken` (just got a 401) or already
 * expired are ignored and not saved.
 * @returns {Promise<{ token: string|null, tabOpen: boolean, result: object|null }>}
 */
export async function refreshFromKekaTab(rejectToken = null) {
  const r = await grabTokensFromKekaTab();
  // tabOpen = a tab that actually holds a Keka session (a refresh token).
  if (!r || !r.token) return { token: null, tabOpen: false, result: r };
  const fresh = r.accessToken && r.accessToken !== rejectToken
    && (!r.expiresAt || r.expiresAt * 1000 - 60000 > Date.now());
  if (!fresh) return { token: null, tabOpen: true, result: r };
  return { token: await saveGrabbedTokens(r), tabOpen: true, result: r };
}
