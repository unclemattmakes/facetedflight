// tests/unit/tga.test.ts — the decoder that reads the title screen's terrain.
//
// `forest_02_height.tga` is the height map behind 2016's title valley, which
// turns out to be built with `FacetedTerrain` — this port's own generator
// (DEV-039). Every other map in the project is a PNG or a BMP; this one is a
// Targa, and nothing in `tools/` could open it.
//
// A decoder's failure mode is not "throws" — it is "returns plausible pixels
// that are wrong", and here those pixels become TERRAIN. So this checks the
// synthetic cases where the answer is known exactly, and the two things a
// heightmap decoder gets silently wrong: row order and channel order.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// Types come from the sibling `tga.d.mts`, as they do for bmp.mjs and png.mjs.
import { legacyPath } from '../../tools/legacy-root.mjs'
import { decodeTga, readTgaHeader } from '../../tools/terrain/tga.mjs'

/** Write a tiny uncompressed true-colour TGA and return its path. */
const write = (
  name: string,
  width: number,
  height: number,
  bpp: 24 | 32,
  descriptor: number,
  /** BGR(A) bytes, in FILE order. */
  pixels: number[],
): string => {
  const header = Buffer.alloc(18)
  header[2] = 2 // uncompressed true-colour
  header.writeUInt16LE(width, 12)
  header.writeUInt16LE(height, 14)
  header[16] = bpp
  header[17] = descriptor
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tga-')), name)
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pixels)]))
  return file
}

describe('the TGA decoder', () => {
  it('reads BGR as RGB, which is the channel order every Targa uses', () => {
    // One pixel, unmistakable: file order B=1, G=2, R=3 must come back 3,2,1.
    const f = write('one.tga', 1, 1, 24, 0x20, [1, 2, 3])
    const img = decodeTga(f)
    expect(Array.from(img.data)).toEqual([3, 2, 1])
    expect(img.channels).toBe(3)
  })

  it('keeps the alpha of a 32-bit file', () => {
    const f = write('a.tga', 1, 1, 32, 0x28, [1, 2, 3, 4])
    expect(Array.from(decodeTga(f).data)).toEqual([3, 2, 1, 4])
  })

  it('puts row 0 at the TOP whichever way the file stores it', () => {
    // THE assertion. Getting this backwards mirrors the terrain vertically, and
    // a mirrored heightfield is a plausible island that is wrong everywhere —
    // the mirror bug cost three assets and was caught by a screenshot, not a
    // test (CLAUDE.md, the orientation lesson).
    //
    // Two rows, top red and bottom blue, written both ways round.
    const topRow = [0, 0, 255] // BGR for red
    const bottomRow = [255, 0, 0] // BGR for blue

    // descriptor bit 5 SET: first row in the file is the top row.
    const topDown = decodeTga(write('td.tga', 1, 2, 24, 0x20, [...topRow, ...bottomRow]))
    // bit 5 CLEAR: bottom-up, like a BMP — so the file lists the bottom first.
    const bottomUp = decodeTga(write('bu.tga', 1, 2, 24, 0x00, [...bottomRow, ...topRow]))

    for (const [label, img] of [
      ['top-down', topDown],
      ['bottom-up', bottomUp],
    ] as const) {
      expect(Array.from(img.data.slice(0, 3)), `${label} row 0`).toEqual([255, 0, 0])
      expect(Array.from(img.data.slice(3, 6)), `${label} row 1`).toEqual([0, 0, 255])
    }
  })

  it('refuses what it cannot read, by name, instead of guessing', () => {
    // A decoder that half-supports a format and mis-reads the rest is worse
    // than one that stops: the output here becomes terrain.
    const rle = write('rle.tga', 1, 1, 24, 0x20, [1, 2, 3])
    fs.writeFileSync(
      rle,
      (() => {
        const b = fs.readFileSync(rle)
        b[2] = 10 // RLE true-colour
        return b
      })(),
    )
    expect(() => decodeTga(rle)).toThrow(/RLE true-colour/)

    const rightLeft = write('rl.tga', 1, 1, 24, 0x30, [1, 2, 3])
    expect(() => decodeTga(rightLeft)).toThrow(/right-to-left/)

    const short = write('short.tga', 4, 4, 24, 0x20, [1, 2, 3])
    expect(() => decodeTga(short)).toThrow(/truncated/)
  })

  it('reads the real title-valley map, and it is a grayscale height field', () => {
    // The file this decoder exists for. Skipped where the read-only 2016
    // project is not mounted, so the suite still runs on a fresh clone.
    const p = legacyPath(
      'Assets/Faceted Flight/World Machine Content/forest_02/forest_02_height.tga',
    )
    if (!fs.existsSync(p)) return

    const head = readTgaHeader(p)
    // 1025, not 1024 — same as both Simonet maps, and the reason `nPOTScale: 1`
    // makes Unity rescale it at import (DEV-007).
    expect(head.width).toBe(1025)
    expect(head.height).toBe(1025)
    expect(head.imageType).toBe(2)
    expect(head.bitsPerPixel).toBe(32)
    expect(head.topDown).toBe(true)
    // The size is the header plus exactly one uncompressed image: proof there
    // is no RLE, no ID field and no colour map to mis-skip.
    expect(head.bytes).toBe(18 + 1025 * 1025 * 4)

    const img = decodeTga(p)
    expect(img.width).toBe(1025)
    let grey = 0
    let min = 255
    let max = 0
    for (let i = 0; i < img.data.length; i += img.channels * 997) {
      const r = img.data[i] as number
      if (r === img.data[i + 1] && r === img.data[i + 2]) grey++
      min = Math.min(min, r)
      max = Math.max(max, r)
    }
    const n = Math.ceil(img.data.length / (img.channels * 997))
    // A height map written by World Machine as RGB: every pixel is grey.
    expect(grey).toBe(n)
    // And it uses its range — a map that decoded to one flat value would pass
    // every structural check above and generate a billiard table.
    expect(max - min).toBeGreaterThan(100)
  })
})
