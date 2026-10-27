import { useFocusable } from '../../hooks/useFocusable.js';
import defaultStyles from '../SceneDetailPage.module.css';

// Shared by the scene and performer detail pages. The id prefix must be unique
// per page because the focus registry is global; zone and CSS module follow
// ActionButton's rule.
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

  // At a bound the button is inert but still focusable, hence `aria-disabled`
  // rather than native `disabled`: a natively disabled button cannot hold
  // focus, so pressing "−" to zero would drop the ring, focus to <body>, and
  // the D-pad's zone. The page-level `disabled` is different, nothing becomes
  // focusable there without a reload of page state, so a real one is safe.
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
        {stars > 0 ? `${stars}` : '–'}
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
