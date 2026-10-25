/**
 * entityViews.jsx — what each of the four browse-only sections shows.
 *
 * `EntityGrid` and `Carousel` each draw any of the four; these descriptors are
 * the part that cannot generalize. Kept together so the differences sit side
 * by side.
 *
 * ## What a descriptor provides
 *
 *   key, service, itemsKey, noun   the listing and where its rows live
 *   focusPrefix                    the cards' registry-id prefix, which the
 *                                  Carousel also matches on — card and strip
 *                                  must agree or the hero silently freezes on
 *                                  row 1 with nothing thrown.
 *   aspect                         'portrait' | 'landscape' — the one thing
 *                                  that changes the card's *shape*
 *   slotWidth                      Carousel only, portrait art only. See
 *                                  `--slot-w` in Carousel.module.css.
 *   getImage / getTitle /          the fields the card asks for. `getImage`
 *   getSubtitle / getBadge /       returns a URL the service already put
 *   isFavorite / label             through `withApiKey()`; the card never
 *                                  touches it.
 *   hero                           `(item) => ({title, meta, blurb})`, fields
 *                                  not markup. Only the Carousel renders the
 *                                  blurb, so description/details live in the
 *                                  heavier query the Carousel asks for.
 *
 * Two things true of all four:
 *
 * `image_path` is non-empty for every tag and studio in this library, which
 * does **not** mean a picture is there — Stash serves a generated-asset URL
 * whether or not Generate has run, so a 200 proves nothing. The monogram
 * fallback is therefore reached by `onError`, never an absent field, which is
 * why EntityCard owns it rather than a getter.
 *
 * `longPress` opts a section into the card's long-press menu. Images and
 * Galleries set it (their menu opens the viewer); Tags and Studios leave it
 * off, which keeps their Enter firing on keydown.
 */

import EntityCard from './EntityCard.jsx';

import { fetchTags } from '../utils/tagService.js';
import { fetchStudios } from '../utils/studioService.js';
import { fetchGalleries } from '../utils/galleryService.js';
import { fetchImages } from '../utils/imageService.js';

/** Plurals that are not `noun + 's'` are spelled out, not derived. */
function scenes(n) {
  return `${n} scene${n === 1 ? '' : 's'}`;
}

function year(date) {
  return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : date;
}

/**
 * Alias lists are unbounded but the hero meta is one line: cap at three names
 * plus a count, or the row becomes a paragraph and pushes the strip down.
 */
function aliasesText(list = [], max = 3) {
  if (!list.length) return null;
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

/**
 * Bind a descriptor to the card component so `Carousel` can render it through
 * the shared `{ item, index, list, onSelect, onLongPress }` contract. The card
 * still reads `view.focusPrefix`, so strip and cards cannot disagree.
 */
function bind(view) {
  const Bound = (props) => <EntityCard {...props} view={view} />;
  Bound.displayName = `EntityCard(${view.key})`;
  return {
    ...view,
    Card: Bound,
    // EntityCard selects with `(item, index, list?.items)`; the Images viewer
    // needs the position, so a list row must hand up the same three.
    rowSelect: (item, index, list, onSelect) => onSelect?.(item, index, list?.items),
    // The menu takes the listing itself when the section opted in — it reports
    // the position from the listing's total.
    rowLongPress: view.longPress
      ? (item, index, list, onLongPress) => onLongPress?.(item, index, list)
      : undefined,
  };
}

// Portrait. Tag has no `rating100`, so no badge — the clearest of the four
// differences and why this is a descriptor rather than a colour of one card.
export const TAG_VIEW = bind({
  key: 'tags',
  service: fetchTags,
  itemsKey: 'tags',
  focusPrefix: 'tag',
  noun: 'tags',
  gridLabel: 'Tag grid',
  ariaLabel: 'Tag carousel',
  aspect: 'portrait',
  slotWidth: 166,
  getImage: (t) => t.image_path,
  getTitle: (t) => t.name,
  getSubtitle: (t) => scenes(t.scene_count),
  getBadge: () => null,
  isFavorite: (t) => t.favorite,
  label: (t) => `${t.name}, ${scenes(t.scene_count)}`,
  hero: (t) => ({
    title: t.name,
    meta: [
      t.scene_count && { text: scenes(t.scene_count) },
      t.image_count && { text: `${t.image_count} images` },
      t.performer_count && { text: `${t.performer_count} performers` },
      aliasesText(t.aliases) && { text: `Aliases: ${aliasesText(t.aliases)}` },
    ].filter(Boolean),
    blurb: t.description || null,
  }),
});

// Landscape; the only one of the four that can be a favourite *and* rated.
export const STUDIO_VIEW = bind({
  key: 'studios',
  service: fetchStudios,
  itemsKey: 'studios',
  focusPrefix: 'studio',
  noun: 'studios',
  gridLabel: 'Studio grid',
  ariaLabel: 'Studio carousel',
  aspect: 'landscape',
  getImage: (s) => s.image_path,
  getTitle: (s) => s.name,
  getSubtitle: (s) => scenes(s.scene_count),
  getBadge: (s) => (s.rating ? `★ ${s.rating}` : null),
  isFavorite: (s) => s.favorite,
  label: (s) => `${s.name}, ${scenes(s.scene_count)}`,
  hero: (s) => ({
    title: s.name,
    meta: [
      s.scene_count && { text: scenes(s.scene_count) },
      s.gallery_count && { text: `${s.gallery_count} galleries` },
      s.parentStudio?.name && { text: `Part of ${s.parentStudio.name}` },
      aliasesText(s.aliases) && { text: `Aliases: ${aliasesText(s.aliases)}` },
      s.rating && { text: `★ ${s.rating}`, kind: 'rating' },
    ].filter(Boolean),
    blurb: s.details || null,
  }),
});

// Landscape covers. No `paths.cover` case here — the service already applied
// withApiKey, and a gallery with no cover is `null`, caught by the fallback.
export const GALLERY_VIEW = bind({
  key: 'galleries',
  service: fetchGalleries,
  itemsKey: 'galleries',
  focusPrefix: 'gallery',
  noun: 'galleries',
  gridLabel: 'Gallery grid',
  ariaLabel: 'Gallery carousel',
  aspect: 'landscape',
  longPress: true,
  getImage: (g) => g.image_path,
  getTitle: (g) => g.title,
  // Studio is the ideal second line but rare on a real library; folder is
  // almost always there, so it is the fallback.
  getSubtitle: (g) => {
    const count = `${g.image_count} image${g.image_count === 1 ? '' : 's'}`;
    const where = g.studio?.name || g.folder;
    return where ? `${count} · ${where}` : count;
  },
  getBadge: (g) => (g.rating ? `★ ${g.rating}` : null),
  label: (g) => `${g.title}, ${g.image_count} images`,
  hero: (g) => ({
    title: g.title,
    meta: [
      g.date && { text: year(g.date) },
      g.image_count && { text: `${g.image_count} images` },
      g.studio?.name && { text: g.studio.name },
      g.photographer && { text: `Photo: ${g.photographer}` },
      g.folder && { text: g.folder },
      g.rating && { text: `★ ${g.rating}`, kind: 'rating' },
    ].filter(Boolean),
  }),
});

// `image_path` is the thumbnail; `full` is the full-resolution file the viewer
// opens. Keeping them separate matters: full-resolution art for every tile is
// the one thing that would make this section slow, and there are 31,251 images.
export const IMAGE_VIEW = bind({
  key: 'images',
  service: fetchImages,
  itemsKey: 'images',
  focusPrefix: 'image',
  noun: 'images',
  gridLabel: 'Image grid',
  ariaLabel: 'Image carousel',
  aspect: 'landscape',
  longPress: true,
  getImage: (im) => im.image_path,
  getTitle: (im) => im.title,
  getSubtitle: (im) => year(im.date),
  getBadge: (im) => (im.rating ? `★ ${im.rating}` : null),
  label: (im) => `${im.title}${im.date ? `, ${year(im.date)}` : ''}`,
  hero: (im) => ({
    title: im.title,
    meta: [
      im.date && { text: year(im.date) },
      im.o_counter && { text: `♥ ${im.o_counter}` },
      im.rating && { text: `★ ${im.rating}`, kind: 'rating' },
    ].filter(Boolean),
  }),
});
