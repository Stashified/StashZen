/**
 * tvActions.jsx: the controls a TV panel is built out of.
 *
 * `ActionButton` replaces the identical copies SettingsPanel and ExitPrompt
 * each carried; the props are the union of what their call sites passed.
 *
 * FirstRun deliberately keeps its own larger variant (13px 26px, 16px text,
 * plus `:disabled`). Do not fold that size into this component, it is a design
 * change, not a move.
 *
 * `zone` is the focus scope and part of the contract: useFocusable groups by
 * it, so a button in the wrong zone is skipped by the D-pad walk. It defaults
 * to 'settings' because most call sites want that.
 *
 * `pressed` maps to `aria-pressed`, not a class: the on/off state is meant to
 * be announced, not only visible in the label.
 */

import { useFocusable } from '../hooks/useFocusable.js';
import styles from './tvActions.module.css';

export function ActionButton({ id, label, primary, pressed, onClick, autoFocus, zone = 'settings' }) {
  const { ref, focused } = useFocusable({
    id,
    zone,
    onEnter: onClick,
    autoFocus,
  });
  return (
    <button
      ref={ref}
      className={`${styles.actionBtn} ${primary ? styles.actionPrimary : ''} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      aria-pressed={pressed}
    >
      {label}
    </button>
  );
}

/**
 * The class names, for places that need the look without the component.
 *
 * AppLockSection's buttons call `primaryBtn.focus()` imperatively when the PIN
 * flow opens, which a component owning its own useFocusable cannot be asked to
 * do from outside. Moving them to <ActionButton> needs an imperative escape
 * hatch, a deliberate change, not a side effect of this move.
 */
export const tvActionStyles = styles;
