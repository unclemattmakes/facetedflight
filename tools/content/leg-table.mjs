// tools/content/leg-table.mjs — where a lesson step goes, measured off a course. DEV-378.
//
//   node tools/content/leg-table.mjs rookie_02_hoverJet
//   node tools/content/leg-table.mjs adv_01_hoverJet --from 10
//   node tools/content/leg-table.mjs lesson_02_canyon_run
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §8: *"Derived, not typed: the leg table (a
// small print tool … for choosing where a step goes on any course)"*. A lesson
// step is sized for a LEG — a climb, a straight, a hard corner, a stretch
// between canyon walls — and which ring starts which leg is a fact about the
// course, not a thing to eyeball. §2.1's table and §2.6's walls were one
// uncommitted probe; this is that probe, for any course, generated or authored.
//
// ── What each column is OF (CLAUDE.md: a derived number says what it measures)
//
//   y      the ring's TRIGGER centre, metres, the height a player flies through.
//   leg    straight-line metres from the previous point to this ring's trigger:
//          the previous ring, or for ring 0 the START — the top of the lift
//          (`spawn.pos` + `spawn.launch.rise`) for an elevator spawn, the spawn
//          itself for a direct one. §2.1's ring-0 leg (149 m) was measured from
//          the BOTTOM of the shaft; DEV-376 §5 corrected it (88.5 m from the
//          top). This tool measures from where the player is let go.
//   climb  this ring's y minus the previous point's.
//   turn   the HORIZONTAL heading change at this ring, degrees: the in-leg
//          (previous point → ring) against the out-leg (ring → next ring, or
//          → the finish for the last).
//   arc    this ring's arc length on the racing line (`gateArcLengths`), the
//          number a `startArcMetres` or an instructor's gap is measured in.
//   both / one   of the LINE VERTICES on this leg (arc after the previous
//          ring's, up to this ring's), the percentage with ground standing
//          ABOVE the line vertex within `wallMetres` (200, §2.6) on both sides
//          of the line / on exactly one. Sampled every 10 m across the line's
//          horizontal right (`routeRightAt`), on the collision field
//          (`tests/unit/helpers/terrain-field.ts`'s `fieldFor`, the one the
//          route-clearance and golden-lesson specs read).
//   agl    the lowest the line runs above that field on this leg, metres.
//
// The pure half, {@link legTable}, takes its dependencies (the sim's route
// functions and a height field) as arguments, so a unit test can hold it to the
// numbers the plan measured (§2.1, §2.6) without a vite server; the CLI half
// loads them through vite, as `tools/assets/bake-placements.mjs` does.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMain } from '../lib/cli.mjs'
import { createSsrServer } from '../lib/ssr.mjs'

/** §2.6's reach: ground within this many metres either side counts as a wall. */
export const WALL_METRES = 200
/** Across-the-line sample spacing, metres. The terrain's quads are 8 m. */
export const WALL_STEP = 10

const DEG = 180 / Math.PI

/** Horizontal heading, radians, of the vector a→b (x, z). */
const heading = (ax, az, bx, bz) => Math.atan2(bx - ax, bz - az)

/** The smallest signed difference between two headings, degrees, as a magnitude. */
const turnDegrees = (h0, h1) => {
  let d = h1 - h0
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return Math.abs(d) * DEG
}

const percentile = (sorted, p) =>
  sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]

/**
 * The table. SIM space throughout: the rings, the start and the finish are
 * THREE space in the level JSON and are mirrored in z here, the way
 * `courseGates` and `createRoute` mirror them.
 *
 * @param {object} level  a level JSON (generated or authored)
 * @param {object} deps   { createRoute, gateArcLengths, routeRightAt, terrainHeightAt, outsideField }
 * @param {object|null} field  the course's collision HeightField, or null for no walls
 */
export const legTable = (level, deps, field = null) => {
  const rings = level.routes.flatMap((r) => r.rings).filter((r) => r.scoring.addScore !== 0)
  const sim = (p) => ({ x: p[0], y: p[1], z: -p[2] })
  const gates = rings.map((r) => ({ centre: sim(r.trigger.pos), radius: r.trigger.radius }))
  const rise = level.spawn.launchKind === 'elevator' ? (level.spawn.launch?.rise ?? 0) : 0
  const start = sim(level.spawn.pos)
  start.y += rise
  const finish = level.finish ? sim(level.finish.pos) : null

  const route = level.route && level.route.length > 1 ? deps.createRoute(level.route) : null
  const arcs = route ? deps.gateArcLengths(route, gates) : gates.map(() => Number.NaN)

  // ── every line vertex: its height over the field, and its walls ──────────
  const vertex = []
  if (route) {
    const right = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < route.count; i++) {
      const x = route.points[i * 3]
      const y = route.points[i * 3 + 1]
      const z = route.points[i * 3 + 2]
      const s = route.cumulative[i]
      let agl = Number.NaN
      let left = false
      let rightWall = false
      if (field && !deps.outsideField(field, x, z)) {
        agl = y - deps.terrainHeightAt(field, x, z)
        deps.routeRightAt(route, s, right)
        for (const side of [1, -1]) {
          for (let d = WALL_STEP; d <= WALL_METRES; d += WALL_STEP) {
            const px = x + right.x * d * side
            const pz = z + right.z * d * side
            if (deps.outsideField(field, px, pz)) continue
            if (deps.terrainHeightAt(field, px, pz) > y) {
              if (side > 0) rightWall = true
              else left = true
              break
            }
          }
        }
      }
      vertex.push({ s, agl, both: left && rightWall, one: left !== rightWall })
    }
  }

  const rows = gates.map((g, i) => {
    const prev = i === 0 ? start : gates[i - 1].centre
    const next = i + 1 < gates.length ? gates[i + 1].centre : finish
    const c = g.centre
    const leg = Math.hypot(c.x - prev.x, c.y - prev.y, c.z - prev.z)
    const turn = next
      ? turnDegrees(heading(prev.x, prev.z, c.x, c.z), heading(c.x, c.z, next.x, next.z))
      : Number.NaN
    const from = i === 0 ? Number.NEGATIVE_INFINITY : arcs[i - 1]
    const on = vertex.filter((v) => v.s > from && v.s <= arcs[i])
    const measured = on.filter((v) => Number.isFinite(v.agl))
    return {
      ring: i,
      name: rings[i].name,
      y: c.y,
      leg,
      climb: c.y - prev.y,
      turn,
      arc: arcs[i],
      points: measured.length,
      both: measured.length ? measured.filter((v) => v.both).length / measured.length : Number.NaN,
      one: measured.length ? measured.filter((v) => v.one).length / measured.length : Number.NaN,
      agl: measured.length ? Math.min(...measured.map((v) => v.agl)) : Number.NaN,
    }
  })

  const measured = vertex.filter((v) => Number.isFinite(v.agl))
  const agls = measured.map((v) => v.agl).sort((a, b) => a - b)
  return {
    id: level.id,
    start: level.spawn.launchKind === 'elevator' ? 'lift top' : 'spawn',
    rings: rows,
    lineMetres: route ? route.length : Number.NaN,
    lineVertices: route ? route.count : 0,
    finishRadius: level.finish?.radius ?? Number.NaN,
    ringRadius: gates[0]?.radius ?? Number.NaN,
    measuredVertices: measured.length,
    bothSides: measured.filter((v) => v.both).length,
    oneSide: measured.filter((v) => v.one).length,
    agl: { p10: percentile(agls, 10), p50: percentile(agls, 50), p90: percentile(agls, 90) },
    turnsOver60: rows.filter((r) => r.turn > 60).length,
  }
}

/** The table as text, the way the plan prints it. */
export const formatLegTable = (t, from = 0) => {
  const f = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—')
  const pc = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—')
  const pad = (s, n) => String(s).padStart(n)
  const lines = [
    `${t.id}: ${t.rings.length} rings, line ${f(t.lineMetres)} m over ${t.lineVertices} vertices, ` +
      `ring r ${f(t.ringRadius, 1)} m, finish r ${f(t.finishRadius, 1)} m; ring 0's leg from the ${t.start}`,
    `${pad('ring', 4)} ${pad('y', 6)} ${pad('leg', 6)} ${pad('climb', 6)} ${pad('turn', 5)} ${pad('arc', 7)} ${pad('both', 5)} ${pad('one', 5)} ${pad('agl', 5)}`,
  ]
  for (const r of t.rings) {
    if (r.ring < from) continue
    lines.push(
      `${pad(r.ring, 4)} ${pad(f(r.y), 6)} ${pad(f(r.leg), 6)} ${pad(f(r.climb), 6)} ` +
        `${pad(f(r.turn), 5)} ${pad(f(r.arc), 7)} ${pad(pc(r.both), 5)} ${pad(pc(r.one), 5)} ${pad(f(r.agl), 5)}`,
    )
  }
  if (t.measuredVertices > 0) {
    lines.push(
      `height over the ground p10 / p50 / p90: ${f(t.agl.p10)} / ${f(t.agl.p50)} / ${f(t.agl.p90)} m; ` +
        `walls both sides at ${t.bothSides} of ${t.measuredVertices} vertices, one side at ${t.oneSide}; ` +
        `${t.turnsOver60} turn(s) over 60°`,
    )
  } else {
    lines.push('no walls: the height map is not on disk (`pnpm assets:pull`)')
  }
  return lines.join('\n')
}

// ── the CLI ───────────────────────────────────────────────────────────────

if (isMain(import.meta.url)) {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const args = process.argv.slice(2)
  const id = args.find((a) => !a.startsWith('--'))
  const fromAt = args.indexOf('--from')
  const from = fromAt >= 0 ? Number(args[fromAt + 1]) : 0
  if (!id) {
    console.error('usage: node tools/content/leg-table.mjs <level id> [--from <ring>]')
    process.exit(2)
  }
  const file = ['content/levels', 'content/authored']
    .map((d) => path.join(REPO_ROOT, d, `${id}.json`))
    .find((p) => fs.existsSync(p))
  if (!file) {
    console.error(`leg-table: no ${id}.json under content/levels or content/authored`)
    process.exit(2)
  }
  const level = JSON.parse(fs.readFileSync(file, 'utf8'))
  const server = await createSsrServer({ logLevel: 'error' })
  try {
    const route = await server.ssrLoadModule('/src/sim/route.ts')
    const { gateArcLengths } = await server.ssrLoadModule('/src/sim/ai-racer.ts')
    const hf = await server.ssrLoadModule('/src/sim/terrain/height-field.ts')
    const { fieldFor, haveMaps } = await server.ssrLoadModule(
      '/tests/unit/helpers/terrain-field.ts',
    )
    const field = haveMaps ? fieldFor(level) : null
    const table = legTable(
      level,
      {
        createRoute: route.createRoute,
        gateArcLengths,
        routeRightAt: route.routeRightAt,
        terrainHeightAt: hf.terrainHeightAt,
        outsideField: hf.outsideField,
      },
      field,
    )
    console.log(formatLegTable(table, from))
  } finally {
    await server.close()
  }
}
