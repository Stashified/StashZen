/**
 * playQueue.js — the two shapes a playback session is built from.
 *
 * Every entry point into the player produces the same shape — a queue plus
 * the index to start at — so the player has one code path rather than a
 * "single video" one and a "queue" one that can drift apart.
 */

/**
 * A queue of one: the detail page's Play, and a marker.
 *
 * `fetchPage: null` is what tells the queue it has nowhere to extend into.
 * A longer queue comes from a view — its array, the total the server
 * reported, the page it stopped at, and its own `fetchPage` closure. See
 * usePlayQueue.
 */
export function queueOf(video, startSeconds = 0) {
  return {
    items: [video], total: 1, page: 1, startIndex: 0, startSeconds, fetchPage: null,
  };
}

/**
 * The queue item for a marker. A marker is a timestamp inside a scene, so it
 * opens without the scene browser in front of it — but the item has to carry
 * everything the player reads from a grid card.
 *
 * Two markers on one scene produce the same `id` on purpose: the player's
 * queue is keyed by scene, and the dedupe in `markerQueueItems` relies on it.
 */
export function queueItemFromMarker(marker) {
  return {
    id: marker.scene.id,
    // The marker this row came from, so a marker queue can put the cursor
    // back on the marker card for the scene last viewed — the scene id alone
    // does not name a card in the Markers tab. See usePlayback.
    markerId: marker.id ?? null,
    title: `${marker.scene.title} — ${marker.title}`,
    stream: marker.scene.stream,
    thumbnail: marker.screenshot || marker.scene.screenshot,
    // Forward the parent scene's sprite/vtt so the player's skim
    // preview works exactly as it does for full-scene playback.
    sprite: marker.scene.sprite,
    vtt: marker.scene.vtt,
    // And its codec fields, for the same reason: this queue item is built by
    // hand rather than taken from the grid, so a marker on a scene the TV
    // cannot decode would otherwise be the one playback path that never
    // consults them. See playbackSource.js.
    videoCodec: marker.scene.videoCodec,
    audioCodec: marker.scene.audioCodec,
    container: marker.scene.container,
    // The timeline and the resume end threshold both read this. See the
    // same field in markerService's normalizer.
    durationSeconds: marker.scene.durationSeconds,
    studio: null,
  };
}

/**
 * The queue rows for a run of markers, one per scene.
 *
 * The Markers tab lists markers, but the player plays scenes: two markers on
 * one scene are two ways into the same video. Keeping both would make the
 * queue walk into a scene it has just left, and the player's dedupe would drop
 * the second a moment later — silently, so the counter would disagree.
 * First occurrence wins, in listing order.
 *
 * Each row also carries `startSeconds`. Only the starting row's timestamp is
 * read (`VideoPlayer`'s `index === startIndex` rule), so a later value is
 * inert — but keeping it lets "Play from here" start on its marker without a
 * second code path.
 */
export function markerQueueItems(markers) {
  const seen = new Set();
  const items = [];
  for (const marker of markers || []) {
    const item = queueItemFromMarker(marker);
    const id = item.id == null ? '' : String(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({ ...item, startSeconds: marker.seconds || 0 });
  }
  return items;
}

/**
 * A play queue seeded from the Markers listing.
 *
 * `markers` is the run to start with — the whole loaded listing for "Play all",
 * or rows from the pressed marker onward for "Play from here". Paging continues
 * the *marker* listing, mapping each page through `markerQueueItems` so the
 * dedupe also applies to rows arriving while playing. `total` is the marker
 * count, an upper bound over scenes: the queue treats an overcount as "maybe
 * there is more", asks, finds only duplicates, and gives up.
 */
export function queueFromMarkers(list, markers) {
  const items = markerQueueItems(markers);
  const fetchPage = list?.fetchPage
    ? (page) => list.fetchPage(page)
      .then(d => ({ items: markerQueueItems(d.items), total: d.total }))
    : null;
  return {
    items,
    total: list?.total ?? items.length,
    page: list?.page ?? 1,
    startIndex: 0,
    // "Play from here" starts at the first distinct scene at or after the
    // pressed marker; its row is first, so its timestamp is the start.
    startSeconds: items[0]?.startSeconds || 0,
    fetchPage,
  };
}
