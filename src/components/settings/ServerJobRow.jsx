/**
 * ServerJobRow, one job in the Settings → Server snapshot.
 *
 * Its own component because Stop needs per-row state: a two-step confirm on
 * the list would arm every row. The row also receives `stopping` from the
 * section, which holds the request and its token.
 *
 * A job shows what it is, its progress, the first few subtasks, its start and,
 * for FAILED, why. `subTasks` are joined and ellipsised so a long scan does
 * not grow the row.
 *
 * Only RUNNING and READY get a Stop button; STOPPING is on its way out and
 * FAILED has nothing to stop.
 */

import { useArmedConfirm } from '../../hooks/useArmedConfirm.js';
import { ActionButton } from '../tvActions.jsx';
import { formatJobStart } from '../../utils/format.js';

const STOPPABLE = new Set(['RUNNING', 'READY']);
const MAX_SUBTASKS = 3;

const JOB_STATUS_LABELS = {
  RUNNING: 'Running',
  READY: 'Queued',
  STOPPING: 'Stopping',
  FAILED: 'Failed',
};

export function ServerJobRow({ job, stopping, onStop, styles }) {
  const [confirmingStop, runStop] = useArmedConfirm();

  const pct = job.progress == null
    ? null
    : Math.max(0, Math.min(100, Math.round(job.progress * 100)));
  const start = formatJobStart(job.startTime);
  const subTasks = job.subTasks.slice(0, MAX_SUBTASKS);

  // A press while the request is in flight neither arms nor commits; the row
  // survives until the refresh lands, and its label says so.
  const handleStop = () => {
    if (stopping) return;
    runStop(() => onStop(job));
  };

  return (
    <div className={styles.jobRow}>
      <div className={styles.jobMeta}>
        <span className={styles.jobDescription}>{job.description}</span>
        <span className={styles.jobStatus}>
          {JOB_STATUS_LABELS[job.status] || job.status}
          {pct != null ? ` · ${pct}%` : ''}
        </span>
      </div>

      {subTasks.length > 0 && (
        <div className={styles.jobSubtasks}>{subTasks.join(' · ')}</div>
      )}

      {start && <div className={styles.jobStart}>Started {start}</div>}

      {job.error && <div className={styles.jobError}>{job.error}</div>}

      {pct != null && (
        <div className={styles.jobTrack} aria-hidden="true">
          <div className={styles.jobFill} style={{ width: `${pct}%` }} />
        </div>
      )}

      {STOPPABLE.has(job.status) && (
        <div className={styles.jobFooter}>
          <ActionButton
            id={`settings-job-stop-${job.id}`}
            label={stopping ? 'Stopping…' : confirmingStop ? 'Press again to stop' : 'Stop'}
            onClick={handleStop}
          />
        </div>
      )}
    </div>
  );
}
