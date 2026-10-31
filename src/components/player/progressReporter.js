/**
 * progressReporter, everything the player writes back to Stash, as a plain
 * object.
 *
 * This is the one subsystem that can write *wrong data* into the user's
 * library: `play_duration` is added server-side, so a double-sent delta or a
 * zero read at the wrong moment is permanent. Hence no React, DOM or module
 * state, and injected network calls; the caller keeps the page-level effects.
 *
 * The snapshot rule: `save()` captures the position and owed watch time when the
 * write is *requested*, and the sender only uses that snapshot. A queued save
 * may be sent long after the queue moved on, and re-reading live values would
 * report the next scene's position for the outgoing one.
 */

import { PLAY_CREDIT_MAX_S, PLAY_CREDIT_MIN_S } from './constants.js';

/**
 * @param {object} deps
 * @param {(input: {id: string, resumeTime: number, playDuration: number}) => Promise<{ok: boolean, error?: any}>} deps.save
 *        the sceneSaveActivity write, kept internally as `write`.
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
   * Send one already-captured snapshot, then drain whatever queued behind it.
   * Recursive rather than a loop: a queued snapshot re-enters the sender when
   * the write in flight settles, which holds "one write at a time" without a
   * scheduler.
   */
  function sendSnapshot(snapshot) {
    saveInFlight = true;
    report('saving');

    const settle = (res) => {
      saveInFlight = false;
      // A save that resolves to nothing is a failure, not a success: without
      // this the next line throws and the queue never drains.
      if (!res) res = { ok: false, error: new Error('The save returned no result.') };

      // The prune names the scene the snapshot describes, so it must not wait
      // for that scene to still be on screen: a queue advance or close happens
      // before the write lands. The App owning the shelf outlives the player and
      // the set is idempotent, so no component is needed. Only a *landed* save
      // proves Stash took the position, hence the success check.
      if (res.ok && snapshot.completed) onCompleted?.(snapshot.id);

      if (mounted) {
        if (res.ok) {
          syncError = null;
          onSync('saved');
          // Only while this is still the scene the values describe: a late
          // success would stamp the old position over the new scene's
          // `lastSaved` and drain watch time it has begun accruing.
          if (sceneId === snapshot.id) {
            lastSaved = snapshot.t;
            // Decremented, not zeroed: time counted after this snapshot was
            // captured is still owed and would otherwise be discarded.
            played = Math.max(0, played - snapshot.played);
          }
        } else {
          // Deliberately not clearing played or lastSaved: the watch time stays
          // owed and the position is retried with the next attempt.
          syncError = res.error;
          onSync('failed');
        }
      }

      // The queued write for this scene carried the same watch time this one
      // sent (`played` shrinks only after a success), so strip what landed or
      // it is counted twice. A failed send leaves the queued amount whole.
      const sameScene = queuedSaves.get(snapshot.id);
      if (sameScene) {
        queuedSaves.delete(snapshot.id);
        sendSnapshot({
          ...sameScene,
          played: res.ok ? Math.max(0, sameScene.played - snapshot.played) : sameScene.played,
        });
        return;
      }
      // Otherwise the oldest entry, whatever scene it belongs to: the Map
      // preserves the order the exits happened in.
      const next = queuedSaves.entries().next();
      if (!next.done) {
        queuedSaves.delete(next.value[0]);
        sendSnapshot(next.value[1]);
      }
    };

    // A rejected write must not wedge the sender: route it through the same
    // failure path so the chip reports it and queued snapshots still drain.
    // The async IIFE also turns a synchronous throw by an injected save into
    // a rejection.
    (async () => write({
      id: snapshot.id,
      resumeTime: snapshot.t,
      playDuration: snapshot.played,
    }))().then(settle, (error) => settle({ ok: false, error }));
  }

  /**
   * Report the current scene. The id is passed in because the teardown must
   * name the *outgoing* scene even though the queue has moved on.
   */
  function saveScene(id) {
    if (!id) return;
    const t = completed ? 0 : lastTime;
    const owed = played;
    // Nothing to report: neither the position nor the watch time moved. Both
    // halves matter, without the second, a scene watched to a standstill would
    // stop saving its play_duration. After a completion save `lastSaved` is 0,
    // so the following teardown is a no-op rather than a second end write.
    if (Math.abs(t - lastSaved) < 2 && owed < PLAY_CREDIT_MIN_S) return;

    const snapshot = { id, t, played: owed, completed };
    if (saveInFlight) {
      // Latest wins: a pause, an `ended` and a teardown can all land inside one
      // 30 s request, and the last carries the most truthful position.
      queuedSaves.set(id, snapshot);
      return;
    }
    sendSnapshot(snapshot);
  }

  return {
    /** Which scene the value callbacks should stamp. */
    setScene(id) { sceneId = id ?? null; },

    /**
     * The per-scene reset: the clock values belong to the outgoing scene, and
     * carrying them over would report its position for the incoming one.
     */
    resetScene() {
      lastTime = 0;
      lastSaved = 0;
      // Watch time is per scene too: carrying it over would add the outgoing
      // scene's minutes to the incoming play_duration, and Stash *adds* that
      // field to a running total, so the error would be permanent.
      played = 0;
      lastTick = 0;
      completed = false;
    },

    /**
     * One `timeupdate`. The caller has dropped ticks from a stale source; the
     * credit rule here separates playback from seeks.
     */
    tick(t, paused) {
      // Credit only what the clock advanced by itself: a skim, marker jump or
      // resume seek is one oversized step and is ignored (see
      // PLAY_CREDIT_MAX_S). Backwards steps fall out of `delta > 0`.
      const delta = t - lastTick;
      if (!paused && delta > 0 && delta <= PLAY_CREDIT_MAX_S) played += delta;
      lastTick = t;
      lastTime = t;
    },

    /**
     * A seek that took. The clock values record where the *element* actually
     * is, so the caller moves them only on success: a non-seekable stream must
     * not be given a position the element never reached.
     */
    seek(t) {
      lastTick = t;
      lastTime = t;
    },

    /** Where the playhead is believed to be, read by the fallback seek. */
    position() { return lastTime; },

    complete() { completed = true; },
    reopen() { completed = false; },

    /**
     * The play counter, once per scene per player session. `playing` also fires
     * after every buffer stall, so the latch is load-bearing; `play` would be
     * worse, firing on every resume. `playing` and not mount, because mounting
     * says nothing about whether the file was watchable.
     *
     * A set of ids, not one remembered id: a revisited scene must not count
     * twice.
     */
    countPlay(id) {
      if (!id || countedPlay.has(id)) return;
      countedPlay.add(id);
      addPlay(id).then((res) => {
        if (res.ok || !mounted) return;
        // Reported through the same chip as a failed save: both mean "this app
        // is not reaching Stash", and the user needs one place to look.
        syncError = res.error;
        onSync('failed');
      });
    },

    save: saveScene,

    /** A read failed too, same chip, same reason (see countPlay). */
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
