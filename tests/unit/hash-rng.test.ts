// The shared hash and generators (code-reuse audit WP-2). The expected values
// were taken from the copies this replaced BEFORE they were deleted, and the
// reference spellings below are those copies, kept as the oracle for a
// differential check.

import { describe, expect, it } from 'vitest'
import { fnv1a32, fnv1a32Hex } from '@/sim/math/hash'
import { mulberry32, xorshift32 } from '@/sim/math/rng'

const draws = (rnd: () => number, n = 3): number[] => Array.from({ length: n }, () => rnd())

/** The XR checklist runner's original (removed, DEV-900): the multiply written as shift-and-add. */
const shiftAddHex = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** content/canonical-json.ts's original: `>>> 0` inside the loop. */
const inLoopHex = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** boot/app/horizon.ts's original: xor folded into the multiply. */
const foldedSeed = (id: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/** render/particles.ts's original, constants in decimal. */
const decimalSeed = (name: string): number => {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

describe('fnv1a32', () => {
  it('matches the published FNV-1a test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
    expect(fnv1a32Hex('a')).toBe('e40c292c')
    expect(fnv1a32Hex('')).toBe('811c9dc5')
  })

  it('agrees with every spelling it replaced, including non-ASCII code units', () => {
    const samples = [
      '',
      'x',
      'int_01_hoverJet',
      'rookie_01_jumpSeat',
      'smoke',
      'é中🚀',
      'a'.repeat(300),
    ]
    for (const s of samples) {
      expect(fnv1a32Hex(s)).toBe(shiftAddHex(s))
      expect(fnv1a32Hex(s)).toBe(inLoopHex(s))
      expect(fnv1a32(s)).toBe(foldedSeed(s))
      expect(fnv1a32(s)).toBe(decimalSeed(s))
    }
  })
})

describe('mulberry32', () => {
  it('reproduces the stream sim/terrain/faceted.ts had', () => {
    expect(draws(mulberry32(1))).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ])
    expect(draws(mulberry32(0))).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
    ])
    expect(draws(mulberry32(12345))).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985,
    ])
  })

  it('gives each constructor its own stream', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    a()
    expect(draws(b, 1)[0]).not.toBe(a())
  })
})

describe('xorshift32', () => {
  it('reproduces the stream game/props/instance-plan.ts had, zero seed included', () => {
    expect(draws(xorshift32(1))).toEqual([
      0.00006295018829405308, 0.015747428173199296, 0.6164041024167091,
    ])
    expect(draws(xorshift32(0))).toEqual([
      0.31659353361465037, 0.8757069851271808, 0.4833001629449427,
    ])
    expect(draws(xorshift32(12345))).toEqual([
      0.776938705239445, 0.3951726963277906, 0.6557702794671059,
    ])
  })

  it('never sticks at zero for a seed that truncates to zero', () => {
    expect(draws(xorshift32(2 ** 32))).toEqual(draws(xorshift32(0)))
  })
})
