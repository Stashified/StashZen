import styles from '../VideoPlayer.module.css';

/**
 * The overlay-level status feedback: the skim flash, the buffering spinner and
 * the error state.
 *
 * Returns a fragment on purpose. These three are absolutely positioned against
 * the overlay and must sit *outside* `.controls` — that element fades to
 * opacity 0 when the rail hides itself, which would take the spinner and the
 * error message with it.
 *
 * The big ▶ is not here: it is the flexible middle of `.controls`, a layout
 * element rather than a status line, and moving it would change the nesting
 * its CSS depends on.
 */
export function PlayerStatus({ skimFlash, buffering, error, skipSeconds }) {
  return (
    <>
      {skimFlash === 'backward' && (
        <div className={`${styles.skimFlash} ${styles.skimLeft}`}>
          <span className={styles.skimIcon}>⏪</span>
          <span className={styles.skimAmount}>−{skipSeconds}s</span>
        </div>
      )}
      {skimFlash === 'forward' && (
        <div className={`${styles.skimFlash} ${styles.skimRight}`}>
          <span className={styles.skimIcon}>⏩</span>
          <span className={styles.skimAmount}>+{skipSeconds}s</span>
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
