/**
 * ActionMenu — the long-press menu on a scene card
 *
 * Items are passed in rather than hardcoded so the menu stays a plain
 * overlay: App decides what a scene card can do (Play, Play all, Play from
 * here, Details) and this file only knows how to draw a focusable list and
 * how to get out of the way.
 *
 * Focus trapping is free: `modalScopeOf` / `focusScopeOf` in useKeyHandler
 * walk up to the nearest `role="dialog"`, so the D-pad cannot step from a
 * row onto the grid behind it. Back and Escape close the menu rather than
 * reaching App's onBack — which is what stops the exit prompt opening
 * *behind* an overlay the user is still looking at.
 *
 * It has no backdrop-scrim dismissal on purpose. On a TV there is no click
 * outside; Back is the only way out and it is always available.
 */

import { useEffect, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { TIZEN_BACK } from '../utils/input.js';
import styles from './ActionMenu.module.css';

// How long the keydowns have to stop before the press counts as over. A
// remote auto-repeats at roughly 30Hz while a key is held, so ~5 repeat
// intervals of silence is unambiguous without adding a noticeable delay
// before the rows become focusable.
const PRESS_END_MS = 150;

function MenuItem({ id, label, hint, onSelect, autoFocus }) {
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
      className={`${styles.item} ${focused ? styles.focused : ''}`}
      onClick={onSelect}
    >
      <span className={styles.itemLabel}>{label}</span>
      {hint && <span className={styles.itemHint}>{hint}</span>}
    </button>
  );
}

export default function ActionMenu({ title, subtitle, items = [], onClose }) {
  // Capture phase, so Back/Esc closes the menu even though the grid's own
  // focus is what the key would otherwise reach.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  // ── Take focus only once the press that opened this is over ──
  // The menu mounts mid-press: the user is still holding OK. Focus is what
  // decides where that press's auto-repeats go, so grabbing it here aims them
  // straight at the first row — holding OK on a card played the scene instead
  // of showing the menu. Left where it is, the card keeps swallowing them
  // through its own long-press guard, and the D-pad still reaches the menu
  // meanwhile because focusScopeOf falls back to the open dialog.
  //
  // The end of the press is measured rather than observed. A keyup is the
  // direct signal, but a remote is not obliged to send one — and the keydowns
  // simply stopping is just as conclusive, which also covers a remote that
  // repeats without setting `e.repeat`, where a repeat is indistinguishable
  // from a fresh press.
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
