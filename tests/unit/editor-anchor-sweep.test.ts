// tests/unit/editor-anchor-sweep.test.ts — DEV-501 follow-up: the pad's
// heading search and the buried-ring error agree about ring 1.
//
// Found by another session on base `rookie_01_hoverJet`: a new draft's panel
// said "The pad turned 10° so ring 1 clears the ground", and once points were
// added ring 1 — the anchored one — was a `ring-in-ground` ERROR, buried 21.9 m,
// which Lift cannot mend. Reproduced here to the decimal on the island's own
// render surface (`islandGround`, the desk's ground from the real maps).
//
// THE MECHANISM. `anchorHeading` (`editor/core/run-in.ts`) looked for a heading
// whose ring 1 AND the straight to it (the run-in) stand clear, and where
// none did it returned the least-short one — as a bare number. The desk's
// `aimClear` (`editor/desk/index.ts`) could not tell "turned until clear" from
// "turned to the least buried", and said "so ring 1 clears the ground" whenever
// the pad had turned. On rookie_01's new pad no heading clears: the best, 10°
// round, still leaves the run-in 28.9 m short (and ring 1 21.9 m buried).
// Beside it, a second disagreement, smaller: the search built its own ring
// (a disc on the anchored POINT), while the expansion carries the template's
// trigger sphere, which stands 1.9 m off the point on rookie_01 — two copies
// of "ring 1's opening". Now one: `anchoredRing` (`content/player-course.ts`)
// places it, the expansion itself calls it for ring 1, and the search judges
// it with the warning's own `ringIntrusion` (`anchoredRingIntrusion`). The
// search returns `{ yaw, clears }`, and the note (`anchorAimNote`) says
// "clears" only on `clears`, and "move the pad" otherwise.
//
// §1 (runs everywhere): the expanded ring 1 IS `anchoredRing`'s, and the
//     search's measure of it is the warning's, on a made-up hill.
// §2 (the maps): rookie_01's exact case.
// §3 (the maps): the sweep — every HoverJet base the picker offers and seeded
//     islands, the desk's own new-draft pad and adversarial pads (next to
//     cliffs, on steep ground, anywhere on land), points added as the desk adds
//     them: where the pad said ring 1 clears, ring 1 is never buried and the
//     straight to it never short; where it said it does not, the error shows.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionRacers } from '@/content/edition-schema'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import {
  anchoredRing,
  expandPlayerCourse,
  insideArea,
  islandHeightScale,
  PLAYER_COURSE_ISLAND,
  type PlayerCourseArea,
  playerCourseArea,
  ringFacing,
  validatePlayerCourse,
  yawForward,
} from '@/content/player-course'
import {
  aimPad,
  anchorAimNote,
  anchoredRingIntrusion,
  anchorHeading,
  anchorHeightFor,
  type EditorDraft,
  type EditorWarning,
  evaluateDraft,
  type Ground,
  groundClearance,
  movePad,
  newDraft,
  padFootprint,
  padSizeOf,
} from '@/editor/core'
import { addPoint } from '@/editor/core/commands'
import { terrainSurface } from '@/editor/desk/ground'
import {
  courseSlots,
  gridReach,
  nearestDry,
  padSpot,
  type SeatedDraft,
  seatNewDraft,
} from '@/editor/desk/slots'
import {
  customGroundOf,
  donorLand,
  seedGround,
  withCustomGround,
} from '@/game/terrain/custom-ground'
import { environmentTerrains, type LoadedTerrain } from '@/game/terrain/load-terrain'
import { type WaterDisplace, waterDisplacement } from '@/render/water'
import { ISLAND_SYNTH_VERSION } from '@/sim/terrain/island-synth'
import anniversary from '../../content/editions/anniversary.json'
import { islandGround, islandSea, plateWave, shippedLevels } from './helpers/editor-course'
import { haveMaps } from './helpers/terrain-field'

const ANNIV = (anniversary as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers
const NAME = ['Amber', 'Heron'] as const

/** Every base the picker offers from the shipped missions: the HoverJet skies. */
const skies = (): Level[] =>
  shippedLevels().filter((l) => l.vehicle === 'hoverjet' && liveRings(l).length > 0)

const insideOf =
  (area: PlayerCourseArea | null) =>
  (x: number, y: number, z: number): boolean =>
    area ? insideArea(area, { x, y, z }) : true

/** The ring-in-ground error on the ANCHORED ring, if any. */
const anchoredRingError = (ws: readonly EditorWarning[]): EditorWarning | undefined =>
  ws.find((w) => w.kind === 'ring-in-ground' && w.anchored)

/**
 * A new draft as the desk opens one: `seatNewDraft`, the function the desk's
 * seat calls. `d` is the pad placed but NOT aimed (the sweep aims it itself);
 * `seated` is the desk's own result, aimed.
 */
const deskNewDraft = (
  donor: Level,
  ground: Ground,
): { d: EditorDraft; placedYaw: number; seated: SeatedDraft | null } => {
  const d = newDraft(donor, NAME)
  const seated = seatNewDraft(d, donor, ground, ANNIV, insideOf(playerCourseArea(donor)))
  const placed = seated ? movePad(d, seated.draft.course.start.pos) : d
  return { d: placed, placedYaw: d.course.start.yaw, seated }
}

/**
 * The OLD seat (before this follow-up): the nearest good place, whatever ring 1
 * does there — kept to pin the report's case.
 */
const nearestGoodDraft = (donor: Level, ground: Ground): EditorDraft => {
  const d = newDraft(donor, NAME)
  const s = d.course.start
  const inside = insideOf(playerCourseArea(donor))
  const from = customGroundOf(donor) ? (nearestDry(ground, s.pos, inside) ?? s.pos) : s.pos
  const spot = padSpot(ground, donor, ANNIV, { pos: from, yaw: s.yaw }, groundClearance(), inside)
  return spot ? movePad(d, spot.pos) : d
}

/**
 * The line an author clicks after the pad: three points a gap apart, bending
 * `bend` degrees a point from the pad's heading, each at the new-point height
 * over what you see there — as the desk's ground click adds one.
 */
const clickLine = (d: EditorDraft, donor: Level, ground: Ground, bend: number): EditorDraft => {
  const h = anchorHeightFor(donor)
  let out = d
  let p = d.course.path.points[0] as Vec3Tuple
  let yaw = d.course.start.yaw
  for (let k = 0; k < 3; k++) {
    yaw += bend
    const f = yawForward(yaw)
    const x = p[0] + f.x * d.course.path.gap
    const z = p[2] + f.z * d.course.path.gap
    const g = ground.surfaceAt(x, z)
    if (!Number.isFinite(g)) break
    p = [x, g + h, z]
    out = addPoint(out, p)
  }
  return out
}

/** Degrees a point the clicked lines bend by: straight on, and either way. */
const BENDS = [0, 35, -35, 70, -70, 105, -105] as const

// ── §1 ─────────────────────────────────────────────────────────────────────

describe('DEV-501 follow-up — one ring 1, whoever measures it', () => {
  it('the expanded ring 1 of an anchored course IS anchoredRing’s, on every base and heading', () => {
    let checked = 0
    for (const sky of skies()) {
      for (let yaw = -180; yaw < 180; yaw += 30) {
        const d = aimPad(newDraft(sky, NAME), yaw)
        const p0 = d.course.path.points[0] as Vec3Tuple
        const f = yawForward(d.course.start.yaw)
        let c = d
        for (let k = 1; k <= 3; k++) {
          c = addPoint(c, [p0[0] + f.x * 400 * k, p0[1], p0[2] + f.z * 400 * k])
        }
        const v = validatePlayerCourse(c.course, sky)
        if (!v.ok) continue
        const ring = anchoredRing(v.course, sky)
        expect(ring).not.toBeNull()
        const first = liveRings(expandPlayerCourse(v.course, sky))[0]
        expect(first).toEqual(ring)
        // And that ring is the pad's: on the anchored point, facing the pad's heading.
        expect(ring?.pos).toEqual(v.course.path.points[0])
        const facing = ringFacing(ring?.quat ?? [0, 0, 0, 1])
        const want = yawForward(v.course.start.yaw)
        // (To the float noise of carrying the template's own 6-decimal quaternion.)
        expect(Math.hypot(facing.x - want.x, facing.y - want.y, facing.z - want.z)).toBeLessThan(
          1e-5,
        )
        checked++
      }
    }
    expect(checked, 'enough anchored courses expanded to judge').toBeGreaterThan(20)
  })

  it('the search’s measure of ring 1 is the buried-ring error’s, metre for metre', () => {
    const sky = skies()[0] as Level
    const d0 = newDraft(sky, NAME)
    const foot = d0.course.start.pos
    // A ridge across the ground, rising to the side: some headings bury ring 1, some do not.
    const ridge: Ground = {
      surfaceAt: (x, z) => foot[1] + Math.max(0, 0.08 * (x - foot[0]) + 0.02 * (z - foot[2])),
    }
    let buried = 0
    let clear = 0
    for (let yaw = -180; yaw < 180; yaw += 7.5) {
      const d = aimPad(d0, yaw)
      const p0 = d.course.path.points[0] as Vec3Tuple
      const f = yawForward(d.course.start.yaw)
      const c = addPoint(d, [p0[0] + f.x * 1200, p0[1] + 600, p0[2] + f.z * 1200])
      const ev = evaluateDraft(c, sky, ridge)
      if (!ev.level) continue
      const hit = anchoredRingIntrusion(c.course, sky, ridge, groundClearance())
      const err = anchoredRingError(ev.warnings)
      expect(err?.metres ?? null, `yaw ${yaw}`).toBe(hit?.metres ?? null)
      if (hit) buried++
      else clear++
    }
    expect(buried, 'the ridge buries ring 1 at some headings').toBeGreaterThan(3)
    expect(clear, 'and not at others').toBeGreaterThan(3)
  })

  it('wherever the search says ring 1 clears, the evaluation of the course agrees (random slopes)', () => {
    // Tilted planes in every direction and at every height, round each base's
    // pad: the search's verdict is checked against the warnings the author
    // sees. Slopes put the ground's edge within a metre or two of ring 1's rim
    // often, which is where a search with its own model of the ring (the disc
    // on the point, not the template's trigger 1.9 m off it) said "clear" over
    // a buried ring.
    let seed = 20260929
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    let saidClear = 0
    let saidNot = 0
    const wrong: string[] = []
    for (const sky of skies()) {
      const d0 = newDraft(sky, NAME)
      const foot = d0.course.start.pos
      for (let trial = 0; trial < 60; trial++) {
        const a = (rnd() - 0.5) * 0.3
        const b = (rnd() - 0.5) * 0.3
        const c = (rnd() - 0.6) * 30
        const plane: Ground = {
          surfaceAt: (x, z) => foot[1] + c + a * (x - foot[0]) + b * (z - foot[2]),
        }
        const aim = anchorHeading(d0.course, sky, plane)
        const d = aimPad(d0, aim.yaw)
        const p0 = d.course.path.points[0] as Vec3Tuple
        const f = yawForward(d.course.start.yaw)
        const ev = evaluateDraft(
          addPoint(d, [p0[0] + f.x * 1200, p0[1] + 600, p0[2] + f.z * 1200]),
          sky,
          plane,
        )
        if (!ev.level) continue
        const short = ev.warnings.filter((w) => w.anchored)
        if (aim.clears) {
          saidClear++
          if (short.length > 0) wrong.push(`${sky.id} #${trial}: ${short[0]?.message}`)
        } else {
          saidNot++
          if (short.length === 0) wrong.push(`${sky.id} #${trial}: not clear, nothing shown`)
        }
      }
    }
    expect(wrong).toEqual([])
    expect(saidClear).toBeGreaterThan(50)
    expect(saidNot).toBeGreaterThan(50)
  })

  it('the note says "clears" only when the search found a heading that does', () => {
    expect(anchorAimNote(60, { yaw: 50, clears: true })).toBe(
      'The pad turned 10° so ring 1 clears the ground.',
    )
    expect(anchorAimNote(60, { yaw: 60, clears: true })).toBe('')
    for (const aim of [
      { yaw: 50, clears: false },
      { yaw: 60, clears: false },
    ]) {
      const note = anchorAimNote(60, aim)
      expect(note).not.toContain('so ring 1 clears')
      expect(note).toContain('move the pad')
    }
  })
})

// ── §2 ─────────────────────────────────────────────────────────────────────

describe.skipIf(!haveMaps)('DEV-501 follow-up — rookie_01’s new draft (the report)', () => {
  it('at the nearest good place no heading clears ring 1: said so, and the error stands', () => {
    const donor = skies().find((l) => l.id === 'rookie_01_hoverJet') as Level
    const ground = islandGround(donor)
    // Where the desk stood the pad before this follow-up: the nearest good place.
    const d = nearestGoodDraft(donor, ground)
    const placedYaw = newDraft(donor, NAME).course.start.yaw
    const aim = anchorHeading(d.course, donor, ground)
    const note = anchorAimNote(placedYaw, aim)
    // The report: "The pad turned 10° so ring 1 clears the ground". It turned
    // 10° to the least-short heading; none clears.
    expect(aim.clears).toBe(false)
    expect(note).not.toContain('so ring 1 clears')
    expect(note).toContain('move the pad')
    const aimed = aimPad(d, aim.yaw)
    // The first line of clicks that makes a course (straight on leaves the boundary here).
    const ev = BENDS.map((b) =>
      evaluateDraft(clickLine(aimed, donor, ground, b), donor, ground),
    ).find((e) => e.level !== null)
    if (!ev) throw new Error('no line of clicks made a course')
    const err = anchoredRingError(ev.warnings)
    expect(err?.message).toContain('turn or move the pad')
    // …and the search measured the ring the error measures.
    expect(err?.metres).toBe(
      anchoredRingIntrusion(aimed.course, donor, ground, groundClearance())?.metres,
    )
  })

  it('the new draft now stands where ring 1 clears, and a course clicked from it is clear', () => {
    const donor = skies().find((l) => l.id === 'rookie_01_hoverJet') as Level
    const ground = islandGround(donor)
    const { seated } = deskNewDraft(donor, ground)
    expect(seated?.aim.clears).toBe(true)
    const d = seated?.draft as EditorDraft
    expect(d.course.start.pos).not.toEqual(nearestGoodDraft(donor, ground).course.start.pos)
    let judged = 0
    for (const b of BENDS) {
      const ev = evaluateDraft(clickLine(d, donor, ground, b), donor, ground)
      if (!ev.level) continue
      judged++
      expect(ev.warnings.filter((w) => w.anchored).map((w) => w.message)).toEqual([])
    }
    expect(judged).toBeGreaterThan(0)
  })
})

// ── §3 ─────────────────────────────────────────────────────────────────────

/** A pad site worth trying, and why. */
interface Site {
  readonly why: 'desk' | 'cliff' | 'steep' | 'land'
  readonly d: EditorDraft
  readonly fromYaw: number
  /** The desk's own seat, for the 'desk' site. */
  readonly seated?: SeatedDraft | null
}

/**
 * Pad sites over `donor`: the desk's own new-draft site, and — from a grid
 * over the play area — the flat sites with the most ground rising within a
 * ring gap (next to cliffs), the steepest sites (the desk seats a dragged pad
 * on the highest ground under it, slope or not), and a spread of any land.
 */
const sitesOf = (donor: Level, ground: Ground): Site[] => {
  const { d, placedYaw, seated } = deskNewDraft(donor, ground)
  const out: Site[] = [{ why: 'desk', d, fromYaw: placedYaw, seated }]
  const area = playerCourseArea(donor)
  const size = padSizeOf(donor)
  if (!area || !size) return out
  const lo = area.kind === 'sphere' ? area.centre.map((c) => c - area.radius) : area.min
  const hi = area.kind === 'sphere' ? area.centre.map((c) => c + area.radius) : area.max
  const inside = insideOf(area)
  const gap = d.course.path.gap
  const step = 128
  const cand: { pos: Vec3Tuple; cliff: number; slope: number }[] = []
  for (let x = (lo[0] as number) + step / 2; x < (hi[0] as number); x += step) {
    for (let z = (lo[2] as number) + step / 2; z < (hi[2] as number); z += step) {
      if (ground.waterAt?.(x, z)) continue
      const under = padFootprint(ground, [x, 0, z], size)
      if (!under || !inside(x, under.high, z)) continue
      let cliff = Number.NEGATIVE_INFINITY
      for (let k = 0; k < 16; k++) {
        const a = (2 * Math.PI * k) / 16
        for (const r of [gap * 0.5, gap]) {
          const g = ground.surfaceAt(x + r * Math.cos(a), z + r * Math.sin(a))
          if (Number.isFinite(g)) cliff = Math.max(cliff, g - under.high)
        }
      }
      cand.push({ pos: [x, under.high, z], cliff, slope: under.high - under.low })
    }
  }
  const flat = cand.filter((c) => c.slope <= groundClearance())
  const pick = (list: typeof cand, n: number, why: Site['why']): void => {
    for (const c of list.slice(0, n)) {
      const moved = movePad(d, c.pos)
      out.push({ why, d: moved, fromYaw: moved.course.start.yaw })
    }
  }
  pick(
    [...flat].sort((a, b) => b.cliff - a.cliff),
    5,
    'cliff',
  )
  pick(
    [...cand].sort((a, b) => b.slope - a.slope),
    3,
    'steep',
  )
  const every = Math.max(1, Math.floor(cand.length / 6))
  pick(
    cand.filter((_, i) => i % every === 0),
    6,
    'land',
  )
  return out
}

/** The bases: every HoverJet sky, and seeded islands over two of them. */
const bases = (): Level[] => {
  const all = skies()
  const seeded: Level[] = []
  // The seed dialog's defaults (rugged 0.5, sea 0.45), and seed 1 as
  // `editor-seed.spec` makes it: the flat shore whose pad the sea covered.
  for (const [id, seed, rugged, sea] of [
    ['int_01_hoverJet', 77, 0.5, 0.45],
    ['int_01_hoverJet', 20260929, 0.5, 0.45],
    ['int_01_hoverJet', 1, 0.25, 0.2],
    ['adv_01_hoverJet', 4242, 0.5, 0.45],
  ] as const) {
    const sky = all.find((l) => l.id === id)
    if (!sky) continue
    const island = sky.environment
    // The island's own side and its full height, as the dialog opens.
    const size = donorLand(island).entry.terrainSize
    const height = islandHeightScale(island) ?? PLAYER_COURSE_ISLAND.minHeight
    const ground = seedGround(
      seed,
      { size, height, rugged, sea },
      island,
      undefined,
      ISLAND_SYNTH_VERSION,
    )
    seeded.push(withCustomGround(sky, ground))
  }
  return [...all, ...seeded]
}

describe.skipIf(!haveMaps)(
  'DEV-501 follow-up — the sweep: a pad that says ring 1 clears is right',
  () => {
    it('on every base, at the desk’s pad and adversarial ones, with points added', () => {
      const tally = { sites: 0, clears: 0, notClear: 0, judged: 0, bases: 0, seeded: 0 }
      const failures: string[] = []
      /** Bases whose NEW draft opens on a pad no heading clears (said, not hidden). */
      const deskNotClear: string[] = []
      for (const donor of bases()) {
        const ground = islandGround(donor)
        const label = customGroundOf(donor) ? `${donor.id}+seed` : donor.id
        tally.bases++
        if (customGroundOf(donor)) tally.seeded++
        for (const site of sitesOf(donor, ground)) {
          tally.sites++
          const aim = anchorHeading(site.d.course, donor, ground)
          const note = anchorAimNote(site.fromYaw, aim)
          const aimed = aimPad(site.d, aim.yaw)
          if (aim.clears) tally.clears++
          else tally.notClear++
          if (site.why === 'desk') {
            if (!aim.clears) deskNotClear.push(label)
            // The desk's own result is this site aimed: the same heading, the same verdict.
            if (site.seated) expect(site.seated.aim).toEqual(aim)
          }
          for (const bend of BENDS) {
            const ev = evaluateDraft(clickLine(aimed, donor, ground, bend), donor, ground)
            if (!ev.level) continue
            tally.judged++
            const where = `${label} ${site.why} pad@${aimed.course.start.pos.map((n) => Math.round(n))} yaw ${aim.yaw} bend ${bend}`
            const anchoredShort = ev.warnings.filter((w) => w.anchored)
            const err = anchoredRingError(ev.warnings)
            // The two measure one ring with one rule.
            const hit = anchoredRingIntrusion(aimed.course, donor, ground, groundClearance())
            if ((err?.metres ?? null) !== (hit?.metres ?? null)) {
              failures.push(`${where}: error ${err?.metres} vs search ${hit?.metres}`)
            }
            if (aim.clears) {
              // Said (or would say) it clears: ring 1 is not buried, the straight is not short.
              if (anchoredShort.length > 0) {
                failures.push(
                  `${where}: said "${note}" but ${anchoredShort.map((w) => w.message).join(' | ')}`,
                )
              }
            } else {
              // Said it does not clear: the author is shown why.
              expect(note).toContain('move the pad')
              const outside = ev.warnings.some((w) => w.kind === 'point-outside' && w.point === 0)
              if (anchoredShort.length === 0 && !outside) {
                failures.push(`${where}: no heading cleared, yet nothing anchored is short`)
              }
            }
          }
        }
      }
      console.info(`editor-anchor-sweep: ${JSON.stringify({ ...tally, deskNotClear })}`)
      expect(failures).toEqual([])
      // Every base's NEW draft opens on a pad whose ring 1 clears — or the base
      // has no place within the search's reach from which any heading clears,
      // and is named here, on purpose. None has today.
      const NO_CLEARING_PLACE: readonly string[] = []
      expect(deskNotClear).toEqual(NO_CLEARING_PLACE)
      // The sweep reached what it claims to: every base, both verdicts, real courses.
      expect(tally.seeded).toBeGreaterThan(0)
      expect(tally.clears).toBeGreaterThan(0)
      expect(tally.notClear).toBeGreaterThan(0)
      expect(tally.judged).toBeGreaterThan(tally.sites)
    }, 240_000)
  },
)

/**
 * The DRAWN sea at level-frame (x, z) at time `t`, as the renderer moves it:
 * every vertex of the plate lifted by `waterDisplacement` at its own Unity
 * position (the vertex shader's `WAVE_GLSL`), the whole group by the bob at
 * the plate's origin (`setWaveTime`), read on the facets through the editor's
 * own `terrainSurface`. (It does not model the ocean's sub-facets, whose
 * jittered interior vertices ride the same wave; `waveCeiling` bounds those too.)
 */
const drawnSea = (
  sea: LoadedTerrain,
  displace: WaterDisplace,
  bobOrigin: readonly number[],
  near: readonly number[],
  reach: number,
): ((t: number) => (x: number, z: number) => number) => {
  const g = sea.surfaceGrid
  const m = sea.group.matrixWorld
  const v = new THREE.Vector3()
  const n = g.verts.length / 3
  // Only the vertices within `reach` of `near` (level frame) are moved: the
  // facets under the points asked about are made of them.
  const moving: number[] = []
  const unity: number[] = []
  for (let i = 0; i < n; i++) {
    v.set(g.verts[i * 3] as number, 0, -(g.verts[i * 3 + 2] as number)).applyMatrix4(m)
    if (Math.hypot(v.x - (near[0] as number), v.z - (near[2] as number)) > reach) continue
    moving.push(i)
    unity.push(v.x, -v.z)
  }
  const verts = new Float32Array(g.verts)
  const yScale = sea.group.scale.y
  return (t) => {
    moving.forEach((i, k) => {
      verts[i * 3 + 1] =
        (g.verts[i * 3 + 1] as number) +
        waterDisplacement(displace, unity[k * 2] as number, unity[k * 2 + 1] as number, t) / yScale
    })
    const bob = waterDisplacement(displace, bobOrigin[0] as number, bobOrigin[2] as number, t)
    const moved = terrainSurface({
      ...sea,
      surfaceGrid: { verts, vertPerSide: g.vertPerSide },
    } as LoadedTerrain)
    return (x, z) => moved(x, z) + bob
  }
}

describe.skipIf(!haveMaps)('DEV-501 follow-up — water is judged at the HIGH-water mark', () => {
  it('no new pad, nor a racer’s beside it, is ever under the drawn sea, and the sea never passes the mark', () => {
    // The sea bobs (2016's whole-plate bob, ±3.459 m on Simonet) and chops. On
    // a seeded shore at 116-117 m a new pad stood where the sea is drawn up to
    // 120 at the top of every wave (photographed); the ground judged it at rest.
    const tally: string[] = []
    for (const donor of bases()) {
      const sea = islandSea(donor)
      if (!sea) continue
      const { displace, bobOrigin } = plateWave(
        environmentTerrains(donor.environment).ocean as string,
      )
      if (!displace) continue
      const ground = islandGround(donor)
      const seated = seatNewDraft(
        newDraft(donor, NAME),
        donor,
        ground,
        ANNIV,
        insideOf(playerCourseArea(donor)),
      )
      if (!seated) continue
      const s = seated.draft.course.start
      const size = padSizeOf(donor) as readonly number[]
      const half = Math.max(size[0] as number, size[2] as number) / 2
      const at: (readonly [number, number])[] = [[s.pos[0], s.pos[2]]]
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        at.push([s.pos[0] + half * Math.cos(a), s.pos[2] + half * Math.sin(a)])
      }
      for (const slot of courseSlots(s, donor, ANNIV)) at.push([slot.foot[0], slot.foot[2]])
      const rest = terrainSurface(sea)
      // Past the farthest racer's pad by more than a sea facet's diagonal (256 m
      // facets at the plate's 8x scale), so every facet asked about is moved whole.
      const wave = drawnSea(sea, displace, bobOrigin, s.pos, gridReach(donor, ANNIV) + 600)
      const period = (2 * Math.PI) / displace.speed
      let rise = Number.NEGATIVE_INFINITY
      let margin = Number.POSITIVE_INFINITY
      for (let k = 0; k < 48; k++) {
        const drawn = wave((k / 48) * period)
        for (const [x, z] of at) {
          const d = drawn(x, z)
          rise = Math.max(rise, d - rest(x, z))
          // `surfaceAt` is the land where it stands over the high-water sea.
          if (!ground.waterAt?.(x, z)) margin = Math.min(margin, ground.surfaceAt(x, z) - d)
        }
      }
      const label = customGroundOf(donor) ? `${donor.id}+seed` : donor.id
      tally.push(
        `${label}: drawn up to ${rise.toFixed(2)} m over rest (mark ${sea.highWater.toFixed(3)}), land clear by ${margin.toFixed(1)} m`,
      )
      expect(rise, label).toBeLessThanOrEqual(sea.highWater + 1e-6)
      expect(seated.aim.clears, label).toBe(true)
      expect(ground.waterAt?.(s.pos[0], s.pos[2]), label).toBe(false)
      expect(margin, `${label}: the pad's ground under the drawn sea`).toBeGreaterThan(0)
    }
    console.info(`editor-anchor-sweep high water:\n  ${tally.join('\n  ')}`)
    expect(tally.length).toBeGreaterThan(3)
  }, 240_000)
})

describe.skipIf(haveMaps)(
  'DEV-501 follow-up — the island cases are gated (loud counterpart)',
  () => {
    it('skips only because the gitignored height maps are absent', () => {
      expect(haveMaps).toBe(false)
    })
  },
)
