/**
 * stashClient.js — the single HTTP transport for Stash.
 *
 * Deliberately *pure*: it imports nothing and takes endpoint and API key as
 * arguments, keeping the dependency graph one-way — settings.js can use
 * `fetchWithTimeout` without a `stashClient → settings → stashClient` cycle.
 *
 * Every request needs a timeout: on a TV a request to an unreachable-but-
 * routable host never settles, leaving the UI on "Loading…" forever. Each
 * request fails within DEFAULT_TIMEOUT_MS with a message the user can act on.
 *
 * Tizen compatibility: `AbortController` is Chromium 66, `AbortSignal.timeout()`
 * Chromium 103; the floor is Tizen 6.5 (Chromium 94), so the controller exists
 * but the helper does not. We always race a timer — that is what settles the
 * promise — and *additionally* abort the socket when a controller exists. The
 * typeof guard is belt and braces: `check:compat` flags the controller on an
 * older engine.
 */

/** How long any single request may take before it is reported as failed. */
export const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Error carrying a machine-readable `code` so callers can distinguish a config
 * problem from a slow server without parsing prose. `message` is shown
 * directly to the user — several pages render it verbatim.
 *
 * `status` is the HTTP status when `code` is 'http', so a rejected API key
 * (401/403) is distinguishable from other server errors without prose-sniffing.
 * Undefined for every other code.
 */
export class StashError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'StashError';
    this.code = code;   // 'config' | 'timeout' | 'network' | 'http' | 'parse' | 'graphql'
    this.status = status;
  }
}

/**
 * `fetch` that cannot hang. Resolves to a Response, or rejects with a
 * StashError whose code is 'timeout' or 'network'.
 *
 * `consume` runs *inside* the timeout, before the timer is cleared: `fetch`
 * resolves when headers arrive, so a server that sends headers and stalls the
 * body would leave `res.json()` pending forever. Passing the read as `consume`
 * keeps it under the same budget and abort signal.
 */
export async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  consume = res => res,
) {
  const external = options.signal || null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  // The caller's own signal (an unmount abort) must still cancel the socket.
  // The controller below belongs to the timeout and replaces `options.signal`
  // on the fetch, so it has to follow the external one too.
  const onExternalAbort = () => controller?.abort();
  if (external && controller) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }

  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new StashError('The server took too long to respond.', 'timeout'));
    }, timeoutMs);
  });

  const request = fetch(url, controller ? { ...options, signal: controller.signal } : options)
    .then(consume);
  // If the timer wins the race, this promise may still reject later with
  // AbortError. Nothing is awaiting it by then, so swallow it here rather
  // than let it surface as an unhandled rejection.
  request.catch(() => {});

  try {
    return await Promise.race([request, timedOut]);
  } catch (e) {
    if (e instanceof StashError) throw e;
    if (e?.name === 'AbortError') {
      // The caller cancelled it (the hook that owns it ignores the rejection,
      // but it must not be reported as a timeout).
      if (external?.aborted) throw e;
      // Our own abort() surfaces as AbortError — report it as the timeout
      // it was, not as a generic network failure.
      if (controller?.signal.aborted) {
        throw new StashError('The server took too long to respond.', 'timeout');
      }
    }
    throw new StashError(
      'Cannot reach the Stash server. Check the URL and that the TV is on the same network.',
      'network',
    );
  } finally {
    clearTimeout(timer);
    external?.removeEventListener?.('abort', onExternalAbort);
  }
}

/**
 * Run a GraphQL query and return `data`, or throw a StashError.
 *
 * @param {string} query
 * @param {object} variables
 * @param {{url?: string, key?: string, timeoutMs?: number}} target
 */
export async function graphqlRequest(query, variables, { url, key, timeoutMs } = {}) {
  if (!url) {
    throw new StashError(
      'No Stash server configured. Open Settings and enter your server URL.',
      'config',
    );
  }

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['ApiKey'] = key;

  const json = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }, timeoutMs, async (res) => {
    if (!res.ok) {
      // Stash returns a rejected filter (a criterion in the wrong shape) as a
      // non-2xx status — 400 in practice — whose body still carries a precise
      // GraphQL error, e.g. `cannot use map as Boolean`. Throw on status alone
      // and the user sees only "GraphQL HTTP 400", with no idea which
      // criterion was wrong, so read the body before giving up on the detail.
      let detail = null;
      try {
        const body = await res.json();
        detail = body?.errors?.[0]?.message || null;
      } catch {
        // Not JSON (a proxy error page, say) — the status is all we have.
      }
      throw new StashError(
        detail ? `GraphQL HTTP ${res.status}: ${detail}` : `GraphQL HTTP ${res.status}`,
        'http',
        res.status,
      );
    }

    try {
      return await res.json();
    } catch {
      // A session wall or captive portal answers 200 with HTML.
      throw new StashError('The server returned an unexpected response.', 'parse');
    }
  });

  if (json.errors) throw new StashError(json.errors[0]?.message || 'GraphQL error', 'graphql');
  return json.data;
}
