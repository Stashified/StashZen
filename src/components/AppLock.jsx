/**
 * AppLock — gates the whole app behind the optional PIN
 *
 * Renders either the lock screen or the app, never both. That is the whole
 * point: pages fetch on mount, so an overlay drawn *over* a mounted app
 * would still load posters and previews behind the panel. Unmounting is
 * also what makes re-locking free — it is exactly cold-start semantics, so
 * there is no teardown to get wrong, and it removes a bypass path for free:
 * App owns the Back handler that opens the exit prompt, and while locked
 * App is not mounted, so there is nothing to open.
 *
 * The cost of that choice is stated in the README: unlocking re-fetches,
 * and re-locking during playback destroys the <video>.
 *
 * The lock state is read once at mount and then only on resume. It
 * deliberately does NOT subscribe to the lock store: setting a PIN in the
 * settings panel must not eject the user to the keypad mid-edit. A PIN set
 * mid-session takes effect the next time the app is resumed or relaunched.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import LockScreen from './LockScreen.jsx';
import { isLockSet } from '../utils/appLock.js';

// Hide/show flips shorter than this don't lock. The on-screen keyboard,
// native dialogs and the TV menu can all flip visibility briefly; genuinely
// leaving the app takes seconds. This is also what stops a stray resume
// event bouncing the user straight back to the keypad — the window covers
// it, because a hide has to outlast the grace before anything locks.
const RESUME_GRACE_MS = 1500;

// The raw-DOM cover applied while the app is hidden. See index.css.
//
// Why not React state: a resumed Tizen app can put its last frame back on
// screen before a state update from the visibilitychange handler can commit,
// which is the half-second of library the PIN exists to hide. A DOM
// attribute set inside the hide handler is in place before the app is
// frozen, so the frame the compositor restores is a blank theme background.
// It is removed in the same task that commits either the keypad or the app,
// so the first frame after a resume is already the right one.
const COVER_ATTR = 'data-lock-cover';

function setCover(on) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (on) document.documentElement.setAttribute(COVER_ATTR, '');
  else document.documentElement.removeAttribute(COVER_ATTR);
}

export default function AppLock({ children }) {
  const [locked, setLocked] = useState(() => isLockSet());

  const hiddenAtRef = useRef(null);

  const handleUnlock = useCallback(() => setLocked(false), []);

  useEffect(() => {
    const markHidden = () => {
      // Only the first hide in a run counts — pagehide and visibilitychange
      // can both fire, and re-stamping would shrink the measured absence.
      if (hiddenAtRef.current === null) {
        hiddenAtRef.current = performance.now();
        // Cover now rather than on return: by the time the show handler
        // runs, the frame that matters may already have been painted.
        if (isLockSet()) setCover(true);
      }
    };

    const handleShow = () => {
      if (document.visibilityState === 'hidden') return;

      const since = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (since === null) {
        setCover(false);
        return;
      }

      if (performance.now() - since < RESUME_GRACE_MS) {
        setCover(false);
        return;
      }

      // Read the store rather than this component's state: a PIN may have
      // been set since mount.
      try {
        // flushSync, not a plain setState: the cover is removed below in
        // this same task, and a deferred render would paint the app first —
        // the exact flash this path exists to prevent.
        if (isLockSet()) flushSync(() => setLocked(true));
      } finally {
        // Always uncover, even if the commit throws: a cover left behind
        // would be a black screen the user cannot dismiss.
        setCover(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markHidden();
      else handleShow();
    };

    // visibilitychange is the primary signal. pagehide/pageshow is the
    // fallback for the app being frozen rather than merely hidden.
    //
    // Deliberately NOT window blur: that fires for transient reasons — the
    // on-screen keyboard, a native dialog, the context menu — and would
    // lock the user mid-interaction. Tizen's own lifecycle API is skipped
    // too; its surface varies by platform version and the standard events
    // already cover this.
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', markHidden);
    window.addEventListener('pageshow', handleShow);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', markHidden);
      window.removeEventListener('pageshow', handleShow);
      setCover(false);
    };
  }, []);

  if (locked) return <LockScreen onUnlock={handleUnlock} />;
  return children;
}
