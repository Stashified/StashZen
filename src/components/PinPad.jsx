/**
 * PinPad — on-screen numeric keypad for the app lock
 *
 * Used in three places with identical behaviour: the lock screen (unlock),
 * the settings panel (set / confirm / remove), and since 0.12.0 the first-run
 * flow's optional PIN step. Factored out so they cannot drift apart.
 *
 * ## Controls
 *   - D-pad + Enter: the `1` key takes focus on open; the grid is evenly
 *     sized so `findBestCandidate`'s geometric scoring gives the obvious
 *     D-pad order with no manual wiring.
 *   - Remote number keys work too, via a capture-phase listener below.
 *   - Backspace deletes one digit. Escape / hardware Back calls onCancel.
 *   - Enter is deliberately NOT handled globally here: useFocusable already
 *     fires `onEnter` on the focused element (useFocusable.js:75-80), so
 *     adding a global Enter handler would submit twice.
 *
 * ## onDecline — an optional way out, and a correctness requirement where used
 * Passing `onDecline` renders one extra focusable action below the grid. The
 * lock screen and the settings section pass nothing and are unchanged.
 *
 * It exists because a caller can need an exit the pad has no other way to
 * offer. The first-run PIN step is that caller: Back returns to the connection
 * step, and the connection step's Skip returns here, so without a third option
 * the two steps form a cycle with no exit — and the pad has no button of its
 * own to put it on. Rendered *inside* this dialog rather than beside it,
 * because `modalScopeOf` scopes nav to the nearest enclosing `role="dialog"`,
 * so a sibling button would be unreachable from the pad.
 *
 * ## onSubmit contract
 * `onSubmit(pin)` must be SYNCHRONOUS and may return either:
 *   - `true` / `undefined` — accepted; the caller takes it from here
 *     (unlock, or advance to the confirm phase).
 *   - a `string`           — rejected; the string is shown as the error
 *     line, the entry is cleared, and focus stays on the keypad.
 * The entry is cleared either way. A Promise would satisfy neither branch
 * and would silently read as "accepted", which is why this must stay sync —
 * the digest is a plain SHA-256 with no stretching, so it is.
 *
 * ## Focus trapping
 * Free: `modalScopeOf` (useKeyHandler.js:40-47) walks up to the nearest
 * `role="dialog"`, and spatial nav is confined to it while this is open.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK, isTextInput } from '../utils/input.js';
import { PIN_LENGTH } from '../utils/appLock.js';
import styles from './PinPad.module.css';

// Row-major. `clear` and `ok` are actions, everything else is a digit.
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'ok'];

const LABELS = { clear: 'Clear', ok: 'OK' };

/**
 * The digit a keydown represents, or null.
 *
 * `e.key` is the reliable source ('0'-'9' for both the number row and the
 * numpad on any engine that implements it). The 96-105 keyCode range is a
 * fallback for engines that report numpad digits as 'Unidentified'.
 */
function digitFromEvent(e) {
  const k = e.key;
  if (typeof k === 'string' && k.length === 1 && k >= '0' && k <= '9') return k;
  const c = e.keyCode;
  if (c >= 96 && c <= 105) return String(c - 96);
  return null;
}

/**
 * The optional way out (see `onDecline` in the header).
 *
 * Same zone as the keys so the D-pad can reach it — `Down` from the bottom row
 * lands on it by the same geometric scoring the grid relies on. It is NOT a
 * thirteenth cell in that grid: it leaves the pad rather than entering a digit,
 * and giving it a key's shape would say otherwise.
 */
function DeclineButton({ id, label, onPress }) {
  const { ref, focused } = useFocusable({ id, zone: 'pinpad', onEnter: onPress });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.decline} ${focused ? styles.declineFocused : ''}`}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

function PinKey({ id, value, onPress, autoFocus }) {
  const label = LABELS[value] || value;
  const { ref, focused } = useFocusable({
    id,
    zone: 'pinpad',
    onEnter: () => onPress(value),
    autoFocus,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.key} ${focused ? styles.keyFocused : ''} ${LABELS[value] ? styles.keyAction : ''}`}
      onClick={() => onPress(value)}
      aria-label={label}
    >
      {label}
    </button>
  );
}

export default function PinPad({
  title = 'Enter PIN',
  subtitle,
  hint,
  length = PIN_LENGTH,
  onSubmit,
  onCancel,
  onDecline,
  declineLabel = 'Not now',
}) {
  // One registry id namespace per instance. Verified PINs are cheap to
  // compute but a Map collision between two mounted pads would silently
  // break nav, so the ids are unique rather than assumed-unique.
  const uid = useId();

  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  // The entry also lives in a ref: the window listener below and a burst
  // of held keys can both run before React re-renders, and reading `pin`
  // from a stale closure there would drop or duplicate a digit.
  const pinRef = useRef('');

  // Guards a second submit while one is in flight. Redundant while
  // onSubmit is synchronous, kept so a stray double-press of OK is inert.
  const submittingRef = useRef(false);

  // Latest props for the once-registered listeners below.
  const cbRef = useRef({});
  useEffect(() => { cbRef.current = { onSubmit, onCancel, length }; });

  const update = useCallback((value) => {
    pinRef.current = value;
    setPin(value);
  }, []);

  const press = useCallback((k) => {
    if (submittingRef.current) return;
    setError('');

    if (k === 'clear') {
      update('');
      return;
    }

    let next = pinRef.current;
    if (k !== 'ok') {
      // Held keys and the 4th-digit auto-submit can race; never append
      // past the required length.
      if (next.length >= length) return;
      next += k;
      update(next);
    }

    // OK with a partial entry does nothing — there is no half-submit.
    if (next.length !== length) return;

    submittingRef.current = true;
    let result;
    try {
      result = onSubmit?.(next);
    } finally {
      submittingRef.current = false;
    }
    update('');
    if (typeof result === 'string' && result) setError(result);
  }, [length, onSubmit, update]);

  const pressRef = useRef(press);
  useEffect(() => { pressRef.current = press; });

  useEffect(() => {
    const handler = (e) => {
      // Never steal keys from a text field. The pad takes focus on open,
      // so this should not be reachable — it is a safety net, not a path.
      if (isTextInput(e.target)) return;

      const digit = digitFromEvent(e);
      if (digit !== null) {
        // A held digit would otherwise fill the whole entry in one press.
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        pressRef.current(digit);
        return;
      }

      if (e.key === 'Backspace') {
        // Delete one digit, not the whole entry. stopPropagation keeps
        // the global handler (and the settings panel's own Back handler)
        // from reading this as "go back".
        e.preventDefault();
        e.stopPropagation();
        setError('');
        update(pinRef.current.slice(0, -1));
        return;
      }

      if (e.key === 'Escape' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        cbRef.current.onCancel?.();
      }
    };

    // Capture phase: this has to win over useKeyHandler's bubble-phase
    // listener, and over the settings panel's capture-phase one the guard
    // in SettingsPanel keeps out of the way.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [update]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </header>

        <div className={styles.dots} aria-hidden="true">
          {Array.from({ length }, (_, i) => (
            <span
              key={i}
              className={`${styles.dot} ${i < pin.length ? styles.dotFilled : ''}`}
            />
          ))}
        </div>

        {/* Always mounted so the live region exists before it has anything
            to announce — a region added at the same time as its text is
            not reliably read out. */}
        <p className={styles.error} role="status" aria-live="polite">{error}</p>

        <div className={styles.grid}>
          {KEYS.map((k, i) => (
            <PinKey
              key={k}
              id={`pin-key-${uid}-${k}`}
              value={k}
              onPress={press}
              autoFocus={i === 0}
            />
          ))}
        </div>

        {onDecline && (
          <DeclineButton id={`pin-decline-${uid}`} label={declineLabel} onPress={onDecline} />
        )}

        {hint && <p className={styles.hint}>{hint}</p>}
      </div>
    </div>
  );
}
