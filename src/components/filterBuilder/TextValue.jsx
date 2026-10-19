import { useEditableField } from '../../hooks/useEditableField.js';
import styles from '../FilterBuilder.module.css';

// ── Value editors ─────────────────────────────────────────
export function TextValue({ id, value, onChange, numeric, placeholder,
                    zone = 'filter-builder', nextId = null }) {
  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id,
    zone,
    nextId,
  });

  return (
    <div
      ref={setWrapperRef}
      className={`${styles.value} ${selected ? styles.focused : ''} ${editing ? styles.editing : ''}`}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode={numeric ? 'numeric' : 'text'}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || (editing ? '' : 'Press Enter')}
        className={styles.valueInput}
        tabIndex={-1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        {...inputHandlers}
      />
    </div>
  );
}
