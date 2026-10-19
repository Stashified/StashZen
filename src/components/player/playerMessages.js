import { needsTranscode } from '../../utils/playbackSource.js';

/**
 * What to put on screen when nothing played.
 *
 * The codec is named only when it is the known reason — the same judgement,
 * from the same function, that sent the scene to the transcoder in the first
 * place. So the message is really "this is the file we could not play, and
 * this is why", and a scene that simply 404'd keeps the plain wording rather
 * than being given a diagnosis it did not earn.
 *
 * A name and never a path, deliberately: this is the only error in the app
 * that quotes the server's own vocabulary back at the user, and where a scene
 * lives on disk is the user's business, not a thing to put on a TV screen at
 * the moment they are already annoyed.
 */
export function playbackFailureMessage(video) {
  if (video && needsTranscode(video)) {
    return `Cannot play this file (${video.videoCodec || video.container})`;
  }
  return 'Failed to load video';
}

// What the sync chip says in each state. `failed` is deliberately a word rather
// than an icon: it is the one state the user has to act on, and on a TV there is
// no console to have already told them.
export const SYNC_LABEL = {
  saving: 'Syncing…',
  saved:  'Saved',
  failed: 'Sync failed',
};
