/**
 * ResumePrompt — "resume, or start from the beginning?"
 *
 * Raised by the player when a scene opens with a saved position, before anything
 * plays. Without it the position is applied silently, which is the wrong default
 * for the one case where intent is genuinely split: reopening a scene you were
 * halfway through is usually a resume, but it is just as often a rewatch or a
 * jump to one part, and nothing visible distinguishes them.
 *
 * ## Why it is a dialog
 *
 * `role="dialog"` is what makes the player stand down. The player's key handler
 * runs in the capture phase and consumes everything it does not deliberately
 * yield, so a prompt that wants the D-pad has to be something the player already
 * knows to yield to — and the test it uses (foreignDialogOpen) is exactly the
 * presence of a dialog that is not its own overlay. That also buys the focus
 * trap: the app's handler confines its candidate search to the innermost open
 * dialog, so ←/→ walks these two buttons and cannot wander onto the rail behind
 * them, which is still mounted.
 *
 * ## Keys
 *
 * Back takes the default rather than dismissing. "Dismiss" has no third meaning
 * here — the scene has to either resume or start — and a prompt whose default is
 * unreachable by the remote's most reflexive button is a prompt that traps
 * people. Nothing is written by either answer, so there is nothing to undo.
 */

import { useCallback } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { formatTime } from '../utils/format.js';
import styles from './ResumePrompt.module.css';

const ZONE = 'resume-prompt';

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

export default function ResumePrompt({ sceneTitle, seconds, onChoose }) {
  const resume = useCallback(() => onChoose?.('resume'), [onChoose]);
  const at = formatTime(seconds, { padMinutes: true });

  // Backspace is Back here, unlike in MarkerModal: there is no text field for
  // it to belong to, and the player itself already treats it as Back. That is
  // exactly `isBackKey`'s default rule.
  useBackKey(resume);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Resume playback">
      <div className={styles.panel}>
        <h2 className={styles.title}>Resume playback?</h2>
        {sceneTitle && <p className={styles.subtitle}>{sceneTitle}</p>}
        <p className={styles.detail}>
          You stopped at <span className={styles.at}>{at}</span>.
        </p>
        <div className={styles.buttons}>
          {/* The cursor starts here, and the label carries the position so the
              default is a decision the user can see rather than a blind
              Enter. */}
          <PromptButton id="resume-prompt-resume" primary autoFocus onEnter={resume}>
            Resume from {at}
          </PromptButton>
          <PromptButton id="resume-prompt-start" onEnter={() => onChoose?.('start')}>
            Start from the beginning
          </PromptButton>
        </div>
        <p className={styles.hint}>
          <kbd>←</kbd><kbd>→</kbd> Choose &nbsp; <kbd>OK</kbd> Confirm &nbsp; <kbd>Back</kbd> Resume
        </p>
      </div>
    </div>
  );
}
