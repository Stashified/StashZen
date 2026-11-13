/**
 * A settings row of compact radios built from an options list.
 *
 * Seek step, transcode quality and slideshow interval differ only in their
 * label, id prefix and options; each carried a copy of this markup.
 *
 * Options are `{ value, label }`, the shape the settings module's validators
 * already use. The focus id is `<idPrefix>-<value>`; the harness and the
 * saved-focus restore both rely on it.
 */

import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SettingsPanel.module.css';

export default function OptionToggle({ label, idPrefix, options, value, onChange }) {
  return (
    <div className={styles.toggleRow}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.toggleGroup} role="radiogroup" aria-label={label}>
        {options.map(opt => (
          <Option
            key={opt.value}
            id={`${idPrefix}-${opt.value}`}
            option={opt}
            selected={value === opt.value}
            onSelect={onChange}
          />
        ))}
      </div>
    </div>
  );
}

function Option({ id, option, selected, onSelect }) {
  const { ref, focused } = useFocusable({
    id,
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
