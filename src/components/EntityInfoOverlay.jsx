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
import { fetchTagInfo, setTagFavorite } from '../utils/tagService.js';
import { fetchStudioInfo, setStudioFavorite } from '../utils/studioService.js';
import { fetchGroupInfo } from '../utils/groupService.js';
import { fetchGalleryInfo, updateGallery } from '../utils/galleryService.js';
import { formatTime, ratingLabel } from '../utils/format.js';
import { RatingStepper } from '../pages/sceneDetail/RatingStepper.jsx';
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
    setFavorite: setTagFavorite,
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
    setFavorite: setStudioFavorite,
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
    editRating: true,
    editOrganized: true,
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

function ActionButton({
  id, label, glyph, active, nextId, onEnter, busy,
}) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'entity-info',
    onEnter,
    nextId,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.action} ${active ? styles.actionOn : ''} ${focused ? styles.actionFocused : ''}`}
      onClick={onEnter}
      aria-pressed={active}
      aria-disabled={busy || undefined}
    >
      <span className={styles.actionGlyph} aria-hidden="true">{glyph}</span>
      {label}
    </button>
  );
}

export default function EntityInfoOverlay({ entity, onClose, onFilter, serverVersion }) {
  const { kind, item } = entity;
  const cfg = KINDS[kind];
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState('loading');
  const [imageFailed, setImageFailed] = useState(false);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // Values this sheet wrote. A detail answer that predates a write still has
  // to land, so its stale fields are merged under these.
  const writtenRef = useRef({});
  // Guards a detail answer against a newer request, not against a write.
  const loadEpochRef = useRef(0);
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

  // One write at a time; the controls stay focusable while it runs and ignore
  // presses, because a native `disabled` would drop the D-pad ring.
  const beginWrite = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    return true;
  };
  const endWrite = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const toggleFavorite = async () => {
    if (!cfg?.setFavorite || busyRef.current) return;
    const prev = !!data.favorite;
    const next = !prev;
    if (!beginWrite()) return;
    writtenRef.current.favorite = next;
    setDetail(d => ({ ...(d || {}), favorite: next }));
    try {
      const saved = await cfg.setFavorite(item.id, next);
      writtenRef.current.favorite = saved;
      setDetail(d => ({ ...(d || {}), favorite: saved }));
    } catch (e) {
      writtenRef.current.favorite = prev;
      setDetail(d => ({ ...(d || {}), favorite: prev }));
      setNotice(`Favourite not saved: ${e.message}`);
    } finally {
      endWrite();
    }
  };

  const setGalleryRating = async (rating100) => {
    if (!cfg?.editRating || busyRef.current) return;
    const prev = detail?.rating100 ?? null;
    const next = Math.max(0, Math.min(100, Math.round(Number(rating100) || 0)));
    if ((prev ?? 0) === next || !beginWrite()) return;
    const optimistic = next > 0 ? next : null;
    writtenRef.current.rating100 = optimistic;
    writtenRef.current.rating = ratingLabel(optimistic);
    setDetail(d => ({
      ...(d || {}), rating100: optimistic, rating: ratingLabel(optimistic),
    }));
    try {
      const saved = await updateGallery({ id: item.id, rating100: next });
      writtenRef.current.rating100 = saved.rating100;
      writtenRef.current.rating = ratingLabel(saved.rating100);
      setDetail(d => ({ ...(d || {}), rating100: saved.rating100, rating: ratingLabel(saved.rating100) }));
    } catch (e) {
      writtenRef.current.rating100 = prev;
      writtenRef.current.rating = ratingLabel(prev);
      setDetail(d => ({
        ...(d || {}), rating100: prev, rating: ratingLabel(prev),
      }));
      setNotice(`Rating not saved: ${e.message}`);
    } finally {
      endWrite();
    }
  };

  const toggleOrganized = async () => {
    if (!cfg?.editOrganized || busyRef.current) return;
    const prev = !!detail?.organized;
    const next = !prev;
    if (!beginWrite()) return;
    writtenRef.current.organized = next;
    setDetail(d => ({ ...(d || {}), organized: next }));
    try {
      const saved = await updateGallery({ id: item.id, organized: next });
      writtenRef.current.organized = saved.organized ?? next;
      setDetail(d => ({ ...(d || {}), organized: saved.organized ?? next }));
    } catch (e) {
      writtenRef.current.organized = prev;
      setDetail(d => ({ ...(d || {}), organized: prev }));
      setNotice(`Organised mark not saved: ${e.message}`);
    } finally {
      endWrite();
    }
  };

  // Gallery controls need the detail row: the listing carries only the display
  // label, not the stored 0-100 value or the organised flag.
  const showGalleryActions = !!(cfg?.editRating && detail);
  const actionIds = [
    ...(cfg?.setFavorite ? ['entity-action-favorite'] : []),
    ...(showGalleryActions
      ? ['entity-rating-dec', 'entity-rating-inc', 'entity-action-organized']
      : []),
  ];
  const firstActionId = actionIds[0] || null;
  const actionNextId = (id) => {
    const at = actionIds.indexOf(id);
    const map = {
      left: actionIds[(at - 1 + actionIds.length) % actionIds.length],
      right: actionIds[(at + 1) % actionIds.length],
    };
    if (firstCountId) map.down = firstCountId;
    return map;
  };
  const panelTargetId = firstActionId || firstCountId;

  const { ref: panelRef, focused } = useFocusable({
    id: 'entity-info-panel',
    zone: 'entity-info',
    autoFocus: true,
    nextId: panelTargetId ? { left: panelTargetId, right: panelTargetId } : null,
  });

  // A different entity starts with nothing written to protect.
  useEffect(() => {
    writtenRef.current = {};
  }, [cfg, item.id]);

  useEffect(() => {
    if (!cfg) return undefined;
    const epoch = ++loadEpochRef.current;
    let cancelled = false;
    setDetail(null);
    setStatus('loading');

    cfg.load(item.id)
      .then(d => {
        if (cancelled || epoch !== loadEpochRef.current) return;
        setDetail(d ? { ...d, ...writtenRef.current } : d);
        setStatus(d ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled && epoch === loadEpochRef.current) setStatus('error');
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
    // The panel scrolls only while it owns focus. Arrows from a count or an
    // action must reach the D-pad's nextId graph instead of being swallowed.
    if (e.target !== panelRef.current) return;
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
              {cfg.favorite && !cfg.setFavorite && data.favorite && (
                <span className={styles.favorite}>★ Favourite</span>
              )}
              {cfg.rating && !cfg.editRating && data.rating && (
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

        {actionIds.length > 0 && (
          <div
            className={styles.actions}
            role="group"
            aria-label="Actions"
            aria-busy={busy || undefined}
          >
            {cfg.setFavorite && (
              <ActionButton
                id="entity-action-favorite"
                label="Favourite"
                glyph={data.favorite ? '★' : '☆'}
                active={!!data.favorite}
                nextId={actionNextId('entity-action-favorite')}
                onEnter={toggleFavorite}
                busy={busy}
              />
            )}
            {showGalleryActions && (
              <>
                <RatingStepper
                  rating100={detail.rating100}
                  idPrefix="entity-rating"
                  zone="entity-info"
                  nextId={{
                    dec: actionNextId('entity-rating-dec'),
                    inc: actionNextId('entity-rating-inc'),
                  }}
                  onChange={setGalleryRating}
                />
                <ActionButton
                  id="entity-action-organized"
                  label="Organised"
                  glyph={detail.organized ? '✓' : '○'}
                  active={!!detail.organized}
                  nextId={actionNextId('entity-action-organized')}
                  onEnter={toggleOrganized}
                  busy={busy}
                />
              </>
            )}
          </div>
        )}

        {notice && <p className={styles.notice} role="status">{notice}</p>}

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
                  ...(firstActionId ? { up: firstActionId } : {}),
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
          {actionIds.length > 0 ? (
            <span>
              <kbd>←</kbd> / <kbd>→</kbd> Actions
              {countActions.length > 0 && <> · <kbd>↓</kbd> Counts</>}
            </span>
          ) : countActions.length > 0 && (
            <span><kbd>←</kbd> / <kbd>→</kbd> Counts · <kbd>OK</kbd> Open</span>
          )}
        </footer>
      </div>
    </div>
  );
}
