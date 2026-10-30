/**
 * SceneDetailPage, full-screen scene view with the editable rating, organised,
 * like and the two activity actions: clear progress (leaves Continue Watching)
 * and mark played (appends a play now).
 *
 * Mounted as an overlay rather than swapped in as a page, so the grid
 * underneath keeps its scroll position and fetched pages: closing is a state
 * change, not a refetch. `role="dialog"` is what confines the D-pad to it via
 * `focusScopeOf`. Data and writes live in `sceneDetail/`, see the two hooks
 * for when the card paints first and the optimistic-write rules.
 */

import { useFlash } from '../hooks/useFlash.js';
import { useBackKey } from '../hooks/useBackKey.js';
import styles from './SceneDetailPage.module.css';
import { fmtDuration, fmtBytes, fmtResolution, fmtDate, hostOf } from './sceneDetail/format.js';
import { useSceneDetailData } from './sceneDetail/useSceneDetailData.js';
import { useRelatedScenes } from './sceneDetail/useRelatedScenes.js';
import { useSceneEdits } from './sceneDetail/useSceneEdits.js';
import { ActionButton } from './sceneDetail/ActionButton.jsx';
import { Chips } from './sceneDetail/Chips.jsx';
import { GalleryChip } from './sceneDetail/GalleryChip.jsx';
import { MarkerChip } from './sceneDetail/MarkerChip.jsx';
import { RelatedScenes } from './sceneDetail/RelatedScenes.jsx';
import { RatingStepper } from './sceneDetail/RatingStepper.jsx';

const NOTICE_MS = 4000;
const MAX_URLS = 3;
// Eight markers look like a timeline without a scrolling wall; the rest are
// counted, and every marker stays reachable from the Markers tab.
const MAX_MARKERS = 8;
// Galleries are a hand-off row, not a listing: four plus +N keeps it bounded.
const MAX_GALLERIES = 4;

export default function SceneDetailPage({
  scene, onClose, onPlay, onPlayAt, onActivityChange, onGallerySelect,
  onTagSelect, onStudioSelect, onPerformerSelect, onRelatedSceneSelect,
}) {
  // Transient status line, cleared on unmount, see useFlash. Called first so
  // its unmount effect is registered before the others.
  const [notice, flash] = useFlash(NOTICE_MS);

  const { detail, setDetail, status, loadError, canEdit } = useSceneDetailData(scene);
  // No handler means no rows: a page mounted without App cannot make them do
  // anything, and two extra requests on every open would be for nothing.
  const relatedRows = useRelatedScenes(detail, !!onRelatedSceneSelect);

  // Back owns this page: capture phase and stopPropagation, so App's global
  // handler never sees it. No text inputs exist here, so Backspace is unambiguous.
  useBackKey(() => onClose?.());

  // The six writes, see useSceneEdits for the optimistic and in-flight-token rules.
  const { setRating, toggleOrganized, incrementLike, clearLike, clearProgress, markPlayed } =
    useSceneEdits({ detail, setDetail, flash, onActivityChange, canEdit });

  if (!detail) return null;

  const liked = (detail.oCounter || 0) > 0;
  // The studio is a chip of its own above the performers, so it is not
  // repeated here.
  const metaBits = [
    fmtDate(detail.date),
    fmtDuration(detail.durationSeconds),
    fmtResolution(detail.width, detail.height),
    fmtBytes(detail.sizeBytes),
  ].filter(Boolean);

  const statBits = [
    detail.playCount != null && `${detail.playCount} ${detail.playCount === 1 ? 'play' : 'plays'}`,
    detail.playDurationSeconds > 0 && `${fmtDuration(detail.playDurationSeconds)} watched`,
    detail.lastPlayedAt && `last ${fmtDate(detail.lastPlayedAt)}`,
  ].filter(Boolean);

  const urls = (detail.urls || []).slice(0, MAX_URLS);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={detail.title}>
      <div className={styles.panel}>

        <div className={styles.heroCol}>
          {detail.screenshot ? (
            <img src={detail.screenshot} alt="" className={styles.hero} />
          ) : (
            <div className={styles.heroFallback}>
              <span>{detail.title?.[0] || '?'}</span>
            </div>
          )}

          <div className={styles.heroBadges}>
            {detail.width && detail.height && (
              <span className={styles.badge}>{detail.height}p</span>
            )}
            {fmtDuration(detail.durationSeconds) && (
              <span className={styles.badge}>{fmtDuration(detail.durationSeconds)}</span>
            )}
            {detail.rating100 > 0 && (
              <span className={`${styles.badge} ${styles.badgeRating}`}>
                {(detail.rating100 / 10).toFixed(1)}
              </span>
            )}
          </div>

          {detail.resumeTime > 10 && detail.durationSeconds > 0 && (
            <div className={styles.resumeBar} aria-hidden="true">
              <div
                className={styles.resumeFill}
                style={{ width: `${Math.min(100, (detail.resumeTime / detail.durationSeconds) * 100)}%` }}
              />
            </div>
          )}
        </div>


        <div className={styles.body}>
          <h1 className={styles.title}>{detail.title}</h1>

          <div className={styles.meta}>
            {metaBits.map((bit, i) => (
              <span key={i} className={styles.metaItem}>{bit}</span>
            ))}
          </div>

          {detail.code && (
            <div className={styles.code}>Code {detail.code}</div>
          )}

          {status === 'loading' && (
            <div className={styles.loading} role="status">
              <div className={styles.spinner} />
              <span>Loading details…</span>
            </div>
          )}

          {loadError && <div className={styles.warn}>{loadError}</div>}

          {detail.studio && (
            <div className={styles.markers} role="group" aria-label="Studio">
              <span className={styles.markersLabel}>Studio</span>
              <Chips
                items={[detail.studio]}
                kind="studio"
                onSelect={onStudioSelect}
              />
            </div>
          )}

          {detail.performers?.length > 0 && (
            <Chips
              items={detail.performers}
              className={styles.chipsPerformers}
              kind="performer"
              onSelect={onPerformerSelect}
            />
          )}

          {detail.tags?.length > 0 && (
            <Chips items={detail.tags} kind="tag" onSelect={onTagSelect} />
          )}

          {/* Enter leaves for the Images tab filtered to this gallery; the tab
              change closes this page through useDetailSelection (see GalleryChip). */}
          {detail.galleries?.length > 0 && (
            <div className={styles.markers} role="group" aria-label="Galleries">
              <span className={styles.markersLabel}>Galleries</span>
              {detail.galleries.slice(0, MAX_GALLERIES).map(gallery => (
                <GalleryChip
                  key={gallery.id}
                  gallery={gallery}
                  // The scene id is what Back can focus on the origin tab:
                  // there is no gallery card there (see handleGallerySelect).
                  onGallerySelect={g => onGallerySelect?.(g, detail.id)}
                />
              ))}
              {detail.galleries.length > MAX_GALLERIES && (
                <span className={styles.markerMore}>
                  +{detail.galleries.length - MAX_GALLERIES}
                </span>
              )}
            </div>
          )}

          {detail.details && (
            <p className={styles.details}>{detail.details}</p>
          )}

          {statBits.length > 0 && (
            <div className={styles.stats}>{statBits.join(' · ')}</div>
          )}

          {urls.length > 0 && (
            <div className={styles.urls}>
              {urls.map(u => <span key={u} className={styles.url}>{hostOf(u)}</span>)}
            </div>
          )}

          {detail.videoCodec && (
            <div className={styles.tech}>
              {[detail.videoCodec, detail.audioCodec].filter(Boolean).join(' / ')}
              {/* `bit_rate` is bits per second (4,200,000 for 1080p H.264),
                  exposed as `bitRate`; the label is kb/s, hence /1000. */}
              {detail.bitRate ? ` · ${Math.round(detail.bitRate / 1000)} kb/s` : ''}
            </div>
          )}


          {detail.markers?.length > 0 && (
            <div className={styles.markers} role="group" aria-label="Markers">
              <span className={styles.markersLabel}>Markers</span>
              {detail.markers.slice(0, MAX_MARKERS).map(marker => (
                <MarkerChip key={marker.id} marker={marker} onPlayAt={onPlayAt} />
              ))}
              {detail.markers.length > MAX_MARKERS && (
                <span className={styles.markerMore}>
                  +{detail.markers.length - MAX_MARKERS}
                </span>
              )}
            </div>
          )}


          <div className={styles.actions}>
            <ActionButton
              id="scene-play"
              label="Play"
              icon="▶"
              primary
              autoFocus
              // The fetched resume point travels with the press: the card
              // behind may be stale, and the player decides "resume or start
              // over" from the queue item it is handed.
              onEnter={() => onPlay?.(detail.resumeTime || 0)}
            />

            <RatingStepper
              rating100={detail.rating100}
              disabled={!canEdit}
              onChange={setRating}
            />

            <ActionButton
              id="scene-organized"
              label="Organised"
              icon="✓"
              active={!!detail.organized}
              disabled={!canEdit}
              onEnter={toggleOrganized}
            />

            <ActionButton
              id="scene-like"
              label={detail.oCounter > 0 ? `o-count ${detail.oCounter}` : 'o-count'}
              icon="💦"
              active={liked}
              disabled={!canEdit}
              title="Press for one more, hold to clear the count"
              onEnter={incrementLike}
              onLongPress={clearLike}
            />

            <ActionButton
              id="scene-clear-progress"
              label="Clear progress"
              disabled={!canEdit}
              inert={!(detail.resumeTime > 0)}
              title="Removes the resume point; watch time is kept"
              onEnter={clearProgress}
            />

            <ActionButton
              id="scene-mark-played"
              label="Mark played"
              disabled={!canEdit}
              title="Adds one play now"
              onEnter={markPlayed}
            />

            <ActionButton
              id="scene-back"
              label="Back"
              onEnter={() => onClose?.()}
            />
          </div>

          {/* Stated on screen, not left to a `title` tooltip: a TV remote has
              no pointer, and this is the only way to learn the second gesture. */}
          <p className={styles.hint}>
            <kbd>OK</kbd> choose &nbsp;·&nbsp; hold <kbd>OK</kbd> on o-count to clear it
          </p>

          {/* Transient save feedback, aria-live so a screen reader hears it. */}
          <div className={styles.notice} role="status" aria-live="polite">
            {notice}
          </div>

          {/* Below the actions on purpose: the page opens with Play focused,
              and a row above it would push the actions out of view. */}
          <RelatedScenes rows={relatedRows} onSelect={onRelatedSceneSelect} />
        </div>
      </div>
    </div>
  );
}
