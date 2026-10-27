/**
 * statsService.js: Library-wide aggregate numbers from Stash.
 *
 * One query, no arguments. `stats` is the aggregate Stash keeps for its own
 * dashboard; the handful of fields displayed is cheap and does not touch the
 * 40-row listing payloads.
 *
 * `group_count` and `movie_count` are deliberately absent: both measured 0 on
 * the 0.31.1 server this app targets, and neither is displayed.
 */

import { getSettings } from './settings.js';
import { runQuery } from './stashQuery.js';

const LIBRARY_STATS_QUERY = `
  query LibraryStats {
    stats {
      scene_count
      scenes_size
      scenes_duration
      image_count
      images_size
      gallery_count
      performer_count
      studio_count
      tag_count
      total_o_count
      total_play_duration
      total_play_count
      scenes_played
    }
  }
`;

function num(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * `scenes_size` and `images_size` are byte sums and there is no total-bytes
 * field, so the two are added here; everything else passes through with a
 * numeric fallback so a missing field renders 0 rather than `undefined`.
 */
export function normalizeStats(raw) {
  if (!raw) return null;
  return {
    sceneCount: num(raw.scene_count),
    imageCount: num(raw.image_count),
    galleryCount: num(raw.gallery_count),
    performerCount: num(raw.performer_count),
    studioCount: num(raw.studio_count),
    tagCount: num(raw.tag_count),
    totalBytes: num(raw.scenes_size) + num(raw.images_size),
    sceneSeconds: num(raw.scenes_duration),
    playSeconds: num(raw.total_play_duration),
    playCount: num(raw.total_play_count),
    scenesPlayed: num(raw.scenes_played),
    oCount: num(raw.total_o_count),
  };
}

// Test mode has no server to aggregate. These numbers are fixed so a
// screenshot or a check never depends on when it ran.
export function mockStats() {
  return {
    sceneCount: 48,
    imageCount: 1245,
    galleryCount: 32,
    performerCount: 60,
    studioCount: 6,
    tagCount: 48,
    totalBytes: 5 * 1024 ** 3,
    sceneSeconds: 48 * 3600,
    playSeconds: 4 * 3600,
    playCount: 211,
    scenesPlayed: 40,
    oCount: 190,
  };
}

/**
 * Throws on transport or GraphQL errors so the Settings panel can show the
 * message. Returns null when the server answers without a `stats` object.
 */
export async function loadLibraryStats() {
  if (getSettings().useMock) return mockStats();
  const data = await runQuery(LIBRARY_STATS_QUERY);
  return normalizeStats(data?.stats);
}
