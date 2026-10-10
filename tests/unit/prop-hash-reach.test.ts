// tests/unit/prop-hash-reach.test.ts — does the spatial hash find everything?
//
// DEV-187. `prop-collision.test.ts` is this file's parent and it asks whether a
// contact is RESOLVED correctly. This one asks the question underneath it —
// whether the contact is found at all — and the two are different because the
// hash is a device of the port's own:
//
//   `stepPropCollision` walks the query point's cell and its eight neighbours.
//   A collider only ever lives in the cell of its own CENTRE. So the walk finds
//   it exactly when that centre is within one cell of the query point — and a
//   contact needs the query point within `radius + sphereRadius` of the centre.
//   The hash is COMPLETE while `radius + sphereRadius <= cellMetres` and
//   silently incomplete above it.
//
// Above it, a ship flies through the prop and nothing reports anything: there
// is no error, no warning and no missing hit to count. Seventeen colliders in
// the shipped content were over that line — desert's sixteen canyon spires and
// Simonet's one, radii 64.7 to 207.9 m against a 64 m cell — and every test
// written against prop collision agreed with the hash, because every one of
// them asked the hash.
//
// ── The oracle is outside the hash ────────────────────────────────────────
//
// `helpers/prop-forest.ts`'s `propPenetrationBrute` / `propContactsBrute` walk
// `props.count` and consult neither `cells` nor `oversized`. Same rotation,
// same broken skip, same vertical reject, same `r + sr - d`: the ONLY thing
// they do differently is look at every collider, so a disagreement can only be
// about reach. CLAUDE.md: compare against something outside the port — and here
// the brute force is outside the part of the port under test.
//
// ── Two halves, and the first one runs on CI ──────────────────────────────
//
// The synthetic half needs no assets: a forest built by hand with radii either
// side of the cell, swept exhaustively on a grid. The real half needs the
// gitignored maps and GLBs, is guarded on `haveForest`, and carries the loud
// counterpart `orb-floor.test.ts` established.

import { describe, expect, it } from 'vitest'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import {
  buildPropColliders,
  createPropCollision,
  type PropCollisionSpec,
  type PropPlacementInput,
  propPenetrationAt,
  stepPropCollision,
} from '@/sim/props/collision'
import { createRigidBody } from '@/sim/rigidbody'
import { routeAt } from '@/sim/route'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import { shippedCrashLine } from './helpers/crash-line'
import {
  ENVIRONMENTS,
  forestFor,
  haveForest,
  propContactsBrute,
  propPenetrationBrute,
} from './helpers/prop-forest'
import { fieldFor, loadLevelJson, MISSIONS } from './helpers/terrain-field'

const EDITION = anniversary as unknown as {
  gameplay: { propCollision: PropCollisionSpec }
  props: {
    scale: Record<string, unknown>
    unbakedPasses: { enabled: boolean }
    groundSnap: { enabled: boolean; sink: number }
    maxSlope: { enabled: boolean; sin: number }
  }
}
const SPEC = EDITION.gameplay.propCollision
const HULL = HOVERJET_GROUND.collision.hull
const LEVEL = { x: 0, y: 0, z: 0, w: 1 }

const FOREST_OPTIONS = {
  spec: SPEC,
  scale: EDITION.props.scale,
  unbakedPasses: EDITION.props.unbakedPasses.enabled,
  groundSnapSink: EDITION.props.groundSnap.enabled ? EDITION.props.groundSnap.sink : null,
  maxSlope: EDITION.props.maxSlope.enabled ? EDITION.props.maxSlope.sin : null,
  landmarks: true,
}

// ── the synthetic half ────────────────────────────────────────────────────

/** A prop whose collider radius comes out at exactly `radius`. */
const prop = (x: number, z: number, radius: number, halfHeight = 300): PropPlacementInput => ({
  x,
  y: 0,
  z,
  scale: 1,
  dims: {
    height: halfHeight,
    base: -halfHeight,
    width: radius / SPEC.radiusFraction,
  },
  kind: 'spire',
})

describe('DEV-187: the hash reaches every collider it holds', () => {
  it('splits on the DIAMETER, not the radius: a collider a cell wide comes off the hash', () => {
    const cell = SPEC.cellMetres
    const under = buildPropColliders([prop(0, 0, cell / 2 - 1)], { x: 0, y: 0, z: 0 }, SPEC)
    const over = buildPropColliders([prop(0, 0, cell / 2 + 1)], { x: 0, y: 0, z: 0 }, SPEC)
    expect(under.oversized, 'narrower than a cell across: the hash holds it').toEqual([])
    expect(under.cells.size).toBe(1)
    expect(over.oversized, 'a cell wide across: the hash cannot').toEqual([0])
    expect(over.cells.size, 'and it is NOT also in a cell — one list, one test').toBe(0)
  })

  it('a collider wider than the walk is reachable, and on the old rule it was not', () => {
    // 200 m radius, a 64 m cell. The hull sits 190 m out along +x: inside the
    // capsule by 10 m, and THREE cells from the collider's own. Nothing the 3x3
    // walk visits contains it.
    const props = buildPropColliders([prop(0, 0, 200)], { x: 0, y: 0, z: 0 }, SPEC)
    const at = { x: 190, y: 0, z: 0 }
    const cellsApart = Math.abs(
      Math.floor(at.x / SPEC.cellMetres) - Math.floor(0 / SPEC.cellMetres),
    )
    expect(cellsApart, 'the sample has to be out of reach or it proves nothing').toBeGreaterThan(1)

    const brute = propPenetrationBrute(at, LEVEL, HULL, props)
    expect(brute, 'the pose is genuinely inside the capsule').toBeGreaterThan(0)
    expect(propPenetrationAt(v3(at.x, at.y, at.z), LEVEL, HULL, props)).toBeCloseTo(brute, 6)

    const state = createPropCollision()
    const body = createRigidBody({ mass: 4 })
    body.position.x = at.x
    body.velocity.x = -10 // into the spire, under `breakSpeed`: a bounce
    expect(stepPropCollision(state, body, HULL, props, SPEC)).toBeGreaterThan(0)
    expect(state.hits[0]?.id).toBe(0)
  })

  it('exhaustive: on a mixed forest the hash and a brute-force sweep never disagree', () => {
    // Radii either side of the split, deliberately overlapping, and placed off
    // the cell grid so no sample sits on a boundary by construction.
    const props = buildPropColliders(
      [
        prop(0, 0, 8),
        prop(37, 11, 9.2),
        prop(150, -60, 33),
        prop(-90, 140, 64.7),
        prop(210, 190, 207.9),
        prop(-230, -210, 120),
      ],
      { x: 7, y: 0, z: -13 },
      SPEC,
    )
    expect(props.oversized.length, 'the sample must contain both kinds').toBe(4)
    expect(props.cells.size).toBeGreaterThan(0)

    let disagreements = 0
    let contacts = 0
    for (let x = -400; x <= 400; x += 7) {
      for (let z = -400; z <= 400; z += 7) {
        const at = { x, y: 0, z }
        const hash = propPenetrationAt(v3(x, 0, z), LEVEL, HULL, props)
        const brute = propPenetrationBrute(at, LEVEL, HULL, props)
        if (Math.abs(hash - brute) > 1e-9) disagreements++
        if (brute > 0) contacts++
      }
    }
    // A sweep that never touched anything agrees trivially.
    expect(contacts, 'the sweep has to be inside something somewhere').toBeGreaterThan(100)
    expect(disagreements, 'hash and brute force disagree somewhere on the grid').toBe(0)
  })

  it('the contacts themselves match, id for id, not just the deepest one', () => {
    // ABOVE `breakSpeed` on purpose. The bounce branch DEPENETRATES — it moves
    // the body out along the normal — so by the third candidate a bouncing hull
    // is no longer at the pose the brute force was asked about, and the two
    // would disagree about the content of a set for a reason that has nothing
    // to do with reach. The break branch touches only the velocity, so the pose
    // the hash is walking is the pose the oracle was given. A fresh forest each
    // time, because a break removes the collider.
    const shape = [prop(0, 0, 207.9), prop(60, 40, 9), prop(-100, 30, 100)]
    let sawTwo = 0
    for (let x = -260; x <= 260; x += 13) {
      for (let z = -260; z <= 260; z += 13) {
        const props = buildPropColliders(shape, { x: 0, y: 0, z: 0 }, SPEC)
        const state = createPropCollision()
        const body = createRigidBody({ mass: 4 })
        body.position.x = x
        body.position.z = z
        body.velocity.x = SPEC.breakSpeed + 1
        const expected = propContactsBrute({ x, y: 0, z }, LEVEL, HULL, props)
        stepPropCollision(state, body, HULL, props, SPEC)
        const got = [...new Set(state.hits.map((h) => h.id))].sort((a, b) => a - b)
        expect(got, `at (${x}, ${z})`).toEqual(expected)
        if (expected.length > 1) sawTwo++
      }
    }
    expect(sawTwo, 'the sweep never stood in two props at once').toBeGreaterThan(0)
  })
})

// ── the real half ─────────────────────────────────────────────────────────

/**
 * An adversarial sample, not a uniform one (CLAUDE.md: a spot-check is a smoke
 * test). Every pose is drawn from the neighbourhood of an OVERSIZED collider —
 * the only place the two answers can differ — plus a ring at the radius where a
 * one-metre error flips the contact.
 */
const posesAroundOversized = (props: {
  oversized: number[]
  x: Float32Array
  z: Float32Array
  bottom: Float32Array
  top: Float32Array
  radius: Float32Array
}): { x: number; y: number; z: number }[] => {
  const out: { x: number; y: number; z: number }[] = []
  for (const id of props.oversized) {
    const r = props.radius[id] as number
    const midY = ((props.bottom[id] as number) + (props.top[id] as number)) / 2
    for (const f of [0, 0.4, 0.9, 0.98, 1.0, 1.02, 1.1, 1.6]) {
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2
        out.push({
          x: (props.x[id] as number) + Math.cos(th) * r * f,
          y: midY,
          z: (props.z[id] as number) + Math.sin(th) * r * f,
        })
      }
    }
    // And the two ends, where the vertical reject decides it.
    out.push({
      x: props.x[id] as number,
      y: (props.bottom[id] as number) + 1,
      z: props.z[id] as number,
    })
    out.push({
      x: props.x[id] as number,
      y: (props.top[id] as number) - 1,
      z: props.z[id] as number,
    })
  }
  return out
}

describe.skipIf(!haveForest)('DEV-187: the real forest, against a brute-force sweep', () => {
  it('every environment: the hash agrees with brute force at the biggest colliders', () => {
    const rows: string[] = []
    for (const env of ENVIRONMENTS) {
      const level = loadLevelJson(
        MISSIONS.find((m) => loadLevelJson(m).environment === env) as string,
      )
      const props = forestFor(env, fieldFor(level), FOREST_OPTIONS)
      const poses = posesAroundOversized(props)
      let inside = 0
      let disagreements = 0
      for (const p of poses) {
        const hash = propPenetrationAt(v3(p.x, p.y, p.z), LEVEL, HULL, props)
        const brute = propPenetrationBrute(p, LEVEL, HULL, props)
        if (Math.abs(hash - brute) > 1e-9) disagreements++
        if (brute > 0) inside++
      }
      let maxR = 0
      for (let i = 0; i < props.count; i++) maxR = Math.max(maxR, props.radius[i] as number)
      rows.push(
        `${env.padEnd(8)} ${String(props.count).padStart(6)} colliders, ` +
          `${String(props.oversized.length).padStart(2)} oversized, maxR ${maxR.toFixed(1).padStart(6)} m | ` +
          `${poses.length} poses, ${inside} inside a prop, ${disagreements} disagreements`,
      )
      expect(disagreements, `${env}: hash vs brute force`).toBe(0)
      if (props.oversized.length > 0) {
        expect(inside, `${env}: the sample never entered a spire`).toBeGreaterThan(0)
      }
    }
    console.log(`DEV-187 hash vs brute force:\n  ${rows.join('\n  ')}`)
    // THE PREMISE. If the content ever stops having a collider wider than a
    // cell this file is testing an empty set, and it should say so out loud
    // rather than pass.
    const desert = forestFor(
      'desert',
      fieldFor(loadLevelJson('rookie_02_hoverJet')),
      FOREST_OPTIONS,
    )
    expect(desert.oversized.length, 'desert has no oversized colliders any more').toBeGreaterThan(0)
  }, 600_000)

  it('a ship at the boost terminal, flown at it: every tick agrees with brute force', () => {
    // 179.62 m/s is the HoverJet's boosting terminal (`hoverjet.test.ts`), so a
    // tick is 2.19 m. The line runs through desert's deepest spire and 400 m
    // out the other side, which is the pass a player makes at racing speed.
    const level = loadLevelJson('rookie_02_hoverJet')
    const props = forestFor('desert', fieldFor(level), FOREST_OPTIONS)
    let widest = props.oversized[0] as number
    for (const id of props.oversized) {
      if ((props.radius[id] as number) > (props.radius[widest] as number)) widest = id
    }
    const step = 179.62 * FIXED_DT
    const r = props.radius[widest] as number
    const y = ((props.bottom[widest] as number) + (props.top[widest] as number)) / 2
    let inside = 0
    let disagreements = 0
    let ticks = 0
    for (let d = -(r + 400); d <= r + 400; d += step) {
      const p = { x: (props.x[widest] as number) + d, y, z: props.z[widest] as number }
      const hash = propPenetrationAt(v3(p.x, p.y, p.z), LEVEL, HULL, props)
      const brute = propPenetrationBrute(p, LEVEL, HULL, props)
      if (Math.abs(hash - brute) > 1e-9) disagreements++
      if (brute > 0) inside++
      ticks++
    }
    console.log(
      `DEV-187 boost pass through spire #${widest} (r ${r.toFixed(1)} m): ${ticks} ticks at ` +
        `${step.toFixed(2)} m, ${inside} inside it, ${disagreements} disagreements`,
    )
    expect(inside, 'the pass never entered the spire').toBeGreaterThan(0)
    expect(disagreements).toBe(0)
  }, 600_000)

  it('all thirteen missions: every metre of the authored line, hash against brute force', () => {
    // THE EXHAUSTIVE ONE, and it is two things at once.
    //
    // As a GATE it is the reach rule tested on the real content rather than on
    // an adversarial sample of it: every metre of every mission's crash line,
    // the hash asked and the brute force asked, and they must agree at all of
    // them. `pnpm oracle:sweep`'s lesson — prefer an exhaustive sweep where one
    // is cheap, and this is about twenty seconds.
    //
    // As a MEASUREMENT it is the answer to "how much authored line is inside a
    // prop now the hash can see them", which is the thing that says whether
    // DEV-187 changed the game. DEV-185 found six of seven routed HoverJet
    // missions with line inside a prop using the BROKEN hash, so that was a
    // floor. The `spire` column is the part that was invisible.
    const rows: string[] = []
    let totalDisagreements = 0
    let missionsWithSpire = 0
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      const field = fieldFor(level)
      const props = forestFor(level.environment, field, FOREST_OPTIONS)
      const { route, kind } = shippedCrashLine(level)
      const at = v3()
      let insideAny = 0
      let insideLandmark = 0
      let disagreements = 0
      let deepest = 0
      for (let s = 0; s <= route.length; s += 1) {
        routeAt(route, s, at)
        const p = { x: at.x, y: at.y, z: at.z }
        const hash = propPenetrationAt(at, LEVEL, HULL, props)
        const brute = propPenetrationBrute(p, LEVEL, HULL, props)
        if (Math.abs(hash - brute) > 1e-9) disagreements++
        if (brute > 0) {
          insideAny++
          deepest = Math.max(deepest, brute)
          // Which kind it is in. Only asked on a metre that IS inside one, so
          // the cost is the handful of metres rather than the whole line.
          for (const cid of propContactsBrute(p, LEVEL, HULL, props)) {
            if ((props.kind[cid] as string) !== 'spire') continue
            insideLandmark++
            break
          }
        }
      }
      totalDisagreements += disagreements
      if (insideLandmark > 0) missionsWithSpire++
      rows.push(
        `${id.padEnd(20)} ${String(level.environment).padEnd(8)} ${kind.padEnd(10)} ` +
          `line ${String(Math.round(route.length)).padStart(5)} m | inside a prop ${String(insideAny).padStart(4)} m ` +
          `(spire ${String(insideLandmark).padStart(4)} m) | deepest ${deepest.toFixed(1).padStart(6)} m | ` +
          `${disagreements} disagreements`,
      )
      expect(disagreements, `${id}: hash and brute force disagree along the line`).toBe(0)
    }
    console.log(`DEV-187 authored line inside a standing prop:\n  ${rows.join('\n  ')}`)
    console.log(
      `DEV-187: ${missionsWithSpire} of ${MISSIONS.length} missions have authored line inside a LANDMARK, ` +
        `which the hash could not see at all before this row.`,
    )
    expect(totalDisagreements).toBe(0)
    // And the sweep has to have found some, or it proved nothing about reach on
    // the real content — this is the number DEV-187 exists to have made visible.
    expect(
      missionsWithSpire,
      'no mission has line inside a spire: nothing here was tested',
    ).toBeGreaterThan(0)
  }, 900_000)

  it('what the direct list COSTS: candidates per hull sphere, counted along the line', () => {
    // `stepPropCollision` is in the player's chain and in every racer's, so a
    // wider search is paid every tick by every ship
    // (`docs/plan/VR-PERF-WAVE-2-WORK.md`: the sim is 0.3 ms of a 6.3 ms frame
    // and is not the problem — keep it that way). The currency is CANDIDATES,
    // not milliseconds: a millisecond belongs to a machine, and a candidate is
    // a count this suite can hold on any of them.
    //
    // One candidate is `broken[id]`, two float compares against the capsule's
    // vertical span, and — only past those — an `ox/oz/hypot`. The direct list
    // adds exactly `oversized.length` of them per hull sphere per tick, with no
    // cell lookup, which is why it is a list and not a wider walk: the 9 cells
    // of a 3x3 walk become the 81 of a 9x9 the moment the reach has to cover a
    // 164 m radius, and alpine and kauai would pay that for nothing.
    const rows: string[] = []
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      const props = forestFor(level.environment, fieldFor(level), FOREST_OPTIONS)
      const { route } = shippedCrashLine(level)
      const at = v3()
      let cellSum = 0
      let cellMax = 0
      let n = 0
      // Every metre of the line, and every hull sphere at it — the same
      // candidate count a tick pays, at a level pose (the spheres are within
      // 1.6 m of the origin and the cells are 64 m, so rotating them cannot
      // change the answer by more than a cell).
      for (let s = 0; s <= route.length; s += 1) {
        routeAt(route, s, at)
        for (const sphere of HULL) {
          const cx = Math.floor((at.x + sphere.x) / props.cellMetres)
          const cz = Math.floor((at.z + sphere.z) / props.cellMetres)
          let c = 0
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              c += (props.cells.get((cx + dx) * 73856093 + (cz + dz) * 19349663) ?? []).length
            }
          }
          cellSum += c
          cellMax = Math.max(cellMax, c)
          n++
        }
      }
      const mean = cellSum / n
      rows.push(
        `${id.padEnd(20)} ${String(level.environment).padEnd(8)} hash ${mean.toFixed(1).padStart(6)} mean / ${String(cellMax).padStart(4)} max` +
          ` + direct ${String(props.oversized.length).padStart(2)} = ${(mean + props.oversized.length).toFixed(1).padStart(6)} mean per hull sphere` +
          // `n/a`, never a number, for a window with no samples: the five
          // JumpSeat missions have no route and a one-metre gate polyline, so
          // their hash mean is one reading and a ratio against it is noise.
          ` (${mean < 1 ? 'n/a' : `+${((props.oversized.length / mean) * 100).toFixed(0)} %`})`,
      )
    }
    console.log(`DEV-187 candidates per hull sphere per tick:\n  ${rows.join('\n  ')}`)

    // THE MECHANISM, gated: the direct list is landmarks and nothing else. If a
    // scatter pass ever grows a collider wider than half a cell this goes red,
    // because that would be thousands of direct tests a tick rather than
    // seventeen, and it must not happen quietly.
    for (const env of ENVIRONMENTS) {
      const level = loadLevelJson(
        MISSIONS.find((m) => loadLevelJson(m).environment === env) as string,
      )
      const props = forestFor(env, fieldFor(level), FOREST_OPTIONS)
      for (const id of props.oversized) {
        expect(props.kind[id], `${env} #${id} is on the direct list and is not a landmark`).toBe(
          'spire',
        )
      }
      expect(props.oversized.length, `${env}: the direct list is not small any more`).toBeLessThan(
        32,
      )
      // And not vacuous: desert HAS to have a direct list, or the row above is
      // a census of nothing and this test would stay green on the very bug it
      // is here to price.
      if (env === 'desert') {
        expect(props.oversized.length, 'desert has no oversized colliders').toBeGreaterThan(0)
      }
    }
  }, 900_000)
})

describe.skipIf(haveForest)('DEV-187: the real-forest half is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    expect(haveForest).toBe(false)
    console.log(
      'DEV-187: the real-forest sweep is skipped — the height maps and prop GLBs are ' +
        'gitignored and come from R2 (`pnpm assets:pull`). The RULE is covered ' +
        'unconditionally by the synthetic half above.',
    )
  })
})
