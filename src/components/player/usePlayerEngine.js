/**
 * usePlayerEngine — whether this session can use the TV's player, and the
 * objects needed to drive it.
 *
 * Three inputs decide it, and they are checked in this order:
 *
 *   Browser       the Settings lever: today's player, and the rollback path.
 *                 `Auto` and `TV player` both allow AVPlay — they differ only
 *                 in which engine the candidate plan puts first.
 *   forced        build-level `__FORCE_BROWSER_ENGINE__`, for a release that
 *                 has to disable AVPlay entirely without a settings migration
 *   availability  AVPlay is present, or the WebAPI script loads in time
 *
 * Availability is asynchronous only when the panel does not already expose
 * `window.webapis.avplay`. The source resolver waits for `ready` before it
 * builds a plan, so the first scene never starts on the browser and then
 * switches engines under the user. The wait is bounded by ensureAvplay's 1.5 s
 * timeout, and on a Tizen widget the script is local.
 *
 * The setting is read when the player opens rather than subscribed to: a
 * mid-scene Settings change does not exist — Settings is not reachable from the
 * player — and "applies on the next open" is what the setting's own hint says.
 */

import { useEffect, useState } from 'react';
import { ensureAvplay, avplayNow } from '../../utils/avplayAvailability.js';
import { readPlaybackEngine } from '../../utils/enginePolicy.js';
import { getSettings } from '../../utils/settings.js';

/** The build-level rollback. Undefined in an ordinary build. */
export function readForcedBrowser() {
  try {
    return !!__FORCE_BROWSER_ENGINE__;
  } catch (e) {
    return false;
  }
}

const tvAudio = () => {
  try {
    return window.tizen?.tvaudiocontrol || null;
  } catch (e) {
    return null;
  }
};

export function usePlayerEngine() {
  const setting = readPlaybackEngine(getSettings().playbackEngine);
  const forcedBrowser = readForcedBrowser();
  const allowed = setting !== 'browser' && !forcedBrowser;

  const [avplay, setAvplay] = useState(() => (allowed ? avplayNow() : null));
  const [ready, setReady] = useState(() => !allowed || !!avplayNow());

  useEffect(() => {
    if (!allowed) {
      setReady(true);
      return undefined;
    }
    if (avplay) {
      setReady(true);
      return undefined;
    }
    let live = true;
    setReady(false);
    ensureAvplay().then((api) => {
      if (!live) return;
      setAvplay(api || null);
      setReady(true);
    });
    return () => { live = false; };
  }, [allowed, avplay]);

  return {
    setting,
    forcedBrowser,
    /** Null while the question is open, or when the panel has no AVPlay. */
    avplay: ready ? avplay : null,
    tvaudiocontrol: ready ? tvAudio() : null,
    /** The source resolver must not build a plan until this is true. */
    ready,
  };
}
