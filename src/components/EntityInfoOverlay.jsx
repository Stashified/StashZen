/**
 * EntityInfoOverlay: a read-only sheet for a tag or studio.
 *
 * Opened from the card's long-press menu. The card's own record paints first;
 * the detail query layers description, aliases and hierarchy on top. The panel
 * scrolls (Up/Down) and Back closes it; Left/Right step into the count pills,
 * which open the listings behind them. The D-pad cannot leak to the listing
 * outside, which `role="dialog"` also traps.
 */

import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { fetchTagInfo } from '../utils/tagService.js';
import { fetchStudioInfo } from '../utils/studioService.js';
import styles from './EntityInfoOverlay.module.css';

// A tag can have hundreds of aliases or relatives; the sheet is not a listing.
const MAX_NAMES = 8;

function namesText(list = []) {
  const names = list.map(x => x.name).filter(Boolean);
  if (!names.length) return null;
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown;
}

// Which tab each count opens, per kind. The criterion is one field on every
// target tab (`tags` for a tag, `studios` for a studio), so the same count
// object works all the way down; see the schema in stashFilterSchema.js.
// Groups have no tab, so a studio's group count stays a plain number.
const TAG_COUNTS = [
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  { key: 'scene_marker_count', target: 'markers', one: 'marker', many: 'markers' },
  { key: 'image_count', target: 'images', one: 'image', many: 'images' },
  { key: 'gallery_count', target: 'galleries', one: 'gallery', many: 'galleries' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
  { key: 'studio_count', target: 'studios', one: 'studio', many: 'studios' },
];
const STUDIO_COUNTS = [
  { key: 'scene_count', target: 'scenes', one: 'scene', many: 'scenes' },
  { key: 'image_count', target: 'images', one: 'image', many: 'images' },
  { key: 'gallery_count', target: 'galleries', one: 'gallery', many: 'galleries' },
  { key: 'performer_count', target: 'performers', one: 'performer', many: 'performers' },
  { key: 'group_count', one: 'group', many: 'groups' },
];

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

export default function EntityInfoOverlay({ entity, onClose, onFilter }) {
  const { kind, item } = entity;
  const [detail, setDetail] = useState(null);
  const [status, setStatus] = useState('loading');
  const [imageFailed, setImageFailed] = useState(false);

  // Capture phase: Back closes this sheet, not the page behind it.
  useBackKey(onClose);

  const data = { ...item, ...(detail || {}) };
  // The counts are the sheet's only actions, so they are the only registered
  // elements besides the panel. The panel declares Left/Right into the first
  // count: from there the row's own nextId chain takes over, which also keeps
  // Right meaningful when the row wraps at a narrow width.
  const counts = (kind === 'tag' ? TAG_COUNTS : STUDIO_COUNTS)
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
    let cancelled = false;
    setDetail(null);
    setStatus('loading');

    const load = kind === 'tag' ? fetchTagInfo : fetchStudioInfo;
    load(item.id)
      .then(d => {
        if (cancelled) return;
        setDetail(d);
        setStatus(d ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => { cancelled = true; };
  }, [kind, item.id]);

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

  const aliases = data.aliases || [];
  const description = kind === 'tag' ? data.description : data.details;
  const parentNames = kind === 'tag'
    ? namesText(data.parents || [])
    : data.parentStudio?.name;
  const childNames = kind === 'tag'
    ? namesText(data.children || [])
    : namesText(data.childStudios || []);
  const noun = kind === 'tag' ? 'tag' : 'studio';

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`Info for ${data.name}`}
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
              className={`${styles.image} ${kind === 'tag' ? styles.portrait : styles.landscape}`}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div
              className={`${styles.image} ${styles.fallback} ${kind === 'tag' ? styles.portrait : styles.landscape}`}
              aria-hidden="true"
            >
              {data.name?.[0] || '?'}
            </div>
          )}

          <div className={styles.heading}>
            <p className={styles.kind}>{kind === 'tag' ? 'Tag' : 'Studio'}</p>
            <h2 className={styles.title}>{data.name}</h2>
            <div className={styles.meta}>
              {data.favorite && <span className={styles.favorite}>★ Favourite</span>}
              {kind === 'studio' && data.rating && (
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
          <p className={styles.state}>This {noun} is no longer on the server.</p>
        )}

        {description && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              {kind === 'tag' ? 'Description' : 'Details'}
            </h3>
            <p className={styles.body}>{description}</p>
          </section>
        )}

        {aliases.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Also known as</h3>
            <p className={styles.body}>{aliases.join(', ')}</p>
          </section>
        )}

        {parentNames && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              {kind === 'tag' ? 'Parent tags' : 'Parent studio'}
            </h3>
            <p className={styles.body}>{parentNames}</p>
          </section>
        )}

        {childNames && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              {kind === 'tag' ? 'Child tags' : 'Sub-studios'}
            </h3>
            <p className={styles.body}>{childNames}</p>
          </section>
        )}

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
