/**
 * PlayerErrorBoundary, keep a player render error local.
 *
 * The root boundary would unmount the tab, overlays and playback position
 * together. The player is the one subtree where that is the wrong trade: the
 * user asked to play one file, so put them back on the previous screen.
 *
 * The panel is a dialog that owns the keys while it is up. Without that, the
 * grid behind stayed live and Back raised the exit prompt *over* it.
 * `data-player-host` keeps it visible in AVPlay plane mode.
 */

import { Component } from 'react';
import { isBackCode } from '../utils/input.js';
import styles from './PlayerErrorBoundary.module.css';

const CLOSE_DELAY_MS = 1600; // long enough to read, short enough not to feel stuck

export default class PlayerErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.done = false;
    this.closeTimer = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[StashZen] player render error:', error, info?.componentStack || '');
    if (this.closeTimer != null || this.done) return;
    this.closeTimer = setTimeout(this.finish, CLOSE_DELAY_MS);
  }

  componentDidUpdate(prevProps, prevState) {
    if (!this.state.error || prevState.error) return;
    window.addEventListener('keydown', this.onKey, true);
    this.node?.focus();
  }

  componentWillUnmount() {
    clearTimeout(this.closeTimer);
    window.removeEventListener('keydown', this.onKey, true);
  }

  setNode = (el) => { this.node = el; };

  // Capture, so the panel closes before the app's Back handler can raise the
  // exit prompt over it.
  onKey = (e) => {
    const isOk = e.key === 'Enter' || e.keyCode === 13;
    if (!isOk && e.key !== 'Escape' && !isBackCode(e.keyCode)) return;
    e.preventDefault();
    e.stopPropagation();
    this.finish();
  };

  finish = () => {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.closeTimer);
    window.removeEventListener('keydown', this.onKey, true);
    try {
      this.props.onClose?.();
    } catch (e) {
      console.error('[StashZen] player close failed:', e);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        ref={this.setNode}
        className={styles.fallback}
        role="dialog"
        aria-modal="true"
        aria-label="Playback stopped"
        tabIndex={-1}
        data-player-host=""
      >
        <p className={styles.title}>Playback stopped</p>
        <p className={styles.detail}>Something went wrong. See the log for details.</p>
      </div>
    );
  }
}
