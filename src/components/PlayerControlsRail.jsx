/**
 * PlayerControlsRail — the transport rail at the bottom of the video player.
 *
 * On-screen transport for the same actions the remote already has, plus the
 * ones that only exist here (mute, details, marker creation, the playback-info
 * toggle). The arrow-skim keys are kept — see VideoPlayer's key table — so
 * this is additive.
 *
 * ## Focus
 *
 * The rail is a single horizontal row in one zone, so ←/→ walk it and Back
 * leaves it. ↑/↓ are not the rail's at all — they step scenes in every state,
 * which is why they appear nowhere in this file; the player consumes them
 * before they reach a focused button. Leaving is the player's job too, not this
 * component's: it blurs to `document.body` rather than focusing anything,
 * because focusing the player's own container would resolve `focusScopeOf` to
 * the player's dialog and the player would go on yielding the arrows, which
 * kills skim with no visible cause.
 *
 * **The entry target is play/pause, not the leftmost button.** ←/→ radiate
 * outward from a focused control, and landing on a rewind because it happens to
 * be first would put the cursor on the wrong thing when the user pressed OK to
 * interact. `focusPlayPause` below is that entry point.
 *
 * ## Why the play/pause button is one element
 *
 * The icon swaps with playback state, and the *button* must not. React reuses a
 * DOM node only while its type and position are stable, so swapping the child
 * SVG keeps the node — and therefore focus — while rendering the two states as
 * different components or keying the button on `playing` would remount it,
 * drop focus to `<body>`, and make the next OK press re-focus instead of
 * resuming. The third press is the one that would go missing.
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';
import styles from './PlayerControlsRail.module.css';
import { useFocusable } from '../hooks/useFocusable.js';

const ZONE = 'player-rail';
const ICON = 26;

function Svg({ children, stroke = true }) {
  return (
    <svg
      width={ICON}
      height={ICON}
      viewBox="0 0 24 24"
      fill={stroke ? 'none' : 'currentColor'}
      stroke={stroke ? 'currentColor' : 'none'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* Filled glyphs — transport. */
const RewindIcon = () => (
  <Svg stroke={false}><path d="M11 12 19 6v12zM3 12l8-6v12z" /></Svg>
);
const ForwardIcon = () => (
  <Svg stroke={false}><path d="M13 12 5 6v12zM21 12l-8-6v12z" /></Svg>
);
const PlayIcon = () => (
  <Svg stroke={false}><path d="M7 4.5 19.5 12 7 19.5z" /></Svg>
);
const PauseIcon = () => (
  <Svg stroke={false}><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" /></Svg>
);
const PrevSceneIcon = () => (
  <Svg stroke={false}><path d="M6 5h2.5v14H6zM19 5.5 9.5 12 19 18.5z" /></Svg>
);
const NextSceneIcon = () => (
  <Svg stroke={false}><path d="M15.5 5H18v14h-2.5zM5 5.5 14.5 12 5 18.5z" /></Svg>
);

/*
 * Marker glyphs are a bookmark rather than a transport triangle, so the two
 * marker buttons cannot be mistaken for the two scene buttons sitting next to
 * them. The chevron carries the direction.
 */
const MarkerPrevIcon = () => (
  <Svg>
    <path d="M14 4H7a1 1 0 0 0-1 1v15l5-4 5 4V5a1 1 0 0 0-1-1Z" />
    <path d="M18 9.5 15 12l3 2.5" />
  </Svg>
);
const MarkerNextIcon = () => (
  <Svg>
    <path d="M10 4h7a1 1 0 0 1 1 1v15l-5-4-5 4V5a1 1 0 0 1 1-1Z" />
    <path d="M6 9.5 9 12l-3 2.5" />
  </Svg>
);
const MarkerAddIcon = () => (
  <Svg>
    <path d="M6 4h8a1 1 0 0 1 1 1v15l-5-4-5 4V5a1 1 0 0 1 1-1Z" />
    <path d="M18 8v6M15 11h6" />
  </Svg>
);

const MutedIcon = () => (
  <Svg>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
    <path d="m15 9.5 5 5M20 9.5l-5 5" />
  </Svg>
);
const SoundIcon = () => (
  <Svg>
    <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
    <path d="M14.5 9.5a3.5 3.5 0 0 1 0 5M17 7a7 7 0 0 1 0 10" />
  </Svg>
);
const DetailsIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.75v.5" />
  </Svg>
);
/* A level meter rather than ⓘ: Details is already the ⓘ, and these two
   buttons sit next to each other. */
const StatsIcon = () => (
  <Svg>
    <path d="M5 19v-6M10 19V8M15 19v-4M20 19V5" />
  </Svg>
);

/**
 * One rail button. `disabled` reaches both the DOM and the D-pad: a DOM-disabled
 * element is skipped as a navigation candidate (see findBestCandidate), which is
 * what stops a dimmed button from becoming an absorbing wall the cursor cannot
 * pass. That fix is recent, so the marker buttons are the first controls in the
 * app to rely on it.
 *
 * A missing handler disables the button too. That is for the caller's benefit,
 * not the user's: it keeps the rail from being handed a button that would do
 * nothing, so an action that has not been built yet cannot ship as a
 * dead-looking control.
 */
function RailButton({ id, label, disabled = false, active = false, onEnter, children }) {
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.railBtn,
        focused ? styles.focused : '',
        active ? styles.active : '',
      ].join(' ')}
      onClick={onEnter}
      disabled={disabled || !onEnter}
      aria-label={label}
    >
      {children}
    </button>
  );
}

const PlayerControlsRail = forwardRef(function PlayerControlsRail({
  playing,
  muted,
  hasMarkers,
  onPlayPause,
  onSkim,
  onPrevScene,
  onNextScene,
  onPrevMarker,
  onNextMarker,
  onAddMarker,
  onToggleMute,
  onDetails,
  statsOpen,
  onToggleStats,
}, ref) {
  // Held so the rail can be entered at play/pause specifically. The hook's
  // `focus` callback is stable across renders, so the handle below is built
  // once and never needs to be rebuilt.
  const playPause = useFocusable({
    id: 'player-rail-playpause',
    zone: ZONE,
    onEnter: onPlayPause,
  });

  const railElRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focusPlayPause: playPause.focus,
    /**
     * True while the cursor is anywhere on the rail.
     *
     * The player needs this to refuse to auto-hide the controls out from
     * under the user, and the alternative — the player reaching in for this
     * element itself — would mean the player knowing the rail's DOM. The rail
     * answers for itself instead.
     */
    holdsFocus: () => !!railElRef.current?.contains(document.activeElement),
  }), [playPause.focus]);

  return (
    <div ref={railElRef} className={styles.rail} role="toolbar" aria-label="Player controls">
      <RailButton id="player-rail-rew" label="Rewind 15 seconds" onEnter={() => onSkim(-15)}>
        <RewindIcon />
      </RailButton>

      {/*
        One button, two icons. See the header — this element's identity is what
        the three-press pause/resume sequence depends on.
      */}
      <button
        ref={playPause.ref}
        type="button"
        className={[styles.railBtn, playPause.focused ? styles.focused : ''].join(' ')}
        onClick={onPlayPause}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <RailButton id="player-rail-ff" label="Forward 15 seconds" onEnter={() => onSkim(15)}>
        <ForwardIcon />
      </RailButton>

      <span className={styles.sep} aria-hidden="true" />

      <RailButton id="player-rail-prev" label="Previous scene" onEnter={onPrevScene}>
        <PrevSceneIcon />
      </RailButton>
      <RailButton id="player-rail-next" label="Next scene" onEnter={onNextScene}>
        <NextSceneIcon />
      </RailButton>

      <span className={styles.sep} aria-hidden="true" />

      <RailButton
        id="player-rail-marker-prev"
        label="Previous marker"
        disabled={!hasMarkers}
        onEnter={onPrevMarker}
      >
        <MarkerPrevIcon />
      </RailButton>
      <RailButton id="player-rail-marker-add" label="Add marker" onEnter={onAddMarker}>
        <MarkerAddIcon />
      </RailButton>
      <RailButton
        id="player-rail-marker-next"
        label="Next marker"
        disabled={!hasMarkers}
        onEnter={onNextMarker}
      >
        <MarkerNextIcon />
      </RailButton>

      <span className={styles.sep} aria-hidden="true" />

      <RailButton
        id="player-rail-mute"
        label={muted ? 'Unmute' : 'Mute'}
        active={muted}
        onEnter={onToggleMute}
      >
        {muted ? <MutedIcon /> : <SoundIcon />}
      </RailButton>
      <RailButton id="player-rail-details" label="Details" onEnter={onDetails}>
        <DetailsIcon />
      </RailButton>
      {/* Toggle, not a one-shot: the panel stays up until it is turned off,
          so the button carries the state it is in. */}
      <RailButton
        id="player-rail-stats"
        label="Playback info"
        active={statsOpen}
        onEnter={onToggleStats}
      >
        <StatsIcon />
      </RailButton>
    </div>
  );
});

export default PlayerControlsRail;
