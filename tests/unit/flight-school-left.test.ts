// tests/unit/flight-school-left.test.ts — the HoverJet's flight plans read
// Flight School, Ring Attack, Free Flight, left to right. DEV-419.
//
// Matt, 2026-09-26: *"hoverjet flow: flight school should be the left-most
// table. in order -> flight school, ring attack, free flight"* — and, asked
// whether that is both aircraft, *"just hover jet"*.
//
// It REVERSES the day before (the DEV-379 follow-up, *"move flight school to the
// middle"*, which this file pinned under its old name, `flight-school-middle`).
// That arc was four wide on every aircraft — Ring Attack, Target Practice,
// Flight School, Free Flight — and the HoverJet drew it with a HOLE where the
// JumpSeat's Target Practice stands. So the order changing is half of it; the
// other half is that the plan arc is now the open aircraft's own plans, and
// nothing it does not fly holds a position on it.
//
// ── What is measured, and what is not ─────────────────────────────────────
//
// Every claim is a BEARING read off the arc the room deals (`hangarArcs`, the
// same `slotOrdersFor` → `pagesFor` → `stepBearings` path `applyPage` lays its
// tables with), or an ANGLE and a PROJECTION from the resting aim — the chair's
// yaw and pitch as `boot/app.ts` composes them, through a three.js camera with
// the renderer's own lens. Never a slot index read back to itself. The content
// is the real content off the disk, on both editions' fleets. Flight School is
// found by its mode row's `teaches`, never by its key.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { fleetOf } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { GameMode } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { MODES } from '@/game/modes'
import { variantStep } from '@/game/variant-stats'
import { baseFovFor } from '@/render/flat-fov'
import {
  GAZE_RADIUS,
  type HangarArc,
  hangarArcs,
  seatEyeLocal,
  seatPitchLocal,
  seatYawLocal,
  tableGazeLocal,
} from '@/render/hangar'
import { hangarSpecFor } from '@/sim/hangar'

const REPO = process.cwd()
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) as T
const ANNIVERSARY = readJson<Edition>('content/editions/anniversary.json')
const CLASSIC = readJson<Edition>('content/editions/classic.json')

/** `int_01`'s real room, as `level-select.test.ts` builds it. The angles do not depend on it. */
const SPEC = hangarSpecFor(9.35 / 2, 12)

const deg = (r: number): number => (r * 180) / Math.PI
const rad = (d: number): number => (d * Math.PI) / 180

/**
 * The flat camera's vertical lens, READ from `render/renderer.ts` rather than
 * retyped, then put through the preset exactly as `render/flat-fov.ts` does.
 */
const rendererFov = (): number => {
  const source = fs.readFileSync(path.join(REPO, 'src/render/renderer.ts'), 'utf8')
  const match = /new THREE\.PerspectiveCamera\(\s*(\d+(?:\.\d+)?)\s*,/.exec(source)
  if (!match) throw new Error('renderer.ts no longer builds its camera with a literal lens')
  return Number(match[1])
}

/**
 * The resting view on a flat 16:9 screen: the eye in the chair, the rig's yaw
 * and the camera's pitch composed as `boot/app.ts` composes them (`rig x
 * camera`, yaw then pitch, 'YXZ'), with nothing looked. Hangar-local space:
 * `HANGAR_SPIN` turns the room and the chair together and cancels out.
 */
const restingCamera = (edition: Edition): THREE.PerspectiveCamera => {
  const camera = new THREE.PerspectiveCamera(
    baseFovFor(edition.render.flatFov, rendererFov()),
    16 / 9,
    0.08,
    100,
  )
  const eye = seatEyeLocal(SPEC)
  camera.position.set(eye.x, eye.y, eye.z)
  camera.quaternion.setFromEuler(new THREE.Euler(seatPitchLocal(), seatYawLocal(), 0, 'YXZ'))
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  return camera
}

/** One table on an arc, measured from the resting aim. */
interface Seen {
  readonly key: string
  /** True angle between the resting aim and the eye → table-centre ray, degrees. */
  readonly fromRest: number
  /** Where the table's gaze window reaches across the frame, as NDC x (left, right). */
  readonly ndcLeft: number
  readonly ndcRight: number
  readonly ndcY: number
  readonly inFront: boolean
  readonly bearingDegrees: number
}

const seen = (camera: THREE.PerspectiveCamera, key: string, bearingDegrees: number): Seen => {
  const c = tableGazeLocal(SPEC, rad(bearingDegrees))
  const centre = new THREE.Vector3(c.x, c.y, c.z)
  const aim = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const toTable = centre.clone().sub(camera.position).normalize()
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const ndc = (p: THREE.Vector3) => p.clone().project(camera)
  const a = ndc(centre.clone().addScaledVector(right, -GAZE_RADIUS))
  const b = ndc(centre.clone().addScaledVector(right, GAZE_RADIUS))
  return {
    key,
    fromRest: deg(Math.acos(Math.min(1, Math.max(-1, aim.dot(toTable))))),
    ndcLeft: Math.min(a.x, b.x),
    ndcRight: Math.max(a.x, b.x),
    ndcY: ndc(centre).y,
    inFront: toTable.dot(aim) > 0,
    bearingDegrees,
  }
}

/** Does this plan TEACH? The mode row's own answer, as the room asks it. */
const teaches = (mode: string): boolean =>
  Object.hasOwn(MODES, mode) && MODES[mode as GameMode].teaches

/** The level index a room on `edition` is handed: its fleet, the listed courses. */
const cardsOn = (edition: Edition): Promise<MissionCard[]> =>
  loadMissionIndex(
    undefined,
    fleetOf(() => edition),
  )

/** Every arc a room on `edition` deals, with the variant step where it has one. */
const arcsOn = async (edition: Edition): Promise<readonly HangarArc[]> =>
  hangarArcs(
    await cardsOn(edition),
    variantStep(
      () => edition,
      aircraftFor,
      () => null,
    ),
  )

/** An aircraft's flight-plan arc (the first, where a variant step deals one per variant). */
const plansOf = (arcs: readonly HangarArc[], vehicle: string): HangarArc => {
  const arc = arcs.find((a) => a.view === 'modes' && a.path[0] === vehicle)
  if (!arc) throw new Error(`no ${vehicle} flight-plan arc`)
  return arc
}

/** The plan keys an arc DRAWS, left to right by bearing. */
const leftToRight = (arc: HangarArc): string[] =>
  arc.plates
    .filter((p) => p.key !== null)
    .slice()
    .sort((a, b) => a.bearingDegrees - b.bearingDegrees)
    .map((p) => p.key as string)

/** The flight plans the content gives one aircraft, whatever order the room deals them in. */
const plansFlown = (cards: readonly MissionCard[], vehicle: string): Set<string> =>
  new Set(cards.filter((c) => c.vehicle === vehicle).map((c) => c.mode))

describe("the HoverJet's flight plans: Flight School, Ring Attack, Free Flight (DEV-419)", () => {
  for (const [name, edition] of [
    ['Anniversary', ANNIVERSARY],
    ['Classic', CLASSIC],
  ] as const) {
    it(`${name}: left to right, Flight School then Ring Attack then Free Flight, and nothing between`, async () => {
      const arc = plansOf(await arcsOn(edition), 'hoverjet')
      const order = leftToRight(arc)
      const school = order.filter(teaches)
      // The premise: one teaching plan, and it is the HoverJet's.
      expect(school, 'the HoverJet deals exactly one plan that teaches').toHaveLength(1)
      expect(order, "Matt's order, off the arc's bearings").toEqual([
        school[0],
        'ringAttack',
        'freeFlight',
      ])
      // "Nothing between": the arc is exactly as wide as the plans it draws.
      // The four-wide arc this replaces had an undrawn position — Target
      // Practice's, which the HoverJet does not fly — between Ring Attack and
      // Flight School.
      expect(
        arc.plates.map((p) => p.key),
        'a position on the HoverJet plan arc that holds no plan',
      ).not.toContain(null)
      expect(
        arc.plates.every((p) => p.live),
        'every HoverJet plan table is live',
      ).toBe(true)
      // Evenly spaced: one table step between neighbours, so the row reads as a
      // row and not as two tables and a stray.
      const bearings = arc.plates.map((p) => p.bearingDegrees).sort((a, b) => a - b)
      for (let i = 1; i < bearings.length; i++) {
        expect((bearings[i] as number) - (bearings[i - 1] as number)).toBeCloseTo(30, 9)
      }
    })

    it(`${name}: the plan arc is each aircraft's OWN plans — the JumpSeat keeps its one`, async () => {
      // *"just hover jet"*: the reorder is the HoverJet's. What every other
      // aircraft draws is exactly the plans it flies, each once, and nothing
      // it does not fly — not a dead plate and not an undrawn position.
      const cards = await cardsOn(edition)
      const arcs = await arcsOn(edition)
      const vehicles = [...new Set(cards.map((c) => c.vehicle))]
      expect(vehicles.length, 'the premise: more than one aircraft').toBeGreaterThan(1)
      for (const vehicle of vehicles) {
        const arc = plansOf(arcs, vehicle)
        expect(new Set(leftToRight(arc)), `${vehicle}'s plan arc`).toEqual(
          plansFlown(cards, vehicle),
        )
        expect(arc.plates, `${vehicle}: one position per plan`).toHaveLength(
          plansFlown(cards, vehicle).size,
        )
      }
      expect(leftToRight(plansOf(arcs, 'jumpseat'))).toEqual(['targetPractice'])
    })

    it(`${name}: from rest, Ring Attack is under the pointer and every plan table is in a flat 16:9 frame`, async () => {
      const arcs = (await arcsOn(edition)).filter((a) => a.view === 'modes')
      const camera = restingCamera(edition)
      const hover = plansOf(arcs, 'hoverjet')
      const ring = hover.plates.find((p) => p.key === 'ringAttack')
      expect(ring, 'the premise: a Ring Attack table').toBeDefined()
      // The middle of three is the table under the resting pointer
      // (`tableBearings`): the plan a Quick Race also names.
      expect(
        seen(camera, 'ringAttack', (ring as HangarArc['plates'][number]).bearingDegrees).fromRest,
        'Ring Attack, degrees from the resting aim',
      ).toBeLessThan(0.5)
      let checked = 0
      for (const arc of arcs) {
        for (const p of arc.plates) {
          if (p.key === null) continue
          const t = seen(camera, p.key, p.bearingDegrees)
          const where = `${arc.path.join(' / ')}: ${t.key}`
          expect(t.inFront, `${where} is behind the eye`).toBe(true)
          // The whole gaze WINDOW, edge to edge, not only the centre.
          expect(t.ndcLeft, `${where}'s left edge, NDC`).toBeGreaterThan(-1)
          expect(t.ndcRight, `${where}'s right edge, NDC`).toBeLessThan(1)
          expect(Math.abs(t.ndcY), `${where}, NDC y`).toBeLessThan(1)
          // And inside the ±45 degrees a seated head turns through comfortably.
          expect(t.fromRest, `${where}, degrees from the resting aim`).toBeLessThan(45)
          checked++
        }
      }
      expect(checked, 'the premise: tables were measured').toBeGreaterThan(3)
    })
  }

  it('rests the pointer ON a position on every arc of both editions', async () => {
    // DEV-203's layout property, which the four-wide centred plan arc gave up
    // (the pointer rested BETWEEN two plans) and DEV-419 gives back: every
    // shipped plan arc is now an odd number of the aircraft's own plans.
    for (const edition of [ANNIVERSARY, CLASSIC]) {
      const camera = restingCamera(edition)
      for (const arc of await arcsOn(edition)) {
        const nearest = Math.min(
          ...arc.plates.map((p) => seen(camera, p.key ?? '', p.bearingDegrees).fromRest),
        )
        // DEV-858: arcs are symmetric about the eye line, so an odd arc has a table
        // under the pointer and an even one has the pointer between its middle two:
        // never more than half a step from one.
        expect(
          nearest,
          `${arc.view} ${arc.path.join(' / ')}: a position at most half a step from the pointer`,
        ).toBeLessThan(arc.plates.length % 2 === 1 ? 0.5 : 15.5)
      }
    }
  })
})
