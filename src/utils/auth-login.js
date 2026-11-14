import { Storage, SessionStore } from './storage.js';
import { getTenantSubdomain } from './tenant.js';

/**
 * Email + password + captcha login flow against Keka's identity service.
 *
 * Sequence (deduped from the raw browser trace):
 *   1. GET  /Account/Login         → antiforgery token (form + cookie)
 *   2. POST /Account/Login         → submit UserName, follows redirect to KekaLogin
 *   3. GET  /captcha               → image bytes, returned as data URL
 *   4. POST /Account/KekaLogin     → submit Email + Password + captcha → auth cookie
 *      (if 2FA is on: SendCode → VerifyCode first — see the OTP section below)
 *   5. GET  /connect/authorize     → our own PKCE, redirects to the tenant with ?code=
 *   6. POST /connect/token         → access_token + refresh_token
 *
 * Steps 1–3 happen in startEmailLogin(), step 4 in completeLogin(), the OTP
 * steps in sendOtpCode() / verifyOtpCode() / resendOtpCode(), and 5–6 in
 * finishOidcLogin().
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

// State carried between the user-facing steps. Mirrored to
// chrome.storage.session so the popup can close (e.g. to read the OTP in
// Mail/Messages) and resume where it left off. The identity cookies live in
// the browser's cookie jar, so the server-side flow survives too.
// Never contains the password.
let session = null;
const PENDING_KEY = 'pending_login';
const PENDING_TTL_MS = 10 * 60 * 1000;

function persist() {
  if (!session) return SessionStore.remove(PENDING_KEY);
  return SessionStore.set(PENDING_KEY, { ...session, savedAt: Date.now() });
}

async function loadSession() {
  if (session) return session;
  const saved = await SessionStore.get(PENDING_KEY);
  if (saved && Date.now() - (saved.savedAt || 0) < PENDING_TTL_MS) session = saved;
  return session;
}

/**
 * Where an unfinished sign-in left off, for the popup to resume:
 *   { stage: 'password', email, captchaDataUrl }
 *   { stage: 'otp_choose', email, providers: [{value,label}] }
 *   { stage: 'otp_verify', email, destination }
 * or null.
 */
export async function restoreLogin() {
  const s = await loadSession();
  if (!s || !s.stage) return null;
  if (s.stage === 'otp_choose') {
    return { stage: s.stage, email: s.email, providers: (s.otp?.providers || []).map(({ value, label }) => ({ value, label })) };
  }
  if (s.stage === 'otp_verify') return { stage: s.stage, email: s.email, destination: s.destination };
  return { stage: 'password', email: s.email, captchaDataUrl: s.captchaDataUrl };
}

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
    antiforgeryToken: token2,
    captchaDataUrl,
    stage: 'password'
  };
  await persist();

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
  if (!(await loadSession())) throw new Error('Login not started');
  session.captchaDataUrl = await fetchCaptchaInternal();
  await persist();
  return session.captchaDataUrl;
}

// --- HTML helpers (popup context: DOMParser is available) -----------------

function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function formAction(form) {
  // getAttribute keeps it relative to app.keka.com, not the extension origin.
  return new URL(form.getAttribute('action') || '', APP).toString();
}

function formToken(form) {
  return form.querySelector('input[name="__RequestVerificationToken"]')?.value || null;
}

function pageError(doc) {
  // Keka's pages include empty placeholder error elements — take the first
  // one that actually has text.
  for (const el of doc.querySelectorAll('.validation-summary-errors, .field-validation-error, .text-danger, .alert-danger')) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

const isPath = (url, path) => new URL(url).pathname.toLowerCase() === path.toLowerCase();

/**
 * Step 4: submit password + captcha.
 *
 * Resolves to one of:
 *   { status: 'done' }                                   — signed in, tokens stored
 *   { status: 'otp_choose', providers: [{value,label}] } — Keka wants 2FA; pick a channel
 *   { status: 'otp_verify', destination }                — code already sent; enter it
 *
 * Throws (err.retry = true, err.captchaDataUrl) on a wrong password/captcha.
 * @param {string} password
 * @param {string} captcha
 */
export async function completeLogin(password, captcha) {
  if (!(await loadSession())) throw new Error('Sign-in expired — please start again.');
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

  // Two-factor: Keka redirects to /Account/SendCode (choose email/mobile) or,
  // for some setups, straight to /Account/VerifyCode.
  if (isPath(loginRes.url, '/Account/SendCode')) {
    return enterSendCodeStep(await loginRes.text());
  }
  if (isPath(loginRes.url, '/Account/VerifyCode')) {
    return enterVerifyStep(await loginRes.text());
  }

  // On failure the final URL stays on the login page; on success it follows
  // the redirect chain away from /Account/*.
  if (/\/Account\/(Login|KekaLogin)/i.test(new URL(loginRes.url).pathname)) {
    const html = await loginRes.text();
    const newTok = parseAntiforgery(html);
    if (newTok) session.antiforgeryToken = newTok;
    const msg = pageError(parseHtml(html)) || 'Login failed — check your password and captcha';
    // Captcha is single-use — pull a fresh one for the next attempt.
    try {
      session.captchaDataUrl = await fetchCaptchaInternal();
    } catch (_) {}
    await persist();
    const err = new Error(msg);
    err.captchaDataUrl = session.captchaDataUrl;
    err.retry = true;
    throw err;
  }

  await finishOidcLogin();
  return { status: 'done' };
}

// --- Two-factor (OTP) --------------------------------------------------------
//
// Sequence observed from Keka:
//   GET  /Account/SendCode   → one form per channel, hidden TokenProvider
//                               (1 = email, 0 = mobile) + antiforgery token
//   POST /Account/SendCode   → 302 /Account/VerifyCode
//   GET  /Account/VerifyCode → verify form (TwoFactorCode, TokenProvider) and
//                               a resend form (POST /Account/ResendCode)
//   POST /Account/VerifyCode → 302 to returnurl; identity cookie is now set

function enterSendCodeStep(html) {
  const doc = parseHtml(html);
  const providers = [];
  for (const form of doc.querySelectorAll('form')) {
    const value = form.querySelector('input[name="TokenProvider"]')?.value;
    if (value == null) continue;
    const button = form.querySelector('button, input[type="submit"]');
    const label = (button?.textContent || button?.value || '').replace(/\s+/g, ' ').trim()
      || (value === '1' ? 'Send code to email' : value === '0' ? 'Send code to mobile' : `Send code (${value})`);
    providers.push({ value, label, action: formAction(form), token: formToken(form) });
  }
  if (!providers.length) throw new Error('Keka asked for verification, but no delivery options were found.');
  session.otp = { providers };
  session.stage = 'otp_choose';
  void persist();
  return {
    status: 'otp_choose',
    providers: providers.map(({ value, label }) => ({ value, label }))
  };
}

function enterVerifyStep(html) {
  const doc = parseHtml(html);
  const verifyForm = doc.querySelector('input[name="TwoFactorCode"]')?.closest('form');
  if (!verifyForm) throw new Error('Could not find the verification code form.');
  const resendForm = doc.getElementById('js-resend-2fa-form')
    || [...doc.querySelectorAll('form')].find(f => /ResendCode/i.test(f.getAttribute('action') || ''));

  const provider = verifyForm.querySelector('input[name="TokenProvider"]')?.value ?? '';
  session.otp = {
    ...(session.otp || {}),
    provider,
    verify: { action: formAction(verifyForm), token: formToken(verifyForm) },
    resend: resendForm ? { action: formAction(resendForm), token: formToken(resendForm) } : null
  };

  // e.g. "We sent a code to your email j***@acme.com"
  const sent = [...doc.querySelectorAll('p, span, div, label')]
    .map(el => el.textContent.replace(/\s+/g, ' ').trim())
    .find(t => /we sent a code/i.test(t) && t.length < 160);
  session.stage = 'otp_verify';
  session.destination = sent || 'Enter the code Keka sent you.';
  void persist();
  return { status: 'otp_verify', destination: session.destination };
}

async function postForm(action, fields) {
  return fetch(action, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  });
}

/**
 * Ask Keka to send the code via the chosen channel.
 * @param {string} providerValue  value from the providers list ('1' email, '0' mobile)
 * @returns {Promise<{ status: 'otp_verify', destination: string }>}
 */
export async function sendOtpCode(providerValue) {
  await loadSession();
  const provider = session?.otp?.providers?.find(p => p.value === String(providerValue));
  if (!provider) throw new Error('Sign-in expired — please start again.');
  const res = await postForm(provider.action, {
    TokenProvider: provider.value,
    __RequestVerificationToken: provider.token
  });
  if (!isPath(res.url, '/Account/VerifyCode')) {
    const msg = pageError(parseHtml(await res.text()));
    throw new Error(msg || 'Could not send the verification code. Please start again.');
  }
  return enterVerifyStep(await res.text());
}

/**
 * Submit the OTP. On success runs the token exchange and resolves to
 * { status: 'done' }. On a wrong code throws with err.retry = true.
 * @param {string} code
 */
export async function verifyOtpCode(code) {
  await loadSession();
  const v = session?.otp?.verify;
  if (!v) throw new Error('Sign-in expired — please start again.');
  const res = await postForm(v.action, {
    TwoFactorCode: code,
    TokenProvider: session.otp.provider,
    __RequestVerificationToken: v.token
  });

  if (isPath(res.url, '/Account/VerifyCode')) {
    const html = await res.text();
    try { enterVerifyStep(html); } catch (_) { /* keep previous form state */ }
    const err = new Error(pageError(parseHtml(html)) || 'That code didn\'t work — check it and try again.');
    err.retry = true;
    throw err;
  }
  if (/\/Account\/(Login|KekaLogin|SendCode)/i.test(new URL(res.url).pathname)) {
    throw new Error('Verification expired — please sign in again.');
  }

  await finishOidcLogin();
  return { status: 'done' };
}

/** Ask Keka to resend the code to the same channel. */
export async function resendOtpCode() {
  await loadSession();
  const r = session?.otp?.resend;
  if (!r) throw new Error('Resend isn\'t available — please start again.');
  const res = await postForm(r.action, {
    TokenProvider: session.otp.provider,
    __RequestVerificationToken: r.token
  });
  if (!isPath(res.url, '/Account/VerifyCode')) {
    throw new Error('Could not resend the code. Please start again.');
  }
  return enterVerifyStep(await res.text());
}

// --- Step 5–6: our own PKCE authorization_code exchange ------------------------

async function finishOidcLogin() {
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
  if (!code) {
    // Landed back on a login/2FA page: Keka didn't consider us signed in.
    if (/\/Account\//i.test(finalUrl.pathname)) {
      throw new Error('Keka needs extra verification that ShiftMate couldn\'t complete. Please sign in again.');
    }
    throw new Error('Authorization failed — no code returned');
  }
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
    [Storage.KEYS.TOKEN_SOURCE]: 'own',
    [Storage.KEYS.CLIENT_ID]: clientId
  });

  session = null;
  await persist();
  return data.access_token;
}

export function cancelLogin() {
  session = null;
  return persist();
}
