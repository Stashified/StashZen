import styles from '../VideoPlayer.module.css';

/**
 * The bar across the top of the overlay: close, title, source chip and queue
 * position. Presentational only — the shell owns the source decision and the
 * queue, and hands this the answers.
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
      {/* Direct or transcoded. The difference is otherwise invisible —
          a slow start and a seek that behaves differently have no
          explanation on screen, and "is the server doing work?" is not
          something the user should have to infer from the network. The
          hook names the source it actually resolved, so a fallback in
          either direction updates this chip.

          Deliberately not a live region. The player already has two
          `role="status"` lines (the sync chip and the marker toast), and a
          third, always-mounted one makes "the player's status line"
          ambiguous for both a screen reader and the harness. The chip is a
          label that changes, not an announcement. */}
      {sourceLabel && (
        <div
          className={`${styles.sourceChip} ${sourceKind === 'transcode' ? styles.sourceTranscode : ''}`}
        >
          {sourceLabel}
        </div>
      )}
      {/* Only worth showing when there is a queue to be a position in.
          `total` is the count the server reported, `items` what has
          actually been fetched — the same fallback the counter in
          VideoCarousel uses. */}
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
