/**
 * VideoPlayer, full-screen video player overlay.
 *
 * Plays a `queue` (`{ items, total, page, startIndex, startSeconds, fetchPage }`,
 * see usePlayQueue): an ordered list plus the index to start at. A one-scene
 * queue is the ordinary case; Play all / Play from here make it longer, and the
 * rail's ⏮/⏭ (and the end of a scene) advance through it. `startSeconds`
 * applies only to the scene the session opened on (a marker's timestamp).
 *
 * ## Keys
 *
 * The rail is the on-screen half of these and deliberately not the same map. A
 * key either does something to the video or moves the cursor, and the cursor
 * only exists while the rail is up:
 *
 *   OK         open the rail focused on ⏯, then activate the focused button
 *   ↓ / ↑      next/previous scene; from the seek bar ↓ goes to the buttons
 *              first, and ↑ from the buttons goes to the seek bar (←/→ skim)
 *   ← / →      skim −15s / +15s in the scene, and reveal the rail
 *   Back/Esc   leave the rail if it is up, else close the player
 *   Space, ⏯   instant transport in every state; the remote's play/pause key
 *              (10252) toggles, pause (19) and play (415) do only their name
 *
 * A one-scene queue has nowhere to step, so ↑/↓ raise the rail there instead.
 * With a foreign dialog up (add-marker, resume prompt, detail page) the player
 * owns no keys, see foreignDialogOpen.
 *
 * ## Writes
 *
 * play_count is `sceneAddPlay`, once per scene per session on the first frame
 * that actually plays: in Stash a play count is a list of view dates, so an
 * "increment" appends a row and `sceneSaveActivity` does not touch it at all.
 * resume_time and play_duration are both `sceneSaveActivity`; the latter is a
 * delta of seconds watched because the server adds it to a running total. A
 * failed save is shown, not swallowed (see `syncState`): on a TV a silently
 * rejected write is indistinguishable from success. Rules live in
 * progressReporter.js.
 *
 * The detail page is rendered here, not by the app: its Play resumes the loaded
 * scene rather than starting from zero, and its cursor returns to the button
 * that opened it. Folding the two sites together would make the app carry the
 * player's focus and playback state.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo,
} from 'react';
import styles from './VideoPlayer.module.css';
import PlayerControlsRail from './PlayerControlsRail.jsx';
import MarkerModal from './MarkerModal.jsx';
import PlaybackInfoPanel from './PlaybackInfoPanel.jsx';
import ResumePrompt from './ResumePrompt.jsx';
import SceneDetailPage from '../pages/SceneDetailPage.jsx';
import { useSpriteVtt } from '../hooks/useSpriteVtt.js';
import { usePlayQueue } from '../hooks/usePlayQueue.js';
import { usePlaybackSource } from '../hooks/usePlaybackSource.js';
import { usePlayerEngine } from './player/usePlayerEngine.js';
import { timelineDuration } from '../utils/playbackSource.js';
import { sourceKey } from '../utils/enginePolicy.js';
import { withApiKey } from '../utils/stashUrl.js';
import { createMediaEngine } from './player/engine/mediaEngine.js';
import { deriveDefaultTag } from './player/markerUtils.js';
import { usePlaybackProgress } from './player/usePlaybackProgress.js';
import { useSceneState } from './player/useSceneState.js';
import { useControlsVisibility } from './player/useControlsVisibility.js';
import { useResumeSeek } from './player/useResumeSeek.js';
import { usePlayerMedia } from './player/usePlayerMedia.js';
import { useSkim } from './player/useSkim.js';
import { usePlayerTransport } from './player/usePlayerTransport.js';
import { useMarkerOverlay } from './player/useMarkerOverlay.js';
import { useDetailsOverlay } from './player/useDetailsOverlay.js';
import { usePlayerKeys } from './player/usePlayerKeys.js';
import { PlayerTopBar } from './player/PlayerTopBar.jsx';
import { PlayerProgress } from './player/PlayerProgress.jsx';
import { PlayerTimeRow } from './player/PlayerTimeRow.jsx';
import { PlayerStatus } from './player/PlayerStatus.jsx';

export default function VideoPlayer({ queue, onClose, onActivityChange, onSceneChange }) {
  const {
    items, total, index, current: video, goNext, goPrev, hasPrev, hasNext,
  } = usePlayQueue(queue);

  // Report the scene on screen so the screen underneath can restore the cursor
  // to *that* card, not the one the queue started on. Read through refs: App
  // rebuilds the callback every render, and the report belongs to a scene
  // change, not to each transport update.
  const onSceneChangeRef = useRef(onSceneChange);
  onSceneChangeRef.current = onSceneChange;
  const currentVideoRef = useRef(video);
  currentVideoRef.current = video;
  useEffect(() => {
    onSceneChangeRef.current?.(currentVideoRef.current ?? null);
  }, [video?.id]);

  // One scene and no neighbours: ↑/↓ have nowhere to step, so they raise the
  // rail. Derived from hasPrev/hasNext rather than items.length so a
  // single-scene page of a larger queue is still a step-and-fetch.
  const singleScene = !hasPrev && !hasNext;

  const startIndex = queue?.startIndex ?? 0;
  // Only the scene the session opened on can have an explicit start: a
  // marker's timestamp describes that marker, not the scene after it.
  const startSeconds = index === startIndex ? (queue?.startSeconds || 0) : 0;

  // Codec primitives, not the queue object, for the failure message only. The
  // event-wiring effect tracks scenes by `video?.id` on purpose (the <video>
  // node survives an advance, so anything looser would tear its listeners down
  // mid-playback), and listing `video` would reintroduce that churn.
  const codecs = useMemo(() => ({
    videoCodec: video?.videoCodec,
    audioCodec: video?.audioCodec,
    container: video?.container,
  }), [video?.videoCodec, video?.audioCodec, video?.container]);

  /**
   * The media facade every playback hook talks to. Stable for the player's
   * life and shaped like the slice of HTMLMediaElement the hooks use; the
   * backend is the browser's `<video>` today. Created lazily in a ref because
   * the hooks hold it as a ref and must not re-run when it appears.
   */
  const mediaRef = useRef(null);
  if (!mediaRef.current) mediaRef.current = createMediaEngine();
  const media = mediaRef.current;

  // Stable callback ref: an inline arrow would detach and re-attach the
  // facade's element listeners every render, and the progress clock makes this
  // component render several times a second.
  const attachVideo = useCallback((el) => {
    if (el) media.attachVideoElement(el);
    else media.detachVideoElement();
  }, [media]);

  const containerRef = useRef(null);
  const railRef = useRef(null);
  const startSeekedRef = useRef(false); // ensure we only auto-seek once
  // A held skim defers its seek, so the element keeps playing at the old
  // position: its `timeupdate` must not pull the timeline back to it.
  const skimPendingRef = useRef(false);
  // `{sceneId, time}` so a source change belonging to a new scene cannot carry
  // the outgoing scene's position into it.
  const fallbackSeekRef = useRef({ sceneId: null, time: 0 });

  // Write-back lifecycle, sync chip, unmount latch, pagehide, periodic save.
  // Accounting lives in progressReporter.js; the media handlers below feed it
  // and `useSceneState` names the scene.
  const { progress, syncState } = usePlaybackProgress({ video, mediaRef, onActivityChange });

  // Shared render state: the media wiring writes the timeline and error, the
  // transport and overlays read them, so the shell owns them.
  const [currentTime, setCurrentTime] = useState(startSeconds);
  const [elementDuration, setElementDuration] = useState(0);
  const [error, setError] = useState(null);

  // Read once at open, not subscribed: Settings is unreachable from the
  // player, and the setting says "applies on the next open".
  const {
    setting: engineSetting, forcedBrowser, avplay, tvaudiocontrol, ready: engineReady,
  } = usePlayerEngine();

  // What the media is pointed at, the scene's file, or a Stash transcode when
  // the engine cannot decode it, and the other of the two if the first fails.
  // The decision and fallback live in usePlaybackSource; this component only
  // supplies the queue item and the element.
  const {
    src: playbackSrc,
    srcSceneId,
    sourceKind,
    engine,
    engineStatus,
    exhausted: sourceExhausted,
    reportFailure: reportSourceFailure,
  } = usePlaybackSource(video, mediaRef, {
    setting: engineSetting,
    forcedBrowser,
    avplayAvailable: !!avplay,
    ready: engineReady,
  });

  // Re-arm key for the media wiring. Includes the engine: a fallback can
  // re-open the *same* URL on the other backend, and a URL-only key would leave
  // the hooks listening to the dead one.
  const mediaKey = sourceKey(engine, playbackSrc);

  /**
   * Point the facade at the resolved engine and enter/leave AVPlay plane mode
   * in the same commit.
   *
   * A layout effect because both halves must be true before paint: a
   * transparent page with the shell still drawn flashes the listing through,
   * and the reverse hides the picture. React has also attached or detached the
   * `<video>` by now, which the "no <video> while AVPlay is open" invariant
   * needs.
   *
   * This effect is the attribute's only owner: its cleanup removes it on every
   * engine change and unmount, so closing from AVPlay cannot leave the shell
   * hidden.
   */
  useLayoutEffect(() => {
    media.setEngine(engine === 'avplay' ? 'avplay' : 'html5', { avplay, tvaudiocontrol });
    const root = document.documentElement;
    if (engine === 'avplay') root.setAttribute('data-avplay-plane', '');
    else root.removeAttribute('data-avplay-plane');
    return () => { root.removeAttribute('data-avplay-plane'); };
  }, [media, engine, avplay, tvaudiocontrol]);

  // Saved position, owed watch time, completion/play-count latches and the
  // save queue live behind `progress` (see progressReporter.js). The teardown
  // save reads the reporter, never the element: React points `src` at the next
  // scene before the old effect's cleanup runs, and assigning `src` resets
  // currentTime to 0.

  // The current src has not reported metadata, so its timeline is not the
  // user's yet. Assigning `src` resets currentTime to 0 and some engines
  // announce that with a `timeupdate` before the new source loads; taking it
  // would overwrite the saved playhead with 0 mid-fallback. Cleared by
  // `loadedmetadata`.
  const sourceFreshRef = useRef(false);

  // A resume position the element cannot seek to yet (no metadata), applied on
  // `loadedmetadata`. Without it the position is lost: the seek throws and the
  // later load has no other way to learn about it.
  const pendingLiveResumeRef = useRef(0);

  // What Stash knows about the scene: live resume point, markers, resume-prompt
  // answer. The per-scene reset and fetch live here too, one commit, one
  // reset.
  const {
    liveResumeTime, markers, addMarkers, resumeChoice, setResumeChoice,
  } = useSceneState({
    video,
    progress,
    startSeekedRef,
    pendingLiveResumeRef,
    setLoadError: setError,
  });

  // Whether the rail is up, and the timer that puts it away.
  const {
    controlsVisible, showControls, revealRail, leaveRail, leaveRailToSeek,
    hideControls,
  } = useControlsVisibility({ railRef });

  // Where a scene starts: the prompt, the policy, and the seek latches shared
  // with the media wiring below.
  const {
    resumeTime, askingToResume, effectiveStart, chooseResume,
  } = useResumeSeek({
    video,
    mediaRef,
    liveResumeTime,
    resumeChoice,
    setResumeChoice,
    startSeconds,
    startSeekedRef,
    pendingLiveResumeRef,
    setCurrentTime,
  });

  /**
   * Open the native AVPlay session, its load path, since AVPlay has no
   * element (the browser's is the `<video>`'s `src`, set in the same commit).
   * The resume prompt owns whether playback may start; the transport starts it
   * once the prompt is gone.
   *
   * Keyed on the source identity, not `effectiveStart`/`askingToResume`:
   * re-opening to change a start position would restart the stream, and a seek
   * is what those two need. The options are read through a ref so the effect
   * need not depend on them.
   *
   * No cleanup on a source change: `open()` already tears the previous session
   * down (`setEngine` closes it on an engine switch). `close()` restores a TV
   * mute this app applied, so closing per scene would unmute between two
   * scenes of a muted sitting; the unmount effect below closes.
   */
  // The sitting's mute choice, owned by the transport button and read when a
  // source opens. AVPlay captures the TV mute state at open, so a queue advance
  // would otherwise unmute a muted sitting between two scenes.
  const muteIntentRef = useRef(null);

  const openOptionsRef = useRef({ startSeconds: 0, autoplay: true });
  openOptionsRef.current = {
    startSeconds: effectiveStart,
    autoplay: !askingToResume,
    muted: muteIntentRef.current,
  };
  useEffect(() => {
    if (engine !== 'avplay' || !playbackSrc) return;
    media.open(playbackSrc, openOptionsRef.current);
  }, [media, engine, playbackSrc, mediaKey]);

  // A plan that ran out leaves the previous scene's native session playing
  // under the error card. A plain source change must not close (that would
  // unmute between two scenes); exhaustion means no source is coming.
  useEffect(() => {
    if (sourceExhausted) media.close();
  }, [media, sourceExhausted]);

  // The sitting's end: close the native session and restore the panel. Runs
  // after the plane attribute's cleanup, so the shell is never left hidden.
  useEffect(() => () => media.close(), [media]);

  // The element's listeners, autoplay decision and source-change re-arm;
  // consumes the resume decision above.
  const { playing, buffering } = usePlayerMedia({
    video,
    mediaRef,
    progress,
    showControls,
    effectiveStart,
    askingToResume,
    startSeekedRef,
    pendingLiveResumeRef,
    fallbackSeekRef,
    sourceFreshRef,
    skimPendingRef,
    playbackSrc: mediaKey,
    sourceSceneId: srcSceneId,
    sourceExhausted,
    reportSourceFailure,
    codecs,
    goNext,
    setCurrentTime,
    setElementDuration,
    setError,
  });

  /**
   * The poster above the AVPlay plane until the engine has a picture.
   *
   * AVPlay draws behind the page, so between `open()` and the first decoded
   * frame the page is transparent over black, a thumbnail reads better than
   * nothing. An `<img>`, never a `<video>`: a second decoder would compete with
   * the engine it is covering for.
   *
   * Set by the `playing` event rather than derived from state: on the render
   * that picks a new scene the old `playing` may still be true, and the poster
   * would vanish before the new one had a frame. Keyed per source so an engine
   * fallback shows it again.
   */
  const [posterKey, setPosterKey] = useState(null);
  useEffect(() => {
    const onPlaying = () => setPosterKey(mediaKey);
    media.addEventListener('playing', onPlaying);
    return () => media.removeEventListener('playing', onPlaying);
  }, [media, mediaKey]);
  const showPoster = engine === 'avplay' && posterKey !== mediaKey && !!video?.thumbnail;

  /**
   * The timeline the UI draws, not always the element's duration.
   *
   * `v.duration` is the truth whenever it exists: it is the range the transport
   * can reach, and matches a direct file or HLS playlist exactly. A Stash MP4
   * transcode has none, which is what made the timeline show only the first
   * 10 seconds.
   *
   * The rule lives in `timelineDuration` because no off-device run reproduces
   * it; this component only reads the answer.
   */
  const duration = timelineDuration(elementDuration, video?.durationSeconds || 0);

  const { skim, skimFlash, skimPreviewVisible } = useSkim({
    mediaRef,
    duration,
    showControls,
    setCurrentTime,
    mediaKey,
    skimPendingRef,
  });

  const {
    muted, muteAvailable, togglePlay, mediaTransport, stepScene, jumpToMarker, toggleMute,
  } = usePlayerTransport({
    mediaRef,
    engine,
    markers,
    setCurrentTime,
    setError,
    showControls,
    goNext,
    goPrev,
    muteIntentRef,
  });

  const {
    markerModal, markerNotice, openMarkerModal, closeMarkerModal, handleMarkerCreated,
  } = useMarkerOverlay({ mediaRef, addMarkers, showControls });

  const {
    detailsOpen, statsOpen, openDetails, closeDetails, toggleStats,
    playFromDetails, playAtFromDetails,
  } = useDetailsOverlay({ mediaRef, progress, showControls, setCurrentTime });

  // Installed last: the key map is pure (keyRouting.js) and only dispatches
  // into the callbacks above.
  usePlayerKeys({
    onClose,
    containerRef,
    railRef,
    mediaTransport,
    skim,
    revealRail,
    leaveRail,
    leaveRailToSeek,
    hideControls,
    controlsVisible,
    stepScene,
    singleScene,
  });

  const { getCue } = useSpriteVtt(video?.vtt);

  // The tag the form opens on: see deriveDefaultTag.
  const defaultMarkerTag = useMemo(() => deriveDefaultTag(markers), [markers]);

  if (!video) return null;

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  // What the controls bar says about the source; null while the resolver is
  // still choosing, the spinner is the honest state then.
  const sourceLabel = sourceKind === 'transcode' ? 'Transcoded'
    : sourceKind === 'direct' ? 'Direct play'
      : null;

  return (
    <div
      ref={containerRef}
      data-player-host=""
      className={`${styles.overlay} ${engine === 'avplay' ? styles.avplay : ''}`}
      role="dialog"
      aria-label={`Now playing: ${video.title}`}
      onMouseMove={showControls}
    >
      {/* No `autoPlay`: the effect above starts playback and holds back while
          the resume prompt is up. `src` is the resolver's, not the scene's:
          the file itself, or Stash's transcode when the TV cannot decode it,
          and it can change mid-scene if the first choice fails. */}
      {engine !== 'avplay' && (
        <video
          ref={attachVideo}
          className={styles.video}
          src={playbackSrc}
          poster={video.thumbnail}
          playsInline
        />
      )}

      {/* Under the controls, over the transparent plane. The class's black
          background stops a slow thumbnail exposing the page underneath. */}
      {showPoster && (
        <img className={styles.poster} src={withApiKey(video.thumbnail)} alt="" />
      )}

      <PlayerStatus
        skimFlash={skimFlash}
        buffering={buffering}
        error={error}
      />

      <div className={`${styles.controls} ${controlsVisible ? styles.controlsVisible : ''}`}>
        <PlayerTopBar
          video={video}
          sourceKind={sourceKind}
          sourceLabel={sourceLabel}
          itemsLength={items.length}
          total={total}
          index={index}
          onClose={onClose}
        />

        <div className={styles.centerIndicator}>
          {!playing && !buffering && !error && <div className={styles.bigPlay}>▶</div>}
        </div>

        <div className={styles.bottomBar}>
          <PlayerProgress
            progressPct={progressPct}
            markers={markers}
            duration={duration}
            currentTime={currentTime}
            cue={getCue(currentTime)}
            skimPreviewVisible={skimPreviewVisible}
          />
          <PlayerTimeRow
            currentTime={currentTime}
            duration={duration}
            syncState={syncState}
            syncError={progress.syncError()?.message}
          />
          <PlayerControlsRail
            ref={railRef}
            playing={playing}
            muted={muted}
            hasMarkers={markers.length > 0}
            muteAvailable={muteAvailable}
            onPlayPause={togglePlay}
            onSkim={skim}
            // Null at the ends of the queue, which the rail dims and makes
            // un-navigable, otherwise both scene buttons ship enabled and
            // inert on the common one-scene path. `goNext` is still passed to
            // the `ended` handler above, where callable-at-the-end is the point.
            onPrevScene={hasPrev ? goPrev : null}
            onNextScene={hasNext ? goNext : null}
            onPrevMarker={jumpToMarker(-1)}
            onNextMarker={jumpToMarker(1)}
            onAddMarker={openMarkerModal}
            onToggleMute={toggleMute}
            onDetails={openDetails}
            statsOpen={statsOpen}
            onToggleStats={toggleStats}
          />
        </div>
      </div>

      {/* Outside `.controls`: the user turned the readout on, so it must not
          vanish when the rail times out. It owns its own live state. */}
      {statsOpen && (
        <PlaybackInfoPanel
          media={media}
          video={video}
          sourceKind={sourceKind}
          src={playbackSrc}
          engine={engine}
          engineStatus={engineStatus}
        />
      )}

      {/* Outside `.controls` so the confirmation survives the rail hiding, the
          notice is the only evidence that a write landed. */}
      {markerNotice && (
        <p className={styles.toast} role="status" aria-live="polite">{markerNotice}</p>
      )}

      {/* Last, so it draws over the controls and rail. `role="dialog"` makes
          the player yield every key while it is up (see ResumePrompt). Hidden
          on error: there is nothing to resume into, and the error already says
          Back. */}
      {askingToResume && !error && (
        <ResumePrompt
          sceneTitle={video.title}
          seconds={resumeTime}
          onChoose={chooseResume}
        />
      )}

      {markerModal && (
        <MarkerModal
          sceneId={video.id}
          sceneTitle={video.title}
          initialSeconds={markerModal.seconds}
          duration={duration}
          defaultTag={defaultMarkerTag}
          onClose={closeMarkerModal}
          onCreated={handleMarkerCreated}
        />
      )}

      {/*
        Keyed on the scene id: an instance outliving its scene would carry the
        previous optimistic rating and organised state into the next one, which
        can arrive without the page closing. It paints over the rail despite its
        lower z-index because the player's overlay is a stacking context, so its
        900 is compared against the rail's, not the overlay's 1000.
      */}
      {detailsOpen && (
        <SceneDetailPage
          key={video.id}
          scene={video}
          onClose={closeDetails}
          onPlay={playFromDetails}
          onPlayAt={playAtFromDetails}
          onActivityChange={onActivityChange}
        />
      )}
    </div>
  );
}
