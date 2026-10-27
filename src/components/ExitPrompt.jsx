/**
 * ExitPrompt, modal asking the user to confirm app exit.
 *
 * Shown on Back at a top-level tab. On confirm it exits via
 * `tizen.application`; in a browser that silently no-ops.
 *
 * Spatial nav is trapped inside by the standard `role="dialog"` check.
 */

import { useBackKey } from '../hooks/useBackKey.js';
import { ActionButton } from './tvActions.jsx';
import styles from './ExitPrompt.module.css';

// `zone: 'exit-prompt'` is passed at each call site rather than defaulted: it
// keeps these buttons out of the settings walk, so it must not be accidental.

export default function ExitPrompt({ onCancel }) {
  // Capture phase, so Back/Esc cancels the prompt rather than re-triggering it.
  useBackKey(onCancel);

  const handleExit = () => {
    // Tizen exits for real; browsers refuse to close pages they did not open.
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