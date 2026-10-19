import { useEffect, useRef, useState } from 'react';
import { ActionButton } from '../tvActions.jsx';
import { loadServerStatus, startLibraryScan } from '../../utils/serverService.js';
import { getSettings } from '../../utils/settings.js';
import { useSectionLoader } from '../../hooks/useSectionLoader.js';
import styles from '../SettingsPanel.module.css';

// ── Server status ─────────────────────────────────────────
const SERVER_STATUS_LABELS = {
  OK: 'OK',
  NEEDS_MIGRATION: 'Needs migration',
  SETUP: 'Setup required',
};

const JOB_STATUS_LABELS = {
  RUNNING: 'Running',
  READY: 'Queued',
  STOPPING: 'Stopping',
  FAILED: 'Failed',
};

export function ServerStatusSection() {
  const {
    phase, data: status, message, load, show, sectionRef,
  } = useSectionLoader(loadServerStatus, {
    emptyMessage: 'The server returned no status.',
  });

  // Starting a scan is its own phase: it must not borrow the status button's
  // label, and a failed scan must not wipe a snapshot that is already open.
  const [scanPhase, setScanPhase] = useState('idle'); // idle | starting | started | error
  const [scanMessage, setScanMessage] = useState('');
  const scanRef = useRef(0);

  useEffect(() => () => { scanRef.current += 1; }, []);

  const handleClick = () => {
    if (phase === 'loading') return;
    // Refresh is the point of this section: once a snapshot is on screen,
    // pressing again takes a new one rather than hiding it.
    if (phase === 'ready' || phase === 'error') { load(); return; }
    if (status) { show(); return; }
    load();
  };

  const label = phase === 'closed' ? 'Check server status'
    : phase === 'loading' ? 'Checking…'
    : phase === 'ready' ? 'Refresh'
    : 'Try again';

  // Starting a scan is one press that does two things: it enqueues the job,
  // then takes a fresh snapshot so the job and its progress appear without
  // the user having to find Refresh. The snapshot is read after the mutation
  // resolves, so Stash has already enqueued by the time it asks.
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
            status.jobs.map(job => {
              const pct = job.progress == null
                ? null
                : Math.max(0, Math.min(100, Math.round(job.progress * 100)));
              return (
                <div key={job.id} className={styles.jobRow}>
                  <div className={styles.jobMeta}>
                    <span className={styles.jobDescription}>{job.description}</span>
                    <span className={styles.jobStatus}>
                      {JOB_STATUS_LABELS[job.status] || job.status}
                      {pct != null ? ` · ${pct}%` : ''}
                    </span>
                  </div>
                  {pct != null && (
                    <div className={styles.jobTrack} aria-hidden="true">
                      <div className={styles.jobFill} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })
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
