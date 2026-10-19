/**
 * SearchInput — Debounced text input for the controls panel.
 *
 * The input value reflects what the user is typing (snappy feedback),
 * but onChange fires only after a debounce window so we don't refetch
 * on every keystroke.
 *
 * The field is selected before it can be typed in — the D-pad lands on the
 * wrapper and Enter moves focus onto the input, which is what raises the
 * TV's on-screen keyboard. So Left/Right move the caret only once the field
 * is being edited; before that they navigate, as they do on any other
 * control. See useEditableField.
 */

import { useState, useEffect, useRef } from 'react';
import { useEditableField } from '../hooks/useEditableField.js';
import styles from './SearchInput.module.css';

const DEBOUNCE_MS = 300;

export default function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  const [draft, setDraft] = useState(value || '');
  const debounceRef = useRef(null);

  // External value resets (e.g. tab change) should reset the draft.
  useEffect(() => { setDraft(value || ''); }, [value]);

  const commit = () => {
    clearTimeout(debounceRef.current);
    onChange(draft);
  };

  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id: 'ctrl-search',
    zone: 'controls',
    crossZone: true,
    // Enter while editing flushes the pending search before the keyboard
    // closes. Nothing waits on Enter any more — the field is debounce-driven
    // and Enter's only job was shortcutting the 300ms window — so this just
    // makes "search now" and "I'm done typing" the same gesture.
    onCommit: commit,
  });

  const handleChange = (e) => {
    const next = e.target.value;
    setDraft(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(next), DEBOUNCE_MS);
  };

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const showClear = draft.length > 0;

  return (
    <div className={styles.control}>
      <span className={styles.controlLabel}>Search</span>
      <div
        ref={setWrapperRef}
        className={[
          styles.inputWrap,
          selected ? styles.focused : '',
          editing ? styles.editing : '',
        ].join(' ')}
      >
        <svg className={styles.icon} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={handleChange}
          placeholder={placeholder}
          className={styles.input}
          tabIndex={-1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          {...inputHandlers}
        />
        {showClear && (
          <button
            className={styles.clearBtn}
            onClick={() => { setDraft(''); onChange(''); }}
            aria-label="Clear search"
            tabIndex={-1}
          >×</button>
        )}
      </div>
      <span className={`${styles.hint} ${selected && !editing ? styles.hintOn : ''}`}>
        Press Enter to edit
      </span>
    </div>
  );
}
