/**
 * actionMenus.js — what a long-press menu offers, for each kind of card.
 *
 * Pure: it reads the menu state and closes over the handlers passed in.
 * Playback entries end in `openPlayer` and image/gallery entries in the viewer
 * openers, so the menu is never left behind. The menu component only draws
 * rows — which rows a card has belongs here.
 */

import { queueOf, queueItemFromMarker, markerQueueItems, queueFromMarkers } from './playQueue.js';
import { formatTime } from './format.js';

/** The position line every listing-backed menu uses. */
function listingSubtitle(list, index) {
  return list?.total
    ? `${index + 1} of ${list.total} in this listing`
    : null;
}

/** The menu the card at `index` opened, in its listing's own words. */
export function buildActionMenu({ kind, item, list, index = 0 } = {}, handlers) {
  if (!item) return null;
  if (kind === 'marker') {
    return {
      title: item.title,
      subtitle: `at ${formatTime(item.seconds)} in ${item.scene?.title || 'this scene'}`,
      items: buildMarkerMenuItems({ item, list, index }, handlers),
    };
  }
  if (kind === 'image') {
    return {
      title: item.title || 'Image',
      subtitle: listingSubtitle(list, index),
      items: buildImageMenuItems({ item, list, index }, handlers),
    };
  }
  if (kind === 'gallery') {
    return {
      title: item.title || 'Gallery',
      subtitle: item.image_count
        ? `${item.image_count} image${item.image_count === 1 ? '' : 's'}`
        : null,
      items: buildGalleryMenuItems({ item }, handlers),
    };
  }
  return {
    title: item.title,
    subtitle: listingSubtitle(list, index),
    items: buildSceneMenuItems({ item, list, index }, handlers),
  };
}

/**
 * @param {{ item, list, index }} actionMenu   the card the menu opened on
 * @param {{ openPlayer, onDetails }} handlers
 *
 * "Play all" / "Play from here" continue through the listing, so need a view
 * that has one — every card opening this menu does. `restoreBy: 'video'` tells
 * Back to return to the last-viewed scene card rather than the queue's origin;
 * single-scene Play omits it (its card never changes).
 */
export function buildSceneMenuItems({ item, list, index }, { openPlayer, onDetails }) {
  return [
    { id: 'menu-play', label: 'Play', onSelect: () => openPlayer(queueOf(item)) },
    ...(list?.items?.length ? [
      {
        id: 'menu-play-all',
        label: 'Play all',
        hint: 'from the start',
        onSelect: () => openPlayer({
          ...list, startIndex: 0, startSeconds: 0, restoreBy: 'video',
        }),
      },
      {
        id: 'menu-play-here',
        label: 'Play from here',
        hint: `${list.total - index} left`,
        onSelect: () => openPlayer({
          ...list, startIndex: index, startSeconds: 0, restoreBy: 'video',
        }),
      },
    ] : []),
    {
      id: 'menu-details',
      label: 'Details',
      onSelect: () => onDetails(item),
    },
  ];
}

/**
 * A marker is a timestamp in a scene, so "Play" means that scene from that
 * point; listing entries walk the *markers*, one scene each.
 *
 * `markerQueueItems` turns markers into scene rows and drops repeats, so the
 * hint counts scenes. A `+` means not every marker was loaded — the queue pages
 * in the rest itself.
 *
 * `restoreBy: 'marker'`: Back returns to the last-viewed scene's marker card;
 * rows carry the marker id because a scene id names no card in this tab.
 */
export function buildMarkerMenuItems({ item, list, index }, { openPlayer, onDetails }) {
  const loaded = list?.items?.length ? list.items : [item];
  const start = Math.max(0, Math.min(index, loaded.length - 1));
  const here = markerQueueItems(loaded.slice(start));
  const more = Number(list?.total) > loaded.length;
  const count = `${here.length}${more ? '+' : ''}`;

  return [
    {
      id: 'menu-play',
      label: 'Play',
      hint: formatTime(item.seconds),
      onSelect: () => openPlayer(queueOf(queueItemFromMarker(item), item.seconds || 0)),
    },
    ...(list?.items?.length ? [
      {
        id: 'menu-play-all',
        label: 'Play all',
        hint: 'from the start',
        onSelect: () => openPlayer({ ...queueFromMarkers(list, loaded), restoreBy: 'marker' }),
      },
      {
        id: 'menu-play-here',
        label: 'Play from here',
        hint: `${count} scene${here.length === 1 && !more ? '' : 's'}`,
        onSelect: () => openPlayer({
          ...queueFromMarkers(list, loaded.slice(start)), restoreBy: 'marker',
        }),
      },
    ] : []),
    {
      id: 'menu-details',
      label: 'Details',
      // A marker has no page of its own, so Details opens its scene's.
      onSelect: () => onDetails(item.scene),
    },
  ];
}

/**
 * The image viewer's menu. Every row opens the viewer; they differ only in
 * where it starts and whether it runs.
 *
 * The listing is the grid's loaded snapshot (the viewer does not page it), so
 * hints count what is loaded.
 */
export function buildImageMenuItems({ item, list, index }, { openImageViewer }) {
  const loaded = list?.items?.length ? list.items : [item];
  const start = Math.max(0, Math.min(index, loaded.length - 1));

  return [
    {
      id: 'menu-image-view',
      label: 'View',
      onSelect: () => openImageViewer({ items: loaded, index: start }),
    },
    ...(loaded.length > 1 ? [
      {
        id: 'menu-image-slideshow-here',
        label: 'Slideshow from here',
        hint: `${loaded.length - start} left`,
        onSelect: () => openImageViewer({ items: loaded, index: start, autoPlay: true }),
      },
      {
        id: 'menu-image-slideshow-start',
        label: 'Slideshow from start',
        onSelect: () => openImageViewer({ items: loaded, index: 0, autoPlay: true }),
      },
    ] : []),
    {
      id: 'menu-image-info',
      label: 'Info',
      onSelect: () => openImageViewer({ items: loaded, index: start, infoOpen: true }),
    },
  ];
}

/**
 * A gallery is a container, so its menu chooses a way to show the pictures.
 * The viewer fetches the gallery's own images — the listing behind the card is
 * galleries — and pages the rest in behind the first screen.
 *
 * "View images" is the same destination as Enter: the Images tab filtered to
 * this gallery.
 */
export function buildGalleryMenuItems({ item }, { openGallery, openGallerySlideshow }) {
  return [
    {
      id: 'menu-gallery-view',
      label: 'View images',
      onSelect: () => openGallery(item),
    },
    {
      id: 'menu-gallery-slideshow',
      label: 'Slideshow',
      onSelect: () => openGallerySlideshow(item, { shuffle: false }),
    },
    {
      id: 'menu-gallery-shuffle',
      label: 'Shuffle slideshow',
      onSelect: () => openGallerySlideshow(item, { shuffle: true }),
    },
  ];
}
