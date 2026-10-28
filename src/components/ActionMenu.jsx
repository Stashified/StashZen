/**
 * ActionMenu, the long-press menu on a scene card.
 *
 * Items are passed in so App decides what a card can do and this file only
 * draws a focusable list.
 *
 * Focus trapping is free: `focusScopeOf` walks up to the nearest
 * `role="dialog"`, so the D-pad cannot step onto the grid behind. Back and
 * Escape close the menu rather than reaching App's onBack, which stops the
 * exit prompt opening behind it.
 *
 * No backdrop-scrim dismissal on purpose: on a TV there is no click outside.
 */

import { useEffect, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import styles from './ActionMenu.module.css';

// How long keydowns must stop before the press counts as over. A remote
// auto-repeats at ~30Hz, so ~5 intervals is unambiguous without a noticeable
// delay before the rows become focusable.
const PRESS_END_MS = 150;

function MenuItem({ id, label, hint, danger, onSelect, autoFocus }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'action-menu',
    onEnter: onSelect,
    autoFocus,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.item,
        danger ? styles.danger : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onSelect}
    >
      <span className={styles.itemLabel}>{label}</span>
      {hint && <span className={styles.itemHint}>{hint}</span>}
    </button>
  );
}

export default function ActionMenu({ title, subtitle, items = [], onClose }) {
  // Capture phase, so Back/Esc closes the menu rather than reaching the grid.
  // The hook registers once and holds the handler in a ref, so a changing
  // `onClose` does not reorder window-capture listeners.
  useBackKey(onClose);

  // Take focus only after the press that opened the menu ends: it mounts
  // mid-press, and grabbing focus would aim the auto-repeats at the first row
  // (holding OK on a card played the scene). The press end is measured, not
  // observed, a remote need not send keyup, and keydowns simply stopping also
  // covers remotes that repeat without setting `e.repeat`.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed) return undefined;
    let timer = setTimeout(() => setArmed(true), PRESS_END_MS);
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setArmed(true), PRESS_END_MS);
    };
    window.addEventListener('keyup', restart, true);
    window.addEventListener('keydown', restart, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keyup', restart, true);
      window.removeEventListener('keydown', restart, true);
    };
  }, [armed]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Actions for ${title}`}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </header>

        <div className={styles.items}>
          {items.map((item, i) => (
            <MenuItem
              key={item.id}
              id={item.id}
              label={item.label}
              hint={item.hint}
              danger={item.danger}
              onSelect={item.onSelect}
              autoFocus={armed && i === 0}
            />
          ))}
        </div>

        <footer className={styles.footer}>
          <span className={styles.footerHint}><kbd>Back</kbd> Close</span>
        </footer>
      </div>
    </div>
  );
}
