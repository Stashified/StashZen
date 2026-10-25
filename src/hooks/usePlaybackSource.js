/**
 * usePlaybackSource — which URL the <video> gets, and what to do when it does
 * not work.
 *
 * A `<video>` element decodes a narrower set than the TV's own pipeline, so a
 * scene that plays in Stash's web UI or VLC can be one this app refuses with
 * no explanation. See playbackSource.js for the measured codec census.
 *
 * **An ordered candidate list per scene, each tried only if the one before it
 * failed**: `needsTranscode(video)` puts the transcoded endpoints first (HLS,
 * then MP4, then WebM) with the direct file as the net; otherwise the direct
 * file goes first and a transcode is the fallback. Only the first transcode is
 * resolved unless a format does not play.
 *
 * Either order can be wrong, which is why both halves exist: a codec list
 * cannot be complete, and the failure being fixed is a TV *silently* refusing
 * a file. The reactive half is the safety net; the list is only an
 * optimisation saving a request and encode for known-bad codecs.
 *
 * **Two failure signals, because a refused codec does not always raise one.**
 * A source the engine can identify but not decode fires `error`; one it accepts
 * and sits on raises nothing and spins forever. So the `error` handler calls
 * `reportFailure()`, and each attempt also arms a stall watchdog, cleared by
 * `loadedmetadata`/`canplay`/`playing` so a slow buffer keeps its spinner.
 *
 * Returns:
 *   src          the URL for the element, or null while a transcode is being
 *                resolved (the poster and spinner cover that gap)
 *   sourceKind   `direct` or `transcode`, or null while nothing is resolved.
 *                Derived here, because only the candidate that yielded it knows
 *                whether the server is re-encoding.
 *   exhausted    every candidate has been tried and none loaded
 *   reportFailure()  a media error — true if another candidate is being tried,
 *                false if there is none (the caller shows the failure)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSceneStreams } from '../utils/videoService.js';
import { pickTranscodeUrls } from '../utils/playbackSource.js';
import { buildCandidatePlan } from '../utils/enginePolicy.js';
import { createEngineController } from '../utils/engineController.js';

// How long an attempt may sit below HAVE_METADATA before it is judged dead: a
// LAN direct stream reports metadata well under a second, a transcode about a
// second. Generous because a stall costs the user time but switching early
// wastes a transcode — which still plays.
const STALL_MS = 10000;

// Under `Auto` the browser is first and AVPlay is a real second opinion: a
// browser that refuses fires `error` quickly, one that accepts and sits shows
// up only here. When a working AVPlay follows, four seconds is enough; elsewhere
// keeps the generous 10 s, since a transcode takes longer and there is nothing
// better to switch to.
const BROWSER_DIRECT_STALL_MS = 4000;

export function usePlaybackSource(video, mediaRef, {
  setting = 'auto',
  forcedBrowser = false,
  avplayAvailable = false,
  ready = true,
} = {}) {
  const sceneId = video?.id ?? null;
  const directUrl = video?.stream ?? null;

  // The session's engine memory — the kill switch and the per-format negative
  // cache. One instance for the life of the player: what one scene teaches
  // survives a queue advance, nothing survives the player.
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createEngineController();
  const controller = controllerRef.current;

  // The codec fields as a stable set for the policy and format cache. A memo of
  // primitives, not the queue object: that hands over a fresh identity, and
  // re-planning would restart playback.
  const sceneMeta = useMemo(() => ({
    id: sceneId,
    stream: directUrl,
    container: video?.container,
    videoCodec: video?.videoCodec,
    audioCodec: video?.audioCodec,
    // Part of the negative-cache key: a panel can refuse one resolution of a
    // codec and play another. Hand-built queue rows may not carry it.
    width: video?.width,
    height: video?.height,
  }), [
    sceneId, directUrl, video?.container, video?.videoCodec, video?.audioCodec,
    video?.width, video?.height,
  ]);

  const [src, setSrc] = useState(null);
  // Which half of the plan produced `src`. The player uses this to say whether
  // the server is re-encoding — a URL comparison would be an inference and
  // would drift.
  const [sourceKind, setSourceKind] = useState(null);
  // Which engine owns the source: one URL can belong to either, and the player
  // re-arms on `engine + ':' + src`. `null` means the browser path, so the
  // <video> exists before a source does.
  const [engine, setEngine] = useState(null);
  // Which scene the exhaustion belongs to, not a bare boolean: on the commit
  // that advances the queue the effect has not run, so a plain flag is still
  // the previous scene's answer for one render — when the error effect runs.
  // Naming the scene derives the answer against the scene on screen.
  const [exhaustedScene, setExhaustedScene] = useState(null);

  // The active plan, replaced wholesale per scene. Continuations compare
  // identity first, so a stale sceneStreams answer cannot set another's source.
  const planRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed, not just cleared: StrictMode's simulated unmount would leave the
    // latch false and every `runFrom` continuation bails, leaving the poster up
    // forever in dev.
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /**
   * Walk the plan from wherever it got to, until a candidate yields a URL.
   *
   * A loop rather than "set the first, react to failure": a candidate can come
   * back empty without anything failing (a server with transcoding disabled
   * returns no endpoints), and that must fall through immediately.
   */
  const runFrom = useCallback(async (plan) => {
    while (plan.index < plan.sources.length) {
      const candidate = plan.sources[plan.index++];
      // What the session learned can invalidate a candidate mid-walk: an engine
      // failure on the previous scene trips the kill switch, a refused format
      // skips AVPlay's direct attempt.
      if (candidate.engine === 'avplay'
        && (controller.isDisabled()
          || (candidate.kind === 'direct' && controller.blockedFormat(plan.video)))) {
        continue;
      }
      // The mirror image: this format's direct file already failed in the
      // browser this session, and a resident engine can take it. Skipping costs
      // nothing if wrong — the browser is last in the plan.
      if (candidate.engine === 'html5' && candidate.kind === 'direct'
        && plan.avplayAvailable && !controller.isDisabled()
        && controller.browserBlockedFormat(plan.video)) {
        continue;
      }
      // A media `error` in this window belongs to the source that just failed,
      // not the untried one — see reportFailure. Set inside the loop so an
      // empty resolve keeps the guard up while the next is fetched.
      plan.pending = true;

      // A candidate that throws is a failed candidate, not an error to
      // propagate — the loop is the "try the next" path.
      const url = await candidate.make().catch(() => null);
      if (planRef.current !== plan || !mountedRef.current) return;

      // A candidate may stand for several: the transcodes are one lazy fetch
      // yielding an ordered list (HLS, MP4, WebM), spliced open here so the
      // walk can resume at the second format without asking the server again.
      if (Array.isArray(url)) {
        plan.sources.splice(
          plan.index, 0,
          ...url.map((u) => ({
            kind: candidate.kind,
            engine: candidate.engine,
            make: async () => u,
          })),
        );
        continue;
      }

      if (!url) continue;

      plan.pending = false;
      // Which candidate owns the source now. A later failure has to be
      // attributed to this engine and kind, not to the plan's first choice.
      plan.active = { engine: candidate.engine || 'html5', kind: candidate.kind };
      setSrc(url);
      setSourceKind(candidate.kind);
      setEngine(candidate.engine || 'html5');

      clearTimer();
      const browserDirect = plan.avplayAvailable
        && candidate.engine === 'html5' && candidate.kind === 'direct';
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (planRef.current !== plan || !mountedRef.current) return;
        // HAVE_METADATA or beyond means this file *is* loading; a stall after
        // that is buffering, which the player's own spinner already reports
        // honestly, and re-sourcing would be a lie about what went wrong.
        const el = mediaRef.current;
        if (el && el.readyState >= 1) return;
        // Move on, but record no verdict: no metadata in four seconds does not
        // mean the format was refused — a moov-at-the-end MP4, a spinning-up
        // NAS or a dropped LAN all stall. A cached verdict would exile the
        // format for the session; only the element's own error is evidence.
        void runFrom(plan);
      }, browserDirect ? BROWSER_DIRECT_STALL_MS : STALL_MS);
      return;
    }
    plan.pending = false;
    setExhaustedScene(plan.sceneId);
  }, [clearTimer, mediaRef, controller]);

  const reportFailure = useCallback(() => {
    const plan = planRef.current;
    if (!plan) return false;

    // Learn before walking on. AVPlay classifies what it saw (avplayErrors.js):
    // a *content* refusal on a direct attempt is cached per codec triple; an
    // *engine* fault counts toward the kill switch. A refused transcode is
    // never cached — Stash produced that file.
    const active = plan.active;
    const failure = mediaRef.current?.lastFailure;
    if (active?.engine === 'avplay' && failure) {
      if (failure.level === 'engine') {
        controller.fail({ sceneId: plan.sceneId, level: 'engine', reason: failure.phase });
      } else if (failure.level !== 'transient' && active.kind === 'direct') {
        // A *transient* failure is the seek coalescer giving up: the scene moves
        // to the browser at the requested position, but that says nothing about
        // the format, so the next scene must still try AVPlay.
        controller.refusedDirect(plan.video);
      }
    } else if (active?.engine === 'html5' && active.kind === 'direct'
      && plan.avplayAvailable) {
      // 3 = DECODE_ERR, 4 = SRC_NOT_SUPPORTED: the element looked and could not
      // use it. 2 = NETWORK_ERR says nothing about the format, and caching it
      // would exile a codec for the session over a dropped LAN.
      const code = mediaRef.current?.error?.code;
      if (code === 3 || code === 4) controller.browserRefused(plan.video);
    }

    // A second `error` while the next candidate is resolving must not read as
    // "nothing left to try": `index` has moved past the failed candidate, so
    // the old check saw the plan exhausted and put the failure overlay over a
    // transcode about to play.
    if (plan.pending) return true;
    plan.active = null;
    if (plan.index >= plan.sources.length) return false;
    clearTimer();
    void runFrom(plan);
    return true;
  }, [clearTimer, runFrom, mediaRef, controller]);

  // ── The plan for this scene ────────────────────────────────
  useEffect(() => {
    const plan = {
      index: 0,
      sources: [],
      sceneId,
      video: sceneMeta,
      pending: false,
      active: null,
      // Snapshotted with the plan: the watchdog's length and the browser cache
      // skip both depend on whether a fallback engine exists at all.
      avplayAvailable: false,
    };
    planRef.current = plan;
    clearTimer();
    setSrc(null);
    setSourceKind(null);
    setExhaustedScene(null);
    // The engine is deliberately *not* reset: dropping to null would unmount
    // AVPlay for a commit between every pair of scenes, closing the native
    // session and with it a TV mute the user asked for. It switches when the
    // next scene resolves.

    // Availability resolves asynchronously on a panel that must load the WebAPI
    // script; planning first would start on the browser and switch under the
    // user.
    if (!sceneId || !ready) return;

    // One response serves every transcode candidate of this scene, whichever
    // engine asks first.
    let streams = null;
    const transcodeUrls = async () => {
      if (!streams) streams = await fetchSceneStreams(sceneId);
      return pickTranscodeUrls(streams);
    };

    // Descriptors from the policy, with URL production attached here — the
    // policy never fetches. `kind`/`engine` survive the walk so the controls and
    // stats show the answer.
    const available = avplayAvailable && !controller.isDisabled();
    plan.avplayAvailable = available;
    plan.sources = buildCandidatePlan({
      video: sceneMeta, setting, available, forcedBrowser,
    }).map((d) => ({
      engine: d.engine,
      kind: d.kind,
      make: d.kind === 'direct' ? async () => directUrl : transcodeUrls,
    }));

    void runFrom(plan);

    return () => { planRef.current = null; clearTimer(); };
    // The codec fields arrive through `sceneMeta`, which is memoised on those
    // primitives for this exact reason — see its comment.
  }, [
    sceneId, directUrl, sceneMeta, setting, forcedBrowser, avplayAvailable, ready,
    controller, runFrom, clearTimer,
  ]);

  // ── The stall watchdog's off switch ────────────────────────
  // Only these three: they mean the element has real media behind it.
  // `loadeddata`/`progress` also fire for a file that begins to arrive and then
  // stops being decodable — exactly the case the watchdog catches.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const settle = () => clearTimer();
    // A frame on screen is proof the engine works, and it is what clears the
    // kill switch's count — not a prepared or requested stream.
    //
    // Only a frame *from AVPlay* counts: the browser fallback plays after every
    // AVPlay fault, and letting its `playing` clear the count would mean the
    // switch could never trip. The facade's `kind` is the backend at the event.
    const healthy = () => {
      clearTimer();
      if (mediaRef.current?.kind === 'avplay') controller.succeed();
    };
    el.addEventListener('loadedmetadata', settle);
    el.addEventListener('canplay', settle);
    el.addEventListener('playing', healthy);
    return () => {
      el.removeEventListener('loadedmetadata', settle);
      el.removeEventListener('canplay', settle);
      el.removeEventListener('playing', healthy);
      clearTimer();
    };
  }, [sceneId, clearTimer, mediaRef, controller]);

  // Derived, not stored: on the render where the queue has moved to a new
  // scene this is already false, even though the state has not been reset
  // yet. See `exhaustedScene`.
  return {
    src,
    sourceKind,
    engine,
    // Why AVPlay is or is not in play, for the stats panel and the failure
    // message. A silent fallback is indistinguishable from a bug.
    engineStatus: controller.status({
      setting, available: avplayAvailable, forcedBrowser, video: sceneMeta,
    }),
    exhausted: exhaustedScene != null && exhaustedScene === sceneId,
    reportFailure,
  };
}
