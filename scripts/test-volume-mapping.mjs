#!/usr/bin/env node
/**
 * test-volume-mapping.mjs — the mute button on three kinds of panel
 *
 *   node scripts/test-volume-mapping.mjs
 *
 * Measured facts this pins down: this panel has no `avplay.setVolume` and a
 * working `tizen.tvaudiocontrol`; some panels have the reverse; some have
 * neither. TV mute is system-wide, so a mute the app did not create must be
 * left alone — restoring it on close would undo a choice made with the remote.
 *
 * No framework.
 */

import {
  MUTE_CAPABILITIES,
  detectMuteCapability,
  mapMute,
  mapMuteRestore,
  clampLevel,
} from '../src/utils/volumeMapping.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tv = { setMute() {}, isMute() { return false; }, getVolume() { return 13; } };
const playerWithVolume = { setVolume() {} };
const playerWithoutVolume = { open() {}, close() {} };

// ── Capability detection ───────────────────────────────────
check('capabilities are ordered', eq(MUTE_CAPABILITIES, ['tvaudio', 'setVolume', 'none']));
check('tvaudio wins when both exist',
  detectMuteCapability({ tvaudiocontrol: tv, avplay: playerWithVolume }) === 'tvaudio');
check('setVolume is the second rung',
  detectMuteCapability({ avplay: playerWithVolume }) === 'setVolume');
check('no volume method means none',
  detectMuteCapability({ tvaudiocontrol: tv, avplay: playerWithoutVolume }) === 'tvaudio');
check('neither means none',
  detectMuteCapability({ avplay: playerWithoutVolume }) === 'none');
check('half a tvaudio API is not enough',
  detectMuteCapability({ tvaudiocontrol: { setMute() {} } }) === 'none');
check('empty call is none', detectMuteCapability({}) === 'none');

// ── Muting ─────────────────────────────────────────────────
{
  const m = mapMute({ capability: 'tvaudio', muted: true, level: 40 });
  check('tvaudio mute calls setMute(true)', eq(m.calls, [
    { target: 'tvaudiocontrol', method: 'setMute', args: [true] },
  ]));
  check('tvaudio mute does not touch the TV level', m.level === undefined);
  check('tvaudio mute is effective', m.effective === true);

  const u = mapMute({ capability: 'tvaudio', muted: false, level: 40 });
  check('tvaudio unmute calls setMute(false)',
    eq(u.calls, [{ target: 'tvaudiocontrol', method: 'setMute', args: [false] }]));
}
{
  const m = mapMute({ capability: 'setVolume', muted: true, level: 55 });
  check('setVolume mute calls volume 0',
    eq(m.calls, [{ target: 'avplay', method: 'setVolume', args: [0] }]));
  const u = mapMute({ capability: 'setVolume', muted: false, level: 55 });
  check('setVolume unmute restores the remembered level',
    eq(u.calls, [{ target: 'avplay', method: 'setVolume', args: [55] }]));
  check('the mapped level is recorded', u.level === 55);
}
{
  const m = mapMute({ capability: 'setVolume', muted: false, level: 150 });
  check('levels are clamped to 100', m.calls[0].args[0] === 100);
  const z = mapMute({ capability: 'setVolume', muted: false, level: -3 });
  check('levels are clamped to 0', z.calls[0].args[0] === 0);
}
{
  const m = mapMute({ capability: 'none', muted: true });
  check('an unsupported panel returns no calls', eq(m.calls, []));
  check('and reports the mute as ineffective', m.effective === false);
}

// ── Restoring on close ─────────────────────────────────────
{
  const r = mapMuteRestore({ capability: 'tvaudio', appMuted: true, initialMuted: false });
  check('restores a TV the app muted',
    eq(r.calls, [{ target: 'tvaudiocontrol', method: 'setMute', args: [false] }]));

  const keep = mapMuteRestore({ capability: 'tvaudio', appMuted: false, initialMuted: true });
  check('a TV muted by the remote is left alone', eq(keep.calls, []));

  const preset = mapMuteRestore({ capability: 'tvaudio', appMuted: true, initialMuted: true });
  check('muting an already-muted TV restores it muted',
    eq(preset.calls, [{ target: 'tvaudiocontrol', method: 'setMute', args: [true] }]));
}
{
  const r = mapMuteRestore({ capability: 'setVolume', appMuted: true, initialLevel: 13 });
  check('setVolume restores its initial level',
    eq(r.calls, [{ target: 'avplay', method: 'setVolume', args: [13] }]));
  const clamped = mapMuteRestore({ capability: 'setVolume', appMuted: true, initialLevel: 130 });
  check('setVolume restores a clamped level', clamped.calls[0].args[0] === 100);
  check('a panel with no mute has nothing to restore',
    eq(mapMuteRestore({ capability: 'none', appMuted: true }).calls, []));
}

check('clampLevel rounds', clampLevel(33.6) === 34);
check('clampLevel tolerates nonsense', clampLevel('loud') === 100);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
