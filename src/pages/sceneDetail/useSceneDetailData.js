import { useEffect, useState } from 'react';
import { fromCard, loadSceneDetail } from '../../utils/sceneService.js';

/**
 * The page's data — two sources of truth, on purpose.
 *
 * `detail` starts as the card the user pressed Enter on (title, screenshot,
 * duration, resume point), so the page paints immediately instead of spinning.
 * The detail query then adds what a card never carries: organized, o_counter,
 * details, codecs, last_played_at.
 *
 * `canEdit` is false until that lands (and in Test mode, where ids have no row
 * behind them): the card's rating is a display string rounded for the grid, so
 * pressing "+" against it could write 80 to a scene Stash has at 75.
 */
export function useSceneDetailData(scene) {
  const [detail, setDetail] = useState(() => fromCard(scene));
  const [status, setStatus] = useState('loading');   // loading | ready | error
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    loadSceneDetail(scene)
      .then(full => {
        if (cancelled) return;
        if (!full) {
          // Server answered for a scene it doesn't have: keep the card data
          // and leave actions disabled rather than pretend we know its rating.
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

  // Editable only once the real values are on screen, and never in Test mode.
  const canEdit = status === 'ready' && detail?.writable !== false;

  return { detail, setDetail, status, loadError, canEdit };
}
