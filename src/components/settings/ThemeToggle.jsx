import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SettingsPanel.module.css';

// ── Appearance theme ─────────────────────────────────────
// The same two-state shape as ModeToggle. Values are the persisted vocabulary
// in settings.js (`THEMES`); Standard is the absence of `data-theme`, so it is
// not a third state to model here.
export function ThemeToggle({ value, onChange }) {
  const { ref: standardRef, focused: standardFocused } = useFocusable({
    id: 'settings-theme-standard',
    zone: 'settings',
    onEnter: () => onChange('standard'),
  });
  const { ref: oledRef, focused: oledFocused } = useFocusable({
    id: 'settings-theme-oled',
    zone: 'settings',
    onEnter: () => onChange('oled'),
  });

  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>Theme</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label="Theme">
        <button
          ref={standardRef}
          className={`${styles.toggle} ${value === 'standard' ? styles.toggleActive : ''} ${standardFocused ? styles.focused : ''}`}
          onClick={() => onChange('standard')}
          role="radio"
          aria-checked={value === 'standard'}
        >
          Standard
        </button>
        <button
          ref={oledRef}
          className={`${styles.toggle} ${value === 'oled' ? styles.toggleActive : ''} ${oledFocused ? styles.focused : ''}`}
          onClick={() => onChange('oled')}
          role="radio"
          aria-checked={value === 'oled'}
        >
          OLED
        </button>
      </div>
    </div>
  );
}
