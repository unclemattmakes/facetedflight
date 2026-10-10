// tests/unit/racer-lanes-clear.test.ts — rookie_01's racer lanes are clear of
// every prop collider. The DEV-364 follow-up (Matt, 2026-09-25, call 8).
//
// DEV-364 gave every racer a LANE, and on `rookie_01_hoverJet` the lanes climb
// out of gate 0 low over a cluster of three trees just past DEV-287's launch
// corridor. `content/no-prop-volumes.json`'s `rookie-01-climb-out` clears them.
// This flies the race and measures what it has to: how close any racer's hull
// comes to any trunk, in three dimensions, against a margin that is the
// preset's own — `avoidClearance`, the air a racer keeps round its own track.
//
// ── What flies, and what is a copy ────────────────────────────────────────
//
// REAL: the Anniversary grid (`racerStarts`, `assignTunings`), each racer
// through `stepRacerField` with the preset's lanes, avoidance, contact, crash
// rule and prop collision; the real alpine ground (`fieldFor`); and the forest
// built the way `boot/app.ts` builds it (`forestFor`: the scale, the unbaked
// passes, the ground snap, the slope limit, the landmarks, and the authored
// volumes resolved by `resolveNoPropVolumes` from the committed file).
//
// A STAND-IN: the player. The racers steer off it, so it has to be in the air,
// but `boot/app.ts`'s autopilot (route guidance and a speed profile) lives
// behind the renderer. This flies `autopilotActions` gate to gate from the
// release point, which is `src/game/autopilot-lap.ts`'s pilot.
//
// Four starts, every spawn nudged 0 / 0.5 / 1 / 1.5 m along its heading,
// because a race is chaotic (DEV-364 §5) and one start is one sample.
//
// The ground and the forest are gitignored; the flight is inside the `it`
// (CLAUDE.md: `describe.skipIf` skips the tests, not the body). The loud
// counterpart for `haveForest` is `crash-reset-clearance.test.ts`'s — the same
// guard, and one counterpart per missing asset keeps a hydrated tree's skip
// count where it was.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Edition, validateEdition } from '@/content/edition-schema'
import type { NoPropVolumeFile } from '@/content/no-prop-volumes'
import { courseGates } from '@/game/mission'
import { terrainOriginSim } from '@/game/mission-shape'
import { resolveNoPropVolumes } from '@/game/props/no-prop-volumes'
import { racerStarts } from '@/game/racer-grid'
import { assignTunings } from '@/game/racers'
import { environmentTerrains } from '@/game/terrain/load-terrain'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { AI_RACER_TUNINGS, createAiRacer, gateArcLengths } from '@/sim/ai-racer'
import { autopilotActions } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { HOVERJET_CRAFT_VOLUME } from '@/sim/craft-contact'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import type { PropCollisionSpec } from '@/sim/props/collision'
import { createRacerField, stepRacerField } from '@/sim/racer-field'
import { createRoute } from '@/sim/route'
import anniversaryJson from '../../content/editions/anniversary.json'
import { forestFor, haveForest } from './helpers/prop-forest'
import { REPO as ROOT } from './helpers/repo-root'
import { fieldFor, loadLevelJson } from './helpers/terrain-field'

const VOLUMES_FILE = path.join(ROOT, 'content', 'no-prop-volumes.json')
const E: Edition = validateEdition(anniversaryJson as unknown as Edition)
const MISSION = 'rookie_01_hoverJet'
const CLIMB_OUT = 'rookie-01-climb-out'
/** The margin: the air a racer keeps round its own track (DEV-364). */
const MARGIN = E.gameplay.racers.separation.avoidClearance
/** The first 20 s: the grid, the launch, gate 0 and the climb-out, and some way past. */
const SECONDS = 20
const NUDGES = [0, 0.5, 1, 1.5]

interface Closest {
  gap: number
  racer: string
  t: number
  hits: number
}

/** Fly the grid; return the closest any racer's hull came to any trunk, and the hits. */
const fly = (volumes: NoPropVolumeFile): Closest => {
  const level = loadLevelJson(MISSION)
  const gates = courseGates(level)
  const route = createRoute(level.route)
  const guide = { route, gateArc: gateArcLengths(route, gates) }
  const field = fieldFor(level)
  const origin = terrainOriginSim(
    environmentTerrains(level.environment).land,
    level.worldOffset,
  ).position
  const resolved = resolveNoPropVolumes(volumes, {
    environmentId: level.environment,
    missionId: level.id,
    origin,
    anchors: {
      // `level.spawn.pos` is THREE; the anchors are SIM (`boot/app.ts` flips it too).
      spawn: { x: level.spawn.pos[0], z: -level.spawn.pos[2] },
      gates: gates.map((g) => ({ x: g.centre.x, z: g.centre.z })),
    },
  })
  const spec = E.gameplay.propCollision as unknown as PropCollisionSpec
  const forest = forestFor(level.environment, field, {
    spec,
    scale: E.props.scale as unknown as Record<string, unknown>,
    unbakedPasses: E.props.unbakedPasses.enabled,
    groundSnapSink: E.props.groundSnap.enabled ? E.props.groundSnap.sink : null,
    maxSlope: E.props.maxSlope.enabled ? E.props.maxSlope.sin : null,
    landmarks: true,
    noPropVolumes: resolved.volumes,
  })
  const R = HOVERJET_CRAFT_VOLUME.radius
  const closest: Closest = { gap: Number.POSITIVE_INFINITY, racer: '', t: 0, hits: 0 }
  const fwd = v3()
  const nose = v3(0, 0, 1)
  for (const nudge of NUDGES) {
    // The forest is cached per key and a broken trunk is a flag on it.
    forest.broken.fill(0)
    const starts = racerStarts(level, E.gameplay.racers)
    const assigned = assignTunings(starts)
    const racers = starts.map((start, i) => {
      const { id, tuning } = assigned[i] as { id: string; tuning: string }
      const spawn = threeTupleToUnity(v3(), [start.pos[0], start.pos[1], start.pos[2]])
      const q = { x: 0, y: 0, z: 0, w: 1 }
      threeQuatTupleToUnity(q, start.quat as unknown as number[])
      rotateVec3(fwd, q, nose)
      spawn.x += fwd.x * nudge
      spawn.z += fwd.z * nudge
      return createAiRacer(
        {
          id,
          spawn,
          orientation: [q.x, q.y, q.z, q.w],
          tuning: AI_RACER_TUNINGS[tuning] as (typeof AI_RACER_TUNINGS)[string],
        },
        gates,
      )
    })
    const rfield = createRacerField(racers, route)
    const player = createHoverJet()
    player.launched = true
    threeTupleToUnity(player.body.position, level.spawn.pos as number[])
    threeQuatTupleToUnity(player.body.orientation, level.spawn.quat as number[])
    player.body.position.y += level.spawn.launch?.rise ?? 0
    rotateVec3(fwd, player.body.orientation, nose)
    player.body.position.x += fwd.x * nudge
    player.body.position.z += fwd.z * nudge
    const input = noInput()
    let target = 0
    for (let t = 0; t < Math.round(SECONDS / FIXED_DT); t++) {
      const g = gates[target]
      if (g) {
        autopilotActions(
          player.body,
          g.centre,
          input,
          undefined,
          [],
          Number.POSITIVE_INFINITY,
          gates[target + 1]?.centre ?? null,
        )
        stepHoverJet(player, input)
        const p = player.body.position
        if (Math.hypot(p.x - g.centre.x, p.y - g.centre.y, p.z - g.centre.z) < g.radius) target++
      }
      stepRacerField(
        rfield,
        racers,
        gates,
        [field],
        FIXED_DT,
        guide,
        [field],
        E.gameplay.crash,
        { colliders: forest, spec },
        {
          separation: E.gameplay.racers.separation,
          contact: E.gameplay.racers.contact,
          player: player.body,
          hit: E.gameplay.racers.hit,
        },
      )
      for (const r of racers) {
        closest.hits += r.props.hits.length
        const p = r.jet.body.position
        for (let k = 0; k < forest.count; k++) {
          if (forest.broken[k]) continue
          const dx = (forest.x[k] as number) - p.x
          const dz = (forest.z[k] as number) - p.z
          if (Math.abs(dx) > 60 || Math.abs(dz) > 60) continue
          // The hull as a sphere of the craft radius, the trunk as its own
          // vertical capsule: the distance between them in 3D.
          const top = forest.top[k] as number
          const bottom = forest.bottom[k] as number
          const dy = p.y > top ? p.y - top : p.y < bottom ? bottom - p.y : 0
          const gap = Math.hypot(Math.hypot(dx, dz), dy) - (forest.radius[k] as number) - R
          if (gap < closest.gap) {
            closest.gap = gap
            closest.racer = r.spec.id
            closest.t = t * FIXED_DT
          }
        }
      }
    }
  }
  return closest
}

const authored = (): NoPropVolumeFile =>
  JSON.parse(fs.readFileSync(VOLUMES_FILE, 'utf8')) as NoPropVolumeFile

describe.skipIf(!haveForest)(`${MISSION}: every racer's lane is clear of the forest`, () => {
  it(`every racer's hull passes every trunk by at least avoidClearance (${MARGIN} m), and hits none`, () => {
    const c = fly(authored())
    console.info(
      `${MISSION} lanes: closest pass ${c.gap.toFixed(2)} m (${c.racer} at ${c.t.toFixed(2)} s), ${c.hits} prop hits`,
    )
    expect(c.hits, 'prop hits by any racer').toBe(0)
    expect(c.gap, `closest pass: ${c.racer} at ${c.t.toFixed(2)} s`).toBeGreaterThanOrEqual(MARGIN)
  }, 120_000)

  it(`the premise: without ${CLIMB_OUT} a racer passes a crown inside that margin`, () => {
    // The control. If the volume is not what clears the lanes, the test above
    // is green for another reason and proves nothing about it.
    const file = authored()
    const without: NoPropVolumeFile = {
      ...file,
      environments: {
        ...file.environments,
        alpine: (file.environments.alpine ?? []).filter((v) => v.id !== CLIMB_OUT),
      },
    }
    expect(
      (file.environments.alpine ?? []).some((v) => v.id === CLIMB_OUT),
      'the volume is authored',
    ).toBe(true)
    const c = fly(without)
    expect(c.gap, `closest pass without it: ${c.racer} at ${c.t.toFixed(2)} s`).toBeLessThan(MARGIN)
  }, 120_000)
})
