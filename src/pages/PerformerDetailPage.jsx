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

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import VideoGrid from '../components/VideoGrid.jsx';
import ControlsPanel from '../components/ControlsPanel.jsx';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { useFlash } from '../hooks/useFlash.js';
import { isBackKey, focusScopeOf } from '../utils/input.js';
import { loadPerformerDetail, updatePerformer } from '../utils/performerService.js';
import { ActionButton } from './sceneDetail/ActionButton.jsx';
import { RatingStepper } from './sceneDetail/RatingStepper.jsx';
import {
  ageFromBirthdate, formatHeight, formatGender, formatCareer,
  webLinks, formatDeathDate, ratingFromCard,
} from './performerDetail/format.js';
import styles from './PerformerDetailPage.module.css';

// Alias lists can be long (Stash stores every name a performer has worked
// under). Four chips plus a count keeps the hero from growing without bound.
// Tags and links get the same treatment: these are all free-text lists whose
// length is up to the library, and the hero must not push the grid off-screen.
const MAX_ALIAS_CHIPS = 4;
const MAX_TAG_CHIPS = 5;
const MAX_LINK_CHIPS = 3;

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

  // ── Rating and favourite (the two writes this page offers) ─
  // Seeded from the card so the hero is right on the first paint, then
  // replaced by the detail answer. The card's `rating` is a display string;
  // every write below uses the detail query's `rating100`.
  const [edits, setEdits] = useState(() => ({
    rating100: ratingFromCard(performer),
    favorite: !!performer.favorite,
  }));
  const [notice, flash] = useFlash();
  const ratingAttempt = useRef(0);
  const favoriteAttempt = useRef(0);

  const cardRating = performer.rating;
  const cardFavorite = performer.favorite;
  useEffect(() => {
    setEdits({
      rating100: ratingFromCard({ rating: cardRating }),
      favorite: !!cardFavorite,
    });
    // A response aimed at the previous performer must not be adopted here.
    ratingAttempt.current += 1;
    favoriteAttempt.current += 1;
  }, [performer.id, cardRating, cardFavorite]);

  useEffect(() => {
    if (!profile) return;
    // The detail answer is authoritative: in a live library the card's
    // rounded display value and the stored value can differ, and a write
    // must start from what Stash actually has.
    setEdits(prev => ({
      rating100: profile.rating100 ?? prev.rating100,
      favorite: profile.favorite ?? prev.favorite,
    }));
    ratingAttempt.current += 1;
    favoriteAttempt.current += 1;
  }, [profile]);

  // Editable only once the real values are on screen, and never in Test mode
  // where the ids belong to generated data with no row behind them.
  const canEdit = profileStatus === 'ready' && profile?.writable !== false;

  const setRating = async (stars) => {
    if (!canEdit) return;
    const next = Math.max(0, Math.min(100, stars * 10));
    const prev = edits.rating100;
    const attempt = ++ratingAttempt.current;
    setEdits(e => ({ ...e, rating100: next }));
    try {
      const server = await updatePerformer(performer.id, { rating100: next });
      if (attempt !== ratingAttempt.current) return;
      if (server.rating100 != null) {
        setEdits(e => ({ ...e, rating100: server.rating100 }));
      }
    } catch (e) {
      if (attempt !== ratingAttempt.current) return;
      setEdits(prevEdits => ({ ...prevEdits, rating100: prev }));
      flash(`Rating not saved — ${e.message}`);
    }
  };

  const toggleFavorite = async () => {
    if (!canEdit) return;
    const next = !edits.favorite;
    const prev = edits.favorite;
    const attempt = ++favoriteAttempt.current;
    setEdits(e => ({ ...e, favorite: next }));
    try {
      const server = await updatePerformer(performer.id, { favorite: next });
      if (attempt !== favoriteAttempt.current) return;
      if (server.favorite != null) {
        setEdits(e => ({ ...e, favorite: !!server.favorite }));
      }
    } catch (e) {
      if (attempt !== favoriteAttempt.current) return;
      setEdits(prevEdits => ({ ...prevEdits, favorite: prev }));
      flash(`Favourite not saved — ${e.message}`);
    }
  };

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
  const rating = edits.rating100 > 0 ? (edits.rating100 / 10).toFixed(1) : null;
  const { links, omitted: omittedLinks } = webLinks(profile?.urls, MAX_LINK_CHIPS);
  const tags = profile?.tags || [];
  const facts = [
    career && { key: 'career', label: 'Career', value: career },
    profile?.ethnicity && { key: 'ethnicity', label: 'Ethnicity', value: profile.ethnicity },
    profile?.hairColor && { key: 'hair', label: 'Hair', value: profile.hairColor },
    profile?.eyeColor && { key: 'eyes', label: 'Eyes', value: profile.eyeColor },
    profile?.weight && { key: 'weight', label: 'Weight', value: profile.weight },
    profile?.measurements && { key: 'measurements', label: 'Measurements', value: profile.measurements },
    profile?.piercings && { key: 'piercings', label: 'Piercings', value: profile.piercings, clamp: true },
    profile?.fakeTits && { key: 'fake-tits', label: 'Fake tits', value: profile.fakeTits, clamp: true },
    profile?.tattoos && { key: 'tattoos', label: 'Tattoos', value: profile.tattoos, clamp: true },
    formatDeathDate(profile?.deathDate) && {
      key: 'died', label: 'Died', value: formatDeathDate(profile.deathDate),
    },
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
            {edits.favorite && <span className={styles.favorite} aria-label="Favorite">★</span>}
          </h1>

          {performer.disambiguation && (
            <p className={styles.disambiguation}>{performer.disambiguation}</p>
          )}

          <div className={styles.metaRow}>
            <span className={styles.sceneCount}>
              <strong>{performer.scene_count}</strong> {performer.scene_count === 1 ? 'scene' : 'scenes'}
            </span>
            {profile?.oCounter > 0 && <span>{profile.oCounter} likes</span>}
            {profile?.imageCount > 0 && (
              <span>{profile.imageCount} {profile.imageCount === 1 ? 'image' : 'images'}</span>
            )}
            {profile?.galleryCount > 0 && (
              <span>{profile.galleryCount} {profile.galleryCount === 1 ? 'gallery' : 'galleries'}</span>
            )}
            {rating && <span className={styles.rating}>★ {rating}</span>}
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
                <span key={fact.key} className={styles.profileChip}>
                  {fact.label} <span className={fact.clamp ? styles.profileChipText : undefined}>{fact.value}</span>
                </span>
              ))}
            </div>
          )}

          {links.length > 0 && (
            <div className={styles.linksRow} role="group" aria-label="Links">
              <span className={styles.aliasLabel}>Links</span>
              {links.map(link => (
                <span
                  key={link.host}
                  className={`${styles.profileChip} ${styles.profileUrl}`}
                  aria-label={`Website: ${link.url}`}
                >
                  {link.host}
                </span>
              ))}
              {omittedLinks > 0 && (
                <span className={styles.chipMore}>+{omittedLinks}</span>
              )}
            </div>
          )}

          {tags.length > 0 && (
            <div className={styles.tagsRow} role="group" aria-label="Performer tags">
              <span className={styles.aliasLabel}>Tags</span>
              {tags.slice(0, MAX_TAG_CHIPS).map(tag => (
                <span key={tag.id} className={styles.aliasChip}>{tag.name}</span>
              ))}
              {tags.length > MAX_TAG_CHIPS && (
                <span className={styles.chipMore}>+{tags.length - MAX_TAG_CHIPS}</span>
              )}
            </div>
          )}

          {(profileStatus === 'ready') && (
            <div className={styles.actionRow} role="group" aria-label="Performer actions">
              <RatingStepper
                rating100={edits.rating100}
                disabled={!canEdit}
                onChange={setRating}
                idPrefix="performer-rating"
                zone="performer-detail"
                styles={styles}
              />
              <ActionButton
                id="performer-favorite"
                label="Favourite"
                icon="★"
                active={edits.favorite}
                disabled={!canEdit}
                onEnter={toggleFavorite}
                zone="performer-detail"
                styles={styles}
              />
            </div>
          )}

          {performer.details && (
            <p className={styles.bio}>{performer.details}</p>
          )}

          {notice && (
            <div className={styles.profileWarn} role="status">{notice}</div>
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
