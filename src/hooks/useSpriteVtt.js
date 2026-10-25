/**
 * useSpriteVtt — fetch and parse a Stash sprite VTT file
 *
 * `paths.sprite` is the tile sheet and `paths.vtt` maps time ranges to tile
 * rects, encoded in the `xywh` URL fragment of each cue payload:
 *
 *   00:00:00.000 --> 00:00:10.000
 *   sprite_abc123.jpg#xywh=0,0,160,90
 *
 * Returns `{ ready, getCue(seconds) → { x, y, w, h, src } | null, error }`.
 * `src` is resolved relative to the VTT URL — Stash sometimes gives a relative
 * filename, sometimes a full URL.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { withApiKey } from '../utils/stashUrl.js';
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from '../utils/stashClient.js';

function parseTimestamp(ts) {
  // 00:00:00.000 or 00:00.000
  const parts = ts.trim().split(':');
  let s;
  if (parts.length === 3) {
    s = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    s = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
  } else {
    s = parseFloat(parts[0]);
  }
  return isNaN(s) ? 0 : s;
}

function parseVtt(text, vttUrl) {
  const lines = text.split(/\r?\n/);
  const cues = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim());
      const start = parseTimestamp(startStr);
      const end   = parseTimestamp(endStr);

      // The next non-empty line is the payload (URL with #xywh=)
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const payload = (lines[j] || '').trim();

      const hashIdx = payload.indexOf('#xywh=');
      if (hashIdx > -1) {
        const fileRef = payload.slice(0, hashIdx);
        const xywh = payload.slice(hashIdx + 6).split(',').map(n => parseInt(n, 10));
        if (xywh.length === 4 && xywh.every(n => !isNaN(n))) {
          // Resolving a relative reference drops the VTT's query string, so
          // re-attach the API key or the tile sheet is fetched unauthenticated
          // and returns Stash's login page.
          let src;
          try {
            src = withApiKey(new URL(fileRef, vttUrl).href);
          } catch (e) {
            src = withApiKey(fileRef);
          }
          cues.push({
            start,
            end,
            x: xywh[0],
            y: xywh[1],
            w: xywh[2],
            h: xywh[3],
            src,
          });
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  // Sort by start so we can binary-search later
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

// Module-level LRU so channel-surfing does not re-fetch and does not hold
// every VTT ever seen. Map preserves insertion order, so a delete/re-set on a
// hit evicts the least recently used.
const vttCache = new Map(); // vttUrl → cues[]
const MAX_CACHE_ENTRIES = 24;

function cacheVtt(url, cues) {
  vttCache.set(url, cues);
  while (vttCache.size > MAX_CACHE_ENTRIES) {
    vttCache.delete(vttCache.keys().next().value);
  }
}

export function useSpriteVtt(vttUrl) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const cuesRef = useRef([]);

  useEffect(() => {
    cuesRef.current = [];
    setReady(false);
    setError(null);

    if (!vttUrl) return undefined;

    // Cache hit — touch it so it is not the next entry evicted.
    if (vttCache.has(vttUrl)) {
      const cues = vttCache.get(vttUrl);
      vttCache.delete(vttUrl);
      vttCache.set(vttUrl, cues);
      cuesRef.current = cues;
      setReady(true);
      return undefined;
    }

    let cancelled = false;
    // The cleanup can run while the request is open (channel surfing unmounts
    // the player); abort it rather than finishing a body nobody wants. The
    // standard timeout stops a stalled media URL holding the skim bar forever.
    const controller = new AbortController();
    fetchWithTimeout(vttUrl, { signal: controller.signal }, DEFAULT_TIMEOUT_MS, res => {
      if (!res.ok) throw new Error(`VTT HTTP ${res.status}`);
      return res.text();
    })
      .then(text => {
        if (cancelled) return;
        const cues = parseVtt(text, vttUrl);
        cacheVtt(vttUrl, cues);
        cuesRef.current = cues;
        setReady(true);
      })
      .catch(e => {
        if (cancelled) return;
        setError(e.message);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vttUrl]);

  const getCue = useCallback((seconds) => {
    const cues = cuesRef.current;
    if (!cues.length) return null;

    // Binary search for the cue whose [start, end) contains `seconds`
    let lo = 0, hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cues[mid];
      if (seconds < c.start) hi = mid - 1;
      else if (seconds >= c.end) lo = mid + 1;
      else return c;
    }
    // Past the last cue — return last; before the first — return first
    if (seconds < cues[0].start) return cues[0];
    return cues[cues.length - 1];
  }, []);

  return { ready, getCue, error };
}
