/**
 * Headless driver for the user-selectable OLED theme.
 *
 * Two claims: module init applies the saved theme, and the Settings row is a
 * draft. The first seeds localStorage then imports `settings.js` dynamically
 * (a relaunch, not a `setSettings` call): the theme must be on `<html>` before
 * React renders, because AppLock and FirstRun mount App's siblings and unmount
 * App, so a React effect would leave the PIN and setup screens un-themed.
 *
 * The second exercises Standard→Cancel (nothing changes), then Standard→Save
 * and OLED→Save (applied immediately and persisted).
 *
 * Every settings.js import is dynamic: a static one would evaluate before the
 * seed line, the trap boot-entry.jsx exists to avoid.
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

const SAVED = {
  stashUrl: `http://127.0.0.1:${PORT}`,
  stashKey: 'harness',
  useMock: false,
  onboarded: 'live',
  theme: 'oled',
};

const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const stored = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
};
const htmlTheme = () => document.documentElement.dataset.theme || null;

// ── Input, the way a remote sends it ───────────────────────
const active = () => document.activeElement || document.body;
function press(key, keyCode) {
  active().dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode, which: keyCode, bubbles: true, cancelable: true,
  }));
}
async function enter(el) {
  el?.focus();
  await sleep(60);
  press('Enter', 13);
  await sleep(300);
}

const dialogButtons = () => [...document.querySelectorAll('[role="dialog"] button')];
const byLabel = (label) => dialogButtons().find(b => b.textContent.trim() === label);

// The prompt's `autoFocus` lands 50 ms after mount (useFocusable's timer); a
// focus() before that is stolen back, so the following Enter hits "Keep
// editing". Wait for the timer before addressing another prompt button.
const promptReady = () =>
  waitFor(() => document.activeElement === byLabel('Keep editing'), 1000);

async function run() {
  // ── 1. A relaunch with OLED saved ──────────────────────────
  localStorage.setItem(LS_KEY, JSON.stringify(SAVED));

  let mod = null, threw = null;
  try {
    mod = await import('../../src/utils/settings.js');
  } catch (e) {
    threw = `${(e && e.constructor && e.constructor.name) || 'Error'}: ${(e && e.message) || e}`;
  }
  check('T0 settings.js evaluates with a saved OLED theme',
    !!mod && !threw, threw || 'module loaded');
  if (!mod) return;

  check('T1 the saved theme is on <html> before React renders anything',
    htmlTheme() === 'oled', `data-theme=${JSON.stringify(htmlTheme())}`);
  check('T1 and the page is actually black',
    getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'
      && cssVar('--bg-base') === '#000000',
    `body=${getComputedStyle(document.body).backgroundColor} --bg-base=${cssVar('--bg-base')}`);
  check('T1 cards stay lifted off the page rather than vanishing into it',
    cssVar('--bg-card') === '#10171c' && cssVar('--bg-elevated') === '#18222a',
    `--bg-card=${cssVar('--bg-card')} --bg-elevated=${cssVar('--bg-elevated')}`);
  check('T1 borders are light enough to read on a black page',
    /255, ?255, ?255/.test(cssVar('--border'))
      && /255, ?255, ?255/.test(cssVar('--border-strong')),
    `--border=${cssVar('--border')} --border-strong=${cssVar('--border-strong')}`);

  // ── 2. Identity is unchanged ──────────────────────────────
  check('T2 accent and text colours do not change with the panel',
    cssVar('--accent') === '#48aff0'
      && cssVar('--text-primary') === '#f5f8fa'
      // Computed custom properties substitute var(), so the ring carries the
      // accent hex already.
      && cssVar('--focus-ring').includes('#48aff0'),
    `--accent=${cssVar('--accent')} --focus-ring=${cssVar('--focus-ring')}`);

  // ── 3. The validator at the storage boundary ──────────────
  check('T3 an absent or unrecognised theme reads as Standard',
    mod.readTheme(undefined) === 'standard'
      && mod.readTheme('neon') === 'standard'
      && mod.readTheme(null) === 'standard'
      && mod.readTheme('oled') === 'oled',
    `undefined=${mod.readTheme(undefined)} neon=${mod.readTheme('neon')} oled=${mod.readTheme('oled')}`);
  check('T3 and the saved OLED value survived the load',
    mod.getSettings().theme === 'oled', `theme=${mod.getSettings().theme}`);

  // ── 4. The Settings row ───────────────────────────────────
  const { createRoot } = await import('react-dom/client');
  const { default: SettingsPanel } = await import('../../src/components/SettingsPanel.jsx');

  const mountPanel = async () => {
    const host = document.getElementById('root');
    const root = createRoot(host);
    root.render(<SettingsPanel onClose={() => { window.__closed = true; }} />);
    await waitFor(() => !!byLabel('Save'), 6000);
    await sleep(200);
    return root;
  };

  const panel = await mountPanel();
  check('T4 the panel shows the current theme as selected',
    byLabel('OLED')?.getAttribute('aria-checked') === 'true'
      && byLabel('Standard')?.getAttribute('aria-checked') === 'false',
    `OLED=${byLabel('OLED')?.getAttribute('aria-checked')} Standard=${byLabel('Standard')?.getAttribute('aria-checked')}`);

  // Draft discard: choose Standard, back out. Nothing may change.
  await enter(byLabel('Standard'));
  check('T4 choosing Standard updates the draft but not the document',
    htmlTheme() === 'oled' && mod.getSettings().theme === 'oled',
    `data-theme=${JSON.stringify(htmlTheme())} store=${mod.getSettings().theme}`);
  // Cancel with a dirty draft asks first; Discard is the answer that leaves.
  window.__closed = false;
  await enter(byLabel('Cancel'));
  const asked = await waitFor(() => !!byLabel('Discard') && !!byLabel('Keep editing'), 2000);
  await promptReady();
  check('T5a Cancel with an unsaved draft asks instead of discarding',
    asked && !window.__closed && htmlTheme() === 'oled'
      && mod.getSettings().theme === 'oled',
    `asked=${asked} closed=${!!window.__closed} data-theme=${JSON.stringify(htmlTheme())}`);
  await enter(byLabel('Discard'));
  check('T5 Cancel → Discard leaves the document and the store on OLED',
    htmlTheme() === 'oled' && mod.getSettings().theme === 'oled'
      && stored()?.theme === 'oled' && window.__closed === true,
    `data-theme=${JSON.stringify(htmlTheme())} store=${mod.getSettings().theme} saved=${stored()?.theme} closed=${!!window.__closed}`);
  panel.unmount();

  // The Back route: the question appears, Back again keeps editing with the
  // draft intact and the cursor restored.
  window.__closed = false;
  const panelBack = await mountPanel();
  await enter(byLabel('Standard'));
  press('Escape', 27);
  const askedBack = await waitFor(() => !!byLabel('Keep editing'), 2000);
  press('Escape', 27);
  const backToEditing = await waitFor(
    () => !byLabel('Keep editing') && !!byLabel('Save'), 2000);
  check('T5b Back with an unsaved draft asks first',
    askedBack && window.__closed === false,
    `asked=${askedBack} closed=${!!window.__closed}`);
  check('T5b Back again keeps editing, with the draft intact',
    backToEditing && byLabel('Standard')?.getAttribute('aria-checked') === 'true'
      && htmlTheme() === 'oled' && mod.getSettings().theme === 'oled',
    `open=${backToEditing} Standard=${byLabel('Standard')?.getAttribute('aria-checked')} data-theme=${JSON.stringify(htmlTheme())}`);
  check('T5b ...and focus returns to the control it left',
    document.activeElement === byLabel('Standard'),
    `active=${document.activeElement?.textContent?.trim()}`);

  // Save & close from the question is the same commit as the footer button.
  press('Escape', 27);
  const askedSave = await waitFor(() => !!byLabel('Save & close'), 2000);
  await promptReady();
  await enter(byLabel('Save & close'));
  check('T5c Save & close from the question applies the draft',
    askedSave && htmlTheme() === null && stored()?.theme === 'standard'
      && mod.getSettings().theme === 'standard',
    `asked=${askedSave} data-theme=${JSON.stringify(htmlTheme())} saved=${stored()?.theme}`);
  panelBack.unmount();

  // Put OLED back so T6 still measures a real transition.
  window.__closed = false;
  const panelReset = await mountPanel();
  await enter(byLabel('OLED'));
  await enter(byLabel('Save'));
  panelReset.unmount();

  // Save Standard: applied immediately, persisted, and the page goes back.
  const panel2 = await mountPanel();
  await enter(byLabel('Standard'));
  await enter(byLabel('Save'));
  check('T6 saving Standard applies the base palette',
    htmlTheme() === null
      && getComputedStyle(document.body).backgroundColor === 'rgb(32, 43, 51)'
      && cssVar('--bg-base') === '#202b33',
    `data-theme=${JSON.stringify(htmlTheme())} --bg-base=${cssVar('--bg-base')}`);
  check('T6 and it is what a relaunch would read',
    mod.getSettings().theme === 'standard' && stored()?.theme === 'standard',
    `store=${mod.getSettings().theme} saved=${stored()?.theme}`);

  // Save OLED: the same transition in the other direction.
  panel2.unmount();
  const panel3 = await mountPanel();
  await enter(byLabel('OLED'));
  await enter(byLabel('Save'));
  check('T6 saving OLED applies the black palette immediately',
    htmlTheme() === 'oled'
      && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)'
      && cssVar('--bg-base') === '#000000',
    `data-theme=${JSON.stringify(htmlTheme())} --bg-base=${cssVar('--bg-base')}`);
  check('T6 and persists it',
    mod.getSettings().theme === 'oled' && stored()?.theme === 'oled',
    `store=${mod.getSettings().theme} saved=${stored()?.theme}`);
  panel3.unmount();

  // A theme-only write: the panel's Save always carries the connection
  // fields, so the persist condition is otherwise never exercised.
  mod.setSettings({ theme: 'standard' });
  check('T6 a theme-only write reaches storage',
    stored()?.theme === 'standard' && htmlTheme() === null,
    `saved=${stored()?.theme} data-theme=${JSON.stringify(htmlTheme())}`);
  mod.setSettings({ theme: 'oled' });

  check('T7 no error was raised during the run',
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
  check('T9 the driver itself threw', false,
    String(e && e.stack ? e.stack.split('\n')[0] : e));
  await finish();
});
