import { useFocusable } from '../../hooks/useFocusable.js';
import { nextRating } from '../../utils/format.js';
import defaultStyles from '../SceneDetailPage.module.css';

// Shared by the scene and performer detail pages. The id prefix must be unique
// per page because the focus registry is global; zone and CSS module follow
// ActionButton's rule.
export function RatingStepper({
  rating100, disabled, onChange, nextId = null,
  idPrefix = 'scene-rating', zone = 'scene-detail', styles = defaultStyles,
}) {
  const value = Math.max(0, Math.min(100, Math.round(Number(rating100) || 0)));
  // Another client can write an off-grid value (75). Show it exactly and step
  // from it, or the detail page reads 8★ while the card reads 7.5 and a press
  // writes 90.
  const display = value === 0
    ? '–'
    : (value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1));
  const dec = useFocusable({
    id: `${idPrefix}-dec`,
    zone,
    onEnter: () => onChange(nextRating(value, -1)),
    nextId: nextId?.dec || null,
  });
  const inc = useFocusable({
    id: `${idPrefix}-inc`,
    zone,
    onEnter: () => onChange(nextRating(value, 1)),
    nextId: nextId?.inc || null,
  });

  // At a bound the button is inert but still focusable, hence `aria-disabled`
  // rather than native `disabled`: a natively disabled button cannot hold
  // focus, so pressing "−" to zero would drop the ring, focus to <body>, and
  // the D-pad's zone. The page-level `disabled` is different, nothing becomes
  // focusable there without a reload of page state, so a real one is safe.
  const atFloor = value <= 0;
  const atCeiling = value >= 100;

  return (
    <div className={styles.stepper} role="group" aria-label={`Rating, ${value === 0 ? '0' : display} of 10`}>
      <button
        ref={dec.ref}
        className={`${styles.stepperBtn} ${atFloor || disabled ? styles.stepperMuted : ''} ${dec.focused ? styles.focused : ''}`}
        onClick={() => { if (!atFloor && !disabled) onChange(nextRating(value, -1)); }}
        disabled={disabled}
        aria-disabled={disabled || atFloor}
        aria-label="Decrease rating"
      >−</button>
      <span className={styles.stepperVal}>
        {display}
        <span className={styles.stepperStar} aria-hidden="true">★</span>
      </span>
      <button
        ref={inc.ref}
        className={`${styles.stepperBtn} ${atCeiling || disabled ? styles.stepperMuted : ''} ${inc.focused ? styles.focused : ''}`}
        onClick={() => { if (!atCeiling && !disabled) onChange(nextRating(value, 1)); }}
        disabled={disabled}
        aria-disabled={disabled || atCeiling}
        aria-label="Increase rating"
      >+</button>
    </div>
  );
}
