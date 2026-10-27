/**
 * ResumePrompt, "resume, or start from the beginning?"
 *
 * Raised before anything plays, because intent is genuinely split: reopening a
 * half-watched scene is usually a resume, but often a rewatch.
 *
 * It is a dialog so the player stands down: the player consumes every key it
 * does not yield, and `foreignDialogOpen` is what it yields to. That also buys
 * the focus trap, so ←/→ cannot wander onto the rail behind.
 *
 * Back takes the default rather than dismissing, there is no third meaning,
 * and an unreachable default would trap people. Neither answer writes
 * anything, so there is nothing to undo.
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

  // Backspace is Back here, unlike in MarkerModal: there is no text field, and
  // the player already treats it that way. `isBackKey`'s default rule.
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
          {/* Focus starts here and the label carries the position, so the
              default is a visible decision rather than a blind Enter. */}
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
