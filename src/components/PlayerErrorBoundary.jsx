/**
 * PlayerErrorBoundary — keep a player render error local.
 *
 * The app's only boundary used to be the root one in `main.jsx`, so a render
 * error inside the player unmounted the tab, the overlays and the playback
 * position together and put the recovery screen over all of it. The player is
 * the one subtree where that is clearly the wrong trade: the user asked to
 * play one file, and the right outcome is to put them back on the screen they
 * came from.
 *
 * Once it has caught, it shows a short message and then asks the owner to
 * close the player. The close handler (`player.onClose`) already restores
 * focus, so "previous screen" includes the cursor. Rendering nothing was the
 * first version of this and was wrong: the player simply vanished, and the
 * only diagnostic was `console.error`, which a TV never shows.
 *
 * The close is deferred rather than called inside `componentDidCatch`: that
 * lifecycle runs while React is committing, and the owner's `setState` should
 * land after the failed commit has finished unwinding. The delay also gives
 * the message time to be read. `closed` makes the close exactly once even if
 * a later render throws again before the session clears. If the owner never
 * clears the session, the boundary keeps its message up — a dead player, not
 * a crash loop.
 *
 * `console.error` is deliberate: a TV has no other diagnostic. The message
 * prefix matches the app's logging style.
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
    // `data-player-host` keeps this message visible while the page is in AVPlay
    // plane mode: the player that owned the attribute has just been replaced by
    // this fallback, and a shell-hidden screen would show the user nothing at
    // all. It does not turn the plane off — this is an overlay above whatever
    // the TV is still drawing, on a solid background of its own.
    return (
      <div className={styles.fallback} role="alert" data-player-host="">
        <p className={styles.title}>Playback stopped</p>
        <p className={styles.detail}>Something went wrong. See the log for details.</p>
      </div>
    );
  }
}
