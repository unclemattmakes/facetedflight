// tests/unit/racer-grid.test.ts — where five racers stand, and that it is a
// grid the player is at the back of. DEV-125.
//
// Matt: *"add 3 more racers to the hover jet. these should be aligned in front
// of the player at the race start."*
//
// The claims worth a test are GEOMETRIC — the orientation lesson. A slot that
// says "12 m ahead, 13 m right" must land 12 m along the direction the ship's
// nose points and 13 m to the pilot's right, in the world, on every HoverJet
// course. That is measured back off the world position rather than off the
// quaternion the helper used, and "the nose points along the course" is
// measured against the route's own first leg, which nothing in the helper
// reads.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import {
  inSpawnFrame,
  padStandoff,
  padTop,
  racerStarts,
  roomStarts,
  seatOverDishFoot,
  spawnFrame,
} from '@/game/racer-grid'
import { assignTunings, PADS_ONLY } from '@/game/racers'
import { HOVERJET } from '@/generated/constants.generated'
import { AI_RACER_TUNINGS } from '@/sim/ai-racer'
import { hullFromColliders } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVELS = 'content/levels'
const hoverJets = (): { id: string; level: Level }[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => ({
      id: f.replace('.json', ''),
      level: JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as Level,
    }))
    .filter(({ level }) => level.vehicle === 'hoverjet')

const ANNIV = (anniversary as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers
const CLASSIC = (classic as unknown as { gameplay: { racers: EditionRacers } }).gameplay.racers
const level = int01 as unknown as Level
/**
 * DEV-477: metres of gate-0 distance the first three room starts (the pad and
 * 2016's two) may spread across. Measured worst 6.81 m, on `adv_02`.
 */
const BACK_SPREAD_M = 7.5

/** The pads tagged `ai`, as the level carries them. */
const aiPads = (l: Level) =>
  (
    (l.spawn as { startGrid?: { pads?: { role: string; pos: number[] }[] } }).startGrid?.pads ?? []
  ).filter((p) => p.role === 'ai')

describe('the spawn frame', () => {
  /** Degrees between the spawn heading and the route's first leg. */
  const headingOffCourse = (l: Level): number => {
    const route = (l as unknown as { route: number[][] }).route
    const a = route[0] as number[]
    const b = route[5] as number[]
    const dx = (b[0] as number) - (a[0] as number)
    const dz = (b[2] as number) - (a[2] as number)
    const len = Math.hypot(dx, dz)
    const { forward } = spawnFrame(l)
    const cos = (forward[0] * dx + forward[2] * dz) / len
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  }
  const racing = (l: Level) =>
    ((l as unknown as { forcedMode?: string }).forcedMode ?? l.mode) === 'ringAttack'

  it('points along the COURSE on every course that RACES, not just the one measured', () => {
    // "Ahead" is the spawn heading; the claim in `racer-grid.ts` is that the
    // spawn heading is the route's first direction. Measured on int_01 as 1.3°;
    // held here on all six Ring Attack courses, against the route — an
    // independent source the helper never reads. The agreement lesson: a rule
    // tested only where it was derived has not been tested. Measured: 0.6° to
    // 6.3°, with gate 0 79–122 m ahead within 4° on every one.
    let checked = 0
    for (const { id, level } of hoverJets()) {
      if (!racing(level)) continue
      checked++
      expect(headingOffCourse(level), `${id}: spawn heading vs first route leg`).toBeLessThan(10)
    }
    expect(checked).toBe(6)
  })

  it('and the one HoverJet course that does NOT race points somewhere else entirely', () => {
    // hoverJet_kauai_beg is int_01's course authored again in Kauai, forced to
    // Free Flight: its spawn heading is 86° off the route's first leg and gate
    // 0 is 2.5 km away. So "the spawn heading is the course direction" is a
    // property of the racing courses, not of the spawn — and it is exactly the
    // course on which no grid is ever drawn, because Free Flight has no
    // opponents (`ModeRules.opponents`). The counter-case, kept loud.
    const kauai = hoverJets().find(({ id }) => id === 'hoverJet_kauai_beg')?.level as Level
    expect(racing(kauai)).toBe(false)
    expect(headingOffCourse(kauai)).toBeGreaterThan(45)
  })

  it('has the 2016 AI pads on the SHOULDERS, which is what right means', () => {
    // The pads are 2016's, extracted, and they flank the player. Read back in
    // the spawn frame they must be small in `ahead` and ±16 m in `right` — one
    // each side. That is the sign check on `right`, made against data the
    // helper did not produce.
    const sides = aiPads(level).map((p) => inSpawnFrame(level, p.pos))
    expect(sides).toHaveLength(2)
    for (const s of sides) {
      expect(Math.abs(s.ahead), 'beside, not ahead').toBeLessThan(4)
      expect(Math.abs(s.right)).toBeGreaterThan(12)
      expect(Math.abs(s.right)).toBeLessThan(20)
    }
    expect(Math.sign(sides[0]?.right as number)).not.toBe(Math.sign(sides[1]?.right as number))
  })
})

describe('the Anniversary grid', () => {
  it('is five: the two 2016 pads and three slots, pads first', () => {
    const starts = racerStarts(level, ANNIV)
    expect(starts).toHaveLength(5)
    expect(starts.slice(0, 2).map((s) => s.from.kind)).toEqual(['pad', 'pad'])
    expect(starts.slice(2).map((s) => s.from.kind)).toEqual(['slot', 'slot', 'slot'])
  })

  it('puts every slot where the preset said, measured back from the world', () => {
    // Round trip through the world, not through the same rotation: build the
    // world position, then measure its ahead/right from the spawn using the
    // route-checked frame. A sign error in either axis fails here.
    const starts = racerStarts(level, ANNIV)
    ANNIV.slots.forEach((slot, i) => {
      const s = starts[2 + i] as (typeof starts)[number]
      const back = inSpawnFrame(level, s.pos)
      expect(back.ahead, `slot ${i} ahead`).toBeCloseTo(slot.ahead, 6)
      expect(back.right, `slot ${i} right`).toBeCloseTo(slot.right, 6)
    })
  })

  it('stands every preset SLOT at the release altitude, on one line', () => {
    // The 2016 pads no longer stand here — see the DEV-158 block below. The
    // slots still do: their pads are drawn at one deck height the port chose,
    // and their altitude was authored against the sightline to gate 0.
    const releaseY = (level.spawn.pos[1] as number) + (level.spawn.launch?.rise ?? 0)
    for (const s of racerStarts(level, ANNIV).filter((s) => s.from.kind === 'slot')) {
      expect(s.pos[1]).toBeCloseTo(releaseY, 9)
    }
  })

  it('is AHEAD of the player and does not stand in the first gate', () => {
    // The 2016 launch view (video 00:55 alpine, 09:25 Simonet): the first gate
    // is straight ahead at about 100 m, at eye height. int_01's gate 0 is
    // 122 m ahead and 23 m above the release line. Every slot must be ahead of
    // the player — the ask — and BELOW the line of sight to that gate, so the
    // grid sits under the ring in the view rather than across it.
    const gate = (level as unknown as { routes: Record<string, { rings: { pos: number[] }[] }> })
      .routes['0']?.rings[0]?.pos as number[]
    const g = inSpawnFrame(level, gate)
    const releaseY = (level.spawn.pos[1] as number) + (level.spawn.launch?.rise ?? 0)
    const gateElevation = Math.atan2((gate[1] as number) - releaseY, g.ahead)
    for (const s of racerStarts(level, ANNIV).filter((s) => s.from.kind === 'slot')) {
      const f = inSpawnFrame(level, s.pos)
      expect(f.ahead, 'ahead of the player').toBeGreaterThan(5)
      // A ship at release height, nose to tail ~6 m, top ~2 m above its origin.
      const shipTopElevation = Math.atan2(2, f.ahead)
      expect(shipTopElevation, 'under the gate').toBeLessThan(gateElevation)
    }
  })

  it('keeps two hull widths between every pair of ships on the grid', () => {
    // 13 m of lateral spacing against a 5.5–6 m hull; the closest pair on the
    // whole grid, pads included, must still clear one hull with room.
    const starts = racerStarts(level, ANNIV)
    let closest = Number.POSITIVE_INFINITY
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        const a = starts[i] as (typeof starts)[number]
        const b = starts[j] as (typeof starts)[number]
        closest = Math.min(closest, Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]))
      }
    }
    expect(closest).toBeGreaterThan(10)
    // And the player's own release point is clear of all of them.
    for (const s of starts) {
      expect(
        Math.hypot(
          s.pos[0] - (level.spawn.pos[0] as number),
          s.pos[2] - (level.spawn.pos[2] as number),
        ),
      ).toBeGreaterThan(10)
    }
  })

  it("gives a rookie course 2016's two ghost starts and its three slots: five (DEV-457)", () => {
    // rookie_01 / rookie_02 authored no `ai` pad. Matt, 2026-09-27: *"5 racers
    // on rookie"*. So 2016's two starts (DEV-442) join Anniversary's grid there
    // too, first, where the pad courses put their pads — five, as they have.
    let checked = 0
    for (const { id, level: l } of hoverJets()) {
      if (aiPads(l).length > 0) continue
      const starts = racerStarts(l, ANNIV)
      expect(
        starts.map((s) => s.from.kind),
        id,
      ).toEqual(['ghost', 'ghost', 'slot', 'slot', 'slot'])
      checked++
    }
    expect(checked, 'the two rookie courses').toBe(2)
  })

  it('keeps every pair of ships apart on every racing course, and the ghosts out of the way to gate 0', () => {
    // The ghost starts stand 17 m off the shoulders and the chevron's pair
    // 12 m ahead at 13 m out, so the closest new pair is a ghost and a slot on
    // one side: 12.6 m. Measured on all six Ring Attack courses, not the one
    // the chevron was laid out on. And a ghost start stands BESIDE the player,
    // never ahead, so DEV-457 puts nothing between the player and gate 0.
    //
    // (The chevron's own first two slots stand 0.02 to 0.05 rad OVER the line
    // to gate 0 on `adv_01` and `rookie_02` — the case above holds it on
    // `int_01` only. DEV-125's, not this row's; the ledger row says so.)
    let checked = 0
    for (const { id, level: l } of hoverJets()) {
      if (((l as unknown as { forcedMode?: string }).forcedMode ?? l.mode) !== 'ringAttack')
        continue
      const starts = racerStarts(l, ANNIV)
      expect(starts, id).toHaveLength(5)
      for (let i = 0; i < starts.length; i++) {
        for (let j = i + 1; j < starts.length; j++) {
          const a = starts[i] as (typeof starts)[number]
          const b = starts[j] as (typeof starts)[number]
          expect(
            Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]),
            `${id}: ${a.from.kind} ${a.from.index} to ${b.from.kind} ${b.from.index}`,
          ).toBeGreaterThan(10)
        }
      }
      checked++
      for (const s of starts.filter((s) => s.from.kind === 'ghost')) {
        expect(Math.abs(inSpawnFrame(l, s.pos).ahead), `${id}: ghost ${s.from.index}`).toBeLessThan(
          3,
        )
      }
    }
    expect(checked, 'the six Ring Attack courses').toBe(6)
  })
})

describe('the Classic grid', () => {
  it('is exactly 2016 — the pads, and the slot list is never read', () => {
    const starts = racerStarts(level, CLASSIC)
    expect(starts).toHaveLength(2)
    expect(starts.every((s) => s.from.kind === 'pad')).toBe(true)
    // A Classic preset with slots in it changes nothing: the flag is the gate.
    const poisoned: EditionRacers = { ...CLASSIC, slots: [{ ahead: 30, right: 0 }] }
    expect(racerStarts(level, poisoned)).toHaveLength(2)
    // And PADS_ONLY, what a caller with no preset gets, is the same thing.
    expect(racerStarts(level, PADS_ONLY)).toEqual(starts)
  })
})

// ── DEV-442: 2016 raced EVERY Ring Attack course, the rookies too ────────
//
// Matt, 2026-09-27: *"i was stuck on the classic mode - and there were no
// other racers in the map with me."* Classic's grid was the `ai` pads alone,
// so the two rookie courses (the green mark on two of Ring Attack's three
// places) raced nobody. The oracle is OUTSIDE the grid: 2016's own census,
// `level.ghosts` — two GhostRacers flying their own course on every HoverJet
// mission (DEV-055, `opponents.test.ts`) — and where those recordings BEGIN,
// which the extractor reads off the clips (`GhostRef.start`).
describe('DEV-442: Classic races who 2016 raced, where 2016 raced them', () => {
  const racingCourses = () =>
    hoverJets().filter(
      ({ level: l }) =>
        ((l as unknown as { forcedMode?: string }).forcedMode ?? l.mode) === 'ringAttack',
    )

  it('puts as many racers on every Ring Attack course as 2016 flew ghosts on it', () => {
    let checked = 0
    for (const { id, level: l } of racingCourses()) {
      checked++
      expect(l.ghosts.length, `${id}: 2016's census`).toBe(2)
      expect(racerStarts(l, CLASSIC).length, `${id}: Classic's grid`).toBe(l.ghosts.length)
    }
    expect(checked, 'the six Ring Attack courses').toBe(6)
  })

  it('reads every HoverJet ghost start off its clip: none is missing', () => {
    // A null is the extractor saying it could not read the clip, and an absent
    // field is an extractor that never looked. Loud here either way, so a
    // course cannot quietly fall back to racing nobody.
    for (const { id, level: l } of racingCourses()) {
      for (const g of l.ghosts) {
        expect(g.start, `${id} ${g.clip}`).toHaveLength(3)
        for (const v of g.start ?? []) expect(Number.isFinite(v), `${id} ${g.clip}`).toBe(true)
      }
    }
  })

  it('reads the SHIP, not the object: on every course with pads each start is on a pad', () => {
    // The start is a clip key, the pads are the start prefab's transforms: two
    // sources that share nothing. On all four pad courses every 2016 ghost
    // began within 2.7 m (level) of an `ai` pad, hovering on it. `spawn` does
    // not agree (3.2 km off on int_02): it is the object, not the ship.
    let checked = 0
    for (const { id, level: l } of racingCourses()) {
      const pads = aiPads(l)
      if (pads.length === 0) continue
      for (const g of l.ghosts) {
        const s = g.start as readonly number[]
        const nearest = Math.min(
          ...pads.map((p) =>
            Math.hypot(
              (p.pos[0] as number) - (s[0] as number),
              (p.pos[2] as number) - (s[2] as number),
            ),
          ),
        )
        expect(nearest, `${id} ${g.clip}`).toBeLessThan(3)
        checked++
      }
    }
    expect(checked, 'eight ghosts on four pad courses').toBe(8)
  })

  it('agrees with the shipped int_01 recordings: the world offset plus their first key', () => {
    // `game/ghosts.ts` places a recording at `worldOffset` + its keys; the
    // extractor composes the clip through the ghost's parent. Different tools,
    // one answer, to the recording's own 1 mm quantisation.
    for (const g of level.ghosts) {
      const rec = JSON.parse(
        fs.readFileSync(path.join('content/ghosts', `${g.clip}.json`), 'utf8'),
      ) as { p: number[]; quant: { pos: number } }
      const off = level.worldOffset as readonly number[]
      const s = g.start as readonly number[]
      for (let k = 0; k < 3; k++) {
        const want = (off[k] as number) + (rec.p[k] as number) / rec.quant.pos
        expect(Math.abs((s[k] as number) - want), `${g.clip} axis ${k}`).toBeLessThan(0.001)
      }
    }
  })

  it('stands the rookie racers level with the player, one off each shoulder, with no pad', () => {
    // Measured back from the world in the route-checked spawn frame, so a sign
    // or a frame error fails: 17 m out, level (within 3 m) and 0.4 to 1.3 m
    // above the release — where 2016's recordings hovered before they left.
    let checked = 0
    for (const { id, level: l } of racingCourses()) {
      if (aiPads(l).length > 0) continue
      const starts = racerStarts(l, CLASSIC)
      expect(
        starts.map((s) => s.from.kind),
        id,
      ).toEqual(['ghost', 'ghost'])
      const releaseY = (l.spawn.pos[1] as number) + (l.spawn.launch?.rise ?? 0)
      const sides = starts.map((s) => inSpawnFrame(l, s.pos))
      for (const [i, side] of sides.entries()) {
        expect(Math.abs(side.ahead), `${id} ${i}: level with the player`).toBeLessThan(3)
        expect(Math.abs(side.right), `${id} ${i}: off the shoulder`).toBeGreaterThan(15)
        expect(Math.abs(side.right), `${id} ${i}: off the shoulder`).toBeLessThan(19)
        const above = (starts[i]?.pos[1] as number) - releaseY
        expect(above, `${id} ${i}: at the release`).toBeGreaterThan(0)
        expect(above, `${id} ${i}: at the release`).toBeLessThan(2)
      }
      expect(Math.sign(sides[0]?.right as number), id).not.toBe(
        Math.sign(sides[1]?.right as number),
      )
      checked++
    }
    expect(checked, 'the two rookie courses').toBe(2)
  })

  it('leaves every pad course exactly as it was: the pads, and never a ghost start', () => {
    for (const { id, level: l } of racingCourses()) {
      if (aiPads(l).length === 0) continue
      expect(
        racerStarts(l, CLASSIC).map((s) => s.from.kind),
        id,
      ).toEqual(['pad', 'pad'])
    }
  })

  it('races every Ring Attack course on BOTH editions, which is what Quick Race promises', () => {
    // `game/quick-race.ts` draws from all six and says so: "every course this
    // returns is raced against them". Two in six were not, on Classic.
    for (const { id, level: l } of racingCourses()) {
      expect(racerStarts(l, CLASSIC).length, `${id} classic`).toBeGreaterThan(0)
      expect(racerStarts(l, ANNIV).length, `${id} anniversary`).toBeGreaterThan(0)
    }
  })
})

describe('handing out the controllers', () => {
  it('gives five starts five DIFFERENT tunings, in sheet order', () => {
    const assigned = assignTunings(racerStarts(level, ANNIV))
    expect(assigned.map((a) => a.tuning)).toEqual(Object.keys(AI_RACER_TUNINGS))
    expect(new Set(assigned.map((a) => a.id)).size).toBe(5)
  })

  it('honours a slot that names its tuning and keeps the name out of the rotation', () => {
    const grid: EditionRacers = {
      ...ANNIV,
      slots: [
        { ahead: 12, right: -13, tuning: 'fast' },
        { ahead: 12, right: 13 },
      ],
    }
    const assigned = assignTunings(racerStarts(level, grid))
    // Two pads take the rotation minus `fast`; the named slot takes `fast`.
    expect(assigned.map((a) => a.tuning)).toEqual(['steady', 'cutter', 'fast', 'wide'])
    expect(assigned.map((a) => a.id)).toEqual(['steady', 'cutter', 'fast', 'wide'])
  })

  it('numbers a repeated tuning so no two racers share an id', () => {
    const many: EditionRacers = {
      ...ANNIV,
      slots: Array.from({ length: 6 }, (_, i) => ({ ahead: 12 + 10 * i, right: 0 })),
    }
    const assigned = assignTunings(racerStarts(level, many))
    expect(assigned).toHaveLength(8)
    expect(new Set(assigned.map((a) => a.id)).size).toBe(8)
    expect(assigned.filter((a) => a.tuning === 'fast').map((a) => a.id)).toEqual(['fast', 'fast-2'])
  })

  it('refuses a tuning nobody has heard of, naming the ones that exist', () => {
    const grid: EditionRacers = { ...ANNIV, slots: [{ ahead: 12, right: 0, tuning: 'ludicrous' }] }
    expect(() => assignTunings(racerStarts(level, grid))).toThrow(/ludicrous.*fast, steady/)
  })
})

// ── DEV-158: nobody starts with their belly in a pad ─────────────────────
//
// Matt, from a VR playthrough: *"instead of toggling it on, let's just start
// with it enabled. this way our player and ai jets don't start with their
// bellies on the pads."*
//
// Every claim here is a DISTANCE — metres from the lowest point of a hull to
// the top face of the pad under it. The orientation lesson's rule: a distance
// is true independently of what anyone believed about the placement.

/** Metres from a HoverJet's origin down to the lowest point of its hull. */
const HULL_DEPTH = (() => {
  let lowest = 0
  for (const s of hullFromColliders(
    HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  )) {
    if (s.y - s.radius < lowest) lowest = s.y - s.radius
  }
  return -lowest
})()

/**
 * DEV-554's census: metres each 2016 pad start came down, by course and pad.
 * One number on all ten: every one of 2016's AI pads is the same size, so the
 * old rule (the box's top plus DEV-158's stand-off) and the new (the foot plus
 * the lift's 2.2 m) differ by a constant.
 */
const MOVED_554: readonly string[] = [
  'adv_01_hoverJet 0 0.959',
  'adv_01_hoverJet 1 0.959',
  'adv_02_hoverJet 0 0.959',
  'adv_02_hoverJet 1 0.959',
  'hoverJet_kauai_beg 0 0.959',
  'hoverJet_kauai_beg 1 0.959',
  'int_01_hoverJet 0 0.959',
  'int_01_hoverJet 1 0.959',
  'int_02_hoverJet 0 0.959',
  'int_02_hoverJet 1 0.959',
]
/** DEV-554: metres 2016's two recordings stand over the int_01 pad starts now. */
const UNDER_RECORDINGS_554: readonly string[] = ['1.25', '0.65']

describe('the hover stand-off on the start grid', () => {
  it('is deeper than the hull, or the ship is still sitting on the pad', () => {
    expect(padStandoff()).toBeGreaterThan(HULL_DEPTH)
  })

  it("DEV-554: stands every 2016 pad racer over its pad's foot as the lift stands the player", () => {
    // Matt, 2026-09-30: *"lower the racers"*. Since DEV-547 2016's two pads are
    // drawn at the lift's size, so a ship stands over a pad's foot as the
    // player's stands over the lift's dish. The racer's height comes from the
    // extracted dish (`launch.dish`, mission scene); the player's from the rig's
    // constants (`platform.offset` and `shipOffset`): two sources, one height.
    // And the census of what moved, against DEV-158's stand-off over the box.
    const moved: string[] = []
    let courses = 0
    for (const { id, level: l } of hoverJets()) {
      const pads = aiPads(l)
      if (pads.length === 0) continue
      courses++
      const platform = l.spawn.launch?.platform as unknown as {
        offset: number[]
        shipOffset: number[]
      }
      const liftHeight = (platform.shipOffset[1] as number) - (platform.offset[1] as number)
      expect(seatOverDishFoot(l), id).toBeCloseTo(liftHeight, 4)
      for (const grid of [ANNIV, CLASSIC]) {
        const starts = racerStarts(l, grid).filter((s) => s.from.kind === 'pad')
        expect(starts.length, `${id} pad count`).toBe(pads.length)
        starts.forEach((s, i) => {
          const foot = (pads[i] as { pos: number[] }).pos[1] as number
          expect((s.pos[1] as number) - foot, `${id} pad ${i}`).toBeCloseTo(liftHeight, 4)
          // Still clear of the pad's own foot by the hull and then some: the
          // belly over the DRAWN dish is `start-grid-art.test.ts`'s and
          // `race-start.spec.ts`'s, measured off the art.
          expect((s.pos[1] as number) - HULL_DEPTH - foot, `${id} pad ${i}`).toBeGreaterThan(1)
          if (grid === ANNIV) {
            const before =
              (padTop(pads[i] as unknown as Parameters<typeof padTop>[0]) as number) + padStandoff()
            moved.push(`${id} ${i} ${(before - (s.pos[1] as number)).toFixed(3)}`)
          }
        })
      }
    }
    console.info(`DEV-554: metres each 2016 pad start came down: ${moved.join(' / ')}`)
    expect(moved).toEqual(MOVED_554)
    expect(courses).toBe(5)
  })

  it("DEV-554: stands under 2016's recordings on int_01 now, by Matt's call", () => {
    // The check that is not ours: `content/ghosts/*.json` are the 2016
    // `Random_Animation` clips, extracted and hash-guarded, and they are where
    // 2016 actually stood its opposition. `worldOffset` Y is 0, so `p[1]/quant`
    // is world Y. 2016 put BOTH ships at ~127.86 — within 1.2 cm of each other
    // and 1.42 m above the player — while their pads differ by 0.589 m; so no
    // single clearance rule can reproduce both, and the question is only how
    // close one number gets. The hover engine's own ride height, fitted to
    // nothing, got within 0.31 m of each (DEV-158). DEV-554 trades that for
    // the pads' own fiction (Matt: *"lower the racers"*): each ship sits in its
    // lift-sized dish as the player sits in the lift's, 1.25 and 0.65 m under
    // the recordings. Pinned, so the next move is a decision and not a drift.
    const ghostY = (file: string): number => {
      const g = JSON.parse(fs.readFileSync(path.join('content/ghosts', file), 'utf8')) as {
        p: number[]
        quant: { pos: number }
        space: string
      }
      expect(g.space).toContain('THREE')
      expect((int01 as unknown as { worldOffset: number[] }).worldOffset[1]).toBe(0)
      return (g.p[1] as number) / g.quant.pos
    }
    const pads = racerStarts(level, ANNIV).filter((s) => s.from.kind === 'pad')
    const recorded = [
      ghostY('int_01_leftSpawn_fast_01.json'),
      ghostY('int_01_rightSpawn_slow_01.json'),
    ]
    expect(pads).toHaveLength(2)
    expect(pads.map((s, i) => ((recorded[i] as number) - (s.pos[1] as number)).toFixed(2))).toEqual(
      UNDER_RECORDINGS_554,
    )
  })

  it('pairs each pad start with the pad it stands on, not with the other one', () => {
    // A swapped pair would still clear both pads on int_01 (the tops differ by
    // 0.589 m and the stand-off is 2.19) — so clearance alone cannot catch it.
    // The XZ does: each start must be over its own pad's centre.
    const pads = aiPads(level)
    racerStarts(level, ANNIV)
      .filter((s) => s.from.kind === 'pad')
      .forEach((s, i) => {
        const pad = pads[i] as { pos: number[] }
        expect(
          Math.hypot(s.pos[0] - (pad.pos[0] as number), s.pos[2] - (pad.pos[2] as number)),
        ).toBeLessThan(0.001)
      })
  })

  it('falls back to the release altitude for a pad with no size', () => {
    // `padTop` cannot answer without a size, and a silent NaN would put a racer
    // nowhere. The fallback is what this file did for every pad before DEV-158.
    const releaseY = (level.spawn.pos[1] as number) + (level.spawn.launch?.rise ?? 0)
    const stripped = JSON.parse(JSON.stringify(level)) as Level
    // A launch with no dish (DEV-554's rule needs one), so DEV-158's runs.
    delete (stripped.spawn.launch as unknown as Record<string, unknown>).dish
    const pads = (stripped.spawn as unknown as { startGrid: { pads: Record<string, unknown>[] } })
      .startGrid.pads
    for (const p of pads) delete p.size
    for (const s of racerStarts(stripped, ANNIV).filter((s) => s.from.kind === 'pad')) {
      expect(s.pos[1]).toBeCloseTo(releaseY, 9)
    }
  })
})

// ── DEV-477: a room's people stand on the racers' own starts ─────────────
//
// Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
// spawned at the same location. 1 player per start-point (players instead of
// the ai racers)"* — the racers' own starts, of the three options he was
// offered. This REPLACES DEV-389's human row, whose test here held every person
// level against gate 0 (*"the chevron's slots ... are no place for a person"*).
// He was told, and accepted, that a room's time runs from each player's own
// release, so a person on a forward slot flies a shorter lap. So the gate-0
// distances are no longer bounded: they are WRITTEN DOWN, below, to the
// centimetre, and a grid that moves turns this red until the table (and the
// ledger row's copy of it) is re-measured.
describe('a room’s starts (DEV-477)', () => {
  const racingCourses = () =>
    hoverJets().filter(
      ({ level: l }) =>
        ((l as unknown as { forcedMode?: string }).forcedMode ?? l.mode) === 'ringAttack',
    )
  const gate0 = (l: Level): number[] =>
    (l as unknown as { routes: Record<string, { rings: { pos: number[] }[] }> }).routes['0']
      ?.rings[0]?.pos as number[]
  const toGate = (l: Level, pos: readonly number[]): number => {
    const g = gate0(l)
    return Math.hypot(
      (pos[0] as number) - (g[0] as number),
      (pos[1] as number) - (g[1] as number),
      (pos[2] as number) - (g[2] as number),
    )
  }

  it("is single player's list: the player's pad, then the racers' own, in order, on every Ring Attack course", () => {
    let checked = 0
    for (const { id, level: l } of racingCourses()) {
      const starts = roomStarts(l, ANNIV)
      const [pad, ...rest] = starts
      // Start 0 IS the player's release: the spawn's x and z, lifted by the ride.
      const releaseY = (l.spawn.pos[1] as number) + (l.spawn.launch?.rise ?? 0)
      expect(pad?.from, id).toEqual({ kind: 'player', index: 0 })
      expect(pad?.pos, id).toEqual([l.spawn.pos[0], releaseY, l.spawn.pos[2]])
      expect(pad?.quat, id).toEqual(l.spawn.quat)
      expect(rest, id).toEqual(racerStarts(l, ANNIV))
      // Six on every course: the room's seat cap is the list's length.
      expect(starts, id).toHaveLength(6)
      checked++
    }
    expect(checked, 'the six Ring Attack courses').toBe(6)
  })

  it('gives every start its own place: every pair more than 10 m apart, the pad included', () => {
    // One ship per start-point is only a promise if no two points share air.
    for (const { id, level: l } of racingCourses()) {
      const starts = roomStarts(l, ANNIV)
      for (let i = 0; i < starts.length; i++) {
        for (let j = i + 1; j < starts.length; j++) {
          const a = starts[i] as (typeof starts)[number]
          const b = starts[j] as (typeof starts)[number]
          expect(
            Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]),
            `${id}: ${a.from.kind} ${a.from.index} to ${b.from.kind} ${b.from.index}`,
          ).toBeGreaterThan(10)
        }
      }
    }
  })

  /**
   * Metres from each start to gate 0's centre, in `roomStarts` order (the pad,
   * 2016's two, the chevron's three). Measured 2026-09-27 off the level JSON
   * and Anniversary's preset (2016's two re-measured 2026-09-30 for DEV-554:
   * 0.96 m lower, and 0.09 to 0.21 m farther); straight lines, which is what the first leg is
   * within 4° on every course (the spawn-frame test above).
   */
  const GATE0_M: Readonly<Record<string, readonly number[]>> = {
    //                  pad     2016's two      the chevron (12 m, 12 m, 27.5 m ahead)
    adv_01_hoverJet: [87.12, 90.1, 91.74, 76.6, 76.05, 59.88],
    adv_02_hoverJet: [81.31, 86.92, 88.33, 71.84, 70.01, 55.04],
    int_01_hoverJet: [124.36, 128.28, 126.02, 114.36, 112.39, 97.57],
    int_02_hoverJet: [90.56, 95.16, 93.25, 80.4, 79.59, 64.11],
    rookie_01_hoverJet: [119.57, 120.62, 120.46, 108.65, 108.53, 92.71],
    rookie_02_hoverJet: [90.01, 91.65, 91.47, 79.3, 79.15, 62.92],
  }

  it('writes the unfairness down: each start’s distance to gate 0, on every course', () => {
    const table: Record<string, number[]> = {}
    for (const { id, level: l } of racingCourses()) {
      table[id] = roomStarts(l, ANNIV).map((s) => Math.round(toGate(l, s.pos) * 100) / 100)
    }
    console.log(`room starts, metres to gate 0: ${JSON.stringify(table)}`)
    for (const [id, want] of Object.entries(GATE0_M)) {
      const got = table[id] as number[]
      expect(got, id).toHaveLength(want.length)
      for (const [k, w] of want.entries()) expect(got[k], `${id} start ${k}`).toBeCloseTo(w, 1)
    }
    expect(Object.keys(table).sort()).toEqual(Object.keys(GATE0_M).sort())
  })

  it('and the shape of it: the first three start level with the pad, the chevron ahead of all three', () => {
    // What a room of N people means for the lap: three or fewer stand on the
    // pad and 2016's two, within a few metres of each other in distance to gate
    // 0; the fourth to sixth take the chevron, which stands nearer gate 0 than
    // any of the first three.
    for (const { id, level: l } of racingCourses()) {
      const d = roomStarts(l, ANNIV).map((s) => toGate(l, s.pos))
      const back = d.slice(0, 3)
      const chevron = d.slice(3)
      expect(Math.max(...back) - Math.min(...back), `${id}: the back three`).toBeLessThan(
        BACK_SPREAD_M,
      )
      expect(Math.max(...chevron), `${id}: the chevron ahead`).toBeLessThan(Math.min(...back))
    }
  })
})
