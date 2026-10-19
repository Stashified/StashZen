import styles from '../VideoPlayer.module.css';
import SkimPreview from '../SkimPreview.jsx';

/**
 * The progress track: fill, marker ticks, playhead dot and the skim preview.
 * The shell computes the percentage and owns the sprite cues; this draws them.
 */
export function PlayerProgress({ progressPct, markers, duration, currentTime, cue, skimPreviewVisible }) {
  return (
    <div className={styles.progressTrack}>
      <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
      {/* Marker ticks. Decorative here — the rail's marker buttons are
          the keyboard path to the same positions, and a span is not a
          control, so there is nothing for the D-pad to focus. */}
      {duration > 0 && markers.map(m => (
        <span
          key={m.id}
          className={styles.markerTick}
          style={{ left: `${(m.seconds / duration) * 100}%` }}
          aria-hidden="true"
        />
      ))}
      <div className={styles.progressDot} style={{ left: `${progressPct}%` }} />
      <SkimPreview
        cue={cue}
        time={currentTime}
        progressPct={progressPct}
        visible={skimPreviewVisible}
      />
    </div>
  );
}
