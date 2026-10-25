import { useFocusable } from '../../hooks/useFocusable.js';
import defaultStyles from '../SceneDetailPage.module.css';

// Shared by the scene and performer detail pages. Zone and CSS module are props
// because the pages register in different focus zones and style heroes
// separately; the scene page's call sites rely on the defaults.
export function ActionButton({
  id, label, icon, primary, active, autoFocus, disabled, title, onEnter, onLongPress,
  zone = 'scene-detail', styles = defaultStyles,
}) {
  // Opting into `onLongPress` moves this button's *short* action from keydown
  // to keyup, so it fires a few tens of milliseconds after its neighbours. Per
  // button keeps that delay off Play; a page-wide hold would not.
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
