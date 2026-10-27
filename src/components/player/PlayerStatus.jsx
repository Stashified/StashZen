import styles from '../VideoPlayer.module.css';

/**
 * The overlay-level status feedback: the skim flash, the buffering spinner and
 * the error state.
 *
 * Returns a fragment because these are positioned against the overlay and must
 * sit *outside* `.controls`, which fades to opacity 0 when the rail hides and
 * would take the spinner and error with it. The big ▶ is not here: it is the
 * flexible middle of `.controls`, and moving it would change the CSS nesting.
 */
export function PlayerStatus({ skimFlash, buffering, error }) {
  return (
    <>
      {skimFlash?.direction === 'backward' && (
        <div className={`${styles.skimFlash} ${styles.skimLeft}`}>
          <span className={styles.skimIcon}>⏪</span>
          <span className={styles.skimAmount}>−{skimFlash.seconds}s</span>
        </div>
      )}
      {skimFlash?.direction === 'forward' && (
        <div className={`${styles.skimFlash} ${styles.skimRight}`}>
          <span className={styles.skimIcon}>⏩</span>
          <span className={styles.skimAmount}>+{skimFlash.seconds}s</span>
        </div>
      )}

      {buffering && !error && (
        <div className={styles.buffering}>
          <div className={styles.spinner} />
        </div>
      )}

      {error && (
        <div className={styles.errorState}>
          <p>{error}</p>
          <p className={styles.errorHint}>Press Back to close</p>
        </div>
      )}
    </>
  );
}
