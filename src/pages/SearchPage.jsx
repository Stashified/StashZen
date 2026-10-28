/**
 * SearchPage, one query across scenes, performers, tags and studios.
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
import { TAG_VIEW, STUDIO_VIEW } from '../components/entityViews.jsx';
import { fetchVideos } from '../utils/videoService.js';
import { fetchPerformers } from '../utils/performerService.js';
import { fetchTags } from '../utils/tagService.js';
import { fetchStudios } from '../utils/studioService.js';
import styles from './SearchPage.module.css';

const LIMIT = 6;
const DEBOUNCE_MS = 300;

// `sort: null` on scenes keeps Stash's relevance order for a text query;
// naming a sort would bury the best matches behind the newest. The three name
// sections sort by name, which is the only order a person can predict.
const SECTIONS = [
  {
    key: 'scenes',
    heading: 'Scenes',
    noun: 'scenes',
    tab: 'scenes',
    focusPrefix: 'video',
    Card: VideoCard,
    load: (q, signal) => fetchVideos({
      q, sort: null, order: null, page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.videos, total: d.total })),
  },
  {
    key: 'performers',
    heading: 'Performers',
    noun: 'performers',
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
    tab: 'studios',
    focusPrefix: 'studio',
    Card: STUDIO_VIEW.Card,
    load: (q, signal) => fetchStudios({
      q, sort: 'name', order: 'asc', page: 1, limit: LIMIT, signal,
    }).then(d => ({ items: d.studios, total: d.total })),
  },
];

function errorText(e) {
  return e?.message || 'failed';
}

export default function SearchPage({
  query,
  onQueryChange,
  onSceneSelect,
  onPerformerSelect,
  onTagSelect,
  onStudioSelect,
  onSeeAll,
}) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

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
  }, [query]);

  const select = {
    scenes: (item) => onSceneSelect?.(item),
    performers: (item) => onPerformerSelect?.(item),
    tags: (item) => onTagSelect?.(item),
    studios: (item) => onStudioSelect?.(item),
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
  const trimmed = (query || '').trim();

  return (
    <div className={styles.page}>
      <SearchField value={query} onChange={onQueryChange} downTo={firstDownId} />

      {!trimmed && (
        <p className={styles.intro}>
          Search scenes, performers, tags and studios.
        </p>
      )}

      {trimmed && !anyItems && loading && (
        <div className={styles.state}>
          <div className={styles.spinner} aria-label="Searching" />
          <p className={styles.stateText}>Searching…</p>
        </div>
      )}

      {trimmed && !anyItems && !loading && (
        <p className={styles.stateText}>
          {anyError ? 'Could not search your library.' : `No matches for “${trimmed}”.`}
        </p>
      )}

      {trimmed && anyItems && (
        <div className={styles.results}>
          <p className={styles.status} role="status" aria-live="polite">
            {loading ? 'Searching…' : `Results for “${trimmed}”`}
          </p>

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
                onSeeAll={onSeeAll}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SearchField({ value, onChange, downTo }) {
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

  const { setWrapperRef, inputRef, selected, editing, inputHandlers } = useEditableField({
    id: 'search-field',
    zone: 'grid',
    autoFocus,
    nextId: downTo ? { down: downTo } : null,
    onCommit: () => flush(draft),
  });

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
          placeholder="Search scenes, performers, tags, studios"
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
  const { key, heading, noun, Card } = section;
  const canSeeAll = row.total > row.items.length;

  return (
    <section className={styles.section} aria-labelledby={`search-${key}-heading`}>
      <div className={styles.rowHead}>
        <h2 id={`search-${key}-heading`} className={styles.heading}>{heading}</h2>
        <span className={styles.count}>
          {row.total.toLocaleString()} {row.total === 1 ? noun.replace(/s$/, '') : noun}
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
