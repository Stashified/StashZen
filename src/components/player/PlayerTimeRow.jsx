import styles from '../VideoPlayer.module.css';
import { formatTime } from '../../utils/format.js';
import { SYNC_LABEL } from './playerMessages.js';

/**
 * Elapsed time, the key hint, the sync chip and the total.
 *
 * `syncState` is `idle | saving | saved | failed`; `syncError` is the last
 * rejected write's message. The error is a tooltip only — the chip has to stand
 * on its own at couch distance.
 */
export function PlayerTimeRow({ currentTime, duration, syncState, syncError }) {
  return (
    <div className={styles.timeRow}>
      <span className={styles.time}>{formatTime(currentTime, { padMinutes: true })}</span>
      <div className={styles.hint}>
        <kbd>OK</kbd> Controls &nbsp; <kbd>↑</kbd><kbd>↓</kbd> Prev/Next &nbsp; <kbd>←</kbd> −15s &nbsp; <kbd>→</kbd> +15s &nbsp; <kbd>Back</kbd> Exit
      </div>
      {/* Only mounted when there is something to say. `failed` is the point: a
          rejected write and a successful one would otherwise look identical
          from the couch. */}
      {syncState !== 'idle' && (
        <span
          className={`${styles.syncChip} ${syncState === 'failed' ? styles.syncFailed : ''}`}
          role="status"
          aria-live="polite"
          title={syncError || undefined}
        >
          {SYNC_LABEL[syncState]}
        </span>
      )}
      <span className={styles.time}>{formatTime(duration, { padMinutes: true })}</span>
    </div>
  );
}
