// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/net/base64url.ts — bytes <-> base64url text (RFC 4648 §5), no padding.
//
// A lap travels as base64url inside a JSON body and is stored as the same text
// (D1 hands a BLOB back as an Array of numbers, one JSON value per byte). Its
// own code rather than `atob`/`btoa`, which speak the OTHER alphabet, work on
// binary STRINGS rather than bytes, and would need a translation step either
// side: this is the whole codec, and it refuses what it cannot decode rather
// than skipping it.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const DECODE = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

export const toBase64url = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63)
  }
  return out
}

/** Decode, or null for anything that is not canonical unpadded base64url. */
export const fromBase64url = (text: string): Uint8Array | null => {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const v = c < 128 ? (DECODE[c] as number) : -1
    if (v < 0) return null
    // At most 13 live bits (7 left over + 6 new); the mask keeps the
    // accumulator from overflowing a 32-bit shift on a long input.
    acc = ((acc << 6) | v) & 0x3fff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  // Leftover bits must be zero, or two texts would decode to one byte string.
  if ((acc & ((1 << bits) - 1)) !== 0) return null
  return out
}
