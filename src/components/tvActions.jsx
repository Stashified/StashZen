/**
 * tvActions.jsx — the controls a TV panel is built out of.
 *
 * Lifted from SettingsPanel.jsx and ExitPrompt.jsx, which each carried their
 * own copy of `ActionButton`. The two copies had not drifted — their CSS was
 * byte-identical — so this is a move, not a merge, and the props are the union
 * of what the two call sites already passed.
 *
 * The third consumer is why it exists: FirstRun carries a deliberately larger
 * variant of the same button (13px 26px, 16px text, plus a `:disabled`), added
 * in 0.8.0 with its own CSS module to keep that release's blast radius small.
 * P5 adds a PIN step to that flow and should use this rather than a fourth
 * copy. FirstRun is *not* migrated here: its button is a different size on
 * purpose, and folding a size variant into this component is a design change
 * rather than the behaviour-neutral one this is.
 *
 * `zone` is the focus scope, and it is a required part of the contract rather
 * than a detail: useFocusable groups by it, so a button placed in the wrong
 * zone is skipped by the D-pad walk. Defaults to 'settings' because that is
 * what most call sites want, and ExitPrompt passes its own explicitly.
 *
 * `pressed` maps to `aria-pressed`, not to a class — the on/off state is meant
 * to be announced rather than only visible in the label.
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
 * The class names, for the handful of places that need the look without the
 * component.
 *
 * AppLockSection's two buttons are the case: they call `primaryBtn.focus()`
 * imperatively when the PIN flow opens, which a component owning its own
 * useFocusable cannot be asked to do from outside. They were already raw
 * `<button>`s passing these exact class names, so handing them the same names
 * from their new home keeps their rendering identical — which is the whole
 * requirement. Migrating them to <ActionButton> means adding an imperative
 * escape hatch, and that is a change to make deliberately, not as a side
 * effect of a move.
 */
export const tvActionStyles = styles;
