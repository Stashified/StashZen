import { useFocusable } from '../../hooks/useFocusable.js';
import { SEEK_STEP_OPTIONS } from '../../utils/settings.js';
import styles from '../SettingsPanel.module.css';

export function SeekStepToggle({ value, onChange }) {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>Seek step</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label="Seek step">
        {SEEK_STEP_OPTIONS.map(opt => (
          <SeekOption
            key={opt.value}
            option={opt}
            selected={value === opt.value}
            onSelect={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function SeekOption({ option, selected, onSelect }) {
  const { ref, focused } = useFocusable({
    id: `settings-seek-${option.value}`,
    zone: 'settings',
    onEnter: () => onSelect(option.value),
  });
  return (
    <button
      ref={ref}
      className={[
        styles.toggle,
        styles.toggleCompact,
        selected ? styles.toggleActive : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={() => onSelect(option.value)}
      role="radio"
      aria-checked={selected}
    >
      {option.label}
    </button>
  );
}
