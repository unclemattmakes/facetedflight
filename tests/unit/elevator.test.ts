// tests/unit/elevator.test.ts — the platform, the shaft, and the seven segments
// that are switched off.
//
// The interesting assertions here are not about geometry. They are about the
// EXTRACTION being honest, because this is the third component in a row on this
// elevator whose serialised state and shipped state disagree:
//
//   `Mover_Lift`      tuned to 108.5, `move` never set        -> never ran
//   `Timer_Race`      tuned 3 x 1 s, `useCountdown` 0         -> never ran
//   `ent_elevatorShaft_01..07`  authored and positioned, `m_IsActive: 0`
//
// A port that reads the first field it finds gets a 108.5 m lift with a
// countdown, climbing an eight-storey shaft. None of that is the game.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createElevator, type Elevator } from '@/render/elevator'
import { evaluateCurve } from '@/sim/art-lean'
import { FIXED_DT } from '@/sim/constants'
import { hangarSpecFor } from '@/sim/hangar'
import { createClock, stepFixed } from '@/sim/integrator'
import {
  createLaunch,
  type LaunchSpec,
  launchHoldsShip,
  startLaunch,
  stepLaunch,
  topRise,
} from '@/sim/launch'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LAUNCH = int01.spawn.launch as {
  rise: number
  platform: {
    mesh: string
    meshShippable: boolean
    size: number[]
    offset: number[]
    scale: number
    shipOffset: number[]
  }
  shaft: {
    meshes: string[]
    meshShippable: boolean
    segmentsAuthored: number
    segmentSpacing: number
    liveSegmentLocalY: number[]
    deadSegmentLocalY: number[]
  }
}

const build = () =>
  createElevator({
    platform: LAUNCH.platform,
    shaft: LAUNCH.shaft,
    rise: LAUNCH.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })

describe('what the extractor found', () => {
  it('measured the platform off the mesh AABB, not off a guess', () => {
    // `Projector04-Faceted`'s `m_LocalAABB` extent is (2.769, 0.518, 2.748),
    // so 5.54 x 1.04 x 5.50 m of mesh, at a prefab scale of 1.688.
    const [w, h, d] = LAUNCH.platform.size as [number, number, number]
    expect(w).toBeCloseTo(2.76853728 * 2 * LAUNCH.platform.scale, 1)
    expect(h).toBeCloseTo(0.517961562 * 2 * LAUNCH.platform.scale, 1)
    expect(d).toBeCloseTo(2.74752998 * 2 * LAUNCH.platform.scale, 1)
    // Big enough to stand a 6.8 m ship on, which is the sanity check that the
    // scale was applied at all.
    expect(w).toBeGreaterThan(6.8)
  })

  it('records that the meshes cannot ship', () => {
    // `Converted_Faceted_Meshes/` is the folder `content/MANIFEST.md` marks
    // CONFIRM, and the shaft pieces are `_pwn` PolyWorld conversions. CLAUDE.md
    // rule 7: never commit one. The paths travel as EVIDENCE; the art is ours.
    expect(LAUNCH.platform.meshShippable).toBe(false)
    expect(LAUNCH.shaft.meshShippable).toBe(false)
    expect(LAUNCH.platform.mesh).toContain('Converted_Faceted_Meshes')
    for (const m of LAUNCH.shaft.meshes) expect(m).toContain('FF_WorldTour/meshes/converted')
  })

  it('found EIGHT authored shaft segments and only ONE alive', () => {
    // The finding this file exists for. Seven of eight are `m_IsActive: 0`, so
    // the 106 m ride is open air with a collar near the top.
    expect(LAUNCH.shaft.segmentsAuthored).toBe(8)
    expect(LAUNCH.shaft.liveSegmentLocalY).toEqual([96])
    expect(LAUNCH.shaft.deadSegmentLocalY).toHaveLength(7)
    // They tile at 12 m, which is what makes it obvious they were MEANT to be a
    // continuous shaft — and were then turned off one by one.
    const all = [...LAUNCH.shaft.deadSegmentLocalY, ...LAUNCH.shaft.liveSegmentLocalY].sort(
      (a, b) => a - b,
    )
    for (let i = 1; i < all.length; i++) {
      expect((all[i] as number) - (all[i - 1] as number)).toBe(LAUNCH.shaft.segmentSpacing)
    }
  })

  it('puts the live segment near the TOP of the ride, not the bottom', () => {
    // 96 m of a 106.6 m rise. You see it in the last couple of seconds, which is
    // why the middle of the ride looking empty is correct rather than broken.
    const [only] = LAUNCH.shaft.liveSegmentLocalY as [number]
    expect(only / LAUNCH.rise).toBeGreaterThan(0.85)
    expect(only).toBeLessThan(LAUNCH.rise)
  })
})

describe('the geometry it builds', () => {
  it('hangs the deck below the ship, not through it', () => {
    // The prefab parents the ship at `PlayerShipRoot` (0, 0.67, 1.3) and the
    // platform mesh at (0, -1.53, 0). So relative to the ship the deck top is
    // 2.2 m down — it must never be at or above zero, or the ship is inside it.
    const elevator = build()
    const platform = elevator.object.getObjectByName('elevator-platform')
    expect(platform).toBeDefined()
    expect((platform as THREE.Object3D).position.y).toBeLessThan(-1.5)
    elevator.dispose()
  })

  it('rides, while the shaft stays put', () => {
    // The whole point of the split. The platform climbs 106 m; the shaft is
    // scenery you pass.
    const elevator = build()
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    const shaft = elevator.object.getObjectByName('elevator-shaft') as THREE.Object3D
    const restY = platform.position.y
    const shaftY = shaft.position.y

    elevator.setRise(LAUNCH.rise)
    expect(platform.position.y - restY).toBeCloseTo(LAUNCH.rise, 6)
    expect(shaft.position.y).toBe(shaftY)

    elevator.setRise(0)
    expect(platform.position.y).toBeCloseTo(restY, 6)
    elevator.dispose()
  })

  it('leaves room for the platform to pass through the shaft', () => {
    // Pillars set outside the deck's own footprint. If they were inside it the
    // platform would visibly intersect them on the way up, which is the kind of
    // thing that is obvious in a headset and invisible in a unit test unless the
    // test is this one.
    const elevator = build()
    const shaft = elevator.object.getObjectByName('elevator-shaft') as THREE.Object3D
    const deckRadius =
      Math.max(LAUNCH.platform.size[0] as number, LAUNCH.platform.size[2] as number) / 2

    let checked = 0
    shaft.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BoxGeometry)) return
      const r = Math.hypot(mesh.position.x, mesh.position.z)
      expect(r, 'pillar inside the deck').toBeGreaterThan(deckRadius)
      checked++
    })
    // Six a segment, however many segments the spec asks for. The first version
    // of this hard-coded SIX — the shipped build's one live segment — and broke
    // the moment DEV-024c restored the other seven, which is the value-not-the-
    // claim trap again: the claim is "every pillar clears the deck", and "there
    // are exactly six of them" is a different sentence that happened to be true.
    const segments =
      LAUNCH.shaft.liveSegmentLocalY.length + (LAUNCH.shaft.deadSegmentLocalY?.length ?? 0)
    expect(checked).toBe(6 * segments)
    expect(checked, 'there were pillars to check at all').toBeGreaterThan(0)
    elevator.dispose()
  })

  it('builds every AUTHORED segment, not just the one 2016 left enabled', () => {
    // DEV-024c. 2016 authored eight and disabled seven, which was invisible
    // while the ride was cut and you started at the top. With the hangar at the
    // bottom it is not: the room's ceiling closes at 15 m and the next
    // structure was at 96, so you sat in an "underground hangar" and looked up
    // into 79 m of open sky.
    const elevator = build()
    const shaft = elevator.object.getObjectByName('elevator-shaft') as THREE.Object3D
    const authored =
      LAUNCH.shaft.liveSegmentLocalY.length + (LAUNCH.shaft.deadSegmentLocalY?.length ?? 0)
    expect(shaft.children.length).toBe(authored)
    expect(authored, 'the fixture has the dead ones').toBeGreaterThan(1)

    // Evenly spaced, in order. A shaft with a gap in it is a shaft you can see
    // daylight through, which is the whole thing this fixes — and a gap is
    // exactly what a sort-order slip would produce.
    const ys = shaft.children.map((c) => c.position.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect((ys[i] as number) - (ys[i - 1] as number), `gap ${i}`).toBeCloseTo(
        LAUNCH.shaft.segmentSpacing,
        6,
      )
    }
    elevator.dispose()
  })

  it('disposes everything it made', () => {
    // A launch elevator is built once per run and thrown away on restart. The
    // geometry is small but the habit is not optional in a long session.
    const elevator = build()
    let geometries = 0
    elevator.object.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) geometries++
    })
    expect(geometries).toBeGreaterThan(6)
    expect(() => elevator.dispose()).not.toThrow()
  })
})

// ── DEV-445: the deck is drawn where the frame is, not where the step is ────
//
// Matt: *"the "elevator" model is very jittery during the elevator ride up."*
// The ride below is stepped the way `boot/app.ts` steps it — `stepFixed`, then
// `stepLaunch` and `setRise` on every fixed step while the lift holds the ship —
// and drawn once per display frame. What a frame SHOULD show is the clip at the
// moment the frame depicts, which the interpolation puts `1 - alpha` of a step
// behind the sim (`sim/integrator.ts`): the moment the ship, and the eye in it,
// are drawn at. So the reference is 2016's curve and the clock, never the
// elevator's own arithmetic, and a deck that disagrees with it by an amount that
// changes frame to frame is a deck that judders under the eye.
//
// The eye itself is `flight.render`'s and needs a loaded aircraft; the browser
// half, eye and deck in world space, is `tests/e2e/lift-judder.spec.ts`.
describe('DEV-445: the platform is drawn between the last two steps', () => {
  const launchJson = int01.spawn.launch as unknown as {
    keys: LaunchSpec['keys']
    releaseAtSeconds: number
  }
  const spec: LaunchSpec = {
    keys: launchJson.keys,
    releaseAtSeconds: launchJson.releaseAtSeconds,
    countdownSteps: 0,
    countdownStepSeconds: 0,
    skipRide: false,
  }

  /**
   * One whole ride at `frameSeconds` a frame. `draw` is what the frame does
   * with the lift after the steps. Returns the deck's error against the clip,
   * worst frame-to-frame change and worst absolute, in metres.
   */
  const ride = (frameSeconds: number, draw: (e: Elevator, alpha: number) => void) => {
    const elevator = build()
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    const restY = platform.position.y
    const clock = createClock()
    const launch = createLaunch(spec)
    startLaunch(launch, spec)
    let previous: number | null = null
    let judder = 0
    let worst = 0
    let frames = 0
    while (launchHoldsShip(launch)) {
      const alpha = stepFixed(clock, frameSeconds, (dt) => {
        if (!launchHoldsShip(launch)) return
        stepLaunch(launch, spec, dt)
        elevator.setRise(launch.rise)
      })
      if (!launchHoldsShip(launch)) break
      draw(elevator, alpha)
      const depicted = Math.max(
        0,
        Math.min(launch.elapsed - (1 - alpha) * FIXED_DT, spec.releaseAtSeconds),
      )
      const error = platform.position.y - restY - evaluateCurve({ keys: spec.keys }, depicted)
      if (previous !== null) judder = Math.max(judder, Math.abs(error - previous))
      worst = Math.max(worst, Math.abs(error))
      previous = error
      frames++
    }
    elevator.dispose()
    return { judder, worst, frames }
  }

  const BEATING = [
    ['60 Hz', 1 / 60],
    ['90 Hz', 1 / 90],
    ['120 Hz', 1 / 120],
  ] as const
  /** A millimetre: float noise and the lerp's curvature error sit far under it, a step's climb far over. */
  const BOUND = 0.001

  for (const [label, frameSeconds] of BEATING) {
    it(`rendered at ${label}, the deck holds within a millimetre of the clip at the frame's moment`, () => {
      const r = ride(frameSeconds, (e, alpha) => e.render(alpha))
      expect(r.frames, 'a whole ride was drawn').toBeGreaterThan(13 / frameSeconds)
      expect(r.judder, 'frame-to-frame change of the deck against the clip').toBeLessThan(BOUND)
      expect(r.worst, 'and never off it').toBeLessThan(BOUND)
    })
  }

  it('drawn at the step alone — the base — it saws by most of a step at every beating rate, and not at the sim rate', () => {
    // The mechanism, reproduced: nothing but `setRise`, as `boot/app.ts` did
    // before this row. At 60, 90 and 120 Hz `alpha` beats against the step and
    // the error jumps by a large fraction of one step's climb, up to 0.20 m
    // at the clip's 16.6 m/s peak. At exactly one step a frame `alpha`
    // holds still, so the deck is a whole step AHEAD but steadily so — the
    // signature of an interpolation mismatch rather than of anything else.
    for (const [label, frameSeconds] of BEATING) {
      const stepped = ride(frameSeconds, () => {})
      expect(stepped.judder, `${label}: the base judders`).toBeGreaterThan(0.05)
    }
    const control = ride(FIXED_DT, () => {})
    // Not under the millimetre: a lead of one whole step's climb changes as the
    // lift's SPEED does, and the clip's hardest ease (the key at 13.17 s) is
    // about 19 m/s², so the lead moves by 19 x 12.2 ms² = 2.8 mm a frame there.
    // Smooth, and sixty times under the beat.
    expect(control.judder, 'at the sim rate: steady').toBeLessThan(0.005)
    expect(control.worst, 'though a whole step ahead of the eye').toBeGreaterThan(0.1)
  })

  it('collapses onto the first step, so a lift built at the top does not streak up from the floor', () => {
    // `?ride=0` and every retry: the launch sits at `topRise` from its first
    // step. A pair that began at zero would draw one frame between the floor
    // and the top. The ship's pair starts where the ship is; so does this one.
    const elevator = build()
    const platform = elevator.object.getObjectByName('elevator-platform') as THREE.Object3D
    const restY = platform.position.y
    const top = topRise(spec)
    elevator.setRise(top)
    elevator.render(0)
    expect(platform.position.y - restY).toBeCloseTo(top, 9)
    // And from then on it is a pair: half way from the top back to the floor.
    elevator.setRise(0)
    elevator.render(0.5)
    expect(platform.position.y - restY).toBeCloseTo(top / 2, 9)
    elevator.dispose()
  })
})
