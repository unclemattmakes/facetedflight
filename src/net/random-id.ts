// src/net/random-id.ts: an id drawn uniformly from an alphabet (code-reuse
// audit BE-10). `lap-server.ts`'s `newLapId` and `stats-server.ts`'s
// `newBugId` each wrote the same rejection loop.
//
// UNBIASED: a byte is kept only below `256 - (256 % n)`, the largest whole
// multiple of the alphabet, so `% n` is uniform; the rest are drawn again.
// (62 gives 248, the lap id's old constant; the bug id's 31 gives 248 too.)
// The randomness is INJECTED, so a test can feed bytes and check the bias,
// and a Worker, node and a page each pass their own `crypto`.
//
// Not here: `net/tv-protocol.ts`'s `mintTvId` (`b & 31` over a 32-letter
// alphabet: exact, and its tests feed it a fixed byte stream whose draw size
// it must not change) and `game/room-client.ts`'s room code (outside this
// package).
//
// SERVER-SAFE: no imports, no clock, no global randomness of its own.

/** Fill `bytes` with random values (`crypto.getRandomValues` fits). */
export type FillRandom = (bytes: Uint8Array) => void

/** `length` characters of `alphabet`, each uniform and independent. */
export const randomIdOver = (alphabet: string, length: number, fill: FillRandom): string => {
  const n = alphabet.length
  const ceiling = 256 - (256 % n)
  const bytes = new Uint8Array(Math.max(16, length * 2))
  let out = ''
  while (out.length < length) {
    fill(bytes)
    for (const b of bytes) {
      if (b < ceiling && out.length < length) out += alphabet.charAt(b % n)
    }
  }
  return out
}

/** The platform's CSPRNG as a `FillRandom`. */
export const cryptoFill: FillRandom = (bytes) => {
  crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>)
}
