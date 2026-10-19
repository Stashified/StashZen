/**
 * EntityPicker — choose entities for a multi-select criterion.
 *
 * NOT PORTALLED, AND THAT IS A REQUIREMENT RATHER THAN A STYLE. This renders
 * inside FilterBuilder's overlay, as a DOM child of it. `focusScopeOf` in
 * useKeyHandler walks up from the focused element and returns the *nearest*
 * enclosing `role="dialog"`, so a nested dialog wins and the D-pad is confined
 * to the picker. Render this through a portal instead and it lands in
 * <body> — outside the builder's dialog — where the scope is the outer one
 * again and the arrow keys walk the builder's rows behind an open picker.
 *
 * The stored shape is Stash's own: `[{id, label}]`. Labels are kept alongside
 * ids because that is what the saved filter carries, and it is what lets the
 * builder show "Blonde" when the user reopens a filter without a round trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { TIZEN_BACK } from '../utils/input.js';
import { searchEntities } from '../utils/entitySearch.js';
import styles from './FilterBuilder.module.css';

function ResultRow({ row, selected, onToggle }) {
  const { ref, focused } = useFocusable({
    id: `pick-${row.id}`,
    zone: 'entity-picker',
    onEnter: () => onToggle(row),
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.pickRow} ${selected ? styles.pickSelected : ''} ${focused ? styles.focused : ''}`}
      onClick={() => onToggle(row)}
      role="option"
      aria-selected={selected}
    >
      <span className={styles.pickMark} aria-hidden="true">{selected ? '✓' : ''}</span>
      <span className={styles.pickLabel}>{row.label}</span>
    </button>
  );
}

export default function EntityPicker({ title, entity, selected = [], onDone, onCancel }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(selected);

  // Search box. Same two-step select-then-edit as SettingsPanel's fields: the
  // D-pad selects the wrapper, Enter raises the TV's IME. Everything about why
  // lives in useEditableField.
  const { setWrapperRef, inputRef, selected: boxSelected, editing, inputHandlers } = useEditableField({
    id: 'pick-search',
    zone: 'entity-picker',
    // Opening the picker used to leave focus on the "Choose…" button behind
    // the overlay. Selecting the search box (not the input) is the right
    // landing spot: it is the picker's first control and Enter still decides
    // when the keyboard appears.
    autoFocus: true,
  });

  // Results are re-fetched per keystroke. The guard is the request id, not a
  // debounce: a debounce would still let a slow first response land after a
  // fast second one, which is the failure that shows the wrong list.
  const reqRef = useRef(0);
  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    searchEntities(entity, query)
      .then((list) => {
        if (reqRef.current !== id) return;
        setRows(list);
        setLoading(false);
      })
      .catch((e) => {
        if (reqRef.current !== id) return;
        setError(e.message || 'Could not reach Stash');
        setLoading(false);
      });
  }, [entity, query]);

  // Back closes the picker, not the builder.
  //
  // `stopPropagation` here is NOT what achieves that, and it is worth being
  // precise because the obvious reading is wrong: this listener is registered
  // *after* the builder's, so on a shared `window` capture target the
  // builder's runs first, and `stopPropagation` cannot suppress a sibling
  // listener on the same target anyway. What keeps the builder open is
  // FilterBuilder's own `overlayOpenRef` guard, which makes it stand down
  // while any nested layer is up. This handler is the one that actually acts.
  // Escape and the hardware Back always cancel; Backspace cancels only when
  // the picker is not in its text-entry mode. This is the picker's own rule —
  // `isBackKey`'s document-activeElement test is not a substitute for
  // `editing`, which is what the old handler keyed on.
  const pickerIsBack = useCallback(
    (e) => e.key === 'Escape' || e.keyCode === TIZEN_BACK
      || (e.key === 'Backspace' && !editing),
    [editing],
  );
  useBackKey(onCancel, { isBack: pickerIsBack });

  const isChosen = (row) => chosen.some((c) => String(c.id) === String(row.id));
  const toggle = (row) => {
    setChosen((prev) => (isChosen(row)
      ? prev.filter((c) => String(c.id) !== String(row.id))
      : [...prev, { id: String(row.id), label: row.label }]));
  };

  const { ref: doneRef, focused: doneFocused } = useFocusable({
    id: 'pick-done',
    zone: 'entity-picker',
    onEnter: () => onDone?.(chosen),
  });

  return (
    <div className={styles.pickOverlay} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.pickPanel}>
        <header className={styles.pickHeader}>
          <h3 className={styles.pickTitle}>{title}</h3>
          <span className={styles.pickCount}>
            {chosen.length ? `${chosen.length} selected` : 'None selected'}
          </span>
        </header>

        <div
          ref={setWrapperRef}
          className={`${styles.pickSearch} ${boxSelected ? styles.focused : ''} ${editing ? styles.editing : ''}`}
        >
          <span className={styles.pickSearchLabel}>Search</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a name"
            className={styles.pickInput}
            tabIndex={-1}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            {...inputHandlers}
          />
          <span className={styles.pickHint}>
            {editing ? 'Press Enter when done' : 'Press Enter to search'}
          </span>
        </div>

        <div className={styles.pickList} role="listbox" aria-multiselectable="true">
          {loading && <p className={styles.pickEmpty}>Searching…</p>}
          {!loading && error && <p className={styles.pickError}>{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className={styles.pickEmpty}>
              {query ? `Nothing matches “${query}”.` : 'Nothing here — this library has none.'}
            </p>
          )}
          {!loading && !error && rows.map((row) => (
            <ResultRow key={row.id} row={row} selected={isChosen(row)} onToggle={toggle} />
          ))}
        </div>

        <footer className={styles.pickFooter}>
          <button
            type="button"
            ref={doneRef}
            className={`${styles.btn} ${styles.btnPrimary} ${doneFocused ? styles.focused : ''}`}
            onClick={() => onDone?.(chosen)}
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
