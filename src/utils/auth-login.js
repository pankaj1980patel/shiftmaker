import { Storage } from './storage.js';
import { getTenantSubdomain, normalizeTenant } from './tenant.js';

/**
 * Email + password + captcha login flow against Keka's identity service.
 *
 * Sequence (deduped from the raw browser trace):
 *   1. GET  /Account/Login         → antiforgery token (form + cookie)
 *   2. POST /Account/Login         → submit UserName, follows redirect to KekaLogin
 *   3. GET  /captcha               → image bytes, returned as data URL
 *   4. POST /Account/KekaLogin     → submit Email + Password + captcha → auth cookie
 *   5. GET  /connect/authorize     → our own PKCE, redirects to zujo with ?code=
 *   6. POST /connect/token         → access_token + refresh_token
 *
 * Steps 1–3 happen in startEmailLogin(). Steps 4–6 happen in completeLogin().
 */

const APP = 'https://app.keka.com';
const SCOPE = 'openid offline_access kekahr.api hiro.api';

async function requireTenant() {
  const host = await getTenantSubdomain();
  if (!host) throw new Error('Enter your Keka workspace (e.g. "acme") before signing in.');
  return host;
}

function walkForClientId(obj, depth = 0) {
  if (!obj || depth > 6 || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (/^client[_-]?id$/i.test(k) && typeof v === 'string' && v.length > 8) return v;
  }
  for (const k of Object.keys(obj)) {
    const found = walkForClientId(obj[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve the OIDC client_id without hardcoding it.
 *   1. Storage (populated by a previous login / auto-grab / content script)
 *   2. The tenant's public deploy config at /assets/config/config.deploy.json
 *
 * Throws if neither source yields a client_id — at that point the user needs
 * to load Keka in a tab once so the SPA exposes it.
 */
export async function ensureClientId() {
  const stored = await Storage.get(Storage.KEYS.CLIENT_ID);
  if (stored[Storage.KEYS.CLIENT_ID]) return stored[Storage.KEYS.CLIENT_ID];

  try {
    const tenant = await requireTenant();
    const r = await fetch(`https://${tenant}/assets/config/config.deploy.json`, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });
    if (r.ok) {
      const cfg = await r.json();
      const found = walkForClientId(cfg);
      if (found) {
        await Storage.set({ [Storage.KEYS.CLIENT_ID]: found });
        return found;
      }
    }
  } catch (_) { /* fall through */ }

  throw new Error(
    'Could not discover Keka client_id. Open Keka in a browser tab once so the extension can learn it.'
  );
}

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

function parseAntiforgery(html) {
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
        || html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/);
  return m ? m[1] : null;
}

function toCaptchaDataUrl(text) {
  const trimmed = text.trim().replace(/^"|"$/g, '');
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

async function ensureSubdomainCookie() {
  if (!chrome?.cookies?.set) return;
  try {
    const tenant = await requireTenant();
    await chrome.cookies.set({
      url: 'https://app.keka.com/',
      name: 'Subdomain',
      value: tenant,
      domain: '.keka.com',
      path: '/',
      secure: true
    });
  } catch (e) {
    console.warn('Could not set Subdomain cookie', e);
  }
}

// In-memory state carried between the two user-facing steps.
let session = null;

/**
 * Step 1–3: submit the email and fetch the captcha.
 * @param {string} email
 * @returns {Promise<{ captchaDataUrl: string }>}
 */
export async function startEmailLogin(email) {
  await ensureSubdomainCookie();

  const loginPage = await fetch(`${APP}/Account/Login?returnurl=%2F`, {
    method: 'GET',
    credentials: 'include'
  });
  if (!loginPage.ok) throw new Error('Failed to load login page (' + loginPage.status + ')');
  const html1 = await loginPage.text();
  const token1 = parseAntiforgery(html1);
  if (!token1) throw new Error('Antiforgery token not found on /Account/Login');

  const body1 = new URLSearchParams();
  body1.append('UserName', email);
  body1.append('__RequestVerificationToken', token1);

  const r2 = await fetch(`${APP}/Account/Login?returnurl=%2F`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body1
  });
  if (!r2.ok) throw new Error('Email submit failed (' + r2.status + ')');

  const html2 = await r2.text();
  const token2 = parseAntiforgery(html2);
  if (!token2) {
    // Probably means the email isn't recognised — the server re-rendered /Account/Login
    // without progressing to KekaLogin. Surface a clear error.
    throw new Error('Could not advance to password step — check the email address');
  }

  const captchaDataUrl = await fetchCaptchaInternal();

  session = {
    email,
    antiforgeryToken: token2
  };

  return { captchaDataUrl };
}

async function fetchCaptchaInternal() {
  const res = await fetch(`${APP}/captcha?_=${Date.now()}`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store'
  });
  if (!res.ok) throw new Error('Failed to fetch captcha (' + res.status + ')');
  const text = await res.text();
  return toCaptchaDataUrl(text);
}

/**
 * Refresh just the captcha (keeps the same email step).
 */
export async function refreshCaptcha() {
  if (!session) throw new Error('Login not started');
  return fetchCaptchaInternal();
}

/**
 * Step 4–6: submit password + captcha and run the OIDC code exchange.
 * Resolves to the access token (also persisted in storage).
 * @param {string} password
 * @param {string} captcha
 */
export async function completeLogin(password, captcha) {
  if (!session) throw new Error('Login not started');
  const { email, antiforgeryToken } = session;

  const loginBody = new URLSearchParams();
  loginBody.append('Email', email);
  loginBody.append('Password', password);
  loginBody.append('captcha', captcha);
  loginBody.append('__RequestVerificationToken', antiforgeryToken);

  const loginRes = await fetch(`${APP}/Account/KekaLogin?returnurl=%2F`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: loginBody
  });

  // On failure the final URL stays on the login page; on success it follows
  // the OIDC redirect chain and lands at the tenant origin.
  if (/\/Account\/(Login|KekaLogin)/.test(loginRes.url)) {
    const html = await loginRes.text();
    const newTok = parseAntiforgery(html);
    if (newTok) session.antiforgeryToken = newTok;

    // Try to extract a server-side error message before failing.
    const errMatch = html.match(/class="[^"]*validation-summary-errors[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
                  || html.match(/class="[^"]*field-validation-error[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
                  || html.match(/class="[^"]*text-danger[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p)>/i);
    let msg = 'Login failed — check your password and captcha';
    if (errMatch) {
      const cleaned = errMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned) msg = cleaned;
    }
    // Captcha is single-use — pull a fresh one for the next attempt.
    try {
      session.captchaDataUrl = await fetchCaptchaInternal();
    } catch (_) {}
    const err = new Error(msg);
    err.captchaDataUrl = session.captchaDataUrl;
    err.retry = true;
    throw err;
  }

  // Run our own PKCE-protected authorization_code flow.
  const tenant = await requireTenant();
  const tenantOrigin = `https://${tenant}`;
  const clientId = await ensureClientId();
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(await sha256(codeVerifier));
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));

  const authorizeUrl = new URL(`${APP}/connect/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('redirect_uri', tenantOrigin);
  authorizeUrl.searchParams.set('scope', SCOPE);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('nonce', nonce);

  const authRes = await fetch(authorizeUrl.toString(), {
    method: 'GET',
    credentials: 'include'
  });
  const finalUrl = new URL(authRes.url);
  const code = finalUrl.searchParams.get('code');
  const returnedState = finalUrl.searchParams.get('state');
  if (!code) throw new Error('Authorization failed — no code returned');
  if (returnedState && returnedState !== state) throw new Error('OIDC state mismatch');

  const tokenBody = new URLSearchParams();
  tokenBody.append('grant_type', 'authorization_code');
  tokenBody.append('code', code);
  tokenBody.append('redirect_uri', tenantOrigin);
  tokenBody.append('code_verifier', codeVerifier);
  tokenBody.append('client_id', clientId);

  const tokenRes = await fetch(`${APP}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text().catch(() => '');
    throw new Error('Token exchange failed (' + tokenRes.status + '): ' + txt.slice(0, 200));
  }
  const data = await tokenRes.json();
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Token endpoint returned no tokens');
  }

  const expiresAt = Date.now() + (data.expires_in * 1000) - 60000;
  await Storage.set({
    [Storage.KEYS.ACCESS_TOKEN]: data.access_token,
    [Storage.KEYS.REFRESH_TOKEN]: data.refresh_token,
    [Storage.KEYS.EXPIRES_AT]: expiresAt,
    [Storage.KEYS.CLIENT_ID]: clientId
  });

  session = null;
  return data.access_token;
}

export function cancelLogin() {
  session = null;
}

export function hasPendingLogin() {
  return session !== null;
}
