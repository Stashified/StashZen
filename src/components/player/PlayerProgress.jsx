import { memo } from 'react';
import styles from '../VideoPlayer.module.css';
import SkimPreview from '../SkimPreview.jsx';

/**
 * Marker ticks. Decorative, the rail's marker buttons are the keyboard path to
 * the same positions, and a span is not focusable.
 *
 * Memoised: the shell re-renders at timeupdate rate, and without this every
 * tick would be re-created and diffed on every beat. `markers` comes from
 * player state, so its identity only changes when the markers do.
 */
const MarkerTicks = memo(function MarkerTicks({ markers, duration }) {
  if (!(duration > 0)) return null;
  return markers.map(m => (
    <span
      key={m.id}
      className={styles.markerTick}
      style={{ left: `${(m.seconds / duration) * 100}%` }}
      aria-hidden="true"
    />
  ));
});

/**
 * The progress track: fill, marker ticks, playhead dot and skim preview. The
 * shell computes the percentage and owns the sprite cues; this draws them.
 *
 * The fill and the dot move by composited transform, not by `width`/`left`:
 * this subtree re-renders on every timeupdate (4 Hz) and every glide frame
 * (~30 fps), and those two properties would lay out and repaint the bar each
 * time.
 */
export function PlayerProgress({ progressPct, markers, duration, currentTime, cue, skimPreviewVisible }) {
  const pct = Number.isFinite(progressPct) ? Math.max(0, Math.min(100, progressPct)) : 0;
  return (
    <div className={styles.progressTrack}>
      <div className={styles.progressFill} style={{ transform: `scaleX(${pct / 100})` }} />
      <MarkerTicks markers={markers} duration={duration} />
      {/* The carrier box is full width so its percentage translate resolves
          against the track, not against the 16 px dot. */}
      <div className={styles.progressHead} style={{ transform: `translateX(${pct - 100}%)` }}>
        <div className={styles.progressDot} />
      </div>
      <SkimPreview
        cue={cue}
        time={currentTime}
        progressPct={pct}
        visible={skimPreviewVisible}
      />
    </div>
  );
}
