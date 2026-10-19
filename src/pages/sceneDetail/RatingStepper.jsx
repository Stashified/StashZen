import { useFocusable } from '../../hooks/useFocusable.js';
import styles from '../SceneDetailPage.module.css';

// ── Rating stepper ──────────────────────────────────────────
export function RatingStepper({ rating100, disabled, onChange }) {
  const stars = Math.max(0, Math.min(10, Math.round((rating100 || 0) / 10)));
  const dec = useFocusable({
    id: 'scene-rating-dec',
    zone: 'scene-detail',
    onEnter: () => onChange(Math.max(0, stars - 1)),
  });
  const inc = useFocusable({
    id: 'scene-rating-inc',
    zone: 'scene-detail',
    onEnter: () => onChange(Math.min(10, stars + 1)),
  });

  // At a bound, the button is inert but still focusable — `aria-disabled`
  // rather than the native attribute. A native `disabled` button cannot hold
  // focus, so pressing "−" down to zero removed the button from under the
  // focused element: the ring vanished, focus fell to <body>, and the D-pad
  // had no zone. The page-level `disabled` (nothing may be edited yet) is a
  // different thing and stays a real one — nothing is going to become
  // focusable there without a reload of the page state.
  const atFloor = stars <= 0;
  const atCeiling = stars >= 10;

  return (
    <div className={styles.stepper} role="group" aria-label={`Rating, ${stars} of 10`}>
      <button
        ref={dec.ref}
        className={`${styles.stepperBtn} ${atFloor || disabled ? styles.stepperMuted : ''} ${dec.focused ? styles.focused : ''}`}
        onClick={() => { if (!atFloor && !disabled) onChange(Math.max(0, stars - 1)); }}
        disabled={disabled}
        aria-disabled={disabled || atFloor}
        aria-label="Decrease rating"
      >−</button>
      <span className={styles.stepperVal}>
        {stars > 0 ? `${stars}` : '—'}
        <span className={styles.stepperStar} aria-hidden="true">★</span>
      </span>
      <button
        ref={inc.ref}
        className={`${styles.stepperBtn} ${atCeiling || disabled ? styles.stepperMuted : ''} ${inc.focused ? styles.focused : ''}`}
        onClick={() => { if (!atCeiling && !disabled) onChange(Math.min(10, stars + 1)); }}
        disabled={disabled}
        aria-disabled={disabled || atCeiling}
        aria-label="Increase rating"
      >+</button>
    </div>
  );
}
