/**
 * stashUrl.js — Attach the API key to Stash media URLs.
 *
 * GraphQL requests authenticate with an `ApiKey` header. Media gets no such
 * luxury: `<img>`, `<video poster>`, a CSS `background-image` and the browser's
 * own fetch of the sprite VTT cannot send headers, so the key has to travel in
 * the URL itself.
 *
 * Stash only does that for `paths.stream`, because that endpoint is meant for
 * external players. Every other path comes back bare — `screenshot`,
 * `preview`, `sprite`, `vtt`, and a performer's `image_path` — and an
 * unauthenticated request is answered with `302 → /login?returnURL=…`. The
 * browser then tries to decode Stash's login page as a JPEG and renders
 * nothing at all.
 *
 * That is why Live mode can show no thumbnails at all while Test mode looks
 * perfectly fine — and the reason is worth stating precisely, because this
 * sentence spent several releases describing the opposite of the truth. It
 * used to say Test mode "points at external placeholder URLs"; Test-mode
 * covers have been inline SVG data URIs since `mockArt.js` (0.7.5). They never
 * reach the network, so they never meet this problem: Test mode is not a case
 * of the rewrite working, it is a case of there being nothing to rewrite.
 *
 * Only URLs on the configured Stash host are rewritten, so mock data and any
 * genuinely external asset pass through untouched.
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
