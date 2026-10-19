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
 */

import { useCallback } from 'react';
import PinPad from './PinPad.jsx';
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
  // No `onBack`: Back must never dismiss the lock.
  useKeyHandler({});

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
      <PinPad
        title="Enter PIN"
        subtitle="StashZen is locked"
        onSubmit={handleSubmit}
        onCancel={noopCancel}
      />
    </div>
  );
}

/**
 * Back must never dismiss the lock — deliberately does nothing.
 *
 * Note this is belt-and-braces rather than the only thing holding: AppLock
 * does not render <App /> at all while locked, so App's own Back handler
 * (which opens the exit prompt) is not even registered. But the lock screen
 * is the wrong place for a "cancel" affordance under any circumstance, so
 * the handler is explicit here rather than left to inference.
 */
function noopCancel() {}
