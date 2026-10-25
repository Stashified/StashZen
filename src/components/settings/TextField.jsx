import { useEditableField } from '../../hooks/useEditableField.js';
import styles from '../SettingsPanel.module.css';

// The D-pad selects the wrapper; Enter moves onto the input and only then does
// the TV keyboard appear. The reasoning and its two traps live in
// useEditableField.
export function TextField({ id, label, value, onChange, placeholder, type = 'text', externalRef }) {
  const labelId = `${id}-label`;
  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id,
    zone: 'settings',
    externalRef,
  });

  return (
    // A <div>, not a <label>: a label natively forwards activation to its
    // control, which would focus the input and raise the keyboard.
    <div
      ref={setWrapperRef}
      className={[
        styles.field,
        selected ? styles.focused : '',
        editing ? styles.editing : '',
      ].join(' ')}
    >
      <span className={styles.fieldLabel} id={labelId}>{label}</span>
      <input
        ref={inputRef}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={styles.input}
        tabIndex={-1}
        aria-labelledby={labelId}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...inputHandlers}
      />
      <span className={styles.fieldHint}>
        {editing ? 'Press Enter when done' : 'Press Enter to edit'}
      </span>
    </div>
  );
}
