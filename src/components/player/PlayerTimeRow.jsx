import { useSyncExternalStore } from 'react';
import styles from '../VideoPlayer.module.css';
import { formatTime } from '../../utils/format.js';
import { SYNC_LABEL } from './playerMessages.js';
import { SKIM_STEPS } from './constants.js';

/**
 * The save-status chip. Subscribes to its own store so a save cycle re-renders
 * this span, not the player (`syncChip.js`).
 *
 * `failed` is the point: a rejected write and a successful one would otherwise
 * look identical from the couch. The error is a tooltip only, the chip has to
 * stand on its own at couch distance.
 */
function SyncChip({ chip }) {
  const state = useSyncExternalStore(chip.subscribe, chip.getState);
  if (state === 'idle') return null;
  return (
    <span
      className={`${styles.syncChip} ${state === 'failed' ? styles.syncFailed : ''}`}
      role="status"
      aria-live="polite"
      title={chip.getError()?.message || undefined}
    >
      {SYNC_LABEL[state]}
    </span>
  );
}

/**
 * Elapsed time, the key hint, the sync chip and the total.
 *
 * `seekStep` is the setting frozen for this session. Adaptive names its first
 * rung, since that is what one press gives; the ladder after it is not a
 * number to print.
 */
export function PlayerTimeRow({ currentTime, duration, seekStep, syncChip }) {
  const step = typeof seekStep === 'number' ? seekStep : SKIM_STEPS[0];
  return (
    <div className={styles.timeRow}>
      <span className={styles.time}>{formatTime(currentTime, { padMinutes: true })}</span>
      <div className={styles.hint}>
        <kbd>OK</kbd> Controls &nbsp; <kbd>↑</kbd><kbd>↓</kbd> Prev/Next &nbsp;{' '}
        <kbd>←</kbd> −{step}s &nbsp; <kbd>→</kbd> +{step}s &nbsp; <kbd>Back</kbd> Exit
      </div>
      <SyncChip chip={syncChip} />
      <span className={styles.time}>{formatTime(duration, { padMinutes: true })}</span>
    </div>
  );
}
