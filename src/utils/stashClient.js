/**
 * stashClient.js — the single HTTP transport for Stash.
 *
 * This module is deliberately *pure*: it imports nothing, and takes the
 * endpoint and API key as arguments. Callers read them from the settings
 * store (`getSettings()`) and pass them in. That keeps the dependency
 * graph one-way — settings.js can use `fetchWithTimeout` without the
 * cycle that `stashClient → settings → stashClient` would create.
 *
 * Why this exists: every request used to be a bare `fetch` with no
 * timeout. On a TV, a request to an unreachable-but-routable host never
 * settles, so the UI sat on "Loading…" forever with no error and no
 * retry. Every request now fails within DEFAULT_TIMEOUT_MS and surfaces
 * a message the user can act on.
 *
 * Tizen compatibility note: `AbortController` landed in Chromium 66 and
 * `AbortSignal.timeout()` in Chromium 103. The app's floor is Tizen 6.5
 * (Chromium 94), so the controller exists there but the signal helper does
 * not. We therefore always race against a timer — which is what guarantees
 * the promise settles — and only *additionally* abort the socket when
 * AbortController happens to exist. The typeof guard is belt and braces:
 * `npm run check:compat` would flag the controller on an older engine.
 */

/** How long any single request may take before it is reported as failed. */
export const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Error carrying a machine-readable `code` so callers can distinguish
 * "your config is wrong" from "the server is slow" without parsing prose.
 * `message` is written to be shown directly to the user — several pages
 * render `error.message` verbatim.
 *
 * `status` carries the HTTP status when `code` is 'http'. Callers that need to
 * tell a rejected API key (401/403) from any other server error would otherwise
 * have to parse the message, which is exactly the prose-sniffing `code` exists
 * to prevent. `status` is undefined for every other code.
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
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new StashError('The server took too long to respond.', 'timeout'));
    }, timeoutMs);
  });

  const request = fetch(url, controller ? { ...options, signal: controller.signal } : options);
  // If the timer wins the race, this promise may still reject later with
  // AbortError. Nothing is awaiting it by then, so swallow it here rather
  // than let it surface as an unhandled rejection.
  request.catch(() => {});

  try {
    return await Promise.race([request, timedOut]);
  } catch (e) {
    if (e instanceof StashError) throw e;
    // Our own abort() surfaces as AbortError — report it as the timeout
    // it was, not as a generic network failure.
    if (e?.name === 'AbortError' && controller?.signal.aborted) {
      throw new StashError('The server took too long to respond.', 'timeout');
    }
    throw new StashError(
      'Cannot reach the Stash server. Check the URL and that the TV is on the same network.',
      'network',
    );
  } finally {
    clearTimeout(timer);
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

  const res = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }, timeoutMs);

  if (!res.ok) {
    // Stash returns a *rejected filter* — a criterion in the wrong shape — as a
    // non-2xx status (400 in practice) whose body still carries a precise
    // GraphQL error, e.g. `cannot use map as Boolean`. The old code threw on the
    // status alone and never read the body, so every malformed filter reached
    // the user as "GraphQL HTTP 400" with no indication of which criterion was
    // wrong. Read the body before giving up on the detail.
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

  let json;
  try {
    json = await res.json();
  } catch {
    // A session wall or captive portal answers 200 with HTML.
    throw new StashError('The server returned an unexpected response.', 'parse');
  }

  if (json.errors) throw new StashError(json.errors[0]?.message || 'GraphQL error', 'graphql');
  return json.data;
}
