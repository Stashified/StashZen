import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SettingsPanel.module.css';

// Same radio shape as ThemeToggle; the values are enginePolicy.js's persisted
// `PLAYBACK_ENGINES`. Auto (default) is browser first, TV engine for what it
// cannot take; TV player puts AVPlay first as an on-panel A/B; Browser is the
// rollback lever.
export function EngineToggle({ value, onChange, forcedBrowser = false }) {
  const { ref: autoRef, focused: autoFocused } = useFocusable({
    id: 'settings-engine-auto',
    zone: 'settings',
    onEnter: () => onChange('auto'),
  });
  const { ref: tvRef, focused: tvFocused } = useFocusable({
    id: 'settings-engine-tv',
    zone: 'settings',
    onEnter: () => onChange('tv'),
  });
  const { ref: browserRef, focused: browserFocused } = useFocusable({
    id: 'settings-engine-browser',
    zone: 'settings',
    onEnter: () => onChange('browser'),
  });

  // A forced-browser build has no lever to offer: a radio that changes nothing
  // would misrepresent the build. The name still shows so the row does not
  // vanish.
  if (forcedBrowser) {
    return (
      <div className={styles.toggleRow}>
        <span className={styles.fieldLabel}>Playback engine</span>
        <div className={styles.toggleGroup} aria-label="Playback engine">
          <span className={`${styles.toggle} ${styles.toggleActive}`}>Browser</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>Playback engine</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label="Playback engine">
        <button
          ref={autoRef}
          className={`${styles.toggle} ${value === 'auto' ? styles.toggleActive : ''} ${autoFocused ? styles.focused : ''}`}
          onClick={() => onChange('auto')}
          role="radio"
          aria-checked={value === 'auto'}
        >
          Auto
        </button>
        <button
          ref={tvRef}
          className={`${styles.toggle} ${value === 'tv' ? styles.toggleActive : ''} ${tvFocused ? styles.focused : ''}`}
          onClick={() => onChange('tv')}
          role="radio"
          aria-checked={value === 'tv'}
        >
          TV player
        </button>
        <button
          ref={browserRef}
          className={`${styles.toggle} ${value === 'browser' ? styles.toggleActive : ''} ${browserFocused ? styles.focused : ''}`}
          onClick={() => onChange('browser')}
          role="radio"
          aria-checked={value === 'browser'}
        >
          Browser
        </button>
      </div>
    </div>
  );
}
