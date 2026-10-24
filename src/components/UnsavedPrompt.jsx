/**
 * UnsavedPrompt — "you changed settings and did not press Save".
 *
 * Raised from the Settings panel when Back / Esc / Cancel would close it with
 * a dirty draft. Reported from the TV, 2026-10-24: "I sometimes forget to go
 * press save" — backing out silently discarded the change, and the panel gave
 * no sign that anything had been lost.
 *
 * ## Why it is a nested dialog
 *
 * The prompt renders inside Settings' own `role="dialog"` overlay as a second,
 * innermost one. `focusScopeOf` returns the nearest dialog ancestor, so the
 * app's D-pad handler confines its candidates to these three buttons while the
 * prompt is open; the settings controls behind it stay mounted and cannot take
 * focus. `autoFocus` on "Keep editing" puts the cursor there before the first
 * key is read.
 *
 * ## Keys
 *
 * This component deliberately registers no Back handler. Settings' own
 * capture-phase listener is registered first and, seeing the prompt open,
 * dismisses it instead of closing the panel — two sibling listeners on the
 * same target would both run, and a second dismissal here would race that one.
 * Back therefore means "keep editing", the same as the focused default.
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
