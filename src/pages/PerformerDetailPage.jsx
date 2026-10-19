/**
 * PerformerDetailPage — Hero header + filtered video grid
 *
 * Shown when a performer is selected from the Performers grid.
 * Owns its own controls state (independent of the app-level Home
 * controls). Filters videos to scenes featuring this performer
 * via Stash's standard scene filter shape.
 *
 * Backspace / Tizen Back returns to the performer grid.
 */

import { useCallback, useEffect, useState, useMemo } from 'react';
import VideoGrid from '../components/VideoGrid.jsx';
import ControlsPanel from '../components/ControlsPanel.jsx';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { isBackKey, focusScopeOf } from '../utils/input.js';
import { loadPerformerDetail } from '../utils/performerService.js';
import styles from './PerformerDetailPage.module.css';

// Alias lists can be long (Stash stores every name a performer has worked
// under). Four chips plus a count keeps the hero from growing without bound.
const MAX_ALIAS_CHIPS = 4;

// Scene sort groups for the inner video grid — same set as Home, but
// kept local so we don't have to thread them down from App.
const SCENE_SORT_GROUPS = [
  {
    group: 'General',
    options: [
      { value: 'created_at',     label: 'Date Added' },
      { value: 'updated_at',     label: 'Date Updated' },
      { value: 'title',          label: 'Title' },
      { value: 'random',         label: 'Random' },
    ],
  },
  {
    group: 'Engagement',
    options: [
      { value: 'rating',         label: 'Rating' },
      { value: 'o_counter',      label: 'Likes' },
      { value: 'play_count',     label: 'Play Count' },
      { value: 'play_duration',  label: 'Play Duration' },
      { value: 'last_played_at', label: 'Last Played' },
    ],
  },
  {
    group: 'File',
    options: [
      { value: 'duration',       label: 'Duration' },
      { value: 'filesize',       label: 'File Size' },
      { value: 'resolution',     label: 'Resolution' },
      { value: 'bitrate',        label: 'Bitrate' },
      { value: 'framerate',      label: 'Frame Rate' },
    ],
  },
];

const DEFAULT_DETAIL_CONTROLS = {
  sort:  'created_at',
  order: 'desc',
  cols:  4,
  search: '',
};

// Compute an age string from an ISO birthdate
function ageFromBirthdate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function formatHeight(cm) {
  if (!cm) return null;
  // Round to whole inches first, then split. Rounding only the remainder
  // prints 5′12″ for, say, 182 cm; carrying the 12 is the same mistake a
  // careless clock makes at 59.6 minutes.
  const totalInches = Math.round(cm / 2.54);
  const ft = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${cm} cm · ${ft}′${inches}″`;
}

// GenderEnum is SCREAMING_SNAKE and is not meant to be read raw. Unknown
// values (a newer Stash adds one) fall back to words rather than disappearing.
function formatGender(value) {
  if (!value) return null;
  const labels = {
    MALE: 'Male',
    FEMALE: 'Female',
    TRANSGENDER_MALE: 'Transgender male',
    TRANSGENDER_FEMALE: 'Transgender female',
    INTERSEX: 'Intersex',
    NON_BINARY: 'Non-binary',
  };
  return labels[value] || String(value).replace(/_/g, ' ').toLowerCase();
}

// Stash stores career bounds as strings, in practice a date ("1999-04-01").
function yearOf(value) {
  const m = String(value).match(/^\d{4}/);
  return m ? m[0] : String(value);
}

// Prefer the two bounds; `career_length` is a free string ("12 years") and is
// only the fallback when neither bound is recorded.
function formatCareer({ careerStart, careerEnd, careerLength } = {}) {
  if (careerStart && careerEnd) return `${yearOf(careerStart)}–${yearOf(careerEnd)}`;
  if (careerStart) return `${yearOf(careerStart)}–`;
  if (careerEnd) return `–${yearOf(careerEnd)}`;
  return careerLength || null;
}

// There is no browser on a TV, so a performer's website is shown by host.
function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

// ── Back button — focusable so mouse/click users have a path ─
function BackButton({ onClick }) {
  const { ref, focused } = useFocusable({
    id: 'detail-back',
    zone: 'detail-header',
    onEnter: onClick,
    autoFocus: true,
  });
  return (
    <button
      ref={ref}
      className={`${styles.backBtn} ${focused ? styles.focused : ''}`}
      onClick={onClick}
      aria-label="Back to performers"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M12 5l-5 5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span>Back</span>
    </button>
  );
}

// ── Main component ──────────────────────────────────────
export default function PerformerDetailPage({ performer, onBack, onVideoSelect, previewMuted, onMuteToggle }) {
  const [controls, setControls] = useState(DEFAULT_DETAIL_CONTROLS);
  // The card the page was opened from already carries everything the hero's
  // first paint needs. The profile fields arrive from one small query and are
  // layered on top; until then — and if it fails — the card stays on screen.
  const [profile, setProfile] = useState(null);
  const [profileStatus, setProfileStatus] = useState('loading');
  const [profileError, setProfileError] = useState(null);

  // Filter scenes to those including this performer. Memoised so we
  // don't trigger downstream re-fetches when other state changes.
  const objectFilter = useMemo(() => ({
    performers: { value: [String(performer.id)], modifier: 'INCLUDES' },
  }), [performer.id]);

  const updateControls = (patch) => {
    setControls(prev => ({ ...prev, ...patch }));
  };

  // ── Profile fields (one query, layered onto the card) ──────
  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setProfileStatus('loading');
    setProfileError(null);

    loadPerformerDetail(performer)
      .then(full => {
        if (cancelled) return;
        if (!full) {
          setProfileStatus('error');
          setProfileError('Performer not found on the server.');
          return;
        }
        setProfile(full);
        setProfileStatus('ready');
      })
      .catch(e => {
        if (cancelled) return;
        setProfileStatus('error');
        setProfileError(e.message);
      });

    return () => { cancelled = true; };
  }, [performer]);

  // Page-level Back handler — capture phase so the global Back doesn't fire
  // its tab-switching behaviour first.
  //
  // The predicate carries the two yields the hand-written handler had. Only
  // Backspace belongs to the search field (`isBackKey` does that test; this
  // guard once returned for *every* key while a text field had focus, which
  // swallowed the remote's Back entirely). A nested layer owns Back while it
  // is open — an open sort/filter dropdown (`data-focus-trap`) or the
  // long-press action menu (`role="dialog"`) — and this listener is
  // registered when the page mounts, so it runs before theirs on the shared
  // window capture target. Doing the scope test in the predicate rather than
  // in the handler also means this listener does not preventDefault a key the
  // nested layer handles.
  const pageIsBack = useCallback(
    (e) => isBackKey(e) && !focusScopeOf(document.activeElement),
    [],
  );
  useBackKey(() => onBack?.(), { isBack: pageIsBack });

  const age = ageFromBirthdate(performer.birthdate);
  const height = formatHeight(performer.height_cm);

  // The card's gender is available on the first paint; the detail answer is
  // preferred once it lands, and an empty detail value falls back to the card.
  const gender = formatGender(profile?.gender ?? performer.gender);
  const aliases = profile?.aliases || [];
  const career = profile ? formatCareer(profile) : null;
  const website = profile?.url ? (hostOf(profile.url) || profile.url) : null;
  const facts = [
    career && { key: 'career', label: 'Career', value: career },
    profile?.measurements && { key: 'measurements', label: 'Measurements', value: profile.measurements },
    profile?.tattoos && { key: 'tattoos', label: 'Tattoos', value: profile.tattoos, clamp: true },
    website && { key: 'website', label: 'Website', value: website, url: profile.url },
  ].filter(Boolean);

  return (
    <div className={styles.page}>
      {/* ── Hero header ─────────────────────────────────── */}
      <header className={styles.hero}>
        <div className={styles.heroLeft}>
          <BackButton onClick={onBack} />
          {performer.image_path ? (
            <img
              src={performer.image_path}
              alt=""
              className={styles.image}
              loading="lazy"
            />
          ) : (
            <div className={styles.imageFallback}>
              <span>{performer.name?.[0] || '?'}</span>
            </div>
          )}
        </div>

        <div className={styles.heroRight}>
          <h1 className={styles.name}>
            {performer.name}
            {performer.favorite && <span className={styles.favorite} aria-label="Favorite">★</span>}
          </h1>

          {performer.disambiguation && (
            <p className={styles.disambiguation}>{performer.disambiguation}</p>
          )}

          <div className={styles.metaRow}>
            <span className={styles.sceneCount}>
              <strong>{performer.scene_count}</strong> {performer.scene_count === 1 ? 'scene' : 'scenes'}
            </span>
            {performer.rating && (
              <span className={styles.rating}>★ {performer.rating}</span>
            )}
            {gender && <span aria-label={`Gender: ${gender}`}>{gender}</span>}
            {performer.country && <span>{performer.country}</span>}
            {age != null && <span>Age {age}</span>}
            {height && <span>{height}</span>}
          </div>

          {aliases.length > 0 && (
            <div className={styles.aliasRow} role="group" aria-label="Also known as">
              <span className={styles.aliasLabel}>Also known as</span>
              {aliases.slice(0, MAX_ALIAS_CHIPS).map(alias => (
                <span key={alias} className={styles.aliasChip}>{alias}</span>
              ))}
              {aliases.length > MAX_ALIAS_CHIPS && (
                <span className={styles.chipMore}>+{aliases.length - MAX_ALIAS_CHIPS}</span>
              )}
            </div>
          )}

          {facts.length > 0 && (
            <div className={styles.profileRow} role="group" aria-label="Performer profile">
              {facts.map(fact => (
                <span
                  key={fact.key}
                  className={`${styles.profileChip} ${fact.url ? styles.profileUrl : ''}`}
                  aria-label={fact.url ? `Website: ${fact.url}` : undefined}
                >
                  {fact.label} <span className={fact.clamp ? styles.profileChipText : undefined}>{fact.value}</span>
                </span>
              ))}
            </div>
          )}

          {performer.details && (
            <p className={styles.bio}>{performer.details}</p>
          )}

          {profileStatus === 'error' && (
            <div className={styles.profileWarn} role="status">
              Couldn't load profile details{profileError ? ` — ${profileError}` : ''}
            </div>
          )}
        </div>
      </header>

      {/* ── Controls panel for the inner grid ───────────── */}
      <ControlsPanel
        controls={controls}
        onChange={updateControls}
        modeOptions={null}
        sortGroups={SCENE_SORT_GROUPS}
        showOrder={true}
        showGridSize={true}
        filterOptions={null}
        showSearch={true}
        previewMuted={previewMuted}
        onMuteToggle={onMuteToggle}
      />

      {/* ── Video grid filtered to this performer ───────── */}
      <VideoGrid
        controls={controls}
        objectFilter={objectFilter}
        searchQuery={controls.search || ''}
        onVideoSelect={onVideoSelect}
      />
    </div>
  );
}
