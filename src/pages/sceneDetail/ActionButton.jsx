import { useFocusable } from '../../hooks/useFocusable.js';
import defaultStyles from '../SceneDetailPage.module.css';

// Shared by the scene and performer detail pages. Zone and CSS module are props
// because the pages register in different focus zones and style heroes
// separately; the scene page's call sites rely on the defaults.
export function ActionButton({
  id, label, icon, primary, active, autoFocus, disabled, inert, title, onEnter, onLongPress,
  zone = 'scene-detail', styles = defaultStyles,
}) {
  // `inert` is a bound the press itself can cross, Clear progress with nothing
  // left to clear. A natively disabled button cannot hold focus, so that press
  // dropped the ring to <body> and the D-pad's zone. `disabled` stays native:
  // only a reload of page state makes those buttons live again. See
  // RatingStepper.
  const blocked = disabled || inert;
  // Opting into `onLongPress` moves this button's *short* action from keydown
  // to keyup, so it fires a few tens of milliseconds after its neighbours. Per
  // button keeps that delay off Play; a page-wide hold would not, hence the
  // wrapper only when there is a hold action.
  const { ref, focused } = useFocusable({
    id, zone, autoFocus, disabled,
    onEnter: () => { if (!blocked) onEnter?.(); },
    ...(onLongPress ? { onLongPress: () => { if (!blocked) onLongPress(); } } : {}),
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
      onClick={() => { if (!blocked) onEnter?.(); }}
      disabled={disabled}
      aria-disabled={blocked || undefined}
      aria-pressed={active}
      title={title}
    >
      {icon && <span className={styles.actionIcon} aria-hidden="true">{icon}</span>}
      <span>{label}</span>
    </button>
  );
}
