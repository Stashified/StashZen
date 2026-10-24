/**
 * usePlayerTransport — everything that moves the playhead or the queue.
 *
 * These were separate callbacks in the player shell, and they belong together
 * because they share one rule: each of them ends by re-arming the controls,
 * since a press that changes something should also show what it changed. The
 * only exception is the ends of the queue, where `stepScene` deliberately does
 * nothing — a key that shows a rail and then refuses to move reads as a press
 * the app half-heard.
 */

import { useCallback, useEffect, useState } from 'react';

export function usePlayerTransport({
  mediaRef,
  engine,
  markers,
  setCurrentTime,
  setError,
  showControls,
  goNext,
  goPrev,
  // Null until the user expresses a preference. The player reads it when it
  // opens a source, so a scene advance or an engine switch asks the new
  // backend for the same state; the ref is owned here because this hook is
  // where the button lives.
  muteIntentRef = null,
}) {
  // Mute belongs to this playback session, not to the app: it starts off on
  // every open and is never persisted, because a silent player that the user
  // cannot hear and did not ask for is indistinguishable from a broken one.
  const [muted, setMuted] = useState(false);

  // Whether the live backend can mute at all. The facade's capability is set
  // by `setEngine` in the player's layout effect — after this render — so it
  // is read again when the engine changes rather than during render, and the
  // button is disabled while the answer is still the previous engine's.
  // (Hierarchy: tizen.tvaudiocontrol → avplay.setVolume → none. The browser
  // engine reports 'property' off a TV and 'tvaudio' on one, so a remote mute
  // shows up in the same button.)
  const [muteCapability, setMuteCapability] = useState(
    () => mediaRef.current?.getMuteCapability?.() ?? 'property',
  );
  useEffect(() => {
    setMuteCapability(mediaRef.current?.getMuteCapability?.() ?? 'property');
  }, [engine, mediaRef]);
  const muteAvailable = muteCapability !== 'none';

  /**
   * Keep the button honest about who is muted.
   *
   * Two sources of truth meet here. AVPlay captures the TV's mute state when
   * it opens — a mute made with the remote is already in effect and the
   * button has to say so — and it announces every change it applies. On an
   * engine switch the new backend starts in its own state, so an expressed
   * preference is carried onto the browser element; AVPlay receives the same
   * preference through `open()` and re-applies it after prepare.
   */
  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    // An event is a change, and once the viewer has expressed a preference
    // every later change — the remote's included — is a preference too, so it
    // has to travel to the next scene and the next engine. Before the first
    // press the intent stays null, because AVPlay's `open()` must keep
    // adopting a TV that was already muted rather than overriding it with a
    // default. The initial read below is deliberately not this path.
    const sync = () => {
      setMuted(!!v.muted);
      if (muteIntentRef && muteIntentRef.current != null) {
        muteIntentRef.current = !!v.muted;
      }
    };
    if (v.kind === 'html5' && muteIntentRef && muteIntentRef.current != null
        && v.muted !== muteIntentRef.current) {
      v.muted = muteIntentRef.current;
    }
    setMuted(!!v.muted);
    v.addEventListener('volumechange', sync);
    return () => v.removeEventListener('volumechange', sync);
  }, [engine, mediaRef, muteIntentRef]);

  /**
   * Start playback without turning a routine rejection into an error overlay.
   *
   * `AbortError` is a play interrupted by a pause or a seek. `NotSupportedError`
   * is what a source-less element answers — which is the normal state while the
   * resolver is still fetching a transcode's URL. Reporting that one would put
   * a permanent raw error over a scene that is about to play underneath it; a
   * genuine decode failure arrives as a media `error` event and is handled
   * there, with the fallback given first refusal.
   */
  const playQuietly = useCallback((v) => {
    v.play().catch(e => {
      if (e?.name === 'AbortError' || e?.name === 'NotSupportedError') return;
      setError(e.message);
    });
  }, [setError]);

  const togglePlay = useCallback(() => {
    const v = mediaRef.current;
    if (!v) return;
    if (v.paused) playQuietly(v);
    else v.pause();
    showControls();
  }, [mediaRef, playQuietly, showControls]);

  /**
   * The remote's play/pause keys, resolved to animations.
   *
   * Not three names for one toggle. Tizen has three distinct codes and two of
   * them mean one thing each: 10252 is the play/pause key and only that one
   * toggles, while 19 is *pause* and 415 is *play*. Folding 19 and 415 into the
   * toggle would put a remote with separate keys permanently one press out of
   * phase — pressing pause on a paused scene would start it, which on a remote
   * with a dedicated pause key is indistinguishable from the app ignoring you.
   *
   * 415 and 19 are also which of Tizen's codes a given TV actually emits, so
   * this is the one part of the rail that cannot be settled off-device: the
   * harness can only prove the mapping, not that this remote sends them.
   */
  const mediaTransport = useCallback((code) => {
    const v = mediaRef.current;
    if (!v) return;
    if (code === 19) {
      if (!v.paused) v.pause();
    } else if (code === 415) {
      if (v.paused) playQuietly(v);
    } else {
      togglePlay();
      return;
    }
    showControls();
  }, [mediaRef, playQuietly, togglePlay, showControls]);

  /**
   * Step to the neighbouring scene. The single path behind ↑/↓ and the rail's
   * ⏮/⏭, so the rule about the ends of the queue is stated once rather than
   * being whatever each caller happens to do.
   *
   * There is no wrapping: running off either end does nothing at all, and that
   * includes not raising the controls, because a key that shows a rail and then
   * refuses to move would read as a press the app half-heard.
   *
   * `goPrev` answers synchronously and `goNext` with a promise — it may have to
   * fetch the next page — so both are normalised rather than each call site
   * knowing which kind of stepper it holds.
   */
  const stepScene = useCallback((dir) => {
    const moved = dir > 0 ? goNext() : Promise.resolve(goPrev());
    moved.then((ok) => { if (ok) showControls(); });
  }, [goNext, goPrev, showControls]);

  // Step to the neighbouring marker. The comparison is strict with a small
  // tolerance rather than "the marker nearest the cursor", because the cursor
  // in question is `currentTime`, which drifts continuously: an inclusive
  // test would re-seek to the marker the user is already sitting on and the
  // button would look stuck.
  //
  // No wrapping. Running off either end does nothing, the same as scene
  // prev/next at the ends of the queue.
  const jumpToMarker = useCallback((dir) => () => {
    const v = mediaRef.current;
    if (!v) return;
    const t = v.currentTime;
    let target = null;
    if (dir > 0) {
      target = markers.find(m => m.seconds > t + 0.05) || null;
    } else {
      for (let i = markers.length - 1; i >= 0; i -= 1) {
        if (markers[i].seconds < t - 0.05) { target = markers[i]; break; }
      }
    }
    if (!target) return;
    try { v.currentTime = target.seconds; } catch (e) { return; }
    // Move the clock and the dot now rather than at the next `timeupdate`,
    // which is up to 250ms away — the same reason skim() sets it directly.
    setCurrentTime(target.seconds);
  }, [mediaRef, markers, setCurrentTime]);

  const toggleMute = useCallback(() => {
    const v = mediaRef.current;
    if (!v || !muteAvailable) return;
    const next = !v.muted;
    // Recorded before the write: a backend can refuse (the AVPlay setVolume
    // rung needs a prepared session), and the preference should still travel
    // to the session that is about to become ready.
    if (muteIntentRef) muteIntentRef.current = next;
    v.muted = next;
    setMuted(v.muted);
    showControls();
  }, [mediaRef, muteAvailable, showControls, muteIntentRef]);

  return {
    muted,
    muteAvailable,
    playQuietly,
    togglePlay,
    mediaTransport,
    stepScene,
    jumpToMarker,
    toggleMute,
  };
}
