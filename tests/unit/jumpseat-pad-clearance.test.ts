// tests/unit/jumpseat-pad-clearance.test.ts — every pad can be landed on. DEV-345.
//
// ── The claim ─────────────────────────────────────────────────────────────
//
// On Anniversary, **no live JumpSeat pad's landing zone is inside a prop
// collider**: the bullseye plate, over its whole footprint, from the plate to
// 20 m above it, touches nothing the ship would bounce off or break. Before
// DEV-345 that was false on seven of the pads, and two of them decided whether
// a mission could be finished at all:
//
//   int_01_jumpSeat pad 5, adv_02_jumpSeat pad 2   Simonet's sea stack. The pad
//       is built on a shoulder of the rock and DEV-213's convex hull wrapped
//       over it: the bullseye was 5.3 m / 11.1 m clear of the rock and
//       22.4 m / 12.1 m inside the hull. The autopilot struck the hull for
//       ~15,000 ticks beside pad 5, ran the tank dry and fell in the sea, so
//       `completion.spec.ts` could not finish int_01. FIXED by colliding on the
//       rock behind the hull (`sim/props/landmark-mesh.ts`) — 2016's own
//       `MeshCollider`, `m_Convex: 0`.
//   rookie_01 pads 2 and 4, int_02 pads 3, 5 and 8   Anniversary's unbaked
//       scatter (DEV-102/134) standing trees in the bowl, one 29 m above the
//       plate. FIXED by clearing each live pad's own landing surface from the
//       scatter (`padClearings`), the way DEV-100 clears a launch deck.
//
// ── What is swept, and against what ───────────────────────────────────────
//
// The forest is built the way `boot/app.ts` builds it for the mission: the
// Anniversary preset's scale, unbaked passes, slope limit and ground snap, the landmarks
// and the mission's own props, and the ground cleared by BOTH the authored
// volumes (`content/no-prop-volumes.json`, resolved against this mission's
// spawn and gates) and the pad clearings. Every one of those moves a collider;
// a sweep that dropped one would measure a forest nobody flies.
//
// The query is `propPenetrationAt` — the game's own, through the hash — at a
// 5 x 5 grid over each bullseye plate in its own axes, at six heights, with a
// level hull. `prop-hash-reach.test.ts` holds that query to a brute-force
// sweep; the brute one is used here only to NAME what a failure touched.
//
// The centre of the plate alone finds four of the seven; the grid finds all
// of them. A landing is anywhere on the plate.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import type { NoPropVolumeFile } from '@/content/no-prop-volumes'
import { autopilotWaypointsFor } from '@/game/jumpseat-flight'
import { courseGates } from '@/game/mission'
import { terrainOriginSim } from '@/game/mission-shape'
import { padClearings, resolveNoPropVolumes } from '@/game/props/no-prop-volumes'
import { livePads, padSurfaces, padZones } from '@/game/targets'
import { environmentTerrains } from '@/game/terrain/load-terrain'
import { insideAnyClearing, type NoPropVolume } from '@/sim/props/clearing'
import { type PropCollisionSpec, propPenetrationAt } from '@/sim/props/collision'
import { meshSignedDistance } from '@/sim/props/landmark-mesh'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import { JUMPSEAT_MISSIONS, jumpSeatHeightField, loadJumpSeatLevel } from './helpers/jumpseat-run'
import { forestFor, haveForest, propContactsBrute } from './helpers/prop-forest'
import { REPO as ROOT } from './helpers/repo-root'
import { loadLevelJson, MISSIONS } from './helpers/terrain-field'

const EDITION = anniversary as unknown as {
  gameplay: { propCollision: PropCollisionSpec }
  props: {
    scale: Record<string, unknown>
    unbakedPasses: { enabled: boolean }
    groundSnap: { enabled: boolean; sink: number }
    maxSlope: { enabled: boolean; sin: number }
  }
}
const HULL = HOVERJET_GROUND.collision.hull
const LEVEL = { x: 0, y: 0, z: 0, w: 1 }
/** Metres above the plate a landing passes through. The finding's "up to ~20 m". */
const HEIGHTS = [0, 2.5, 5, 10, 15, 20] as const

/** The terrain origin `boot/app.ts` resolves every volume against, SIM space. */
const originOf = (level: Level): readonly number[] =>
  terrainOriginSim(
    environmentTerrains(level.environment).land,
    level.worldOffset as unknown as number[],
  ).position

/**
 * DEV-287's authored volumes for this mission, resolved against its spawn and
 * gates exactly as `boot/app.ts` resolves them — the anchors built the way
 * `no-prop-volumes.test.ts` builds them.
 */
const authoredGroundOf = (level: Level): readonly NoPropVolume[] => {
  const file = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content', 'no-prop-volumes.json'), 'utf8'),
  ) as NoPropVolumeFile
  return resolveNoPropVolumes(file, {
    environmentId: level.environment,
    missionId: level.id,
    origin: originOf(level),
    anchors: {
      spawn: { x: level.spawn.pos[0] as number, z: -(level.spawn.pos[2] as number) },
      gates: courseGates(level).map((g) => ({ x: g.centre.x, z: g.centre.z })),
    },
  }).volumes
}

/** The whole list `boot/app.ts` hands `loadProps`: the authored volumes, then the pads. */
const clearedGroundOf = (level: Level): NoPropVolume[] => [
  ...authoredGroundOf(level),
  ...padClearings(padSurfaces(level), originOf(level)),
]

/** Points over a plate: a 5 x 5 grid in its own axes, corners included. */
const platePoints = (w: ReturnType<typeof autopilotWaypointsFor>[number]) => {
  const out: { x: number; y: number; z: number }[] = []
  const [ax, , az] = w.axes
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const lx = (i / 2) * w.half.x
      const lz = (j / 2) * w.half.z
      for (const dy of HEIGHTS) {
        out.push({
          x: w.centre.x + ax.x * lx + az.x * lz,
          y: w.centre.y + dy,
          z: w.centre.z + ax.z * lx + az.z * lz,
        })
      }
    }
  }
  return out
}

// ── 1. the clearing is the pad's own ground (no assets needed) ────────────

describe('DEV-345: each live pad clears its own landing surface', () => {
  it('a clearing holds the plates of the pad it was derived from', () => {
    // A RELATIONSHIP through a second path: the plates come off `padZones`,
    // which reads `zone.pos` and composes `zone.quat`; the clearing comes off
    // `solid.pos` through `padSurfaces`. A sign slip in either frame puts the
    // clearing kilometres from its plates, and this is where it shows.
    //
    // Every plate's CENTRE, and every corner of the BULLSEYE — the landing zone
    // the sweep below certifies. Not every corner of every plate: the 25-point
    // triggers are generous boxes whose outer corners reach ~21 m, past the
    // 20.3 m bowl they score. You land on the SURFACE, and the surface is what
    // `solid.outer` measures (Matt's call against the landing trigger's 28.4).
    let pads = 0
    for (const id of JUMPSEAT_MISSIONS) {
      const level = loadJumpSeatLevel(id)
      const origin = originOf(level)
      const clearings = padClearings(padSurfaces(level), origin)
      expect(clearings, `${id}: one clearing per live pad`).toHaveLength(livePads(level).length)
      for (const zone of padZones(level)) {
        const clearing = clearings[zone.pad] as NoPropVolume
        const [ax, , az] = zone.axes
        const reach = zone.points === 100 ? [-1, 1] : [0]
        for (const sx of reach) {
          for (const sz of reach) {
            const x = zone.centre.x + ax.x * zone.half.x * sx + az.x * zone.half.z * sz
            const z = zone.centre.z + ax.z * zone.half.x * sx + az.z * zone.half.z * sz
            expect(
              insideAnyClearing(x - (origin[0] ?? 0), z - (origin[2] ?? 0), [clearing]),
              `${id} pad ${zone.pad}: a ${zone.points}-point plate is outside its clearing`,
            ).toBe(true)
          }
        }
      }
      pads += clearings.length
    }
    // Loud: six missions and not one pad would pass every check above.
    expect(pads).toBeGreaterThan(JUMPSEAT_MISSIONS.length)
  })

  it('a mission with no pads clears nothing', () => {
    for (const id of MISSIONS) {
      if ((JUMPSEAT_MISSIONS as readonly string[]).includes(id)) continue
      const level = loadLevelJson(id) as Level
      expect(padSurfaces(level), id).toEqual([])
    }
  })
})

// ── 2. the sweep (needs the forest) ───────────────────────────────────────

describe.skipIf(!haveForest)('DEV-345: no live pad is inside a prop collider', () => {
  const forestOf = (level: Level, cleared: readonly NoPropVolume[]) =>
    forestFor(level.environment, jumpSeatHeightField(level), {
      spec: EDITION.gameplay.propCollision,
      scale: EDITION.props.scale,
      unbakedPasses: EDITION.props.unbakedPasses.enabled,
      groundSnapSink: EDITION.props.groundSnap.enabled ? EDITION.props.groundSnap.sink : null,
      // DEV-356: the steep facets are bare too. After the volumes, as the game
      // orders them, so the pad clearings' count does not depend on it.
      maxSlope: EDITION.props.maxSlope.enabled ? EDITION.props.maxSlope.sin : null,
      landmarks: true,
      missionProps: level.props ?? null,
      noPropVolumes: cleared,
    })

  it('the whole bullseye plate, plate to +20 m, touches nothing — on all six missions', {
    timeout: 120_000,
  }, () => {
    const failures: string[] = []
    let swept = 0
    let live = 0
    for (const id of JUMPSEAT_MISSIONS) {
      const level = loadJumpSeatLevel(id)
      const props = forestOf(level, clearedGroundOf(level))
      live += livePads(level).length
      for (const w of autopilotWaypointsFor(level)) {
        swept++
        const hit = new Set<number>()
        let worst = 0
        for (const p of platePoints(w)) {
          const depth = propPenetrationAt(p, LEVEL, HULL, props)
          if (depth <= 0) continue
          worst = Math.max(worst, depth)
          for (const k of propContactsBrute(p, LEVEL, HULL, props)) hit.add(k)
        }
        if (hit.size > 0 || worst > 0) {
          failures.push(
            `${id} pad ${w.pad}: ${worst.toFixed(1)} m deep in ` +
              (hit.size > 0
                ? [...hit].map((k) => `${props.kind[k]} ${k}`).join(', ')
                : 'a collider the brute-force oracle does not see — the query and the oracle disagree'),
          )
        }
      }
    }
    expect(failures, 'pads whose landing zone is inside a prop collider').toEqual([])
    // Every live pad was swept: a waypoint list that lost one would pass above.
    expect(swept).toBe(live)
  })

  it('the pad clearings are what cleared the trees — they remove scatter, and only scatter', () => {
    let removed = 0
    for (const id of JUMPSEAT_MISSIONS) {
      const level = loadJumpSeatLevel(id)
      const without = forestOf(level, authoredGroundOf(level))
      const withPads = forestOf(level, clearedGroundOf(level))
      removed += without.count - withPads.count
      // The landmarks are appended last and never cleared: the same number of
      // hulls on both sides.
      expect(withPads.hulls.size, `${id}: landmarks untouched`).toBe(without.hulls.size)
    }
    // Loud: a clearing that removed nothing anywhere would leave the sweep
    // above green for a different reason — the trees being somewhere else.
    expect(removed).toBeGreaterThan(0)
  })

  it('the rock-shoulder pads are inside a HULL and clear of the ROCK — the mesh is what lands them', () => {
    // Found, not listed: every pad whose bullseye centre is inside a landmark's
    // convex hull. If none were, the sweep above would not be exercising
    // `landmark-mesh.ts` at all, and a green would say nothing about it.
    const shoulders: string[] = []
    for (const id of JUMPSEAT_MISSIONS) {
      const level = loadJumpSeatLevel(id)
      const props = forestOf(level, clearedGroundOf(level))
      for (const w of autopilotWaypointsFor(level)) {
        const c = w.centre
        for (const [k, planes] of props.hulls) {
          let gap = Number.NEGATIVE_INFINITY
          for (let i = 0; i < planes.length; i += 4) {
            gap = Math.max(
              gap,
              (planes[i] as number) * c.x +
                (planes[i + 1] as number) * c.y +
                (planes[i + 2] as number) * c.z -
                (planes[i + 3] as number),
            )
          }
          if (gap >= 0) continue
          const mesh = props.meshes.get(k)
          expect(
            mesh,
            `${id} pad ${w.pad}: landmark ${k} has no mesh behind its hull`,
          ).toBeDefined()
          const rock = meshSignedDistance(mesh as NonNullable<typeof mesh>, c.x, c.y, c.z)
          // Clear of the rock by more than the widest hull sphere.
          const widest = Math.max(...HULL.map((s) => Math.hypot(s.x, s.y, s.z) + s.radius))
          expect(
            rock,
            `${id} pad ${w.pad}: the bullseye is in landmark ${k}'s rock`,
          ).toBeGreaterThan(widest)
          shoulders.push(
            `${id} pad ${w.pad}: ${(-gap).toFixed(1)} m in the hull, ${rock.toFixed(1)} m clear of the rock`,
          )
        }
      }
    }
    expect(shoulders.length, 'no pad stands in a landmark hull').toBeGreaterThan(0)
  })
})

describe.skipIf(haveForest)('DEV-345: the pad sweep is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    expect(haveForest).toBe(false)
    console.log(
      'DEV-345: `jumpseat-pad-clearance` sweep skipped — the height maps and prop GLBs ' +
        'are gitignored and come from R2 (`pnpm assets:pull`). The clearing FRAME is ' +
        'covered unconditionally above, and the rock test by `landmark-mesh.test.ts`; ' +
        'what is skipped is the certification of the shipped pads.',
    )
  })
})
