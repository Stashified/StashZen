import { useEffect, useState } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { useFlash } from '../../hooks/useFlash.js';
import { useArmedConfirm } from '../../hooks/useArmedConfirm.js';
import { tvActionStyles } from '../tvActions.jsx';
import PinPad from '../PinPad.jsx';
import { useAppLock, setPin, clearPin, PIN_LENGTH } from '../../utils/appLock.js';
import styles from '../SettingsPanel.module.css';

// The two raw buttons here use tvActions' class names directly rather than
// ActionButton, for the reason given there.

/**
 * The Remove action, as its own component because it mounts conditionally.
 * `useFocusable` registers once and reads `ref.current` then; called
 * unconditionally while no PIN existed, it saw null and never re-ran, leaving
 * a dead D-pad stop. A child mounting with the button gives it that mount.
 */
function RemovePinButton({ confirming, onPress }) {
  const { ref, focused } = useFocusable({
    id: 'settings-lock-remove',
    zone: 'settings-lock',
    onEnter: onPress,
  });
  return (
    <button
      ref={ref}
      className={`${tvActionStyles.actionBtn} ${focused ? tvActionStyles.focused : ''}`}
      onClick={onPress}
    >
      {confirming ? 'Press again to confirm' : 'Remove PIN'}
    </button>
  );
}

/**
 * Optional PIN gate. Owns a nested PinPad: `pinFlow` is null (actions only),
 * 'set' (choosing a PIN) or 'confirm' (re-entering it).
 *
 * `pinFlowRef` is a channel back to SettingsPanel: while a flow is open the
 * panel must not act on Back itself.
 */
export function AppLockSection({ pinFlowRef }) {
  const lockSet = useAppLock();

  const [pinFlow, setPinFlow] = useState(null);
  const [pendingPin, setPendingPin] = useState(null);
  // Same two-step confirm as "Clear saved" below — see useArmedConfirm.
  const [confirmingRemove, runRemove, resetRemove] = useArmedConfirm();
  // Transient confirmation, cleared on unmount — see useFlash.
  const [notice, flash] = useFlash();

  useEffect(() => {
    if (pinFlowRef) pinFlowRef.current = pinFlow;
  }, [pinFlow, pinFlowRef]);

  const primaryBtn = useFocusable({
    id: 'settings-lock-primary',
    zone: 'settings-lock',
    onEnter: () => openFlow(),
  });

  function openFlow() {
    setPendingPin(null);
    resetRemove();
    setPinFlow('set');
  }

  function closeFlow() {
    setPinFlow(null);
    setPendingPin(null);
    // The keypad is about to unmount; without this, focus falls to <body> and
    // the D-pad navigates from the middle of the screen.
    primaryBtn.focus();
  }

  function handleRemove() {
    runRemove(() => {
      // clearPin reports whether storage was actually written; on failure the
      // lock is still set, so "PIN removed" would be a lie.
      if (!clearPin()) {
        flash('Could not remove the PIN on this device');
        return;
      }
      // The Remove button is about to unmount with `lockSet`; move focus
      // before it falls to <body>.
      primaryBtn.focus();
      flash('PIN removed');
    });
  }

  function handlePinSubmit(pin) {
    if (pinFlow === 'set') {
      setPendingPin(pin);
      setPinFlow('confirm');
      return true;
    }

    // A mismatch restarts at the first phase: if the *first* entry was
    // mistyped, re-confirming against it would loop forever.
    if (pin !== pendingPin) {
      setPendingPin(null);
      setPinFlow('set');
      return 'PINs did not match — start again';
    }

    // setPin reports whether the write landed; don't claim success otherwise.
    if (!setPin(pin)) {
      setPendingPin(null);
      setPinFlow('set');
      return 'Could not save the PIN on this device';
    }

    const changed = lockSet;
    closeFlow();
    flash(changed ? 'PIN changed' : 'PIN set');
    return true;
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionRow}>
        <div className={styles.sectionText}>
          <span className={styles.fieldLabel}>App lock</span>
          <p className={styles.sectionStatus}>
            {lockSet
              ? 'A PIN is required to open the app.'
              : 'No PIN set — the app opens without one.'}
          </p>
        </div>
        <div className={styles.sectionActions}>
          <button
            ref={primaryBtn.ref}
            className={`${tvActionStyles.actionBtn} ${primaryBtn.focused ? tvActionStyles.focused : ''}`}
            onClick={openFlow}
          >
            {lockSet ? 'Change PIN' : 'Set PIN'}
          </button>
          {lockSet && (
            <RemovePinButton
              confirming={confirmingRemove}
              onPress={handleRemove}
            />
          )}
        </div>
      </div>

      <p className={styles.lockNotice} role="status" aria-live="polite">{notice}</p>

      <p className={styles.hint}>
        A forgotten PIN cannot be recovered in the app. See the README for
        how to reset — it clears the saved endpoint and key too.
      </p>

      {pinFlow && (
        <PinPad
          title={pinFlow === 'confirm' ? 'Confirm PIN' : (lockSet ? 'Change PIN' : 'Set PIN')}
          subtitle={pinFlow === 'confirm'
            ? 'Enter the same PIN again'
            : `Choose a ${PIN_LENGTH}-digit PIN`}
          hint="Press Back to cancel"
          onSubmit={handlePinSubmit}
          onCancel={closeFlow}
        />
      )}
    </div>
  );
}
