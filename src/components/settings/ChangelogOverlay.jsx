/**
 * What's new, a nested dialog inside Settings.
 *
 * Rendered by UpdateSection, like PinPad inside AppLockSection: `role="dialog"`
 * is the focus scope the D-pad walks, and the nearest one wins, so the pane
 * cannot leak sideways into the settings body.
 *
 * The pane itself is the scroll surface. Up/Down scroll it only while it owns
 * focus, so the same keys still move the ring in the loading and error states.
 */

import { useRef } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { useBackKey } from '../../hooks/useBackKey.js';
import { useChangelog } from '../../hooks/useChangelog.js';
import { selectChangelogReleases } from '../../utils/changelog.js';
import { ActionButton } from '../tvActions.jsx';
import styles from './ChangelogOverlay.module.css';

export function ChangelogOverlay({ onClose }) {
  const { status, releases, error, reload } = useChangelog();
  const view = selectChangelogReleases(releases, __APP_VERSION__);

  const { ref: paneRef, focused } = useFocusable({
    id: 'settings-changelog-panel',
    zone: 'settings-changelog',
    autoFocus: true,
    // Up/Down are the scroll keys; sideways is the way to the Close button.
    nextId: { left: 'settings-changelog-close', right: 'settings-changelog-close' },
  });

  useBackKey(onClose);

  // The scroll keys belong to the pane only while there is notes to scroll.
  // In the loading, error and empty states they must reach the buttons.
  const lastScroll = useRef(0);
  const onKeyDown = (e) => {
    if (e.target !== paneRef.current) return;
    if (status !== 'ready') return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && Date.now() - lastScroll.current < 90) return;
    lastScroll.current = Date.now();
    paneRef.current?.scrollBy({ top: e.key === 'ArrowDown' ? 180 : -180 });
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="What's new">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.heading}>What&apos;s new</h2>
            <p className={styles.subtitle}>
              {view.mode === 'newer'
                ? `Newer than v${__APP_VERSION__}`
                : `You're on v${__APP_VERSION__}`}
            </p>
          </div>
          <ActionButton
            id="settings-changelog-close"
            label="Close"
            onClick={onClose}
            zone="settings-changelog"
          />
        </header>

        <div
          ref={paneRef}
          className={`${styles.scroll} ${focused ? styles.scrollFocused : ''}`}
          onKeyDown={onKeyDown}
          aria-label="Release notes"
        >
          {status === 'loading' && (
            <p className={styles.state} role="status">Loading release notes…</p>
          )}

          {status === 'error' && (
            <>
              <p className={styles.error} role="alert">{error}</p>
              <p className={styles.hint}>Check the connection, then try again.</p>
            </>
          )}

          {status === 'ready' && view.mode === 'none' && (
            <>
              <p className={styles.state}>
                No release notes for v{__APP_VERSION__} yet.
              </p>
              <p className={styles.hint}>
                Notes are published with each release; see GitHub Releases for
                older versions.
              </p>
            </>
          )}

          {status === 'ready' && view.releases.map(release => (
            <article key={release.version} className={styles.release}>
              <div className={styles.releaseHead}>
                <h3 className={styles.version}>v{release.version}</h3>
                {release.date && <span className={styles.date}>{release.date}</span>}
              </div>
              {release.sections.map((section, i) => (
                <section key={`${section.title}-${i}`} className={styles.section}>
                  <h4 className={styles.sectionTitle}>{section.title}</h4>
                  <ul className={styles.items}>
                    {section.items.map((item, j) => (
                      <li key={j} className={styles.item}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </article>
          ))}
        </div>

        {status === 'error' && (
          <footer className={styles.footer}>
            <ActionButton
              id="settings-changelog-retry"
              label="Try again"
              onClick={reload}
              zone="settings-changelog"
            />
          </footer>
        )}
      </div>
    </div>
  );
}
