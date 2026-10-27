/**
 * appLock.js: optional PIN gate for the whole app.
 *
 * Stores a salted SHA-256 of a 4-digit PIN under its own localStorage key,
 * deliberately not in settings.js: `persistToStorage()` writes a whitelist of
 * three fields (a new field would silently never persist), and
 * `clearSettings()` wipes `tvapp.settings.v1` wholesale, so "Clear saved"
 * would silently remove the user's PIN. A separate key rules that out by
 * construction with no guard in the Clear path.
 *
 * The PIN is a deterrent, not encryption. A 4-digit PIN is 10⁴ combinations,
 * so anyone who can read localStorage recovers it offline almost instantly;
 * the digest only keeps it out of plaintext. The Stash API key written by
 * settings.js is not even held to that standard (see README Security notes).
 * The PIN deters someone with the remote, not anyone with the installer.
 *
 * No PBKDF2 stretching on purpose: it would cost unlock latency on a TV CPU
 * and buy nothing against a 10⁴ keyspace. The defence that works against the
 * on-device attacker is `attemptPin()`'s escalating delay.
 *
 * FAIL OPEN: if storage is unreadable or the blob is corrupt, `isLockSet()`
 * reports false and the app opens; a corrupt blob must never brick the app.
 */

import { useEffect, useState } from 'react';
import { sha256Hex } from './sha256.js';

const LS_KEY = 'tvapp.lock.v1';

/** Digits required. Shared with the keypad and the settings section. */
export const PIN_LENGTH = 4;

const PIN_RE = /^\d{4}$/;

// ── In-memory state ──────────────────────────────────────
let state = loadFromStorage();   // { v, salt, hash } | null

// Wrong-PIN backoff, deliberately in memory: a persisted timestamp can brick
// an unlocked device after a clock change, and relaunching to clear the delay
// should stay inconvenient. Losing the counter on restart is the same
// fail-open promise as the rest of the module. Indexed by consecutive
// failures: first three misses free, then 1s, 5s and 30s (10⁴ tries ≈ 3.5 days).
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
    // Corrupt JSON, or storage unavailable, fail open (see header).
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
 * `crypto.getRandomValues` is used over `crypto.subtle` because it is not
 * secure-context gated, so it works over `file://` in the packaged widget.
 * Guarded anyway: failing to set a PIN over a missing RNG is worse than a
 * weaker salt.
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
 * Replacing does not require the old PIN: the app is already unlocked, so
 * the caller has passed the gate. Deliberate v1 scope, not an oversight.
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
 * The plain `===` is not a weakness worth fixing: an attacker who can call
 * this can read the hash out of localStorage and brute-force it offline,
 * where no comparison timing is observable.
 */
export function verifyPin(pin) {
  if (!state) return false;
  if (typeof pin !== 'string') return false;
  return digest(state.salt, pin) === state.hash;
}

/**
 * How long before another PIN may be checked, in ms. Exposed so the lock
 * screen can phrase the message; enforcement lives in `attemptPin`.
 */
export function pinRetryDelayMs() {
  const wait = blockedUntil - Date.now();
  return wait > 0 ? wait : 0;
}

/**
 * Check a PIN through the retry limiter; the lock screen must use this
 * rather than `verifyPin`, which bypasses the delay.
 *
 * Returns `{ ok, retryAfterMs, blocked, failures? }`. `blocked: true` means
 * the PIN was not checked and the counter not incremented. `failures` is the
 * new consecutive count.
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
 * React hook: whether a lock is set, re-rendering on change. Used by the
 * settings section so it reflects set/change/remove.
 */
export function useAppLock() {
  const [snapshot, setSnapshot] = useState(isLockSet());
  useEffect(() => subscribeLock(setSnapshot), []);
  return snapshot;
}
