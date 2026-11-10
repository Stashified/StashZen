/**
 * RemoteHelpOverlay, the remote's cheat sheet, a nested dialog inside Settings.
 *
 * Static content, so it needs no request and no cache: the keys are fixed by
 * the build it ships in. The pane is the one focusable stop, like the changelog
 * viewer; Up/Down scroll it only while it owns focus.
 */

import { useRef } from 'react';
import { useFocusable } from '../../hooks/useFocusable.js';
import { useBackKey } from '../../hooks/useBackKey.js';
import { ActionButton } from '../tvActions.jsx';
import styles from './RemoteHelpOverlay.module.css';

const SECTIONS = [
  {
    title: 'Moving around',
    rows: [
      ['D-pad', 'Move the focus ring. Left from a card returns to the rail.'],
      ['OK', 'Open the focused card or press the focused control.'],
      ['Back', 'Leave the screen, close a menu, or dismiss the topmost overlay.'],
      ['Up / Down on the rail', 'Change section. OK on the current tab reloads it.'],
    ],
  },
  {
    title: 'Card menu',
    rows: [
      ['Hold OK on a card', 'Open its actions without leaving the listing.'],
      ['Scene cards', 'Play, Play all, Play from here, Mark played, Add O, Clear resume, Mark organised and Details. Clear resume appears only when the scene has progress.'],
      ['Other cards', 'Images, galleries, tags, studios and groups have their own entries, such as slideshow and Info.'],
    ],
  },
  {
    title: 'Player',
    rows: [
      ['OK', 'Show the controls. Back puts them away.'],
      ['Left / Right', 'Seek by the step chosen in Settings. Hold to keep scrubbing.'],
      ['Play / Pause', 'Play or pause, wherever the focus is.'],
      ['Up / Down', 'With the controls hidden, jump to the previous or next scene. With the seek bar up, Down returns to the buttons and Up jumps to the previous scene.'],
      ['Back', 'Hide the controls, then close the player.'],
    ],
  },
  {
    title: 'Image viewer',
    rows: [
      ['Left / Right', 'Previous or next image. While zoomed, pan instead.'],
      ['OK', 'Zoom 2x and 3x, then back to full size.'],
      ['Up', 'Reach Info, then OK opens the image details.'],
      ['Back', 'Close the info panel, then reset the zoom, then the viewer.'],
    ],
  },
  {
    title: 'Typing',
    rows: [
      ['OK on a text field', 'Open the on-screen keyboard.'],
      ['Done / OK', 'Accept the text and close the keyboard.'],
    ],
  },
];

export function RemoteHelpOverlay({ onClose }) {
  const { ref: paneRef, focused } = useFocusable({
    id: 'settings-help-panel',
    zone: 'settings-help',
    autoFocus: true,
    // Close sits above the pane, so Up leaves for it at the top. Sideways and
    // Down stay put; a self-reference blocks those edges.
    nextId: {
      up: 'settings-help-close',
      left: 'settings-help-panel',
      right: 'settings-help-panel',
      down: 'settings-help-panel',
    },
  });

  useBackKey(onClose);

  // Up/Down scroll only while the pane can move that way; at an edge the key
  // is left to the focus handler, so Up reaches Close.
  const lastScroll = useRef(0);
  const onKeyDown = (e) => {
    const pane = paneRef.current;
    if (!pane || e.target !== pane) return;
    if (e.key === 'ArrowUp') {
      if (pane.scrollTop <= 0) return;
    } else if (e.key === 'ArrowDown') {
      if (pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 1) return;
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && Date.now() - lastScroll.current < 90) return;
    lastScroll.current = Date.now();
    pane.scrollBy({ top: e.key === 'ArrowDown' ? 180 : -180 });
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Remote help">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.heading}>Remote help</h2>
            <p className={styles.subtitle}>Every key, without the README.</p>
          </div>
          <ActionButton
            id="settings-help-close"
            label="Close"
            onClick={onClose}
            zone="settings-help"
          />
        </header>

        <div
          ref={paneRef}
          className={`${styles.scroll} ${focused ? styles.scrollFocused : ''}`}
          onKeyDown={onKeyDown}
          role="group"
          aria-label="Remote help"
        >
          {SECTIONS.map(section => (
            <section key={section.title} className={styles.section}>
              <h3 className={styles.sectionTitle}>{section.title}</h3>
              <dl className={styles.rows}>
                {section.rows.map(([key, action]) => (
                  <div key={key} className={styles.row}>
                    <dt className={styles.key}>{key}</dt>
                    <dd className={styles.action}>{action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
