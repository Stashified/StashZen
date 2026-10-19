import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Two-step confirm for a destructive button: the first press arms it, the
 * second commits, and it disarms itself after `timeoutMs` so a forgotten
 * press does not stay live.
 *
 * `run(commit)` is the whole interaction. On the first call it only arms,
 * and the caller shows the armed label. On the second it disarms *before*
 * running `commit`, so a commit that throws or writes asynchronously cannot
 * leave the button one press away from firing again.
 *
 * The timeout is held in a ref and cleared on unmount, and arming again
 * restarts it — the same rules as useFlash: a timer is never left to fire
 * into a component that is already gone.
 */
export function useArmedConfirm({ timeoutMs = 4000 } = {}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // Disarm when the component goes away — leaving the timer behind would make
  // it set state on an unmounted component.
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
