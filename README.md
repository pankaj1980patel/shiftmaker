# ShiftMate

A browser-toolbar companion for the [Keka](https://www.keka.com/) HR platform: one-click punch in/out, timed breaks with automatic clock-back-in, daily history, and a live progress badge that turns red → green as you approach an 8-hour workday.

Built as a Manifest V3 Chrome extension. Not affiliated with Keka HR Technologies Pvt Ltd.

## Features

- **One-click punch in / out** from the browser toolbar — no need to open Keka in a tab.
- **Smart timed breaks** (30 / 45 / 60 min or custom). Punches you out, runs a countdown, and auto-clocks you back in. Desktop notification confirms the result.
- **Live progress badge** on the toolbar icon: gradient from red at 0h to green at 8h, updated every minute.
- **Today + History tabs** show in/out times, total hours, weekend/leave badges.
- **Frictionless sign-in**:
  - Auto-detects an existing Keka session in an open tab.
  - In-popup email + password + captcha form when no session exists.
  - Power-user fallback: paste a refresh token directly.

## Installation (development)

1. Clone this repo.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and pick this folder.

## Project layout

```
manifest.json          # MV3 manifest
src/
  background.js        # Service worker: alarms, badge, auto break-end clock-in
  popup.html / popup.js / popup.css  # Popup UI
  utils/
    api.js             # Authenticated fetch + token refresh + AUTH_REQUIRED hook
    auth-login.js      # OIDC PKCE login flow (email + password + captcha)
    grab-tokens.js     # Scrape OIDC tokens from an open Keka tab
    storage.js         # chrome.storage.sync wrapper
docs/
  index.html           # Privacy policy (served via GitHub Pages)
```

## Privacy

All data stays in your own Chrome profile. The extension talks only to Keka's own servers (`*.keka.com`). See the [privacy policy](https://pankaj1980patel.github.io/shiftmaker/).

## License

MIT
