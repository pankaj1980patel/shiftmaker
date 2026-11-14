import { Storage, DEFAULT_AUTO_CONFIG, DEFAULT_BIRTHDAY_WISH, clearCaches } from './utils/storage.js';
import { API, onAuthRequired } from './utils/api.js';
import { grabTokensFromKekaTab, saveGrabbedTokens } from './utils/grab-tokens.js';
import { fetchTodayAttendance } from './utils/attendance.js';
import { dateKey, hhmmToMinutes, minutesToHHMM, formatDuration, formatClock, unwrap } from './utils/time.js';
import { fetchBirthdays, birthdayWhen } from './utils/birthdays.js';
import {
  getDayStatus,
  getWeekSchedule,
  getHolidays,
  getLeave,
  getOnLeaveToday,
  getInboxCounts,
  getTargetHours,
  KEKA_ROUTES
} from './utils/workday.js';
import {
  startEmailLogin,
  completeLogin,
  refreshCaptcha,
  cancelLogin,
  sendOtpCode,
  verifyOtpCode,
  resendOtpCode,
  restoreLogin
} from './utils/auth-login.js';
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
  loginStepOtp: document.getElementById('login-step-otp'),
  otpChoose: document.getElementById('otp-choose'),
  otpProviders: document.getElementById('otp-providers'),
  otpVerify: document.getElementById('otp-verify'),
  otpDestination: document.getElementById('otp-destination'),
  otpInput: document.getElementById('login-otp'),
  btnOtpVerify: document.getElementById('btn-otp-verify'),
  btnOtpResend: document.getElementById('btn-otp-resend'),
  btnOtpRestart: document.getElementById('btn-otp-restart'),
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
  avatarInitials: document.getElementById('avatar-initials'),
  currentDate: document.getElementById('current-date'),
  statePill: document.getElementById('state-pill'),
  targetLabel: document.getElementById('target-label'),
  progressBar: document.getElementById('progress-bar'),
  progressFill: document.getElementById('progress-fill'),
  progressLeft: document.getElementById('progress-left'),
  progressEta: document.getElementById('progress-eta'),
  attendanceError: document.getElementById('attendance-error'),
  toast: document.getElementById('toast'),
  breakHint: document.getElementById('break-hint'),
  breakCustom: document.getElementById('break-custom'),
  breakCustomInput: document.getElementById('break-custom-input'),
  btnBreakCustomStart: document.getElementById('btn-break-custom-start'),
  currentTime: document.getElementById('current-time'),
  statIn: document.getElementById('stat-in'),
  statOut: document.getElementById('stat-out'),
  statDuration: document.getElementById('stat-duration'),
  btnClockIn: document.getElementById('btn-clock-in'),
  btnClockOut: document.getElementById('btn-clock-out'),
  historyList: document.getElementById('history-list'),
  dayList: document.getElementById('day-list'),
  historySummary: document.getElementById('history-summary'),
  tabs: document.querySelectorAll('.tab'),
  tabPanels: {
    today: document.getElementById('tab-today'),
    overview: document.getElementById('tab-overview'),
    history: document.getElementById('tab-history'),
    settings: document.getElementById('tab-settings')
  },
  settingConnection: document.getElementById('setting-connection'),
  settingTenant: document.getElementById('setting-tenant'),
  btnReset: document.getElementById('btn-reset'),
  autoOutEnabled: document.getElementById('auto-out-enabled'),
  autoOutThreshold: document.getElementById('auto-out-threshold'),
  autoOutRow: document.getElementById('auto-out-row'),
  autoInEnabled: document.getElementById('auto-in-enabled'),
  autoInTime: document.getElementById('auto-in-time'),
  autoInRow: document.getElementById('auto-in-row'),
  autoBreakEnabled: document.getElementById('auto-break-enabled'),
  autoBreakFrom: document.getElementById('auto-break-from'),
  autoBreakTo: document.getElementById('auto-break-to'),
  autoBreakMinutes: document.getElementById('auto-break-minutes'),
  autoBreakWindowRow: document.getElementById('auto-break-window-row'),
  autoBreakLengthRow: document.getElementById('auto-break-length-row'),
  birthdayNotify: document.getElementById('birthday-notify'),
  approvalNotify: document.getElementById('approval-notify'),
  skipDaysOff: document.getElementById('skip-days-off'),
  settingShift: document.getElementById('setting-shift'),
  btnUseShiftTimes: document.getElementById('btn-use-shift-times'),
  dayStatus: document.getElementById('day-status'),
  overviewDot: document.getElementById('overview-dot'),
  inboxApprovals: document.getElementById('inbox-approvals'),
  inboxApprovalsCount: document.getElementById('inbox-approvals-count'),
  inboxNotifications: document.getElementById('inbox-notifications'),
  inboxNotificationsCount: document.getElementById('inbox-notifications-count'),
  leaveList: document.getElementById('leave-list'),
  holidayList: document.getElementById('holiday-list'),
  onLeaveList: document.getElementById('onleave-list'),
  onLeaveCount: document.getElementById('onleave-count'),
  weekStrip: document.getElementById('week-strip'),
  weekNote: document.getElementById('week-note'),
  inboxApprovalsState: document.getElementById('inbox-approvals-state'),
  inboxNotificationsState: document.getElementById('inbox-notifications-state'),
  birthdayCard: document.getElementById('birthday-card'),
  birthdayWish: document.getElementById('birthday-wish'),
  btnWishReset: document.getElementById('btn-wish-reset'),
  birthdayList: document.getElementById('birthday-list'),
  settingVersion: document.getElementById('setting-version'),
  breakIdle: document.getElementById('break-idle'),
  breakActive: document.getElementById('break-active'),
  breakReturnTime: document.getElementById('break-return-time'),
  breakCountdown: document.getElementById('break-countdown'),
  btnReturnNow: document.getElementById('btn-return-now'),
  breakPresets: document.querySelectorAll('.btn-break')
};

let breakCountdownInterval = null;

let historyLoaded = false;

// Arrow keys / Home / End move between tabs (roving tabindex).
ui.tabs.forEach((tab, i, all) => {
  tab.addEventListener('keydown', (ev) => {
    const n = all.length;
    const next = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[ev.key];
    if (next === undefined) return;
    ev.preventDefault();
    all[next].focus();
    all[next].click();
  });
});

ui.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    ui.tabs.forEach(t => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
      t.tabIndex = t === tab ? 0 : -1;
    });
    Object.entries(ui.tabPanels).forEach(([key, panel]) => {
      panel.classList.toggle('hidden', key !== target);
    });
    if (target === 'history' && !historyLoaded) {
      loadHistoryData();
    }
    if (target === 'overview') {
      loadOverview();
    }
    if (target === 'settings') {
      loadSettingsData();
    }
  });
});

async function loadSettingsData() {
  const data = await Storage.get([Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.CLIENT_ID, Storage.KEYS.AUTO_CONFIG, Storage.KEYS.TENANT_SUBDOMAIN]);
  const hasToken = !!data[Storage.KEYS.REFRESH_TOKEN];
  const tenant = data[Storage.KEYS.TENANT_SUBDOMAIN];

  ui.settingConnection.textContent = hasToken ? 'Connected' : 'Not connected';
  ui.settingConnection.className = 'setting-value ' + (hasToken ? 'connected' : 'disconnected');

  ui.settingTenant.textContent = tenant || 'not set';
  ui.settingVersion.textContent = chrome.runtime.getManifest?.().version || '—';
  prefillBugReport();
  ui.settingTenant.title = tenant || '';


  const cfg = { ...DEFAULT_AUTO_CONFIG, ...(data[Storage.KEYS.AUTO_CONFIG] || {}) };
  ui.autoOutEnabled.checked = !!cfg.outEnabled;
  ui.autoOutThreshold.value = minutesToHHMM(cfg.outThresholdMin);
  ui.autoInEnabled.checked = !!cfg.inEnabled;
  ui.autoInTime.value = cfg.inTime;
  ui.autoBreakEnabled.checked = !!cfg.breakEnabled;
  ui.autoBreakFrom.value = cfg.breakFrom;
  ui.autoBreakTo.value = cfg.breakTo;
  ui.autoBreakMinutes.value = cfg.breakMinutes;
  ui.birthdayNotify.checked = cfg.birthdayNotify !== false;
  ui.approvalNotify.checked = cfg.approvalNotify !== false;
  ui.skipDaysOff.checked = cfg.skipDaysOff !== false;
  updateAutomationRowState();
  loadShiftInfo();
  ui.birthdayWish.value = await getWishTemplate();
}

function updateAutomationRowState() {
  ui.autoOutRow.classList.toggle('disabled', !ui.autoOutEnabled.checked);
  ui.autoInRow.classList.toggle('disabled', !ui.autoInEnabled.checked);
  ui.autoOutThreshold.disabled = !ui.autoOutEnabled.checked;
  ui.autoInTime.disabled = !ui.autoInEnabled.checked;
  const breakOn = ui.autoBreakEnabled.checked;
  ui.autoBreakWindowRow.classList.toggle('disabled', !breakOn);
  ui.autoBreakLengthRow.classList.toggle('disabled', !breakOn);
  ui.autoBreakFrom.disabled = ui.autoBreakTo.disabled = ui.autoBreakMinutes.disabled = !breakOn;
}

function flashAutomationStatus(msg, ms = 1800) {
  toast(msg, ms > 2000 ? 'warn' : 'success', ms);
}

async function saveAutoConfig() {
  const outMin = hhmmToMinutes(ui.autoOutThreshold.value);
  const inTime = ui.autoInTime.value || DEFAULT_AUTO_CONFIG.inTime;
  const breakFrom = ui.autoBreakFrom.value || DEFAULT_AUTO_CONFIG.breakFrom;
  const breakTo = ui.autoBreakTo.value || DEFAULT_AUTO_CONFIG.breakTo;
  const breakMinutes = Math.min(240, Math.max(1, parseInt(ui.autoBreakMinutes.value, 10) || DEFAULT_AUTO_CONFIG.breakMinutes));
  ui.autoBreakMinutes.value = breakMinutes;
  const cfg = {
    outEnabled: !!ui.autoOutEnabled.checked,
    outThresholdMin: outMin === null || outMin < 1 ? DEFAULT_AUTO_CONFIG.outThresholdMin : outMin,
    inEnabled: !!ui.autoInEnabled.checked,
    inTime,
    birthdayNotify: !!ui.birthdayNotify.checked,
    approvalNotify: !!ui.approvalNotify.checked,
    skipDaysOff: !!ui.skipDaysOff.checked,
    breakEnabled: !!ui.autoBreakEnabled.checked,
    breakFrom,
    breakTo,
    breakMinutes
  };
  await Storage.set({ [Storage.KEYS.AUTO_CONFIG]: cfg });
  // Nudge the background to reschedule the auto clock-in alarm immediately.
  try { await chrome.runtime.sendMessage({ type: 'auto_config_changed' }); } catch (_) {}
  const windowMin = (hhmmToMinutes(breakTo) ?? 0) - (hhmmToMinutes(breakFrom) ?? 0);
  if (cfg.breakEnabled && windowMin < breakMinutes) {
    flashAutomationStatus(`Saved — but the break window is shorter than ${breakMinutes} min, so no auto break will happen.`, 5000);
  } else {
    flashAutomationStatus('Saved');
  }
}

function bindAutomationInputs() {
  const onChange = () => {
    updateAutomationRowState();
    saveAutoConfig();
  };
  ui.autoOutEnabled.addEventListener('change', onChange);
  ui.autoInEnabled.addEventListener('change', onChange);
  ui.autoBreakEnabled.addEventListener('change', onChange);
  ui.autoBreakFrom.addEventListener('change', saveAutoConfig);
  ui.autoBreakTo.addEventListener('change', saveAutoConfig);
  ui.autoBreakMinutes.addEventListener('change', saveAutoConfig);
  ui.birthdayNotify.addEventListener('change', saveAutoConfig);
  ui.approvalNotify.addEventListener('change', saveAutoConfig);
  ui.skipDaysOff.addEventListener('change', saveAutoConfig);
  ui.autoOutThreshold.addEventListener('change', saveAutoConfig);
  ui.autoInTime.addEventListener('change', saveAutoConfig);
}
bindAutomationInputs();

confirmTwice(ui.btnReset, 'Really? Tap again 🥺', async () => {
  try {
    await chrome.alarms.clear('break_end');
    await Storage.resetThisDevice(); // synced settings are kept
    chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}); // resets badge & tooltip
    ui.refreshTokenInput.value = '';
    showInit();
    setLoginStatus('Signed out 👋 Your settings are safe and sound.');
  } catch (e) {
    toast(`Reset failed: ${e.message}`, 'error', 6000);
  }
});

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

  // No tokens. An unfinished sign-in (popup closed to read the OTP)? Resume it.
  const pending = await restoreLogin();
  if (pending) {
    showInit({ keepPending: true });
    await prefillTenantField();
    resumeLogin(pending);
    return;
  }

  // Otherwise show the init view and silently try auto-grab first.
  showInit();
  await prefillTenantField();
  await trySilentAutoGrab();
}

function resumeLogin(pending) {
  ui.loginEmailInput.value = pending.email || '';
  ui.loginEmailDisplay.textContent = pending.email || '';
  setLoginStatus('Picking up where you left off.');
  if (pending.stage === 'password') {
    if (pending.captchaDataUrl) ui.captchaImage.src = pending.captchaDataUrl;
    setLoginStep('password');
    ui.loginPasswordInput.focus();
  } else if (pending.stage === 'otp_choose') {
    setLoginStep('otp');
    renderOtpProviders(pending.providers || []);
  } else if (pending.stage === 'otp_verify') {
    setLoginStep('otp');
    showOtpVerify(pending.destination, { restartCooldown: false });
  }
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
  chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}); // resets icon, badge & tooltip
  showInit();
  setLoginStatus('Session expired — signing back in…');
  // trySilentAutoGrab() already calls showDashboard() internally on success.
  await trySilentAutoGrab();
}

function showInit({ keepPending = false } = {}) {
  views.init.classList.remove('hidden');
  views.dashboard.classList.add('hidden');
  setLoginStep('email');
  setLoginError('');
  setLoginStatus('');
  if (!keepPending) cancelLogin();
}

function setLoginStep(step) {
  ui.loginStepEmail.classList.toggle('hidden', step !== 'email');
  ui.loginStepPassword.classList.toggle('hidden', step !== 'password');
  ui.loginStepToken.classList.toggle('hidden', step !== 'token');
  ui.loginStepOtp.classList.toggle('hidden', step !== 'otp');
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

// Pre-fill the GitHub issue with version + browser (nothing personal) so a
// bug report is one click and the frog has what it needs to debug.
function prefillBugReport() {
  const link = document.getElementById('about-bug');
  if (!link) return;
  const version = chrome.runtime.getManifest?.().version || '?';
  const chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
  const body = [
    '**What happened?**', '', '',
    '**What did you expect?**', '', '',
    '**Steps to reproduce**', '1. ', '',
    '---',
    `ShiftMate ${version} · Chrome ${chromeVer} · ${navigator.platform || '?'}`,
    '_Please don’t paste tokens, passwords or colleagues’ names._'
  ].join('\n');
  const url = new URL('https://github.com/pankaj1980patel/shiftmaker/issues/new');
  url.searchParams.set('labels', 'bug');
  url.searchParams.set('body', body);
  link.href = url.toString();
}

async function trySilentAutoGrab() {
  setLoginStatus('Checking for an open Keka session…');
  try {
    const grabbed = await grabTokensFromKekaTab();
    if (grabbed && grabbed.token) {
      // Read-only: don't refresh here — that would spend the Keka tab's
      // refresh token and log it out. API.ensureValidToken handles renewal.
      await saveGrabbedTokens(grabbed);
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

  // Independent requests run in parallel. Birthdays wait for the profile,
  // which provides the image base URL for their avatars.
  const user = loadUserData();
  user.then(loadBirthdays); // the card stays hidden until it has data
  loadDayStatus();
  loadInboxCounts();
  await Promise.all([user, loadAttendanceData(), refreshBreakState()]);
}

// === Day status, shift & overview ===

async function openKeka(routeKey) {
  try {
    chrome.tabs.create({ url: await tenantUrl(KEKA_ROUTES[routeKey] || KEKA_ROUTES.dashboard) });
  } catch (e) {
    console.warn('Could not open Keka', e);
  }
}

async function loadDayStatus() {
  try {
    const day = await getDayStatus();
    const s = day.schedule;
    let text = null;
    if (day.off) {
      text = `${day.reason} — go touch grass 🌿`;
    } else {
      const parts = [];
      if (day.reason) parts.push(day.reason);
      if (s?.shiftName) parts.push(s.flexible ? `${s.shiftName} (flexible)` : `${s.shiftName} ${s.start}–${s.end}`);
      if (s?.durationHours) parts.push(`${s.durationHours}h target`);
      text = parts.join(' · ') || null;
    }
    ui.dayStatus.textContent = text || '';
    ui.dayStatus.classList.toggle('hidden', !text);
    ui.dayStatus.classList.toggle('off', !!day.off);
  } catch (e) {
    console.warn('Failed to load day status', e);
  }
}

function renderInboxCounts({ approvals, notifications }) {
  const show = (tile, countEl, stateEl, n, noun) => {
    const known = typeof n === 'number';
    countEl.textContent = known ? String(n) : '–';
    tile.classList.toggle('has-items', known && n > 0);
    stateEl.textContent = !known ? 'Can’t tell 🤷' : n === 0 ? 'Inbox zero ✨' : `${n} ${n === 1 ? noun : noun + 's'} waiting 👀`;
    tile.title = `Open in Keka`;
  };
  show(ui.inboxApprovals, ui.inboxApprovalsCount, ui.inboxApprovalsState, approvals, 'request');
  show(ui.inboxNotifications, ui.inboxNotificationsCount, ui.inboxNotificationsState, notifications, 'unread');
  ui.overviewDot.classList.toggle('hidden', !((approvals || 0) + (notifications || 0)));
}

async function loadInboxCounts() {
  // Show the background's last poll instantly, then refresh live.
  try {
    const { [Storage.KEYS.INBOX_STATE]: cachedCounts } = await Storage.get(Storage.KEYS.INBOX_STATE);
    if (cachedCounts) renderInboxCounts(cachedCounts);
    const counts = await getInboxCounts();
    renderInboxCounts(counts);
    // Keep the background's baseline in step so it doesn't re-alert on items already seen.
    await Storage.set({ [Storage.KEYS.INBOX_STATE]: { ...counts, checkedAt: Date.now() } });
  } catch (e) {
    console.warn('Failed to load inbox counts', e);
  }
}

ui.inboxApprovals.addEventListener('click', () => openKeka('approvals'));
ui.inboxNotifications.addEventListener('click', () => openKeka('notifications'));
document.querySelectorAll('.section-link[data-route]').forEach(btn => {
  btn.addEventListener('click', () => openKeka(btn.dataset.route));
});

function listItem(main, side, extraClass) {
  const li = document.createElement('li');
  if (extraClass) li.className = extraClass;
  const a = document.createElement('span');
  a.className = 'ov-main';
  a.textContent = main;
  li.appendChild(a);
  if (side) {
    const b = document.createElement('span');
    b.className = 'ov-side';
    b.textContent = side;
    li.appendChild(b);
  }
  return li;
}

function fillList(listEl, items, emptyText) {
  listEl.replaceChildren(...(items.length ? items : [listItem(emptyText, null, 'overview-empty')]));
}

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
const fmtDays = (n) => `${fmtNum(n)} ${n === 1 ? 'day' : 'days'}`;

// One leave type: big "days left", a bar of what's left of the yearly quota,
// and a "used" line. Colour by what's left: ok / low / none.
function renderLeaveBalance(b) {
  const li = el('li', 'leave-item');
  const hasQuota = b.quota !== null && b.quota > 0;
  const left = Math.max(0, b.available);
  const ratio = hasQuota ? Math.min(1, left / b.quota) : 0;
  const level = !hasQuota ? 'none-quota'
    : left <= 0 ? 'empty'
    : (ratio <= 0.35 || left <= 3) ? 'low' : 'ok';
  li.classList.add(`level-${level}`);

  const head = el('div', 'leave-head');
  const name = el('div', 'leave-name');
  name.append(el('span', 'leave-title', b.name));
  if (b.code) name.append(el('span', 'leave-code', b.code));
  if (!b.isPaid) name.append(el('span', 'leave-code unpaid', 'Unpaid'));

  const figure = el('div', 'leave-figure');
  if (hasQuota) {
    figure.append(el('span', 'leave-left', fmtNum(left)), el('span', 'leave-of', ` / ${fmtNum(b.quota)}`));
  } else {
    figure.append(el('span', 'leave-left', fmtNum(b.consumed)), el('span', 'leave-of', ' used'));
  }
  head.append(name, figure);
  li.append(head);

  if (hasQuota) {
    const bar = el('div', 'leave-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${b.name}: ${fmtDays(left)} left of ${fmtNum(b.quota)}`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(b.quota));
    bar.setAttribute('aria-valuenow', String(left));
    const fill = el('div', 'leave-bar-fill');
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.append(fill);
    li.append(bar);
    li.append(el('div', 'leave-sub', left <= 0
      ? `All ${fmtDays(b.quota)} used 🫠`
      : `${fmtNum(b.consumed)} of ${fmtNum(b.quota)} used`));
  } else {
    li.append(el('div', 'leave-sub', 'No fixed quota'));
  }
  return li;
}

async function loadOverview() {
  loadInboxCounts();
  loadWeekStrip();

  getLeave().then(({ balances }) => {
    const rows = balances
      .filter(b => b.quota !== null || b.available > 0 || b.consumed > 0)
      .map(renderLeaveBalance);
    fillList(ui.leaveList, rows, 'No leave plan yet 🤷');
  }).catch(() => fillList(ui.leaveList, [], 'Could not load leave balances.'));

  getHolidays().then(holidays => {
    const today = dateKey();
    const rows = holidays.filter(h => h.date >= today).slice(0, 3).map(renderHoliday);
    fillList(ui.holidayList, rows, 'No more holidays this year. This is fine 🔥')
  }).catch(() => fillList(ui.holidayList, [], 'Could not load holidays.'));

  getOnLeaveToday().then(people => {
    ui.onLeaveCount.textContent = people.length ? String(people.length) : '';
    const shown = people.slice(0, 6).map(renderPerson);
    if (people.length > 6) shown.push(listItem(`+${people.length - 6} more`, null, 'people-more'));
    fillList(ui.onLeaveList, shown, 'Everyone’s in today 🎉');
  }).catch(() => fillList(ui.onLeaveList, [], 'Could not load who is on leave.'));
}

const dayDiff = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - start) / 86400000);
};

// Mon–Sun of the current week: working day / holiday / weekly off / leave.
async function loadWeekStrip() {
  try {
    const [schedule, holidays, leave] = await Promise.all([
      getWeekSchedule(),
      getHolidays().catch(() => []),
      getLeave().catch(() => ({ leaveDays: {} }))
    ]);
    const days = Object.keys(schedule).sort();
    if (!days.length) throw new Error('no schedule');
    const today = dateKey();
    let offCount = 0;
    ui.weekStrip.replaceChildren(...days.map(iso => {
      const sched = schedule[iso];
      const holiday = holidays.find(h => h.date === iso);
      const leaveDay = leave.leaveDays?.[iso];
      let kind = 'work';
      let label = sched.shiftName || 'Working day';
      if (sched.weekOffType === 1 || (holiday && !holiday.isFloater)) { kind = 'holiday'; label = holiday ? holiday.name : 'Holiday'; }
      else if (sched.weekOffType === 2) { kind = 'off'; label = 'Weekly off'; }
      else if (leaveDay && leaveDay.duration >= 1) { kind = 'leave'; label = leaveDay.typeName; }
      else if (leaveDay) { kind = 'half'; label = `Half day · ${leaveDay.typeName}`; }
      if (kind !== 'work' && iso >= today) offCount++;

      const [y, m, d] = iso.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const li = el('li', `week-day kind-${kind}` + (iso === today ? ' is-today' : '') + (iso < today ? ' is-past' : ''));
      li.title = `${date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })} — ${label}`;
      li.setAttribute('aria-label', li.title);
      li.append(
        el('span', 'wd-name', date.toLocaleDateString(undefined, { weekday: 'narrow' })),
        el('span', 'wd-date', String(d)),
        el('span', 'wd-dot')
      );
      return li;
    }));
    const upcoming = days.filter(iso => iso >= today);
    const workLeft = upcoming.filter(iso => {
      const sc = schedule[iso];
      const hol = holidays.find(h => h.date === iso && !h.isFloater);
      const lv = leave.leaveDays?.[iso];
      return sc.weekOffType === 0 && !hol && !(lv && lv.duration >= 1);
    }).length;
    ui.weekNote.textContent = workLeft === 0
      ? 'Weekend mode: ON 🏖️'
      : `${workLeft} working day${workLeft === 1 ? '' : 's'} to go${offCount ? ` · ${offCount} day${offCount === 1 ? '' : 's'} off 🎉` : ' 💪'}`;
    ui.weekNote.classList.remove('hidden');
  } catch (e) {
    ui.weekStrip.replaceChildren(emptyNote('Could not load this week’s schedule.'));
    ui.weekNote.classList.add('hidden');
  }
}

function renderHoliday(h) {
  const [y, m, d] = h.date.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = dayDiff(h.date);
  const li = el('li', 'holiday-item' + (days <= 7 ? ' soon' : ''));
  const chip = el('div', 'cal-chip');
  chip.append(
    el('span', 'cal-month', date.toLocaleDateString(undefined, { month: 'short' })),
    el('span', 'cal-day', String(d))
  );
  const info = el('div', 'holiday-info');
  info.append(
    el('span', 'holiday-name', h.name),
    el('span', 'holiday-when', `${date.toLocaleDateString(undefined, { weekday: 'long' })}${h.isFloater ? ' · Floater' : ''}`)
  );
  const countdown = el('span', 'holiday-countdown',
    days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`);
  li.append(chip, info, countdown);
  return li;
}

function renderPerson(p) {
  const li = el('li', 'person-item');
  li.append(el('span', 'person-avatar', initials(p.name)));
  const info = el('div', 'person-info');
  info.append(el('span', 'person-name', p.name));
  if (p.detail) info.append(el('span', 'person-detail', p.detail));
  li.append(info);
  return li;
}

let shiftTimes = null;
async function loadShiftInfo() {
  try {
    const s = (await getWeekSchedule())[dateKey()];
    if (!s) { ui.settingShift.textContent = 'Not available'; return; }
    const hours = s.durationHours ? ` · ${s.durationHours}h` : '';
    ui.settingShift.textContent = s.flexible
      ? `${s.shiftName || 'Shift'} (flexible)${hours}`
      : `${s.shiftName || 'Shift'} ${s.start}–${s.end}${hours}`;
    shiftTimes = s.flexible ? null : { start: s.start, end: s.end };
    ui.btnUseShiftTimes.classList.toggle('hidden', !shiftTimes);
  } catch (e) {
    ui.settingShift.textContent = 'Not available';
  }
}

ui.btnUseShiftTimes.addEventListener('click', async () => {
  if (!shiftTimes) return;
  ui.autoInTime.value = shiftTimes.start;
  ui.autoOutThreshold.value = shiftTimes.end;
  ui.autoInEnabled.checked = true;
  ui.autoOutEnabled.checked = true;
  updateAutomationRowState();
  await saveAutoConfig();
});

// === Birthdays ===

// Set by loadUserData(): https://{domain}{publicStorageAccountUrl}
let orgImageBase = null;

const BIRTHDAY_DAYS_AHEAD = 14;

async function loadBirthdays() {
  try {
    const { hidden, items } = await fetchBirthdays();
    const upcoming = items.filter(b => b.daysAway <= BIRTHDAY_DAYS_AHEAD).slice(0, 6);
    if (hidden || !upcoming.length) {
      ui.birthdayCard.classList.add('hidden');
      return;
    }
    ui.birthdayList.replaceChildren(...upcoming.map(renderBirthday));
    ui.birthdayCard.classList.remove('hidden');
  } catch (e) {
    console.warn('Failed to load birthdays', e);
    ui.birthdayCard.classList.add('hidden');
  }
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function renderBirthday(b) {
  const li = document.createElement('li');
  li.className = 'birthday-item' + (b.daysAway === 0 ? ' today' : '');

  const avatar = document.createElement('span');
  avatar.className = 'birthday-avatar';
  avatar.textContent = initials(b.name);
  if (orgImageBase && b.imagePath) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `${orgImageBase}/50x50/${b.imagePath}`;
    img.addEventListener('load', () => { avatar.textContent = ''; avatar.appendChild(img); });
  }

  const info = document.createElement('div');
  info.className = 'birthday-info';
  const name = document.createElement('span');
  name.className = 'birthday-name';
  name.textContent = b.name;
  info.appendChild(name);
  if (b.jobTitle) {
    const title = document.createElement('small');
    title.textContent = b.jobTitle;
    info.appendChild(title);
  }

  const when = document.createElement('span');
  when.className = 'birthday-when';
  when.textContent = b.daysAway === 0 ? '🎂 Today' : birthdayWhen(b);

  li.append(avatar, info, when, copyWishButton(b));
  return li;
}

// --- Birthday wish (copy to clipboard) ---

async function getWishTemplate() {
  const { [Storage.KEYS.BIRTHDAY_WISH]: t } = await Storage.get(Storage.KEYS.BIRTHDAY_WISH);
  return (typeof t === 'string' && t.trim()) ? t : DEFAULT_BIRTHDAY_WISH;
}

function buildWish(template, fullName) {
  const firstName = (fullName || '').trim().split(/\s+/)[0] || 'there';
  return template
    .replace(/\{firstName\}/gi, firstName)
    .replace(/\{name\}/gi, (fullName || '').trim() || firstName);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of paths) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}
const COPY_ICON = [['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]];
const CHECK_ICON = [['path', { d: 'M20 6 9 17l-5-5' }]];

function copyWishButton(b) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wish-copy';
  btn.title = `Copy a birthday wish for ${b.name}`;
  btn.setAttribute('aria-label', btn.title);
  btn.appendChild(svgIcon(COPY_ICON));
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildWish(await getWishTemplate(), b.name));
      btn.replaceChildren(svgIcon(CHECK_ICON));
      btn.classList.add('copied');
      btn.title = 'Copied!';
      setTimeout(() => {
        btn.replaceChildren(svgIcon(COPY_ICON));
        btn.classList.remove('copied');
        btn.title = `Copy a birthday wish for ${b.name}`;
      }, 1500);
    } catch (e) {
      console.warn('Copy failed', e);
      btn.title = 'Could not copy — try again';
    }
  });
  return btn;
}

let wishSaveTimer = null;
function flashWishStatus(msg) {
  toast(msg, 'success', 1500);
}
ui.birthdayWish.addEventListener('input', () => {
  clearTimeout(wishSaveTimer);
  wishSaveTimer = setTimeout(async () => {
    const value = ui.birthdayWish.value;
    // An empty box means "use the default".
    await Storage.set({ [Storage.KEYS.BIRTHDAY_WISH]: value.trim() ? value : '' });
    flashWishStatus('Saved');
  }, 500);
});
ui.btnWishReset.addEventListener('click', async () => {
  clearTimeout(wishSaveTimer);
  await Storage.set({ [Storage.KEYS.BIRTHDAY_WISH]: '' });
  ui.birthdayWish.value = DEFAULT_BIRTHDAY_WISH;
  flashWishStatus('Reset to default');
});

function setConnected(isConnected) {
  ui.connectionStatus.classList.toggle('connected', isConnected);
  if (!isConnected) setStatus('unknown', 'Napping 😴');
  else if (!ui.connectionStatus.classList.contains('is-in')
           && !ui.connectionStatus.classList.contains('is-out')
           && !ui.connectionStatus.classList.contains('is-break')) {
    setStatus('unknown', 'Connected 🔌');
  }
}

function updateClock() {
  const now = new Date();
  ui.currentTime.textContent = formatClock(now);
  ui.currentDate.textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  if (attendanceState) renderProgress();
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
      await Storage.clear([Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.EXPIRES_AT,
        Storage.KEYS.CLIENT_ID, Storage.KEYS.INBOX_STATE]);
      await clearCaches(); // schedule, holidays, location policy… belong to the old company
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
    const result = await completeLogin(password, captcha);
    setLoginStatus('');
    await handleLoginResult(result);
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

// === Two-factor (OTP) step ===

let resendCooldownTimer = null;

async function handleLoginResult(result) {
  if (!result || result.status === 'done') {
    showDashboard();
    return;
  }
  setLoginStep('otp');
  if (result.status === 'otp_choose') {
    // Only one channel offered → send straight away.
    if (result.providers.length === 1) {
      await chooseOtpProvider(result.providers[0].value);
      return;
    }
    renderOtpProviders(result.providers);
  } else if (result.status === 'otp_verify') {
    showOtpVerify(result.destination);
  }
}

function renderOtpProviders(providers) {
  ui.otpChoose.classList.remove('hidden');
  ui.otpVerify.classList.add('hidden');
  ui.otpProviders.replaceChildren(...providers.map(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = p.label;
    btn.addEventListener('click', () => chooseOtpProvider(p.value));
    return btn;
  }));
}

async function chooseOtpProvider(value) {
  const buttons = [...ui.otpProviders.querySelectorAll('button')];
  buttons.forEach(b => { b.disabled = true; });
  setLoginError('');
  setLoginStatus('Sending code…');
  try {
    const result = await sendOtpCode(value);
    setLoginStatus('');
    showOtpVerify(result.destination);
  } catch (e) {
    setLoginStatus('');
    setLoginError(e.message || 'Could not send the code.');
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

function showOtpVerify(destination, { restartCooldown = true } = {}) {
  ui.otpChoose.classList.add('hidden');
  ui.otpVerify.classList.remove('hidden');
  ui.otpDestination.textContent = destination;
  ui.otpInput.value = '';
  ui.otpInput.focus();
  if (restartCooldown) startResendCooldown();
}

// Keka will happily resend on every click — keep users from spamming it.
function startResendCooldown(seconds = 30) {
  clearInterval(resendCooldownTimer);
  let left = seconds;
  ui.btnOtpResend.disabled = true;
  ui.btnOtpResend.textContent = `Resend code (${left}s)`;
  resendCooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(resendCooldownTimer);
      ui.btnOtpResend.disabled = false;
      ui.btnOtpResend.textContent = 'Resend code';
      return;
    }
    ui.btnOtpResend.textContent = `Resend code (${left}s)`;
  }, 1000);
}

ui.btnOtpVerify.addEventListener('click', async () => {
  const code = ui.otpInput.value.replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) { setLoginError('Enter the code from your email or SMS.'); return; }
  setLoginError('');
  setLoginStatus('Verifying…');
  ui.btnOtpVerify.disabled = true;
  try {
    await verifyOtpCode(code);
    setLoginStatus('');
    clearInterval(resendCooldownTimer);
    showDashboard();
  } catch (e) {
    setLoginStatus('');
    setLoginError(e.message || 'Verification failed.');
    if (e.retry) {
      ui.otpInput.select();
    } else {
      // Session is gone — the user has to start again from the email step.
      clearInterval(resendCooldownTimer);
      cancelLogin();
      setLoginStep('email');
    }
  } finally {
    ui.btnOtpVerify.disabled = false;
  }
});

ui.btnOtpResend.addEventListener('click', async () => {
  ui.btnOtpResend.disabled = true;
  setLoginError('');
  try {
    const result = await resendOtpCode();
    ui.otpDestination.textContent = result.destination;
    setLoginStatus('A new code is on its way.');
    startResendCooldown();
  } catch (e) {
    setLoginError(e.message || 'Could not resend the code.');
    ui.btnOtpResend.disabled = false;
  }
});

ui.btnOtpRestart.addEventListener('click', () => {
  clearInterval(resendCooldownTimer);
  cancelLogin();
  setLoginStep('email');
  setLoginError('');
  setLoginStatus('');
});

ui.otpInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); ui.btnOtpVerify.click(); }
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

  await Storage.set({ [Storage.KEYS.REFRESH_TOKEN]: token, [Storage.KEYS.TOKEN_SOURCE]: 'own' });
  await Storage.clear([Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.EXPIRES_AT]);

  try {
    await API.ensureValidToken();
    showDashboard();
    return;
  } catch (e) {
    console.warn('Refresh token exchange failed', e);
  }
  setLoginError('Invalid refresh token or network error.');
  await Storage.clear([Storage.KEYS.REFRESH_TOKEN, Storage.KEYS.ACCESS_TOKEN, Storage.KEYS.EXPIRES_AT, Storage.KEYS.TOKEN_SOURCE]);
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
      await saveGrabbedTokens(storageResult);
      setLoginStatus('');
      showDashboard();
      return;
    }

    const cookies = await chrome.cookies.getAll({ domain: '.keka.com' });
    const tokenCookie = cookies.find(c => /refresh.?token/i.test(c.name));
    if (tokenCookie) {
      await saveGrabbedTokens({ token: decodeURIComponent(tokenCookie.value) });
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

// === Feedback helpers: toast + two-click confirm (no native dialogs) ===

let toastTimer = null;
function toast(message, kind = 'info', ms = 3500) {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.className = 'toast hidden'; }, ms);
}

// First click arms the button ("Tap again to …"), second click within 3s runs.
function confirmTwice(btn, confirmLabel, action) {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.dataset.label = btn.innerHTML;
      btn.textContent = confirmLabel;
      btn.classList.add('armed');
      btn._disarm = setTimeout(() => disarm(btn), 3000);
      return;
    }
    disarm(btn);
    await action();
  });
}
function disarm(btn) {
  clearTimeout(btn._disarm);
  if (btn.dataset.armed === '1') {
    btn.innerHTML = btn.dataset.label; // static markup we put there ourselves
    btn.dataset.armed = '';
    btn.classList.remove('armed');
  }
}

// Runs fn with the given buttons disabled, so double clicks can't send two
// punches. fn may return a punch type ('IN' | 'OUT'): the buttons are then
// set for that new state instead of restored to how they were before.
async function busy(buttons, fn) {
  const prev = buttons.map(b => b.disabled);
  buttons.forEach(b => { b.disabled = true; });
  let newState;
  try { newState = await fn(); return newState; }
  finally {
    buttons.forEach((b, i) => { b.disabled = prev[i]; });
    if (newState === 'IN' || newState === 'OUT') updateButtonState(newState);
  }
}

const punchButtons = () => [ui.btnClockIn, ui.btnClockOut, ui.btnReturnNow, ...ui.breakPresets];

// Meme-flavoured copy — ShiftMate is meant to be fun.
const STATUS_TEXT = {
  in: 'On the clock 💼',
  out: 'Off duty 😎',
  unknown: 'Hmm… 🤔'
};
const PUNCH_IN_TOASTS = [
  'Ah, here we go again 🫠',
  'Let them cook 🧑‍🍳 Punched IN.',
  'One does not simply skip punching in 🧙',
  'It’s showtime 🎬 Punched IN.'
];
const PUNCH_OUT_TOASTS = [
  'It ain’t much, but it’s honest work 🧑‍🌾',
  'I’ll be back 🤖 (tomorrow). Punched OUT.',
  'Mission accomplished 😎 Punched OUT.',
  'Peace out ✌️ Laptop lid down, please.'
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function setStatus(state, text) {
  // state: 'in' | 'out' | 'break' | 'unknown'
  ui.connectionStatus.classList.remove('is-in', 'is-out', 'is-break');
  if (state === 'in') ui.connectionStatus.classList.add('is-in');
  if (state === 'out') ui.connectionStatus.classList.add('is-out');
  if (state === 'break') ui.connectionStatus.classList.add('is-break');
  ui.statusText.textContent = text;
  ui.statePill.className = `state-pill state-${state}`;
  ui.statePill.textContent = text;
}

function nudgeBackground() {
  setTimeout(loadAttendanceData, 800);
  setTimeout(() => chrome.runtime.sendMessage({ type: 'badge_refresh' }).catch(() => {}), 900);
}

confirmTwice(ui.btnClockIn, 'Sure? Tap again 🐸🥊', () => performPunch('IN'));
confirmTwice(ui.btnClockOut, 'Sure? Tap again 🐸👋', () => performPunch('OUT'));

// Break feature
ui.breakPresets.forEach(btn => {
  const mins = parseInt(btn.dataset.min, 10);
  if (mins === 0) {
    // "Custom" opens the inline minutes field.
    btn.addEventListener('click', () => {
      ui.breakCustom.classList.toggle('hidden');
      if (!ui.breakCustom.classList.contains('hidden')) ui.breakCustomInput.focus();
    });
  } else {
    confirmTwice(btn, 'Tap again ✔', () => startBreak(mins));
  }
});
// Same two-tap confirm as the presets; the length is checked on the first tap.
ui.btnBreakCustomStart.addEventListener('click', (ev) => {
  if (ui.btnBreakCustomStart.dataset.armed === '1') return;
  const mins = parseInt(ui.breakCustomInput.value, 10);
  if (isNaN(mins) || mins < 1 || mins > 480) {
    ev.stopImmediatePropagation(); // don't arm
    toast('Enter a break length between 1 and 480 minutes.', 'error');
    ui.breakCustomInput.focus();
  }
});
confirmTwice(ui.btnBreakCustomStart, 'Tap again ✔', () => {
  const mins = parseInt(ui.breakCustomInput.value, 10);
  if (isNaN(mins) || mins < 1 || mins > 480) return toast('Enter a break length between 1 and 480 minutes.', 'error');
  ui.breakCustom.classList.add('hidden');
  return startBreak(mins);
});
ui.breakCustomInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); ui.btnBreakCustomStart.click(); }
});

confirmTwice(ui.btnReturnNow, 'Sure? Tap again 🫡', returnFromBreak);

// The background can end a break (alarm) while the popup is open — follow it.
// Changes this popup makes itself already refresh via nudgeBackground().
let ownBreakWriteUntil = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[Storage.KEYS.ACTIVE_BREAK]) {
    refreshBreakState();
    if (Date.now() > ownBreakWriteUntil) loadAttendanceData();
  }
});

async function refreshBreakState() {
  const { [Storage.KEYS.ACTIVE_BREAK]: active } = await Storage.get(Storage.KEYS.ACTIVE_BREAK);
  if (active && active.returnAt) {
    showActiveBreakUI(active);
  } else {
    showIdleBreakUI();
  }
}

function setCountdown(main, label) {
  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = label;
  ui.breakCountdown.replaceChildren(document.createTextNode(main), lbl);
}

function showActiveBreakUI(active) {
  ui.breakIdle.classList.add('hidden');
  ui.breakActive.classList.remove('hidden');
  ui.breakReturnTime.textContent = formatClock(active.returnAt);
  if (breakCountdownInterval) clearInterval(breakCountdownInterval);
  const tick = () => {
    const remaining = active.returnAt - Date.now();
    if (remaining <= 0) {
      // The background punches in and clears the break; storage.onChanged
      // above then switches this card back to idle.
      setCountdown('I’ll be back 🤖', 'Auto punch IN');
      setStatus('break', 'Back in a sec 🏃');
      clearInterval(breakCountdownInterval);
      return;
    }
    const totalSec = Math.floor(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    setCountdown(`${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`, 'of freedom left');
    setStatus('break', `On break 🍩 · ${m}m`);
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
  await busy(punchButtons(), async () => {
    try {
      const res = await API.clockInOrOut('OUT');
      if (!res.ok) {
        toast(`Couldn't punch out (Keka returned ${res.status}), so the break didn't start. Try again.`, 'error', 6000);
        return;
      }
      const returnAt = Date.now() + mins * 60 * 1000;
      ownBreakWriteUntil = Date.now() + 2000;
      await Storage.set({
        [Storage.KEYS.ACTIVE_BREAK]: { startedAt: Date.now(), returnAt, durationMin: mins }
      });
      chrome.alarms.create('break_end', { when: returnAt });
      showActiveBreakUI({ returnAt });
      toast(`Break time! ☕ We’ll punch you back in at ${formatClock(returnAt)}.`, 'success');
      nudgeBackground();
      return 'OUT';
    } catch (e) {
      toast(`Couldn't start the break: ${e.message}`, 'error', 6000);
    }
  });
}

async function returnFromBreak() {
  await busy(punchButtons(), async () => {
    try {
      // Punch first; only clear the break once we're actually back in, so a
      // failed punch keeps the automatic return in place.
      const res = await API.clockInOrOut('IN');
      if (!res.ok) {
        toast(`Couldn't punch in (Keka returned ${res.status}). Your break is still running — try again.`, 'error', 6000);
        return;
      }
      chrome.alarms.clear('break_end');
      ownBreakWriteUntil = Date.now() + 2000;
      await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
      setStatus('in', STATUS_TEXT.in);
      showIdleBreakUI();
      toast('Welcome back, legend 🦸 Punched IN.', 'success');
      nudgeBackground();
      return 'IN';
    } catch (e) {
      toast(`Couldn't punch in: ${e.message}`, 'error', 6000);
    }
  });
}

async function performPunch(type) {
  await busy(punchButtons(), async () => {
    try {
      const response = await API.clockInOrOut(type);
      if (!response.ok) {
        toast(`Punch ${type} failed (Keka returned ${response.status}). Check you're still signed in and try again.`, 'error', 6000);
        return;
      }
      if (type === 'IN') {
        // Punching in by hand ends any running break.
        chrome.alarms.clear('break_end');
        ownBreakWriteUntil = Date.now() + 2000;
        await Storage.clear([Storage.KEYS.ACTIVE_BREAK]);
        showIdleBreakUI();
      }
      setStatus(type === 'IN' ? 'in' : 'out', type === 'IN' ? STATUS_TEXT.in : STATUS_TEXT.out);
      toast(response.locationMissing
        ? `Punched ${type} — but without your location (Chrome couldn’t get it 🛰️). Allow location for Chrome in system settings.`
        : (type === 'IN' ? pick(PUNCH_IN_TOASTS) : pick(PUNCH_OUT_TOASTS)),
        response.locationMissing ? 'warn' : 'success',
        response.locationMissing ? 7000 : 3000);
      nudgeBackground();
      return type;
    } catch (e) {
      toast(`Punch ${type} failed: ${e.message}`, 'error', 6000);
    }
  });
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
            ui.avatarInitials.textContent = initials(name);
            
            // Department / Title
            let subtitle = 'Keka User';
            if (data.employee?.jobDetails?.departmentId && data.departments) {
                 const dept = data.departments.find(d => d.id === data.employee.jobDetails.departmentId);
                 if (dept) subtitle = dept.name;
            }
            ui.userTitle.textContent = subtitle;

            // Avatar: https://{domain}{publicStorage}/50x50/{profileImage}
            const domain = data.org?.subDomainName;
            const storageUrl = data.org?.publicStorageAccountUrl;
            const profileImage = data.employee?.profileImageUrl;
            if (domain && storageUrl) orgImageBase = `https://${domain}${storageUrl}`;
            if (orgImageBase && profileImage) {
                // Shown only once it loads; initials stay otherwise.
                ui.userAvatar.onload = () => {
                    ui.userAvatar.classList.remove('hidden');
                    ui.avatarInitials.classList.add('hidden');
                };
                ui.userAvatar.src = `${orgImageBase}/50x50/${profileImage}`;
            }
        }
    } catch (e) {
        console.error('Failed to load user data', e);
    }
}

// Last fetched attendance, so the clock tick can advance "worked" live.
let attendanceState = null; // { durationMs, fetchedAt, isClockedIn, target }

async function loadAttendanceData() {
  try {
    const [{ entries, durationMs, isClockedIn }, target] = await Promise.all([
      fetchTodayAttendance(),
      getTargetHours().catch(() => null)
    ]);
    ui.attendanceError.classList.add('hidden');
    attendanceState = { durationMs, fetchedAt: Date.now(), isClockedIn, target: target || 8 };
    if (entries.length > 0) {
      ui.statIn.textContent = formatClock(entries[0].timestamp);
      ui.statOut.textContent = isClockedIn ? 'On duty' : formatClock(entries[entries.length - 1].timestamp);
      renderSessions(entries);
    } else {
      ui.statIn.textContent = '--:--';
      ui.statOut.textContent = '--:--';
      ui.historyList.replaceChildren(emptyNote('No punches yet. The day is young 🌅'));
    }
    renderProgress();
    // Don't override the "On Break" status while a break is running.
    if (!breakCountdownInterval) setStatus(isClockedIn ? 'in' : 'out', isClockedIn ? STATUS_TEXT.in : STATUS_TEXT.out);
    updateButtonState(isClockedIn ? 'IN' : 'OUT');
  } catch (e) {
    console.error('Failed to load attendance', e);
    // Unknown state: block punching rather than guess (e.g. punching OUT
    // while not clocked in).
    attendanceState = null;
    ui.attendanceError.classList.remove('hidden');
    setStatus('unknown', STATUS_TEXT.unknown);
    updateButtonState(null);
  }
}

// Worked time vs today's target (shift length from Keka, else 8h), advancing
// live while clocked in; "Done by" is when the target will be reached.
function renderProgress() {
  const st = attendanceState;
  if (!st) return;
  const worked = st.durationMs + (st.isClockedIn ? Date.now() - st.fetchedAt : 0);
  const targetMs = st.target * 3600000;
  const ratio = Math.min(1, worked / targetMs);
  ui.statDuration.textContent = formatDuration(worked);
  ui.targetLabel.textContent = `of ${st.target}h`;
  ui.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  ui.progressFill.classList.toggle('done', worked >= targetMs);
  ui.progressBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (worked >= targetMs) {
    ui.progressLeft.textContent = worked - targetMs >= 60000
      ? `Stonks 📈 +${formatDuration(worked - targetMs)} overtime`
      : 'Target smashed 🎯 Go home!';
    ui.progressEta.textContent = '';
  } else {
    const left = targetMs - worked;
    ui.progressLeft.textContent = `${formatDuration(left)} till freedom`;
    ui.progressEta.textContent = st.isClockedIn ? `🏁 ${formatClock(new Date(Date.now() + left))}` : '';
  }
}

// lastStatus: 'IN' | 'OUT' | null (unknown — everything disabled)
function updateButtonState(lastStatus) {
  const clockedIn = lastStatus === 'IN';
  ui.btnClockIn.disabled = lastStatus !== 'OUT';
  ui.btnClockOut.disabled = lastStatus !== 'IN';
  // Break presets only make sense while clocked in
  ui.breakPresets.forEach(btn => { btn.disabled = !clockedIn; });
  ui.breakHint.textContent = clockedIn
    ? 'We punch you OUT now and back IN when time’s up. Pinky promise 🤙'
    : lastStatus === 'OUT' ? 'Punch in first — can’t take a break from nothing 😅' : 'Checking if you’re working… 🕵️';
  if (!clockedIn) ui.breakCustom.classList.add('hidden');
}

function emptyNote(text, isError = false) {
  const div = document.createElement('div');
  div.className = 'empty-note' + (isError ? ' error' : '');
  div.textContent = text;
  return div;
}

// Pair punches into work sessions (IN→OUT), with the gaps between them as
// breaks; an open IN is "now". Chronological, like a timeline.
function renderSessions(entries) {
  const sessions = [];
  let open = null;
  for (const e of entries) {
    if (e.punchStatus === 0) open = new Date(e.timestamp);
    else if (e.punchStatus === 1 && open) { sessions.push({ start: open, end: new Date(e.timestamp) }); open = null; }
  }
  if (open) sessions.push({ start: open, end: null });

  const rows = [];
  sessions.forEach((sess, i) => {
    if (i > 0 && sessions[i - 1].end) {
      const gap = sess.start - sessions[i - 1].end;
      if (gap >= 60000) {
        const br = el('div', 'session-break');
        br.append(el('span', 'session-break-label', `Break · ${formatDuration(gap)}`));
        rows.push(br);
      }
    }
    const row = el('div', 'session-item' + (sess.end ? '' : ' live'));
    const range = el('span', 'session-range',
      `${formatClock(sess.start)} – ${sess.end ? formatClock(sess.end) : 'now'}`);
    const dur = el('span', 'session-dur', formatDuration((sess.end || new Date()) - sess.start));
    row.append(el('span', 'session-dot'), range, dur);
    rows.push(row);
  });
  ui.historyList.replaceChildren(...(rows.length ? rows : [emptyNote('No punches yet. The day is young 🌅')]));
}

const HISTORY_DAYS = 3; // most recent previous days shown in the History tab

async function loadHistoryData() {
  ui.dayList.replaceChildren(emptyNote('Loading…'));
  try {
    const response = await API.request(await tenantUrl('/k/attendance/api/mytime/attendance/summary'));
    if (!response.ok) {
      ui.dayList.replaceChildren(emptyNote('Failed to load history', true));
      return;
    }
    const payload = unwrap(await response.json());
    const days = Array.isArray(payload) ? payload : [];

    const today = dateKey(); // local date, not UTC
    // Exclude today and sort descending (most recent first)
    const past = days
      .filter(d => (d.attendanceDate || '').slice(0, 10) < today)
      .sort((a, b) => new Date(b.attendanceDate) - new Date(a.attendanceDate))
      .slice(0, HISTORY_DAYS);

    const target = (await getTargetHours().catch(() => null)) || 8;
    ui.dayList.replaceChildren(...(past.length ? past.map(d => renderDayItem(d, target)) : [emptyNote('Nothing here yet 👻')]));
    renderHistorySummary(past, target);
    historyLoaded = true;
  } catch (e) {
    console.error('Failed to load history', e);
    ui.dayList.replaceChildren(emptyNote(`Error: ${e.message}`, true));
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// "8h 30m" / "08:30" → minutes (Keka sends effectiveHoursInHHMM as text).
function hoursTextToMinutes(text) {
  const str = String(text || '');
  let m = /(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(str);
  if (m) return (+m[1]) * 60 + (+(m[2] || 0));
  m = /^(\d{1,2}):(\d{2})/.exec(str);
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}

function dayBadge(day) {
  if (day.dayType === 2) return { label: 'Weekend', cls: 'weekend' };
  if (day.leaveDetails && day.leaveDetails.length > 0) return { label: day.leaveDetails[0].leaveTypeName || 'Leave', cls: 'leave' };
  if (day.attendanceDayStatus === 1 || (day.timeEntries && day.timeEntries.length > 0) || day.firstLogOfTheDay) return { label: 'Present', cls: 'present' };
  return { label: 'Absent', cls: 'absent' };
}

function renderDayItem(day, targetHours = 8) {
  const date = new Date(day.attendanceDate);
  const badge = dayBadge(day);
  const minutes = hoursTextToMinutes(day.effectiveHoursInHHMM);
  const targetMin = targetHours * 60;
  const showTimes = day.firstLogOfTheDay || day.lastLogOfTheDay;

  const item = el('div', `day-item day-${badge.cls}`);
  const header = el('div', 'day-header');
  const when = el('div', 'day-when');
  when.append(
    el('span', 'date', date.toLocaleDateString(undefined, { weekday: 'long' })),
    el('span', 'day-sub', date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))
  );
  header.append(when, el('span', `badge ${badge.cls}`, badge.label));
  item.append(header);

  if (badge.cls === 'present' || minutes > 0) {
    const bar = el('div', 'day-bar');
    const fill = el('div', 'day-bar-fill' + (minutes >= targetMin ? ' done' : ''));
    fill.style.width = `${Math.min(100, Math.round((minutes / targetMin) * 100))}%`;
    bar.append(fill);
    const meta = el('div', 'meta');
    meta.append(
      el('span', null, showTimes ? `${formatClock(day.firstLogOfTheDay)} → ${formatClock(day.lastLogOfTheDay)}` : (day.arrivalMessage || '—')),
      el('span', 'hours', `${formatDuration(minutes * 60000)}${minutes >= targetMin ? ' ✓' : ''}`)
    );
    item.append(bar, meta);
  } else if (day.arrivalMessage && badge.cls === 'absent') {
    item.append(el('div', 'meta', day.arrivalMessage));
  }
  return item;
}

// Total and average over the days shown that you actually worked.
function renderHistorySummary(days, targetHours) {
  const worked = days.map(d => hoursTextToMinutes(d.effectiveHoursInHHMM)).filter(m => m > 0);
  if (!worked.length) { ui.historySummary.classList.add('hidden'); return; }
  const total = worked.reduce((a, b) => a + b, 0);
  const avg = Math.round(total / worked.length);
  const stat = (label, value) => {
    const box = el('div', 'hs-stat');
    box.append(el('span', 'hs-value', value), el('span', 'hs-label', label));
    return box;
  };
  ui.historySummary.replaceChildren(
    stat('Total', formatDuration(total * 60000)),
    stat('Avg / day', formatDuration(avg * 60000)),
    stat('Target', `${targetHours}h`)
  );
  ui.historySummary.classList.remove('hidden');
}

init();
