/**
 * carouselViews.js — what each section's carousel shows
 *
 * `Carousel` is one component that draws any section; these descriptors are
 * the part that cannot generalize, because a scene and a performer genuinely
 * have different fields and different art. One per section, kept together so
 * the differences are visible side by side rather than scattered across three
 * pages — the four things that vary (card, service, id prefix, hero fields)
 * are the same four the old scene-only carousel had hardcoded.
 *
 * Each `hero` returns fields, not markup: `{ title, meta: [{ text, kind }] }`
 * with `kind` in 'tag' | 'rating' | undefined. The strip owns what a tag or a
 * rating looks like; the descriptor owns which fields a section has. Adding a
 * section means a descriptor here and nothing else.
 *
 * These live in `components/` rather than `utils/` because they name card
 * components — the same reason `tvActions.jsx` is here.
 */

import VideoCard from './VideoCard.jsx';
import PerformerCard from './PerformerCard.jsx';
import MarkerCard from './MarkerCard.jsx';

import { fetchVideos } from '../utils/videoService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchMarkers } from '../utils/markerService.js';
import { formatTime } from '../utils/format.js';

export const SCENE_VIEW = {
  Card: VideoCard,
  service: fetchVideos,
  itemsKey: 'videos',
  focusPrefix: 'video',
  noun: 'videos',
  ariaLabel: 'Video carousel',
  // List-mode row art. A scene's list row is landscape, like its card.
  aspect: 'landscape',
  rowImage: (scene) => scene.thumbnail,
  // The list row's activation has to reproduce the card's argument list, not
  // invent one: VideoCard hands the *whole listing* (including `fetchPage`) up
  // so a play queue can continue past the loaded rows. The index is unused by
  // scenes, which look the scene up in the listing by id.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item, list),
  // Long-press is a scene-only action (Play / Play all / Details); the other
  // descriptors deliberately omit it. VideoCard's signature is
  // `(item, list, index)`.
  rowLongPress: (item, index, list, onLongPress) => onLongPress?.(item, list, index),
  // The fields the scene carousel has always printed, in the order it printed
  // them: year, duration, the primary tag, then the rating.
  hero: (scene) => ({
    title: scene.title,
    meta: [
      scene.year && { text: scene.year },
      scene.duration && { text: scene.duration },
      scene.category && { text: scene.category, kind: 'tag' },
      scene.rating && { text: `★ ${scene.rating}`, kind: 'rating' },
    ].filter(Boolean),
  }),
};

export const PERFORMER_VIEW = {
  Card: PerformerCard,
  service: fetchPerformers,
  itemsKey: 'performers',
  focusPrefix: 'performer',
  noun: 'performers',
  ariaLabel: 'Performer carousel',
  // Portrait art, so a list row's thumbnail is portrait too.
  aspect: 'portrait',
  rowImage: (performer) => performer.image_path,
  // PerformerCard takes only the item.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item),
  // Portrait art, so the slot is sized to keep the focused card the same
  // HEIGHT as a focused scene card rather than the same width. See the note on
  // `--slot-w` in Carousel.module.css for the arithmetic.
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
  noun: 'markers',
  ariaLabel: 'Marker carousel',
  // A marker's art is a scene screenshot — landscape, and `screenshot`, not
  // `thumbnail`, which is the field MarkerCard reads.
  aspect: 'landscape',
  rowImage: (marker) => marker.screenshot,
  // MarkerCard takes only the item.
  rowSelect: (item, index, list, onSelect) => onSelect?.(item),
  // And the same arguments for its menu, which is built from the markers in
  // the listing. See actionMenus.js.
  rowLongPress: (item, index, list, onLongPress) => onLongPress?.(item, list, index),
  // Marker thumbnails are scene screenshots, so this one is landscape and
  // takes the default slot width.
  hero: (marker) => ({
    title: marker.title,
    meta: [
      marker.scene?.title && { text: marker.scene.title, kind: 'tag' },
      { text: formatTime(marker.seconds) },
    ].filter(Boolean),
  }),
};
