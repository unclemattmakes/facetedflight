// tests/unit/tank-feel.test.ts: a tank you can feel (DEV-640).
//
// The sim says everything; this file holds the presentation's edges to account:
// a dry press is a RISING edge on a tank that cannot light, never a held stick;
// the tank's three sounds are three different cues; the glow's ease is
// frame-rate independent and lands exactly.

import { describe, expect, it } from 'vitest'
import { actionsForEvent } from '@/audio/events'
import { createRisingEdge, easeLevel, isDryPress, TANK_FEEL } from '@/game/tank-feel'
import { boostAvailable, createEnergy, energySpec, stepEnergy } from '@/sim/energy'

describe('the dry click', () => {
  it('fires on the press, once, never on a held stick', () => {
    const edge = createRisingEdge()
    expect(edge.step(false)).toBe(false)
    expect(edge.step(true)).toBe(true)
    expect(edge.step(true)).toBe(false)
    expect(edge.step(true)).toBe(false)
    expect(edge.step(false)).toBe(false)
    expect(edge.step(true)).toBe(true)
  })

  it('is a dry press only when the tank cannot light and the ship is flying', () => {
    expect(isDryPress(true, false, true)).toBe(true)
    expect(isDryPress(true, true, true)).toBe(false)
    expect(isDryPress(false, false, true)).toBe(false)
    expect(isDryPress(true, false, false)).toBe(false)
  })

  it("agrees with the sim's own tank: an empty one is dry, a refilled one is not", () => {
    // The real tank, empty as Anniversary starts it (DEV-630), then run until
    // it can light: the dry click must follow `boostAvailable`, not its own idea.
    const spec = energySpec(0.16, undefined, 0, 0.25)
    const tank = createEnergy(spec, 0)
    expect(isDryPress(true, boostAvailable(tank), true)).toBe(true)
    for (let i = 0; i < 400; i++) stepEnergy(tank, spec, false, 0.0121999998)
    expect(boostAvailable(tank)).toBe(true)
    expect(isDryPress(true, boostAvailable(tank), true)).toBe(false)
  })

  it('trap 19: a second detector does not move the first', () => {
    const a = createRisingEdge()
    const b = createRisingEdge()
    a.step(true)
    expect(b.step(true)).toBe(true)
    expect(a.step(true)).toBe(false)
  })

  it('a reset forgets a held stick, so the next hold is a press', () => {
    const edge = createRisingEdge()
    edge.step(true)
    edge.reset()
    expect(edge.step(true)).toBe(true)
  })
})

describe('the three tank sounds are three cues', () => {
  it('fill, empty and dry each play their own', () => {
    const cue = (type: 'tank.fill' | 'tank.empty' | 'tank.dry'): string | undefined =>
      actionsForEvent({ type }, [])[0]?.cue
    expect(cue('tank.fill')).toBe('tank.fill')
    expect(cue('tank.empty')).toBe('tank.sputter')
    expect(cue('tank.dry')).toBe('tank.dry')
    expect(new Set([cue('tank.fill'), cue('tank.empty'), cue('tank.dry')]).size).toBe(3)
  })
})

describe('the glow and the lens ease', () => {
  it('rises when asked and falls when released, and lands EXACTLY at rest', () => {
    let level = 0
    for (let i = 0; i < 600; i++) level = easeLevel(level, 1, 0.12, 0.4, 1 / 60)
    expect(level).toBe(1)
    for (let i = 0; i < 600; i++) level = easeLevel(level, 0, 0.12, 0.4, 1 / 60)
    expect(level).toBe(0)
  })

  it('attacks faster than it releases', () => {
    const up = easeLevel(0, 1, TANK_FEEL.glowAttackSeconds, TANK_FEEL.glowReleaseSeconds, 0.05)
    const down =
      1 - easeLevel(1, 0, TANK_FEEL.glowAttackSeconds, TANK_FEEL.glowReleaseSeconds, 0.05)
    expect(up).toBeGreaterThan(down)
  })

  it('is frame-rate independent: one 1/30 step equals two 1/60 steps', () => {
    const one = easeLevel(0, 1, 0.12, 0.4, 1 / 30)
    const two = easeLevel(easeLevel(0, 1, 0.12, 0.4, 1 / 60), 1, 0.12, 0.4, 1 / 60)
    expect(one).toBeCloseTo(two, 12)
  })

  it('a non-positive dt leaves the level alone, a non-positive time constant snaps', () => {
    expect(easeLevel(0.3, 1, 0.12, 0.4, 0)).toBe(0.3)
    expect(easeLevel(0.3, 1, 0.12, 0.4, -1)).toBe(0.3)
    expect(easeLevel(0.3, 1, 0, 0.4, 1 / 60)).toBe(1)
  })

  it('the lens push is a few degrees: a push, not a zoom', () => {
    expect(TANK_FEEL.fovPushDegrees).toBeGreaterThan(0)
    expect(TANK_FEEL.fovPushDegrees).toBeLessThanOrEqual(5)
  })
})
