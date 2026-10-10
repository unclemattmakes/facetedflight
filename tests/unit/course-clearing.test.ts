/**
 * tests/unit/course-clearing.test.ts — DEV-502, a player course's clearing
 * along its FLOWN line, and the shipped missions it must not move.
 *
 * Matt, 2026-09-28: *"let's add clearing along the line"*. Four things have
 * to hold, and they fail in four different ways:
 *
 *   1. **Nothing shipped moves.** Every shipped mission and every authored
 *      lesson leaves the SAME placed props as before this row — count and
 *      positions, pass by pass. The oracle is `boot/app.ts`'s list as it stood
 *      at a0f8a23d (the commit before DEV-502), COPIED below on purpose: a
 *      test that imported the new function could not catch it changing. And
 *      the placed sets are pinned in `fixtures/shipped-placed-props.json`, so
 *      a later edit to either side shows up as a diff somebody has to accept.
 *   2. **The corridor is the CURVE, not the chords.** The separating sample:
 *      the spline's furthest point from the ring-to-ring chords, and a tree
 *      just inside the radius on the outside of that bend. The line's corridor
 *      takes it; a chord corridor of the same radius leaves it.
 *   3. **It runs from the pad to the finish** — the ship on its pad, the run-in
 *      to point 1, the curve — and is cut at the finish found in RING ORDER,
 *      so a loop that passes its finish early does not end there.
 *   4. **The mask is the subtraction.** What `createLineMask` hides over a
 *      forest is exactly what `withoutVolumes` would have removed from it,
 *      and a restore puts back only what the mask itself took.
 *
 * ── It needs no gitignored assets ────────────────────────────────────────
 *
 * A clearing is unbounded in y, so a placement's height never enters: `x` and
 * `z` come from the committed blobs' texel indices (`no-prop-volumes.test.ts`
 * says the same). Nothing here skips; it all runs in CI.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Level, liveRings, validateLevel } from '@/content/level-schema'
import type { NoPropVolumeFile } from '@/content/no-prop-volumes'
import { expandPlayerCourse, playerCourseArea, playerCourseSpline } from '@/content/player-course'
import { courseGates } from '@/game/mission'
import { terrainOriginSim } from '@/game/mission-shape'
import {
  createLineMask,
  flownLine,
  isPlayerCourseLevel,
  lineClearings,
  worldClearings,
} from '@/game/props/course-clearing'
import { createScatterBatch } from '@/game/props/load-props'
import { padClearings, resolveNoPropVolumes, startPadClearings } from '@/game/props/no-prop-volumes'
import { padSurfaces } from '@/game/targets'
import { courseCorridor } from '@/game/terrain/custom-ground'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { type Clearing, insideAnyClearing } from '@/sim/props/clearing'
import { buildPropColliders, propPenetrationAt, setPropCleared } from '@/sim/props/collision'
import { PLACEMENT_STRIDE } from '@/sim/props/placements'
import { withoutVolumes } from '@/sim/props/scatter'
import { fittedCourse, shippedLevels } from './helpers/editor-course'
import { REPO as ROOT } from './helpers/repo-root'

const ENV_DIR = path.join(ROOT, 'content', 'environments')
const AUTHORED_DIR = path.join(ROOT, 'content', 'authored')
const FIXTURE = path.join(ROOT, 'tests', 'unit', 'fixtures', 'shipped-placed-props.json')
const VOLUMES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content', 'no-prop-volumes.json'), 'utf8'),
) as NoPropVolumeFile

interface EnvJson {
  id: string
  spawnClearing?: { radius: number }
  scatter: { index: number; placements: { mapWidth: number; mapHeight: number; data: string } }[]
}
const envOf = (id: string): EnvJson | null => {
  const f = path.join(ENV_DIR, `${id}.json`)
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as EnvJson) : null
}

const SHIPPED = shippedLevels()
const AUTHORED: Level[] = fs
  .readdirSync(AUTHORED_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(AUTHORED_DIR, f), 'utf8')) as Level)
const ALL = [...SHIPPED, ...AUTHORED]

/** Every placement of one pass, in the terrain's own mesh space (x, z). */
const placementsOf = (entry: EnvJson['scatter'][number], terrainSize: number): Float32Array => {
  const bytes = Buffer.from(entry.placements.data, 'base64')
  const n = bytes.length / PLACEMENT_STRIDE
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const o = i * PLACEMENT_STRIDE
    out[i * 2] = (bytes.readUInt16LE(o) * terrainSize) / entry.placements.mapWidth
    out[i * 2 + 1] = (bytes.readUInt16LE(o + 2) * terrainSize) / entry.placements.mapHeight
  }
  return out
}

const sizeOf = (environment: string): number =>
  terrainParams(environmentTerrains(environment).land).terrainSize

const originOf = (level: Level): readonly number[] =>
  terrainOriginSim(environmentTerrains(level.environment).land, level.worldOffset).position
const gatesOf = (level: Level) => courseGates(level).map((g) => ({ x: g.centre.x, z: g.centre.z }))

/**
 * `boot/app.ts`'s clearing list AS IT STOOD AT a0f8a23d, the commit before
 * DEV-502, for a world on a shipped island. Copied, not imported, on purpose:
 * it is the oracle the new split is held to.
 */
const listBeforeDev502 = (level: Level, radius: number | undefined): Clearing[] => {
  const origin = originOf(level)
  return [
    ...resolveNoPropVolumes(VOLUMES, {
      environmentId: level.environment,
      missionId: level.id,
      origin,
      anchors: {
        spawn: {
          x: (level.spawn.pos[0] as number) ?? 0,
          z: -((level.spawn.pos[2] as number) ?? 0),
        },
        gates: gatesOf(level),
      },
    }).volumes,
    ...padClearings(padSurfaces(level), origin),
    ...padClearings(startPadClearings(level, radius), origin),
  ]
}

/** The input `boot/app.ts` hands `worldClearings` for a world on a shipped island. */
const inputFor = (level: Level) => ({
  level,
  volumes: VOLUMES,
  origin: originOf(level),
  gates: gatesOf(level),
  spawnRadius: envOf(level.environment)?.spawnClearing?.radius,
  customRadius: null,
  custom: false,
})

/** The placed set of one pass under a clearing: survivor count and a digest of their positions. */
const placedUnder = (xz: Float32Array, clearings: readonly Clearing[]) => {
  const n = xz.length / 2
  const kept: number[] = []
  for (let i = 0; i < n; i++) {
    if (!insideAnyClearing(xz[i * 2] as number, xz[i * 2 + 1] as number, clearings)) kept.push(i)
  }
  const pos = new Float32Array(kept.length * 2)
  kept.forEach((i, k) => {
    pos[k * 2] = xz[i * 2] as number
    pos[k * 2 + 1] = xz[i * 2 + 1] as number
  })
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(pos.buffer))
    .digest('hex')
    .slice(0, 16)
  return { kept, placed: kept.length, digest }
}

// ── 1. nothing shipped moves ──────────────────────────────────────────────

describe('DEV-502 moves no shipped prop (every mission and every authored lesson)', () => {
  it('sweeps all thirteen shipped missions and the authored lessons', () => {
    // The premise of the sweep: the set is what it says it is.
    expect(SHIPPED.length).toBe(13)
    expect(AUTHORED.length).toBeGreaterThan(0)
  })

  it('no shipped level or lesson is a player course, and none has a course clearing', () => {
    for (const level of ALL) {
      expect(isPlayerCourseLevel(level), level.id).toBe(false)
      expect(flownLine(level), level.id).toBeNull()
      expect(worldClearings(inputFor(level)).course, level.id).toEqual([])
    }
  })

  it('the fixed list is the list boot/app.ts built before DEV-502, entry for entry', () => {
    for (const level of ALL) {
      const radius = envOf(level.environment)?.spawnClearing?.radius
      expect(worldClearings(inputFor(level)).fixed, level.id).toEqual(
        listBeforeDev502(level, radius),
      )
    }
  })

  // The table the two tests below read, built once: every level, every pass
  // of its island (baked and unbaked — the Anniversary look draws both), the
  // placed set under the list before and under the list now.
  const table = ALL.flatMap((level) => {
    const env = envOf(level.environment)
    if (!env) return []
    const size = sizeOf(level.environment)
    const radius = env.spawnClearing?.radius
    const now = worldClearings(inputFor(level))
    return env.scatter.map((pass) => {
      const xz = placementsOf(pass, size)
      return {
        key: `${level.id}#${pass.index}`,
        before: placedUnder(xz, listBeforeDev502(level, radius)),
        // `course` is empty (asserted above); the mask over it would hide nothing.
        after: placedUnder(xz, [...now.fixed, ...now.course]),
      }
    })
  })

  it('every pass of every level places the same props, count and positions, as before', () => {
    expect(table.length).toBeGreaterThan(0)
    for (const row of table) {
      expect(row.after.placed, `${row.key} count`).toBe(row.before.placed)
      expect(row.after.kept, `${row.key} indices`).toEqual(row.before.kept)
      expect(row.after.digest, `${row.key} positions`).toBe(row.before.digest)
    }
  })

  it('and the placed sets are the pinned ones (fixtures/shipped-placed-props.json)', () => {
    const now = Object.fromEntries(
      table.map((r) => [r.key, { placed: r.after.placed, digest: r.after.digest }]),
    )
    if (process.env.UPDATE_PLACED_PROPS === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`)
    }
    const pinned = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
    expect(now).toEqual(pinned)
  })
})

// ── 2 and 3. the flown line, from the pad to the finish ───────────────────

const alpine = SHIPPED.find((l) => l.id === 'rookie_01_hoverJet') as Level
const int01 = SHIPPED.find((l) => l.id === 'int_01_hoverJet') as Level
const RADIUS = envOf('alpine')?.spawnClearing?.radius as number

describe('a player course clears its FLOWN line', () => {
  const course = fittedCourse(alpine)
  const level = expandPlayerCourse(course, alpine)
  const origin = originOf(level)
  const line = flownLine(level) as { x: number; z: number }[]

  it('is a player course by id and generator', () => {
    expect(isPlayerCourseLevel(level)).toBe(true)
    expect(RADIUS).toBeGreaterThan(50)
  })

  it('starts at the ship on its pad, and takes the run-in to point 1', () => {
    const route = level.route as number[][]
    const pad = route[0] as number[]
    expect(line[0]).toEqual({ x: pad[0], z: -(pad[2] as number) })
    // Point 1 of the course lies ON the line (the run-in's far end).
    const p1 = course.path.points[0] as number[]
    expect(planDistance(line, p1[0] as number, -(p1[2] as number))).toBeLessThan(0.01)
  })

  it('ends at the finish: its last point is the finish gate in plan', () => {
    const fin = level.finish?.pos as number[]
    const last = line[line.length - 1] as { x: number; z: number }
    expect(Math.hypot(last.x - (fin[0] as number), last.z + (fin[2] as number))).toBeLessThan(1)
    // And the route runs on past it, which the line does not.
    const route = level.route as number[][]
    const end = route[route.length - 1] as number[]
    expect(planDistance(line, end[0] as number, -(end[2] as number))).toBeGreaterThan(0)
  })

  it('hugs the CURVE: every spline sample up to the finish is within a metre of it', () => {
    const spline = playerCourseSpline(course)
    const sFinish = course.finish.t * spline.length
    let worst = 0
    spline.samples.forEach((p, i) => {
      if ((spline.arc[i] as number) > sFinish) return
      worst = Math.max(worst, planDistance(line, p.x, -p.z))
    })
    expect(worst).toBeLessThan(1)
  })

  it('every ring stands inside the corridor', () => {
    const clearings = lineClearings(level, RADIUS, origin)
    for (const r of liveRings(level)) {
      const x = (r.pos[0] as number) - (origin[0] as number)
      const z = -(r.pos[2] as number) - (origin[2] as number)
      expect(insideAnyClearing(x, z, clearings)).toBe(true)
    }
  })

  it('SEPARATES from the chords: a tree outside a bend is taken by the line and left by chords', () => {
    // The chords DEV-489 cleared on a custom island: the pad, then ring to ring.
    const rings = liveRings(level).map((r) => ({ x: r.pos[0] as number, z: -(r.pos[2] as number) }))
    const pad = { x: level.spawn.pos[0] as number, z: -(level.spawn.pos[2] as number) }
    const chords = courseCorridor([pad, ...rings], RADIUS, origin)
    const clearings = lineClearings(level, RADIUS, origin)
    // The sample of the line furthest from the chord chain: the apex of the
    // widest bend between two rings.
    const chordLine = [pad, ...rings]
    let apex = { x: 0, z: 0 }
    let sag = 0
    for (const p of line.slice(0, -1)) {
      const d = planDistance(chordLine, p.x, p.z)
      if (d > sag) {
        sag = d
        apex = p
      }
    }
    // A bend worth the name on 2016's alpine line.
    expect(sag).toBeGreaterThan(10)
    // Outward from the chords, through the apex, to just inside the radius.
    const foot = nearestOn(chordLine, apex.x, apex.z)
    const ux = (apex.x - foot.x) / sag
    const uz = (apex.z - foot.z) / sag
    const tree = { x: apex.x + ux * (RADIUS - 1), z: apex.z + uz * (RADIUS - 1) }
    const mesh = { x: tree.x - (origin[0] as number), z: tree.z - (origin[2] as number) }
    expect(insideAnyClearing(mesh.x, mesh.z, clearings), 'the line takes it').toBe(true)
    expect(insideAnyClearing(mesh.x, mesh.z, chords), 'the chords leave it').toBe(false)
  })

  it('puts the pad, the island volumes at its pad and rings, and the line on the COURSE list', () => {
    const split = worldClearings(inputFor(level))
    expect(split.fixed).toEqual([]) // no JumpSeat pad on a HoverJet course
    const volumes = split.resolved.volumes
    // alpine's launch corridor is written for every mission, a player's too.
    expect(volumes.length).toBeGreaterThan(0)
    expect(split.course.slice(0, volumes.length)).toEqual(volumes)
    expect(split.course.length).toBe(volumes.length + 1 + (line.length - 1))
  })

  it('and it clears trees on alpine: the line runs through the forest', () => {
    const env = envOf('alpine') as EnvJson
    const size = sizeOf('alpine')
    const clearings = lineClearings(level, RADIUS, origin)
    let taken = 0
    for (const pass of env.scatter) {
      const xz = placementsOf(pass, size)
      taken += xz.length / 2 - placedUnder(xz, clearings).placed
    }
    expect(taken).toBeGreaterThan(100)
  })
})

describe('the line is cut at the finish in RING ORDER', () => {
  // A U: out along +x, back along z = 100. The finish sits on the way back at
  // x = 100 — and 20 m from the OUTBOUND leg too, inside its 30 m reach. A
  // search for the first pass within reach would end the line on the way out.
  const route: [number, number, number][] = []
  for (let x = 0; x <= 1000; x += 25) route.push([x, 50, 0])
  for (let x = 1000; x >= -200; x -= 25) route.push([x, 50, -120])
  const ring = (x: number, z: number) => ({
    pos: [x, 50, z],
    quat: [0, 0, 0, 1],
    scale: [1, 1, 1],
    trigger: { pos: [x, 50, z], quat: [0, 0, 0, 1], radius: 22, spheres: [] },
    scoring: { addScore: 1, triggerOnce: true },
  })
  const level = {
    id: 'pc_000000000000',
    generated: { generator: 'player-v1', seed: 0 },
    spawn: { pos: [0, 50, 0], quat: [0, 0, 0, 1], yaw: 0 },
    route,
    routes: [{ id: 'player-v1', rings: [ring(800, 0), ring(500, -120)] }],
    finish: {
      shape: 'sphereUnion',
      pos: [100, 50, -100],
      quat: [0, 0, 0, 1],
      radius: 30,
      spheres: [],
    },
  } as unknown as Level

  it('ends on the return leg, past the rings, not on the outbound pass', () => {
    const line = flownLine(level) as { x: number; z: number }[]
    const last = line[line.length - 1] as { x: number; z: number }
    expect(last.z).toBeCloseTo(120, 6) // SIM z: the return leg
    expect(last.x).toBeCloseTo(100, 6)
    // The whole outbound leg and the far turn are in it.
    expect(line.some((p) => p.x === 1000)).toBe(true)
  })

  it('a ring the route never reaches keeps the WHOLE route: the failure clears more', () => {
    const lost = {
      ...level,
      routes: [{ id: 'player-v1', rings: [ring(800, 0), ring(500, 900)] }],
    } as unknown as Level
    expect(flownLine(lost)?.length).toBe(route.length)
  })
})

// ── 4. the mask is the subtraction, and a restore is only its own ─────────

describe('createLineMask: the forest a course clearing hides', () => {
  const alpineEnv = envOf('alpine') as EnvJson
  const xz = placementsOf(alpineEnv.scatter[0] as EnvJson['scatter'][number], sizeOf('alpine'))
  const points = Array.from({ length: xz.length / 2 }, (_, i) => ({
    x: xz[i * 2] as number,
    z: xz[i * 2 + 1] as number,
  }))
  const course = fittedCourse(alpine)
  const level = expandPlayerCourse(course, alpine)
  const clearings = worldClearings(inputFor(level)).course

  it('hides exactly what the load-time subtraction would have removed', () => {
    const mask = createLineMask(points, 64)
    const { hide, show } = mask.update(clearings, () => true)
    expect(show).toEqual([])
    const scattered = {
      count: points.length,
      positions: Float32Array.from(points.flatMap((p) => [p.x, 0, p.z])),
      yaw: new Float32Array(points.length),
      scale: new Float32Array(points.length),
      palette: new Uint8Array(points.length),
      chunk: new Uint16Array(points.length),
      texel: new Uint16Array(points.length * 2),
      chunkPerSide: 1,
    }
    const { removed } = withoutVolumes(scattered, clearings)
    expect(hide.length).toBe(removed)
    expect(hide.length).toBeGreaterThan(0)
    for (const id of hide) {
      const p = points[id] as { x: number; z: number }
      expect(insideAnyClearing(p.x, p.z, clearings)).toBe(true)
    }
    expect(mask.count()).toBe(hide.length)
  })

  it('moving the line puts back what it no longer covers, and only that', () => {
    const mask = createLineMask(points, 64)
    const first = mask.update(clearings, () => true)
    // The same course with its line moved 120 m, toward the middle of the
    // island so it stays inside the play area.
    const area = playerCourseArea(alpine)
    const mid =
      area?.kind === 'sphere' ? area.centre : area ? [(area.min[0] + area.max[0]) / 2] : [0]
    const dx = (course.start.pos[0] < (mid[0] as number) ? 1 : -1) * 120
    const moved = expandPlayerCourse(
      {
        ...course,
        path: {
          ...course.path,
          points: course.path.points.map(
            (p) => [p[0] + dx, p[1], p[2]] as [number, number, number],
          ),
        },
        start: {
          ...course.start,
          pos: [course.start.pos[0] + dx, course.start.pos[1], course.start.pos[2]],
        },
      },
      alpine,
    )
    const next = worldClearings(inputFor(moved)).course
    const second = mask.update(next, () => true)
    const firstSet = new Set(first.hide)
    for (const id of second.show) expect(firstSet.has(id), `showed ${id} it never hid`).toBe(true)
    for (const id of second.hide) expect(firstSet.has(id), `hid ${id} twice`).toBe(false)
    expect(second.show.length).toBeGreaterThan(0)
    // The state is the new clearing's, whatever the history.
    const fresh = createLineMask(points, 64)
    fresh.update(next, () => true)
    expect(Array.from(mask.masked)).toEqual(Array.from(fresh.masked))
  })

  it('never masks a tree already broken, so it never shows one again', () => {
    const mask = createLineMask(points, 64)
    const all = mask.update(clearings, () => true).hide
    const broken = all[0] as number
    const again = createLineMask(points, 64)
    const got = again.update(clearings, (id) => id !== broken)
    expect(got.hide).not.toContain(broken)
    expect(again.update([], () => true).show).not.toContain(broken)
  })

  it('an empty clearing hides nothing, and the grid size does not change the answer', () => {
    expect(createLineMask(points, 64).update([], () => true).hide).toEqual([])
    const a = createLineMask(points, 64)
    const b = createLineMask(points, 7)
    a.update(clearings, () => true)
    b.update(clearings, () => true)
    expect(Array.from(a.masked)).toEqual(Array.from(b.masked))
  })
})

describe('what is drawn and what is solid are masked together', () => {
  it('a scatter batch hides a slot and puts back the matrix it was built with', () => {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3)
    const batch = createScatterBatch(inst, [{ chunk: 0, start: 0, count: 3 }])
    const m = new THREE.Matrix4()
    for (let k = 0; k < 3; k++) batch.setSource(k, m.makeTranslation(k * 10, 1, 2))
    batch.reapply()
    const drawn = (k: number) => Array.from(inst.instanceMatrix.array.slice(k * 16, k * 16 + 16))
    const before = drawn(1)
    batch.maskSource(1, true)
    batch.reapply()
    // The fracture's zero: a scale of nothing, so the instance draws no area.
    expect(drawn(1)).toEqual(new THREE.Matrix4().makeScale(0, 0, 0).toArray())
    expect(drawn(0)[12]).toBe(0)
    expect(drawn(2)[12]).toBe(20)
    batch.maskSource(1, false)
    batch.reapply()
    expect(drawn(1)).toEqual(before)
  })

  it('a cleared collider is not there, and a restored one is', () => {
    const spec = {
      breakSpeed: 1e9,
      breakSlowdown: 0,
      bounceRestitution: 0,
      radiusFraction: 0.5,
      cellMetres: 64,
      racerStuckSeconds: 0,
    }
    const props = buildPropColliders(
      [{ x: 0, y: 0, z: 0, scale: 1, dims: { height: 20, base: 0, width: 4 }, kind: 'tree' }],
      { x: 0, y: 0, z: 0 },
      spec,
    )
    const at = { x: 0, y: 5, z: 0 }
    const q = { x: 0, y: 0, z: 0, w: 1 }
    const hull = [{ x: 0, y: 0, z: 0, radius: 1 }]
    expect(propPenetrationAt(at, q, hull, props)).toBeGreaterThan(0)
    setPropCleared(props, 0, true)
    expect(propPenetrationAt(at, q, hull, props)).toBe(0)
    setPropCleared(props, 0, false)
    expect(propPenetrationAt(at, q, hull, props)).toBeGreaterThan(0)
  })
})

describe('int_01 (Simonet): the line and its finish on a sphere-bounded island', () => {
  it('the fitted course ends at 2016 int_01 finish', () => {
    const level = expandPlayerCourse(fittedCourse(int01), int01)
    const line = flownLine(level) as { x: number; z: number }[]
    const fin = level.finish?.pos as number[]
    const last = line[line.length - 1] as { x: number; z: number }
    expect(Math.hypot(last.x - (fin[0] as number), last.z + (fin[2] as number))).toBeLessThan(1)
    expect(validateLevel(level)).toBeTruthy()
  })
})

// ── plan geometry for the assertions ──────────────────────────────────────

function nearestOn(
  line: readonly { x: number; z: number }[],
  x: number,
  z: number,
): { x: number; z: number; d: number } {
  let best = { x: 0, z: 0, d: Number.POSITIVE_INFINITY }
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i] as { x: number; z: number }
    const b = line[i + 1] as { x: number; z: number }
    const ex = b.x - a.x
    const ez = b.z - a.z
    const len2 = ex * ex + ez * ez
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / len2)) : 0
    const px = a.x + u * ex
    const pz = a.z + u * ez
    const d = Math.hypot(x - px, z - pz)
    if (d < best.d) best = { x: px, z: pz, d }
  }
  return best
}

function planDistance(line: readonly { x: number; z: number }[], x: number, z: number): number {
  return nearestOn(line, x, z).d
}
