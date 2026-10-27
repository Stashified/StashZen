/**
 * EntityPicker, choose entities for a multi-select criterion.
 *
 * NOT PORTALLED. `focusScopeOf` returns the *nearest* enclosing
 * `role="dialog"`, so as a DOM child of FilterBuilder this dialog confines the
 * D-pad to the picker. Portalled into <body> the scope would be the builder
 * again, and the arrows would walk its rows behind the picker.
 *
 * The stored shape is Stash's own `[{id, label}]`: labels let the builder show
 * "Blonde" when a filter is reopened, without a round trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { isBackCode } from '../utils/input.js';
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

  // Search box: the same select-then-edit field as SettingsPanel's, see
  // useEditableField. Select the wrapper (not the input) so it is the picker's
  // first landing spot; Enter still decides when the IME appears.
  const { setWrapperRef, inputRef, selected: boxSelected, editing, inputHandlers } = useEditableField({
    id: 'pick-search',
    zone: 'entity-picker',
    autoFocus: true,
  });

  // Re-fetched per keystroke. The guard is a request id, not a debounce: a
  // debounce still lets a slow first response land after a fast second one.
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

  // Back closes the picker, not the builder: this listener registers after the
  // builder's, so the builder's runs first, and FilterBuilder's `overlayOpenRef`
  // guard stands down while a nested layer is up, not any `stopPropagation`
  // here. Backspace cancels only outside text-entry mode, tested by the picker's
  // own `editing` flag rather than `isBackKey`'s activeElement heuristic.
  const pickerIsBack = useCallback(
    (e) => e.key === 'Escape' || isBackCode(e.keyCode)
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
              {query ? `Nothing matches “${query}”.` : 'Nothing here: this library has none.'}
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
