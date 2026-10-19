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
 * So this boundary renders nothing once it has caught, and asks the owner to
 * close the player. The close handler (`player.onClose`) already restores
 * focus, so "previous screen" includes the cursor.
 *
 * The close is deferred a microtask rather than called inside
 * `componentDidCatch`: that lifecycle runs while React is committing, and the
 * owner's `setState` should land after the failed commit has finished
 * unwinding. `closed` makes it exactly once even if a later render throws
 * again before the session clears. If the owner never clears the session, the
 * boundary keeps rendering null — a dead player, not a crash loop.
 *
 * `console.error` is deliberate: a TV has no other diagnostic. The message
 * prefix matches the app's logging style.
 */

import { Component } from 'react';

export default class PlayerErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.closed = false;
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
    queueMicrotask(() => {
      try {
        close();
      } catch (e) {
        console.error('[StashZen] player close failed:', e);
      }
    });
  }

  render() {
    return this.state.error ? null : this.props.children;
  }
}
