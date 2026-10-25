/**
 * stashUrl.js — Attach the API key to Stash media URLs.
 *
 * GraphQL requests send an `ApiKey` header. Media cannot: `<img>`, `<video
 * poster>`, CSS `background-image` and the browser's fetch of the sprite VTT
 * send no headers, so the key travels in the URL.
 *
 * Stash only does that for `paths.stream`, because that endpoint is meant for
 * external players. Every other path comes back bare — `screenshot`,
 * `preview`, `sprite`, `vtt`, a performer's `image_path` — and an
 * unauthenticated request gets a `302 → /login?returnURL=…`; the browser then
 * tries to decode the login page as a JPEG and renders nothing.
 *
 * That is why Live mode can show no thumbnails while Test mode looks fine:
 * Test-mode covers are inline SVG data URIs (`mockArt.js`), so they never reach
 * the network and there is nothing to rewrite.
 *
 * Only URLs on the configured Stash host are rewritten; mock and genuinely
 * external assets pass through untouched.
 */

import { getSettings } from './settings.js';

export function withApiKey(url) {
  if (!url || typeof url !== 'string') return url;

  // Already authenticated — Stash's own `paths.stream` arrives this way.
  if (/[?&]apikey=/i.test(url)) return url;

  const { stashUrl, stashKey } = getSettings();
  if (!stashKey) return url;

  try {
    if (new URL(url, stashUrl).host !== new URL(stashUrl).host) return url;
  } catch (e) {
    // Unparseable, or no usable base — leave it alone rather than guess.
    return url;
  }

  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}apikey=${encodeURIComponent(stashKey)}`;
}
