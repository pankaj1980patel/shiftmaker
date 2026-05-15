# ShiftMate — Keka Attendance for Chrome

A browser-toolbar companion for the [Keka](https://www.keka.com/) HR platform. Track work hours, clock in and out, take timed breaks, and let the extension handle the daily routine of punching in and out — from any `*.keka.com` workspace, without ever opening the Keka tab.

Built as a Manifest V3 Chrome extension. Not affiliated with Keka HR Technologies Pvt Ltd.

> **Keywords**: Keka, attendance, timesheet, time tracking, clock in / clock out, punch in / punch out, auto clock-in, auto clock-out, work hours, 8-hour workday, Chrome extension.

## Features

- **One-click punch in / out** from the browser toolbar — no need to open Keka in a tab.
- **Smart timed breaks** (30 / 45 / 60 min or custom). Punches you out, runs a countdown, and auto-clocks you back in. Desktop notification confirms the result.
- **Scheduled auto clock-in** — set a daily time; if you have zero punches that day, ShiftMate punches you in for you.
- **Scheduled auto clock-out** — set a daily time-of-day; ShiftMate punches you out if you're still clocked in past it. If you re-punch in by hand, you get a desktop notification asking whether to punch out again or handle it yourself (throttled to once per day).
- **Multi-tenant** — works for any `*.keka.com` workspace. Auto-detected from an open Keka tab or the session cookie; falls back to a workspace prompt on the sign-in form.
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
  background.js        # Service worker: alarms, badge, scheduled auto in/out
  popup.html / popup.js / popup.css  # Popup UI
  utils/
    api.js             # Authenticated fetch + token refresh + AUTH_REQUIRED hook
    auth-login.js      # OIDC PKCE login flow (email + password + captcha)
    grab-tokens.js     # Scrape OIDC tokens from an open Keka tab
    storage.js         # chrome.storage.sync wrapper
    tenant.js          # Per-tenant subdomain resolution and discovery
docs/
  index.html           # Privacy policy (served via GitHub Pages)
```

## Privacy

All data stays in your own Chrome profile. The extension talks only to Keka's own servers (`*.keka.com`). See the [privacy policy](https://pankaj1980patel.github.io/shiftmaker/).

## License

MIT
