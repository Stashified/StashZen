/**
 * Headless driver for the one thing every other driver cannot see: module
 * init.
 *
 * `settings.js` runs `let state = loadFromStorage()` at module scope, and
 * `loadFromStorage` validated saved `viewModes` through `readViewModes`, which
 * read a `const VIEW_MODES` declared below that call, a temporal dead zone
 * `ReferenceError`. The throw only fired when a `viewModes` map existed to
 * iterate (`readViewModes` early-returns for undefined/null/string/array), and
 * the module threw during import, so the launch rendered nothing: no grid, no
 * first-run, no PIN, before React had a component to mount.
 *
 * Every other entry imports settings.js statically and seeds through
 * `setSettings` after init, so `VIEW_MODES` is long initialised and the
 * ordering is never exercised. A relaunch writes localStorage then loads the
 * module, so this driver writes storage first and imports dynamically;
 * `App.jsx` is dynamic for the same reason.
 *
 * Asserts on the load, not the feature (that is views-entry.jsx's job): the
 * module evaluates and the app mounts.
 */

import '../../src/index.css';

const LS_KEY = 'tvapp.settings.v1';
const PORT = window.__PORT__;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const errors = [];
window.addEventListener('error', (e) => { errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', (e) => {
  errors.push(`unhandled rejection: ${(e.reason && e.reason.message) || e.reason}`);
});

async function waitFor(pred, ms = 6000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

const seed = (obj) => {
  localStorage.setItem(LS_KEY, JSON.stringify(obj));
};

// Exercises every field `loadFromStorage` validates, with `viewModes` present
// and non-empty, the condition that made init throw.
const SAVED = {
  stashUrl: `http://127.0.0.1:${PORT}`,
  stashKey: 'harness',
  useMock: false,
  onboarded: 'live',
  viewModes: { performers: 'carousel' },
};

/**
 * Load `settings.js` the way a relaunch does: storage written, module second.
 *
 * One shot per page: an ES module evaluates once per realm, so a second
 * `import()` returns the cached namespace and module scope does not re-run (a
 * cache-busting query fails, as the lib build emits no such file). The
 * interesting fixture therefore gets the one real observation; other shapes
 * are asked of `readViewModes` directly, which `loadFromStorage` calls with
 * exactly that argument. Only the timing needs the dynamic import.
 */
async function loadSettings() {
  return import('../../src/utils/settings.js');
}

async function run() {
  // ── 1. The repro: a saved viewModes map, loaded at module init ──
  seed(SAVED);
  let mod = null, threw = null;
  try {
    mod = await loadSettings();
  } catch (e) {
    threw = `${(e && e.constructor && e.constructor.name) || 'Error'}: ${(e && e.message) || e}`;
  }
  check('B0 settings.js evaluates with a saved viewModes map',
    !!mod && !threw, threw || 'module loaded');
  if (!mod) return;

  check('B1 and it read the saved mode rather than dropping it',
    mod.getSettings().viewModes.performers === 'carousel',
    JSON.stringify(mod.getSettings().viewModes));
  check('B1 the rest of the saved settings survived the same read',
    mod.getSettings().onboarded === 'live'
      && mod.getSettings().useMock === false
      && mod.getSettings().stashUrl === `http://127.0.0.1:${PORT}`,
    `onboarded=${mod.getSettings().onboarded} useMock=${mod.getSettings().useMock}`);

  // ── 2. What the validator does with the other shapes ──
  // These take the early return and never reach the throwing line, which is
  // why they cannot serve as the regression check.
  check('B2 an unrecognised mode is dropped, keeping the valid one',
    JSON.stringify(mod.readViewModes({ home: 'hologram', performers: 'carousel' }))
      === JSON.stringify({ performers: 'carousel' }),
    JSON.stringify(mod.readViewModes({ home: 'hologram', performers: 'carousel' })));

  const shapes = [
    ['absent', undefined],
    ['null', null],
    ['a string', 'classic'],
    ['an array', ['classic']],
  ];
  const shapeOut = shapes.map(([label, v]) => `${label}=${JSON.stringify(mod.readViewModes(v))}`);
  check('B2 absent, null, a string and an array all read as "no modes set"',
    shapes.every(([, v]) => JSON.stringify(mod.readViewModes(v)) === '{}'),
    shapeOut.join(' '));

  // ── 3. And the app itself mounts from that same storage ──
  // App is imported dynamically so its static settings.js import evaluates
  // after the seed. The user-facing symptom was a blank screen; a tree renders
  // is the claim.
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('../../src/App.jsx');
  const { registry } = await import('../../src/hooks/useFocusable.js');

  const before = localStorage.getItem(LS_KEY);
  const root = createRoot(document.getElementById('root'));
  root.render(<App />);
  const mounted = await waitFor(() => registry.size > 0, 8000);
  check('B3 the app mounts from a saved viewModes map', mounted, `${registry.size} focusable ids`);
  check('B3 the rail rendered — this is the screen that was blank',
    !!document.querySelector('nav[aria-label="Main navigation"]'),
    `nav=${!!document.querySelector('nav[aria-label="Main navigation"]')}`);

  // The mount must not rewrite the store out from under the mode; the earlier
  // checks read the module, this reads what mounting persisted.
  let after = null;
  try { after = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* stays null */ }
  check('B3 and the stored mode is still there after the app mounted',
    after?.viewModes?.performers === 'carousel',
    `before=${JSON.stringify(JSON.parse(before || 'null')?.viewModes)} after=${JSON.stringify(after?.viewModes ?? null)}`);

  check('B4 no error was raised during the boot',
    errors.length === 0, errors.length ? errors.slice(-2).join(' | ') : 'none');
}

async function finish() {
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  });
  await fetch('/done', { method: 'POST' });
}

run().then(finish).catch(async (e) => {
  check('B9 the driver itself threw', false,
    String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
