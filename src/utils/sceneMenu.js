/**
 * sceneMenu.js — the long-press menu's items for one scene card.
 *
 * Pure in the sense that matters here: it reads the menu's state and closes
 * over the handlers it is given, and owns none of it. The three playback
 * entries all end in `openPlayer`, which is the one place that knows how to
 * open the player without leaving the menu behind it.
 */

import { queueOf } from './playQueue.js';

/**
 * @param {{ video, list, index }} actionMenu   the card the menu opened on
 * @param {{ openPlayer, onDetails }} handlers
 *
 * "Play all" and "Play from here" continue through the listing, so they only
 * make sense when the card came from a view that has one — and every card
 * that can open this menu does.
 */
export function buildSceneMenuItems({ video, list, index }, { openPlayer, onDetails }) {
  return [
    { id: 'menu-play', label: 'Play', onSelect: () => openPlayer(queueOf(video)) },
    ...(list?.items?.length ? [
      {
        id: 'menu-play-all',
        label: 'Play all',
        hint: 'from the start',
        onSelect: () => openPlayer({ ...list, startIndex: 0, startSeconds: 0 }),
      },
      {
        id: 'menu-play-here',
        label: 'Play from here',
        hint: `${list.total - index} left`,
        onSelect: () => openPlayer({
          ...list, startIndex: index, startSeconds: 0,
        }),
      },
    ] : []),
    {
      id: 'menu-details',
      label: 'Details',
      onSelect: () => onDetails(video),
    },
  ];
}
