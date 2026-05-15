import { Storage, DEFAULT_AUTO_CONFIG } from './utils/storage.js';
import { API, onAuthRequired } from './utils/api.js';
import { grabTokensFromKekaTab } from './utils/grab-tokens.js';
import { startEmailLogin, completeLogin, refreshCaptcha, cancelLogin } from './utils/auth-login.js';
import {
  getTenantSubdomain,
  setTenantSubdomain,
  tenantUrl,
  discoverTenantFromTabs,
  discoverTenantFromCookie,
  normalizeTenant
} from './utils/tenant.js';

// DOM Elements
const views = {
  init: document.getElementById('view-init'),
  dashboard: document.getElementById('view-dashboard')
};

const ui = {
  statusText: document.querySelector('#connection-status .text'),
  statusDot: document.querySelector('#connection-status .dot'),
  connectionStatus: document.getElementById('connection-status'),
  refreshTokenInput: document.getElementById('refresh-token-input'),
  btnSaveToken: document.getElementById('btn-save-token'),
  btnAutoGrab: document.getElementById('btn-auto-grab'),
  // Login flow
  loginStatus: document.getElementById('login-status'),
  loginError: document.getElementById('login-error'),
  loginStepEmail: document.getElementById('login-step-email'),
  loginStepPassword: document.getElementById('login-step-password'),
  loginStepToken: document.getElementById('login-step-token'),
  loginTenantInput: document.getElementById('login-tenant'),
  loginEmailInput: document.getElementById('login-email'),
  loginEmailDisplay: document.getElementById('login-email-display'),
  loginPasswordInput: document.getElementById('login-password'),
  loginCaptchaInput: document.getElementById('login-captcha'),
  captchaImage: document.getElementById('captcha-image'),
  btnLoginContinue: document.getElementById('btn-login-continue'),
  btnLoginSubmit: document.getElementById('btn-login-submit'),
  btnLoginChangeEmail: document.getElementById('btn-login-change-email'),
  btnCaptchaRefresh: document.getElementById('btn-captcha-refresh'),
  btnShowTokenPaste: document.getElementById('btn-show-token-paste'),
  btnTogglePassword: document.getElementById('btn-toggle-password'),
  userName: document.getElementById('user-name'),
  userTitle: document.getElementById('user-title'),
  userAvatar: document.getElementById('user-avatar'),
  currentTime: document.getElementById('current-time'),
  statIn: document.getElementById('stat-in'),
  statOut: document.getElementById('stat-out'),
  statDuration: document.getElementById('stat-duration'),
  btnClockIn: document.getElementById('btn-clock-in'),
  btnClockOut: document.getElementById('btn-clock-out'),
  historyList: document.getElementById('history-list'),
  dayList: document.getElementById('day-list'),
  tabs: document.querySelectorAll('.tab'),
  tabPanels: {
    today: document.getElementById('tab-today'),
    history: document.getElementById('tab-history'),
    settings: document.getElementById('tab-settings')
  },
  settingConnection: document.getElementById('setting-connection'),
  settingTenant: document.getElementById('setting-tenant'),
  settingClientId: document.getElementById('setting-clientid'),
  btnReset: document.getElementById('btn-reset'),
  autoOutEnabled: document.getElementById('auto-out-enabled'),
  autoOutThreshold: document.getElementById('auto-out-threshold'),
  autoOutRow: document.getElementById('auto-out-row'),
  autoInEnabled: document.getElementById('auto-in-enabled'),
  autoInTime: document.getElementById('auto-in-time'),
  autoInRow: document.getElementById('auto-in-row'),
  automationStatus: document.getElementById('automation-status'),
  breakIdle: document.getElementById('break-idle'),
  breakActive: document.getElementById('break-active'),
  breakReturnTime: document.getElementById('break-return-time'),
  breakCountdown: document.getElementById('break-countdown'),
  btnReturnNow: document.getElementById('btn-return-now'),
  breakPresets: document.querySelectorAll('.btn-break')
};

let breakCountdownInterval = null;

let historyLoaded = false;

ui.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    ui.tabs.forEach(t => t.classList.toggle('active', t === tab));
    Object.entries(ui.tabPanels).forEach(([key, panel]) => {
      panel.classList.toggle('hidden', key !== target);
    });
    if (target === 'history' && !historyLoaded) {
      loadHistoryData();
    }
    if (target === 'settings') {
      loadSettingsData();
    }
  });
});

async function loadSettingsData() {
  const data = await Storage.get([Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.CLIENT_ID, Storage.KEYS.AUTO_CONFIG, Storage.KEYS.TENANT_SUBDOMAIN]);
  const hasToken = !!data[Storage.KEYS.REFRESH_TOKEN];
  const clientId = data[Storage.KEYS.CLIENT_ID];
  const tenant = data[Storage.KEYS.TENANT_SUBDOMAIN];

  ui.settingConnection.textContent = hasToken ? 'Connected' : 'Not connected';
  ui.settingConnection.className = 'setting-value ' + (hasToken ? 'connected' : 'disconnected');

  ui.settingTenant.textContent = tenant || 'not set';
  ui.settingTenant.title = tenant || '';

  ui.settingClientId.textContent = clientId || 'default (built-in)';
  ui.settingClientId.title = clientId || '';

  const cfg = { ...DEFAULT_AUTO_CONFIG, ...(data[Storage.KEYS.AUTO_CONFIG] || {}) };
  ui.autoOutEnabled.checked = !!cfg.outEnabled;
  ui.autoOutThreshold.value = minutesToHHMM(cfg.outThresholdMin);
  ui.autoInEnabled.checked = !!cfg.inEnabled;
  ui.autoInTime.value = cfg.inTime;
  updateAutomationRowState();
}

function minutesToHHMM(min) {
  const total = Math.max(0, Math.min(23 * 60 + 59, parseInt(min, 10) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':');
  const hh = parseInt(h, 10);
  const mm = parseInt(m, 10);
  if (isNaN(hh) || isNaN(mm)) return null;
  return hh * 60 + mm;
}

function updateAutomationRowState() {
  ui.autoOutRow.classList.toggle('disabled', !ui.autoOutEnabled.checked);
  ui.autoInRow.classList.toggle('disabled', !ui.autoInEnabled.checked);
  ui.autoOutThreshold.disabled = !ui.autoOutEnabled.checked;
  ui.autoInTime.disabled = !ui.autoInEnabled.checked;
}

let autoStatusTimer = null;
function flashAutomationStatus(msg) {
  ui.automationStatus.textContent = msg;
  ui.automationStatus.classList.remove('hidden');
  if (autoStatusTimer) clearTimeout(autoStatusTimer);
  autoStatusTimer = setTimeout(() => ui.automationStatus.classList.add('hidden'), 1800);
}

async function saveAutoConfig() {
  const outMin = hhmmToMinutes(ui.autoOutThreshold.value);
  const inTime = ui.autoInTime.value || DEFAULT_AUTO_CONFIG.inTime;
  const cfg = {
    outEnabled: !!ui.autoOutEnabled.checked,
    outThresholdMin: outMin === null || outMin < 1 ? DEFAULT_AUTO_CONFIG.outThresholdMin : outMin,
    inEnabled: !!ui.autoInEnabled.checked,
    inTime
  };
  await Storage.set({ [Storage.KEYS.AUTO_CONFIG]: cfg });
  // Nudge the background to reschedule the auto clock-in alarm immediately.
  try { await chrome.runtime.sendMessage({ type: 'auto_config_changed' }); } catch (_) {}
  flashAutomationStatus('Saved');
}

function bindAutomationInputs() {
  const onChange = () => {
    updateAutomationRowState();
    saveAutoConfig();
  };
  ui.autoOutEnabled.addEventListener('change', onChange);
  ui.autoInEnabled.addEventListener('change', onChange);
  ui.autoOutThreshold.addEventListener('change', saveAutoConfig);
  ui.autoInTime.addEventListener('change', saveAutoConfig);
}
bindAutomationInputs();

ui.btnReset.addEventListener('click', async () => {
  if (!confirm('Reset everything? This will clear all stored data — tokens, client ID, active break — and return to login.')) return;
  try {
    await chrome.alarms.clear('break_end');
    await new Promise(resolve => chrome.storage.sync.clear(resolve));
    chrome.action.setBadgeText({ text: '' });
    ui.refreshTokenInput.value = '';
    alert('Reset complete. Reconnect your account to continue.');
    showInit();
  } catch (e) {
    alert('Reset failed: ' + e.message);
  }
});

// Handle Avatar Errror (CSP Safe)
// ui.userAvatar.addEventListener('error', () => {
//   ui.userAvatar.style.display = 'none';
// });

async function init() {
  // Clock first so it ticks even while we're in the login flow.
  setInterval(updateClock, 1000);
  updateClock();

  // If any API call exhausts its retry/refresh paths, bounce back to login
  // with stale tokens cleared and try a silent auto-grab once.
  onAuthRequired(handleAuthRequired);

  const { [Storage.KEYS.REFRESH_TOKEN]: token } = await Storage.get(Storage.KEYS.REFRESH_TOKEN);
  if (token) {
    // Existing install with no tenant yet (e.g. upgraded from v1.0.0) — try
    // to discover it silently before hitting the dashboard, which needs it.
    if (!(await getTenantSubdomain())) {
      const cookieTenant = await discoverTenantFromCookie();
      if (cookieTenant) await setTenantSubdomain(cookieTenant);
      else {
        const tabTenant = await discoverTenantFromTabs();
        if (tabTenant) await setTenantSubdomain(tabTenant);
      }
    }
    if (await getTenantSubdomain()) {
      showDashboard();
      return;
    }
    // Tenant still unknown — surface the login form (tenant input) without
    // wiping tokens; the user just needs to tell us their workspace.
    showInit();
    await prefillTenantField();
    setLoginStatus('');
    setLoginError('Please enter your Keka workspace to continue.');
    ui.loginTenantInput.focus();
    return;
  }

  // No tokens — show the init view and silently try auto-grab first.
  showInit();
  await prefillTenantField();
  await trySilentAutoGrab();
}

// Best-effort fill of the tenant input on the login form so the user doesn't
// have to type their workspace if we can infer it (existing storage, the
// Subdomain cookie, or an open Keka tab).
async function prefillTenantField() {
  if (ui.loginTenantInput.value) return;
  const stored = await getTenantSubdomain();
  if (stored) { ui.loginTenantInput.value = stored.replace(/\.keka\.com$/i, ''); return; }
  const fromCookie = await discoverTenantFromCookie();
  if (fromCookie) { ui.loginTenantInput.value = fromCookie.replace(/\.keka\.com$/i, ''); return; }
  const fromTab = await discoverTenantFromTabs();
  if (fromTab) ui.loginTenantInput.value = fromTab.replace(/\.keka\.com$/i, '');
}

// One silent re-auth attempt per popup session. Without this latch, the
// dashboard's failed API calls would re-enter the handler in a loop.
let reauthAttempted = false;
async function handleAuthRequired() {
  if (reauthAttempted) {
    // Already tried recovery this session — stop bouncing the UI and let
    // the user sign in via the form.
    showInit();
    setLoginStatus('');
    setLoginError('Session expired. Please sign in again.');
    return;
  }
  reauthAttempted = true; // set synchronously so concurrent callers bail out

  await Storage.clear([
    Storage.KEYS.ACCESS_TOKEN,
    Storage.KEYS.REFRESH_TOKEN,
    Storage.KEYS.EXPIRES_AT
  ]);
  chrome.action.setBadgeText({ text: '' });
  showInit();
  setLoginStatus('Session expired — signing back in…');
  // trySilentAutoGrab() already calls showDashboard() internally on success.
  await trySilentAutoGrab();
}

function showInit() {
  views.init.classList.remove('hidden');
  views.dashboard.classList.add('hidden');
  setLoginStep('email');
  setLoginError('');
  setLoginStatus('');
  cancelLogin();
}

function setLoginStep(step) {
  ui.loginStepEmail.classList.toggle('hidden', step !== 'email');
  ui.loginStepPassword.classList.toggle('hidden', step !== 'password');
  ui.loginStepToken.classList.toggle('hidden', step !== 'token');
}

function setLoginStatus(msg) {
  if (!msg) {
    ui.loginStatus.classList.add('hidden');
    return;
  }
  ui.loginStatus.classList.remove('hidden');
  ui.loginStatus.textContent = msg;
}

function setLoginError(msg) {
  if (!msg) {
    ui.loginError.classList.add('hidden');
    ui.loginError.textContent = '';
    return;
  }
  ui.loginError.classList.remove('hidden');
  ui.loginError.textContent = msg;
}

async function trySilentAutoGrab() {
  setLoginStatus('Checking for an open Keka session…');
  try {
    const grabbed = await grabTokensFromKekaTab();
    if (grabbed && grabbed.token) {
      const updates = { [Storage.KEYS.REFRESH_TOKEN]: grabbed.token };
      if (grabbed.clientId) updates[Storage.KEYS.CLIENT_ID] = grabbed.clientId;
      if (grabbed.tenant) updates[Storage.KEYS.TENANT_SUBDOMAIN] = grabbed.tenant;
      if (grabbed.accessToken) {
        updates[Storage.KEYS.ACCESS_TOKEN] = grabbed.accessToken;
        const expiresAtMs = grabbed.expiresAt
          ? grabbed.expiresAt * 1000
          : Date.now() + 5 * 60 * 1000;
        updates[Storage.KEYS.EXPIRES_AT] = expiresAtMs - 60000;
      }
      await Storage.set(updates);
      // Validate by trying a refresh; if that fails, treat as auto-grab failure.
      try {
        await API.refreshToken();
      } catch (_) {
        // refresh failed, but we still have an access token captured — let the UI try.
      }
      showDashboard();
      return true;
    }
  } catch (e) {
    console.warn('Silent auto-grab failed', e);
  }
  setLoginStatus('No Keka session found — sign in below.');
  setLoginStep('email');
  ui.loginEmailInput.focus();
  return false;
}

async function showDashboard() {
  views.init.classList.add('hidden');
  views.dashboard.classList.remove('hidden');
  setConnected(true);

  await loadUserData();
  await loadAttendanceData();
  await refreshBreakState();
}

function setConnected(isConnected) {
  if (isConnected) {
    ui.connectionStatus.classList.add('connected');
    ui.statusText.textContent = 'Active';
  } else {
    ui.connectionStatus.classList.remove('connected');
    ui.statusText.textContent = 'Disconnected';
  }
}

function updateClock() {
  const now = new Date();
  ui.currentTime.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// === Email / password / captcha login ===

ui.btnLoginContinue.addEventListener('click', async () => {
  const tenantInput = ui.loginTenantInput.value.trim();
  const email = ui.loginEmailInput.value.trim();
  if (!tenantInput) {
    setLoginError('Enter your Keka workspace (the subdomain before .keka.com).');
    ui.loginTenantInput.focus();
    return;
  }
  let tenant;
  try {
    tenant = normalizeTenant(tenantInput);
    if (!tenant) throw new Error('bad');
  } catch (_) {
    setLoginError('That workspace doesn\'t look right — use the subdomain only (e.g. "acme").');
    ui.loginTenantInput.focus();
    return;
  }
  if (!email) {
    setLoginError('Please enter your work email.');
    return;
  }
  setLoginError('');
  setLoginStatus('Requesting captcha…');
  ui.btnLoginContinue.disabled = true;
  try {
    const previousTenant = await getTenantSubdomain();
    await setTenantSubdomain(tenant);
    // Switching workspaces invalidates any cached tokens (they were issued
    // by the previous tenant). Drop them so we don't mix credentials.
    if (previousTenant && previousTenant !== tenant) {
      await Storage.clear([Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.EXPIRES_AT, Storage.KEYS.CLIENT_ID]);
    }
    const { captchaDataUrl } = await startEmailLogin(email);
    ui.captchaImage.src = captchaDataUrl;
    ui.loginEmailDisplay.textContent = email;
    ui.loginPasswordInput.value = '';
    ui.loginCaptchaInput.value = '';
    setLoginStep('password');
    setLoginStatus('');
    ui.loginPasswordInput.focus();
  } catch (e) {
    console.error('Email login start failed', e);
    setLoginError(e.message || 'Could not start login.');
    setLoginStatus('');
  } finally {
    ui.btnLoginContinue.disabled = false;
  }
});

ui.btnLoginChangeEmail.addEventListener('click', () => {
  cancelLogin();
  setLoginStep('email');
  setLoginError('');
  setLoginStatus('');
  ui.loginEmailInput.focus();
});

ui.btnTogglePassword.addEventListener('click', () => {
  const showing = ui.loginPasswordInput.type === 'text';
  ui.loginPasswordInput.type = showing ? 'password' : 'text';
  ui.btnTogglePassword.textContent = showing ? 'Show' : 'Hide';
  ui.btnTogglePassword.setAttribute('aria-pressed', String(!showing));
  ui.btnTogglePassword.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

ui.btnCaptchaRefresh.addEventListener('click', async () => {
  ui.btnCaptchaRefresh.disabled = true;
  try {
    const dataUrl = await refreshCaptcha();
    ui.captchaImage.src = dataUrl;
    ui.loginCaptchaInput.value = '';
    ui.loginCaptchaInput.focus();
  } catch (e) {
    setLoginError(e.message || 'Could not refresh captcha.');
  } finally {
    ui.btnCaptchaRefresh.disabled = false;
  }
});

ui.btnLoginSubmit.addEventListener('click', async () => {
  const password = ui.loginPasswordInput.value;
  const captcha = ui.loginCaptchaInput.value.trim();
  if (!password) { setLoginError('Enter your password.'); return; }
  if (!captcha) { setLoginError('Enter the captcha.'); return; }

  setLoginError('');
  setLoginStatus('Signing in…');
  ui.btnLoginSubmit.disabled = true;
  try {
    await completeLogin(password, captcha);
    setLoginStatus('');
    showDashboard();
  } catch (e) {
    console.error('Login failed', e);
    setLoginError(e.message || 'Sign-in failed.');
    setLoginStatus('');
    // Server already rotated the captcha — show the fresh one if we have it.
    if (e.captchaDataUrl) {
      ui.captchaImage.src = e.captchaDataUrl;
      ui.loginCaptchaInput.value = '';
      ui.loginCaptchaInput.focus();
    }
  } finally {
    ui.btnLoginSubmit.disabled = false;
  }
});

// Submit on Enter in either step
ui.loginEmailInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); ui.btnLoginContinue.click(); }
});
[ui.loginPasswordInput, ui.loginCaptchaInput].forEach(el => {
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ui.btnLoginSubmit.click(); }
  });
});

// === Advanced: paste refresh_token (kept as escape hatch) ===
ui.btnShowTokenPaste.addEventListener('click', () => {
  setLoginStep('token');
  setLoginStatus('');
  setLoginError('');
  ui.refreshTokenInput.focus();
});

ui.btnSaveToken.addEventListener('click', async () => {
  const token = ui.refreshTokenInput.value.trim();
  if (!token) return;

  if (!(await getTenantSubdomain())) {
    setLoginError('Set your Keka workspace first — switch back from "Advanced" and fill the workspace field.');
    setLoginStep('email');
    ui.loginTenantInput.focus();
    return;
  }

  await Storage.set({ [Storage.KEYS.REFRESH_TOKEN]: token });

  try {
    await API.refreshToken();
    showDashboard();
    return;
  } catch (e) {
    console.warn('Refresh token exchange failed; checking for grabbed access token', e);
  }

  const stored = await Storage.get([Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.EXPIRES_AT]);
  const accessToken = stored[Storage.KEYS.ACCESS_TOKEN];
  const expiresAt = stored[Storage.KEYS.EXPIRES_AT];

  if (accessToken && expiresAt && Date.now() < expiresAt) {
    showDashboard();
    return;
  }

  setLoginError('Invalid refresh token or network error.');
  await Storage.clear([Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.EXPIRES_AT]);
});

ui.btnAutoGrab.addEventListener('click', async () => {
  setLoginError('');
  setLoginStatus('Looking for an open Keka tab…');
  ui.btnAutoGrab.disabled = true;
  try {
    const storageResult = await grabTokensFromKekaTab();
    if (storageResult === null) {
      setLoginError('No Keka tab found. Open your Keka workspace (e.g. https://acme.keka.com) and sign in, then retry.');
      setLoginStatus('');
      return;
    }

    if (storageResult && storageResult.token) {
      const updates = { [Storage.KEYS.REFRESH_TOKEN]: storageResult.token };
      if (storageResult.clientId) updates[Storage.KEYS.CLIENT_ID] = storageResult.clientId;
      if (storageResult.tenant) updates[Storage.KEYS.TENANT_SUBDOMAIN] = storageResult.tenant;
      if (storageResult.accessToken) {
        updates[Storage.KEYS.ACCESS_TOKEN] = storageResult.accessToken;
        const expiresAtMs = storageResult.expiresAt
          ? storageResult.expiresAt * 1000
          : Date.now() + 5 * 60 * 1000;
        updates[Storage.KEYS.EXPIRES_AT] = expiresAtMs - 60000;
      }
      await Storage.set(updates);
      setLoginStatus('');
      showDashboard();
      return;
    }

    const cookies = await chrome.cookies.getAll({ domain: '.keka.com' });
    const tokenCookie = cookies.find(c => /refresh.?token/i.test(c.name));
    if (tokenCookie) {
      await Storage.set({ [Storage.KEYS.REFRESH_TOKEN]: decodeURIComponent(tokenCookie.value) });
      setLoginStatus('');
      showDashboard();
      return;
    }

    setLoginError('Could not find a refresh token in the open Keka tab.');
    setLoginStatus('');
  } catch (e) {
    setLoginError('Auto-grab failed: ' + e.message);
    setLoginStatus('');
  } finally {
    ui.btnAutoGrab.disabled = false;
  }
});

ui.btnClockIn.addEventListener('click', () => performPunch('IN'));
ui.btnClockOut.addEventListener('click', () => performPunch('OUT'));

// Break feature
ui.breakPresets.forEach(btn => {
  btn.addEventListener('click', () => {
    let mins = parseInt(btn.dataset.min, 10);
    if (mins === 0) {
      const input = prompt('Break duration in minutes (1–480):', '30');
      if (input === null) return; // cancelled
      mins = parseInt(input, 10);
      if (isNaN(mins) || mins < 1 || mins > 480) {
        alert('Please enter a whole number between 1 and 480.');
        return;
      }
    }
    if (mins > 0) startBreak(mins);
  });
});

ui.btnReturnNow.addEventListener('click', returnFromBreak);

async function refreshBreakState() {
  const { [Storage.KEYS.ACTIVE_BREAK]: active } = await Storage.get(Storage.KEYS.ACTIVE_BREAK);
  if (active && active.returnAt && active.returnAt > Date.now()) {
    showActiveBreakUI(active);
  } else {
    if (active) await Storage.clear([Storage.KEYS.ACTIVE_BREAK]); // expired
    showIdleBreakUI();
  }
}

function showActiveBreakUI(active) {
  ui.breakIdle.classList.add('hidden');
  ui.breakActive.classList.remove('hidden');
  ui.breakReturnTime.textContent = new Date(active.returnAt).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit'
  });
  if (breakCountdownInterval) clearInterval(breakCountdownInterval);
  const tick = () => {
    const remaining = active.returnAt - Date.now();
    if (remaining <= 0) {
      ui.breakCountdown.innerHTML = 'Returning...<span class="label">Auto Punch IN</span>';
      ui.statusText.textContent = 'Returning...';
      clearInterval(breakCountdownInterval);
      return;
    }
    const totalSec = Math.floor(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const mm = m.toString().padStart(2, '0');
    const ss = s.toString().padStart(2, '0');
    ui.breakCountdown.innerHTML = `${mm}:${ss}<span class="label">Remaining</span>`;
    ui.statusText.textContent = `On Break · ${m}m left`;
    ui.statusDot.style.backgroundColor = '#ffa726';
  };
  tick();
  breakCountdownInterval = setInterval(tick, 1000);
}

function showIdleBreakUI() {
  ui.breakIdle.classList.remove('hidden');
  ui.breakActive.classList.add('hidden');
  if (breakCountdownInterval) {
    clearInterval(breakCountdownInterval);
    breakCountdownInterval = null;
  }
}

async function startBreak(mins) {
  if (!confirm(`Take a ${mins}-minute break? You will be punched OUT now and back IN automatically after ${mins} minutes.`)) return;

  try {
    const res = await API.clockInOrOut('OUT');
    if (!res.ok) {
      alert('Punch OUT failed. Break not started.');
      return;
    }

    const returnAt = Date.now() + mins * 60 * 1000;
    await Storage.set({
      [Storage.KEYS.ACTIVE_BREAK]: { startedAt: Date.now(), returnAt, durationMin: mins }
    });
    chrome.alarms.create('break_end', { when: returnAt });

    // Optimistic UI
    updateButtonState('OUT');
    ui.statusText.textContent = 'On Break';
    ui.statusDot.style.backgroundColor = '#ffa726';

    showActiveBreakUI({ returnAt });
    setTimeout(loadAttendanceData, 800);
    setTimeout(() => chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}), 900);
  } catch (e) {
    alert('Error starting break: ' + e.message);
  }
}

async function returnFromBreak() {
  if (!confirm('Return from break now? You will be punched IN immediately.')) return;
  try {
    chrome.alarms.clear('break_end');
    await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);

    const res = await API.clockInOrOut('IN');
    if (res.ok) {
      updateButtonState('IN');
      ui.statusText.textContent = 'Clocked In';
      ui.statusDot.style.backgroundColor = '#66bb6a';
      showIdleBreakUI();
      setTimeout(loadAttendanceData, 800);
      setTimeout(() => chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}), 900);
    } else {
      alert('Punch IN failed. Try again manually.');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function performPunch(type) {
  if (!confirm(`Are you sure you want to Punch ${type}?`)) return;

  try {
    const response = await API.clockInOrOut(type);
    if (response.ok) {
       alert('Punch Successful!');
       updateButtonState(type);
       ui.statusText.textContent = type === 'IN' ? 'Clocked In' : 'Clocked Out';
       ui.statusDot.style.backgroundColor = type === 'IN' ? '#66bb6a' : '#bdbdbd';
       setTimeout(loadAttendanceData, 800);
       setTimeout(() => chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}), 900);
    } else {
       alert('Punch Request Failed. check logs.');
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function loadUserData() {
    try {
        const response = await API.request(await tenantUrl('/k/dashboard/api/context'));
        if (response.ok) {
            let data = await response.json();
            if (data.data) {
                data = data.data;
            }
            
            // Name
            const name = data.employee?.displayName || 'Employee';
            ui.userName.textContent = name;
            
            // Department / Title
            let subtitle = 'Keka User';
            if (data.employee?.jobDetails?.departmentId && data.departments) {
                 const dept = data.departments.find(d => d.id === data.employee.jobDetails.departmentId);
                 if (dept) subtitle = dept.name;
            }
            ui.userTitle.textContent = subtitle;

            // Avatar construction: https://{domain}{publicStorage}/150x150/{profileImage}
            const domain = data.org.subDomainName;
            const storageUrl = data.org.publicStorageAccountUrl;
            const profileImage = data?.employee?.profileImageUrl;
            // console.log(domain, storageUrl, profileImage , {
            //   imagurl:`https://${domain}${storageUrl}/150x150/${profileImage}`
            // });
            // ui.userAvatar.setAttribute('src', 'https://zujo.keka.com/files/71fdda59-d8f8-4c09-b319-4427459782af/50x50/profileimage/636820eb96404f9695b2567930a25751.jpg');
            if (domain && storageUrl && profileImage) {
                // ui.userAvatar.style.display = 'block';
                ui.userAvatar.setAttribute('src', `https://${domain}${storageUrl}/50x50/${profileImage}`);
            } else if (profileImage && domain) {
                 // Fallback
            }
        }
    } catch (e) {
        console.error('Failed to load user data', e);
    }
}

async function loadAvatarImage(url) {
    try {
        const response = await API.request(url);
        if (response.ok) {
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            ui.userAvatar.src = objectUrl;
            ui.userAvatar.style.display = 'block';
        }
    } catch (error) {
        console.warn('Failed to fetch avatar blob', error);
        // Fallback to direct src if blob fetch fails (unlikely to work if CORS is issue, but good safeguard)
        ui.userAvatar.src = url;
    }
}


async function loadAttendanceData() {
    try {
        const response = await API.request(await tenantUrl('/k/attendance/api/mytime/attendance/attendancedayrequests'));

        if (response.ok) {
           let data = await response.json();
           if (data.data) data = data.data; // Unwrap envelope

           const webEntries = data.webclockin?.flatMap(r => r.timeEntries || []) || [];
           const remoteEntries = data.remoteclockin?.flatMap(r => r.timeEntries || []) || [];
           const entries = [...webEntries, ...remoteEntries];

           if (entries.length > 0) {
             entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

             const firstPunch = entries[0];
             const lastPunch = entries[entries.length - 1];
             const isClockedIn = lastPunch.punchStatus === 0;

             ui.statIn.textContent = formatTime(firstPunch.timestamp);
             ui.statOut.textContent = isClockedIn ? 'On Duty' : formatTime(lastPunch.timestamp);

             const totalDuration = calculateDuration(entries);
             ui.statDuration.textContent = formatDuration(totalDuration);

             renderHistory(entries);

             setConnected(true);
             ui.statusText.textContent = isClockedIn ? 'Clocked In' : 'Clocked Out';
             ui.statusDot.style.backgroundColor = isClockedIn ? '#66bb6a' : '#bdbdbd';
             updateButtonState(isClockedIn ? 'IN' : 'OUT');
           } else {
             ui.statIn.textContent = '--:--';
             ui.statOut.textContent = '--:--';
             ui.statDuration.textContent = '0h 0m';
             ui.historyList.innerHTML = '<div style="text-align:center; color: var(--text-muted); font-size: 12px; padding: 8px;">No activity yet</div>';
             updateButtonState(null);
           }
        }
    } catch (e) {
        console.error('Failed to load attendance', e);
    }
}

function updateButtonState(lastStatus) {
    const clockedIn = lastStatus === 'IN';

    if (lastStatus === 'IN') {
        ui.btnClockIn.disabled = true;
        ui.btnClockOut.disabled = false;
    } else if (lastStatus === 'OUT') {
        ui.btnClockIn.disabled = false;
        ui.btnClockOut.disabled = true;
    } else {
        ui.btnClockIn.disabled = false;
        ui.btnClockOut.disabled = true;
    }

    // Break presets only make sense while clocked in
    ui.breakPresets.forEach(btn => {
        btn.disabled = !clockedIn;
    });
}

function renderHistory(entries) {
    ui.historyList.innerHTML = '';
    // Reverse order: Newest first
    const reversed = [...entries].reverse();
    
    reversed.forEach(entry => {
        const item = document.createElement('div');
        const isIn = entry.punchStatus === 0;
        item.className = `history-item ${isIn ? 'in' : 'out'}`;
        
        const timeStr = formatTime(entry.timestamp);
        const typeStr = isIn ? 'Punch In' : 'Punch Out';
        
        item.innerHTML = `
            <span class="type">${typeStr}</span>
            <span class="time">${timeStr}</span>
        `;
        ui.historyList.appendChild(item);
    });
}

async function loadHistoryData() {
    ui.dayList.innerHTML = '<div style="text-align:center; color: var(--text-muted); font-size: 12px; padding: 16px;">Loading...</div>';
    try {
        const response = await API.request(await tenantUrl('/k/attendance/api/mytime/attendance/summary'));
        if (!response.ok) {
            ui.dayList.innerHTML = '<div style="text-align:center; color: var(--danger); font-size: 12px; padding: 16px;">Failed to load history</div>';
            return;
        }

        let payload = await response.json();
        if (payload && payload.data) payload = payload.data;
        const days = Array.isArray(payload) ? payload : [];

        const todayISO = new Date().toISOString().slice(0, 10);
        // Exclude today and sort descending (most recent first)
        const past = days
            .filter(d => (d.attendanceDate || '').slice(0, 10) < todayISO)
            .sort((a, b) => new Date(b.attendanceDate) - new Date(a.attendanceDate));

        if (past.length === 0) {
            ui.dayList.innerHTML = '<div style="text-align:center; color: var(--text-muted); font-size: 12px; padding: 16px;">No previous days</div>';
            historyLoaded = true;
            return;
        }

        ui.dayList.innerHTML = '';
        past.forEach(day => ui.dayList.appendChild(renderDayItem(day)));
        historyLoaded = true;
    } catch (e) {
        console.error('Failed to load history', e);
        ui.dayList.innerHTML = '<div style="text-align:center; color: var(--danger); font-size: 12px; padding: 16px;">Error: ' + e.message + '</div>';
    }
}

function renderDayItem(day) {
    const item = document.createElement('div');
    item.className = 'day-item';

    const date = new Date(day.attendanceDate);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    // Determine badge
    let badge = { label: 'Absent', cls: 'absent' };
    if (day.dayType === 2) {
        badge = { label: 'Weekend', cls: 'weekend' };
    } else if (day.leaveDetails && day.leaveDetails.length > 0) {
        badge = { label: day.leaveDetails[0].leaveTypeName || 'Leave', cls: 'leave' };
    } else if (day.attendanceDayStatus === 1 || (day.timeEntries && day.timeEntries.length > 0)) {
        badge = { label: 'Present', cls: 'present' };
    }

    const inTime = day.firstLogOfTheDay ? formatTime(day.firstLogOfTheDay) : '--:--';
    const outTime = day.lastLogOfTheDay ? formatTime(day.lastLogOfTheDay) : '--:--';
    const hours = day.effectiveHoursInHHMM || '0h 0m';
    const showTimes = day.firstLogOfTheDay || day.lastLogOfTheDay;

    item.innerHTML = `
        <div class="day-header">
            <span class="date">${dateStr}</span>
            <span class="badge ${badge.cls}">${badge.label}</span>
        </div>
        <div class="meta">
            <span>${showTimes ? `${inTime} → ${outTime}` : (day.arrivalMessage || '—')}</span>
            <span class="hours">${hours}</span>
        </div>
    `;
    return item;
}

function formatTime(isoString) {
  if (!isoString) return '--:--';
  return new Date(isoString).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function calculateDuration(entries) {
  let totalMs = 0;
  let inTime = null;

  for (const entry of entries) {
    if (entry.punchStatus === 0) { // IN
      inTime = new Date(entry.timestamp);
    } else if (entry.punchStatus === 1 && inTime) { // OUT
      totalMs += (new Date(entry.timestamp) - inTime);
      inTime = null;
    }
  }

  // If currently clocked in, add time until now
  if (inTime) {
     totalMs += (new Date() - inTime);
  }

  return totalMs;
}

function formatDuration(ms) {
  const h = Math.floor(ms / (1000 * 60 * 60));
  const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${h}h ${m}m`;
}

init();
