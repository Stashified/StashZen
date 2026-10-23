/**
 * settings.js — Runtime configuration store
 *
 * Persists the Stash endpoint URL, the API key, the Test/Live mode, the
 * preview preferences and the first-run answer to localStorage, so a
 * device is configured once and not again. The build-time env is only
 * the *fallback*, used by a device that has never saved anything: Test
 * only if VITE_USE_MOCK is 'true', otherwise **Live**. The shipped
 * .env.production sets it to false, so a release build a user has never
 * opened Settings on starts Live.
 *
 * Two earlier versions of this comment are worth not repeating. The
 * first claimed a cold start always defaults to Test; it never did. The
 * second claimed the mode was deliberately not persisted — which was
 * true, and was the bug: a Test/Live switch was silently undone by the
 * next launch, and a first-run answer could not survive one either.
 *
 * Components subscribe via the useSettings() hook to re-render when
 * settings change (e.g. user flips Test→Live → grids should refetch).
 *
 * Reads from import.meta.env as the initial fallback so a power user
 * can still preconfigure with a .env file.
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
const ENV_MOCK  = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_USE_MOCK === 'true')

/**
 * The view modes a section may be in. Exported because this is the persisted
 * vocabulary, not a local detail: `viewModes` below stores these strings and
 * the Mode control in ControlsPanel offers them.
 *
 * Enumerated here so a value from storage can be checked against it. A stored
 * mode that is not in this set would otherwise reach App and fall through to
 * the grid — degraded silently, but with the Mode control showing nothing
 * selected, which is the part that makes it worth rejecting at the boundary.
 *
 * **It is declared above `state` below, and that is load-bearing, not
 * tidiness.** `let state = loadFromStorage()` runs at module init and calls
 * `readViewModes`, which reads this. As a `const` it is in the temporal dead
 * zone until its own line executes, so declaring it *after* that call threw
 * `ReferenceError: Cannot access 'VIEW_MODES' before initialization` — but
 * only once a `viewModes` map existed to iterate, i.e. only for a device whose
 * user had actually set a mode. The module threw during import, so a launch
 * showed a blank screen with no first-run and no PIN prompt. Shipped that way
 * in 0.10.0; fixed in 0.10.1 by moving this up. Anything else added here that
 * `loadFromStorage` reaches must be a function declaration or declared above.
 */
export const VIEW_MODES = ['classic', 'carousel', 'coverflow', 'list'];

/**
 * The themes a device may be in. `standard` is the app's Blueprint-derived
 * palette; `oled` turns the page black and lifts only the surfaces that have
 * to stay distinguishable, for panels where black is genuinely off.
 *
 * Same boundary rule as VIEW_MODES: declared above `state`, because
 * `loadFromStorage` validates through it at module init. Anything reachable
 * from that call must be declared here.
 */
export const THEMES = ['standard', 'oled'];

export function readTheme(value) {
  return value === 'oled' ? 'oled' : 'standard';
}

/**
 * Apply the theme to the document root.
 *
 * Called at module init — before React renders — and again whenever the
 * setting changes. Deliberately outside React: main.jsx mounts App *inside*
 * AppLock and FirstRun, and both gates unmount App by design. An effect in App
 * would leave the PIN screen and the first-run screen in the old theme, and
 * flash on unlock. `standard` is the absence of the attribute, so the base
 * `:root` block applies and there is nothing to keep in sync.
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
 * The stored per-section view modes, with anything unrecognised dropped.
 *
 * A sparse map: an absent tab means 'classic'. Keys and values both have to be
 * strings, since the whole point is that this came back from JSON.
 *
 * Exported because it is the boundary this field is validated at, and a
 * boundary that only runs at module init is otherwise reachable only by
 * relaunching — `views-entry.jsx` asserts on it directly rather than
 * re-importing the module to provoke it.
 *
 * That last sentence was the blind spot that let 0.10.0 ship broken.
 * `views-entry.jsx` seeds through `setSettings` *after* the module has
 * initialised, which is not what a relaunch does; `boot-entry.jsx` now covers
 * the real path, writing storage before the first import.
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
 * The stored per-section grid column counts, with anything unrecognised
 * dropped. Same sparse-map contract as readViewModes: an absent tab means the
 * section's own default, so a new section needs no migration.
 *
 * Columns are per section rather than one shared value because the sections
 * are not the same shape: a performer card is 3:4 portrait and a scene card is
 * 16:9, so one column count that suits Scenes makes Performers enormous. The
 * control writes through to this map, so the setting survives a launch and
 * changing columns on one tab leaves the others alone.
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

  // Scenes was split out of Home in 0.15.0 (Home became the showroom). The
  // two per-tab maps already treat an absent tab as "use the default", so this
  // is not a structural migration — it is carrying the user's *choice* over:
  // someone who set Home to Coverflow or six columns should find Scenes that
  // way, not silently reset to Classic/four. Non-destructive: the old `home`
  // keys stay where they are, and a device that never set one migrates
  // nothing.
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
    // On by default as of 0.22.2. The cost is unchanged: a preview only
    // exists for a scene someone has run Stash's Generate → Previews on, and
    // `paths.preview` is a non-empty URL for every scene regardless — so a
    // focused card without one issues a request that fails, which VideoCard
    // learns and stops repeating. That cost used to decide the default. The
    // feature decides it now: a fresh install should see previews without
    // hunting through Settings, and an existing device keeps whatever it has
    // already saved.
    previewsEnabled: saved.previewsEnabled !== undefined ? !!saved.previewsEnabled : true,
    // Persisted as of 0.8.0. The in-memory-only rule it replaces meant the
    // Settings Test/Live switch was forgotten on every launch.
    useMock: saved.useMock !== undefined ? !!saved.useMock : ENV_MOCK,
    // The appearance theme. Standard on every device that has never chosen —
    // an upgrade must not restyle a working TV unasked.
    theme: readTheme(saved.theme),
    // Which playback engine `Auto` means: the TV's native AVPlay pipeline
    // first, with the browser as fallback. `browser` is the rollback lever and
    // reproduces the pre-0.36 player exactly. An unrecognised value falls back
    // to `auto` at this boundary, like every other validated setting.
    playbackEngine: readPlaybackEngine(saved.playbackEngine),
    // Which view each section is in, keyed by tab: { home: 'coverflow' }.
    //
    // A tab that is absent means 'classic', which is deliberate and is why
    // this is a sparse map rather than an entry per section — a new section
    // then needs no migration, and a user who has never opened the Mode
    // dropdown has nothing stored at all. Values are validated on the way in
    // rather than trusted: an unrecognised string would otherwise reach the
    // page and fall through to the grid anyway, but silently, and the mode
    // control would show an empty selection.
    viewModes,
    // Per-section column counts, keyed by tab: { performers: 6 }. Absent means
    // the section default (see gridColsFor in App.jsx).
    gridCols,
    // The first-run answer. null means "never asked", which is what the
    // first-run screen gates on.
    //
    // A device that already has an endpoint or a key saved is inferred to have
    // answered `live`, and that inference is the difference between onboarding
    // being an upgrade and being an interruption: this field did not exist
    // before 0.8.0, so without it every already-configured device — including
    // the one this was developed against — would be shown the setup screen on
    // first launch and asked to re-enter a connection it had working.
    //
    // Only `live` can be inferred. The old build did not persist the mode, so
    // there is nothing recorded here that could mean "sample data".
    onboarded: saved.onboarded === 'live' || saved.onboarded === 'test'
      ? saved.onboarded
      : ((saved.stashUrl || saved.stashKey) ? 'live' : null),
    // Set by Settings' "Run setup again". Kept separate from `onboarded`
    // rather than blanking it, so a re-run can be cancelled with Back and
    // land the user back on the app they were using.
    setupRequested: !!saved.setupRequested,
    // Derived, never persisted: whether this device has ever saved an
    // endpoint. The first-run screen uses it to decide between prefilling
    // the URL field and leaving it empty — `stashUrl` itself is always
    // non-empty, because it falls back to ENV_URL's localhost placeholder,
    // and prefilled localhost on a TV reads as a real address.
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
      // hasSavedEndpoint is deliberately absent — it is derived from the
      // two fields above and would only be able to disagree with them.
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

// The fingerprint of the key the current source string was built from. One
// entry, because only the current key matters; keyed on the secret so a
// changed key is re-hashed rather than re-used.
let keyFingerprint = { key: null, fp: null };

function fingerprint(secret) {
  if (keyFingerprint.key === secret) return keyFingerprint.fp;
  // A short digest, not the secret. Sixteen hex characters is more than
  // enough to tell one credential from another, and it is still a hash, so
  // the string is safe to use as a Map key and to appear in a console log.
  const fp = sha256Hex(String(secret)).slice(0, 16);
  keyFingerprint = { key: secret, fp };
  return fp;
}

/**
 * Identifies the data source the app is currently pointed at.
 *
 * App.jsx uses this as the `key` on <main>, which remounts the data tree on
 * a Test↔Live switch so nothing from the previous source survives. Module
 * scope caches *do* survive that remount, so they use this same string to
 * partition themselves — see listCache.js.
 *
 * The key's *value* is part of the identity, through a digest rather than
 * the secret itself. Presence alone was not enough: rewriting the API key for
 * the same server is exactly what a user does when a token is regenerated,
 * and it left every module-scoped cache — scenes, performers, saved filters —
 * holding the previous credential's answers until the app was relaunched.
 * The digest keeps the secret out of a string that is used as a cache key.
 */
export function dataSourceKey(s = state) {
  return s.useMock ? 'mock' : `live:${s.stashUrl}:${s.stashKey ? `k${fingerprint(s.stashKey)}` : 'nk'}`;
}

export function setSettings(patch) {
  state = { ...state, ...patch };
  // Recomputed rather than set by callers, so it cannot drift from the two
  // fields it is derived from. A connection that has just been saved counts
  // as saved, which is what stops a second visit to the setup screen from
  // clearing a field the user filled in the first time.
  if ('stashUrl' in patch || 'stashKey' in patch) {
    state.hasSavedEndpoint = !!(state.stashUrl || state.stashKey);
  }
  // Every persisted field has to be in this list, or the change appears to
  // work for the rest of the session and is gone on the next launch. That is
  // exactly what happened to `previewsEnabled` before it was added here, and
  // to `useMock` for as long as it was in-memory by design.
  if ('stashUrl' in patch || 'stashKey' in patch || 'previewMuted' in patch
      || 'previewsEnabled' in patch || 'useMock' in patch || 'theme' in patch
      || 'playbackEngine' in patch
      || 'viewModes' in patch || 'gridCols' in patch || 'onboarded' in patch
      || 'setupRequested' in patch) {
    persistToStorage();
  }
  // Applied here rather than by the panel, so every path that changes the
  // theme — Save, clearing saved settings, a future first-run choice — also
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
 * Used by the Settings panel's "Test connection" button.
 *
 * This is the one request that deliberately does NOT go through `runQuery`:
 * it has to test the credentials the user has typed but not yet saved, so it
 * passes `{url, key}` straight to `graphqlRequest` instead. That used to mean
 * re-implementing the transport *and* the whole error-mapping table here; now
 * it only translates the thrown StashError's `code` into the sentence this
 * button shows, which is the part that is genuinely specific to it.
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
    // Any other non-2xx. `{ version { version } }` takes no arguments, so there
    // is no rejected-input detail to preserve here — the status is the whole
    // story.
    if (e?.code === 'http') return { ok: false, reason: `Server returned HTTP ${e.status}.` };
    if (e?.code === 'parse') return { ok: false, reason: 'Server returned invalid JSON.' };
    // 'graphql' | 'timeout' | 'network' | 'config' all carry a message written
    // to be shown to the user as-is.
    return { ok: false, reason: e?.message || 'Cannot reach server. Check the URL.' };
  }

  const v = data?.version?.version;
  if (!v) return { ok: false, reason: 'Unexpected response from server.' };

  return { ok: true, version: v };
}

/**
 * Wipe persisted settings, reset in-memory state, and notify subscribers.
 * The data tree remounts via the dataKey change in App.jsx.
 *
 * This genuinely clears the endpoint and key. It previously restored
 * ENV_URL/ENV_KEY — the credentials baked in at build time — which is the
 * exact opposite of what the button promises, and it hardcoded
 * useMock: true, ignoring ENV_MOCK. Both made the button a no-op in the
 * shipped build while the panel's own fields blanked to '', so a
 * following Save committed stashUrl: '' and every request then went to a
 * path relative to the app.
 */
export function clearSettings() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  state = {
    stashUrl: '',
    stashKey: '',
    previewMuted: true,
    previewsEnabled: true,
    useMock: ENV_MOCK,
    // Clearing saved settings is the documented reset, so appearance resets
    // too — and the document has to be re-themed here because clearSettings
    // does not go through setSettings.
    theme: 'standard',
    // A cleared device is an unknown device, and `auto` is the safe default:
    // it degrades to the browser on any panel without AVPlay. `browser` would
    // silently turn off the native engine on a device that was just reset.
    playbackEngine: 'auto',
    // Back to "every section is classic", which is what an absent key means.
    viewModes: {},
    // …and every section back to its own default column count. This has to be
    // an empty object rather than absent: App reads `gridCols[tab]`, so a
    // missing map is a crash on the tab-change effect, not a default.
    gridCols: {},
    // Back to "never asked" as well. Clearing saved settings is the app's
    // documented reset, and a device that has just been reset should be met
    // by the setup screen rather than dropped onto a dead endpoint — which
    // is the whole reason onboarding exists.
    onboarded: null,
    setupRequested: false,
    hasSavedEndpoint: false,
  };
  applyTheme(state.theme);
  notify();
}