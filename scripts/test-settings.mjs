#!/usr/bin/env node
/**
 * test-settings.mjs: setSettings applies the same boundary as loadFromStorage.
 *
 *   node scripts/test-settings.mjs
 *
 * A value that only snaps back on the next launch is a UI/store disagreement,
 * so the checks go through the public API and read getSettings().
 */

const store = new Map();
globalThis.localStorage = {
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
};

const { getSettings, setSettings } = await import('../src/utils/settings.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const initial = getSettings();
check('a fresh device has no saved endpoint', initial.hasSavedEndpoint === false);

// ── invalid values never enter live state ───────────────
{
  // Non-default values first, or "reset to the default" and "kept" would look
  // alike. An unreadable value falls back the way it does on load; only
  // `undefined` is dropped (see the test below).
  setSettings({ theme: 'oled', seekStep: 30, transcodeQuality: 'low' });
  setSettings({ theme: 'dark', seekStep: 7, transcodeQuality: '8k' });
  const after = getSettings();
  check('an unknown theme falls back to standard', after.theme === 'standard', after.theme);
  check('an out-of-range seek step falls back to adaptive',
    after.seekStep === 'adaptive', String(after.seekStep));
  check('an unknown transcode quality falls back to original',
    after.transcodeQuality === 'original', after.transcodeQuality);
}
{
  const before = getSettings();
  setSettings({ stashUrl: 42, stashKey: null, updateLatestVersion: 7 });
  const after = getSettings();
  check('a non-string endpoint leaves the state alone', after.stashUrl === before.stashUrl, after.stashUrl);
  check('a non-string key leaves the state alone', after.stashKey === before.stashKey);
  check('a non-string version leaves the state alone',
    after.updateLatestVersion === before.updateLatestVersion);
}
{
  // Seeded non-zero, or the reset check passes on a value that was already 0.
  setSettings({ lastUpdateCheckAt: 1234 });
  const before = getSettings();
  setSettings({ lastUpdateCheckAt: 'yesterday' });
  check('a non-finite timestamp is reset to zero', getSettings().lastUpdateCheckAt === 0,
    String(before.lastUpdateCheckAt));
}
check('valid values do apply', (() => {
  setSettings({ theme: 'oled', seekStep: 5 });
  return getSettings().theme === 'oled' && getSettings().seekStep === 5;
})());
check('an undefined value does not wipe a setting', (() => {
  setSettings({ theme: undefined });
  return getSettings().theme === 'oled';
})());

// ── derived fields cannot be written ────────────────────
check('hasSavedEndpoint cannot be forced on', (() => {
  setSettings({ hasSavedEndpoint: true });
  return getSettings().hasSavedEndpoint === false;
})());
check('saving an endpoint derives hasSavedEndpoint', (() => {
  setSettings({ stashUrl: 'http://192.0.2.10:8087' });
  return getSettings().hasSavedEndpoint === true;
})());

// ── onboarded matches what the next launch infers ───────
check('an invalid answer over a saved endpoint is live', (() => {
  setSettings({ onboarded: 'maybe' });
  return getSettings().onboarded === 'live';
})());
check('the sample-data answer is kept', (() => {
  setSettings({ onboarded: 'test' });
  return getSettings().onboarded === 'test';
})());
check('with no endpoint an invalid answer is null', (() => {
  setSettings({ stashUrl: '', stashKey: '', onboarded: 'maybe' });
  return getSettings().onboarded === null;
})());
// Explicit null is "never asked", the value FirstRun gates on, not an
// invalid answer to infer `live` over.
check('an explicit null survives a saved endpoint', (() => {
  setSettings({ stashUrl: 'http://192.0.2.10:8087', onboarded: null });
  return getSettings().onboarded === null;
})());

// ── the next launch sees the same values ────────────────
{
  setSettings({
    stashUrl: 'http://192.0.2.10:8087', stashKey: 'abc',
    theme: 'oled', seekStep: 5, transcodeQuality: 'standard',
    onboarded: 'test', viewModes: { scenes: 'coverflow' },
  });
  const reloaded = await import('../src/utils/settings.js?reload=1');
  const s = reloaded.getSettings();
  check('a reload keeps the endpoint', s.stashUrl === 'http://192.0.2.10:8087', s.stashUrl);
  check('...and the theme', s.theme === 'oled', s.theme);
  check('...and the seek step', s.seekStep === 5, String(s.seekStep));
  check('...and the transcode quality', s.transcodeQuality === 'standard', s.transcodeQuality);
  check('...and the answer', s.onboarded === 'test', String(s.onboarded));
  check('...and the derived endpoint flag', s.hasSavedEndpoint === true, String(s.hasSavedEndpoint));
  check('...and the view mode', s.viewModes.scenes === 'coverflow', JSON.stringify(s.viewModes));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
