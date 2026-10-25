/**
 * usePlayerTransport — everything that moves the playhead or the queue.
 *
 * They share one rule: each ends by re-arming the controls, since a press that
 * changes something should show what it changed. The exception is the ends of
 * the queue: there `stepScene` does nothing, because a key that raises a rail
 * and then refuses to move reads as a press the app half-heard.
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
  // opens a source, so a scene advance or engine switch asks the new backend for
  // the same state.
  muteIntentRef = null,
}) {
  // Mute belongs to this playback session, not the app: it starts off on every
  // open and is never persisted, because an unexplained silent player reads as
  // broken.
  const [muted, setMuted] = useState(false);

  // Whether the live backend can mute. `setEngine` sets the facade's capability
  // in a layout effect, after this render, so it is re-read when the engine
  // changes; until then the button shows the previous engine's answer.
  // Hierarchy: tizen.tvaudiocontrol → avplay.setVolume → none. A remote mute on
  // a TV shows up in the same button via its 'tvaudio' path.
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
   * AVPlay adopts the TV's mute state when it opens (a remote mute must show)
   * and announces every change it applies. On an engine switch the new backend
   * starts in its own state, so the expressed preference is carried onto the
   * element; AVPlay gets it through `open()` and re-applies it after prepare.
   */
  useEffect(() => {
    const v = mediaRef.current;
    if (!v) return;
    // Once the viewer has expressed a preference, every later change — the
    // remote's included — is a preference too and must travel to the next scene
    // and engine. Before the first press the intent stays null, so `open()` keeps
    // adopting an already-muted TV. The initial read below is not this path.
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
   * `AbortError` is a play interrupted by a pause or seek; `NotSupportedError`
   * is a source-less element, normal while the resolver fetches a transcode
   * URL. Reporting that would put a permanent raw error over a scene about to
   * play. A genuine decode failure is a media `error` event, handled there.
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
   * The remote's play/pause keys, resolved to actions. Not three names for one
   * toggle: 10252 is play/pause and only that one toggles, while 19 is *pause*
   * and 415 is *play*. Folding them together would leave a remote with separate
   * keys one press out of phase — pause on a paused scene would start it.
   *
   * Which code a given TV emits cannot be settled off-device: the harness can
   * prove the mapping, not that this remote sends them.
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
   * Step to the neighbouring scene — the single path behind ↑/↓ and the rail's
   * ⏮/⏭, so the ends-of-queue rule is stated once.
   *
   * No wrapping: running off either end does nothing, including not raising the
   * controls, because a key that shows a rail and then refuses to move reads as
   * a press the app half-heard.
   *
   * `goPrev` answers synchronously and `goNext` with a promise (it may fetch
   * the next page), so both are normalised here.
   */
  const stepScene = useCallback((dir) => {
    const moved = dir > 0 ? goNext() : Promise.resolve(goPrev());
    moved.then((ok) => { if (ok) showControls(); });
  }, [goNext, goPrev, showControls]);

  // Step to the neighbouring marker. The comparison is strict with a small
  // tolerance, because `currentTime` drifts: an inclusive test would re-seek to
  // the marker already sat on and the button would look stuck. No wrapping.
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
    // Move the clock and dot now rather than at the next `timeupdate`, up to
    // 250 ms away — the same reason skim() sets it directly.
    setCurrentTime(target.seconds);
  }, [mediaRef, markers, setCurrentTime]);

  const toggleMute = useCallback(() => {
    const v = mediaRef.current;
    if (!v || !muteAvailable) return;
    const next = !v.muted;
    // Recorded before the write: a backend can refuse (the AVPlay setVolume
    // rung needs a prepared session), and the preference should still reach the
    // session about to become ready.
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
