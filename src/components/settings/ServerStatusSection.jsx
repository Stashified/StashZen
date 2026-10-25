import { useEffect, useRef, useState } from 'react';
import { ActionButton } from '../tvActions.jsx';
import { loadServerStatus, startLibraryScan, stopJob } from '../../utils/serverService.js';
import { getSettings } from '../../utils/settings.js';
import { focusByIdWhenReady } from '../../utils/focus.js';
import { useSectionLoader } from '../../hooks/useSectionLoader.js';
import { ServerJobRow } from './ServerJobRow.jsx';
import styles from '../SettingsPanel.module.css';

const SERVER_STATUS_LABELS = {
  OK: 'OK',
  NEEDS_MIGRATION: 'Needs migration',
  SETUP: 'Setup required',
};

export function ServerStatusSection() {
  const {
    phase, data: status, message, load, show, sectionRef,
  } = useSectionLoader(loadServerStatus, {
    emptyMessage: 'The server returned no status.',
  });

  // Starting a scan is its own phase: it must not borrow the status button's
  // label, and a failed scan must not wipe an open snapshot.
  const [scanPhase, setScanPhase] = useState('idle'); // idle | starting | started | error
  const [scanMessage, setScanMessage] = useState('');
  const scanRef = useRef(0);

  // A third phase, separate from the scan's: both can be in flight and neither
  // message should overwrite the other. `id` keeps the other rows live.
  const [stopState, setStopState] = useState({ phase: 'idle', id: null, message: '' });
  const stopRef = useRef(0);

  useEffect(() => () => { scanRef.current += 1; stopRef.current += 1; }, []);

  const handleClick = () => {
    if (phase === 'loading') return;
    // Once a snapshot is on screen, pressing again takes a new one rather than
    // hiding it.
    if (phase === 'ready' || phase === 'error') { load(); return; }
    if (status) { show(); return; }
    load();
  };

  const label = phase === 'closed' ? 'Check server status'
    : phase === 'loading' ? 'Checking…'
    : phase === 'ready' ? 'Refresh'
    : 'Try again';

  // One press enqueues the job, then takes a fresh snapshot so its progress
  // appears without hunting for Refresh. Reading after the mutation resolves
  // guarantees Stash has enqueued.
  const handleScan = async () => {
    if (scanPhase === 'starting') return;
    const token = ++scanRef.current;
    setScanPhase('starting');
    setScanMessage('');
    try {
      await startLibraryScan();
      if (token !== scanRef.current) return;
      setScanPhase('started');
      setScanMessage(getSettings().useMock
        ? 'Test mode — sample data; no scan was started on a server.'
        : "Scan started with this server's saved scan options — progress appears below.");
      load();
    } catch (e) {
      if (token !== scanRef.current) return;
      setScanPhase('error');
      setScanMessage(e.message);
    }
  };

  // Stopping removes the row that holds focus. Move focus *before* load(): the
  // refresh unmounts the job body, leaving the D-pad with nowhere to start.
  const handleStop = async (job) => {
    if (stopState.phase === 'stopping') return;
    const token = ++stopRef.current;
    setStopState({ phase: 'stopping', id: job.id, message: '' });
    try {
      await stopJob(job.id);
      if (token !== stopRef.current) return;
      focusByIdWhenReady('settings-server');
      setStopState({
        phase: 'stopped',
        id: job.id,
        message: getSettings().useMock
          ? 'Test mode — the sample job was removed; no job was stopped on a server.'
          : `Stopping "${job.description}" — press Refresh if it is still listed.`,
      });
      load();
    } catch (e) {
      if (token !== stopRef.current) return;
      // The row keeps its place and focus: the user is one press from retrying,
      // and nothing was stopped.
      setStopState({ phase: 'error', id: job.id, message: e.message });
    }
  };

  return (
    <div className={styles.section} ref={sectionRef}>
      <div className={styles.sectionRow}>
        <div className={styles.sectionText}>
          <span className={styles.fieldLabel}>Server status</span>
          <p className={styles.sectionStatus}>
            Stash version, schema health and any running scan. Start a new scan here.
          </p>
        </div>
        <div className={styles.sectionActions}>
          <ActionButton id="settings-scan"
            label={scanPhase === 'starting' ? 'Starting…' : 'Scan library'}
            onClick={handleScan} />
          <ActionButton id="settings-server" label={label} onClick={handleClick} />
        </div>
      </div>

      <div
        className={`${styles.statNotice} ${scanPhase === 'error' ? styles.statError : ''}`}
        role="status"
        aria-live="polite"
      >
        {scanPhase === 'error'
          ? `Couldn't start a scan${scanMessage ? ` — ${scanMessage}` : ''}`
          : scanPhase === 'started' ? scanMessage : ''}
      </div>

      <div
        className={`${styles.statNotice} ${stopState.phase === 'error' ? styles.statError : ''}`}
        role="status"
        aria-live="polite"
      >
        {stopState.phase === 'error'
          ? `Couldn't stop the job${stopState.message ? ` — ${stopState.message}` : ''}`
          : stopState.phase === 'stopped' ? stopState.message : ''}
      </div>

      {phase === 'ready' && status && (
        <div className={styles.serverBody} role="group" aria-label="Server status">
          <div className={styles.serverHeadline}>
            Stash {status.version || 'unknown'}
            {' · '}
            {SERVER_STATUS_LABELS[status.status] || status.status || 'Unknown'}
          </div>

          {status.status && status.status !== 'OK' && (
            <div className={styles.serverSchema}>
              schema {status.databaseSchema ?? '?'} → {status.appSchema ?? '?'}
            </div>
          )}

          {status.jobs.length === 0 ? (
            <div className={styles.serverIdle}>No jobs running.</div>
          ) : (
            status.jobs.map(job => (
              <ServerJobRow
                key={job.id}
                job={job}
                stopping={stopState.phase === 'stopping' && stopState.id === job.id}
                onStop={handleStop}
                styles={styles}
              />
            ))
          )}
        </div>
      )}

      <div
        className={`${styles.statNotice} ${phase === 'error' ? styles.statError : ''}`}
        role="status"
        aria-live="polite"
      >
        {phase === 'error'
          ? `Couldn't load server status${message ? ` — ${message}` : ''}`
          : ''}
      </div>

      <p className={styles.hint}>
        A snapshot, not a live feed — press <strong>Refresh</strong> to update it.
        {' '}A scan uses the scan options saved on your Stash server (Settings → Tasks →
        Scan in Stash), so it generates whatever those options ask for.
      </p>
    </div>
  );
}
