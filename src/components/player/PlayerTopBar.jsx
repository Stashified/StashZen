import styles from '../VideoPlayer.module.css';
import { resolutionLabel } from '../../utils/format.js';

// The file's height, not the decoded stream's: Playback info already reports
// what the element is playing, and on a transcode that is the server's output.

/**
 * The bar across the top of the overlay: close, title, cast and studio, source
 * chip, file resolution and queue position. Presentational, the shell owns the
 * source decision and the queue.
 */
export function PlayerTopBar({ video, sourceKind, sourceLabel, itemsLength, total, index, onClose }) {
  const performers = video.performers || [];
  const resolution = resolutionLabel(video.height);

  return (
    <div className={styles.topBar}>
      <button className={styles.iconBtn} onClick={onClose} aria-label="Close player">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M18 8L8 18M8 8l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </button>
      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{video.title}</h2>
        {/* One line, ellipsised: a long cast must not wrap the bar or push the
            chips off screen. The cast is the brighter half because it is what
            a viewer scans for. */}
        {(performers.length > 0 || video.studio) && (
          <p className={styles.subtitle}>
            {performers.length > 0 && (
              <span className={styles.performers}>{performers.join(', ')}</span>
            )}
            {performers.length > 0 && video.studio && (
              <span className={styles.metaSep}> · </span>
            )}
            {video.studio && <span className={styles.studio}>{video.studio}</span>}
          </p>
        )}
      </div>
      {/* File resolution, beside the source chip: both describe this playback
          rather than the scene. Neutral, unlike the coloured transcode chip. */}
      {resolution && <div className={styles.resolutionChip}>{resolution}</div>}
      {/* Direct or transcoded: the difference is otherwise invisible on screen.
          Names the source actually resolved, so a fallback either way updates
          it. Deliberately not a live region: the player already has two
          `role="status"` lines, and a third always-mounted one would make "the
          player's status line" ambiguous. It is a label, not an announcement. */}
      {sourceLabel && (
        <div
          className={`${styles.sourceChip} ${sourceKind === 'transcode' ? styles.sourceTranscode : ''}`}
        >
          {sourceLabel}
        </div>
      )}
      {/* Only when there is a queue to be a position in. `total` is the server's
          count, `itemsLength` what has been fetched. */}
      {itemsLength > 1 && (
        <div className={styles.queueCounter}>
          <span className={styles.queueCur}>{index + 1}</span>
          <span className={styles.queueSep}>/</span>
          <span className={styles.queueTotal}>{total || itemsLength}</span>
        </div>
      )}
    </div>
  );
}
