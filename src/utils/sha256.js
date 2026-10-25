/**
 * sha256.js — dependency-free SHA-256 (FIPS 180-4)
 *
 * Hand-rolled rather than `crypto.subtle`: the widget is a Tizen .wgt loaded
 * over `file://`, where a secure context is not guaranteed and `crypto.subtle`
 * is undefined. Its only consumer is the optional app-lock PIN (see
 * appLock.js), which must work however the widget was loaded.
 *
 * NOT a password KDF: no stretching, no per-attempt cost. Four digits is 10⁴
 * combinations, so against an attacker holding the blob the digest buys
 * nothing; it only keeps the PIN out of localStorage in plaintext.
 *
 * It does NOT protect the Stash API key written unencrypted beside it — anyone
 * who can read the app's storage has that key whatever this does. The README
 * says so.
 *
 * Output is lowercase hex; input is a JS string encoded UTF-8. The app's input
 * is always ASCII digits, but a real encoder keeps it safe to reuse.
 */

// First 32 bits of the fractional parts of the cube roots of the first 64
// primes — the FIPS 180-4 round constants.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = '0123456789abcdef';

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/**
 * Encode a JS string as UTF-8 bytes.
 *
 * Handles surrogate pairs (a code point above U+FFFF needs four bytes) and
 * replaces unpaired surrogates with U+FFFD, matching TextEncoder — which
 * is itself unavailable on the older engines this targets.
 */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f),
        );
      } else {
        out.push(0xef, 0xbf, 0xbd);
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd);
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

/**
 * SHA-256 of a byte array. Returns 32 bytes.
 *
 * Message schedule is 64 words regardless of the multiple of 64 in the
 * block count; W[0..15] come from the block and W[16..63] are derived.
 */
function sha256Bytes(bytes) {
  // Pad: 0x80, then zeros, then the message length in bits as a 64-bit
  // big-endian integer — such that the total is a multiple of 64 bytes.
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;

  // Only the low word can be non-zero for any input this app will ever
  // see, but write both so the length encoding is correct in general.
  const lenHi = Math.floor(bitLen / 0x100000000);
  const lenLo = bitLen >>> 0;
  msg[total - 8] = (lenHi >>> 24) & 0xff;
  msg[total - 7] = (lenHi >>> 16) & 0xff;
  msg[total - 6] = (lenHi >>> 8) & 0xff;
  msg[total - 5] = lenHi & 0xff;
  msg[total - 4] = (lenLo >>> 24) & 0xff;
  msg[total - 3] = (lenLo >>> 16) & 0xff;
  msg[total - 2] = (lenLo >>> 8) & 0xff;
  msg[total - 1] = lenLo & 0xff;

  // Initial hash values: fractional parts of the square roots of the
  // first eight primes.
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      w[i] = (msg[o] << 24) | (msg[o + 1] << 16) | (msg[o + 2] << 8) | msg[o + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const v = words[i];
    out[i * 4] = (v >>> 24) & 0xff;
    out[i * 4 + 1] = (v >>> 16) & 0xff;
    out[i * 4 + 2] = (v >>> 8) & 0xff;
    out[i * 4 + 3] = v & 0xff;
  }
  return out;
}

/**
 * SHA-256 of a string, as lowercase hex.
 *
 * @param {string} str
 * @returns {string} 64 hex characters
 */
export function sha256Hex(str) {
  return toHex(sha256Bytes(utf8Bytes(String(str))));
}
