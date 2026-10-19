import { useFocusable } from '../../hooks/useFocusable.js';
import defaultStyles from '../SceneDetailPage.module.css';

// ── Action button ───────────────────────────────────────────
// Shared by the scene detail page and the performer detail page. The zone and
// the CSS module are props because the two pages register under different
// focus zones and style their heroes separately; the scene page's call sites
// rely on the defaults.
export function ActionButton({
  id, label, icon, primary, active, autoFocus, disabled, title, onEnter, onLongPress,
  zone = 'scene-detail', styles = defaultStyles,
}) {
  // `onLongPress` is opt-in on useFocusable, and opting in moves the *short*
  // action from keydown to keyup for this button alone — every other button on
  // this page still fires on keydown, so the o-count press is a few tens of
  // milliseconds later than its neighbours. Opting in is what keeps that
  // contained: the alternative, a page-wide hold, would put that delay on Play.
  const { ref, focused } = useFocusable({
    id, zone, onEnter, onLongPress, autoFocus, disabled,
  });
  return (
    <button
      ref={ref}
      className={[
        styles.actionBtn,
        primary ? styles.primary : '',
        active ? styles.active : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onEnter}
      disabled={disabled}
      aria-pressed={active}
      title={title}
    >
      {icon && <span className={styles.actionIcon} aria-hidden="true">{icon}</span>}
      <span>{label}</span>
    </button>
  );
}
