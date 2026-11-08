/**
 * html5Backend, the <video> element behind the media facade.
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
  // The player's chosen rate, kept on the backend because `load()` resets the
  // element's rate to `defaultPlaybackRate`, so the value must survive a source
  // change and be reapplied every time an element is attached or opened.
  let desiredRate = 1;

  function applyRate() {
    if (!el) return;
    try {
      el.defaultPlaybackRate = desiredRate;
      el.playbackRate = desiredRate;
    } catch (e) {
      // An element can refuse a rate; the next attach/open retries.
    }
  }

  // A media element removed from the document keeps playing its audio until it
  // is paused and unloaded. React drops the <video> on unmount and on an engine
  // switch, so detaching has to stop it first.
  function stop(target) {
    if (!target) return;
    try { target.pause(); } catch (e) { /* not playing */ }
    try { target.removeAttribute('src'); target.load(); } catch (e) { /* teardown */ }
  }

  function detach() {
    const previous = el;
    el = null;
    if (previous) {
      for (const [type, handler] of handlers) {
        previous.removeEventListener(type, handler);
      }
      stop(previous);
    }
    handlers.clear();
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
    applyRate();
  }

  return {
    attach,
    detach,

    open(url) {
      if (!el || !url) return;
      el.src = url;
      el.load();
      // `load()` resets `playbackRate` to `defaultPlaybackRate`; set both again
      // so a scene change keeps the chosen speed.
      applyRate();
    },

    close() {
      stop(el);
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
    setPlaybackRate(rate) {
      const n = Number(rate);
      desiredRate = Number.isFinite(n) && n > 0 ? n : 1;
      applyRate();
      return desiredRate;
    },
    pause() {
      if (el) el.pause();
    },
    getVideoPlaybackQuality() {
      return el?.getVideoPlaybackQuality?.() ?? null;
    },
  };
}
