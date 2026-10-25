/**
 * PinPad — on-screen numeric keypad for the app lock, shared by the lock
 * screen (unlock), Settings (set/confirm/remove) and FirstRun's optional PIN
 * step, so the three cannot drift.
 *
 * ## Controls
 *   - D-pad + Enter: `1` takes focus on open; the even grid gives
 *     `findBestCandidate` the obvious order with no manual wiring.
 *   - Remote number keys, via the capture-phase listener below.
 *   - Backspace deletes one digit; Escape / hardware Back calls onCancel.
 *   - Enter is NOT handled globally: useFocusable already fires `onEnter` on
 *     the focused element, and a global handler would submit twice.
 *
 * ## onDecline
 * Renders one extra focusable action below the grid; the lock screen and
 * Settings pass nothing. FirstRun's PIN step needs it: Back returns to the
 * connection step and Skip returns here, so without a third exit the two form
 * a cycle. It lives *inside* this dialog because `modalScopeOf` scopes nav to
 * the nearest `role="dialog"`, making a sibling button unreachable.
 *
 * ## onSubmit contract
 * Must be SYNCHRONOUS and may return:
 *   - `true` / `undefined` — accepted; the caller takes it from here.
 *   - a `string`           — rejected; shown as the error line, the entry is
 *                            cleared, and focus stays on the keypad.
 * The entry is cleared either way. A Promise satisfies neither branch and
 * would read as "accepted"; the digest is a plain SHA-256 with no stretching,
 * so it stays sync.
 *
 * ## Focus trapping
 * Free: `modalScopeOf` walks up to the nearest `role="dialog"` and confines
 * spatial nav to it.
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
 * `e.key` is reliable ('0'-'9' for both number row and numpad); the 96-105
 * keyCode range is the fallback for engines that report numpad digits as
 * 'Unidentified'.
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
 * Same zone as the keys so Down from the bottom row reaches it by the same
 * geometric scoring. NOT a thirteenth grid cell: it leaves the pad rather than
 * entering a digit, and a key's shape would say otherwise.
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
  // One registry id namespace per instance: a Map collision between two
  // mounted pads would silently break nav.
  const uid = useId();

  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  // The entry also lives in a ref: the listener and a burst of held keys can
  // run before React re-renders, and a stale `pin` would drop or duplicate a
  // digit.
  const pinRef = useRef('');

  // Redundant while onSubmit is synchronous; kept so a stray double-press of
  // OK is inert.
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
      // Held keys and the final-digit auto-submit can race; never append past
      // the required length.
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
      // Never steal keys from a text field. Unreachable in practice since the
      // pad takes focus on open — a safety net, not a path.
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
        // One digit, not the whole entry. stopPropagation keeps the global
        // handler and the settings panel's Back handler from reading this as
        // "go back".
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

    // Capture phase: must win over useKeyHandler's bubble-phase listener and
    // the settings panel's capture-phase one (which its guard keeps clear).
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

        {/* Always mounted so the live region exists before it has text — a
            region added with its text is not reliably read out. */}
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
