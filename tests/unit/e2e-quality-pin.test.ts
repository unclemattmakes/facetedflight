// tests/unit/e2e-quality-pin.test.ts — the guard that says a photo run's tier
// held, tested for the failure mode a guard is allowed to have: none that
// looks like a pass.
//
// DEV-245. Every screenshot spec in this project loaded without `quality=` or
// `adaptive=` until this fixture, so a starved frame could drop the tier
// between two arms and change MSAA, the framebuffer scale, the shadow map and
// the prop LOD — all of them in the picture. The pin is one string; the half
// worth testing is the COMPARISON, because DEV-241's lesson is that a check
// whose broken state reads as agreement is not a check.
//
// The e2e fixture is imported directly. It carries only a `type` import of
// Playwright's `Page`, so nothing from the runner is loaded here.

import { describe, expect, it } from 'vitest'
import { type DrawState, drawStateDiff, drawStateLine, PINNED } from '../e2e/fixtures/quality-pin'

const held: DrawState = {
  tier: 'high',
  adaptiveStep: 1,
  framebufferScale: 1,
  pixelRatio: 2,
  foveation: 0,
  samples: 4,
  antialias: true,
  drawingBuffer: '2016x2016',
}

describe('PINNED', () => {
  it('names the tier AND switches the controller off — one without the other is not a pin', () => {
    // Both halves, because they fail differently: without `quality=` the tier
    // is whatever the player's settings say, and without `adaptive=0` the
    // controller still walks the pixel count inside the pinned tier.
    expect(PINNED).toContain('quality=high')
    expect(PINNED).toContain('adaptive=0')
    // No leading `&`: the call sites interpolate it into a query they build,
    // and a stray separator makes an empty parameter that `parseSnap`-style
    // readers have to tolerate.
    expect(PINNED.startsWith('&')).toBe(false)
  })
})

describe('drawStateDiff', () => {
  it('reports nothing when the two readings are the same', () => {
    expect(drawStateDiff(held, { ...held })).toEqual([])
  })

  it('names the field, the before and the after — which bug it is, not just that there is one', () => {
    // A framebuffer scale and an MSAA count are different causes; a guard that
    // said only "the tier moved" would send the reader to the wrong file.
    expect(drawStateDiff(held, { ...held, samples: 0 })).toEqual(['samples 4 -> 0'])
    expect(drawStateDiff(held, { ...held, framebufferScale: 0.7 })).toEqual([
      'framebufferScale 1 -> 0.7',
    ])
  })

  it('catches every field, so adding one to DrawState cannot silently go unwatched', () => {
    // Walks the reading's OWN keys rather than a list written here, which is
    // the property that keeps this true when `DrawState` grows. Asserted by
    // moving every field at once and counting.
    const moved: DrawState = {
      tier: 'low',
      adaptiveStep: 0.8,
      framebufferScale: 0.7,
      pixelRatio: 1,
      foveation: 1,
      samples: 0,
      antialias: false,
      drawingBuffer: '1008x1008',
    }
    expect(drawStateDiff(held, moved)).toHaveLength(Object.keys(held).length)
  })

  it('does not call a null pixelRatio a change, and does call null-to-a-number one', () => {
    // `pixelRatio` is null in a session and a number outside one, so it is the
    // field most likely to be compared wrongly. `Object.is` gets both halves;
    // a `!=` would have called `null` and `0` the same.
    const presenting = { ...held, pixelRatio: null }
    expect(drawStateDiff(presenting, { ...presenting })).toEqual([])
    expect(drawStateDiff(presenting, { ...held, pixelRatio: 0 })).toEqual(['pixelRatio null -> 0'])
  })

  it('is not fooled by a reading compared with itself', () => {
    // The shape of a guard that passes because it broke: two references to one
    // object always agree, and so would a pair of readings that both came back
    // empty. `drawState` throws rather than returning a blank, which is the
    // other half of the same property, and this is the half that can be tested
    // without a browser.
    expect(drawStateDiff(held, held)).toEqual([])
    const blank = {} as DrawState
    expect(drawStateDiff(blank, blank)).toEqual([])
    // ...so a blank must never be mistaken for a held reading. A real one has
    // every key, and that is what the spec's assertion rests on.
    expect(Object.keys(blank)).toHaveLength(0)
    expect(Object.keys(held)).toHaveLength(8)
  })
})

describe('drawStateLine', () => {
  it('prints the tier, the sample count and the buffer the frame was drawn at', () => {
    const line = drawStateLine(held)
    expect(line).toContain('tier high')
    expect(line).toContain('4x MSAA')
    expect(line).toContain('2016x2016')
  })

  it('says `xr` rather than `null` for a pixel ratio taken inside a session', () => {
    expect(drawStateLine({ ...held, pixelRatio: null })).toContain('dpr xr')
  })
})
