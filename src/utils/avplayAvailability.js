/**
 * avplayAvailability, is the TV's own player there, and load it if not.
 *
 * `window.webapis` is normally present; on some firmware the media APIs only
 * appear after the WebAPI script is pulled in. `$WEBAPIS/webapis/webapis.js`
 * is rewritten by Tizen to a local path on install, so it costs nothing and
 * cannot hit the network.
 *
 * The load is attempted once per session and the promise shared, so concurrent
 * scenes wait on one attempt. Failure is a normal answer, the caller falls
 * back to the browser, not something to propagate.
 */

const WEBAPIS_SRC = '$WEBAPIS/webapis/webapis.js';

let loading = null;

/** The live AVPlay object, or null. Never throws (a missing `webapis` can). */
export function avplayNow(win = typeof window !== 'undefined' ? window : null) {
  try {
    return win?.webapis?.avplay || null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve with the AVPlay object, injecting the WebAPI script if needed.
 *
 * @param {{ timeoutMs?: number, doc?: Document }} [opts]
 * @returns {Promise<object|null>} null when the panel has no AVPlay at all.
 */
export function ensureAvplay({
  timeoutMs = 1500,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
} = {}) {
  const present = avplayNow(win);
  if (present) return Promise.resolve(present);
  if (loading) return loading;
  if (!doc || !win) {
    loading = Promise.resolve(null);
    return loading;
  }

  loading = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Keep the resolved value cached even when it is null: a panel without
      // AVPlay must not pay the timeout again on every scene.
      resolve(value);
    };
    const el = doc.createElement('script');
    el.src = WEBAPIS_SRC;
    el.async = true;
    el.onload = () => finish(avplayNow(win));
    el.onerror = () => finish(null);
    const timer = setTimeout(() => finish(avplayNow(win)), timeoutMs);
    doc.head.appendChild(el);
  });
  return loading;
}

/** Test hook: forget a failed attempt between harness runs. */
export function resetAvplayProbe() {
  loading = null;
}
