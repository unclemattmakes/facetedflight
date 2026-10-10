// src/content/sha256.ts — SHA-256, synchronous and dependency-free. DEV-466.
//
// A player course's id is a SHA-256 prefix of its canonical bytes
// (`content/player-course.ts`), and `expandPlayerCourse` is pure and
// SYNCHRONOUS: it stamps that id on the level it returns. `crypto.subtle.digest`
// is async everywhere it exists, so it cannot sit inside a pure function, and
// the one place this has to agree with is the lap server later (E6), which
// runs the same file. So the digest is written out here, once.
//
// FIPS 180-4 §6.2, word for word. Every numeric literal below is the standard's
// own (the round constants `K` are the first 32 bits of the fractional parts of
// the cube roots of the first 64 primes, the initial hash `H0` of the square
// roots of the first eight), not a tuning number, which is the justification
// R9 asks of a literal under `src/content/`.
//
// Verified against node's own `crypto.createHash('sha256')` over the FIPS
// vectors and a sweep of random lengths across the 55/56/64-byte padding
// boundaries: `tests/unit/player-course.test.ts`. A hand-rolled digest checked
// only against itself would be DEV-069's "two of your own devices".

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** The SHA-256 of `bytes`, as 64 lower-case hex characters. */
export const sha256Hex = (bytes: Uint8Array): string => {
  // Padding (§5.1.1): a 1 bit, zeros to 56 mod 64, then the length in BITS as
  // a 64-bit big-endian integer. JS numbers hold the bit length exactly up to
  // 2^53, far past any course.
  const bitLength = bytes.length * 8
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const h = H0.slice()
  const w = new Uint32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4)
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15] as number
      const w2 = w[t - 2] as number
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[t] as number) + (w[t] as number)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = ((h[0] as number) + a) >>> 0
    h[1] = ((h[1] as number) + b) >>> 0
    h[2] = ((h[2] as number) + c) >>> 0
    h[3] = ((h[3] as number) + d) >>> 0
    h[4] = ((h[4] as number) + e) >>> 0
    h[5] = ((h[5] as number) + f) >>> 0
    h[6] = ((h[6] as number) + g) >>> 0
    h[7] = ((h[7] as number) + hh) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('')
}
