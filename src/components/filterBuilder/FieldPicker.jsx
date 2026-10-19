import { useEffect, useMemo, useState } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { TIZEN_BACK } from '../../utils/input.js';
import { criteriaFor } from '../../utils/filterCriteria.js';
import styles from '../FilterBuilder.module.css';

// ── Field chooser ─────────────────────────────────────────
export function FieldPicker({ filterType, used, onAdd, onClose }) {
  const [scope, setScope] = useState('common');
  const all = useMemo(() => criteriaFor(filterType), [filterType]);

  const shown = all.filter((c) => {
    if (scope === 'off') return !c.editor;
    if (!c.editor) return false;
    if (used.includes(c.field)) return false;
    return scope === 'common' ? c.common : true;
  });

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' || e.keyCode === TIZEN_BACK) {
        e.preventDefault(); e.stopPropagation(); onClose?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  // The dialog takes focus when it opens. These rows are plain buttons and had
  // no `autoFocus`, so opening the picker left focus on the "+ Add criterion"
  // button *behind* the overlay — the D-pad started each press on whatever the
  // geometry could reach through the dialog's scope, which was nothing.
  //
  // A disabled row (the "Unavailable" scope) cannot take focus, so fall back
  // to the tabs; they always exist.
  const firstField = shown.find(c => c.editor)?.field ?? null;

  return (
    <div className={styles.pickOverlay} role="dialog" aria-modal="true" aria-label="Add a criterion">
      <div className={styles.pickPanel}>
        <header className={styles.pickHeader}>
          <h3 className={styles.pickTitle}>Add a criterion</h3>
        </header>

        <div className={styles.tabs} role="tablist">
          {[['common', 'Common'], ['all', 'All fields'], ['off', 'Unavailable']].map(([k, l]) => (
            <FieldTab
              key={k}
              id={`fp-tab-${k}`}
              label={l}
              active={scope === k}
              onClick={() => setScope(k)}
              autoFocus={!firstField && k === 'common'}
            />
          ))}
        </div>

        <div className={styles.pickList} role="listbox">
          {shown.length === 0 && (
            <p className={styles.pickEmpty}>
              {scope === 'off' ? 'Everything is available.' : 'Nothing left to add here.'}
            </p>
          )}
          {shown.map((c) => (
            <FieldRow
              key={c.field}
              desc={c}
              onAdd={() => onAdd(c)}
              autoFocus={c.field === firstField}
            />
          ))}
        </div>

        <footer className={styles.pickFooter}>
          <span className={styles.pickHint}>Back closes this list</span>
        </footer>
      </div>
    </div>
  );
}

function FieldTab({ id, label, active, onClick, autoFocus = false }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'field-picker-tabs',
    onEnter: onClick,
    autoFocus,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.tab} ${active ? styles.tabActive : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      role="tab"
      aria-selected={active}
    >
      {label}
    </button>
  );
}

function FieldRow({ desc, onAdd, autoFocus = false }) {
  const { ref, focused } = useFocusable({
    id: `fp-${desc.field}`,
    zone: 'field-picker',
    onEnter: () => { if (desc.editor) onAdd(); },
    disabled: !desc.editor,
    autoFocus,
  });

  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.pickRow} ${focused && desc.editor ? styles.focused : ''} ${!desc.editor ? styles.pickDisabled : ''}`}
      onClick={() => { if (desc.editor) onAdd(); }}
      disabled={!desc.editor}
      role="option"
      aria-selected={false}
    >
      <span className={styles.pickLabel}>{desc.label}</span>
      <span className={styles.pickWhy}>{desc.reason || desc.field}</span>
    </button>
  );
}
