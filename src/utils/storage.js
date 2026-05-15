/**
 * specific wrapper for chrome.storage.sync
 */

const KEYS = {
  REFRESH_TOKEN: 'refresh_token',
  ACCESS_TOKEN: 'access_token',
  EXPIRES_AT: 'expires_at',
  CLIENT_ID: 'client_id',
  USER_PROFILE: 'user_profile',
  AUTO_CONFIG: 'auto_config',
  AUTO_MARKERS: 'auto_markers',
  ACTIVE_BREAK: 'active_break'
};

export const DEFAULT_AUTO_CONFIG = {
  outEnabled: false,
  outThresholdMin: 570, // 9h 30m
  inEnabled: false,
  inTime: '09:30' // 24h HH:MM in user's local time
};

export const Storage = {
  get: (keys) => {
    return new Promise((resolve) => {
      chrome.storage.sync.get(keys, (result) => {
        resolve(result);
      });
    });
  },

  set: (items) => {
    return new Promise((resolve) => {
      chrome.storage.sync.set(items, () => {
        resolve();
      });
    });
  },

  clear: (keys) => {
    return new Promise((resolve) => {
      chrome.storage.sync.remove(keys, () => {
        resolve();
      });
    });
  },
  
  KEYS
};
