/**
 * SearchInput, debounced text input for the controls panel.
 *
 * The draft updates per keystroke for feedback; onChange fires after a
 * debounce so the listing is not refetched on every key.
 *
 * The D-pad lands on the wrapper and Enter moves onto the input, raising the
 * TV's keyboard, so Left/Right move the caret only while editing. See
 * useEditableField.
 */

import { useState, useEffect, useRef } from 'react';
import { useEditableField } from '../hooks/useEditableField.js';
import styles from './SearchInput.module.css';

const DEBOUNCE_MS = 300;

export default function SearchInput({ value, onChange, placeholder = 'Search…' }) {
  const [draft, setDraft] = useState(value || '');
  const debounceRef = useRef(null);

  // An external reset (a tab change) must clear the pending debounce too, or
  // the timer fires the old tab's text into the new listing.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    setDraft(value || '');
  }, [value]);

  const commit = () => {
    clearTimeout(debounceRef.current);
    onChange(draft);
  };

  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id: 'ctrl-search',
    zone: 'controls',
    crossZone: true,
    // Enter flushes the pending search before the keyboard closes, making
    // "search now" and "I'm done typing" one gesture.
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
            onClick={() => {
              clearTimeout(debounceRef.current);
              setDraft('');
              onChange('');
            }}
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
