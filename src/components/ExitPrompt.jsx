/**
 * ExitPrompt — Modal asking the user to confirm app exit.
 *
 * Shown when the user presses Back at a top-level tab (Home, Markers,
 * Performers grid). On confirm, attempts to exit via tizen.application;
 * silently no-ops in browsers where exit isn't permitted.
 *
 * Spatial nav is trapped inside via the standard role="dialog" check
 * in useKeyHandler.
 */

import { useEffect } from 'react';
import { TIZEN_BACK } from '../utils/input.js';
import { ActionButton } from './tvActions.jsx';
import styles from './ExitPrompt.module.css';

// The local ActionButton moved to tvActions.jsx. Its `zone: 'exit-prompt'`
// was hardcoded here and is now passed at each call site — the zone is what
// keeps this prompt's two buttons out of the settings walk, so it cannot be
// left to a default.

export default function ExitPrompt({ onCancel }) {
  // Capture-phase handler — Back/Esc cancels the prompt itself so
  // the user doesn't immediately re-trigger it.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.keyCode === TIZEN_BACK) {
        e.preventDefault();
        e.stopPropagation();
        onCancel?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel]);

  const handleExit = () => {
    // Tizen: real exit. Browser: no-op (browsers won't let pages close
    // themselves except those they opened). The user can press the
    // hardware Exit button or close the tab manually.
    try {
      if (typeof window !== 'undefined' && window.tizen?.application) {
        window.tizen.application.getCurrentApplication().exit();
        return;
      }
    } catch (e) {
      // Fall through
    }
    // Best-effort fallback for browser dev
    window.close();
  };

  return (
    <div className={styles.overlay} role="dialog" aria-label="Exit confirmation" aria-modal="true">
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>Exit app?</h2>
          <p className={styles.subtitle}>You'll return to the home screen.</p>
        </header>
        <footer className={styles.footer}>
          <ActionButton id="exit-cancel" label="Cancel" onClick={onCancel} zone="exit-prompt" autoFocus />
          <ActionButton id="exit-confirm" label="Exit" onClick={handleExit} zone="exit-prompt" primary />
        </footer>
      </div>
    </div>
  );
}