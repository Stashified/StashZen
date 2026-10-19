/**
 * appLock.js — Optional PIN gate for the whole app
 *
 * Stores a salted SHA-256 of a 4-digit PIN under its own localStorage key.
 *
 * Why a SEPARATE key rather than a field in settings.js:
 *   1. `persistToStorage()` in settings.js writes an explicit whitelist of
 *      three fields, so a new settings field would silently never persist.
 *   2. `clearSettings()` wipes `tvapp.settings.v1` wholesale, and the
 *      panel's "Clear saved" is a destructive two-step action aimed at the
 *      *connection config*. Wiring the lock in there would mean that button
 *      silently removed the user's PIN. A separate key makes that
 *      impossible by construction, with no guard in the Clear path.
 *
 * Threat model — be honest about it. A 4-digit PIN is 10⁴ combinations, so
 * anyone who can read localStorage can recover it offline almost instantly.
 * The digest is not a defence against that; it only keeps the PIN from
 * sitting in storage in plaintext.
 *
 * The Stash API key stored beside it is NOT held to that standard and must
 * not be described as if it were: settings.js writes it unencrypted. Anyone
 * who can read this app's storage gets the key whether or not a PIN is set.
 * See the README's Security notes. The PIN deters someone picking up the
 * remote; it is not encryption and not protection from anyone with the
 * installer.
 *
 * No iteration stretching (PBKDF2) on purpose: it would cost unlock latency
 * on a TV CPU and buy nothing against a 10⁴ keyspace. Against the on-device
 * attacker, the cheap defence that does work is `attemptPin()`'s escalating
 * delay below — it makes pressing the D-pad 10⁴ times impractical.
 *
 * FAIL OPEN: if storage is unreadable or the blob is corrupt, `isLockSet()`
 * reports false and the app opens. A corrupt blob must never be able to
 * brick the app into a state the user cannot unlock.
 */

import { useEffect, useState } from 'react';
import { sha256Hex } from './sha256.js';

const LS_KEY = 'tvapp.lock.v1';

/** Digits required. Shared with the keypad and the settings section. */
export const PIN_LENGTH = 4;

const PIN_RE = /^\d{4}$/;

// ── In-memory state ──────────────────────────────────────
let state = loadFromStorage();   // { v, salt, hash } | null

// Wrong-PIN backoff. Deliberately in memory, not storage: relaunching the
// app to clear the delay is itself the "force quit and try again" the lock
// exists to make inconvenient, and a persisted timestamp can brick an
// unlocked device after a clock change. Losing the counter on restart is the
// fail-open behaviour the rest of this module already promises.
//
// Indexed by consecutive failures: the first three misses are free (typing
// the wrong PIN by accident is common on a numeric pad), then 1s, 5s and
// finally 30s per miss. 10⁴ tries at 30s is about 3.5 days.
const FAIL_DELAYS_MS = [0, 0, 0, 1000, 1000, 5000, 5000, 5000, 30000];

let failures = 0;
let blockedUntil = 0;

function resetBackoff() {
  failures = 0;
  blockedUntil = 0;
}

function loadFromStorage() {
  let blob;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    blob = JSON.parse(raw);
  } catch (e) {
    // Corrupt JSON, or storage unavailable — fail open (see header).
    return null;
  }

  if (!blob || typeof blob !== 'object') return null;
  if (typeof blob.salt !== 'string' || !blob.salt) return null;
  if (typeof blob.hash !== 'string' || !blob.hash) return null;

  return { v: 1, salt: blob.salt, hash: blob.hash };
}

function persist(blob) {
  try {
    if (blob) localStorage.setItem(LS_KEY, JSON.stringify(blob));
    else localStorage.removeItem(LS_KEY);
    return true;
  } catch (e) {
    // Storage full or disabled. Report it rather than pretending the PIN
    // was saved: state is only updated on success.
    return false;
  }
}

function digest(salt, pin) {
  return sha256Hex(`${salt}:${pin}`);
}

/**
 * A random hex salt.
 *
 * `crypto.getRandomValues` is deliberately used over `crypto.subtle` — it
 * is NOT secure-context gated, so it works over `file://` in the packaged
 * widget. Guarded anyway: failing to set a PIN because an RNG is missing
 * would be a worse outcome than a weaker salt.
 */
function randomSalt() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  } catch (e) {
    let out = '';
    for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
}

// ── Subscribers ──────────────────────────────────────────
const listeners = new Set();
function notify() {
  const locked = state !== null;
  listeners.forEach(fn => fn(locked));
}

// ── Public API ───────────────────────────────────────────

/** True if a PIN is configured. False on any storage failure (fail open). */
export function isLockSet() {
  return state !== null;
}

/**
 * Set (or replace) the PIN. Returns true on success.
 *
 * Replacing does not require the old PIN: the app is already unlocked at
 * that point, so the caller has demonstrably passed the gate. That is a
 * deliberate v1 scope decision, not an oversight.
 */
export function setPin(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return false;
  const salt = randomSalt();
  const blob = { v: 1, salt, hash: digest(salt, pin) };
  if (!persist(blob)) return false;
  state = blob;
  resetBackoff();
  notify();
  return true;
}

/**
 * Check a PIN against the stored digest.
 *
 * The comparison is a plain `===` and that is not a weakness worth fixing:
 * an attacker who can call this can also read the hash out of localStorage
 * and brute-force it offline, where no comparison timing is observable.
 */
export function verifyPin(pin) {
  if (!state) return false;
  if (typeof pin !== 'string') return false;
  return digest(state.salt, pin) === state.hash;
}

/**
 * How long the caller must wait before another PIN may be checked, in ms.
 *
 * Exposed so the lock screen can phrase the message; the enforcement is in
 * `attemptPin`.
 */
export function pinRetryDelayMs() {
  const wait = blockedUntil - Date.now();
  return wait > 0 ? wait : 0;
}

/**
 * Check a PIN through the retry limiter. The lock screen must use this
 * rather than `verifyPin` — the latter is the raw comparison and would
 * bypass the delay.
 *
 * Returns `{ ok, retryAfterMs, blocked, failures? }`:
 *   - `ok: true`                     — correct PIN; the counter is reset.
 *   - `blocked: true`                — still cooling down; the PIN was NOT
 *                                      checked and the counter was not
 *                                      incremented.
 *   - `ok: false, blocked: false`    — checked and wrong. `retryAfterMs` is
 *                                      the delay that now applies (0 for the
 *                                      first three misses) and `failures` is
 *                                      the new consecutive count.
 */
export function attemptPin(pin) {
  const wait = pinRetryDelayMs();
  if (wait > 0) return { ok: false, retryAfterMs: wait, blocked: true };

  if (verifyPin(pin)) {
    resetBackoff();
    return { ok: true, retryAfterMs: 0, blocked: false };
  }

  failures += 1;
  const delay = FAIL_DELAYS_MS[Math.min(failures, FAIL_DELAYS_MS.length - 1)];
  blockedUntil = delay > 0 ? Date.now() + delay : 0;
  return { ok: false, retryAfterMs: delay, blocked: false, failures };
}

/** Remove the lock entirely. Returns true if storage was written. */
export function clearPin() {
  if (!persist(null)) return false;
  state = null;
  resetBackoff();
  notify();
  return true;
}

/** Subscribe to lock-set changes. `fn` receives a boolean. */
export function subscribeLock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * React hook — returns whether a lock is set, re-rendering on change.
 * Used by the settings section so it reflects set/change/remove.
 */
export function useAppLock() {
  const [snapshot, setSnapshot] = useState(isLockSet());
  useEffect(() => subscribeLock(setSnapshot), []);
  return snapshot;
}
