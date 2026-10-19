/**
 * ServerJobRow — one job in the Settings → Server snapshot.
 *
 * Extracted from ServerStatusSection because Stop needs state of its own: a
 * two-step confirm must belong to a row, not to the list, or arming one job
 * would arm the button on another. The row also keeps its own in-flight flag
 * from the section (`stopping`), because the section is the one holding the
 * request and its token.
 *
 * What a job says, in the order it matters: what it is, how far along, what
 * it is doing right now (the first few subtasks), when it started, and — for a
 * FAILED job — why. Stash's `subTasks` are already user-facing prose; they are
 * joined on one line and ellipsised, because a scan can report a long list and
 * the row must not grow with it.
 *
 * Only RUNNING and READY get a Stop button. STOPPING is already on its way
 * out, and FAILED has nothing left to stop.
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

  // A press while the request is in flight neither arms nor commits. The row
  // is still on screen until the refresh lands, and the label says why it is
  // ignoring the press.
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
