/**
 * OverlayGate, the Suspense and error boundaries around one lazy overlay.
 *
 * A chunk that fails to load must not reach the root boundary: that unmounts
 * the app. React.lazy caches the rejection for the module's lifetime, so a
 * retry inside this mount can only fail again; the gate reports it and closes
 * back to the page instead.
 *
 * The pending fallback is invisible but focusable, and it swallows keys while
 * the chunk loads. The page underneath is still mounted and focused, so an
 * Enter there would activate a card the overlay is about to cover. Its
 * `role="dialog"` also makes `dialogOpen()` true, so a page's own Back guard
 * yields. Back closes the pending overlay rather than raising the exit prompt.
 */

import { Component, Suspense, useEffect, useRef } from 'react';
import { isBackKey } from '../utils/input.js';
import styles from './OverlayGate.module.css';

const CLOSE_DELAY_MS = 1600; // long enough to read, short enough not to feel stuck

function Pending({ onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => {
      // Capture, and every key: nothing under the overlay may act on a press
      // meant for the screen that is loading.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (isBackKey(e)) onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className={styles.pending}
      role="dialog"
      aria-modal="true"
      aria-label="Loading"
      tabIndex={-1}
    />
  );
}

class Failed extends Component {
  constructor(props) {
    super(props);
    this.done = false;
    this.timer = null;
  }

  componentDidMount() {
    window.addEventListener('keydown', this.onKey, true);
    this.timer = setTimeout(this.close, CLOSE_DELAY_MS);
    this.node?.focus();
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
  }

  setNode = (el) => { this.node = el; };

  onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (isBackKey(e) || e.key === 'Enter' || e.key === 'Escape') this.close();
  };

  close = () => {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.props.onClose?.();
  };

  render() {
    return (
      <div
        ref={this.setNode}
        className={styles.fallback}
        role="dialog"
        aria-modal="true"
        aria-label="Could not open this screen"
        tabIndex={-1}
      >
        <p className={styles.title}>Couldn't open this screen</p>
        <p className={styles.detail}>Returning to where you were.</p>
      </div>
    );
  }
}

class Catch extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('[StashZen] overlay failed to load:', error, info?.componentStack || '');
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <Failed onClose={this.props.onClose} />;
  }
}

export default function OverlayGate({ onClose, children }) {
  return (
    <Catch onClose={onClose}>
      <Suspense fallback={<Pending onClose={onClose} />}>{children}</Suspense>
    </Catch>
  );
}
