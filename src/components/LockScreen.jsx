/**
 * LockScreen — the gate shown while the app is locked
 *
 * A thin wrapper over PinPad: the keypad, the verification, and the one
 * piece of app-level wiring the lock screen would otherwise lose by
 * replacing <App /> — the global arrow-key navigator.
 *
 * The backdrop is solid rather than translucent on purpose. This is the one
 * screen where nothing is behind the panel by construction — AppLock
 * unmounts the app tree rather than drawing over it — so there is nothing
 * to blur, and a solid fill makes that explicit.
 *
 * Back asks whether to close the app. It must not dismiss the lock — that
 * would make the PIN a suggestion — but a Back that does nothing at all
 * reads as a broken remote, which is what a viewer on the lock screen
 * reported on 2026-10-24. The confirmation is the same component the main
 * screen uses, so "Back → Exit app?" behaves identically everywhere.
 */

import { useCallback, useState } from 'react';
import PinPad from './PinPad.jsx';
import ExitPrompt from './ExitPrompt.jsx';
import { useKeyHandler } from '../hooks/useKeyHandler.js';
import { attemptPin } from '../utils/appLock.js';
import styles from './LockScreen.module.css';

export default function LockScreen({ onUnlock }) {
  // The lock screen replaces <App />, and App is where the global arrow-key
  // navigator lives (App.jsx:247). Without this, nothing moves focus: the
  // keypad auto-focuses "1" and the D-pad then does nothing, because
  // useFocusable only binds Enter per element. Every other key is covered
  // elsewhere — PinPad's capture-phase handler consumes digits, Backspace,
  // Escape and Tizen Back before they could reach this bubble-phase
  // listener, so only the arrows actually arrive here.
  //
  // No `onBack`: Back is PinPad's `onCancel` below, and while the exit
  // prompt is up it is ExitPrompt's own handler. This listener never sees
  // either.
  useKeyHandler({});

  const [exitPromptOpen, setExitPromptOpen] = useState(false);

  // Back (Escape / Tizen Back) from the keypad. Opening the prompt unmounts
  // the pad rather than stacking over it, and that is deliberate on three
  // counts: the pad's overlay sits above ExitPrompt's, the pad's
  // window-capture listener would otherwise go on swallowing digits and
  // Backspace behind the dialog, and remounting the pad puts the cursor
  // back on "1" when the prompt closes.
  const handleCancel = useCallback(() => setExitPromptOpen(true), []);
  const closeExitPrompt = useCallback(() => setExitPromptOpen(false), []);

  const handleSubmit = useCallback((pin) => {
    // attemptPin, not verifyPin: it owns the wrong-PIN backoff. PinPad
    // renders the returned string as the error and clears the entry.
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
