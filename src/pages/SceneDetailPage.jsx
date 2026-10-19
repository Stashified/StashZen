/**
 * SceneDetailPage — full-screen scene view with editable rating, organised,
 * like, and the two activity actions: clear progress (leaves Continue
 * Watching) and mark played (appends a play now).
 *
 * Mounted by App as an overlay rather than swapped in as a page, so the grid
 * underneath keeps its scroll position and its fetched pages: closing the
 * page is a state change, not a refetch. The overlay carries `role="dialog"`,
 * which is all useKeyHandler needs to confine the D-pad to it
 * (see `focusScopeOf`).
 *
 * The data load and the six writes live in `sceneDetail/` — see
 * `useSceneDetailData` for why the card paints first and when editing is
 * allowed, and `useSceneEdits` for the optimistic-write rules.
 *
 * The formatters and the small presentational pieces live in `sceneDetail/`.
 */

import { useFlash } from '../hooks/useFlash.js';
import { useBackKey } from '../hooks/useBackKey.js';
import styles from './SceneDetailPage.module.css';
import { fmtDuration, fmtBytes, fmtResolution, fmtDate, hostOf } from './sceneDetail/format.js';
import { useSceneDetailData } from './sceneDetail/useSceneDetailData.js';
import { useSceneEdits } from './sceneDetail/useSceneEdits.js';
import { ActionButton } from './sceneDetail/ActionButton.jsx';
import { Chips } from './sceneDetail/Chips.jsx';
import { GalleryChip } from './sceneDetail/GalleryChip.jsx';
import { MarkerChip } from './sceneDetail/MarkerChip.jsx';
import { RatingStepper } from './sceneDetail/RatingStepper.jsx';

const NOTICE_MS = 4000;
const MAX_URLS = 3;
// A scene can carry dozens of markers. Eight is enough to look like a
// timeline without turning the page's footer into a scrolling wall; the rest
// are counted, and every marker is still reachable from the Markers tab.
const MAX_MARKERS = 8;
// Galleries are a hand-off row, not a listing: four is enough to see that the
// scene belongs to one, and the +N keeps a scene with dozens bounded.
const MAX_GALLERIES = 4;

// ── Main ────────────────────────────────────────────────────
export default function SceneDetailPage({
  scene, onClose, onPlay, onPlayAt, onActivityChange, onGallerySelect,
}) {
  // Transient status line, cleared on unmount — see useFlash. Called first so
  // its unmount effect keeps the position it had before the split.
  const [notice, flash] = useFlash(NOTICE_MS);

  const { detail, setDetail, status, loadError, canEdit } = useSceneDetailData(scene);

  // Back owns this page. Capture phase, and stopPropagation, so App's global
  // handler never sees it — App's own guard is only a backstop. No text
  // inputs exist here, so Backspace is unambiguous.
  useBackKey(() => onClose?.());

  // The six writes — see useSceneEdits for the optimistic rules and the
  // in-flight tokens.
  const { setRating, toggleOrganized, incrementLike, clearLike, clearProgress, markPlayed } =
    useSceneEdits({ detail, setDetail, flash, onActivityChange });

  if (!detail) return null;

  const liked = (detail.oCounter || 0) > 0;
  const metaBits = [
    detail.studio?.name,
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
        {/* ── Left: hero ───────────────────────────────── */}
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

        {/* ── Right: everything else ───────────────────── */}
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

          {detail.performers?.length > 0 && (
            <Chips items={detail.performers} className={styles.chipsPerformers} />
          )}

          {detail.tags?.length > 0 && <Chips items={detail.tags} />}

          {/* A scene can be in a gallery. Enter leaves for the Galleries tab;
              the tab change closes this page through useDetailSelection, so
              the chip does not close it itself (see GalleryChip). */}
          {detail.galleries?.length > 0 && (
            <div className={styles.markers} role="group" aria-label="Galleries">
              <span className={styles.markersLabel}>Galleries</span>
              {detail.galleries.slice(0, MAX_GALLERIES).map(gallery => (
                <GalleryChip
                  key={gallery.id}
                  gallery={gallery}
                  onGallerySelect={onGallerySelect}
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
              {/* Stash's `bit_rate` is bits per second (4,200,000 for a 1080p
                  H.264 file), and the normalizer exposes it as `bitRate`.
                  Reading `detail.bitrate` here meant this never rendered at
                  all; dividing bps by 1000 and calling it Mb/s was wrong even
                  once it did. */}
              {detail.bitRate ? ` · ${Math.round(detail.bitRate / 1000)} kb/s` : ''}
            </div>
          )}

          {/* ── Markers ──────────────────────────────────── */}
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

          {/* ── Actions ──────────────────────────────────── */}
          <div className={styles.actions}>
            <ActionButton
              id="scene-play"
              label="Play"
              icon="▶"
              primary
              autoFocus
              // The fetched resume point travels with the press. The card
              // behind this page may be stale — a scene just played from the
              // same mounted listing still says 0 — and the player decides
              // whether to ask "resume or start over" from the queue item it
              // is handed. `detail` has the server's answer by now.
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
              disabled={!canEdit || !(detail.resumeTime > 0)}
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

          {/* Stated on screen rather than left to a tooltip: a TV remote has no
              pointer to hover with, so a `title` is a message nobody receives.
              This is the only way a user can learn that the o-count has a
              second gesture at all. */}
          <p className={styles.hint}>
            <kbd>OK</kbd> choose &nbsp;·&nbsp; hold <kbd>OK</kbd> on o-count to clear it
          </p>

          {/* Transient save feedback. aria-live so a screen reader hears the
              failure; sighted users get the same text under the buttons. */}
          <div className={styles.notice} role="status" aria-live="polite">
            {notice}
          </div>
        </div>
      </div>
    </div>
  );
}
