/**
 * endpointUrl, the one rule for a user-typed Stash endpoint.
 *
 * Shared by Settings and first-run so the two screens cannot disagree. A bare
 * `host:port` is accepted and stored as `http://host:port`: typing the scheme
 * with a remote is the likeliest miss, and first-run used to pass it straight
 * to fetch, which failed as a relative request and blamed the network.
 */

/**
 * @returns {{ok: true, url: string} | {ok: false, url: '', error: string}}
 */
export function normalizeEndpointUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { ok: false, url: '', error: 'Enter the Stash endpoint before saving.' };
  }

  // Only prepend when there is no scheme at all; a wrong scheme must be
  // refused, not bent into http://wrong:...
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, url: '', error: 'The endpoint must be an http:// or https:// URL.' };
    }
    // `fetch` refuses a URL carrying credentials with a TypeError, which
    // `stashClient` would report as a network fault. Refuse it here, where the
    // message can say what is wrong. It also keeps the password out of storage.
    if (parsed.username || parsed.password) {
      return {
        ok: false,
        url: '',
        error: 'Enter the server address without a username or password.',
      };
    }
    // `stashClient` appends `/graphql` textually, so a query or fragment would
    // put it after them and the request would miss the API path.
    if (text.includes('?') || text.includes('#')) {
      return {
        ok: false,
        url: '',
        error: 'Enter the server address only, without a query string or #fragment.',
      };
    }
    return { ok: true, url: candidate };
  } catch {
    // Not a URL at all.
  }
  return { ok: false, url: '', error: 'The endpoint must be an http:// or https:// URL.' };
}
