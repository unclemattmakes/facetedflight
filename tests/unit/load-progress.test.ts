// tests/unit/load-progress.test.ts — the readout that replaces a four-and-a-
// half-second lie.
//
// Three things here are guards rather than descriptions, and each of them is a
// way a progress bar is wrong that nobody reports as a bug:
//
//   1. **It must not go backwards.** The aggregate is a mean over channels, so
//      a channel opened after the others have reported would drop it. A bar
//      that goes backwards reads as broken even when the work behind it is
//      fine.
//   2. **It must not stop at 100% and sit there.** `buildWorld` loads three
//      terrains in parallel and THEN assembles rings, indicators, props,
//      dressing, the ship and the sky. A bar fed by `onProgress` alone reaches
//      the end while seconds of work remain — a new lie replacing the old one
//      — so the WORD changes when the work changes.
//   3. **A failure must end it.** The world promise can reject. The loud path
//      is `MissingAssetBaseUrlError` reaching the landing card, which is what
//      diagnosed the 2026-09-09 headset session; a readout that counted to 43%
//      and stopped would hold the button disabled for ever and hide it.

import { describe, expect, it } from 'vitest'
import { busyText, cardText, createLoadProgress, type LoadState } from '@/boot/load-progress'

const record = (p: ReturnType<typeof createLoadProgress>): LoadState[] => {
  const seen: LoadState[] = []
  p.subscribe((s) => seen.push(s))
  return seen
}

describe('the aggregate over parallel loaders', () => {
  it('averages the channels, so three terrains are one bar', () => {
    const p = createLoadProgress('Simonet Islands')
    const a = p.channel()
    const b = p.channel()
    a(1)
    expect(p.state.fraction).toBeCloseTo(0.5, 6)
    b(1)
    expect(p.state.fraction).toBe(1)
  })

  it('never goes backwards, even when a channel opens late', () => {
    // `buildWorld` opens all three before any reports, which is what the
    // comment there says — but the clamp is what makes that a guarantee rather
    // than a convention somebody can quietly break.
    const p = createLoadProgress('Kauai')
    const a = p.channel()
    a(1)
    expect(p.state.fraction).toBe(1)
    const b = p.channel()
    b(0)
    expect(p.state.fraction, 'a late channel must not drop the bar').toBe(1)
  })

  it('clamps a channel to 0..1 rather than trusting the loader', () => {
    const p = createLoadProgress('Mesa Canyon')
    const a = p.channel()
    a(5)
    expect(p.state.fraction).toBe(1)
    const q = createLoadProgress('Mesa Canyon')
    const b = q.channel()
    b(-5)
    expect(q.state.fraction).toBe(0)
  })

  it('notifies only when something actually moved', () => {
    // This fires once per terrain CHUNK — a few hundred times a load, on the
    // same frames the islands are generating.
    const p = createLoadProgress('Alpine Forest')
    const seen = record(p)
    const a = p.channel()
    a(0.5)
    a(0.5)
    a(0.5)
    // One for the subscribe, one for the move. Not four.
    expect(seen).toHaveLength(2)
  })
})

describe('the phases, so the bar never sits at 100%', () => {
  it('changes the word when the terrains are in', () => {
    const p = createLoadProgress('Simonet Islands')
    const a = p.channel()
    a(1)
    expect(cardText(p.state)).toContain('Simonet Islands')
    expect(cardText(p.state)).toContain('100%')
    p.assembling()
    expect(p.state.phase).toBe('assembling')
    expect(cardText(p.state)).not.toContain('%')
  })

  it('names the place, because a bare percentage buys the visitor nothing', () => {
    const p = createLoadProgress('Mesa Canyon')
    const a = p.channel()
    a(0.43)
    expect(cardText(p.state)).toBe('Loading Mesa Canyon… 43%')
  })

  it('says something short in the room, and nothing when it is done', () => {
    // The hangar draws its header as geometry across a holotable, so this is
    // the same word the room already used with the number it was missing.
    const p = createLoadProgress('Kauai')
    const a = p.channel()
    a(0.43)
    expect(busyText(p.state)).toBe('LOADING · 43%')
    p.assembling()
    expect(busyText(p.state)).toBe('LOADING')
    p.ready()
    expect(busyText(p.state), 'null clears the header').toBeNull()
  })

  it('refuses to go back to counting once it is past it', () => {
    const p = createLoadProgress('Simonet Islands')
    p.assembling()
    const a = p.channel()
    a(0.1)
    expect(p.state.phase).toBe('assembling')
    expect(p.state.fraction).toBe(1)
  })
})

describe('failure ends it', () => {
  it('reaches a terminal phase with the reason attached', () => {
    const p = createLoadProgress('Simonet Islands')
    p.channel()(0.4)
    p.failed('VITE_ASSET_BASE_URL is not set')
    expect(p.state.phase).toBe('failed')
    expect(p.state.error).toContain('VITE_ASSET_BASE_URL')
    // The two surfaces both say so rather than freezing mid-count.
    expect(cardText(p.state)).toBe('Could not load')
    expect(busyText(p.state)).toBe('FAILED')
  })

  it('does not let a late success paper over a failure', () => {
    const p = createLoadProgress('Simonet Islands')
    p.failed('boom')
    p.ready()
    expect(p.state.phase).toBe('failed')
  })
})

describe('a mission swap starts again', () => {
  it('resets the bar and renames the place', () => {
    const p = createLoadProgress('Simonet Islands')
    p.channel()(1)
    p.assembling()
    p.ready()
    p.restart('Alpine Forest')
    expect(p.state.phase).toBe('terrain')
    expect(p.state.fraction).toBe(0)
    expect(cardText(p.state)).toBe('Loading Alpine Forest… 0%')
  })

  it('drops the old channels, or the second load starts half done', () => {
    const p = createLoadProgress('Simonet Islands')
    p.channel()(1)
    p.restart('Kauai')
    const a = p.channel()
    a(0.5)
    expect(p.state.fraction).toBeCloseTo(0.5, 6)
  })
})
