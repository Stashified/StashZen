/**
 * carouselViews.js: what each section's carousel shows.
 *
 * `Carousel` draws any section; these descriptors are the part that cannot
 * generalize, because scenes and performers have different fields and art.
 * Kept together so the differences are visible side by side.
 *
 * Each `hero` returns fields, not markup: `{ title, meta: [{ text, kind }],
 * details, blurb }` with `kind` in 'tag' | 'rating' | undefined. `details` is
 * an array of strings drawn as one line (joined with ' · '); absent means the
 * section has no such field, while an empty array reserves the line.
 * `blurb` is a paragraph. The strip owns what a tag or
 * rating looks like; the descriptor owns which fields a section has, so a new
 * section is one descriptor and nothing else. `rowMeta` adds fields only the
 * wider list row has room for.
 *
 * They live in `components/` rather than `utils/` because they name card
 * components, the same reason `tvActions.jsx` is here.
 */

import VideoCard from './VideoCard.jsx';
import PerformerCard from './PerformerCard.jsx';
import MarkerCard from './MarkerCard.jsx';

import { fetchVideos } from '../utils/videoService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchMarkers } from '../utils/markerService.js';
import { formatTime, resolutionLabel } from '../utils/format.js';

/** Cast, then the file's height: the detail line a row and a hero both fit. */
function sceneDetails(scene) {
  return [
    scene.performers?.length ? scene.performers.join(', ') : null,
    resolutionLabel(scene.height),
  ].filter(Boolean);
}

export const SCENE_VIEW = {
  Card: VideoCard,
  service: fetchVideos,
  itemsKey: 'videos',
  focusPrefix: 'video',
  // The strip asks for the hero query, so its page 1 cannot seed from a grid's.
  seedVariant: 'hero',
  // Rows to patch in place when a write changes a scene. See rowPatches.js.
  entity: 'scene',
  noun: 'videos',
  ariaLabel: 'Video carousel',
  // List-mode row art; a scene's row is landscape, like its card.
  aspect: 'landscape',
  rowImage: (scene) => scene.thumbnail,
  // Must reproduce VideoCard's argument list, not invent one: it hands up the
  // *whole listing* (including `fetchPage`) so a play queue can continue past
  // the loaded rows. Scenes ignore the index and look the scene up by id.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item, list),
  // Long-press is a scene-only action (Play / Play all / Details); the other
  // descriptors omit it. VideoCard's signature is `(item, list, index)`.
  rowLongPress: (item, index, list, onLongPress) => onLongPress?.(item, list, index),
  // Year, duration, the primary tag, then the rating.
  hero: (scene) => ({
    title: scene.title,
    meta: [
      scene.year && { text: scene.year },
      scene.duration && { text: scene.duration },
      scene.category && { text: scene.category, kind: 'tag' },
      scene.rating && { text: `★ ${scene.rating}`, kind: 'rating' },
    ].filter(Boolean),
    // Always an array, so the hero reserves the line with no cast.
    details: sceneDetails(scene),
    // The hero query selects details; grids and lists leave it null.
    blurb: scene.details || null,
  }),
  rowMeta: sceneDetails,
};

export const PERFORMER_VIEW = {
  Card: PerformerCard,
  service: fetchPerformers,
  itemsKey: 'performers',
  focusPrefix: 'performer',
  noun: 'performers',
  ariaLabel: 'Performer carousel',
  // Portrait art, so the list row is portrait too.
  aspect: 'portrait',
  rowImage: (performer) => performer.image_path,
  // PerformerCard takes only the item.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item),
  // Sized so the focused card is the same HEIGHT as a focused scene card, not
  // the same width. See `--slot-w` in Carousel.module.css.
  slotWidth: 166,
  hero: (performer) => ({
    title: performer.name,
    meta: [
      performer.scene_count && {
        text: `${performer.scene_count} scene${performer.scene_count === 1 ? '' : 's'}`,
      },
      performer.disambiguation && { text: performer.disambiguation },
      performer.country && { text: performer.country },
      performer.rating && { text: `★ ${performer.rating}`, kind: 'rating' },
    ].filter(Boolean),
  }),
};

export const MARKER_VIEW = {
  Card: MarkerCard,
  service: fetchMarkers,
  itemsKey: 'markers',
  focusPrefix: 'marker',
  entity: 'marker',
  noun: 'markers',
  ariaLabel: 'Marker carousel',
  // A marker's art is a scene screenshot: `screenshot`, not `thumbnail`, which
  // is the field MarkerCard reads.
  aspect: 'landscape',
  rowImage: (marker) => marker.screenshot,
  // MarkerCard takes only the item.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item),
  // Same arguments for its menu, which is built from the listing's markers.
  // See actionMenus.js.
  rowLongPress: (item, index, list, onLongPress) => onLongPress?.(item, list, index),
  // Screenshots are landscape, so this one takes the default slot width.
  hero: (marker) => ({
    title: marker.title,
    meta: [
      marker.scene?.title && { text: marker.scene.title, kind: 'tag' },
      { text: formatTime(marker.seconds) },
    ].filter(Boolean),
  }),
};
