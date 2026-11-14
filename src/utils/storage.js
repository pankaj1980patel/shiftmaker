/**
 * Storage wrapper.
 *
 * - chrome.storage.local  — this device only: auth tokens (so a working
 *   refresh token isn't copied to every Chrome profile on the Google account),
 *   the active break (its alarm only exists on this machine), the "already
 *   done today" automation markers, and polled inbox counts.
 * - chrome.storage.sync   — follows the user: settings, tenant, wish template.
 * - chrome.storage.session — in-memory for the browser session, survives the
 *   service worker being shut down: short-lived API caches and the
 *   in-progress sign-in (see auth-login.js).
 */

const KEYS = {
  REFRESH_TOKEN: 'refresh_token',
  ACCESS_TOKEN: 'access_token',
  EXPIRES_AT: 'expires_at',
  TOKEN_SOURCE: 'token_source', // 'own' (our sign-in) | 'grabbed' (copied from a Keka tab)
  CLIENT_ID: 'client_id',
  USER_PROFILE: 'user_profile',
  AUTO_CONFIG: 'auto_config',
  AUTO_MARKERS: 'auto_markers',
  ACTIVE_BREAK: 'active_break',
  TENANT_SUBDOMAIN: 'tenant_subdomain', // e.g. "acme.keka.com"
  INBOX_STATE: 'inbox_state', // last seen approval / notification counts
  BIRTHDAY_WISH: 'birthday_wish' // user's birthday wish template
};

const LOCAL_KEYS = new Set([
  KEYS.REFRESH_TOKEN, KEYS.ACCESS_TOKEN, KEYS.EXPIRES_AT, KEYS.TOKEN_SOURCE,
  KEYS.INBOX_STATE, KEYS.ACTIVE_BREAK, KEYS.AUTO_MARKERS
]);

export const DEFAULT_BIRTHDAY_WISH =
  'Happy Birthday, {firstName}! 🎂🎉 Wishing you a fantastic year ahead full of joy, success and lots of cake! 🥳🎁';

export const DEFAULT_AUTO_CONFIG = {
  outEnabled: false,
  outThresholdMin: 1110, // 18:30 local time (minutes since midnight)
  inEnabled: false,
  inTime: '09:30', // 24h HH:MM in user's local time
  birthdayNotify: true, // morning notification on colleagues' birthdays
  approvalNotify: true, // notify when new requests are waiting for your approval
  skipDaysOff: true, // auto clock-in skips holidays, weekly offs and full-day leave
  breakEnabled: false, // auto break: once a day inside [breakFrom, breakTo]
  breakFrom: '13:00',
  breakTo: '14:00',
  breakMinutes: 30
};

const area = (name) => ({
  get: (keys) => new Promise(resolve => chrome.storage[name].get(keys, resolve)),
  set: (items) => new Promise(resolve => chrome.storage[name].set(items, resolve)),
  remove: (keys) => new Promise(resolve => chrome.storage[name].remove(keys, resolve)),
  clear: () => new Promise(resolve => chrome.storage[name].clear(resolve))
});
const local = area('local');
const sync = area('sync');
const session = chrome.storage.session ? area('session') : null;

// One-time move of device-only keys saved by older versions from sync → local.
// Memoised per context (popup / service worker).
let migration = null;
function migrateLocalKeys() {
  if (!migration) {
    migration = (async () => {
      const keys = [...LOCAL_KEYS];
      const old = await sync.get(keys);
      const found = Object.keys(old);
      if (!found.length) return;
      const current = await local.get(keys);
      const toCopy = {};
      for (const k of found) if (!(k in current)) toCopy[k] = old[k];
      if (Object.keys(toCopy).length) await local.set(toCopy);
      await sync.remove(found);
    })().catch(e => console.warn('[ShiftMate] storage migration failed', e));
  }
  return migration;
}

function split(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return {
    localKeys: list.filter(k => LOCAL_KEYS.has(k)),
    syncKeys: list.filter(k => !LOCAL_KEYS.has(k))
  };
}

export const Storage = {
  get: async (keys) => {
    await migrateLocalKeys();
    const { localKeys, syncKeys } = split(keys);
    const [a, b] = await Promise.all([
      localKeys.length ? local.get(localKeys) : {},
      syncKeys.length ? sync.get(syncKeys) : {}
    ]);
    return { ...b, ...a };
  },

  set: async (items) => {
    await migrateLocalKeys();
    const localItems = {};
    const syncItems = {};
    for (const [k, v] of Object.entries(items)) {
      (LOCAL_KEYS.has(k) ? localItems : syncItems)[k] = v;
    }
    await Promise.all([
      Object.keys(localItems).length ? local.set(localItems) : null,
      Object.keys(syncItems).length ? sync.set(syncItems) : null
    ]);
  },

  clear: async (keys) => {
    const { localKeys, syncKeys } = split(keys);
    await Promise.all([
      localKeys.length ? local.remove(localKeys) : null,
      syncKeys.length ? sync.remove(syncKeys) : null
    ]);
  },

  /**
   * Sign this browser out: wipe device-only data (tokens, break, markers,
   * caches, pending sign-in). Synced settings are kept, so a reset on one
   * machine doesn't erase them on the others.
   */
  resetThisDevice: async () => {
    await Promise.all([local.clear(), session ? session.clear() : null]);
  },

  KEYS
};

/**
 * Small TTL cache in chrome.storage.session (falls back to memory). Survives
 * the service worker being shut down between one-minute ticks.
 */
const memoryCache = new Map();
const inFlight = new Map(); // concurrent callers on a cold cache share one load
export async function cached(key, ttlMs, loader) {
  const k = `cache:${key}`;
  const now = Date.now();
  let hit = memoryCache.get(k);
  if (!hit && session) hit = (await session.get(k))[k];
  if (hit && now - hit.at < ttlMs) return hit.value;
  if (inFlight.has(k)) return inFlight.get(k);
  const p = (async () => {
    const value = await loader();
    const entry = { at: Date.now(), value };
    memoryCache.set(k, entry);
    if (session) await session.set({ [k]: entry }).catch(() => {});
    return value;
  })().finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

/** Drop every cached API answer (e.g. after switching Keka workspace). */
export async function clearCaches() {
  memoryCache.clear();
  inFlight.clear();
  if (!session) return;
  const all = await new Promise(resolve => chrome.storage.session.get(null, resolve));
  const keys = Object.keys(all).filter(k => k.startsWith('cache:'));
  if (keys.length) await session.remove(keys);
}

/** Session-scoped key/value (cleared when the browser closes). */
export const SessionStore = {
  get: async (key) => (session ? (await session.get(key))[key] : undefined),
  set: async (key, value) => { if (session) await session.set({ [key]: value }); },
  remove: async (key) => { if (session) await session.remove(key); }
};
