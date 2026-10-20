/**
 * VideoPlayer — Full-screen video player overlay
 *
 * Plays a `queue` — an ordered list of scenes plus the index to start at —
 * rather than a single video. A one-scene queue is the ordinary case: the
 * detail page's Play button and a marker both open one. A longer queue comes
 * from the action menu's Play all / Play from here, and is what the rail's
 * ⏮/⏭ buttons (and the end of a scene) advance through.
 *
 * ## Keys
 *
 * The transport rail (PlayerControlsRail) is the on-screen half of these, and
 * the two are deliberately not the same map. The rule that sorts them: a key
 * either does something *to the video* or moves the cursor, and the cursor
 * only exists once the rail is up.
 *
 *   OK         open the rail, focused on ⏯ — then activate the focused button
 *   ↑ / ↓      previous / next scene, in every state — including with the rail
 *              up; at the ends of a queue, nothing. A one-scene queue has
 *              nowhere to step, so there they raise the rail instead.
 *   ← / →      skim −15s / +15s inside the current scene (and reveal the rail);
 *              inside the rail, move between buttons
 *   Back/Esc   inside the rail, leave it — otherwise close the player
 *   Space, ⏯   instant transport in every state — Space and the remote's
 *              play/pause key (10252) toggle, its pause (19) and play (415)
 *              keys do only what they say; see mediaTransport
 *
 * Three states, not two: with the rail up the cursor owns the arrows, and with
 * the add-marker form, the resume prompt or the detail page up the player owns
 * nothing at all — see foreignDialogOpen for why that is decided by what is in
 * the document rather than by where the cursor happens to be.
 *
 * ## What gets written back
 *
 * Three writes, and they are deliberately not one:
 *
 *   play_count     `sceneAddPlay`, once per scene per session, on the first
 *                  frame that actually plays. It cannot come from anything
 *                  periodic: in Stash a play count is the length of a list of
 *                  view dates, so "increment" means "append a row", and
 *                  `sceneSaveActivity` does not touch that table at all.
 *   resume_time    `sceneSaveActivity`, overwritten each save.
 *   play_duration  the same call, as a *delta* of seconds actually watched —
 *                  the server adds it to a running total, so a position would
 *                  be re-counted on every save.
 *
 * A save that fails is shown, not swallowed: see `syncState`. On a TV there is
 * no console, and a silently rejected write is indistinguishable from one that
 * worked, which is exactly how "does progress sync?" became unanswerable from
 * the couch.
 *
 * The detail page is rendered *here*, not by the app, even though the app has
 * its own render site for the same page. The two differ in exactly the two
 * things that matter and in nothing else: this one restores the cursor to the
 * button that opened it and leaves the scene paused, and its Play resumes the
 * scene already loaded rather than starting a new session from zero. Folding
 * them together would mean the app carrying the player's focus and playback
 * state, which is the state the player exists to own.
 *
 * So OK no longer pauses: pausing is OK (open the rail), OK (activate ⏯), and
 * resuming is a third OK. The blank-OK press that used to be a pause is now
 * the entry, which is why the rail opens with the cursor already on ⏯ rather
 * than on the leftmost button.
 *
 * Queue stepping is ↑/↓ and the rail's ⏮/⏭, and the two are not redundant: the
 * buttons are the labelled affordance, the arrows are the blind path a user
 * finds by pressing. The arrows work in every state, the rail's included. The
 * rail is a single row, so ↑/↓ had nothing to do inside it, and spending ↑ on
 * "leave" made the key a user reaches for to skip a scene mean the opposite of
 * what it means everywhere else in the app. Back is the way out of the rail,
 * exactly as it is the way out of everything else here.
 *
 * The queue object is `{ items, total, page, startIndex, startSeconds,
 * fetchPage }` — see usePlayQueue. `startSeconds` applies to the scene the
 * session opened on (a marker's timestamp) and to nothing after it.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import styles from './VideoPlayer.module.css';
import PlayerControlsRail from './PlayerControlsRail.jsx';
import MarkerModal from './MarkerModal.jsx';
import PlaybackInfoPanel from './PlaybackInfoPanel.jsx';
import ResumePrompt from './ResumePrompt.jsx';
import SceneDetailPage from '../pages/SceneDetailPage.jsx';
import { useSpriteVtt } from '../hooks/useSpriteVtt.js';
import { usePlayQueue } from '../hooks/usePlayQueue.js';
import { usePlaybackSource } from '../hooks/usePlaybackSource.js';
import { timelineDuration } from '../utils/playbackSource.js';
import { SKIP_SECONDS } from './player/constants.js';
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

  // Report the scene on screen, so the screen underneath can put the cursor
  // back on *that* scene's card when the player closes — a queue started in
  // the middle of a listing and then skipped must not return to the scene it
  // started on. The callback is read through a ref because App rebuilds it
  // every render, and the report belongs to a scene change, not to each of
  // the player's own re-renders (the transport writes state every timeupdate).
  const onSceneChangeRef = useRef(onSceneChange);
  onSceneChangeRef.current = onSceneChange;
  const currentVideoRef = useRef(video);
  currentVideoRef.current = video;
  useEffect(() => {
    onSceneChangeRef.current?.(currentVideoRef.current ?? null);
  }, [video?.id]);

  // One scene and no neighbours: ↑/↓ have no scene to step to, so they open
  // the rail instead. Derived from the queue rather than from `items.length`
  // alone, so a single-scene page of a larger queue is still a step-and-fetch.
  const singleScene = !hasPrev && !hasNext;

  const startIndex = queue?.startIndex ?? 0;
  // Only the scene the session opened on can have an explicit start: a
  // marker's timestamp describes that marker, not the scene after it.
  const startSeconds = index === startIndex ? (queue?.startSeconds || 0) : 0;

  // The codec fields, as a set, for the failure message only.
  //
  // A memo of primitives rather than the queue object itself: the event-wiring
  // effect below tracks the scene by `video?.id` on purpose (the <video> node
  // survives an advance, so anything looser would tear its listeners down and
  // re-add them mid-playback), and listing `video` there would reintroduce
  // exactly that churn. These three are read from the same closure, so they
  // need the same treatment — and for a given scene id they never change.
  const codecs = useMemo(() => ({
    videoCodec: video?.videoCodec,
    audioCodec: video?.audioCodec,
    container: video?.container,
  }), [video?.videoCodec, video?.audioCodec, video?.container]);

  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const railRef = useRef(null);
  const startSeekedRef = useRef(false); // ensure we only auto-seek once
  // Where to put the playhead after a *fallback* source loads. `{sceneId,
  // time}` so a source change that belongs to a new scene cannot carry the
  // outgoing scene's position into it.
  const fallbackSeekRef = useRef({ sceneId: null, time: 0 });

  // The write-back subsystem. `progressReporter.js` does the accounting and
  // has its own tests; this hook owns the page lifecycle around it — the sync
  // chip, the unmount latch, visibility/pagehide and the periodic save. The
  // media event handlers below feed it, and `useSceneState` names the scene.
  const { progress, syncState } = usePlaybackProgress({ video, videoRef, onActivityChange });

  // The player's own render state. The timeline the UI draws and the error
  // overlay are shared by several hooks — the media wiring writes them, the
  // transport and the overlays read them — so they are declared in the shell
  // rather than owned by any one of them.
  const [currentTime, setCurrentTime] = useState(startSeconds);
  const [elementDuration, setElementDuration] = useState(0);
  const [error, setError] = useState(null);

  // What the <video> is actually pointed at — the scene's own file, or one of
  // Stash's transcodes when that file is a codec the TV cannot decode, and the
  // other of the two if the first one fails. See the hook: the decision and
  // the fallback both live there, and this component only supplies the queue
  // item and the element.
  const {
    src: playbackSrc,
    sourceKind,
    exhausted: sourceExhausted,
    reportFailure: reportSourceFailure,
  } = usePlaybackSource(video, videoRef);

  // Where this scene actually got to, the watch time owed, the completion
  // latch, the play-count latch and the save queue all live behind
  // `progress` — see progressReporter.js, which explains each rule. Everything
  // here reads the reporter, never the live element, for the teardown save:
  // React points `src` at the next scene before it runs the previous effect's
  // cleanup, and assigning `src` resets currentTime to 0.

  // The current `src` has not reported metadata yet, so its timeline is not
  // yet the user's. Setting `src` runs the media load algorithm, which resets
  // `currentTime` to 0 — and some engines announce that with a `timeupdate`
  // *before* the new source has loaded. Taking it would overwrite the saved
  // playhead with 0 mid-fallback, losing the position both for the resume
  // seek and for the teardown save. Set on every source change, cleared by
  // `loadedmetadata`.
  const sourceFreshRef = useRef(false);

  // A resume position the element would not seek to yet (no metadata), kept
  // for `loadedmetadata` to apply. Without it the live value arriving before
  // the file does was simply lost: the seek threw, and the later load had no
  // other way to learn about it.
  const pendingLiveResumeRef = useRef(0);

  // What Stash knows about the scene on screen: the live resume point, the
  // markers, and the answer to the resume prompt. The per-scene reset and
  // fetch live here too — one commit, one reset.
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
    controlsVisible, showControls, revealRail, leaveRail, hideControls,
  } = useControlsVisibility({ railRef });

  // Where a scene starts: the prompt, the policy, and the seek latches the
  // media wiring below shares with it.
  const {
    resumeTime, askingToResume, effectiveStart, chooseResume,
  } = useResumeSeek({
    video,
    videoRef,
    liveResumeTime,
    resumeChoice,
    setResumeChoice,
    startSeconds,
    startSeekedRef,
    pendingLiveResumeRef,
    setCurrentTime,
  });

  // The element's listeners, its autoplay decision and its source-change
  // re-arm. Consumes the resume decision above; nothing consumes it except
  // the render.
  const { playing, buffering } = usePlayerMedia({
    video,
    videoRef,
    progress,
    showControls,
    effectiveStart,
    askingToResume,
    startSeekedRef,
    pendingLiveResumeRef,
    fallbackSeekRef,
    sourceFreshRef,
    playbackSrc,
    sourceExhausted,
    reportSourceFailure,
    codecs,
    goNext,
    setCurrentTime,
    setElementDuration,
    setError,
  });

  /**
   * The timeline the UI draws — which is *not* always the element's duration.
   *
   * `v.duration` is the truth whenever there is one: it is the range the
   * transport can actually reach, and for a direct file or an HLS playlist it
   * matches the source exactly. A Stash **MP4 transcode** has none to give
   * (see playbackSource.js), and that is where "timeline only shows first 10
   * secs" came from.
   *
   * The rule itself lives in `timelineDuration` rather than here, because it
   * is the one part of that report that no off-device run can reproduce — see
   * its comment. This component only reads the answer.
   */
  const duration = timelineDuration(elementDuration, video?.durationSeconds || 0);

  const { skim, skimFlash, skimPreviewVisible } = useSkim({
    videoRef,
    duration,
    showControls,
    setCurrentTime,
  });

  const {
    muted, togglePlay, mediaTransport, stepScene, jumpToMarker, toggleMute,
  } = usePlayerTransport({
    videoRef,
    markers,
    setCurrentTime,
    setError,
    showControls,
    goNext,
    goPrev,
  });

  const {
    markerModal, markerNotice, openMarkerModal, closeMarkerModal, handleMarkerCreated,
  } = useMarkerOverlay({ videoRef, addMarkers, showControls });

  const {
    detailsOpen, statsOpen, openDetails, closeDetails, toggleStats,
    playFromDetails, playAtFromDetails,
  } = useDetailsOverlay({ videoRef, progress, showControls, setCurrentTime });

  // Last, because it only dispatches into the callbacks above: the key map is
  // pure and lives in keyRouting.js, and this hook installs the listener.
  usePlayerKeys({
    onClose,
    containerRef,
    railRef,
    mediaTransport,
    skim,
    revealRail,
    leaveRail,
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
  // What the controls bar says about the source. `null` while the resolver is
  // still choosing: the spinner is the honest state then, and a chip that
  // guessed would have to change again a moment later.
  const sourceLabel = sourceKind === 'transcode' ? 'Transcoded'
    : sourceKind === 'direct' ? 'Direct play'
      : null;

  return (
    <div
      ref={containerRef}
      className={styles.overlay}
      role="dialog"
      aria-label={`Now playing: ${video.title}`}
      onMouseMove={showControls}
    >
      {/* No `autoPlay`: playback is started by the effect above, which is held
          back while the resume prompt is up. See it for why.
          `src` is the resolver's, not the scene's: it is the file itself
          unless the TV cannot decode it, in which case it is Stash's
          transcode — and it changes mid-scene if the first choice fails.
          See usePlaybackSource. */}
      <video
        ref={videoRef}
        className={styles.video}
        src={playbackSrc}
        poster={video.thumbnail}
        playsInline
      />

      <PlayerStatus
        skimFlash={skimFlash}
        buffering={buffering}
        error={error}
        skipSeconds={SKIP_SECONDS}
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
            onPlayPause={togglePlay}
            onSkim={skim}
            // Null at the ends of the queue, which the rail renders as a
            // dimmed, un-navigable button. A one-scene queue is the ordinary
            // case — the detail page's Play, a marker — so without this the
            // two scene buttons ship enabled and inert on the common path.
            // `goNext` itself is still passed to the `ended` handler above,
            // where being callable at the end is the point.
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

      {/* Outside `.controls` for the same reason as the toast: the readout is
          something the user turned on, so it must not disappear when the rail
          times itself out. It owns its own live-updating state — see the
          component. */}
      {statsOpen && (
        <PlaybackInfoPanel
          videoRef={videoRef}
          video={video}
          sourceKind={sourceKind}
          src={playbackSrc}
        />
      )}

      {/* Outside `.controls`, so the confirmation survives the rail hiding
          itself — the two are timed independently and the notice is the only
          evidence that a write landed. */}
      {markerNotice && (
        <p className={styles.toast} role="status" aria-live="polite">{markerNotice}</p>
      )}

      {/* Last in the overlay, so it draws over the controls and the rail. It
          carries `role="dialog"`, which is what makes the player yield every
          key while it is up — see ResumePrompt's header. Hidden on an error:
          there is nothing to resume into, and the error state already tells the
          user to press Back. */}
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
        Keyed on the scene id for the same reason the app's own render site is:
        an instance that outlived its scene would carry the previous scene's
        optimistic rating and organised state into the next one — and here the
        next one can arrive without the page ever closing, since the queue
        advances underneath it.

        It paints over the rail despite the lower z-index in its own stylesheet:
        the player's overlay is a stacking context, so the page's 900 is
        compared against the rail's, not against the overlay's 1000.
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
