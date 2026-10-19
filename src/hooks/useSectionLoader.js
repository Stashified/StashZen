import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The closed → loading → ready/error state machine shared by the Settings
 * sections that load a snapshot on demand.
 *
 * Two behaviours live here because both sections need them identically:
 *
 *   - Stale answers never paint. A hide, a second load or an unmount bumps a
 *     token; a response whose token no longer matches is dropped.
 *   - Opening the content scrolls the section to the top. The sections sit
 *     below the connection and playback cards, so a grid that renders where
 *     it sits would be mostly off-screen while focus stays on the button.
 *
 * The click semantics are deliberately *not* here: the stats section hides
 * when pressed while open, the server section refreshes. Each caller composes
 * its own handler from `phase`, `data`, `load`, `show` and `hide`.
 *
 * `loadData` should be a stable function (a module-level service call); it is
 * a dependency of the returned `load`.
 */
export function useSectionLoader(loadData, { emptyMessage = 'The server returned no data.' } = {}) {
  const [phase, setPhase] = useState('closed');   // closed | loading | ready | error
  const [data, setData] = useState(null);
  const [message, setMessage] = useState('');
  const sectionRef = useRef(null);
  // Stale answers from a hidden or unmounted section must not paint. Same
  // token pattern the pages use, but a ref because nothing re-renders for it.
  const requestRef = useRef(0);

  useEffect(() => () => { requestRef.current += 1; }, []);

  useEffect(() => {
    if (phase === 'ready') sectionRef.current?.scrollIntoView({ block: 'start' });
  }, [phase]);

  const load = useCallback(async () => {
    const token = ++requestRef.current;
    setPhase('loading');
    setMessage('');
    try {
      const next = await loadData();
      if (token !== requestRef.current) return;
      if (!next) {
        setPhase('error');
        setMessage(emptyMessage);
        return;
      }
      setData(next);
      setPhase('ready');
    } catch (e) {
      if (token !== requestRef.current) return;
      setPhase('error');
      setMessage(e.message);
    }
  }, [loadData, emptyMessage]);

  // Show a held answer again without refetching; hide keeps it in `data`.
  const show = useCallback(() => setPhase('ready'), []);
  const hide = useCallback(() => setPhase('closed'), []);

  return { phase, data, message, load, show, hide, sectionRef };
}
