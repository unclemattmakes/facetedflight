// tests/unit/island-map.test.ts — DEV-490 (T1.5): a player's heightmap, read in
// the browser's own way, capped before it is inflated, and carried by the
// course format and its file.
//
// Fixtures are MADE here, not committed: a PNG is a few chunks around a zlib
// stream, and `node:zlib` writes the stream. So the 16-bit fixture holds
// samples whose LOW byte matters, and each row uses a different PNG filter,
// which is the whole of what the port of `tools/terrain/png.mjs` must get right.

import fs from 'node:fs'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeHeightmap,
  HEIGHTMAP_LIMITS,
  heightmapSha,
  heightmapTooLarge,
  pngHeader,
  reopenMapFile,
} from '@/content/island-map'
import { courseGround, loadPlayerCourse } from '@/content/load-player-course'
import {
  canonicalPlayerCourse,
  groundKey,
  ISLAND_MAP_PEAK_GREY,
  islandHeightScale,
  islandPeakHeight,
  islandWaterline,
  PLAYER_COURSE_ISLAND,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  PlayerCourseError,
  playerCourseId,
  validatePlayerCourse,
} from '@/content/player-course'
import { courseFile, readCourseFile, readCourseToken } from '@/content/player-course-wire'
import { readDraftCourse } from '@/editor/core/drafts'
import { ISLAND_DIALOG, islandDialogHeight, previewHeights } from '@/editor/desk/island-dialog'
import {
  CUSTOM_GROUND_LIMITS,
  customGroundOf,
  mapGround,
  PREVIEW_SHORE,
} from '@/game/terrain/custom-ground'
import { TERRAIN } from '@/generated/constants.generated'
import { toBase64url } from '@/net/base64url'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS } from '@/net/handles'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { haveMaps, MAPS } from './helpers/terrain-field'

// ── Fixture makers ────────────────────────────────────────────────────────

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
const chunk = (type: string, payload: Uint8Array): Buffer => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0)
  return Buffer.concat([head, payload, tail])
}
const ihdr = (w: number, h: number, depth: number, colour = 0, interlace = 0): Buffer => {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0)
  b.writeUInt32BE(h, 4)
  b[8] = depth
  b[9] = colour
  b[12] = interlace
  return chunk('IHDR', b)
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (header: Buffer, idat: Buffer): Uint8Array =>
  new Uint8Array(
    Buffer.concat([SIGNATURE, header, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]),
  )

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A greyscale PNG of `samples` (integers of `depth` bits), row `y` filtered with `y % 5`. */
const greyPng = (w: number, h: number, depth: 8 | 16, samples: readonly number[]): Uint8Array => {
  const bps = depth / 8
  const stride = w * bps
  const rows: Uint8Array[] = []
  for (let y = 0; y < h; y++) {
    const r = new Uint8Array(stride)
    for (let x = 0; x < w; x++) {
      const v = samples[y * w + x] as number
      if (bps === 2) {
        r[2 * x] = v >> 8
        r[2 * x + 1] = v & 0xff
      } else r[x] = v
    }
    rows.push(r)
  }
  const raw = Buffer.alloc(h * (1 + stride))
  for (let y = 0; y < h; y++) {
    const f = y % 5
    raw[y * (1 + stride)] = f
    const cur = rows[y] as Uint8Array
    const prev = y > 0 ? (rows[y - 1] as Uint8Array) : new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bps ? (cur[x - bps] as number) : 0
      const b = prev[x] as number
      const c = x >= bps ? (prev[x - bps] as number) : 0
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c)
      raw[y * (1 + stride) + 1 + x] = ((cur[x] as number) - pred) & 0xff
    }
  }
  return png(ihdr(w, h, depth), zlib.deflateSync(raw))
}

/** A square `.r16`: little-endian 16-bit samples. */
const r16 = (n: number, samples: readonly number[]): Uint8Array => {
  const out = new Uint8Array(n * n * 2)
  for (let i = 0; i < n * n; i++) {
    out[2 * i] = (samples[i] as number) & 0xff
    out[2 * i + 1] = (samples[i] as number) >> 8
  }
  return out
}

/** A seeded LCG: the fuzz is the same every run. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s % n
  }
}

const COURSE: PlayerCourse = {
  v: PLAYER_COURSE_VERSION,
  island: 'simonet',
  sky: 'int_01_hoverJet',
  vehicle: 'hoverjet',
  mode: 'ringAttack',
  path: {
    points: [
      [0, 300, 0],
      [0, 300, 800],
    ],
    gap: 200,
  },
  rings: [],
  start: { pos: [0, 280, -60], yaw: 180 },
  finish: { t: 1 },
  timeLimit: 120,
  name: [HANDLE_ADJECTIVES[0] as string, HANDLE_NOUNS[0] as string],
}

// ── The policy ────────────────────────────────────────────────────────────

describe('DEV-490 — the bounds, pinned by value', () => {
  it('the map caps, and the edge is the generator’s own', () => {
    expect(HEIGHTMAP_LIMITS).toEqual({ maxEdge: 4097, minEdge: 2, maxFileBytes: 37_748_736 })
    expect(HEIGHTMAP_LIMITS.maxEdge).toBe(CUSTOM_GROUND_LIMITS.maxEdge)
    // A 4097² .r16 fits under the file cap, with room for a PNG's chunks.
    expect(4097 * 4097 * 2).toBeLessThan(HEIGHTMAP_LIMITS.maxFileBytes)
  })

  it('the island block, with its extents equal to DEV-489’s ground limits', () => {
    expect(PLAYER_COURSE_ISLAND).toEqual({
      maxSize: 8192,
      maxTerrainHeight: 1536,
      minHeight: 20,
      heightQuantumMetres: 1,
      seaMax: 0.9,
      seaQuantum: 0.001,
      shapeQuantum: 0.01,
    })
    expect(PLAYER_COURSE_ISLAND.maxSize).toBe(CUSTOM_GROUND_LIMITS.maxSize)
    expect(PLAYER_COURSE_ISLAND.maxTerrainHeight).toBe(CUSTOM_GROUND_LIMITS.maxHeight)
  })

  it('the dialog’s defaults and its rights sentence', () => {
    expect(ISLAND_DIALOG.defaultSeaPercent).toBe(5)
    expect(ISLAND_DIALOG.rights).toMatch(/rights/)
  })

  // DEV-499: nothing typed. Each island's "highest point above the sea" runs
  // to, and starts at, its own sheet `terrainHeight` less its waterline.
  it('the height field’s range and default are the island’s own, read from the sheet', () => {
    const sheet = TERRAIN as unknown as Record<
      string,
      { terrains: Record<string, { terrainHeight: number }> }
    >
    const islands = Object.keys(sheet).filter((id) => islandHeightScale(id) !== null)
    expect(islands.length).toBeGreaterThanOrEqual(4)
    for (const id of islands) {
      const land = Object.entries(sheet[id]?.terrains ?? {}).find(([n]) => n !== 'ocean')?.[1]
      const scale = Math.floor((land?.terrainHeight ?? Number.NaN) - islandWaterline(id))
      expect(islandHeightScale(id), id).toBe(scale)
      // DEV-534: it STARTS at the measured summit, under the ceiling; an
      // island with no measured map (the menu valley, which no base flies)
      // starts at its scale, as every island did before.
      const peak = islandPeakHeight(id)
      expect(peak === null, id).toBe(!Object.hasOwn(ISLAND_MAP_PEAK_GREY, id))
      expect(islandDialogHeight(id), id).toEqual({
        min: PLAYER_COURSE_ISLAND.minHeight,
        max: scale,
        value: peak ?? scale,
      })
      expect(peak ?? scale, id).toBeLessThanOrEqual(scale)
      // Under the validator's ceiling with the waterline on.
      expect(islandWaterline(id) + scale).toBeLessThanOrEqual(PLAYER_COURSE_ISLAND.maxTerrainHeight)
    }
    // What those are today, so a sheet change is seen: Simonet's white is 1,536
    // and its sea stands 198 m up its mesh; the others' white is 1,024.
    expect(['simonet', 'kauai', 'desert', 'alpine'].map(islandHeightScale)).toEqual([
      1337, 975, 1024, 1024,
    ])
    // DEV-534: and the summits, DEV-499's measured peaks. Matt: *"measured
    // peak"* (Simonet 892, not 1,337); the other three sit within 3 % of white.
    expect(['simonet', 'kauai', 'desert', 'alpine'].map(islandPeakHeight)).toEqual([
      892, 947, 1020, 1000,
    ])
    expect(islandPeakHeight('nowhere')).toBeNull()
  })

  // DEV-534: the pinned greys are the MAPS' brightest pixels. The maps are
  // gitignored (hydrated from R2), so this reads them where they are and its
  // loud twin below says when they are not. Every channel, as the 2016 maps
  // are grey RGB: the red alone would miss a map that was not.
  describe.skipIf(!haveMaps)('the summit greys, read off the shipped maps', () => {
    it('every island’s brightest grey is the pinned one', () => {
      expect(Object.keys(ISLAND_MAP_PEAK_GREY).sort()).toEqual(Object.keys(MAPS).sort())
      for (const [id, file] of Object.entries(MAPS)) {
        const png = decodePngBuffer(fs.readFileSync(file)) as {
          width: number
          height: number
          channels: number
          data: Uint8Array
        }
        let max = 0
        for (let i = 0; i < png.data.length; i++) {
          if (i % png.channels < 3) max = Math.max(max, png.data[i] as number)
        }
        expect(max, id).toBe(ISLAND_MAP_PEAK_GREY[id])
      }
    })
  })
  describe.skipIf(haveMaps)('the summit greys, where the maps are not hydrated', () => {
    it('skips the read loudly', () => {
      expect(haveMaps).toBe(false)
    })
  })

  it('the waterline, in each island’s own mesh frame', () => {
    // Simonet's agrees with DEV-489's preview shore, derived from the other end
    // (the land group's -81.69 against the same surface reading).
    expect(islandWaterline('simonet')).toBeCloseTo(PREVIEW_SHORE * 1536, 6)
    expect(islandWaterline('simonet')).toBeCloseTo(198.29, 2)
    // Kauai wears the same ocean, its land 68 m up rather than 81.69 down.
    expect(islandWaterline('kauai')).toBeCloseTo(48.6, 2)
    // No sea: the grey stands at the valley floor.
    expect(islandWaterline('desert')).toBe(0)
    expect(islandWaterline('alpine')).toBe(0)
    expect(islandWaterline('nowhere')).toBe(0)
  })
})

// ── The reader ────────────────────────────────────────────────────────────

describe('DEV-490 — a greyscale PNG, 8 and 16 bits, and a .r16', () => {
  const W = 7
  const H = 11
  const sixteen = Array.from({ length: W * H }, (_, i) => (i * 7919 + 257 * (i % 3)) % 65536)

  it('keeps all SIXTEEN bits of a 16-bit PNG, through every row filter', async () => {
    const read = await decodeHeightmap(greyPng(W, H, 16, sixteen))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.map).toMatchObject({ width: W, height: H, format: 'png', bits: 16 })
    expect(Array.from(read.map.data, (v) => Math.round(v * 65535))).toEqual(sixteen)
    // The low byte is not thrown away (png.mjs's own reader keeps only the high).
    expect(sixteen.some((v) => (v & 0xff) !== 0)).toBe(true)
  })

  it('reads an 8-bit PNG', async () => {
    const eight = sixteen.map((v) => v >> 8)
    const read = await decodeHeightmap(greyPng(W, H, 8, eight))
    expect(read.ok && read.map.bits).toBe(8)
    if (read.ok) expect(Array.from(read.map.data, (v) => Math.round(v * 255))).toEqual(eight)
  })

  it('reads a square .r16, little-endian, row 0 first', async () => {
    const n = 9
    const samples = Array.from({ length: n * n }, (_, i) => (i * 40503) % 65536)
    const read = await decodeHeightmap(r16(n, samples))
    expect(read.ok && read.map.format).toBe('r16')
    if (read.ok) expect(Array.from(read.map.data, (v) => Math.round(v * 65535))).toEqual(samples)
    const odd = await decodeHeightmap(new Uint8Array(2 * 10 * 9))
    expect(odd.ok || odd.error).toMatch(/square \.r16/)
  })

  it('refuses a colour, interlaced or cut-short PNG by name', async () => {
    const colour = png(ihdr(4, 4, 8, 2), zlib.deflateSync(Buffer.alloc(4 * 13)))
    expect((await decodeHeightmap(colour)).ok || 'x').not.toBe(true)
    const c = await decodeHeightmap(colour)
    expect(c.ok || c.error).toMatch(/greyscale/)
    const laced = png(ihdr(4, 4, 8, 0, 1), zlib.deflateSync(Buffer.alloc(4 * 5)))
    const l = await decodeHeightmap(laced)
    expect(l.ok || l.error).toMatch(/interlaced/)
    const good = greyPng(W, H, 16, sixteen)
    const cut = await decodeHeightmap(good.subarray(0, good.length - 30))
    expect(cut.ok).toBe(false)
  })
})

describe('DEV-490 — untrusted: capped before inflating, and never a throw', () => {
  it('reads the edge from the IHDR BEFORE a byte is inflated', async () => {
    // A header past the cap over an IDAT that is not deflate at all: were it
    // inflated first, the refusal would be about the stream.
    const bomb = png(ihdr(5000, 5000, 16), Buffer.from('not deflate, never read'))
    const r = await decodeHeightmap(bomb)
    expect(r.ok || r.error).toBe('is 5000x5000; a side may be at most 4097')
    const head = pngHeader(bomb)
    expect(typeof head === 'string' ? head : head.width).toBe(5000)
  })

  it('stops the inflater at the size the header promised (a deflate bomb)', async () => {
    // 64x64 8-bit promises 64 * 65 bytes; the stream holds 8 MB of zeros.
    const bomb = png(ihdr(64, 64, 8), zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024)))
    expect(bomb.length).toBeLessThan(16_384)
    const r = await decodeHeightmap(bomb)
    expect(r.ok || r.error).toBe('holds more image data than its header says')
  })

  it('asks the size first: a file past the cap is refused unread', async () => {
    expect(heightmapTooLarge(HEIGHTMAP_LIMITS.maxFileBytes)).toBe(false)
    expect(heightmapTooLarge(HEIGHTMAP_LIMITS.maxFileBytes + 1)).toBe(true)
    expect(heightmapTooLarge(Number.NaN)).toBe(true)
  })

  it('fuzz: a thousand mutations of a good PNG, and random bytes, never throw', async () => {
    const good = greyPng(W16, H16, 16, S16)
    const rnd = lcg(490)
    let ok = 0
    for (let i = 0; i < 1000; i++) {
      const b = good.slice()
      const edits = 1 + rnd(6)
      for (let k = 0; k < edits; k++) b[rnd(b.length)] = rnd(256)
      const cut = rnd(4) === 0 ? b.subarray(0, rnd(b.length)) : b
      const r = await decodeHeightmap(cut)
      expect(typeof r.ok).toBe('boolean')
      if (r.ok) {
        ok++
        expect(r.map.data.length).toBe(r.map.width * r.map.height)
        expect(r.map.width).toBeLessThanOrEqual(HEIGHTMAP_LIMITS.maxEdge)
        for (const v of r.map.data) expect(v >= 0 && v <= 1).toBe(true)
      } else expect(r.error.length).toBeGreaterThan(0)
    }
    // Some mutations land in the CRCs and still read; most do not.
    expect(ok).toBeGreaterThan(0)
    for (let i = 0; i < 200; i++) {
      const junk = new Uint8Array(rnd(400))
      for (let k = 0; k < junk.length; k++) junk[k] = rnd(256)
      if (i % 2 === 0) junk.set(SIGNATURE.subarray(0, Math.min(8, junk.length)))
      const r = await decodeHeightmap(junk)
      expect(typeof r.ok).toBe('boolean')
    }
  })
})
const W16 = 16
const H16 = 16
const S16 = Array.from({ length: W16 * H16 }, (_, i) => (i * 3571) % 65536)

// ── The format, the file, the ground ──────────────────────────────────────

describe('DEV-490 — the course carries its island, the file carries its map', () => {
  const makeMap = () => greyPng(W16, H16, 16, S16)

  it('writes the island INSIDE `island`, keeps a shipped course’s bytes, and reads both spellings', async () => {
    const map = makeMap()
    const sha = await heightmapSha(map)
    const island = { map: sha, size: 4096, height: 400.4, sea: 0.0504 }
    const onMap = { ...COURSE, ground: island }
    const canonical = JSON.parse(canonicalPlayerCourse(onMap)) as { island: unknown }
    expect(canonical.island).toEqual({
      map: sha,
      size: 4096,
      height: 400,
      sea: 0.05,
      colours: 'simonet',
    })
    // Read back from the wire spelling, it is the in-memory one again.
    const back = validatePlayerCourse(canonical)
    expect(back.ok && back.course.ground).toEqual({ map: sha, size: 4096, height: 400, sea: 0.05 })
    expect(back.ok && back.course.island).toBe('simonet')
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(onMap))
    // The island is in the id; a shipped course's canonical string is unchanged.
    expect(playerCourseId(onMap)).not.toBe(playerCourseId(COURSE))
    expect(canonicalPlayerCourse(COURSE)).not.toContain('colours')
    // Both spellings at once is refused.
    const both = validatePlayerCourse({ ...canonical, ground: island })
    expect(both.ok).toBe(false)
  })

  it('refuses a size off the island’s chunks and a height past the tallest island', () => {
    const at = (island: object): string[] => {
      const r = validatePlayerCourse({ ...COURSE, island })
      return r.ok ? [] : r.errors.map(([p]) => p)
    }
    const good = { map: 'ab'.repeat(32), size: 4096, height: 400, sea: 0.05, colours: 'simonet' }
    expect(at(good)).toEqual([])
    expect(at({ ...good, size: 4000 })).toContain('island.size')
    // Simonet's sea is 198 m up its 1,536 m: 1,400 m above it reaches past.
    expect(at({ ...good, height: 1400 })).toContain('island.height')
    expect(at({ ...good, sea: 0.95 })).toContain('island.sea')
    expect(at({ ...good, map: 'AB'.repeat(32) })).toContain('island.map')
    expect(at({ ...good, extra: 1 })).toContain('island."extra"')
  })

  it('a .ffcourse carries the map; the reader checks it against the SHA the course names', async () => {
    const map = makeMap()
    const onMap = {
      ...COURSE,
      ground: { map: await heightmapSha(map), size: 4096, height: 400, sea: 0.05 },
    }
    const file = await courseFile(onMap, map)
    const read = await readCourseFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(playerCourseId(read.course)).toBe(playerCourseId(onMap))
    expect(Array.from(read.map ?? [])).toEqual(Array.from(map))
    // The wrong map is refused by the writer and by the reader.
    const other = makeMap().fill(7, 60, 70)
    await expect(courseFile(onMap, other)).rejects.toThrow(/not the one/)
    const swapped = file.slice()
    swapped[swapped.length - 20] = (swapped[swapped.length - 20] as number) ^ 0xff
    const r = await readCourseFile(swapped)
    expect(r.ok || r.errors[0]?.[1]).toMatch(/not the one its course names/)
    // A course that names a map but a file without one.
    const bare = await courseFile(COURSE)
    const payloadOnly = await readCourseFile(bare)
    expect(payloadOnly.ok && payloadOnly.map).toBe(null)
  })

  it('a link cannot carry it: the token refuses, and a hand-made one is refused on the way in', async () => {
    const map = makeMap()
    const onMap = {
      ...COURSE,
      ground: { map: await heightmapSha(map), size: 4096, height: 400, sea: 0.05 },
    }
    const { courseToken, coursePayload } = await import('@/content/player-course-wire')
    await expect(courseToken(onMap)).rejects.toThrow(/Save file/)
    const token = `ffc1.${toBase64url(await coursePayload(onMap))}`
    const r = await readCourseToken(token)
    expect(r.ok || r.errors[0]?.[1]).toMatch(/\.ffcourse file/)
  })

  it('the ground: "0 is the waterline", and the level is built over it or not at all', async () => {
    const map = makeMap()
    const sha = await heightmapSha(map)
    const onMap = { ...COURSE, ground: { map: sha, size: 4096, height: 400, sea: 0.05 } }
    const ground = await courseGround(onMap, map)
    expect(ground?.key).toBe(groundKey(onMap.ground))
    expect(ground?.maxHeight).toBeCloseTo(islandWaterline('simonet') + 400, 6)
    // Where the map reads the waterline grey, the ground stands at the sea.
    const read = await decodeHeightmap(map)
    if (!read.ok || !ground) throw new Error('fixture')
    const g = mapGround(
      { width: 2, height: 2, data: new Float32Array([0.05, 1, 0.05, 1]) },
      'simonet',
      { size: 4096, height: 400, sea: 0.05 },
    )
    expect((g.heights.data[0] as number) * g.maxHeight).toBeCloseTo(islandWaterline('simonet'), 3)
    expect((g.heights.data[1] as number) * g.maxHeight).toBeCloseTo(g.maxHeight, 3)
    // Without its ground the course is refused; with it the level carries it.
    await expect(loadPlayerCourse(onMap)).rejects.toBeInstanceOf(PlayerCourseError)
    await expect(courseGround(onMap, null)).rejects.toBeInstanceOf(PlayerCourseError)
    const level = await loadPlayerCourse(onMap, { ground })
    expect(customGroundOf(level)?.key).toBe(groundKey(onMap.ground))
  })

  it('a draft keeps its island; the preview rebases the waterline to 0', async () => {
    const onMap = { ...COURSE, ground: { map: 'cd'.repeat(32), size: 2048, height: 300, sea: 0.2 } }
    const back = readDraftCourse(JSON.parse(JSON.stringify(onMap)))
    expect(back?.ground).toEqual(onMap.ground)
    expect(readDraftCourse({ ...onMap, ground: { map: 'x' } })).toBe(null)
    const p = previewHeights(
      { width: 3, height: 1, data: new Float32Array([0, 0.2, 1]), format: 'r16', bits: 16 },
      0.2,
    )
    expect(Array.from(p.data, (v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1])
  })
})

// ── DEV-499: the map picked again, when this browser lost it ──────────────

describe('DEV-499 — Open a map file…: the same bytes load, another map is refused', () => {
  it('accepts only the file the course names, by its SHA-256', async () => {
    const map = greyPng(W16, H16, 16, S16)
    const sha = await heightmapSha(map)
    expect(await reopenMapFile(sha, map)).toEqual({ ok: true })
    // Another map, even one that decodes and is the same size, is a different map.
    const other = greyPng(
      W16,
      H16,
      16,
      S16.map((v) => 65535 - v),
    )
    const refused = await reopenMapFile(sha, other)
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.why).toMatch(/different map/)
    // Junk never throws.
    const junk = await reopenMapFile(sha, new Uint8Array([1, 2, 3]))
    expect(junk.ok).toBe(false)
  })
})
