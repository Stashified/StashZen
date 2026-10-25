import { needsTranscode } from '../../utils/playbackSource.js';

/**
 * What to put on screen when nothing played.
 *
 * The codec is named only when `needsTranscode` says that is the reason — the
 * same judgement that sent the scene to the transcoder — so a scene that simply
 * 404'd keeps the plain wording instead of a diagnosis it did not earn. A name
 * and never a path: where a scene lives on disk is not for a TV screen.
 */
export function playbackFailureMessage(video) {
  if (video && needsTranscode(video)) {
    return `Cannot play this file (${video.videoCodec || video.container})`;
  }
  return 'Failed to load video';
}

// What the sync chip says in each state. `failed` is a word, not an icon: it is
// the one state to act on, and a TV has no console to have told them.
export const SYNC_LABEL = {
  saving: 'Syncing…',
  saved:  'Saved',
  failed: 'Sync failed',
};
