import { Storage } from './storage.js';

// app.keka.com is the central identity service shared by every tenant; never
// treat it as the tenant subdomain.
const IDENTITY_HOST = 'app.keka.com';

/**
 * Accept either a bare subdomain ("acme") or a full host ("acme.keka.com")
 * or a URL ("https://acme.keka.com/foo") and return "acme.keka.com".
 * Returns null if the input doesn't look like a *.keka.com host.
 */
export function normalizeTenant(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  // Strip protocol + path if a URL was passed.
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).host;
  } catch (_) { /* fall through */ }
  s = s.replace(/\/.*$/, '');

  // Bare subdomain → append .keka.com
  if (!s.includes('.')) s = `${s}.keka.com`;

  if (!/^[a-z0-9-]+\.keka\.com$/i.test(s)) return null;
  if (s === IDENTITY_HOST) return null; // not a tenant
  return s;
}

export async function getTenantSubdomain() {
  const { [Storage.KEYS.TENANT_SUBDOMAIN]: v } = await Storage.get(Storage.KEYS.TENANT_SUBDOMAIN);
  return v || null;
}

export async function setTenantSubdomain(value) {
  const normalized = normalizeTenant(value);
  if (!normalized) throw new Error('Invalid tenant subdomain — expected something like "acme.keka.com"');
  await Storage.set({ [Storage.KEYS.TENANT_SUBDOMAIN]: normalized });
  return normalized;
}

export async function getTenantOrigin() {
  const host = await getTenantSubdomain();
  if (!host) throw new Error('Tenant not configured. Open Keka in a browser tab or enter your Keka workspace.');
  return `https://${host}`;
}

/**
 * Build a tenant-scoped URL. Pass a path beginning with "/".
 */
export async function tenantUrl(path) {
  const origin = await getTenantOrigin();
  return origin + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Look at currently open tabs and return the first *.keka.com host that
 * isn't the central identity host. Useful for silent discovery.
 */
export async function discoverTenantFromTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.keka.com/*' });
    for (const t of tabs) {
      try {
        const host = new URL(t.url).host;
        if (host && host !== IDENTITY_HOST && /\.keka\.com$/i.test(host)) return host.toLowerCase();
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/**
 * Read the "Subdomain" cookie that Keka sets on .keka.com after login.
 * Returns null if missing or not a *.keka.com host.
 */
export async function discoverTenantFromCookie() {
  if (!chrome?.cookies?.get) return null;
  try {
    const c = await chrome.cookies.get({ url: 'https://app.keka.com/', name: 'Subdomain' });
    return c && c.value ? normalizeTenant(c.value) : null;
  } catch (_) {
    return null;
  }
}
