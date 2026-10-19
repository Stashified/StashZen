import { useFocusable } from '../../hooks/useFocusable.js';
import defaultStyles from '../SceneDetailPage.module.css';

// ── Rating stepper ──────────────────────────────────────────
// Shared by the scene detail page and the performer detail page. The id
// prefix must be unique per page — the focus registry is global — and the
// zone and CSS module follow the same rule as ActionButton.
export function RatingStepper({
  rating100, disabled, onChange,
  idPrefix = 'scene-rating', zone = 'scene-detail', styles = defaultStyles,
}) {
  const stars = Math.max(0, Math.min(10, Math.round((rating100 || 0) / 10)));
  const dec = useFocusable({
    id: `${idPrefix}-dec`,
    zone,
    onEnter: () => onChange(Math.max(0, stars - 1)),
  });
  const inc = useFocusable({
    id: `${idPrefix}-inc`,
    zone,
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
