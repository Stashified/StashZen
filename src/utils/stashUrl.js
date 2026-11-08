/**
 * stashUrl.js: Attach the API key to Stash media URLs.
 *
 * GraphQL requests send an `ApiKey` header. Media cannot: `<img>`, `<video
 * poster>`, CSS `background-image` and the browser's fetch of the sprite VTT
 * send no headers, so the key travels in the URL.
 *
 * Stash 0.31 keys `paths.stream` itself, because that endpoint is meant for
 * external players; a server with credentials (0.32+) signs it instead. Every
 * other path comes back bare, `screenshot`, `preview`, `sprite`, `vtt`, a
 * performer's `image_path`, and an unauthenticated request gets a
 * `302 → /login?returnURL=…`; the browser then tries to decode the login page
 * as a JPEG and renders nothing.
 *
 * `stream` gets the key even when signed: the key outlives the signature, and
 * Stash prefers it for HLS segments.
 *
 * That is why Live mode can show no thumbnails while Test mode looks fine:
 * Test-mode covers are inline SVG data URIs (`mockArt.js`), so they never reach
 * the network and there is nothing to rewrite.
 *
 * Any http(s) URL is rewritten, not only one on the configured host. Every URL
 * passed here is a media path the server built, and Stash builds those on
 * `external_host` when it is set, which can differ from the endpoint the TV
 * uses. The server already receives the key, so its own media URLs may carry
 * it too. Data URIs and other non-network assets are left alone.
 */

import { getSettings } from './settings.js';

/**
 * Stash answers an entity with no artwork using one shared placeholder and
 * marks it `default=true`. The URL is a normal 200, so `onError` never sees
 * it; treat the flag as "no picture" or every card in a section shows the same
 * icon.
 */
export function isDefaultAsset(url) {
  return typeof url === 'string' && /[?&]default=true(?:&|#|$)/.test(url);
}

export function withApiKey(url) {
  if (!url || typeof url !== 'string') return url;

  // The fragment never reaches the server, so the key goes before it.
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);

  // Already keyed: by Stash, or by an earlier call.
  if (/[?&]apikey=/i.test(base)) return url;

  const { stashUrl, stashKey } = getSettings();
  if (!stashKey) return url;

  let parsed;
  try {
    parsed = new URL(base, stashUrl || undefined);
  } catch (e) {
    // Unparseable, or a relative path with no usable base. Leave it alone
    // rather than guess.
    return url;
  }
  // The origin is deliberately not compared with `stashUrl`: with
  // `external_host` set, Stash returns its own media on another origin.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;

  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}apikey=${encodeURIComponent(stashKey)}${fragment}`;
}
