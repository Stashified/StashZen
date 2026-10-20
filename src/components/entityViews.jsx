/**
 * entityViews.jsx — what each of the four browse-only sections shows.
 *
 * The same idea as carouselViews.js, and for the same reason: `EntityGrid` and
 * `Carousel` are each one component that draws any of the four, and these
 * descriptors are the part that cannot generalize. Kept together so the
 * differences are visible side by side rather than scattered across four pages
 * — and so that "a Tag has no rating" is a line you can read rather than a
 * clause you have to remember.
 *
 * ## What a descriptor provides
 *
 *   key, service, itemsKey, noun   the listing and where its rows live
 *   focusPrefix                    the cards' registry-id prefix. Also the id
 *                                  scheme the Carousel matches on, so the card
 *                                  and the strip must agree on it — that is the
 *                                  silent failure mode where the hero freezes
 *                                  on row 1 and nothing throws.
 *   aspect                         'portrait' | 'landscape' — the one thing
 *                                  that changes the card's *shape*
 *   slotWidth                      Carousel only, and only for portrait art.
 *                                  See the note on `--slot-w` in
 *                                  Carousel.module.css for the arithmetic.
 *   getImage / getTitle /          the four fields the card asks for. `getImage`
 *   getSubtitle / getBadge /       returns a URL already passed through
 *   isFavorite / label             `withApiKey()` by the service — the card
 *                                  never touches it.
 *   hero                           `(item) => ({title, meta, blurb})`, fields
 *                                  not markup. The Carousel hero and the list
 *                                  rows render title/meta; only the Carousel
 *                                  renders the blurb, which is why the
 *                                  services' description/details live in a
 *                                  heavier query the Carousel asks for.
 *
 * ## Two things that are true of all four and worth stating once
 *
 * `image_path` is a non-empty string for every tag and studio in this library,
 * which does **not** mean a picture is there — Stash serves a generated-asset
 * URL whether or not Generate has ever run, so a 200 proves nothing. The card's
 * monogram fallback is therefore reached by `onError`, never by an absent
 * field, which is why the fallback is in EntityCard rather than in a getter.
 *
 * `longPress` opts a section into the card's long-press menu. Images and
 * Galleries set it — their menu opens the viewer, with slideshow entries —
 * while Tags and Studios leave it off: their press stays a plain tap, which
 * is also what keeps Enter firing on keydown for them.
 */

import EntityCard from './EntityCard.jsx';

import { fetchTags } from '../utils/tagService.js';
import { fetchStudios } from '../utils/studioService.js';
import { fetchGalleries } from '../utils/galleryService.js';
import { fetchImages } from '../utils/imageService.js';

/** Plurals that are not just `noun + 's'` are spelled out rather than derived. */
function scenes(n) {
  return `${n} scene${n === 1 ? '' : 's'}`;
}

function year(date) {
  return typeof date === 'string' && date.length >= 4 ? date.slice(0, 4) : date;
}

/**
 * Alias lists are unbounded, and the hero is one line of meta. Three names
 * plus a count is the cap; a longer string would turn the row into a
 * paragraph and push the strip down.
 */
function aliasesText(list = [], max = 3) {
  if (!list.length) return null;
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} +${list.length - max}` : shown;
}

/**
 * Bind a descriptor to the one card component, so `Carousel` can render it
 * through the same `{ item, index, list, onSelect, onLongPress }` contract every
 * other card in the tree takes. The card still reads `view.focusPrefix` for its
 * id, so a strip and its cards cannot disagree about the prefix.
 */
function bind(view) {
  const Bound = (props) => <EntityCard {...props} view={view} />;
  Bound.displayName = `EntityCard(${view.key})`;
  return {
    ...view,
    Card: Bound,
    // EntityCard's select signature is `(item, index, list?.items)` — three
    // arguments because the Images viewer needs to know where in the listing
    // the press happened. A list row has to hand up the same three, or the
    // viewer would open on the wrong image.
    rowSelect: (item, index, list, onSelect) => onSelect?.(item, index, list?.items),
    // And the menu takes the listing itself when the section opted in — it
    // reports the position from the listing's total.
    rowLongPress: view.longPress
      ? (item, index, list, onLongPress) => onLongPress?.(item, index, list)
      : undefined,
  };
}

// ── Tags ───────────────────────────────────────────────────
// Portrait. Tag has no `rating100` at all, so there is no badge to show —
// which is the clearest of the four differences and the reason this is a
// descriptor rather than a colour of the same card.
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

// ── Studios ────────────────────────────────────────────────
// Landscape, and the only one of the four that can be a favourite *and* rated.
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

// ── Galleries ──────────────────────────────────────────────
// Landscape covers. No `paths.cover` case is handled here — the service has
// already put the URL through withApiKey, and a gallery with no cover is a
// `null` that the card's fallback catches.
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
  // Studio is the ideal second line, but it is rare on a real library; the
  // folder is the field that is almost always there, so it is the fallback.
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

// ── Images ─────────────────────────────────────────────────
// `image_path` is the *thumbnail*; `full` is the full-resolution file and is
// what the viewer opens. They are separate fields on purpose — pulling
// full-resolution art for every tile on screen is the one thing that would make
// this section slow, and this library holds 31,251 of them.
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
