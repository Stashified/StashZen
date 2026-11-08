import { useFocusable } from '../../hooks/useFocusable.js';
import { TRANSCODE_QUALITY_OPTIONS } from '../../utils/settings.js';
import styles from '../SettingsPanel.module.css';

export function TranscodeQualityToggle({ value, onChange }) {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>Transcode quality</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label="Transcode quality">
        {TRANSCODE_QUALITY_OPTIONS.map(opt => (
          <QualityOption
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

function QualityOption({ option, selected, onSelect }) {
  const { ref, focused } = useFocusable({
    id: `settings-quality-${option.value}`,
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
