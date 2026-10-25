/**
 * html5Backend — the <video> element behind the media facade.
 *
 * Deliberately thin: it owns the element attachment and the re-dispatch of a
 * fixed set of events, delegating every property. Policy (stall watches, seeks,
 * mute capability) belongs to the player or the other backend.
 *
 * Events are re-dispatched so `e.target` is the facade, which `usePlayerMedia`
 * guards on: that guard is what keeps a poster-subresource error from painting
 * a failure over a healthy scene.
 */

import { MEDIA_EVENTS, emptyTimeRanges } from './contracts.js';

export function createHtml5Backend({ emit }) {
  let el = null;
  const handlers = new Map();

  function detach() {
    if (el) {
      for (const [type, handler] of handlers) {
        el.removeEventListener(type, handler);
      }
    }
    handlers.clear();
    el = null;
  }

  function attach(next) {
    if (!next || next === el) return;
    detach();
    el = next;
    for (const type of MEDIA_EVENTS) {
      const handler = () => emit(type);
      handlers.set(type, handler);
      el.addEventListener(type, handler);
    }
  }

  return {
    attach,
    detach,

    open(url) {
      if (!el || !url) return;
      el.src = url;
      el.load();
    },

    close() {
      if (!el) return;
      try { el.pause(); } catch (e) { /* no source */ }
      try { el.removeAttribute('src'); el.load(); } catch (e) { /* teardown */ }
    },

    get paused() { return el ? el.paused : true; },
    get seeking() { return el ? el.seeking : false; },
    // NaN, not 0: the player and the timeline both read `Number.isFinite`.
    get duration() { return el ? el.duration : NaN; },
    get currentTime() { return el ? el.currentTime : 0; },
    set currentTime(seconds) {
      if (!el) return;
      el.currentTime = seconds;
    },
    get readyState() { return el ? el.readyState : 0; },
    get networkState() { return el ? el.networkState : 0; },
    get muted() { return el ? el.muted : false; },
    set muted(value) { if (el) el.muted = value; },
    get volume() { return el ? el.volume : 1; },
    set volume(value) { if (el) el.volume = value; },
    get playbackRate() { return el ? el.playbackRate : 1; },
    get error() { return el ? el.error : null; },
    get buffered() { return el ? el.buffered : emptyTimeRanges(); },
    get seekable() { return el ? el.seekable : emptyTimeRanges(); },
    get videoWidth() { return el ? el.videoWidth : 0; },
    get videoHeight() { return el ? el.videoHeight : 0; },
    get webkitDecodedFrameCount() { return el ? el.webkitDecodedFrameCount : undefined; },
    get webkitDroppedFrameCount() { return el ? el.webkitDroppedFrameCount : undefined; },

    play() {
      if (!el) return Promise.resolve();
      return el.play();
    },
    pause() {
      if (el) el.pause();
    },
    getVideoPlaybackQuality() {
      return el?.getVideoPlaybackQuality?.() ?? null;
    },
  };
}
