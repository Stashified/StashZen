/**
 * usePlaybackSource — which URL the <video> gets, and what to do when it
 * doesn't work.
 *
 * The player used to hand the element `video.stream` and stop there. That is
 * Stash's copy of the file, and a `<video>` element decodes a much narrower
 * set of codecs and containers than the TV's own pipeline does — so a scene
 * the user can play in Stash's web UI, or in VLC, can be one this app refuses
 * with no explanation. See playbackSource.js for the measured codec census of
 * this library and the list of what is treated as playable.
 *
 * The model is **an ordered candidate list per scene, each tried only if the
 * one before it failed**:
 *
 *   - `needsTranscode(video)` says the direct file is known-bad. Then the
 *     transcoded endpoints go first and the direct file is the net.
 *   - Otherwise the direct file goes first — no extra request, no server
 *     CPU, full-range seeking — and a transcode is what a failure falls back
 *     to.
 *
 * The transcode candidates are themselves a list, in the order Stash should
 * be preferred (HLS, then MP4, then WebM; see playbackSource.js for the probe
 * that put HLS first). Only the first is resolved unless a format turns out
 * not to play.
 *
 * Either order can be wrong, and that is why both halves exist rather than a
 * single branch. A codec list cannot be complete: this library alone holds
 * eleven video codecs, and the failure being fixed here is a TV *silently*
 * refusing a file, which no list can enumerate. So the reactive half is the
 * real safety net and the list is only an optimisation — one that avoids a
 * request and a few seconds of server-side encode for the 456 scenes whose
 * codec is already known to be outside what any browser engine decodes.
 *
 * **Two failure signals, because a refused codec does not always raise one.**
 * A source the engine can identify but not decode fires `error`; a source it
 * accepts and then sits on raises nothing at all and spins forever, which is
 * what "doesn't want to play" looked like from the sofa. So the player's
 * `error` handler calls `reportFailure()`, and each attempt also arms a stall
 * watchdog. The watchdog is cleared by `loadedmetadata` / `canplay` /
 * `playing`, so a scene that is merely slow to buffer keeps its spinner
 * rather than being re-sourced underneath the user.
 *
 * Returns:
 *   src          the URL for the element, or null while a transcode is being
 *                resolved (the poster and the spinner cover that gap)
 *   sourceKind   `direct` or `transcode`, whichever the URL came from, and
 *                null while nothing is resolved. This is what the player
 *                shows in its controls bar, and it is derived here rather
 *                than inferred from the URL: only the candidate that yielded
 *                it knows whether the server is re-encoding.
 *   exhausted    every candidate has been tried and none loaded
 *   reportFailure()  the element reported a media error — returns true if
 *                another candidate is being tried, false if there is none,
 *                which is the caller's signal to show the failure
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSceneStreams } from '../utils/videoService.js';
import { pickTranscodeUrls } from '../utils/playbackSource.js';
import { buildCandidatePlan } from '../utils/enginePolicy.js';
import { createEngineController } from '../utils/engineController.js';

// How long an attempt may sit below HAVE_METADATA before it is judged dead.
// A LAN direct stream reports metadata in well under a second and a transcode
// takes about a second to start on the server. The asymmetry is the point:
// waiting too long costs the user a stall, and switching too early costs a
// transcode — which still plays. Deliberately generous for that reason.
const STALL_MS = 10000;

// The browser is first under `Auto`, and the resident AVPlay is a real second
// opinion rather than a last resort. A browser that *refuses* a source fires
// `error` quickly; one that accepts and then sits on it only shows up here.
// Ten seconds of that would be the slowest path in the app for no benefit, so
// when the next candidate is a working AVPlay, the browser's direct attempt
// gets four seconds. Everywhere else keeps the generous 10 s — a transcode
// genuinely takes longer to start, and there is nothing better to switch to.
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
  // cache. One instance for the life of the player, so what one scene teaches
  // the next survives a queue advance but nothing survives the player itself.
  // See engineController.js for why this is an instance and not module state.
  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = createEngineController();
  const controller = controllerRef.current;

  // The codec fields, as a stable set, for the policy and the format cache.
  // A memo of primitives rather than the queue object itself: the queue hands
  // over a fresh object identity on its own schedule, and re-planning a scene
  // would restart its playback.
  const sceneMeta = useMemo(() => ({
    id: sceneId,
    stream: directUrl,
    container: video?.container,
    videoCodec: video?.videoCodec,
    audioCodec: video?.audioCodec,
  }), [sceneId, directUrl, video?.container, video?.videoCodec, video?.audioCodec]);

  const [src, setSrc] = useState(null);
  // Which half of the plan produced `src`. The player uses it to say whether
  // the server is re-encoding, which is a fact only this hook knows — a URL
  // comparison in the component would be an inference and would drift.
  const [sourceKind, setSourceKind] = useState(null);
  // Which engine owns the source. One URL can belong to either, and the
  // player re-arms on `engine + ':' + src` rather than the URL alone. `null`
  // while nothing is resolved, which the player treats as the browser path so
  // the <video> exists before a source does.
  const [engine, setEngine] = useState(null);
  // Which scene the exhaustion belongs to, rather than a bare boolean. On the
  // commit that advances the queue, the effect below has not run yet, so a
  // plain `exhausted` is still the *previous* scene's answer for one render —
  // and the player's error effect runs in that same flush. Naming the scene
  // lets the answer be derived against the scene on screen instead.
  const [exhaustedScene, setExhaustedScene] = useState(null);

  // The active plan, replaced wholesale per scene. Continuations compare
  // identity before touching state: a sceneStreams request that lands after
  // the user has moved to the next scene must not set *that* scene's source.
  const planRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-armed rather than only cleared: StrictMode's simulated unmount runs
    // this cleanup and then mounts the effect again, and a latch that stayed
    // false would make every `runFrom` continuation bail — the poster would
    // stay up forever in `npm run dev`. Production runs it once.
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
   * Written as a loop rather than "set the first, react to failure": a
   * candidate can come back empty without anything having failed — a server
   * with transcoding disabled returns no endpoints at all — and that should
   * fall through to the next candidate immediately rather than offering the
   * user a URL that was never there.
   */
  const runFrom = useCallback(async (plan) => {
    while (plan.index < plan.sources.length) {
      const candidate = plan.sources[plan.index++];
      // What the session has learned can invalidate a candidate mid-walk: an
      // engine-level failure on the scene before this one trips the kill
      // switch, and a refused format skips AVPlay's direct attempt. Deciding
      // here rather than in the plan means the walk is honest even when the
      // knowledge arrives while it is running.
      if (candidate.engine === 'avplay'
        && (controller.isDisabled()
          || (candidate.kind === 'direct' && controller.blockedFormat(plan.video)))) {
        continue;
      }
      // The mirror image: this format's direct file already failed to start
      // in the browser this session, and there is a resident engine to hand it
      // to. Skipping costs nothing when the cached verdict was wrong — the
      // browser is still the last direct candidate in the plan.
      if (candidate.engine === 'html5' && candidate.kind === 'direct'
        && plan.avplayAvailable && !controller.isDisabled()
        && controller.browserBlockedFormat(plan.video)) {
        continue;
      }
      // A candidate is being resolved. A media `error` arriving in this
      // window belongs to the source that has just failed, not to one that
      // has not been tried yet — see reportFailure. Set inside the loop so a
      // candidate that resolves empty keeps the guard up while the next one
      // is fetched.
      plan.pending = true;

      // A candidate that throws is a candidate that failed, not an error to
      // propagate — the loop below is already the "try the next one" path, and
      // a rejected fetchSceneStreams resolving to `null` is a case it expects.
      const url = await candidate.make().catch(() => null);
      if (planRef.current !== plan || !mountedRef.current) return;

      // A candidate may stand for several. The transcodes are one lazy fetch
      // that yields an ordered list (HLS, MP4, WebM), and resolving it is the
      // expensive part — so it goes in as one entry and is spliced open here,
      // where the walk can resume from the second format without asking the
      // server again.
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
        // A browser direct attempt that never produced metadata is a format
        // verdict: this file does not start in the browser. Remember it before
        // the walk moves on, so the next scene of the format does not pay the
        // watchdog again. (Transcodes and AVPlay attempts are not cached here:
        // the former is about Stash, and the latter has its own cache.)
        if (browserDirect) controller.browserRefused(plan.video);
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

    // Learn from the failure before walking on. AVPlay classifies what it saw
    // (see avplayErrors.js): a *content* refusal on a direct attempt means
    // "this panel cannot decode this format", which is cached per codec
    // triple; an *engine* fault is a different thing and counts toward the
    // kill switch. A refused transcode is never cached — Stash produced that
    // file, so the refusal says nothing about the original's codecs.
    const active = plan.active;
    const failure = mediaRef.current?.lastFailure;
    if (active?.engine === 'avplay' && failure) {
      if (failure.level === 'engine') {
        controller.fail({ sceneId: plan.sceneId, level: 'engine', reason: failure.phase });
      } else if (failure.level !== 'transient' && active.kind === 'direct') {
        // A *transient* failure is the seek coalescer giving up: the scene
        // moves to the browser at the requested position, but that says
        // nothing about the format — the next scene must still try AVPlay and
        // must not be told this codec was refused.
        controller.refusedDirect(plan.video);
      }
    } else if (active?.engine === 'html5' && active.kind === 'direct'
      && plan.avplayAvailable) {
      // 3 = DECODE_ERR, 4 = SRC_NOT_SUPPORTED: the element looked at the file
      // and could not use it. 2 = NETWORK_ERR says nothing about the format,
      // and caching it would exile a codec for the session over a dropped LAN
      // connection. Anything else is unknown, and is not cached.
      const code = mediaRef.current?.error?.code;
      if (code === 3 || code === 4) controller.browserRefused(plan.video);
    }

    // A second failure while the next candidate is being resolved — the
    // element can fire `error` again for the source that just died — must not
    // be read as "nothing left to try". `index` has already moved past the
    // failed candidate by then, so the old check could see the plan as
    // exhausted and put the failure overlay over a transcode that was about
    // to play. There is a fallback underway; say so.
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
    // The engine is deliberately *not* reset here. While the next scene's
    // plan resolves there is no source anyway, and dropping to `null` would
    // unmount AVPlay for a commit between every pair of scenes — which closes
    // the native session, and with it a TV mute the user asked for. A scene
    // that resolves to the other engine switches once, when it resolves.

    // Availability is resolved asynchronously on a panel that has to load the
    // WebAPI script. Planning before the answer arrives would start the scene
    // on the browser and then switch engines under the user.
    if (!sceneId || !ready) return;

    // One response serves every transcode candidate of this scene, whichever
    // engine asks first.
    let streams = null;
    const transcodeUrls = async () => {
      if (!streams) streams = await fetchSceneStreams(sceneId);
      return pickTranscodeUrls(streams);
    };

    // Descriptors from the policy, with the URL-producing half attached here:
    // the policy never fetches. `kind` and `engine` survive the walk — a
    // fallback in either direction keeps the answer the controls and the stats
    // panel show.
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
  // Only these three: they are the events that mean the element has real
  // media behind it. `loadeddata`/`progress` would fire for a file that has
  // begun to arrive and then stops being decodable, which is exactly the
  // case the watchdog exists to catch.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const settle = () => clearTimer();
    // A frame on screen is the proof that the engine works. It is what clears
    // the kill switch's count — not a prepared stream, and certainly not a
    // requested one — so a scene that prepares and then dies still counts.
    //
    // Only a frame *from AVPlay* counts, though. The browser fallback plays
    // after every AVPlay engine fault, and letting its `playing` event clear
    // the count would mean the kill switch could never trip: each scene would
    // fail the engine once, fall back, play, and reset the ledger. The
    // facade's `kind` is the active backend at the moment of the event, which
    // is the engine whose frame this is.
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
