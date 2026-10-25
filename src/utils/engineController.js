/**
 * engineController — the session's memory about playback engines.
 *
 * `enginePolicy.js` is pure and stateless: what to try, in what order. This
 * module holds what the player has *learned* this session and how that
 * changes the answer for the next scene.
 *
 * Four pieces of memory:
 *   1. **Kill switch.** Two engine-level failures on different scenes turn
 *      AVPlay off for the session. Content refusals never count — they are
 *      what the fallback exists for — and repeated transcode failures on one
 *      scene say nothing about the engine. Counting lives in
 *      `createEngineHealth`.
 *   2. **Per-format negative cache for AVPlay.** Remembers `container|video|
 *      audio` so the next scene of a refused format spends no further attempt
 *      (~110–276 ms). Keyed by format, never URL, and only written for
 *      **direct** play: a refused transcode says nothing about the codec
 *      (Stash produced that file).
 *   3. **Matching cache for the browser.** The browser is first under `Auto`,
 *      and its refusals are expensive: an undecodable codec errors in under a
 *      second, but an accepted source that stalls only shows up via the stall
 *      watchdog. Remembering the format sends the next scene straight to
 *      AVPlay. Same key, same direct-only rule; never written when AVPlay is
 *      unavailable, because there would be nothing to skip to.
 *   4. **Why AVPlay is not active**, for the stats panel and failure message;
 *      a silent `Auto` fallback otherwise looks like a bug.
 *
 * ## Why an instance and not module state
 *
 * Create once per player session (a ref inside the player), never a module
 * singleton: module caches survive the `dataKey` remount on server or API-key
 * change, so one server's negative cache would suppress AVPlay on another
 * server's files.
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
   * Why AVPlay is or is not in play for this scene.
   *
   * `setting` is the persisted value, `available` the resolved availability
   * from usePlayerEngine, `video` this scene's codec triple. The checks run in
   * the resolver's order: build flag/setting, session kill switch,
   * availability, then this scene's format. That order matters to the panel —
   * after the kill switch trips, "refused this format" would be true but the
   * wrong explanation for a scene that was never attempted.
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
    // AVPlay is available here, so the browser playing under `Auto` is policy,
    // not a fallback — but still worth noting, or it looks like a
    // browser-only build.
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
     * Record that AVPlay refused this format on a **direct** attempt. Safe
     * with unknown codecs: the key is null and nothing is cached, because
     * "unknown format" must not become a blanket refusal.
     */
    refusedDirect(video) {
      const key = keyOf(video);
      if (key != null) refusedFormats.add(key);
    },

    /**
     * True when the browser failed this format directly earlier this session,
     * so AVPlay should be asked first. Callers must also check availability —
     * skipping the browser with nowhere to go is an unasked-for transcode.
     */
    browserBlockedFormat(video) {
      const key = keyOf(video);
      return key != null && browserRefusedFormats.has(key);
    },

    /**
     * Record a browser refusal of a **direct** attempt: a media error the
     * element could not decode (3 or 4). Not for a watchdog stall (a slow
     * start is not a format verdict), transcode failures (Stash produced that
     * file) or network errors.
     */
    browserRefused(video) {
      const key = keyOf(video);
      if (key != null) browserRefusedFormats.add(key);
    },

    /**
     * Record a failure. Only `level === 'engine'` counts toward the kill
     * switch; `content` is what the per-format cache and fallback are for.
     * Returns true when this failure disabled AVPlay, so the caller surfaces
     * the reason once rather than on every later scene.
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
