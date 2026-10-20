/**
 * actionMenus.js — what a long-press menu offers, for each kind of card.
 *
 * Pure in the sense that matters here: it reads the menu's state and closes
 * over the handlers it is given, and owns none of it. Every playback entry
 * ends in `openPlayer`, which is the one place that knows how to open the
 * player without leaving the menu behind it; the image/gallery entries end in
 * the viewer openers for the same reason.
 *
 * The menu itself (`ActionMenu`) draws rows and nothing else — which rows a
 * card has is a question about the section, and belongs here.
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
 * "Play all" and "Play from here" continue through the listing, so they only
 * make sense when the card came from a view that has one — and every card
 * that can open this menu does.
 *
 * `restoreBy` is what tells the player's Back that this queue walks cards:
 * 'video' returns to the scene card last viewed rather than the one the queue
 * started on. See usePlayback.handlePlayerClose. The single-scene Play does
 * not set it — its card never changes.
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
 * point — and the listing entries walk the *markers*, one scene each.
 *
 * `markerQueueItems` is what turns the marker run into scene rows and drops
 * repeats, which is why the hint counts scenes rather than markers. A `+`
 * says the grid had not loaded every marker yet; the queue continues into
 * the remaining pages by itself.
 *
 * `restoreBy: 'marker'`: Back returns to the marker card of the scene last
 * viewed, matching a scene queue's behaviour. The queue rows carry the
 * marker's own id for it; the scene id alone names no card in this tab.
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
      // The *scene's* page — a marker has no page of its own, and this is the
      // one entry that looks beyond the timestamp.
      onSelect: () => onDetails(item.scene),
    },
  ];
}

/**
 * The image viewer's menu. Every row opens the viewer; they differ only in
 * where it starts and whether it runs.
 *
 * The listing is the grid's loaded snapshot, as for the viewer's own arrows —
 * the viewer does not page that listing. The hint therefore counts what is
 * loaded, and the row offering the most says where it starts.
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
 * The viewer fetches the gallery's own images — the listing behind the card
 * is galleries, not images — and pages the rest in behind the first screen.
 * See ImageViewer.
 *
 * "View images" is the same destination as Enter: the Images tab filtered to
 * this gallery, where every other image affordance already lives.
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
