/**
 * The heightmap the island specs import: a 16-bit greyscale PNG of a ridged
 * island, 257 a side, written with `node:zlib` (no binary in git). Moved out
 * of `editor-island.spec.ts` by DEV-499 so `editor-island-reopen.spec.ts`
 * picks the same file. `flip` mirrors it: a DIFFERENT map of the same size
 * and kind, for the reopen path's refusal.
 */
import zlib from 'node:zlib'

// ── The map: a 16-bit greyscale PNG of a ridged island ─────────────────────

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff
  for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, payload: Buffer): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0)
  return Buffer.concat([head, payload, tail])
}

/**
 * 257 samples a side. Under the 5 % waterline at the edge; a long island with
 * a spine of ridges, a saddle and two summits, the higher at the map's white.
 */
export const islandPng = (flip = false): Buffer => {
  const n = 257
  const raw = Buffer.alloc(n * (1 + 2 * n))
  for (let row = 0; row < n; row++) {
    raw[row * (1 + 2 * n)] = 0
    for (let col = 0; col < n; col++) {
      // `flip`: the same island mirrored, a DIFFERENT map of the same size and kind.
      const x = (flip ? 1 - col / (n - 1) : col / (n - 1)) - 0.5
      const z = row / (n - 1) - 0.5
      const e = Math.hypot(x / 0.42, z / 0.3)
      const land = Math.max(0, 1 - e)
      const ridge = 0.12 * Math.sin(9 * x + 2 * z) * land
      const peaks =
        Math.exp(-((x - 0.12) ** 2 + z ** 2) / 0.012) +
        0.7 * Math.exp(-((x + 0.15) ** 2 + (z - 0.04) ** 2) / 0.009)
      const h = 0.02 + 0.55 * land ** 0.8 + ridge + 0.43 * peaks * land
      const v = Math.round(Math.min(1, Math.max(0, h)) * 65535)
      raw.writeUInt16BE(v, row * (1 + 2 * n) + 1 + 2 * col)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(n, 0)
  ihdr.writeUInt32BE(n, 4)
  ihdr[8] = 16
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
