/**
 * AppLock, gates the whole app behind the optional PIN.
 *
 * Renders either the lock screen or the app, never both: pages fetch on mount,
 * so an overlay over a mounted app would still load posters behind the panel.
 * Unmounting also makes re-locking free, cold-start semantics, no teardown to
 * get wrong, and removes a bypass: App owns the Back handler that opens the
 * exit prompt, and while locked it is not mounted. The cost (unlocking
 * re-fetches, re-locking during playback destroys the <video>) is in the
 * README.
 *
 * Lock state is read once at mount and then only on resume. It does NOT
 * subscribe to the store: setting a PIN in Settings must not eject the user to
 * the keypad mid-edit, it takes effect on the next resume or relaunch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import LockScreen from './LockScreen.jsx';
import { isLockSet } from '../utils/appLock.js';
import { absenceMs } from '../utils/lockTiming.js';

// Hide/show flips shorter than this don't lock: the on-screen keyboard, native
// dialogs and the TV menu all flip visibility briefly, while genuinely leaving
// takes seconds. A hide must outlast the grace before anything locks.
const RESUME_GRACE_MS = 1500;

// The raw-DOM cover applied while the app is hidden. See index.css.
//
// Not React state: a resumed Tizen app can repaint its last frame before a
// state update from the visibilitychange handler commits, the half-second of
// library the PIN exists to hide. A DOM attribute set inside the hide handler
// is in place before the app freezes, so the restored frame is a blank theme
// background; it is removed in the task that commits the keypad or the app.
const COVER_ATTR = 'data-lock-cover';

function setCover(on) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (on) document.documentElement.setAttribute(COVER_ATTR, '');
  else document.documentElement.removeAttribute(COVER_ATTR);
}

export default function AppLock({ children }) {
  const [locked, setLocked] = useState(() => isLockSet());

  // Both clocks, because either can lie about a standby: see absenceMs.
  const hiddenAtRef = useRef(null);

  const handleUnlock = useCallback(() => setLocked(false), []);

  useEffect(() => {
    const markHidden = () => {
      // Only the first hide in a run counts, pagehide and visibilitychange
      // can both fire, and re-stamping would shrink the measured absence.
      if (hiddenAtRef.current === null) {
        hiddenAtRef.current = { mono: performance.now(), wall: Date.now() };
        // Cover now, not on return: by then the frame that matters may already
        // have been painted.
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

      if (absenceMs(since) < RESUME_GRACE_MS) {
        setCover(false);
        return;
      }

      // Read the store, not component state: a PIN may have been set since
      // mount.
      try {
        // flushSync, not setState: the cover is removed below in this same
        // task, and a deferred render would paint the app first, the exact
        // flash this path prevents.
        if (isLockSet()) flushSync(() => setLocked(true));
      } finally {
        // Always uncover, even if the commit throws: a leftover cover would be
        // a black screen the user cannot dismiss.
        setCover(false);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markHidden();
      else handleShow();
    };

    // visibilitychange is primary; pagehide/pageshow covers being frozen rather
    // than merely hidden.
    //
    // NOT window blur: it fires for the keyboard, native dialogs and the
    // context menu, and would lock the user mid-interaction. Tizen's lifecycle
    // API is skipped, its surface varies by platform version.
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
