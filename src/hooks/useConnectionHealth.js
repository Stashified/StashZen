/**
 * useConnectionHealth: subscribe to the shared connection state.
 *
 * The state lives in utils/connectionHealth.js because the transport writes it
 * and the UI reads it; this hook is only the React binding.
 */

import { useEffect, useState } from 'react';
import { getConnectionState, subscribeConnection } from '../utils/connectionHealth.js';

export function useConnectionHealth() {
  const [state, setState] = useState(getConnectionState);

  useEffect(() => {
    let live = true;
    const sync = () => { if (live) setState(getConnectionState()); };
    const off = subscribeConnection(sync);
    // A verdict can land between the first render and this effect.
    sync();
    return () => { live = false; off(); };
  }, []);

  return state;
}
