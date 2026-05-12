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
  ACTIVE_BREAK: 'active_break'
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
