/**
 * volumeMapping, how the player's mute button is expressed on the TV.
 *
 * Measured on this panel (Tizen 9.0): `avplay.setVolume` does not exist,
 * `disableAudioStream` is one-way (`enableAudioStream` does not restore sound),
 * and `tizen.tvaudiocontrol` works completely. Other panels may have
 * `setVolume`, and some neither. Hence a capability hierarchy:
 *
 *   tvaudio    tizen.tvaudiocontrol.setMute / isMute  (system-wide)
 *   setVolume  avplay.setVolume(0) / setVolume(saved)  (session-local)
 *   none       the button is disabled and the stats panel says so
 *
 * Each plan is a pure list of calls; the backend executes it. TV mute is
 * **system-wide**: it may show the panel's own OSD and cannot be distinguished
 * from a remote mute. So the initial TV state is read when the player opens,
 * the button reflects it, and the TV is restored only if this app changed it.
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
 * `tvaudio`, whose level belongs to the TV.
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
 * Returns calls only when this app is the one that muted. A TV already muted by
 * the remote stays muted, restoring it would override a choice made outside
 * the app, which a system-wide mute must not do.
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
