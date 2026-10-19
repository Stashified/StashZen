import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SettingsPanel.module.css';

// ── Two-state toggle ─────────────────────────────────────
export function ModeToggle({ value, onChange }) {
  const { ref: testRef, focused: testFocused } = useFocusable({
    id: 'settings-mode-test',
    zone: 'settings',
    onEnter: () => onChange(true),
    autoFocus: true,
  });
  const { ref: liveRef, focused: liveFocused } = useFocusable({
    id: 'settings-mode-live',
    zone: 'settings',
    onEnter: () => onChange(false),
  });

  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>Mode</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label="Data source">
        <button
          ref={testRef}
          className={`${styles.toggle} ${value ? styles.toggleActive : ''} ${testFocused ? styles.focused : ''}`}
          onClick={() => onChange(true)}
          role="radio"
          aria-checked={value}
        >
          Test
        </button>
        <button
          ref={liveRef}
          className={`${styles.toggle} ${!value ? styles.toggleActive : ''} ${liveFocused ? styles.focused : ''}`}
          onClick={() => onChange(false)}
          role="radio"
          aria-checked={!value}
        >
          Live
        </button>
      </div>
    </div>
  );
}
