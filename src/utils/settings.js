/**
 * settings.js — runtime configuration store.
 *
 * Persists the Stash endpoint, API key, Test/Live mode, preview preferences,
 * theme, playback engine and first-run answer to localStorage, so a device is
 * configured once. Build-time env is only the *fallback* for a device that has
 * never saved anything: Test only if VITE_USE_MOCK is 'true', otherwise Live;
 * .env.production ships false, so a fresh release starts Live. A power user can
 * still preconfigure with a .env file.
 *
 * Components subscribe via `useSettings()` to re-render on change (e.g. a
 * Test→Live flip makes grids refetch).
 */

import { useEffect, useState } from 'react';
import { graphqlRequest } from './stashClient.js';
import { sha256Hex } from './sha256.js';
import { readPlaybackEngine } from './enginePolicy.js';

const LS_KEY = 'tvapp.settings.v1';

// ── Defaults from build-time env ─────────────────────────
const ENV_URL  = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STASH_URL)
  || 'http://localhost:9999';
const ENV_KEY  = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_STASH_API_KEY)
  || '';
const ENV_MOCK  = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_USE_MOCK === 'true');

/**
 * The view modes a section may be in. Exported because it is persisted
 * vocabulary: `viewModes` stores these strings and the Mode control offers
 * them. A stored value outside the set is rejected at the boundary, else App
 * falls through to the grid with the Mode control showing nothing selected.
 *
 * **Declared above `state` below, and that is load-bearing.** `state =
 * loadFromStorage()` runs at module init and calls `readViewModes`, which reads
 * this; as a later `const` it sits in the temporal dead zone, and the
 * import-time throw is a blank screen with no first-run or PIN prompt. Anything
 * else `loadFromStorage` reaches must likewise be a function declaration or
 * declared above.
 */
export const VIEW_MODES = ['classic', 'carousel', 'coverflow', 'list'];

/**
 * The themes a device may be in. `standard` is the Blueprint-derived palette;
 * `oled` turns the page black and lifts only the surfaces that must stay
 * distinguishable, for panels where black is genuinely off.
 *
 * Same boundary rule as VIEW_MODES: declared above `state`, because
 * `loadFromStorage` validates through it at module init.
 */
export const THEMES = ['standard', 'oled'];

export function readTheme(value) {
  return value === 'oled' ? 'oled' : 'standard';
}

/**
 * Apply the theme to the document root.
 *
 * Called at module init — before React renders — and on every change.
 * Deliberately outside React: AppLock and FirstRun unmount App by design, so an
 * effect in App would leave the PIN and first-run screens in the old theme and
 * flash on unlock. `standard` is the attribute's absence, so `:root` applies.
 */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (theme === 'oled') el.dataset.theme = 'oled';
  else delete el.dataset.theme;
}

// ── In-memory state ──────────────────────────────────────
let state = loadFromStorage();
applyTheme(state.theme);

/**
 * The stored per-section view modes, with unrecognised values dropped.
 *
 * A sparse map: an absent tab means 'classic'. Keys and values must be strings,
 * since this came back from JSON. Exported because it is the validation
 * boundary — `views-entry.jsx` asserts on it directly, while `boot-entry.jsx`
 * covers the real relaunch path by writing storage before the first import.
 */
export function readViewModes(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const out = {};
  for (const [tab, mode] of Object.entries(saved)) {
    if (VIEW_MODES.includes(mode)) out[tab] = mode;
  }
  return out;
}

/**
 * The stored per-section grid column counts, unrecognised values dropped. Same
 * sparse-map contract as readViewModes: an absent tab means the section default,
 * so a new section needs no migration.
 *
 * Per section because card shapes differ: a performer card is 3:4 and a scene
 * card 16:9, so one count that suits Scenes makes Performers enormous. Changing
 * columns on one tab leaves the others alone.
 */
export function readGridCols(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const out = {};
  for (const [tab, cols] of Object.entries(saved)) {
    if (Number.isInteger(cols) && cols >= 1 && cols <= 8) out[tab] = cols;
  }
  return out;
}

function loadFromStorage() {
  let saved = {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (e) {
    // Corrupt or unavailable storage — ignore, fall back to env
  }

  // Scenes was split out of Home. Absent tabs already mean "use the default",
  // so this only carries the user's *choice* over: Home's mode and column
  // count become Scenes'. Non-destructive — the old `home` keys stay.
  const viewModes = readViewModes(saved.viewModes);
  const gridCols = readGridCols(saved.gridCols);
  if (viewModes.scenes === undefined && viewModes.home !== undefined) {
    viewModes.scenes = viewModes.home;
  }
  if (gridCols.scenes === undefined && gridCols.home !== undefined) {
    gridCols.scenes = gridCols.home;
  }

  return {
    stashUrl: saved.stashUrl || ENV_URL,
    stashKey: saved.stashKey || ENV_KEY,
    // Preview mute is per-device user preference; persists.
    previewMuted: saved.previewMuted !== undefined ? !!saved.previewMuted : true,
    // On by default: a fresh install should see previews without hunting
    // through Settings. The cost is that `paths.preview` is non-empty even for
    // scenes never generated, so a focused card issues a request that fails;
    // VideoCard learns and stops repeating. An existing device keeps its value.
    previewsEnabled: saved.previewsEnabled !== undefined ? !!saved.previewsEnabled : true,
    // Persisted, or the Test/Live switch would be forgotten on every launch.
    useMock: saved.useMock !== undefined ? !!saved.useMock : ENV_MOCK,
    // The appearance theme. Standard on every device that has never chosen —
    // an upgrade must not restyle a working TV unasked.
    theme: readTheme(saved.theme),
    // Which engine `Auto` means: the browser first, AVPlay as fallback.
    // `browser` is the rollback lever (the old browser-only player). An
    // unrecognised value falls back to `auto`, like every validated setting.
    playbackEngine: readPlaybackEngine(saved.playbackEngine),
    // Which view each section is in, keyed by tab: { scenes: 'coverflow' }.
    // Absent means 'classic' — a sparse map so a new section needs no
    // migration. Values are validated on the way in, not trusted.
    viewModes,
    // Per-section column counts, keyed by tab: { performers: 6 }. Absent means
    // the section default (see gridColsFor in App.jsx).
    gridCols,
    // The first-run answer; null means "never asked", which the setup screen
    // gates on. A device with an endpoint or key already saved is inferred to
    // have answered `live` — without that, every configured device would be
    // asked to re-enter a working connection. Only `live` can be inferred:
    // nothing recorded could mean "sample data".
    onboarded: saved.onboarded === 'live' || saved.onboarded === 'test'
      ? saved.onboarded
      : ((saved.stashUrl || saved.stashKey) ? 'live' : null),
    // Set by "Run setup again". Separate from `onboarded` rather than blanking
    // it, so Back can cancel a re-run and return to the running app.
    setupRequested: !!saved.setupRequested,
    // Derived, never persisted: has this device ever saved an endpoint? The
    // setup screen prefills the URL only if so — `stashUrl` always falls back
    // to ENV_URL's localhost, and prefilled localhost on a TV reads as real.
    hasSavedEndpoint: !!(saved.stashUrl || saved.stashKey),
  };
}

function persistToStorage() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      stashUrl: state.stashUrl,
      stashKey: state.stashKey,
      previewMuted: state.previewMuted,
      previewsEnabled: state.previewsEnabled,
      useMock: state.useMock,
      theme: state.theme,
      playbackEngine: state.playbackEngine,
      viewModes: state.viewModes,
      gridCols: state.gridCols,
      onboarded: state.onboarded,
      setupRequested: state.setupRequested,
      // hasSavedEndpoint is deliberately absent — derived, so it could only
      // disagree with the two fields above.
    }));
  } catch (e) {
    // Storage full / disabled — fail silently, runtime state still works
  }
}

// ── Subscribers ──────────────────────────────────────────
const listeners = new Set();
function notify() {
  listeners.forEach(fn => fn(state));
}

// ── Public API ───────────────────────────────────────────
export function getSettings() {
  return state;
}

// Fingerprint of the key the current source string was built from. One entry:
// only the current key matters, and keying on the secret re-hashes on change.
let keyFingerprint = { key: null, fp: null };

function fingerprint(secret) {
  if (keyFingerprint.key === secret) return keyFingerprint.fp;
  // A short digest, not the secret: 16 hex chars distinguish credentials and
  // is still a hash, so it is safe as a Map key and in a console log.
  const fp = sha256Hex(String(secret)).slice(0, 16);
  keyFingerprint = { key: secret, fp };
  return fp;
}

/**
 * Identifies the data source the app is currently pointed at.
 *
 * App.jsx uses this as the `key` on <main>, remounting the data tree on a
 * Test↔Live switch. Module caches *survive* that remount, so they partition
 * themselves with this same string — see listCache.js.
 *
 * The key's *value* is part of the identity, via a digest rather than the
 * secret itself: regenerating a token for the same server must not leave
 * module caches holding the previous credential's answers. The digest keeps
 * the secret out of a cache key.
 */
export function dataSourceKey(s = state) {
  return s.useMock ? 'mock' : `live:${s.stashUrl}:${s.stashKey ? `k${fingerprint(s.stashKey)}` : 'nk'}`;
}

export function setSettings(patch) {
  state = { ...state, ...patch };
  // Recomputed, never set by callers, so it cannot drift from its two source
  // fields. A just-saved connection counts as saved, so revisiting the setup
  // screen does not clear a field the user already filled.
  if ('stashUrl' in patch || 'stashKey' in patch) {
    state.hasSavedEndpoint = !!(state.stashUrl || state.stashKey);
  }
  // Every persisted field must be in this list, or a change works for the
  // session and vanishes on the next launch.
  if ('stashUrl' in patch || 'stashKey' in patch || 'previewMuted' in patch
      || 'previewsEnabled' in patch || 'useMock' in patch || 'theme' in patch
      || 'playbackEngine' in patch
      || 'viewModes' in patch || 'gridCols' in patch || 'onboarded' in patch
      || 'setupRequested' in patch) {
    persistToStorage();
  }
  // Applied here, not by the panel, so every path that changes the theme also
  // re-themes the document.
  if ('theme' in patch) applyTheme(state.theme);
  notify();
}

export function subscribeSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * React hook — returns the current settings and re-renders on change.
 */
export function useSettings() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => subscribeSettings(setSnapshot), []);
  return snapshot;
}

/**
 * Test a Stash connection without committing the values to the store.
 * Returns { ok: true, version } on success, { ok: false, reason } on failure.
 *
 * The one request that deliberately does NOT go through `runQuery`: it must
 * test credentials the user has typed but not yet saved, so it passes
 * `{url, key}` straight to `graphqlRequest`.
 */
export async function testStashConnection({ url, key }) {
  if (!url) return { ok: false, reason: 'Endpoint URL is required.' };

  let data;
  try {
    data = await graphqlRequest('{ version { version } }', {}, { url, key });
  } catch (e) {
    if (e?.code === 'http' && (e.status === 401 || e.status === 403)) {
      return { ok: false, reason: 'Authentication failed. Check the API key.' };
    }
    // Any other non-2xx. `{ version { version } }` takes no arguments, so the
    // status is the whole story — there is no rejected-input detail.
    if (e?.code === 'http') return { ok: false, reason: `Server returned HTTP ${e.status}.` };
    if (e?.code === 'parse') return { ok: false, reason: 'Server returned invalid JSON.' };
    // 'graphql' | 'timeout' | 'network' | 'config' carry a user-facing message.
    return { ok: false, reason: e?.message || 'Cannot reach server. Check the URL.' };
  }

  const v = data?.version?.version;
  if (!v) return { ok: false, reason: 'Unexpected response from server.' };

  // Stash reports "v0.31.1"; the callers print their own "v" in front.
  return { ok: true, version: String(v).replace(/^v/i, '') };
}

/**
 * Wipe persisted settings, reset in-memory state, and notify subscribers. The
 * data tree remounts via the dataKey change in App.jsx.
 *
 * This genuinely clears the endpoint and key — do not restore ENV_URL/ENV_KEY
 * here. A reset that brought back the baked-in build credentials would make
 * the button a no-op, and a following Save would commit an empty stashUrl,
 * sending every request to a path relative to the app.
 */
export function clearSettings() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  state = {
    stashUrl: '',
    stashKey: '',
    previewMuted: true,
    previewsEnabled: true,
    useMock: ENV_MOCK,
    // The documented reset includes appearance — and the document must be
    // re-themed here because clearSettings does not go through setSettings.
    theme: 'standard',
    // `auto` is the safe default on an unknown device: it degrades to the
    // browser without AVPlay, where `browser` would silently disable AVPlay.
    playbackEngine: 'auto',
    // Back to "every section is classic", which is what an absent key means.
    viewModes: {},
    // An empty object, not absent: App reads `gridCols[tab]`, so a missing map
    // crashes the tab-change effect instead of defaulting.
    gridCols: {},
    // Back to "never asked": a reset device should meet the setup screen, not
    // a dead endpoint — the whole reason onboarding exists.
    onboarded: null,
    setupRequested: false,
    hasSavedEndpoint: false,
  };
  applyTheme(state.theme);
  notify();
}