/**
 * engineController — the session's memory about playback engines.
 *
 * `enginePolicy.js` answers "what should be tried, in what order" for a scene.
 * It is pure and stateless. This module is the other half: what the player has
 * *learned* during this session, and how that changes the answer for the next
 * scene.
 *
 * Four pieces of memory, each with a different lifetime and a different job:
 *
 *   1. **The kill switch.** Two engine-level failures on different scenes turn
 *      AVPlay off for the rest of the session. Content refusals never count —
 *      those are what the fallback exists for — and one scene's transcodes
 *      failing repeatedly says nothing about the engine. See
 *      `createEngineHealth` in enginePolicy.js for the counting rule.
 *
 *   2. **The per-format negative cache for AVPlay.** AVPlay refusing a file is
 *      normally content-level: one codec it cannot decode. The cache remembers
 *      `container|video|audio` so the next scene of that format does not spend
 *      another attempt (and another ~110–276 ms) being refused. It is keyed by
 *      the format, never by the URL, and it is only ever written for **direct**
 *      play. A refused transcode says nothing about the codec — Stash produced
 *      that file — so caching it would skip AVPlay on a format it plays fine
 *      when handed the original.
 *
 *   3. **The matching cache for the browser.** The browser is first under
 *      `Auto`, and its refusals are the expensive kind: a codec it cannot
 *      decode usually errors in under a second, but a source it accepts and
 *      sits on only reveals itself to the stall watchdog. Either way the
 *      format is remembered, so the second scene of that format goes straight
 *      to AVPlay instead of paying the watchdog again. Same key, same
 *      direct-only rule — and never written when AVPlay is not available,
 *      because there would be nothing better to skip to.
 *
 *   4. **The reason AVPlay is not active**, for the stats panel and the failure
 *      message. `Auto` silently falling back is indistinguishable from a bug
 *      unless the panel says why.
 *
 * ## Why an instance and not module state
 *
 * This must be created once per player session (a ref inside the player), not
 * exported as a module singleton. Module-level caches survive the `dataKey`
 * remount the app uses when the server or API key changes, and a negative
 * cache from one Stash server's library would then suppress AVPlay on another
 * server's files. The lifetime should match the session it describes.
 */

import { createEngineHealth, readPlaybackEngine } from './enginePolicy.js';
import { avplayFormatKey } from './avplayErrors.js';

/** The stable codes the UI switches on. Text lives in `describeEngine`. */
export const ENGINE_STATUS = {
  ACTIVE: 'active',
  BROWSER_FIRST: 'browser-first',
  BROWSER_SETTING: 'browser-setting',
  FORCED_BROWSER: 'forced-browser',
  UNAVAILABLE: 'unavailable',
  KILL_SWITCH: 'kill-switch',
  FORMAT_REFUSED: 'format-refused',
};

const STATUS_TEXT = {
  [ENGINE_STATUS.ACTIVE]: 'AVPlay',
  [ENGINE_STATUS.BROWSER_FIRST]: 'Browser player (first choice)',
  [ENGINE_STATUS.BROWSER_SETTING]: 'Browser player (set in Settings)',
  [ENGINE_STATUS.FORCED_BROWSER]: 'Browser player (forced by this build)',
  [ENGINE_STATUS.UNAVAILABLE]: 'Browser player (AVPlay unavailable on this TV)',
  [ENGINE_STATUS.KILL_SWITCH]: 'Browser player (AVPlay paused after repeated errors)',
  [ENGINE_STATUS.FORMAT_REFUSED]: 'Browser player (AVPlay refused this format earlier)',
};

export function describeEngine(status) {
  return STATUS_TEXT[status] || STATUS_TEXT[ENGINE_STATUS.ACTIVE];
}

/**
 * The same reason as a clause, for a line that already names the engine:
 * `Player: Browser · set in Settings`. Empty for the active engine, because
 * "AVPlay · AVPlay" is not information.
 */
const STATUS_NOTE = {
  [ENGINE_STATUS.ACTIVE]: '',
  [ENGINE_STATUS.BROWSER_FIRST]: 'browser first',
  [ENGINE_STATUS.BROWSER_SETTING]: 'set in Settings',
  [ENGINE_STATUS.FORCED_BROWSER]: 'forced by this build',
  [ENGINE_STATUS.UNAVAILABLE]: 'AVPlay unavailable',
  [ENGINE_STATUS.KILL_SWITCH]: 'AVPlay paused after errors',
  [ENGINE_STATUS.FORMAT_REFUSED]: 'AVPlay refused this format',
};

export function engineNoteFor(status) {
  return STATUS_NOTE[status] ?? '';
}

export function createEngineController({ healthLimit = 2 } = {}) {
  const health = createEngineHealth({ limit: healthLimit });
  const refusedFormats = new Set();
  const browserRefusedFormats = new Set();

  // `avplayFormatKey` destructures its argument, so a nullable video has to be
  // answered before it is called rather than by it.
  const keyOf = (video) => (video ? avplayFormatKey(video) : null);

  /**
   * Why AVPlay is or is not in play right now, for this scene.
   *
   * `setting` is already the persisted value; `available` is the resolved
   * availability question from usePlayerEngine; `video` is this scene's codec
   * triple, so the per-format cache can explain a scene that never reached
   * AVPlay. The order is the order the resolver itself applies: a build flag
   * or the setting overrides everything, then the session kill switch, then
   * availability, and only then this scene's format. That order matters to
   * the panel: after the kill switch trips, "refused this format" would be a
   * true sentence about a scene that was never attempted, and the wrong
   * explanation for why.
   */
  function status({
    setting = 'auto', available = false, forcedBrowser = false, video = null,
  } = {}) {
    const mode = readPlaybackEngine(setting);
    if (forcedBrowser) return ENGINE_STATUS.FORCED_BROWSER;
    if (mode === 'browser') return ENGINE_STATUS.BROWSER_SETTING;
    if (health.disabled()) return ENGINE_STATUS.KILL_SWITCH;
    if (!available) return ENGINE_STATUS.UNAVAILABLE;
    const key = keyOf(video);
    if (key != null && refusedFormats.has(key)) return ENGINE_STATUS.FORMAT_REFUSED;
    // `Auto` reaches here with AVPlay available and no reason to skip it, so
    // the browser being the one playing is the policy, not a fallback. That is
    // still information — without the note the user cannot tell this apart
    // from a browser-only build.
    return mode === 'auto' ? ENGINE_STATUS.BROWSER_FIRST : ENGINE_STATUS.ACTIVE;
  }

  return {
    status,

    /** True when this format was refused directly and should skip AVPlay. */
    blockedFormat(video) {
      const key = keyOf(video);
      return key != null && refusedFormats.has(key);
    },

    /**
     * Record that AVPlay refused this format on a **direct** attempt. Safe to
     * call with a video whose codecs are unknown: `avplayFormatKey` returns
     * null and nothing is cached, because "unknown format" must not become a
     * blanket refusal.
     */
    refusedDirect(video) {
      const key = keyOf(video);
      if (key != null) refusedFormats.add(key);
    },

    /**
     * True when the browser failed this format directly earlier in the
     * session, so the resident AVPlay should be asked before it is. Callers
     * must also check that AVPlay is available — skipping the browser with
     * nowhere to go is a transcode the user did not ask for.
     */
    browserBlockedFormat(video) {
      const key = keyOf(video);
      return key != null && browserRefusedFormats.has(key);
    },

    /**
     * Record a browser refusal of a **direct** attempt: a media error whose
     * source the element could not decode, or a stall the watchdog gave up on.
     * Not for transcode failures (Stash produced that file) and not for
     * network errors, which say nothing about the format.
     */
    browserRefused(video) {
      const key = keyOf(video);
      if (key != null) browserRefusedFormats.add(key);
    },

    /**
     * Record a failure. Only `level === 'engine'` counts toward the kill
     * switch; `content` is what the per-format cache and the fallback are for.
     * Returns true when this failure disabled AVPlay — the caller surfaces the
     * reason once, rather than on every later scene.
     */
    fail({ sceneId, level = 'content', reason = 'engine error' } = {}) {
      if (level !== 'engine') return false;
      return health.fail(sceneId, reason);
    },

    /** A prepare that produced a frame clears the engine-failure count. */
    succeed() {
      health.succeed();
    },

    /** The human sentence for the stats panel, from the status's code. */
    reasonText(opts) {
      return describeEngine(status(opts));
    },

    /** For tests and diagnostics; the caches are otherwise write-only. */
    refusedFormatKeys() {
      return [...refusedFormats];
    },

    browserRefusedFormatKeys() {
      return [...browserRefusedFormats];
    },

    isDisabled() {
      return health.disabled();
    },
  };
}
