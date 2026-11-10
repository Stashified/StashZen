/**
 * SearchPage, one query across every tab Stash can name in one text field:
 * scenes, markers, performers, tags, studios, groups, galleries and images.
 *
 * Each section asks Stash for the same six rows the grid would draw, using the
 * existing card components so a result is recognisable as the card in its own
 * tab. A section with more matches than the six shown gets a See-all tile,
 * which hands the query to that tab. Without it a search could show six other
 * things and no way to reach the match that was eighth.
 *
 * The query is App's state: opening a performer leaves this page for the
 * Performers tab, and Back must return to the same results. The text field
 * debounces like the controls bar's SearchInput; the fetch effect aborts the
 * previous round so a fast typist cannot be answered out of order.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useEditableField } from '../hooks/useEditableField.js';
import { isRestorePending } from '../utils/restorePending.js';
import VideoCard from '../components/VideoCard.jsx';
import PerformerCard from '../components/PerformerCard.jsx';
import {
  TAG_VIEW, STUDIO_VIEW, GROUP_VIEW, GALLERY_VIEW, IMAGE_VIEW,
} from '../components/entityViews.jsx';
import { MARKER_VIEW } from '../components/carouselViews.js';
import { fetchVideos } from '../utils/videoService.js';
import { fetchMarkers } from '../utils/markerService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchTags } from '../utils/tagService.js';
import { fetchStudios } from '../utils/studioService.js';
import { fetchGroups } from '../utils/groupService.js';
import { fetchGalleries } from '../utils/galleryService.js';
import { fetchImages } from '../utils/imageService.js';
import styles from './SearchPage.module.css';

const LIMIT = 6;
const DEBOUNCE_MS = 300;

// `sort: null` on scenes keeps Stash's relevance order for a text query;
// naming a sort would bury the best matches behind the newest. The name/title
// sections sort by their own name field, which is the only order a person can
// predict. `one` is spelled out because "galleries" does not lose its "s".
const SECTIONS = [
  {
    key: 'scenes',
    heading: 'Scenes',
    noun: 'scenes',
    one: 'scene',
    tab: 'scenes',
    focusPrefix: 'video',
    Card: VideoCard,
    load: (q, signal) => fetchVideos({
      q, sort: null, order: null, page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.videos, total: d.total })),
  },
  {
    key: 'markers',
    heading: 'Markers',
    noun: 'markers',
    one: 'marker',
    tab: 'markers',
    focusPrefix: 'marker',
    // Markers are timestamps inside scenes, so their cards play the parent
    // scene from that point. The server's default title order keeps names
    // predictable, the same as the entity sections below.
    Card: MARKER_VIEW.Card,
    load: (q, signal) => fetchMarkers({
      q, page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.markers, total: d.total })),
  },
  {
    key: 'performers',
    heading: 'Performers',
    noun: 'performers',
    one: 'performer',
    tab: 'performers',
    focusPrefix: 'performer',
    // The performer card, not the scene card: it reads `image_path`, draws the
    // 3:4 cover and has no play glyph.
    Card: PerformerCard,
    load: (q, signal) => fetchPerformers({
      q, sort: 'name', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.performers, total: d.total })),
  },
  {
    key: 'tags',
    heading: 'Tags',
    noun: 'tags',
    one: 'tag',
    tab: 'tags',
    focusPrefix: 'tag',
    Card: TAG_VIEW.Card,
    load: (q, signal) => fetchTags({
      q, sort: 'name', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.tags, total: d.total })),
  },
  {
    key: 'studios',
    heading: 'Studios',
    noun: 'studios',
    one: 'studio',
    tab: 'studios',
    focusPrefix: 'studio',
    Card: STUDIO_VIEW.Card,
    load: (q, signal) => fetchStudios({
      q, sort: 'name', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.studios, total: d.total })),
  },
  {
    key: 'groups',
    heading: 'Groups',
    noun: 'groups',
    one: 'group',
    tab: 'groups',
    focusPrefix: 'group',
    Card: GROUP_VIEW.Card,
    load: (q, signal) => fetchGroups({
      q, sort: 'name', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.groups, total: d.total })),
  },
  {
    key: 'galleries',
    heading: 'Galleries',
    noun: 'galleries',
    one: 'gallery',
    tab: 'galleries',
    focusPrefix: 'gallery',
    Card: GALLERY_VIEW.Card,
    load: (q, signal) => fetchGalleries({
      q, sort: 'title', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.galleries, total: d.total })),
  },
  {
    key: 'images',
    heading: 'Images',
    noun: 'images',
    one: 'image',
    tab: 'images',
    focusPrefix: 'image',
    // The grid card, not the viewer: selecting one opens the viewer with the
    // six results beside it, so stepping through them works from here too.
    Card: IMAGE_VIEW.Card,
    load: (q, signal) => fetchImages({
      q, sort: 'title', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.images, total: d.total })),
  },
];

function errorText(e) {
  return e?.message || 'failed';
}

export default function SearchPage({
  query,
  onQueryChange,
  onSceneSelect,
  onMarkerSelect,
  onPerformerSelect,
  onTagSelect,
  onStudioSelect,
  onGroupSelect,
  onGallerySelect,
  onImageSelect,
  onSeeAll,
  recentSearches = [],
  onRememberSearch,
}) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  // Bumped by Retry. Part of the fetch identity, so the same query runs again
  // even though neither it nor `query` changed.
  const [attempt, setAttempt] = useState(0);
  // The retry button unmounts the moment the fetch starts, so the click hands
  // the cursor back to the field rather than letting it fall to <body>.
  const fieldFocusRef = useRef(null);

  useEffect(() => {
    const q = (query || '').trim();
    if (!q) {
      setResults(null);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);

    Promise.all(SECTIONS.map(section => section.load(q, controller.signal)
      .then(data => ({ key: section.key, ...data, error: null }))
      .catch(e => ({ key: section.key, items: [], total: 0, error: errorText(e) }))))
      .then((rows) => {
        if (cancelled) return;
        setResults(rows);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [query, attempt]);

  const trimmed = (query || '').trim();
  // A search worth keeping is one that was committed or led somewhere, not
  // every paused keystroke the debounce happened to send.
  const remember = () => {
    if (trimmed) onRememberSearch?.(trimmed);
  };

  const select = {
    scenes: (item) => { remember(); onSceneSelect?.(item); },
    markers: (item) => { remember(); onMarkerSelect?.(item); },
    performers: (item) => { remember(); onPerformerSelect?.(item); },
    tags: (item) => { remember(); onTagSelect?.(item); },
    studios: (item) => { remember(); onStudioSelect?.(item); },
    groups: (item) => { remember(); onGroupSelect?.(item); },
    galleries: (item) => { remember(); onGallerySelect?.(item); },
    images: (item, index, items) => {
      remember();
      onImageSelect?.(item, index, items);
    },
  };

  const byKey = new Map((results || []).map(row => [row.key, row]));
  // Down from the field would otherwise land on the second card: the field is
  // 900 px wide and its centre sits over column 2 of the six-column grid.
  const firstRow = SECTIONS.find(s => (byKey.get(s.key)?.items.length ?? 0) > 0);
  const firstDownId = firstRow
    ? `${firstRow.focusPrefix}-${byKey.get(firstRow.key).items[0].id}`
    : null;
  const anyItems = (results || []).some(row => row.items.length > 0);
  const anyError = (results || []).some(row => row.error);
  const recent = trimmed ? [] : recentSearches;
  const recentDownId = recent.length ? 'search-recent-0' : null;

  const retry = () => {
    setAttempt(a => a + 1);
    fieldFocusRef.current?.();
  };

  // The chips unmount the moment the query is non-empty, so the press moves the
  // cursor to the field instead of leaving it on a removed button.
  const chooseRecent = (text) => {
    onQueryChange?.(text);
    onRememberSearch?.(text);
    setTimeout(() => fieldFocusRef.current?.(), 0);
  };

  return (
    <div className={styles.page}>
      <SearchField
        value={query}
        onChange={onQueryChange}
        onCommit={onRememberSearch}
        downTo={firstDownId || recentDownId}
        focusRef={fieldFocusRef}
      />

      {!trimmed && (
        <>
          <p className={styles.intro}>
            Search scenes, markers, performers, tags, studios, groups, galleries
            and images.
          </p>
          {recent.length > 0 && (
            <div className={styles.recent}>
              <span className={styles.recentLabel}>Recent searches</span>
              <div className={styles.chips}>
                {recent.map((text, index) => (
                  <RecentChip
                    key={text}
                    id={`search-recent-${index}`}
                    label={text}
                    onClick={() => chooseRecent(text)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {trimmed && !anyItems && loading && (
        <div className={styles.state}>
          <div className={styles.spinner} aria-label="Searching" />
          <p className={styles.stateText}>Searching…</p>
        </div>
      )}

      {trimmed && !anyItems && !loading && (
        <div className={styles.failure}>
          <p className={styles.stateText}>
            {anyError ? 'Could not search your library.' : `No matches for “${trimmed}”.`}
          </p>
          {anyError && <RetryButton id="search-retry" onClick={retry} />}
        </div>
      )}

      {trimmed && anyItems && (
        <div className={styles.results}>
          <div className={styles.statusRow}>
            <p className={styles.status} role="status" aria-live="polite">
              {loading ? 'Searching…' : `Results for “${trimmed}”`}
            </p>
            {!loading && anyError && (
              <RetryButton id="search-retry" onClick={retry} />
            )}
          </div>

          {SECTIONS.map((section) => {
            const row = byKey.get(section.key);
            if (!row) return null;
            if (!row.items.length && !row.error) return null;
            return (
              <SearchSection
                key={section.key}
                section={section}
                row={row}
                query={trimmed}
                onSelect={select[section.key]}
                onSeeAll={(tab, q, focusId) => {
                  remember();
                  onSeeAll?.(tab, q, focusId);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchField({ value, onChange, onCommit, downTo, focusRef }) {
  // A restore is on its way back to a result card (from a detail page). Taking
  // focus here would pull it off that card a frame later, so this mount must
  // not auto-focus. Captured once: a later change of this flag would arm the
  // field's auto-focus mid-session.
  const [autoFocus] = useState(() => !isRestorePending());
  const [draft, setDraft] = useState(value || '');
  const debounceRef = useRef(null);

  const flush = useCallback((next) => {
    clearTimeout(debounceRef.current);
    onChange(next);
  }, [onChange]);

  const {
    setWrapperRef, inputRef, selected, editing, inputHandlers, focusWrapper,
  } = useEditableField({
    id: 'search-field',
    zone: 'grid',
    autoFocus,
    nextId: downTo ? { down: downTo } : null,
    onCommit: () => {
      flush(draft);
      onCommit?.(draft);
    },
  });

  // The query can also change from outside: a recent chip, or Back restoring
  // the tab's previous search. The field must show what is being searched.
  // Skipped while the input has focus, or the debounced value would rewrite
  // characters typed since the timer was armed.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setDraft(value || '');
  }, [value, inputRef]);

  // Retry puts the cursor back here: the button that was pressed is gone.
  useEffect(() => {
    if (!focusRef) return undefined;
    focusRef.current = focusWrapper;
    return () => { focusRef.current = null; };
  }, [focusRef, focusWrapper]);

  const handleChange = (e) => {
    const next = e.target.value;
    setDraft(next);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(next), DEBOUNCE_MS);
  };

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  return (
    <div className={styles.searchBlock}>
      <div
        ref={setWrapperRef}
        className={[
          styles.field,
          selected ? styles.fieldFocused : '',
          editing ? styles.fieldEditing : '',
        ].join(' ')}
      >
        <svg className={styles.searchIcon} width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2" />
          <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={draft}
          onChange={handleChange}
          placeholder="Search scenes, markers, performers, tags…"
          aria-label="Search your library"
          tabIndex={-1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          {...inputHandlers}
        />
      </div>
      <span className={`${styles.hint} ${selected && !editing ? styles.hintOn : ''}`}>
        Press Enter to edit
      </span>
    </div>
  );
}

function SearchSection({ section, row, query, onSelect, onSeeAll }) {
  const { key, heading, noun, one, Card } = section;
  const canSeeAll = row.total > row.items.length;
  const list = { items: row.items, total: row.total };

  return (
    <section className={styles.section} aria-labelledby={`search-${key}-heading`}>
      <div className={styles.rowHead}>
        <h2 id={`search-${key}-heading`} className={styles.heading}>{heading}</h2>
        <span className={styles.count}>
          {row.total.toLocaleString()} {row.total === 1 ? one : noun}
        </span>
        {canSeeAll && (
          <SeeAllButton
            id={`search-seeall-${key}`}
            label={`See all ${noun}`}
            onClick={() => onSeeAll?.(section.tab, query, `search-seeall-${key}`)}
          />
        )}
      </div>

      {row.error && (
        <p className={styles.error}>Could not search {noun}.</p>
      )}

      {row.items.length > 0 && (
        <div className={styles.grid} role="grid" aria-label={`${heading} results`}>
          {row.items.map((item, index) => (
            <Card
              key={item.id}
              item={item}
              index={index}
              // The image viewer steps through this section's results; every
              // card ignores the prop it does not need.
              list={list}
              onSelect={onSelect}
              autoFocus={false}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SeeAllButton({ id, label, onClick }) {
  const { ref, focused } = useFocusable({
    id,
    zone: 'grid',
    onEnter: onClick,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.seeAll} ${focused ? styles.seeAllFocused : ''}`}
      onClick={onClick}
    >
      {label} <span aria-hidden="true">→</span>
    </button>
  );
}

function RecentChip({ id, label, onClick }) {
  const { ref, focused } = useFocusable({ id, zone: 'grid', onEnter: onClick });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.chip} ${focused ? styles.chipFocused : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// One Retry either for the whole page or for the sections that failed; the
// results it replaces are still on screen, so the failure stays visible.
function RetryButton({ id, onClick }) {
  const { ref, focused } = useFocusable({ id, zone: 'grid', onEnter: onClick });
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.retry} ${focused ? styles.retryFocused : ''}`}
      onClick={onClick}
    >
      Retry
    </button>
  );
}
