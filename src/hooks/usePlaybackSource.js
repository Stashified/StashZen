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

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSceneStreams } from '../utils/videoService.js';
import { needsTranscode, pickTranscodeUrls } from '../utils/playbackSource.js';

// How long an attempt may sit below HAVE_METADATA before it is judged dead.
// A LAN direct stream reports metadata in well under a second and a transcode
// takes about a second to start on the server. The asymmetry is the point:
// waiting too long costs the user a stall, and switching too early costs a
// transcode — which still plays. Deliberately generous for that reason.
const STALL_MS = 10000;

export function usePlaybackSource(video, videoRef) {
  const sceneId = video?.id ?? null;
  const directUrl = video?.stream ?? null;
  const transcodeFirst = needsTranscode(video);

  const [src, setSrc] = useState(null);
  // Which half of the plan produced `src`. The player uses it to say whether
  // the server is re-encoding, which is a fact only this hook knows — a URL
  // comparison in the component would be an inference and would drift.
  const [sourceKind, setSourceKind] = useState(null);
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
          ...url.map((u) => ({ kind: candidate.kind, make: async () => u })),
        );
        continue;
      }

      if (!url) continue;

      plan.pending = false;
      setSrc(url);
      setSourceKind(candidate.kind);

      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (planRef.current !== plan || !mountedRef.current) return;
        // HAVE_METADATA or beyond means this file *is* loading; a stall after
        // that is buffering, which the player's own spinner already reports
        // honestly, and re-sourcing would be a lie about what went wrong.
        const el = videoRef.current;
        if (el && el.readyState >= 1) return;
        void runFrom(plan);
      }, STALL_MS);
      return;
    }
    plan.pending = false;
    setExhaustedScene(plan.sceneId);
  }, [clearTimer, videoRef]);

  const reportFailure = useCallback(() => {
    const plan = planRef.current;
    if (!plan) return false;
    // A second failure while the next candidate is being resolved — the
    // element can fire `error` again for the source that just died — must not
    // be read as "nothing left to try". `index` has already moved past the
    // failed candidate by then, so the old check could see the plan as
    // exhausted and put the failure overlay over a transcode that was about
    // to play. There is a fallback underway; say so.
    if (plan.pending) return true;
    if (plan.index >= plan.sources.length) return false;
    clearTimer();
    void runFrom(plan);
    return true;
  }, [clearTimer, runFrom]);

  // ── The plan for this scene ────────────────────────────────
  useEffect(() => {
    const plan = {
      index: 0,
      sources: [],
      sceneId,
      pending: false,
    };
    planRef.current = plan;
    clearTimer();
    setSrc(null);
    setSourceKind(null);
    setExhaustedScene(null);

    if (!sceneId) return;

    // Each candidate carries the answer the player will show: `kind` survives
    // the walk, including a fallback in either direction, so the controls can
    // say what is actually playing rather than what was planned.
    const direct = { kind: 'direct', make: async () => directUrl };
    // Asked for lazily, so a scene that plays directly never pays for it, and
    // answering with a *list* so the walk can try each format in turn off one
    // response. See the expansion in runFrom.
    const transcode = {
      kind: 'transcode',
      make: async () => pickTranscodeUrls(await fetchSceneStreams(sceneId)),
    };

    plan.sources = transcodeFirst ? [transcode, direct] : [direct, transcode];
    void runFrom(plan);

    return () => { planRef.current = null; clearTimer(); };
    // `video?.stream` and the codec fields are read through the plan above;
    // they are primitives, so listing them keeps the effect honest without
    // re-running on every new object identity the queue hands over.
  }, [sceneId, directUrl, transcodeFirst, runFrom, clearTimer]);

  // ── The stall watchdog's off switch ────────────────────────
  // Only these three: they are the events that mean the element has real
  // media behind it. `loadeddata`/`progress` would fire for a file that has
  // begun to arrive and then stops being decodable, which is exactly the
  // case the watchdog exists to catch.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const settle = () => clearTimer();
    el.addEventListener('loadedmetadata', settle);
    el.addEventListener('canplay', settle);
    el.addEventListener('playing', settle);
    return () => {
      el.removeEventListener('loadedmetadata', settle);
      el.removeEventListener('canplay', settle);
      el.removeEventListener('playing', settle);
      clearTimer();
    };
  }, [sceneId, clearTimer, videoRef]);

  // Derived, not stored: on the render where the queue has moved to a new
  // scene this is already false, even though the state has not been reset
  // yet. See `exhaustedScene`.
  return {
    src,
    sourceKind,
    exhausted: exhaustedScene != null && exhaustedScene === sceneId,
    reportFailure,
  };
}
