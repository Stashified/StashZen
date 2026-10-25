import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Two-step confirm for a destructive button: the first press arms it, the
 * second commits, and it disarms itself after `timeoutMs` so a forgotten
 * press does not stay live.
 *
 * On the second press it disarms *before* running `commit`, so a commit that
 * throws or writes asynchronously cannot leave the button one press from
 * firing again. The timer is cleared on unmount — never left to fire into a
 * component that is gone.
 */
export function useArmedConfirm({ timeoutMs = 4000 } = {}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Leaving the timer behind would set state on an unmounted component.
  useEffect(() => () => clearTimer(), [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setArmed(false);
  }, [clearTimer]);

  const run = useCallback((commit) => {
    if (!armed) {
      clearTimer();
      setArmed(true);
      timerRef.current = setTimeout(() => setArmed(false), timeoutMs);
      return;
    }
    reset();
    commit?.();
  }, [armed, clearTimer, reset, timeoutMs]);

  return [armed, run, reset];
}
