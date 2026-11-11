/**
 * settings.js: runtime configuration store.
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

import { useSyncExternalStore } from 'react';
import { graphqlRequest } from './stashClient.js';
import { sha256Hex } from './sha256.js';
import { readPlaybackEngine } from './enginePolicy.js';
import { noteSourceChanged } from './connectionHealth.js';

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
 * Called at module init, before React renders, and on every change.
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

/**
 * How far one seek press moves. `adaptive` is the YouTube-style ladder; a
 * number is a fixed step, for people who would rather press the same distance
 * every time. The settings toggle renders this list and the storage validator
 * reads it, so the two cannot drift.
 *
 * Declared above `state` like the other validated vocabularies, because
 * `loadFromStorage` reaches it at module init.
 */
export const SEEK_STEP_OPTIONS = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 5, label: '5 s' },
  { value: 10, label: '10 s' },
  { value: 15, label: '15 s' },
  { value: 30, label: '30 s' },
];

export function readSeekStep(value) {
  if (value === 'adaptive') return 'adaptive';
  const n = Number(value);
  return SEEK_STEP_OPTIONS.some(o => o.value === n) ? n : 'adaptive';
}

/**
 * Which transcode tier to ask Stash for when a scene cannot play directly.
 * `original` keeps the old behaviour: the source resolution, no downscale.
 *
 * Same boundary rule as SEEK_STEP_OPTIONS: declared above `state`, because
 * `loadFromStorage` validates through it at module init.
 */
export const TRANSCODE_QUALITY_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'standard', label: 'Standard' },
  { value: 'low', label: 'Low' },
];

export function readTranscodeQuality(value) {
  return TRANSCODE_QUALITY_OPTIONS.some(o => o.value === value) ? value : 'original';
}

/**
 * Apply Reduce motion to the document root, same module-init placement and
 * reasoning as applyTheme: the PIN and first-run screens are outside App and
 * must already be still. CSS keys off the attribute.
 */
export function applyReduceMotion(on) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (on) el.dataset.reduceMotion = '';
  else delete el.dataset.reduceMotion;
}

/**
 * How many search terms the Search tab remembers. Enough for a session's
 * exploring, few enough for one row on a 10-foot screen.
 *
 * Above `state`: module init reads it through `readRecentSearches`, so a
 * `const` below would be in its TDZ.
 */
export const RECENT_SEARCH_LIMIT = 8;

// ── In-memory state ──────────────────────────────────────
let state = loadFromStorage();
applyTheme(state.theme);
applyReduceMotion(state.reduceMotion);

/**
 * The stored per-section view modes, with unrecognised values dropped.
 *
 * A sparse map: an absent tab means the section's `defaultMode`, else
 * 'classic'. Keys and values must be strings,
 * since this came back from JSON. Exported because it is the validation
 * boundary, `views-entry.jsx` asserts on it directly, while `boot-entry.jsx`
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
 * The stored search history, oldest entries and junk dropped. Case-insensitive
 * duplicates collapse: "Jane" and "jane" are one search to a person, and the
 * newer spelling wins.
 *
 * Its limit sits above `state` because module init reaches this.
 */
export function readRecentSearches(saved) {
  if (!Array.isArray(saved)) return [];
  const out = [];
  for (const value of saved) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || text.length > 120) continue;
    if (out.some(s => s.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length >= RECENT_SEARCH_LIMIT) break;
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

/**
 * The first-run answer; null means "never asked", which the setup screen gates
 * on. A device with an endpoint or key already saved is inferred to have
 * answered `live`, without that, every configured device would be asked to
 * re-enter a working connection. Only `live` can be inferred: nothing recorded
 * could mean "sample data".
 *
 * Shared by load and patch so a live write and the next relaunch agree.
 */
export function readOnboarded(saved) {
  if (saved?.onboarded === 'live' || saved?.onboarded === 'test') return saved.onboarded;
  // An explicit null means "never asked" (what clearSettings writes and what
  // the setup screen gates on), not an invalid answer to infer over.
  if (saved?.onboarded === null) return null;
  return (saved?.stashUrl || saved?.stashKey) ? 'live' : null;
}

function loadFromStorage() {
  let saved = {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (e) {
    // Corrupt or unavailable storage, ignore, fall back to env
  }

  // Scenes was split out of Home. Absent tabs already mean "use the default",
  // so this only carries the user's *choice* over: Home's mode and column
  // count become Scenes'. Non-destructive, the old `home` keys stay.
  const viewModes = readViewModes(saved.viewModes);
  const gridCols = readGridCols(saved.gridCols);
  if (viewModes.scenes === undefined && viewModes.home !== undefined) {
    viewModes.scenes = viewModes.home;
  }
  if (gridCols.scenes === undefined && gridCols.home !== undefined) {
    gridCols.scenes = gridCols.home;
  }

  return {
    // A saved empty string is a decision ("this device has no key") and must
    // not resurrect the build's baked credentials. Only a value never saved
    // falls back to env.
    stashUrl: typeof saved.stashUrl === 'string' ? saved.stashUrl : ENV_URL,
    stashKey: typeof saved.stashKey === 'string' ? saved.stashKey : ENV_KEY,
    // Preview mute is per-device user preference; persists.
    previewMuted: saved.previewMuted !== undefined ? !!saved.previewMuted : true,
    // On by default: a fresh install should see previews without hunting
    // through Settings. The cost is that `paths.preview` is non-empty even for
    // scenes never generated, so a focused card issues a request that fails;
    // VideoCard learns and stops repeating. An existing device keeps its value.
    previewsEnabled: saved.previewsEnabled !== undefined ? !!saved.previewsEnabled : true,
    // Persisted, or the Test/Live switch would be forgotten on every launch.
    useMock: saved.useMock !== undefined ? !!saved.useMock : ENV_MOCK,
    // The appearance theme. Standard on every device that has never chosen:
    // an upgrade must not restyle a working TV unasked.
    theme: readTheme(saved.theme),
    // Animation and preview autoplay are opt-out: a TV that has never chosen
    // keeps the motion it shipped with.
    reduceMotion: !!saved.reduceMotion,
    // Adaptive is the existing tap-5s-hold-to-climb behaviour.
    seekStep: readSeekStep(saved.seekStep),
    // Which tier a transcode asks for. Original on a device that has never
    // chosen: an upgrade must not start downscaling unasked.
    transcodeQuality: readTranscodeQuality(saved.transcodeQuality),
    // Which engine `Auto` means: the browser first, AVPlay as fallback.
    // `browser` is the rollback lever (the old browser-only player). An
    // unrecognised value falls back to `auto`, like every validated setting.
    playbackEngine: readPlaybackEngine(saved.playbackEngine),
    // Which view each section is in, keyed by tab: { scenes: 'coverflow' }.
    // Absent means the section's default (Tags and Studios open as lists),
    // a sparse map so a new section needs no migration. Values are validated
    // on the way in, not trusted.
    viewModes,
    // Per-section column counts, keyed by tab: { performers: 6 }. Absent means
    // the section default (see gridColsFor in App.jsx).
    gridCols,
    // The Search tab's history, newest first. Recorded when a search is
    // committed or a result is opened, never on every keystroke.
    recentSearches: readRecentSearches(saved.recentSearches),
    // See readOnboarded.
    onboarded: readOnboarded(saved),
    // Set by "Run setup again". Separate from `onboarded` rather than blanking
    // it, so Back can cancel a re-run and return to the running app.
    setupRequested: !!saved.setupRequested,
    // Public-build update check. Off on every device that has never opted in;
    // the timestamp is written after every attempt, success or failure.
    updateCheckEnabled: saved.updateCheckEnabled !== undefined ? !!saved.updateCheckEnabled : false,
    lastUpdateCheckAt: Number.isFinite(saved.lastUpdateCheckAt) ? saved.lastUpdateCheckAt : 0,
    updateLatestVersion: typeof saved.updateLatestVersion === 'string' ? saved.updateLatestVersion : '',
    // Derived, never persisted: has this device ever saved an endpoint? The
    // setup screen prefills the URL only if so, `stashUrl` always falls back
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
      reduceMotion: state.reduceMotion,
      seekStep: state.seekStep,
      transcodeQuality: state.transcodeQuality,
      playbackEngine: state.playbackEngine,
      viewModes: state.viewModes,
      gridCols: state.gridCols,
      recentSearches: state.recentSearches,
      onboarded: state.onboarded,
      setupRequested: state.setupRequested,
      updateCheckEnabled: state.updateCheckEnabled,
      lastUpdateCheckAt: state.lastUpdateCheckAt,
      updateLatestVersion: state.updateLatestVersion,
      // hasSavedEndpoint is deliberately absent, derived, so it could only
      // disagree with the two fields above.
    }));
  } catch (e) {
    // Storage full / disabled, fail silently, runtime state still works
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
 * themselves with this same string, see listCache.js.
 *
 * The key's *value* is part of the identity, via a digest rather than the
 * secret itself: regenerating a token for the same server must not leave
 * module caches holding the previous credential's answers. The digest keeps
 * the secret out of a cache key.
 */
export function dataSourceKey(s = state) {
  return s.useMock ? 'mock' : `live:${s.stashUrl}:${s.stashKey ? `k${fingerprint(s.stashKey)}` : 'nk'}`;
}

/**
 * Run a patch through the same boundary `loadFromStorage` uses.
 *
 * Without this, `{ theme: 'dark' }` or `{ seekStep: 7 }` entered live state,
 * was persisted, and only snapped back on the next launch, so the UI and the
 * store disagreed in between. `undefined` is dropped rather than merged: a
 * stray `{ theme: undefined }` must not wipe a setting.
 */
function normalizePatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    switch (key) {
      case 'theme': out.theme = readTheme(value); break;
      case 'viewModes': out.viewModes = readViewModes(value); break;
      case 'gridCols': out.gridCols = readGridCols(value); break;
      case 'seekStep': out.seekStep = readSeekStep(value); break;
      case 'transcodeQuality': out.transcodeQuality = readTranscodeQuality(value); break;
      case 'playbackEngine': out.playbackEngine = readPlaybackEngine(value); break;
      case 'recentSearches': out.recentSearches = readRecentSearches(value); break;
      case 'stashUrl':
      case 'stashKey':
        if (typeof value === 'string') out[key] = value;
        break;
      case 'updateLatestVersion':
        if (typeof value === 'string') out.updateLatestVersion = value;
        break;
      case 'lastUpdateCheckAt':
        out.lastUpdateCheckAt = Number.isFinite(value) ? value : 0;
        break;
      case 'onboarded':
        // Finished in setSettings, after the merge: the inference needs the
        // endpoint from the same patch.
        break;
      case 'previewMuted':
      case 'previewsEnabled':
      case 'useMock':
      case 'reduceMotion':
      case 'setupRequested':
      case 'updateCheckEnabled':
        out[key] = !!value;
        break;
      case 'hasSavedEndpoint':
        // Derived, so a caller cannot make it contradict the endpoint.
        break;
      default:
        // Unknown keys keep the old pass-through behaviour; they are not part
        // of the persisted contract and `persistToStorage` ignores them.
        out[key] = value;
    }
  }
  return out;
}

export function setSettings(patch) {
  const before = dataSourceKey(state);
  state = { ...state, ...normalizePatch(patch) };
  // A new source retires every answer still in flight. Done here, not in an
  // effect: the new source's first requests start from child effects, before
  // App's effects run, and they would carry the old number.
  if (dataSourceKey(state) !== before) noteSourceChanged();
  // Recomputed when its sources are written: derived, never set by callers, so
  // it cannot drift. Only a string in the patch counts, or a rejected value
  // would derive from the env fallback. A just-saved connection counts as
  // saved, so revisiting setup does not clear a field already filled.
  const urlPatch = typeof patch?.stashUrl === 'string' ? patch.stashUrl : undefined;
  const keyPatch = typeof patch?.stashKey === 'string' ? patch.stashKey : undefined;
  if (urlPatch !== undefined || keyPatch !== undefined) {
    state.hasSavedEndpoint = !!(state.stashUrl || state.stashKey);
  }
  // Same inference as loadFromStorage, run when the answer is written, so this
  // session and the next launch agree. An endpoint-only patch needs no run: the
  // current answer is already the one readOnboarded would derive again. An
  // explicit null or a `test` answer is kept; only an invalid value is inferred
  // over.
  if (patch?.onboarded !== undefined) {
    state.onboarded = readOnboarded({
      onboarded: patch.onboarded,
      stashUrl: state.stashUrl,
      stashKey: state.stashKey,
    });
  }
  // Every persisted field must be in this list, or a change works for the
  // session and vanishes on the next launch.
  if ('stashUrl' in patch || 'stashKey' in patch || 'previewMuted' in patch
      || 'previewsEnabled' in patch || 'useMock' in patch || 'theme' in patch
      || 'reduceMotion' in patch || 'seekStep' in patch
      || 'transcodeQuality' in patch
      || 'playbackEngine' in patch
      || 'viewModes' in patch || 'gridCols' in patch || 'recentSearches' in patch
      || 'onboarded' in patch
      || 'setupRequested' in patch || 'updateCheckEnabled' in patch
      || 'lastUpdateCheckAt' in patch || 'updateLatestVersion' in patch) {
    persistToStorage();
  }
  // Applied here, not by the panel, so every path that changes the theme also
  // re-themes the document.
  if ('theme' in patch) applyTheme(state.theme);
  if ('reduceMotion' in patch) applyReduceMotion(state.reduceMotion);
  notify();
}

export function subscribeSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * React hook, returns the current settings and re-renders on change.
 */
export function useSettings() {
  // Not state + effect: a setSettings between render and subscribe would be
  // missed until the next change.
  return useSyncExternalStore(subscribeSettings, () => state);
}

// The part of the settings a preview card draws from, in a snapshot that only
// changes when one of those values does. `useSettings` returns `state` itself,
// so every one of the 40 subscribers re-renders on any write, including the
// update check's `lastUpdateCheckAt` while the grid is on screen. Comparing a
// stable object instead lets `useSyncExternalStore` skip those renders.
let previewSnapshot = null;

function getPreviewSnapshot() {
  const key = `${state.previewsEnabled}|${state.previewMuted}|${state.reduceMotion}`
    + `|${state.useMock}|${dataSourceKey(state)}`;
  if (previewSnapshot?.key !== key) {
    previewSnapshot = {
      key,
      previewsEnabled: state.previewsEnabled,
      previewMuted: state.previewMuted,
      reduceMotion: state.reduceMotion,
      useMock: state.useMock,
      source: dataSourceKey(state),
    };
  }
  return previewSnapshot;
}

/** Per-card preview settings; see `getPreviewSnapshot` for why it is narrow. */
export function usePreviewSettings() {
  return useSyncExternalStore(subscribeSettings, getPreviewSnapshot);
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
    if (e?.code === 'http' && e.status === 401) {
      return { ok: false, reason: 'Authentication failed. Check the API key.' };
    }
    // Stash 0.32 rejects requests from public IPs with 403 unless the address
    // is whitelisted, so this is not the same failure as a bad key (401).
    if (e?.code === 'http' && e.status === 403) {
      return {
        ok: false,
        reason: 'Server refused the request (HTTP 403). Stash 0.32+ blocks public-IP access unless configured; if the address is a LAN address, check the API key.',
      };
    }
    // Any other non-2xx. `{ version { version } }` takes no arguments, so the
    // status is the whole story, there is no rejected-input detail.
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
 * This genuinely clears the endpoint and key, do not restore ENV_URL/ENV_KEY
 * here. A reset that brought back the baked-in build credentials would make
 * the button a no-op, and a following Save would commit an empty stashUrl,
 * sending every request to a path relative to the app.
 *
 * The reset is *written*, not just the storage removed: an absent record means
 * "never saved" and falls back to env, which is the same resurrection by
 * another route. Persisting the empty strings makes the cleared state survive
 * a relaunch.
 */
export function clearSettings() {
  const before = dataSourceKey(state);
  state = {
    stashUrl: '',
    stashKey: '',
    previewMuted: true,
    previewsEnabled: true,
    useMock: ENV_MOCK,
    // The documented reset includes appearance, and the document must be
    // re-themed here because clearSettings does not go through setSettings.
    theme: 'standard',
    reduceMotion: false,
    seekStep: 'adaptive',
    transcodeQuality: 'original',
    // `auto` is the safe default on an unknown device: it degrades to the
    // browser without AVPlay, where `browser` would silently disable AVPlay.
    playbackEngine: 'auto',
    // Back to "every section is classic", which is what an absent key means.
    viewModes: {},
    // An empty object, not absent: App reads `gridCols[tab]`, so a missing map
    // crashes the tab-change effect instead of defaulting.
    gridCols: {},
    recentSearches: [],
    // Back to "never asked": a reset device should meet the setup screen, not
    // a dead endpoint, the whole reason onboarding exists.
    onboarded: null,
    setupRequested: false,
    updateCheckEnabled: false,
    lastUpdateCheckAt: 0,
    updateLatestVersion: '',
    hasSavedEndpoint: false,
  };
  // A reset goes to an empty endpoint, and App may be about to unmount for
  // the setup screen, so the old source's verdict must not survive here.
  if (dataSourceKey(state) !== before) noteSourceChanged();
  applyTheme(state.theme);
  applyReduceMotion(state.reduceMotion);
  persistToStorage();
  notify();
}