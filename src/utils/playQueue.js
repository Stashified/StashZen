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
 */
export function queueItemFromMarker(marker) {
  return {
    id: marker.scene.id,
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
