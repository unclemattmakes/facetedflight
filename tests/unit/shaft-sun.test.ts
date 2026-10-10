// tests/unit/shaft-sun.test.ts: the light blocker in the launch shaft (DEV-564).
//
// Matt, 2026-10-01: *"can you add a "light blocker" to the elevator shaft in
// all missions? right now the sun is affecting the cockpit when the ship is
// underground."* `render/elevator.ts`'s `shaftSunGain` fades the one sun by the
// eye's depth under the rim. What is held here is against things the gain does
// not compute: every rig's own lift and sun out of the level JSON, the
// elevator's own rim and bore (built by `createElevator`, as the game builds
// it), and `flight.ts`'s eye. No light is added or removed by any of it; that
// half is a single multiply in `boot/app.ts`'s frame loop.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EYE } from '@/game/flight'
import { createElevator, SHAFT_SUN_EDGE, shaftSunGain } from '@/render/elevator'
import { hangarSpecFor } from '@/sim/hangar'

interface Rig {
  readonly id: string
  readonly launch: {
    readonly rise: number
    readonly platform: { size: number[]; offset: number[]; shipOffset: number[] }
    readonly shaft: {
      segmentSpacing: number
      liveSegmentLocalY: number[]
      deadSegmentLocalY: number[]
    } | null
  } | null
  readonly sun: { readonly direction: number[] } | null
}

const LEVELS: Rig[] = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')))
  .map((l) => ({ id: l.id, launch: l.spawn?.launch ?? null, sun: l.lighting?.sun ?? null }))

const RIGS = LEVELS.filter((l) => l.launch?.platform && l.launch.shaft && l.sun)

const elevatorOf = (rig: Rig) => {
  const launch = rig.launch as NonNullable<Rig['launch']>
  return createElevator({
    platform: launch.platform,
    shaft: launch.shaft as NonNullable<NonNullable<Rig['launch']>['shaft']>,
    rise: launch.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })
}

const elevationDeg = (rig: Rig) =>
  (Math.asin(-((rig.sun as { direction: number[] }).direction[1] as number)) * 180) / Math.PI

describe('the light blocker in the launch shaft (DEV-564)', () => {
  it('finds the seven HoverJet rigs, and a sun on every one', () => {
    expect(RIGS.map((r) => r.id).sort()).toHaveLength(7)
  })

  it('blocks the sun at the bottom and lets it all in at the top, on every rig', () => {
    for (const rig of RIGS) {
      const elevator = elevatorOf(rig)
      const dir = (rig.sun as { direction: number[] }).direction
      const top = (rig.launch as { rise: number }).rise
      expect(shaftSunGain(0, elevator, EYE.y, dir), `${rig.id}: on the pad`).toBe(0)
      expect(shaftSunGain(top, elevator, EYE.y, dir), `${rig.id}: at the release`).toBe(1)
      // Where the eye clears the rim (`boot/app.ts`'s `eyeClears`), the sun is in.
      expect(
        shaftSunGain(elevator.rimY - EYE.y, elevator, EYE.y, dir),
        `${rig.id}: eye at the rim`,
      ).toBe(1)
      elevator.dispose()
    }
  })

  it('comes on once, over the last few metres of the climb, and never goes out again', () => {
    for (const rig of RIGS) {
      const elevator = elevatorOf(rig)
      const dir = (rig.sun as { direction: number[] }).direction
      const top = (rig.launch as { rise: number }).rise
      let last = 0
      let firstLight: number | null = null
      for (let rise = 0; rise <= top; rise += 0.05) {
        const g = shaftSunGain(rise, elevator, EYE.y, dir)
        expect(g, `${rig.id} at rise ${rise.toFixed(2)}: never goes down`).toBeGreaterThanOrEqual(
          last - 1e-12,
        )
        if (firstLight === null && g > 0) firstLight = rise
        last = g
      }
      const reach = elevator.boreRadius * Math.tan((elevationDeg(rig) * Math.PI) / 180)
      console.info(
        `DEV-564 ${rig.id}: sun ${elevationDeg(rig).toFixed(1)} deg, bore ${elevator.boreRadius.toFixed(2)} m, reach ${reach.toFixed(2)} m, light from rise ${firstLight?.toFixed(2)} of ${top.toFixed(2)}`,
      )
      // Dark for most of the ride on every rig, whatever its sun: 2016's
      // world comes on at 100.4 (`REVEAL_RISE`), and the light no earlier than
      // ten metres below that.
      expect(firstLight as number, `${rig.id}: dark through the climb`).toBeGreaterThan(90)
      // And not before the deepest point the sun can reach plus the soft edge.
      expect(firstLight as number, `${rig.id}: the bore's own reach`).toBeGreaterThan(
        elevator.rimY - EYE.y - reach - SHAFT_SUN_EDGE - 0.05,
      )
      elevator.dispose()
    }
  })

  it('lets a high sun further down the bore than a low one: the reach the header quotes', () => {
    const at = (id: string) => {
      const rig = RIGS.find((r) => r.id === id) as Rig
      const elevator = elevatorOf(rig)
      const reach = elevator.boreRadius * Math.tan((elevationDeg(rig) * Math.PI) / 180)
      elevator.dispose()
      return reach
    }
    // `render/elevator.ts`: "about 0.5 m on int_01 (4 degrees) and 7 m on rookie_01 (46.5)".
    expect(at('int_01_hoverJet')).toBeGreaterThan(0.3)
    expect(at('int_01_hoverJet')).toBeLessThan(0.7)
    expect(at('rookie_01_hoverJet')).toBeGreaterThan(6)
    expect(at('rookie_01_hoverJet')).toBeLessThan(8)
  })

  it('never touches a mission with no shaft: the JumpSeat pads, and any course without a lift', () => {
    const padded = LEVELS.filter((l) => !l.launch?.shaft && l.sun)
    expect(padded.length, 'the six JumpSeat missions').toBeGreaterThanOrEqual(6)
    for (const l of padded)
      for (const rise of [0, 50, 106.647])
        expect(shaftSunGain(rise, null, EYE.y, (l.sun as { direction: number[] }).direction)).toBe(
          1,
        )
  })

  it('blocks a sun below the horizon entirely until the eye is out', () => {
    const rim = { rimY: 104.447, boreRadius: 6 }
    expect(shaftSunGain(rim.rimY - EYE.y - 0.01, rim, EYE.y, [0, 0.1, 1])).toBeGreaterThan(0.99)
    expect(shaftSunGain(rim.rimY - EYE.y - SHAFT_SUN_EDGE, rim, EYE.y, [0, 0.1, 1])).toBe(0)
  })
})
