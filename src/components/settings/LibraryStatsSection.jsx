import { ActionButton } from '../tvActions.jsx';
import { loadLibraryStats } from '../../utils/statsService.js';
import { formatBytes, formatCount, formatHours } from '../../utils/format.js';
import { useSectionLoader } from '../../hooks/useSectionLoader.js';
import styles from '../SettingsPanel.module.css';

// Read-only aggregates. The tiles are inert on purpose: focusable display would
// add twelve dead D-pad stops to a modal the user is navigating.
const STAT_TILES = (stats) => [
  { key: 'scenes',     label: 'Scenes',       value: formatCount(stats.sceneCount) },
  { key: 'images',     label: 'Images',       value: formatCount(stats.imageCount) },
  { key: 'galleries',  label: 'Galleries',    value: formatCount(stats.galleryCount) },
  { key: 'performers', label: 'Performers',   value: formatCount(stats.performerCount) },
  { key: 'studios',    label: 'Studios',      value: formatCount(stats.studioCount) },
  { key: 'tags',       label: 'Tags',         value: formatCount(stats.tagCount) },
  { key: 'storage',    label: 'Storage',      value: formatBytes(stats.totalBytes) },
  { key: 'video',      label: 'Video',        value: formatHours(stats.sceneSeconds) },
  { key: 'watched',    label: 'Watched',      value: formatHours(stats.playSeconds) },
  { key: 'plays',      label: 'Plays',        value: formatCount(stats.playCount) },
  { key: 'played',     label: 'Scenes played', value: formatCount(stats.scenesPlayed) },
  { key: 'o-count',    label: 'O-count',      value: formatCount(stats.oCount) },
];

export function LibraryStatsSection() {
  const {
    phase, data: stats, message, load, show, hide, sectionRef,
  } = useSectionLoader(loadLibraryStats, {
    emptyMessage: 'The server returned no statistics.',
  });

  const handleClick = () => {
    if (phase === 'loading') return;
    if (phase === 'ready') { hide(); return; }   // hide; keep the answer
    if (phase === 'closed' && stats) { show(); return; } // show again; no refetch
    load();
  };

  const label = phase === 'closed' ? 'Show library stats'
    : phase === 'loading' ? 'Loading…'
    : phase === 'ready' ? 'Hide library stats'
    : 'Try again';

  return (
    <div className={styles.section} ref={sectionRef}>
      <div className={styles.sectionRow}>
        <div className={styles.sectionText}>
          <span className={styles.fieldLabel}>Library stats</span>
          <p className={styles.sectionStatus}>
            Counts, storage and watch time across the whole library.
          </p>
        </div>
        <div className={styles.sectionActions}>
          <ActionButton id="settings-stats" label={label} onClick={handleClick} />
        </div>
      </div>

      {phase === 'ready' && stats && (
        <div className={styles.statGrid} role="group" aria-label="Library stats">
          {STAT_TILES(stats).map(tile => (
            <div key={tile.key} className={styles.statTile}>
              <span className={styles.statValue}>{tile.value}</span>
              <span className={styles.statLabel}>{tile.label}</span>
            </div>
          ))}
        </div>
      )}

      <div
        className={`${styles.statNotice} ${phase === 'error' ? styles.statError : ''}`}
        role="status"
        aria-live="polite"
      >
        {phase === 'error'
          ? `Couldn't load library stats${message ? ` — ${message}` : ''}`
          : ''}
      </div>

      <p className={styles.hint}>
        Reads the saved connection — unsaved edits above are not used.
      </p>
    </div>
  );
}
