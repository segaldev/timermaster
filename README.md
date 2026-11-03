# Multi Timer

Run many countdown timers at once. Personal use, no accounts, no dependencies.

## Run

```bash
npm start      # http://localhost:5173
npm test       # unit tests for the timer model
npm run build:site       # _site/ for GitHub Pages or any static host
npm run build:artifact   # dist/ for the Claude-hosted page
```

(ES modules don't load from `file://`, so use the dev server. Any static host works for deployment.)

## Features

- Any number of timers running at once, with a live countdown to the second.
- **Everything is edited on the card**, with no dialogs: type the name in the title. A compact row of chips holds the rest:
  - **Length** `h m s`: type, or nudge with ↑/↓ or the scroll wheel (Shift = 5 min / 10 s). It's saved when you leave the chip. Range is 1s to 99h 59m 59s. Changing the length of a running timer restarts it.
  - **Sound**: Chime, Church bell, Singing bowl, Marimba, Wind chimes, Kitchen timer, Alarm clock or Digital alarm. Picking one plays it.
  - **Repeat** (switch): start the next cycle automatically.
  - **Nudge** (switch): On rings until you dismiss. Off rings 3 times, then restarts (Repeat on, keeping the original schedule) or waits for you (Repeat off).
- **Mute** (speaker icon next to the name, like a browser tab): click to silence that timer, click again to restore. A muted timer still flashes and notifies.
- **Reorder**: drag the dotted grip in a card's top-left corner (grid or list), or focus it and use the arrow keys. The order is saved.
- **Snooze** (running timers): the current run finishes silently and starts over. The next finish alerts normally. Press again to cancel.
- **Cycle counter**: how many times the timer has reached zero (snoozed runs included), with its own reset button. Resetting the timer doesn't clear it.
- **Dismiss** a finished timer: Repeat on starts the next cycle now; Repeat off goes back to Ready.
- Header: **Grid | List**, **Zen** switch (on by default: only name, mute icon, time and progress; click a finished timer to dismiss it; adding a timer leaves Zen so you can set it up), **Hide/Show settings**, **+ New timer** (or **N**). All of these are remembered.
- **Hints**: point at (or focus) any control to see a one-line explanation of what it does, under the card or in the header's summary line.
- One dark look, on purpose.
- Saved in `localStorage`. Timers keep counting while the page is closed and catch up when you return.
- Optional browser notifications when the tab is in the background. The tab title shows the next timer to finish.

## Publishing

The site is deployed to GitHub Pages by GitHub Actions on every push to `main`
(tests must pass first). One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

Live at https://segaldev.github.io/timermaster/

## Structure

| File | Role |
| --- | --- |
| `js/timer.js` | Pure timer model: create/start/pause/reset/update/complete. Uses absolute `endsAt` timestamps, so it's accurate under tab throttling. No DOM. |
| `js/store.js` | Persistence (`load`/`save`), versioned. Swap for an API-backed store when accounts arrive. |
| `js/sounds.js` | Synthesized sounds (Web Audio): each is built from the overtones of the real instrument (bell, bowl, wooden bars) through a shared room reverb. No audio files. Add an entry to `SOUNDS` to add a sound. |
| `js/format.js` | Display formatting (minute resolution). |
| `js/main.js` | UI wiring: keyed in-place rendering (keeps focus while editing), on-card controls, second-aligned ticking, alarms, notifications. |
| `server.js` | Zero-dependency static dev server. |
| `scripts/build.js` | Builds `_site/` (web) or `dist/` (Claude-hosted) with content-hashed file names, so browsers never mix old and new files. |
| `.github/workflows/pages.yml` | On every push to `main`: run tests, build, deploy to GitHub Pages. |

## Roadmap hooks

- **Presets** (water, stretch, …): timers already carry `presetId`, `soundId` and `repeat`. A preset is a template `{ id, name, hours, minutes, soundId, repeat }` passed to `createTimer`.
- **Accounts/sync**: implement another store with the same `load`/`save` shape (or move to per-timer CRUD calls); `timer.js` can run server-side unchanged.

## Known limitations

- Browsers block audio until you've interacted with the page once (any click or keypress).
- Background tabs are throttled. Alarms can fire up to ~1 minute late in a long-hidden tab, and a closed tab can't ring. A PWA with a service worker plus push notifications would fix this later.
