// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/sim/math/hash.ts: the string hash every layer shares (code-reuse audit
// WP-2, 2026-10-05). Five files each wrote FNV-1a out by hand
// (crosscut.md XC-1, sim-game.md SG-6); they compute the same 32-bit value
// and differ only in how they spell the multiply and the return encoding.
//
// Pure and sim-legal: no clock, no `Math.random`.

/**
 * FNV-1a, 32 bits, over UTF-16 code units, as an unsigned number. Not
 * cryptographic: an IDENTITY that changes when its input does and is the same
 * on every machine and load, which is the one property a seed or a version
 * stamp needs. The offset basis and prime are the algorithm's published
 * constants, not tuned values.
 *
 * `Math.imul` is the multiply by 16777619 mod 2^32 (a plain `*` overflows the
 * float53 mantissa and stops being the same function). A shift-and-add
 * spelling, which the XR checklist runner used, is the same function mod 2^32.
 */
export const fnv1a32 = (text: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** `fnv1a32` as eight lower-case hex digits. */
export const fnv1a32Hex = (text: string): string => fnv1a32(text).toString(16).padStart(8, '0')
