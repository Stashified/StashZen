import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A transient status line: `flash(message)` shows it, and it clears itself
 * after `timeoutMs`.
 *
 * The timer is held in a ref and cleared on unmount, not left to fire into a
 * page or panel that is already gone. A second `flash` restarts the clock, so
 * the message the user is reading is always the one that is still on screen.
 *
 * The notice starts as '' rather than null because every caller renders it
 * unconditionally into an `aria-live` line; an empty string is the quiet state.
 */
export function useFlash(timeoutMs = 4000) {
  const [notice, setNotice] = useState('');
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flash = useCallback((message) => {
    setNotice(message);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setNotice(''), timeoutMs);
  }, [timeoutMs]);

  return [notice, flash];
}
