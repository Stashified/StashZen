/**
 * contracts — the small shared vocabulary of the media facade.
 *
 * Kept in its own module so `mediaEngine.js` and the backends do not form an
 * import cycle: the facade imports a backend, and every backend needs these.
 */

// The events the player subscribes to. A backend forwards exactly these.
export const MEDIA_EVENTS = [
  'play', 'pause', 'waiting', 'playing', 'timeupdate',
  'loadedmetadata', 'durationchange', 'canplay', 'error', 'ended',
  'seeking', 'seeked', 'volumechange',
];

// What a backend returns when it has no media pipeline to ask. Shapes match
// TimeRanges closely enough for `.length` checks and are safe by construction.
const EMPTY_RANGES = Object.freeze({
  length: 0,
  start() { throw new RangeError('no ranges'); },
  end() { throw new RangeError('no ranges'); },
});

export function emptyTimeRanges() {
  return EMPTY_RANGES;
}
