/**
 * PlayerQueuePanel, the player's "Up next" list.
 *
 * The queue is the listing (or marker run) the session was started from, not a
 * new fetch: what is already loaded is shown, and the player's own extension
 * keeps filling it as the cursor nears the end. Rows are the scene cards the
 * queue was seeded with, so the picture and title match the grid.
 *
 * A dialog, deliberately: `role="dialog"` makes the player's key map yield
 * (foreignDialogOpen), and this component's Back handler closes it. Its own
 * rows are the only focusables, one zone, so Up/Down walk the list and Left or
 * Right do nothing accidental.
 *
 * The row on screen cannot be removed: it is still playing. Next already means
 * "skip it", and taking it out of the array would leave the element playing a
 * scene the queue no longer names. Holding OK on any other row removes it.
 */

import { useEffect } from 'react';
import { useFocusable } from '../hooks/useFocusable.js';
import { useBackKey } from '../hooks/useBackKey.js';
import { focusByIdWhenReady } from '../utils/focus.js';
import { durationText } from './player/sceneMeta.js';
import styles from './PlayerQueuePanel.module.css';

const ZONE = 'player-queue';

function QueueRow({ item, index, current, onJump, onRemove }) {
  const { ref, focused } = useFocusable({
    id: `player-queue-${item.id}`,
    zone: ZONE,
    autoFocus: current,
    onEnter: () => onJump(index),
    // The current row has no removal: see the header.
    onLongPress: current ? undefined : () => onRemove(index),
  });

  // The list is longer than the panel. Focus has to bring its own row into
  // view, or Down walks off screen.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused, ref]);

  return (
    <button
      ref={ref}
      type="button"
      className={[
        styles.row,
        current ? styles.current : '',
        focused ? styles.focused : '',
      ].join(' ')}
      onClick={() => onJump(index)}
      aria-current={current ? 'true' : undefined}
      aria-label={`${current ? 'Now playing: ' : ''}${item.title}`}
    >
      <span className={styles.num}>{index + 1}</span>
      {item.thumbnail
        ? <img className={styles.thumb} src={item.thumbnail} alt="" />
        : <span className={styles.thumbFallback}>{item.title?.[0] || '?'}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{item.title}</span>
        <span className={styles.meta}>
          {durationText(item)}
          {current && <span className={styles.playing}>Playing</span>}
        </span>
      </span>
    </button>
  );
}

export default function PlayerQueuePanel({
  items, index, total, onJump, onRemove, onClose,
}) {
  useBackKey(() => onClose?.());

  const handleRemove = (at) => {
    // Removal unmounts the focused row. Move the cursor to the row that takes
    // its place (or the one above it at the end of the list) after the list
    // re-renders, or focus falls to <body> and the D-pad has no zone.
    const next = items[at + 1] || items[at - 1];
    onRemove(at);
    if (next) {
      setTimeout(() => focusByIdWhenReady(`player-queue-${next.id}`), 0);
    }
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Up next"
      onClick={onClose}
    >
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <header className={styles.header}>
          <h2 className={styles.heading}>Up next</h2>
          <span className={styles.count}>{index + 1} of {total}</span>
        </header>

        <div className={styles.list}>
          {items.map((item, i) => (
            <QueueRow
              key={item.id}
              item={item}
              index={i}
              current={i === index}
              onJump={onJump}
              onRemove={handleRemove}
            />
          ))}
        </div>

        <p className={styles.hint}>
          <kbd>OK</kbd> play &nbsp;·&nbsp; hold <kbd>OK</kbd> remove &nbsp;·&nbsp;
          <kbd>Back</kbd> close
        </p>
      </div>
    </div>
  );
}
