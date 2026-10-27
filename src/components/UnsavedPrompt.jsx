/**
 * UnsavedPrompt, "you changed settings and did not press Save".
 *
 * Raised when Back / Esc / Cancel would close the Settings panel with a dirty
 * draft, which used to discard changes silently.
 *
 * It is a nested dialog: `focusScopeOf` returns the nearest dialog, so the
 * D-pad is confined to these buttons while the settings controls stay mounted
 * behind. "Keep editing" is focused so the safe answer is the default.
 *
 * Deliberately no Back handler here: Settings' capture-phase listener is
 * registered first and, seeing the prompt open, dismisses it instead. A
 * second listener would race it, so Back means "keep editing".
 */

import { useFocusable } from '../hooks/useFocusable.js';
import styles from './UnsavedPrompt.module.css';

const ZONE = 'settings-unsaved';

function PromptButton({ id, primary, autoFocus, onEnter, children }) {
  const { ref, focused } = useFocusable({ id, zone: ZONE, onEnter, autoFocus });
  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.btn,
        primary ? styles.btnPrimary : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={onEnter}
    >
      {children}
    </button>
  );
}

export default function UnsavedPrompt({ onSave, onDiscard, onKeepEditing }) {
  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Unsaved settings"
    >
      <div className={styles.panel}>
        <h2 className={styles.title}>Unsaved changes</h2>
        <p className={styles.subtitle}>
          You changed settings but did not press Save.
        </p>
        <div className={styles.buttons}>
          {/* The safe answer holds the cursor: Back and a reflexive Enter both
              return to the panel rather than discarding a change. */}
          <PromptButton id="settings-unsaved-keep" autoFocus onEnter={onKeepEditing}>
            Keep editing
          </PromptButton>
          <PromptButton id="settings-unsaved-discard" onEnter={onDiscard}>
            Discard
          </PromptButton>
          <PromptButton id="settings-unsaved-save" primary onEnter={onSave}>
            Save &amp; close
          </PromptButton>
        </div>
      </div>
    </div>
  );
}
