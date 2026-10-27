import styles from '../VideoPlayer.module.css';

/**
 * The bar across the top of the overlay: close, title, source chip and queue
 * position. Presentational, the shell owns the source decision and the queue.
 */
export function PlayerTopBar({ video, sourceKind, sourceLabel, itemsLength, total, index, onClose }) {
  return (
    <div className={styles.topBar}>
      <button className={styles.iconBtn} onClick={onClose} aria-label="Close player">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M18 8L8 18M8 8l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </button>
      <div className={styles.titleBlock}>
        <h2 className={styles.title}>{video.title}</h2>
        {video.studio && <p className={styles.subtitle}>{video.studio}</p>}
      </div>
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
