/**
 * Screenshot driver for the README.
 *
 * Mounts the real `App` in Test mode and navigates it with the same synthetic
 * remote other drivers use, then POSTs `/shot-ready`. `run.sh` in SCREENSHOT
 * mode puts a hidden `<img src="/hold.png">` in the parsed HTML; the fake
 * server holds that response until this POST, so Firefox's `--headless
 * --screenshot` (which captures on the load event) fires only after the
 * screen is actually built. Without the hold the capture is a race against
 * the first fetch and usually wins with an empty stage.
 *
 * Test mode is the point: the mock generators give a deterministic library,
 * so the images in the README are the app's own demo content rather than the
 * user's private scenes. No live server is contacted.
 *
 * Usage: `?screen=home|performers|performer-detail|scene-detail|settings-stats|settings-server`
 * A screen that never becomes ready posts `/shot-ready` after the timeout
 * anyway and exits 1, which shoot.sh reports — a wrong screenshot is worse
 * than a failed one.
 */

import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import App from '../../src/App.jsx';
import { registry } from '../../src/hooks/useFocusable.js';
import { setSettings } from '../../src/utils/settings.js';

const PORT = window.__PORT__;
const SCREEN = new URLSearchParams(location.search).get('screen') || 'home';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, ms = 6000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

const active = () => document.activeElement || document.body;
async function tapEnter() {
  const el = active();
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await sleep(40);
  (document.activeElement || el).dispatchEvent(new KeyboardEvent('keyup', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await sleep(300);
}

const focus = (id) => {
  const entry = registry.get(id);
  if (entry) entry.el.focus();
  return !!entry;
};
const liveIds = (prefix) => [...registry.entries()]
  .filter(([id, entry]) => id.startsWith(`${prefix}-`) && document.contains(entry.el))
  .map(([id]) => id);

/** First live registry id with this prefix — card ids are generated, and a
 *  screenshot driver should not hard-code a mock fixture's numbering. */
const firstId = (prefix) => liveIds(prefix)[0] || null;

const railActive = () => [...document.querySelectorAll(
  'nav[aria-label="Main navigation"] button')]
  .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || null;

/**
 * Switch tabs, and *confirm* it happened.
 *
 * Two races make the obvious version lie. The rail mounts before the shelf
 * fetches finish, and the showroom's own autofocus lands on its first card
 * when they do — after a `focus('nav-performers')` issued too early, so the
 * Enter went to a card. And a callback fired on the wrong screen still
 * produces a perfectly valid PNG. Hence: retry the press until the rail's
 * `aria-current` row is the tab we asked for, and let the caller's ready
 * predicate re-assert the surface too.
 */
async function pressBack() {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    keyCode: 10009, key: 'Escape', bubbles: true, cancelable: true,
  }));
  await sleep(250);
}

/** Focus a registry entry and only press when the focus actually stayed
 *  there. The showroom's autofocus can reclaim the stage between a
 *  `focus()` and the following keydown. */
async function focusAndEnter(id) {
  const entry = registry.get(id);
  if (!entry) return false;
  entry.el.focus();
  await sleep(100);
  // Compare the DOM, not getCurrentFocusId: that value is only written by a
  // focus *event*, and calling focus() on the already-focused element fires
  // none — which made this guard refuse to press and read as "focus lost".
  if (document.activeElement !== entry.el) return false;
  await tapEnter();
  return true;
}

async function openTab(tab) {
  const want = tab[0].toUpperCase() + tab.slice(1);
  if (!await waitFor(() => registry.has(`nav-${tab}`), 6000)) return false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (railActive() === want) return true;
    // A press that landed on a card instead leaves an overlay in front of the
    // rail. Back out of it before the next attempt rather than pressing into
    // it.
    if (document.querySelector('[role="dialog"]')) await pressBack();
    if (!await focusAndEnter(`nav-${tab}`)) continue;
    if (await waitFor(() => railActive() === want, 1200)) return true;
  }
  return false;
}

/** Settings is a modal, not a tab: its rail row never takes `aria-current`,
 *  so openTab's confirmation can never pass for it. The panel's own
 *  `settings-cancel` registry entry is the confirmation — `[role="dialog"]`
 *  is not, because the scene detail overlay uses the same role. */
const settingsOpen = () => registry.has('settings-cancel');
const trace = [];

async function openSettings() {
  if (!await waitFor(() => registry.has('nav-settings'), 6000)) return false;
  for (let attempt = 0; attempt < 8; attempt++) {
    trace.push(`S${attempt} open=${settingsOpen()} dialog=${!!document.querySelector('[role="dialog"]')} focus=${document.activeElement?.textContent?.trim().slice(0, 12)}`);
    if (settingsOpen()) return true;
    if (document.querySelector('[role="dialog"]')) await pressBack();
    if (!await focusAndEnter('nav-settings')) { trace.push('  rail focus lost'); continue; }
    trace.push(`  pressed; now open=${settingsOpen()} dialog=${!!document.querySelector('[role="dialog"]')}`);
    if (await waitFor(settingsOpen, 1200)) return true;
  }
  return false;
}

const SCREENS = {
  home: {
    async go() {
      return waitFor(() => liveIds('showroom-recent-scenes-video').length > 0);
    },
    ready: () => liveIds('showroom-recent-scenes-video').length > 0,
  },

  performers: {
    async go() {
      if (!await openTab('performers')) return false;
      // Home's own Recently Added Performers shelf uses the same card ids, so
      // the card alone cannot tell the two surfaces apart. The rail can.
      return waitFor(() => firstId('performer-perf') !== null);
    },
    ready: () => railActive() === 'Performers' && firstId('performer-perf') !== null,
  },

  'performer-detail': {
    async go() {
      if (!await openTab('performers')) return false;
      if (!await waitFor(() => firstId('performer-perf') !== null)) return false;
      focus(firstId('performer-perf'));
      await sleep(150);
      await tapEnter();
      return waitFor(() => registry.has('detail-back'), 6000);
    },
    ready: () => railActive() === 'Performers' && registry.has('detail-back'),
  },

  'scene-detail': {
    async go() {
      if (!await openTab('scenes')) return false;
      if (!await waitFor(() => firstId('video') !== null)) return false;
      focus(firstId('video'));
      await sleep(150);
      await tapEnter();
      // The marker row is the feature this screenshot is for; a scene that
      // somehow had none would still be a valid screenshot, but the detail
      // page itself has to be up.
      return waitFor(
        () => registry.has('scene-play') && liveIds('scene-marker').length > 0, 6000);
    },
    ready: () => railActive() === 'Scenes' && registry.has('scene-play'),
  },

  'settings-stats': {
    async go() {
      if (!await openSettings()) return false;
      if (!await waitFor(() => registry.has('settings-stats'), 4000)) return false;
      await focusAndEnter('settings-stats');
      return waitFor(
        () => document.querySelector('[role="group"][aria-label="Library stats"]'),
        6000);
    },
    ready: () => settingsOpen()
      && !!document.querySelector('[role="group"][aria-label="Library stats"]'),
  },

  'settings-server': {
    async go() {
      if (!await openSettings()) return false;
      if (!await waitFor(() => registry.has('settings-server'), 4000)) return false;
      await focusAndEnter('settings-server');
      return waitFor(
        () => document.querySelector('[role="group"][aria-label="Server status"]'),
        6000);
    },
    ready: () => settingsOpen()
      && !!document.querySelector('[role="group"][aria-label="Server status"]'),
  },
};

(async () => {
  setSettings({ useMock: true, onboarded: 'test' });
  const root = document.getElementById('root');
  root.style.cssText = 'height:100vh;display:flex;flex-direction:column;overflow:hidden;';
  document.body.style.margin = '0';
  createRoot(root).render(<App />);

  const screen = SCREENS[SCREEN];
  let ok = false;
  if (screen) ok = await screen.go();
  // Fonts and the focus ring settle a frame or two after the fetch lands; a
  // capture mid-transition shows a half-drawn card.
  await sleep(500);
  ok = ok && screen.ready();
  // Diagnostics for shoot.sh when a screen fails. Cheap, and the alternative
  // is inferring the tab from a PNG whose whole point is that it looked fine.
  await fetch(`http://127.0.0.1:${PORT}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      screen: SCREEN,
      ok,
      active: active().textContent?.trim().slice(0, 60) || null,
      rail: [...document.querySelectorAll('nav[aria-label="Main navigation"] button')]
        .map(b => `${b.textContent.trim()}${b.getAttribute('aria-current') ? '*' : ''}`),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      settingsIds: [...registry.keys()].filter(k => k.includes('settings')),
      trace,
    }),
  });

  // The flag matters: releasing the hold on a failed screen would capture
  // Home and still produce a plausible-looking image. run.sh refuses the
  // capture when this file exists without ok=1.
  await fetch(`http://127.0.0.1:${PORT}/shot-ready${ok ? '?ok=1' : ''}`, {
    method: 'POST',
  });
  if (ok) {
    // The load event follows the release of /hold.png; the screenshot is
    // taken by Firefox after it. Nothing else to do — exit code comes from
    // run.sh, which treats a not-ready flag or a missing file as failure.
    console.log(`shot ready: ${SCREEN}`);
  } else {
    console.error(`screen never became ready: ${SCREEN}`);
    document.title = `SHOT FAILED ${SCREEN}`;
  }
})();
