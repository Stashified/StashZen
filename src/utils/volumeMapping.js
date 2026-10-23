/**
 * volumeMapping — how the player's mute button is expressed on the TV.
 *
 * Measured on this panel (Phase 0, Tizen 9.0): `avplay.setVolume` does not
 * exist, `disableAudioStream` is one-way (it silences, and `enableAudioStream`
 * does not bring sound back), and `tizen.tvaudiocontrol` works completely.
 * On other panels `setVolume` may exist, and on some neither will. Hence a
 * capability hierarchy rather than one call:
 *
 *   tvaudio    tizen.tvaudiocontrol.setMute / isMute  (system-wide)
 *   setVolume  avplay.setVolume(0) / setVolume(saved)  (session-local)
 *   none       the button is disabled and the stats panel says so
 *
 * The plan for each capability is a pure list of calls; the backend executes
 * it. TV mute is **system-wide**: it may show the panel's own mute OSD and it
 * cannot be distinguished from a mute the user made with the remote. So the
 * initial TV state is read when the player opens, the button reflects it, and
 * the TV is restored only if this app was the one that changed it.
 */

export const MUTE_CAPABILITIES = ['tvaudio', 'setVolume', 'none'];

const clampLevel = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(100, Math.round(v)));
};

/**
 * Which mute implementation is available. `avplay` is the live player object
 * (or any object with the same surface), `tvaudiocontrol` is
 * `tizen.tvaudiocontrol`.
 */
export function detectMuteCapability({ tvaudiocontrol, avplay } = {}) {
  if (tvaudiocontrol
      && typeof tvaudiocontrol.setMute === 'function'
      && typeof tvaudiocontrol.isMute === 'function') {
    return 'tvaudio';
  }
  if (avplay && typeof avplay.setVolume === 'function') return 'setVolume';
  return 'none';
}

/**
 * The calls needed to reach `muted`. `effective: false` means the request
 * cannot be honoured and the UI must disable the control rather than claim a
 * mute that is not happening.
 *
 * `level` is the remembered unmuted level for `setVolume`; ignored for
 * `tvaudio`, whose level belongs to the TV and is not ours to change.
 */
export function mapMute({ capability, muted, level = 100 }) {
  if (capability === 'tvaudio') {
    return {
      effective: true,
      muted: !!muted,
      calls: [{ target: 'tvaudiocontrol', method: 'setMute', args: [!!muted] }],
    };
  }
  if (capability === 'setVolume') {
    const vol = muted ? 0 : clampLevel(level);
    return {
      effective: true,
      muted: !!muted,
      level: vol,
      calls: [{ target: 'avplay', method: 'setVolume', args: [vol] }],
    };
  }
  return { effective: false, muted: !!muted, calls: [] };
}

/**
 * What to do when the player closes, falls back, hides or is torn down.
 *
 * Returns calls only when this app is the one that muted. A TV already muted
 * by the remote stays muted — restoring it to "unmuted" would override a
 * choice the user made outside the app, which is the one thing a system-wide
 * mute must not do.
 */
export function mapMuteRestore({ capability, appMuted, initialMuted, initialLevel = 100 }) {
  if (!appMuted) return { calls: [] };
  if (capability === 'tvaudio') {
    return { calls: [{ target: 'tvaudiocontrol', method: 'setMute', args: [!!initialMuted] }] };
  }
  if (capability === 'setVolume') {
    return { calls: [{ target: 'avplay', method: 'setVolume', args: [clampLevel(initialLevel)] }] };
  }
  return { calls: [] };
}

export { clampLevel };
