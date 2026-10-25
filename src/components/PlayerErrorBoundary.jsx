/**
 * PlayerErrorBoundary — keep a player render error local.
 *
 * The root boundary would unmount the tab, overlays and playback position
 * together. The player is the one subtree where that is the wrong trade: the
 * user asked to play one file, so put them back on the previous screen.
 *
 * It shows a short message, then asks the owner to close the player; the close
 * handler already restores focus. Rendering nothing (the first version) made
 * the player simply vanish with only `console.error` as a diagnostic.
 *
 * The close is deferred rather than called in `componentDidCatch`, which runs
 * mid-commit — the owner's `setState` should land after the failed commit
 * unwinds, and the delay lets the message be read. `closed` makes it exactly
 * once. If the owner never clears the session the message stays up: a dead
 * player, not a crash loop.
 */

import { Component } from 'react';
import styles from './PlayerErrorBoundary.module.css';

// Long enough to read, short enough not to feel stuck.
const CLOSE_DELAY_MS = 1600;

export default class PlayerErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.closed = false;
    this.closeTimer = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[StashZen] player render error:', error, info?.componentStack || '');
    if (this.closed) return;
    this.closed = true;
    const close = this.props.onClose;
    if (!close) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      try {
        close();
      } catch (e) {
        console.error('[StashZen] player close failed:', e);
      }
    }, CLOSE_DELAY_MS);
  }

  componentWillUnmount() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // `data-player-host` keeps this visible in AVPlay plane mode: the player
    // that owned the attribute is gone, and a shell-hidden screen would show
    // nothing. It does not turn the plane off — this is an overlay on its own
    // solid background.
    return (
      <div className={styles.fallback} role="alert" data-player-host="">
        <p className={styles.title}>Playback stopped</p>
        <p className={styles.detail}>Something went wrong. See the log for details.</p>
      </div>
    );
  }
}
