/**
 * Screenshot driver for the README.
 *
 * Mounts the real `App` in Test mode, navigates with the synthetic remote,
 * then POSTs `/shot-ready`. run.sh's SCREENSHOT mode puts a hidden
 * `<img src="/hold.png">` in the HTML; the fake server holds that response
 * until the POST, so Firefox's `--screenshot` (on the load event) fires only
 * once the screen is built, rather than racing the first fetch to an empty
 * stage.
 *
 * Test mode gives a deterministic mock library, so the images are demo content
 * rather than the user's scenes; no live server is contacted.
 *
 * Usage: `?screen=home|performers|performer-detail|scene-detail|settings-stats|settings-server`
 * A screen that never readies still posts after the timeout and exits 1: a
 * wrong screenshot is worse than a failed one.
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

/** First live registry id with this prefix — card ids are generated, so a
 *  screenshot driver must not hard-code mock fixture numbering. */
const firstId = (prefix) => liveIds(prefix)[0] || null;

const railActive = () => [...document.querySelectorAll(
  'nav[aria-label="Main navigation"] button')]
  .find(b => b.getAttribute('aria-current') === 'page')?.textContent.trim() || null;

/**
 * Switch tabs, and *confirm* it happened.
 *
 * Two races lie: the showroom's autofocus lands on its first card after a too
 * early `focus('nav-performers')`, so the Enter hits a card; and a callback on
 * the wrong screen still yields a valid PNG. So retry until the rail's
 * `aria-current` row is the wanted tab, and let the caller's ready predicate
 * re-assert the surface.
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
  // Compare the DOM, not getCurrentFocusId: that is only written by a focus
  // event, and focus() on the already-focused element fires none.
  if (document.activeElement !== entry.el) return false;
  await tapEnter();
  return true;
}

async function openTab(tab) {
  const want = tab[0].toUpperCase() + tab.slice(1);
  if (!await waitFor(() => registry.has(`nav-${tab}`), 6000)) return false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (railActive() === want) return true;
    // A press that landed on a card leaves an overlay in front of the rail;
    // back out before the next attempt.
    if (document.querySelector('[role="dialog"]')) await pressBack();
    if (!await focusAndEnter(`nav-${tab}`)) continue;
    if (await waitFor(() => railActive() === want, 1200)) return true;
  }
  return false;
}

/** Settings is a modal, so its rail row never takes `aria-current` and
 *  openTab can never confirm it. Its `settings-cancel` entry is the
 *  confirmation; `[role="dialog"]` is not, as the scene detail overlay shares
 *  that role. */
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
      // Home's performer shelf uses the same card ids, so only the rail tells
      // the two surfaces apart.
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
      // The marker row is the feature; a scene without one is still a valid
      // screenshot, but the detail page must be up.
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
  // Fonts and the focus ring settle a frame or two after the fetch.
  await sleep(500);
  ok = ok && screen.ready();
  // Diagnostics for shoot.sh when a screen fails, rather than inferring the
  // tab from a PNG that looks fine.
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

  // Releasing the hold on a failed screen would capture a plausible-looking
  // Home; run.sh refuses the capture unless ok=1.
  await fetch(`http://127.0.0.1:${PORT}/shot-ready${ok ? '?ok=1' : ''}`, {
    method: 'POST',
  });
  if (ok) {
    // Firefox screenshots after the load event released by /hold.png. Exit
    // code comes from run.sh, which fails on a not-ready flag or missing file.
    console.log(`shot ready: ${SCREEN}`);
  } else {
    console.error(`screen never became ready: ${SCREEN}`);
    document.title = `SHOT FAILED ${SCREEN}`;
  }
})();
