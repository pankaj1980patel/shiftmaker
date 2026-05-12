import { Storage } from './storage.js';

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
 *   source: string | null,
 *   seenKeys: string[]
 * }>}
 */
export async function grabTokensFromKekaTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://zujo.keka.com/*', 'https://app.keka.com/*', 'https://*.keka.com/*']
  });
  if (!tabs.length) return null;

  const [{ result: storageResult } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => {
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
    }
  });

  return storageResult || null;
}

/**
 * Run grabTokensFromKekaTab() and persist whatever it finds.
 * Returns the stored access token (if any) so the caller can retry immediately.
 */
export async function refreshFromKekaTab() {
  const result = await grabTokensFromKekaTab();
  if (!result) return null;

  const updates = {};
  if (result.token) updates[Storage.KEYS.REFRESH_TOKEN] = result.token;
  if (result.clientId) updates[Storage.KEYS.CLIENT_ID] = result.clientId;
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
