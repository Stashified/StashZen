/**
 * LockScreen — the gate shown while the app is locked.
 *
 * A thin wrapper over PinPad, plus the global arrow-key navigator the app tree
 * would otherwise take with it.
 *
 * The backdrop is solid because nothing is behind the panel by construction:
 * AppLock unmounts the app tree rather than drawing over it.
 *
 * Back asks whether to exit; it must not dismiss the lock, which would make
 * the PIN a suggestion. A Back that did nothing read as a broken remote, so
 * the same ExitPrompt as the main screen is used.
 */

import { useCallback, useState } from 'react';
import PinPad from './PinPad.jsx';
import ExitPrompt from './ExitPrompt.jsx';
import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { attemptPin } from '../utils/appLock.js';
import styles from './LockScreen.module.css';

export default function LockScreen({ onUnlock }) {
  // App owns the global arrow-key navigator and has unmounted, so without this
  // the D-pad is dead (useFocusable only binds Enter per element). PinPad's
  // capture-phase handler consumes digits and Back first, so only arrows reach
  // here; no `onBack`, since Back is PinPad's or ExitPrompt's.
  useKeyHandler({});

  const [exitPromptOpen, setExitPromptOpen] = useState(false);

  // Opening the prompt unmounts the pad rather than stacking: the pad's
  // overlay would sit above ExitPrompt's, and its capture listener would keep
  // swallowing keys behind the dialog. Remounting also resets the cursor to 1.
  const handleCancel = useCallback(() => setExitPromptOpen(true), []);
  const closeExitPrompt = useCallback(() => setExitPromptOpen(false), []);

  const handleSubmit = useCallback((pin) => {
    // attemptPin, not verifyPin: it owns the wrong-PIN backoff. PinPad shows
    // the returned string as the error and clears the entry.
    const result = attemptPin(pin);
    if (result.ok) {
      onUnlock?.();
      return true;
    }

    const seconds = Math.ceil(result.retryAfterMs / 1000);
    if (result.blocked) {
      return `Too many attempts — try again in ${seconds}s`;
    }
    if (result.retryAfterMs > 0) {
      return `Incorrect PIN — wait ${seconds}s before trying again`;
    }
    return 'Incorrect PIN';
  }, [onUnlock]);

  return (
    <div className={styles.cover}>
      {exitPromptOpen ? (
        <ExitPrompt onCancel={closeExitPrompt} />
      ) : (
        <PinPad
          title="Enter PIN"
          subtitle="StashZen is locked"
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
