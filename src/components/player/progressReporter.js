/**
 * progressReporter — everything the player writes back to Stash, as a plain
 * object.
 *
 * This is the one subsystem in the app that can write *wrong data* into the
 * user's library: `play_duration` is added server-side, so a double-sent delta
 * or a zero read at the wrong moment is permanent. It is therefore separated
 * from React entirely — no hooks, no DOM, no module state — and the two
 * network calls are injected. The caller keeps the effects that are about the
 * page rather than the element (visibility, pagehide, the periodic save and
 * the teardown) and feeds this object the timeline events.
 *
 * The snapshot rule: `save()` captures the position and the owed watch time at
 * the moment the write is *requested*, and the sender only ever uses that
 * snapshot. A queued save may be sent long after the queue has moved on, and
 * re-reading the live values then would report the next scene's position (or
 * a drained `played`) for the outgoing one.
 */

import { PLAY_CREDIT_MAX_S, PLAY_CREDIT_MIN_S } from './constants.js';

/**
 * @param {object} deps
 * @param {(input: {id: string, resumeTime: number, playDuration: number}) => Promise<{ok: boolean, error?: any}>} deps.save
 *        the sceneSaveActivity write. Named to match the method below; the
 *        factory keeps the injected function as `write`.
 * @param {(id: string) => Promise<{ok: boolean, error?: any}>} deps.addPlay
 * @param {(state: 'saving'|'saved'|'failed') => void} deps.onSync
 *        every call is already guarded by the mounted latch.
 * @param {(id: string) => void} [deps.onCompleted]
 *        a completion save has landed, so the shelf may prune the card.
 */
export function createProgressReporter({
  save,
  addPlay,
  onSync,
  onCompleted,
}) {
  const write = save;

  let lastTime = 0;
  let lastSaved = 0;
  let sceneId = null;
  let played = 0;
  let lastTick = 0;
  const countedPlay = new Set();
  let saveInFlight = false;
  const queuedSaves = new Map();
  let syncError = null;
  let mounted = true;
  let completed = false;

  const report = (state) => {
    if (mounted) onSync(state);
  };

  /**
   * Send one already-captured snapshot, and drain whatever queued behind it.
   *
   * Kept recursive rather than a loop: a queued snapshot re-enters the sender
   * when the write in flight settles, which is what makes "one write at a
   * time" hold without a scheduler.
   */
  function sendSnapshot(snapshot) {
    saveInFlight = true;
    report('saving');

    write({
      id: snapshot.id,
      resumeTime: snapshot.t,
      playDuration: snapshot.played,
    }).then((res) => {
      saveInFlight = false;

      if (mounted) {
        if (res.ok) {
          syncError = null;
          onSync('saved');
          // Only while this is still the scene the values describe. Otherwise
          // a late success would stamp the old position over the new scene's
          // `lastSaved` (skipping its first save) and drain watch time it has
          // already begun accruing.
          if (sceneId === snapshot.id) {
            lastSaved = snapshot.t;
            // Decremented, not zeroed: any time counted after this snapshot
            // was captured is still owed and, under the old zeroing, was
            // discarded on every save that landed while playback continued.
            played = Math.max(0, played - snapshot.played);
            // Only after the server took it: the shelf prune is a local
            // claim, and pruning a card whose resume point Stash still holds
            // would hide the scene until the tab remounts.
            if (snapshot.completed) onCompleted?.(snapshot.id);
          }
        } else {
          // Deliberately not clearing played: the watch time stays owed, and
          // the next attempt carries it. Likewise lastSaved, so the position
          // is retried too.
          syncError = res.error;
          onSync('failed');
        }
      }

      // The queued write for this scene carried the same watch time this one
      // just sent — `played` is only reduced after a success — so strip what
      // has now landed or the delta is counted twice. A failed send leaves the
      // queued amount whole.
      const sameScene = queuedSaves.get(snapshot.id);
      if (sameScene) {
        queuedSaves.delete(snapshot.id);
        sendSnapshot({
          ...sameScene,
          played: res.ok ? Math.max(0, sameScene.played - snapshot.played) : sameScene.played,
        });
        return;
      }
      // Otherwise the oldest entry, whatever scene it belongs to: ordering
      // between scenes is the order the exits happened in, which is what the
      // Map preserves.
      const next = queuedSaves.entries().next();
      if (!next.done) {
        queuedSaves.delete(next.value[0]);
        sendSnapshot(next.value[1]);
      }
    });
  }

  /**
   * Report the current scene. The id is passed in rather than read from the
   * latch: every caller closes over the scene it belongs to, and the teardown
   * needs to name the *outgoing* scene even though the queue has moved on.
   */
  function saveScene(id) {
    if (!id) return;
    const t = completed ? 0 : lastTime;
    const owed = played;
    // Nothing to report: the position has not moved and no watch time
    // accrued. Both halves matter — without the second, a scene watched to a
    // standstill would stop saving its play_duration. After a completion save
    // lands, `lastSaved` is 0, so the teardown that follows is a no-op rather
    // than a second write of the end position.
    if (Math.abs(t - lastSaved) < 2 && owed < PLAY_CREDIT_MIN_S) return;

    const snapshot = { id, t, played: owed, completed };
    if (saveInFlight) {
      // Latest wins. A pause, an `ended` and a teardown can all land inside
      // one 30 s request, and the last of them carries the most truthful
      // position for that scene.
      queuedSaves.set(id, snapshot);
      return;
    }
    sendSnapshot(snapshot);
  }

  return {
    /** Which scene the value callbacks should stamp. */
    setScene(id) { sceneId = id ?? null; },

    /**
     * The per-scene reset. The clock values belong to the scene that was on
     * screen a moment ago; carrying them over would report the outgoing
     * scene's position for the incoming one.
     */
    resetScene() {
      lastTime = 0;
      lastSaved = 0;
      // Watch time is per scene too, and for a sharper reason: carrying it
      // over would add the outgoing scene's minutes to the incoming scene's
      // play_duration, and Stash adds that field to a running total rather
      // than replacing it, so the error would be permanent.
      played = 0;
      lastTick = 0;
      completed = false;
    },

    /**
     * One `timeupdate`. The caller has already dropped ticks that belong to a
     * stale source (`sourceFresh`); the credit rule here is what separates
     * playback from seeks.
     */
    tick(t, paused) {
      // Credit only what the clock advanced by itself — see
      // PLAY_CREDIT_MAX_S. A skim of ±15s, a marker jump and the resume seek
      // all arrive here as one oversized step and are ignored; everything in
      // between is playback. Backwards steps fall out of the `delta > 0` test.
      const delta = t - lastTick;
      if (!paused && delta > 0 && delta <= PLAY_CREDIT_MAX_S) played += delta;
      lastTick = t;
      lastTime = t;
    },

    /**
     * A seek that took. The clock values record where the *element* actually
     * is, so the caller moves them only when the seek succeeded; a
     * non-seekable stream must not have a position written for it that the
     * element never reached.
     */
    seek(t) {
      lastTick = t;
      lastTime = t;
    },

    /** Where the playhead is believed to be — read by the fallback seek. */
    position() { return lastTime; },

    complete() { completed = true; },
    reopen() { completed = false; },

    /**
     * The play counter, once per scene per player session. `playing` also
     * fires again after every buffer stall, so the latch is load-bearing
     * rather than tidy, and `play` would be worse still since it fires on
     * every resume from a pause.
     *
     * `playing` and not mount: mounting says nothing about whether the file
     * was watchable, and a scene that 404s should not count as watched.
     *
     * A set of ids rather than one remembered id: the player can revisit a
     * scene it already showed in this session, and a one-slot latch would
     * count that scene twice.
     */
    countPlay(id) {
      if (!id || countedPlay.has(id)) return;
      countedPlay.add(id);
      addPlay(id).then((res) => {
        if (res.ok || !mounted) return;
        // A failed play count is reported through the same chip as a failed
        // save: both mean "this app is not reaching Stash", and the user needs
        // one place to look, not two.
        syncError = res.error;
        onSync('failed');
      });
    },

    save: saveScene,

    /** A read failed too — same chip, same reason (see countPlay). */
    reportError(error) {
      if (!mounted) return;
      syncError = error;
      onSync('failed');
    },

    /** The message the chip renders; null when the last write landed. */
    syncError() { return syncError; },

    /** Re-arm the latch (StrictMode mounts effects twice). */
    mount() { mounted = true; },
    dispose() { mounted = false; },
  };
}
