/**
 * Headless driver for the one thing every other driver cannot see: **module
 * init**.
 *
 * 0.10.0 shipped a blank screen. `settings.js` does `let state =
 * loadFromStorage()` at module scope, and `loadFromStorage` validates the
 * saved `viewModes` through `readViewModes`, which reads `const VIEW_MODES` —
 * declared *below* that call. A `const` is in the temporal dead zone until its
 * own line runs, so the validation threw
 * `ReferenceError: Cannot access 'VIEW_MODES' before initialization`.
 *
 * **The throw only happened when a `viewModes` map existed to iterate.**
 * `readViewModes` returns early for undefined/null/a string/an array, so a
 * device that had never touched the Mode control loaded fine. Only a user who
 * had actually set a per-section mode armed it — and for them the module threw
 * during import, so the launch rendered *nothing*: no grid, no first-run, no
 * PIN prompt. The whole tree was gone before React had a component to mount.
 *
 * **Why no other driver caught it, which is the point of this file.** Every
 * other entry imports `settings.js` statically and seeds through `setSettings`
 * *after* the module has initialised — `views-entry.jsx` even says in its
 * header that a pre-mount `setSettings` write "is the same observable thing as
 * a saved value". That claim is false, and this bug is exactly the distance
 * between them: `setSettings` reaches `readViewModes` long after `VIEW_MODES`
 * has been initialised, so the ordering is never exercised. A relaunch does
 * not go through `setSettings` at all. It writes localStorage and *then* loads
 * the module.
 *
 * So this driver writes storage first and imports second, dynamically, so that
 * module evaluation happens after the fixture is in place. `App.jsx` is
 * imported dynamically for the same reason — a static import would pull
 * `settings.js` in at the top of the bundle and evaluate it before the first
 * line here runs, which is the trap this file exists to avoid.
 *
 * It asserts on the *load*, not on the feature: that the module evaluates, and
 * that the app mounts. The feature itself is `views-entry.jsx`'s job.
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

// A saved state that exercises every field `loadFromStorage` validates, with
// `viewModes` present and non-empty — the condition that made 0.10.0 throw.
const SAVED = {
  stashUrl: `http://127.0.0.1:${PORT}`,
  stashKey: 'harness',
  useMock: false,
  onboarded: 'live',
  viewModes: { performers: 'carousel' },
};

/**
 * Load `settings.js` the way a relaunch does: storage already written, module
 * evaluated second.
 *
 * **There is exactly one shot at this per page, and that is a property of the
 * language, not a limitation of the harness.** An ES module evaluates once per
 * realm, so a second `import()` of the same specifier returns the cached
 * namespace and module scope does not re-run. A cache-busting query does not
 * help — the lib build emits no such file, and the import fails outright.
 *
 * So the interesting fixture gets the one real observation, and everything
 * else is asked of `readViewModes` directly on the module that came back. That
 * is faithful rather than a compromise: `loadFromStorage` calls exactly
 * `readViewModes(saved.viewModes)`, so a pure call with the same argument is
 * the same computation. The *timing* is the only thing the pure call cannot
 * reproduce — and timing is precisely what the one dynamic import is here to
 * cover.
 *
 * The fixture is deliberately the one that broke: `viewModes` present and
 * non-empty, which is the only shape that reaches the line that threw.
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
  // The same function the module init called, asked about the inputs that were
  // never at risk: these all take the early return and never reach the line
  // that threw, which is why they cannot serve as the regression check.
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
  // Necessary and not sufficient on its own — the app is imported dynamically
  // so its static import of settings.js is evaluated *after* the seed above,
  // which is the whole point of this file. 0.10.0's symptom was a blank
  // screen, so the claim a user cares about is that a tree renders.
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

  // The mount must not have rewritten the store out from under the mode. This
  // is the one claim the earlier checks cannot make: they read the module, and
  // this reads what mounting the app did to what is persisted.
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
