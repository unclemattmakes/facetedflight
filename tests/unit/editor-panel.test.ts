// tests/unit/editor-panel.test.ts — the desk panel's node-testable half. DEV-473.
//
// What is held here:
//
//  1. FINISH_MARKER_POLICY, pinned by value (the HUD_RASTER_SHIPPED pattern).
//  2. Every tooltip is ONE line, and the ranges they quote are the format's
//     own limits rather than a second copy typed into the prose.
//  3. The readouts say what they claim: the finish's share and distance, the
//     ring count, and a distance a person reads.
//  4. The hoop's radius is the donor's own finish trigger on every HoverJet sky.
//
// The DOM half (the slider dragged with the mouse, every control's title) is
// `tests/e2e/editor-panel.spec.ts`.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { PLAYER_COURSE_LIMITS } from '@/content/player-course'
import { FINISH_MARKER_POLICY, finishRadiusOf } from '@/editor/desk/finish-marker'
import { finishReadout, formatDistance, PANEL_TIPS, ringsReadout } from '@/editor/desk/panel'
import { shippedLevels } from './helpers/content'

const hoverjets: Level[] = shippedLevels().filter((l) => l.vehicle === 'hoverjet')

describe('FINISH_MARKER_POLICY', () => {
  it('is pinned by value: moving one is an edit made on purpose', () => {
    expect(FINISH_MARKER_POLICY).toEqual({
      hoopSegments: 64,
      labelScreenHeight: 0.035,
      labelFontPixels: 48,
      labelLift: 0.35,
    })
  })
})

describe('the tooltips', () => {
  it('are one line each, and say something', () => {
    for (const [name, tip] of Object.entries(PANEL_TIPS)) {
      expect(tip.trim().length, name).toBeGreaterThan(10)
      expect(tip, name).not.toMatch(/\n/)
      // One line of a tooltip, not a paragraph.
      expect(tip.length, name).toBeLessThanOrEqual(120)
    }
  })

  it("quote the format's own limits, not a copy of them", () => {
    const g = PLAYER_COURSE_LIMITS.gapMetres
    const t = PLAYER_COURSE_LIMITS.timeLimitSeconds
    expect(PANEL_TIPS['gap-slider']).toContain(`${g.min}–${g.max} m`)
    expect(PANEL_TIPS['time-limit']).toContain(`${t.min}–${t.max}`)
  })

  it('leave the Start slider to DEV-475, which replaces it', () => {
    expect(Object.keys(PANEL_TIPS)).not.toContain('start')
  })
})

describe('the readouts', () => {
  it('say a distance the way a person reads it', () => {
    expect(formatDistance(0)).toBe('0 m')
    expect(formatDistance(849.6)).toBe('850 m')
    expect(formatDistance(1000)).toBe('1.0 km')
    expect(formatDistance(7_349)).toBe('7.3 km')
    expect(formatDistance(12_600)).toBe('13 km')
    expect(formatDistance(Number.NaN)).toBe('—')
  })

  it('put the finish at its share of the line, and that far along it', () => {
    expect(finishReadout(1, 8_000)).toBe('100 % · 8.0 km of 8.0 km')
    expect(finishReadout(0.5, 8_000)).toBe('50 % · 4.0 km of 8.0 km')
    expect(finishReadout(0.25, 1_200)).toBe('25 % · 300 m of 1.2 km')
    // No line yet: the share alone.
    expect(finishReadout(0.8, null)).toBe('80 %')
  })

  it('count the rings the gap makes, or say what is missing', () => {
    expect(ringsReadout(12, 8_000)).toBe('12 rings on 8.0 km of line.')
    expect(ringsReadout(1, 500)).toBe('1 ring on 500 m of line.')
    expect(ringsReadout(null, 500)).toBe('No rings yet on 500 m of line.')
    expect(ringsReadout(null, null)).toBe('Place two points to make a line.')
  })
})

describe('the finish hoop', () => {
  it("is the donor's own finish trigger on every HoverJet sky, never a typed size", () => {
    expect(hoverjets.length).toBeGreaterThan(0)
    for (const level of hoverjets) {
      const finish = level.finish
      expect(finish?.shape, level.id).toBe('sphereUnion')
      expect(finishRadiusOf(level), level.id).toBe(
        finish?.shape === 'sphereUnion' ? finish.radius : null,
      )
      expect(finishRadiusOf(level) ?? 0, level.id).toBeGreaterThan(0)
    }
  })

  it('is absent where the sky has no finish gate', () => {
    const level = hoverjets[0] as Level
    expect(finishRadiusOf({ ...level, finish: null } as unknown as Level)).toBeNull()
  })
})
