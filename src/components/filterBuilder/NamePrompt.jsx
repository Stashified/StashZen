import { useFocusable } from '../../hooks/useFocusable.js';
import { useEditableField } from '../../hooks/useEditableField.js';
import { useBackKey } from '../../hooks/useBackKey.js';
import { isHardBackKey } from '../../utils/input.js';
import styles from '../FilterBuilder.module.css';

export function NamePrompt({ value, onChange, onConfirm, onCancel, saving, error }) {
  // Focus the wrapper, not the input, so the TV keyboard still waits for Enter.
  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id: 'fb-name',
    zone: 'fb-name-prompt',
    autoFocus: true,
  });

  // Escape and the hardware Back only, Backspace stays inert, as it was.
  // A save in flight cannot be cancelled: tearing the prompt down would hide
  // the failure and keep the save, whose reply closes the builder anyway.
  useBackKey(() => { if (!saving) onCancel?.(); }, { isBack: isHardBackKey });

  const { ref: okRef, focused: okFocused } = useFocusable({
    id: 'fb-name-ok',
    zone: 'fb-name-prompt',
    onEnter: () => { if (value.trim() && !saving) onConfirm?.(); },
  });
  const { ref: noRef, focused: noFocused } = useFocusable({
    id: 'fb-name-cancel',
    zone: 'fb-name-prompt',
    onEnter: () => { if (!saving) onCancel?.(); },
  });

  return (
    <div className={styles.pickOverlay} role="dialog" aria-modal="true" aria-label="Save filter">
      <div className={styles.pickPanel}>
        <header className={styles.pickHeader}>
          <h3 className={styles.pickTitle}>Save filter</h3>
          <span className={styles.pickCount}>Saved to Stash, for every device.</span>
        </header>

        <div
          ref={setWrapperRef}
          className={`${styles.pickSearch} ${selected ? styles.focused : ''} ${editing ? styles.editing : ''}`}
        >
          <span className={styles.pickSearchLabel}>Name</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Name this filter"
            className={styles.pickInput}
            tabIndex={-1}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            {...inputHandlers}
          />
          <span className={styles.pickHint}>
            {editing ? 'Press Enter when done' : 'Press Enter to name it'}
          </span>
        </div>

        {error && <p className={styles.pickError}>{error}</p>}

        <footer className={styles.pickFooter}>
          <button
            type="button"
            ref={noRef}
            className={`${styles.btn} ${noFocused ? styles.focused : ''}`}
            onClick={() => { if (!saving) onCancel?.(); }}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={okRef}
            className={`${styles.btn} ${styles.btnPrimary} ${okFocused ? styles.focused : ''}`}
            onClick={() => { if (value.trim() && !saving) onConfirm?.(); }}
            disabled={!value.trim() || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
