import { useEffect, useState } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { useFlash } from '../../hooks/useFlash.js';
import { useArmedConfirm } from '../../hooks/useArmedConfirm.js';
import { tvActionStyles } from '../tvActions.jsx';
import PinPad from '../PinPad.jsx';
import { useAppLock, setPin, clearPin, PIN_LENGTH } from '../../utils/appLock.js';
import styles from '../SettingsPanel.module.css';

// ActionButton moved to tvActions.jsx — SettingsPanel and ExitPrompt carried
// byte-identical copies of it. The two raw buttons in AppLockSection below
// still use its class names directly, for the reason given there.

// ── App lock ─────────────────────────────────────────────
/**
 * The Remove action, as its own component because it mounts conditionally.
 *
 * `useFocusable` registers in an effect whose dependencies are `[id, zone,
 * …]`, and it reads `ref.current` when that effect runs. Called unconditionally
 * in the section, the effect ran once while there was no PIN and therefore no
 * button — `ref.current` was null, it returned early, and it never re-ran when
 * a PIN set *in this session* mounted the button. The result was a button with
 * no tabindex, no key handler and no registry entry: a dead D-pad stop until
 * the panel was closed and reopened. A child that mounts with the button gives
 * the hook the mount it is written to expect.
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
 * Optional PIN gate. Owns a nested PinPad, in one of three states:
 *
 *   pinFlow === null       — just the row of actions
 *   pinFlow === 'set'      — choosing a PIN
 *   pinFlow === 'confirm'  — re-entering the same PIN
 *
 * `pinFlowRef` is a channel back to SettingsPanel: while a flow is open the
 * panel must not act on Back itself (see the guard there).
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
    // The keypad had focus and is about to unmount; without this, focus
    // falls to <body> and the next D-pad press navigates from the middle
    // of the screen.
    primaryBtn.focus();
  }

  function handleRemove() {
    runRemove(() => {
      // clearPin reports whether storage was actually written; on failure the
      // lock is still set, so saying "PIN removed" would be a lie the next
      // launch contradicts. Focus stays on the (still mounted) Remove button.
      if (!clearPin()) {
        flash('Could not remove the PIN on this device');
        return;
      }
      // The button that was focused is about to unmount with `lockSet`. Move
      // focus first: otherwise it falls to <body> and the next D-pad press
      // navigates from the middle of the screen.
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

    // Confirm phase. A mismatch returns to the first phase rather than
    // staying here: if the user mistyped the *first* entry, re-confirming
    // against it would loop forever.
    if (pin !== pendingPin) {
      setPendingPin(null);
      setPinFlow('set');
      return 'PINs did not match — start again';
    }

    // setPin reports whether the write actually landed. Don't claim
    // success on a storage failure.
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
