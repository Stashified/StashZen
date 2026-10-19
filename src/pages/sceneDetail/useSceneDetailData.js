import { useEffect, useState } from 'react';
import { fromCard, loadSceneDetail } from '../../utils/sceneService.js';

/**
 * The page's data — two sources of truth, on purpose.
 *
 * `detail` starts as the card the user pressed Enter on: it already has the
 * title, screenshot, duration and resume point, so the page paints
 * immediately instead of showing a spinner over data the user is looking at.
 * The detail query then replaces what it can answer and adds what a card
 * never carries: organized, o_counter, details, codecs, last_played_at.
 *
 * `canEdit` is false until that lands (and in Test mode, where the ids
 * belong to generated data with no row behind them), because writing a
 * rating the user hasn't actually read yet is the one way this page could
 * silently corrupt a value — the card's rating is a display string rounded
 * for the grid, and pressing "+" against it could write 80 to a scene Stash
 * has at 75.
 */
export function useSceneDetailData(scene) {
  const [detail, setDetail] = useState(() => fromCard(scene));
  const [status, setStatus] = useState('loading');   // loading | ready | error
  const [loadError, setLoadError] = useState(null);

  // ── Load ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    loadSceneDetail(scene)
      .then(full => {
        if (cancelled) return;
        if (!full) {
          // Server answered for a scene it doesn't have. Keep the card data
          // and leave the actions disabled rather than pretending we know
          // its rating.
          setStatus('error');
          setLoadError('Scene not found on the server.');
          return;
        }
        setDetail(full);
        setStatus('ready');
      })
      .catch(e => {
        if (cancelled) return;
        setStatus('error');
        setLoadError(e.message);
      });

    return () => { cancelled = true; };
  }, [scene]);

  // Editable only once the real values are on screen, and never in Test mode
  // where the ids belong to generated data with no row behind them.
  const canEdit = status === 'ready' && detail?.writable !== false;

  return { detail, setDetail, status, loadError, canEdit };
}
