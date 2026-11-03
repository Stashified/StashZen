/**
 * SearchInput, debounced text input for the controls panel.
 *
 * The draft updates per keystroke for feedback; onChange fires after a
 * debounce so the listing is not refetched on every key. Enter flushes the
 * pending term immediately.
 *
 * The D-pad lands on the wrapper and Enter moves onto the input, raising the
 * TV's keyboard, so Left/Right move the caret only while editing. See
 * useEditableField. With a term entered, Right reaches the clear button: it is
 * a focusable of its own, not a mouse-only affordance.
 */

import { useState, useEffect, useRef } from 'react';
import { useEditableField } from '../hooks/useEditableField.js';
import { useFocusable } from '../hooks/useFocusable.js';
import styles from './SearchInput.module.css';

// TV typing is slower than a keyboard's; a shorter window let one keystroke in
// between commits and refreshed the grid per letter.
const DEBOUNCE_MS = 500;

export default function SearchInput({
  value, onChange, placeholder = 'Search…', resetKey = null,
}) {
  const [draft, setDraft] = useState(value || '');
  const debounceRef = useRef(null);
  // The last term handed to the parent. The value effect must ignore that
  // echo: it arrives while the user may already have typed more, and resetting
  // the draft to the snapshot would drop those characters.
  const lastSentRef = useRef(value || '');

  // An external reset (a tab change) must clear the pending debounce too, or
  // the timer fires the old tab's text into the new listing.
  useEffect(() => {
    const next = value || '';
    if (next === lastSentRef.current) return;
    lastSentRef.current = next;
    clearTimeout(debounceRef.current);
    setDraft(next);
  }, [value]);

  // A tab change resets the parent's term to '' either way, so the value effect
  // above cannot tell that apart from an echo of the last commit. The section
  // is the signal: on arrival, drop the draft and the timer that would fire the
  // old tab's text into the new listing.
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    setDraft(value || '');
    lastSentRef.current = value || '';
  }, [resetKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const send = (next) => {
    lastSentRef.current = next;
    onChange(next);
  };

  const commit = () => {
    clearTimeout(debounceRef.current);
    send(draft);
  };

  const { setWrapperRef, inputRef, selected, editing, focusWrapper, inputHandlers } = useEditableField({
    id: 'ctrl-search',
    zone: 'controls',
    crossZone: true,
    // Enter flushes the pending search before the keyboard closes, making
    // "search now" and "I'm done typing" one gesture.
    onCommit: commit,
    // With a term entered, Right goes to the clear button rather than the
    // next control; the button declares the matching Left edge.
    nextId: draft.length > 0 ? { right: 'ctrl-search-clear' } : null,
  });

  const handleChange = (e) => {
    const next = e.target.value;
    setDraft(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => send(next), DEBOUNCE_MS);
  };

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // The button unmounts with the term, so focus goes back to the wrapper it
  // was inside; otherwise it would drop to <body>.
  const clear = () => {
    clearTimeout(debounceRef.current);
    setDraft('');
    lastSentRef.current = '';
    onChange('');
    focusWrapper();
  };

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
        {draft.length > 0 && <ClearSearchButton onClear={clear} />}
      </div>
      <span className={`${styles.hint} ${selected && !editing ? styles.hintOn : ''}`}>
        Press Enter to edit
      </span>
    </div>
  );
}

/**
 * Mounted only with a term, so its own registration effect runs with the
 * button already in the DOM; useFocusable registers on mount.
 */
function ClearSearchButton({ onClear }) {
  const { ref, focused } = useFocusable({
    id: 'ctrl-search-clear',
    zone: 'controls',
    onEnter: onClear,
    nextId: { left: 'ctrl-search' },
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.clearBtn} ${focused ? styles.clearFocused : ''}`}
      onClick={onClear}
      aria-label="Clear search"
    >×</button>
  );
}
