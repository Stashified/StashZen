import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A transient status line: `flash(message)` shows it and clears itself after
 * `timeoutMs`. A second flash restarts the clock, so the visible message is
 * always the current one.
 *
 * The timer is cleared on unmount rather than left to fire into a gone page;
 * `notice` starts as '' because callers render it unconditionally into an
 * `aria-live` line.
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
