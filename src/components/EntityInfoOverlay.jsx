/**
 * EntityInfoOverlay: a read-only sheet for a tag, studio, group or gallery.
 *
 * Opened from the card's long-press menu. The card's own record paints first;
 * the detail query layers description, aliases, hierarchy and related names on
 * top. The panel scrolls (Up/Down) and Back closes it; Left/Right step into the
 * count pills, which open the listings behind them. The D-pad cannot leak to
 * the listing outside, which `role="dialog"` also traps.
 *
 * What differs per kind is data, not markup: KINDS below is the whole
 * difference. The counts that have nowhere to go stay plain numbers, because a
 * filter field that does not exist would turn the request into a 422.
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { fetchTagInfo } from '../utils/tagService.js';
import { fetchStudioInfo } from '../utils/studioService.js';
import { fetchGroupInfo } from '../utils/groupService.js';
import { fetchGalleryInfo } from '../utils/galleryService.js';
import { formatTime } from '../utils/format.js';
import styles from './EntityInfoOverlay.module.css';

// A tag can have hundreds of aliases or relatives; the sheet is not a listing.
const MAX_NAMES = 8;

function namesText(list = []) {
  const names = list.map(x => x?.name ?? x).filter(Boolean);
  if (!names.length) return null;
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown;
}

// Which tab each count opens, per kind. The criterion is one field on every
// target tab (`tags` for a tag, `studios` for a studio, `groups` for a group,
// `galleries` for a gallery), so the same count object works all the way down.
// The gallery's Performers pill goes through the nested `galleries_filter`
// instead, because PerformerFilterType has no `galleries` field. A count with
// no `target` is a plain number: SceneMarkerFilterType has no `studios`, so
// that pill must not pretend to open a listing.
const TAG_COUNTS = [
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  { key: 'scene_marker_count', target: 'markers', one: 'marker', many: 'markers' },
  { key: 'image_count', target: 'images', one: 'image', many: 'images' },
  { key: 'gallery_count', target: 'galleries', one: 'gallery', many: 'galleries' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
  { key: 'studio_count', target: 'studios', one: 'studio', many: 'studios' },
];
const STUDIO_COUNTS = [
  { key: 'o_counter', one: 'O', many: 'O' },
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  // Plain: markers cannot be filtered by studio.
  { key: 'scene_marker_count', one: 'marker', many: 'markers' },
  { key: 'image_count', target: 'images', one: 'image', many: 'images' },
  { key: 'gallery_count', target: 'galleries', one: 'gallery', many: 'galleries' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
  { key: 'group_count', target: 'groups', one: 'group', many: 'groups' },
];
const GROUP_COUNTS = [
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
  { key: 'o_counter', one: 'O', many: 'O' },
];
const GALLERY_COUNTS = [
  { key: 'image_count', target: 'images', one: 'image', many: 'images' },
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
];

// Per-kind data, not markup. `sections` returns the [title, body] pairs after
// the description and aliases; an absent pair is skipped.
const KINDS = {
  tag: {
    noun: 'tag',
    kindLabel: 'Tag',
    portrait: true,
    favorite: true,
    rating: false,
    load: fetchTagInfo,
    counts: TAG_COUNTS,
    title: d => d.name,
    descriptionKey: 'description',
    descriptionLabel: 'Description',
    aliases: d => (Array.isArray(d.aliases) ? d.aliases : []),
    meta: () => [],
    sections: d => [
      d.parents?.length && { title: 'Parent tags', body: namesText(d.parents) },
      d.children?.length && { title: 'Child tags', body: namesText(d.children) },
    ],
  },
  studio: {
    noun: 'studio',
    kindLabel: 'Studio',
    portrait: false,
    favorite: true,
    rating: true,
    load: fetchStudioInfo,
    counts: STUDIO_COUNTS,
    title: d => d.name,
    descriptionKey: 'details',
    descriptionLabel: 'Details',
    aliases: d => (Array.isArray(d.aliases) ? d.aliases : []),
    meta: () => [],
    sections: d => [
      d.parentStudio?.name && { title: 'Parent studio', body: d.parentStudio.name },
      d.childStudios?.length && { title: 'Sub-studios', body: namesText(d.childStudios) },
    ],
  },
  group: {
    noun: 'group',
    kindLabel: 'Group',
    portrait: false,
    favorite: false,
    rating: true,
    load: fetchGroupInfo,
    counts: GROUP_COUNTS,
    title: d => d.name,
    descriptionKey: 'synopsis',
    descriptionLabel: 'Synopsis',
    // A group's aliases are one comma-separated string, not a list.
    aliases: d => (typeof d.aliases === 'string' && d.aliases.trim()
      ? [d.aliases]
      : (Array.isArray(d.aliases) ? d.aliases : [])),
    meta: d => [
      d.date,
      d.durationSeconds ? formatTime(d.durationSeconds) : null,
      d.director && `Dir. ${d.director}`,
      d.studio?.name,
    ],
    sections: d => [
      d.containingGroups?.length && { title: 'Part of', body: namesText(d.containingGroups) },
      d.subGroups?.length && { title: 'Includes', body: namesText(d.subGroups) },
      d.tags?.length && { title: 'Tags', body: namesText(d.tags) },
    ],
  },
  gallery: {
    noun: 'gallery',
    kindLabel: 'Gallery',
    portrait: false,
    favorite: false,
    rating: true,
    load: fetchGalleryInfo,
    counts: GALLERY_COUNTS,
    title: d => d.title,
    descriptionKey: 'details',
    descriptionLabel: 'Details',
    aliases: () => [],
    meta: d => [
      d.date,
      d.photographer && `Photo: ${d.photographer}`,
      d.studio?.name,
      d.folder,
    ],
    sections: d => [
      d.performers?.length && { title: 'Performers', body: namesText(d.performers) },
      d.tags?.length && { title: 'Tags', body: namesText(d.tags) },
    ],
  },
};

function Count({ id, value, one, many, nextId, onSelect, label }) {
  if (!onSelect) {
    return <span className={styles.count}>{value} {value === 1 ? one : many}</span>;
  }
  return (
    <CountButton
      id={id} value={value} one={one} many={many}
      nextId={nextId} onSelect={onSelect} label={label}
    />
  );
}

// A count that opens the listing behind it. `zone` keeps Left/Right inside the
// sheet (the dialog scopes the candidate search on its own), and the nextId
// chain makes the row's order independent of its geometry when it wraps.
function CountButton({ id, value, one, many, nextId, onSelect, label }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'entity-info',
    onEnter: onSelect,
    nextId,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.count} ${styles.countButton} ${focused ? styles.countFocused : ''}`}
      onClick={onSelect}
      aria-label={label}
    >
      {value} {value === 1 ? one : many}
    </button>
  );
}

export default function EntityInfoOverlay({ entity, onClose, onFilter, serverVersion }) {
  const { kind, item } = entity;
  const cfg = KINDS[kind];
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState('loading');
  const [imageFailed, setImageFailed] = useState(false);
  // The studio detail query depends on the server version. If the version
  // resolves while the sheet is open, refetch, or the recursive counts stay
  // missing until it is reopened. Other kinds do not depend on it.
  const versionForLoad = kind === 'studio' ? serverVersion : null;

  // Capture phase: Back closes this sheet, not the page behind it.
  useBackKey(onClose);

  const data = { ...item, ...(detail || {}) };
  // The counts are the sheet's only actions, so they are the only registered
  // elements besides the panel. The panel declares Left/Right into the first
  // count: from there the row's own nextId chain takes over, which also keeps
  // Right meaningful when the row wraps at a narrow width.
  const counts = (cfg?.counts || [])
    .map(c => ({ ...c, value: data[c.key] || 0 }))
    .filter(c => c.value > 0);
  const countActions = onFilter ? counts.filter(c => c.target) : [];
  const countIds = countActions.map(c => `entity-count-${c.target}`);
  const firstCountId = countIds[0] || null;

  const { ref: panelRef, focused } = useFocusable({
    id: 'entity-info-panel',
    zone: 'entity-info',
    autoFocus: true,
    nextId: firstCountId ? { left: firstCountId, right: firstCountId } : null,
  });

  useEffect(() => {
    if (!cfg) return undefined;
    let cancelled = false;
    setDetail(null);
    setStatus('loading');

    cfg.load(item.id)
      .then(d => {
        if (cancelled) return;
        setDetail(d);
        setStatus(d ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => { cancelled = true; };
  }, [cfg, item.id, versionForLoad]);

  // The panel owns the arrows: the window handler would otherwise try to move
  // focus to a card behind the dialog, and its preventDefault would cancel the
  // browser's own scroll. Held keys are throttled like the global handler's:
  // the TV remote repeats at ~30 Hz, which would race a long description to
  // its end.
  const lastScroll = useRef(0);
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && Date.now() - lastScroll.current < 90) return;
    lastScroll.current = Date.now();
    panelRef.current?.scrollBy({ top: e.key === 'ArrowDown' ? 140 : -140 });
  };

  if (!cfg) return null;

  const title = cfg.title(data) || '';
  const aliases = cfg.aliases(data);
  const description = data[cfg.descriptionKey];
  const meta = cfg.meta(data).filter(Boolean);
  const sections = (cfg.sections(data) || []).filter(s => s && s.body);
  const aspect = cfg.portrait ? styles.portrait : styles.landscape;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`Info for ${title}`}
    >
      <div
        ref={panelRef}
        className={`${styles.panel} ${focused ? styles.focused : ''}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          {data.image_path && !imageFailed ? (
            <img
              src={data.image_path}
              alt=""
              className={`${styles.image} ${aspect}`}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div
              className={`${styles.image} ${styles.fallback} ${aspect}`}
              aria-hidden="true"
            >
              {title[0] || '?'}
            </div>
          )}

          <div className={styles.heading}>
            <p className={styles.kind}>{cfg.kindLabel}</p>
            <h2 className={styles.title}>{title}</h2>
            {meta.length > 0 && (
              <p className={styles.metaLine}>{meta.join(' · ')}</p>
            )}
            <div className={styles.meta}>
              {cfg.favorite && data.favorite && <span className={styles.favorite}>★ Favourite</span>}
              {cfg.rating && data.rating && (
                <span className={styles.rating}>★ {data.rating}</span>
              )}
            </div>
          </div>

          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            tabIndex={-1}
            aria-label="Close info"
          >
            ✕
          </button>
        </header>

        <div className={styles.counts} role="group" aria-label="Counts">
          {counts.map((count) => {
            const at = countActions.indexOf(count);
            const id = at === -1 ? undefined : countIds[at];
            return (
              <Count
                key={count.key}
                id={id}
                value={count.value}
                one={count.one}
                many={count.many}
                nextId={at === -1 ? null : {
                  left: countIds[(at - 1 + countIds.length) % countIds.length],
                  right: countIds[(at + 1) % countIds.length],
                }}
                onSelect={at === -1 ? null : () => onFilter(kind, data, count.target)}
                label={at === -1 ? undefined
                  : `Show ${count.value} ${count.value === 1 ? count.one : count.many}`}
              />
            );
          })}
        </div>

        {status === 'loading' && <p className={styles.state}>Loading details…</p>}
        {status === 'error' && <p className={styles.state}>Couldn't load details.</p>}
        {status === 'missing' && (
          <p className={styles.state}>This {cfg.noun} is no longer on the server.</p>
        )}

        {description && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{cfg.descriptionLabel}</h3>
            <p className={styles.body}>{description}</p>
          </section>
        )}

        {aliases.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Also known as</h3>
            <p className={styles.body}>{aliases.join(', ')}</p>
          </section>
        )}

        {sections.map((section) => (
          <section key={section.title} className={styles.section}>
            <h3 className={styles.sectionTitle}>{section.title}</h3>
            <p className={styles.body}>{section.body}</p>
          </section>
        ))}

        <footer className={styles.footer}>
          <span><kbd>Back</kbd> Close</span>
          <span><kbd>Up</kbd> / <kbd>Down</kbd> Scroll</span>
          {countActions.length > 0 && (
            <span><kbd>←</kbd> / <kbd>→</kbd> Counts · <kbd>OK</kbd> Open</span>
          )}
        </footer>
      </div>
    </div>
  );
}
