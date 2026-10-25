/**
 * PerformerDetailPage — hero header plus a video grid filtered to this
 * performer via Stash's standard scene filter shape. Owns its own controls
 * state, independent of the app's. Backspace / Tizen Back returns to the grid.
 */

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import VideoGrid from '../components/VideoGrid.jsx';
import ControlsPanel from '../components/ControlsPanel.jsx';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { useFlash } from '../hooks/useFlash.js';
import { isBackKey, focusScopeOf, dialogOpen } from '../utils/input.js';
import { loadPerformerDetail, updatePerformer } from '../utils/performerService.js';
import { ActionButton } from './sceneDetail/ActionButton.jsx';
import { RatingStepper } from './sceneDetail/RatingStepper.jsx';
import {
  ageFromBirthdate, formatHeight, formatGender, formatCareer,
  webLinks, formatDeathDate, ratingFromCard,
} from './performerDetail/format.js';
import styles from './PerformerDetailPage.module.css';

// Chips are capped: aliases, tags and links are free-text lists whose length is
// up to the library, and the hero must not push the grid off-screen.
const MAX_ALIAS_CHIPS = 4;
const MAX_TAG_CHIPS = 5;
const MAX_LINK_CHIPS = 3;

// Scene sort groups for the inner grid — kept local rather than threaded from App.
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

// Back button: focusable so mouse/click users have a path too.
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

export default function PerformerDetailPage({
  performer, onBack, onVideoSelect, onVideoLongPress, previewMuted, onMuteToggle,
}) {
  const [controls, setControls] = useState(DEFAULT_DETAIL_CONTROLS);
  // The card already carries what the hero's first paint needs; the profile
  // query layers on top, and the card stays on screen until it lands or fails.
  const [profile, setProfile] = useState(null);
  const [profileStatus, setProfileStatus] = useState('loading');
  const [profileError, setProfileError] = useState(null);

  // Memoised so unrelated state changes do not re-trigger the grid fetch.
  const objectFilter = useMemo(() => ({
    performers: { value: [String(performer.id)], modifier: 'INCLUDES' },
  }), [performer.id]);

  const updateControls = (patch) => {
    setControls(prev => ({ ...prev, ...patch }));
  };

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

  // Rating and favourite — the two writes this page offers. Seeded from the
  // card so the hero is right on first paint, then replaced by the detail
  // answer. The card's `rating` is a display string; writes use `rating100`.
  const [edits, setEdits] = useState(() => ({
    rating100: ratingFromCard(performer),
    favorite: !!performer.favorite,
  }));
  const [notice, flash] = useFlash();
  const ratingAttempt = useRef(0);
  const favoriteAttempt = useRef(0);
  // The last value the *server* acknowledged. Reverting to the optimistic value
  // instead would leave the hero showing a number Stash never stored.
  const ratingConfirmed = useRef(ratingFromCard(performer));
  const favoriteConfirmed = useRef(!!performer.favorite);
  // Writes are serialised so overlapping requests cannot reach the server out
  // of order and leave the stored value a press behind the screen.
  const ratingQueue = useRef(Promise.resolve());
  const favoriteQueue = useRef(Promise.resolve());

  const cardRating = performer.rating;
  const cardFavorite = performer.favorite;
  useEffect(() => {
    const rating = ratingFromCard({ rating: cardRating });
    setEdits({
      rating100: rating,
      favorite: !!cardFavorite,
    });
    ratingConfirmed.current = rating;
    favoriteConfirmed.current = !!cardFavorite;
    // A response aimed at the previous performer must not be adopted here.
    ratingAttempt.current += 1;
    favoriteAttempt.current += 1;
  }, [performer.id, cardRating, cardFavorite]);

  useEffect(() => {
    if (!profile) return;
    // The detail answer is authoritative: the card's rounded display value and
    // the stored value can differ, and a write must start from what Stash has.
    setEdits(prev => ({
      rating100: profile.rating100 ?? prev.rating100,
      favorite: profile.favorite ?? prev.favorite,
    }));
    if (profile.rating100 != null) ratingConfirmed.current = profile.rating100;
    if (profile.favorite != null) favoriteConfirmed.current = !!profile.favorite;
    ratingAttempt.current += 1;
    favoriteAttempt.current += 1;
  }, [profile]);

  // Editable only once the real values are on screen, and never in Test mode,
  // where the ids are generated data with no row behind them.
  const canEdit = profileStatus === 'ready' && profile?.writable !== false;

  const setRating = (stars) => {
    if (!canEdit) return;
    const next = Math.max(0, Math.min(100, stars * 10));
    const attempt = ++ratingAttempt.current;
    setEdits(e => ({ ...e, rating100: next }));
    ratingQueue.current = ratingQueue.current.then(async () => {
      try {
        const server = await updatePerformer(performer.id, { rating100: next });
        if (server.rating100 != null) {
          ratingConfirmed.current = server.rating100;
          if (attempt === ratingAttempt.current) {
            setEdits(e => ({ ...e, rating100: server.rating100 }));
          }
        }
      } catch (e) {
        // Only the newest press owns the screen: an older failure is already
        // superseded, and reverting it would undo a later press.
        if (attempt !== ratingAttempt.current) return;
        setEdits(prev => ({ ...prev, rating100: ratingConfirmed.current }));
        flash(`Rating not saved — ${e.message}`);
      }
    });
  };

  const toggleFavorite = () => {
    if (!canEdit) return;
    const next = !edits.favorite;
    const attempt = ++favoriteAttempt.current;
    setEdits(e => ({ ...e, favorite: next }));
    favoriteQueue.current = favoriteQueue.current.then(async () => {
      try {
        const server = await updatePerformer(performer.id, { favorite: next });
        if (server.favorite != null) {
          favoriteConfirmed.current = !!server.favorite;
          if (attempt === favoriteAttempt.current) {
            setEdits(e => ({ ...e, favorite: !!server.favorite }));
          }
        }
      } catch (e) {
        if (attempt !== favoriteAttempt.current) return;
        setEdits(prev => ({ ...prev, favorite: favoriteConfirmed.current }));
        flash(`Favourite not saved — ${e.message}`);
      }
    });
  };

  // Capture phase so the global handler does not tab-switch first. The
  // predicate, not the handler, carries the yields: only Backspace belongs to
  // the search field, and a nested layer (dropdown, action menu) owns Back —
  // testing here avoids preventDefaulting a key it handles. `dialogOpen` is the
  // yield focus cannot make: the player leaves focus on <body>, so a
  // focus-only guard would close the page when dismissing its controls.
  const pageIsBack = useCallback(
    (e) => isBackKey(e) && !dialogOpen() && !focusScopeOf(document.activeElement),
    [],
  );
  useBackKey(() => onBack?.(), { isBack: pageIsBack });

  // Measured to the death date once the profile supplies one; the card alone
  // has none, so the first paint uses today.
  const age = ageFromBirthdate(performer.birthdate, profile?.deathDate);
  const height = formatHeight(performer.height_cm);

  // The card's gender is available on first paint; the detail answer wins once
  // it lands, and an empty detail value falls back to the card.
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
            {age != null && (
              <span>{profile?.deathDate ? `Age at death ${age}` : `Age ${age}`}</span>
            )}
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


      <VideoGrid
        controls={controls}
        objectFilter={objectFilter}
        searchQuery={controls.search || ''}
        onVideoSelect={onVideoSelect}
        onVideoLongPress={onVideoLongPress}
      />
    </div>
  );
}
