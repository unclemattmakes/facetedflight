// tests/unit/lap-validate.test.ts — the lap server's judgement, against real laps and forged ones.
// DEV-372, `docs/plan/PLAYER-GHOSTS.md` §5.
//
// Every lap here is REAL or made FROM a real one. The honest lap is the
// autopilot flying `int_01_hoverJet` with the speed chain on
// (`src/game/autopilot-lap.ts`); every forgery edits that lap's full-rate poses
// and ticks the way a cheat would, and then goes back through the real
// recorder, decimator and wire (`recordedLap`, `lapToBytes`, deflate) — so a
// forged lap is byte-for-byte the kind of thing a browser could send, and the
// only thing wrong with it is the thing the test is about. Each forgery also
// CLAIMS the time its own poses score, as a cheat would, so the claim check
// cannot be what catches it.
//
// Each gate names the stage that must refuse it. A validator that accepts
// everything fails every one of them (DEVIATIONS.md, DEV-372 §5).
//
// The 2016 laps are held to the speed and continuity checks directly: they are
// `ff2-ghost-1` clips, start on their pads and miss rings, which are other
// rules' business (§5).

import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import {
  LAP_COURSES,
  type LapCourse,
  type LapCourses,
  lapCourse,
  lapRules,
  lapVariantRules,
  lapVehicle,
} from '@/net/lap-courses'
import { LAP_COMPRESSED_MAX, LAP_INFLATED_MAX, lapKeyCap } from '@/net/lap-policy'
import {
  checkContinuity,
  checkSpeed,
  ghostCourseOf,
  type LapVerdict,
  speedCeiling,
  trackOf,
  validateCompressedLap,
  validateLap,
} from '@/net/lap-validate'
import { FIXED_DT } from '@/sim/constants'
import { decodeGhostClip, type GhostDoc, type LapDoc, type LapEvent, scoreGhost } from '@/sim/ghost'
import {
  createLapRecorder,
  type LapRecorder,
  lapToBytes,
  markLapEvent,
  recordedLap,
} from '@/sim/ghost-record'
import { hoverJetView } from '@/sim/hoverjet'
import type { SheetScale } from '@/sim/variant'
import hoverjetJson from '../../content/aircraft/hoverjet.json'
import fastDoc from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import int01 from '../../content/levels/int_01_hoverJet.json'
import { FIXTURE_VARIANT, variantCourses } from './helpers/lap-variant-courses'

const LEVEL = int01 as unknown as Level
const MISSION = 'int_01_hoverJet'
const COURSE = lapCourse(MISSION) as LapCourse
const WORLD_OFFSET = COURSE.worldOffset
const POSE = 7
/** The standard HoverJet's ceiling: what 2016's laps and the autopilot are held to. */
const STANDARD = (
  lapVariantRules(MISSION, 'anniversary', 'standard') as NonNullable<
    ReturnType<typeof lapVariantRules>
  >
).ceiling

const meta = (
  edition = 'anniversary',
  variant = 'standard',
  courses: LapCourses = LAP_COURSES,
) => ({
  mission: MISSION,
  mode: 'ringAttack',
  edition,
  rules: lapRules(MISSION, edition, variant, courses) as string,
  vehicle: lapVehicle('hoverjet', variant),
  build: 'unit-test',
})

let flown: AutopilotLap | null = null
/** Flown once, on first use, never during collection. */
const lap = (): AutopilotLap => {
  flown ??= flyAutopilotLap(LEVEL, WORLD_OFFSET)
  return flown
}

// ── Forging ───────────────────────────────────────────────────────────────

interface Key {
  /** The new lap's tick. */
  readonly tick: number
  /** Index into the honest lap's full-rate recording. */
  readonly src: number
  /** Metres added to the pose's y (THREE space; y is shared by both spaces). */
  readonly lift?: number
}

/**
 * A new full-rate recording from the honest one's poses. The recorder's
 * buffers are written directly: the poses are already in its space, and
 * `recordPose` would flip them a second time.
 */
const forge = (keys: readonly Key[], events: readonly LapEvent[]): LapRecorder => {
  const src = lap().rec
  const rec = createLapRecorder(WORLD_OFFSET, keys.length)
  keys.forEach((k, i) => {
    rec.ticks[i] = k.tick
    rec.poses.set(src.poses.subarray(k.src * POSE, k.src * POSE + POSE), i * POSE)
    rec.poses[i * POSE + 1] = (rec.poses[i * POSE + 1] as number) + (k.lift ?? 0)
  })
  rec.count = keys.length
  for (const e of [...events].sort((a, b) => a.tick - b.tick)) markLapEvent(rec, e.tick, e.kind)
  return rec
}

/** The honest lap's events, moved by the forgery's own tick map. Null drops one. */
const remap = (map: (tick: number) => number | null): LapEvent[] =>
  lap()
    .rec.events.map((e) => ({ tick: map(e.tick), kind: e.kind }))
    .filter((e): e is LapEvent => e.tick !== null)

const docOf = (rec: LapRecorder, edition = 'anniversary'): LapDoc => recordedLap(rec, meta(edition))

const deflate = (doc: LapDoc): Uint8Array => new Uint8Array(deflateRawSync(lapToBytes(doc)))

/** The time a lap's own poses score: what a cheat would claim. */
const selfClaim = (doc: LapDoc): { seconds: number } => {
  const { ghost } = ghostCourseOf(COURSE)
  const r = scoreGhost(decodeGhostClip(doc), ghost, FIXED_DT)
  return { seconds: r.seconds ?? Number.NaN }
}

const judge = async (doc: LapDoc, claim = selfClaim(doc)): Promise<LapVerdict> =>
  validateCompressedLap(deflate(doc), claim)

const honestDoc = (edition = 'anniversary'): LapDoc => docOf(lap().rec, edition)

const refusal = (v: LapVerdict): string => (v.ok ? 'accepted' : `${v.stage}: ${v.reason}`)

const ringTick = (g: number): number => lap().ringTicks.get(g) as number

/**
 * Between rings 1 and 2, the same poses flown in two thirds of the time: half
 * as fast again. Under the ALL-rings ceiling (so no jump), over the one-ring
 * one — in the standard HoverJet.
 */
const overCeilingLap = (): LapRecorder => {
  const T0 = ringTick(0) + 10
  const span = Math.min(180, ringTick(1) - ringTick(0) - 30)
  const f = 1.5
  const K = Math.floor(span / f)
  const run = lap()
  const keys: Key[] = []
  for (let t = 0; t <= T0; t++) keys.push({ tick: t, src: t })
  for (let k = 1; k <= K; k++) keys.push({ tick: T0 + k, src: T0 + Math.round(k * f) })
  const resume = T0 + Math.round(K * f)
  for (let s = resume + 1; s <= run.finishTick; s++)
    keys.push({ tick: s - resume + T0 + K, src: s })
  const events = remap((t) => (t <= T0 ? t : t > resume ? t - resume + T0 + K : null))
  return forge(keys, events)
}

// ── The honest lap ────────────────────────────────────────────────────────

describe('the autopilot lap', () => {
  it('is a real, chained, finished int_01 lap with every ring', () => {
    const run = lap()
    expect(run.finishTick).toBeGreaterThan(0)
    expect(run.rings).toBe(COURSE.gates.length)
    // Chained: faster than the UNCHAINED terminal (182.3 m/s), which §7.1's
    // flat cap would have refused.
    expect(run.topSpeed).toBeGreaterThan(speedCeiling(STANDARD, 0, 0))
  })

  it('is ACCEPTED, on the board, at the live finish time and 21 rings', async () => {
    const v = await judge(honestDoc(), { seconds: lap().finishAt })
    expect(refusal(v)).toBe('accepted')
    if (!v.ok) return
    expect(v.board).toBe(true)
    expect(v.score.seconds).toBe(lap().finishAt)
    expect(v.score.ticks).toBe(lap().finishTick)
    expect(v.score.rings).toBe(21)
    // 2016's leaderboard number: 21 x 100 plus 11.5 per second under par.
    expect(v.score.score2016).toBe(2100 + Math.round(11.5 * (180 - lap().finishAt)))
  })

  it("is accepted on Classic too, under Classic's own rules string", async () => {
    const v = await judge(honestDoc('classic'), { seconds: lap().finishAt })
    expect(refusal(v)).toBe('accepted')
  })
})

// ── Forged laps, each refused at its own stage ────────────────────────────

describe('a forged lap is refused', () => {
  it('a TELEPORT FORWARD, marked as a reset', async () => {
    // Half a leg skipped between rings 5 and 6: no ring is missed, so only the
    // direction of the jump is wrong.
    const T = ringTick(4) + 20
    const skip = Math.floor((ringTick(5) - ringTick(4)) / 2)
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
    for (let s = T + skip; s <= run.finishTick; s++) keys.push({ tick: s - skip + 1, src: s })
    const events = [
      ...remap((t) => (t <= T ? t : t >= T + skip ? t - skip + 1 : null)),
      { tick: T + 1, kind: 'reset' as const },
    ]
    const v = await judge(docOf(forge(keys, events)))
    expect(refusal(v)).toMatch(/^continuity: the reset at tick \d+ lands \d/)
  })

  it('...while the same jump BACKWARDS, marked, is a legal crash reset', async () => {
    // The control for the two above and below: rewind to ring 6's own pose.
    // Accepted, so what refuses the others is the direction and the mark.
    const back = ringTick(5)
    const T = back + 60
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
    const shift = T + 1 - back
    for (let s = back; s <= run.finishTick; s++) keys.push({ tick: s + shift, src: s })
    const events = [
      ...remap((t) => (t <= T ? t : t + shift)),
      { tick: T + 1, kind: 'reset' as const },
    ]
    const v = await judge(docOf(forge(keys, events)))
    expect(refusal(v)).toBe('accepted')
    if (v.ok) expect(v.score.ticks).toBe(run.finishTick + shift)
  })

  it('a JUMP at a tick not marked as a reset', async () => {
    // The legal rewind above, without its mark.
    const back = ringTick(5)
    const T = back + 60
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
    const shift = T + 1 - back
    for (let s = back; s <= run.finishTick; s++) keys.push({ tick: s + shift, src: s })
    const v = await judge(
      docOf(
        forge(
          keys,
          remap((t) => (t <= T ? t : t + shift)),
        ),
      ),
    )
    expect(refusal(v)).toMatch(
      /^continuity: a jump of \d+\.\d m in 12\.2 ms at tick \d+, which is not marked/,
    )
  })

  it('a stretch OVER THE CHAIN CEILING, with one ring banked', async () => {
    const v = await judge(docOf(overCeilingLap()))
    expect(refusal(v)).toMatch(/^speed: \d+\.\d m\/s over .* with 1 ring\(s\) banked/)
  })

  it('a CLAIMED TIME its poses do not support', async () => {
    const v = await judge(honestDoc(), { seconds: lap().finishAt - 0.5 })
    expect(refusal(v)).toMatch(/^claimed: the lap claims/)
    // And one tick either way is rounding, not a lie.
    expect(refusal(await judge(honestDoc(), { seconds: lap().finishAt + FIXED_DT }))).toBe(
      'accepted',
    )
  })

  it('a MISSING RING keeps it off the board (call 3), though it may still be shared', async () => {
    // Ring 9 flown 60 m over, the path eased up and back down so nothing else
    // about the lap changes: no jump, no speed, every other ring.
    const tr = ringTick(8)
    const H = Math.floor(0.8 * Math.min(tr - ringTick(7), ringTick(9) - tr))
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= run.finishTick; t++) {
      const u = (t - tr) / H
      const lift = Math.abs(u) < 1 ? 60 * 0.5 * (1 + Math.cos(Math.PI * u)) : 0
      keys.push({ tick: t, src: t, lift })
    }
    const v = await judge(
      docOf(
        forge(
          keys,
          remap((t) => t),
        ),
      ),
    )
    expect(refusal(v)).toBe('accepted')
    if (!v.ok) return
    expect(v.score.rings).toBe(20)
    expect(v.board).toBe(false)
    expect(v.boardReason).toMatch(/^20 of 21 rings/)
  })

  it('an OVERSIZE body', async () => {
    const big = new Uint8Array(LAP_COMPRESSED_MAX + 1)
    const v = await validateCompressedLap(big, { seconds: 1 })
    expect(refusal(v)).toMatch(/^size: 65537 deflated bytes/)
  })

  it('a ZIP BOMB, stopped at the inflate cap rather than after it', async () => {
    // Four times the cap of zeros deflates to about 2 KB.
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(LAP_INFLATED_MAX * 4)))
    expect(bomb.byteLength).toBeLessThan(4096)
    const v = await validateCompressedLap(bomb, { seconds: 1 })
    expect(refusal(v)).toBe(`size: the lap inflates past ${LAP_INFLATED_MAX} bytes`)
  })

  it('bytes that are not deflate, or deflate that is not a lap', async () => {
    expect(refusal(await validateCompressedLap(new Uint8Array([1, 2, 3, 4, 5]), null))).toMatch(
      /^decode:/,
    )
    const notALap = new Uint8Array(deflateRawSync(Buffer.from('FFG1 hello')))
    expect(refusal(await validateCompressedLap(notALap, null))).toMatch(/^decode: .*bad magic/)
  })

  it('a lap that does not leave from the release point', async () => {
    // The whole lap 10 m higher: every ring still taken, no jump, no speed.
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= run.finishTick; t++) keys.push({ tick: t, src: t, lift: 10 })
    const v = await judge(
      docOf(
        forge(
          keys,
          remap((t) => t),
        ),
      ),
    )
    expect(refusal(v)).toMatch(/^start: the first pose is 10\.0 m from the release point and \d/)
    // Tick 0 is the release: a lap that starts later is refused before its pose is.
    const late = honestDoc()
    const shifted = { ...late, tick: late.tick.map((t) => t + 5) }
    const v2 = await judge(shifted)
    expect(refusal(v2)).toMatch(/^start: the lap starts at tick 5/)
  })

  it('a lap on another course, mode or rules version', () => {
    const raw = (over: Partial<LapDoc>): Uint8Array => lapToBytes({ ...honestDoc(), ...over })
    expect(refusal(validateLap(raw({ mission: 'int_99' }), null))).toMatch(/^course: no board/)
    expect(refusal(validateLap(raw({ mode: 'freeFlight' }), null))).toMatch(/^course: mode/)
    expect(refusal(validateLap(raw({ edition: 'deluxe' }), null))).toMatch(/^course: no edition/)
    expect(refusal(validateLap(raw({ rules: '0.00000000' }), null))).toMatch(/^rules: /)
    expect(refusal(validateLap(raw({ vehicle: lapVehicle('jumpseat', 'standard') }), null))).toBe(
      'course: int_01_hoverJet is flown in the hoverjet, not the jumpseat',
    )
  })
})

// ── Aircraft variants: a board each, the variant CHECKED ──────────────────

describe('a lap names its aircraft variant, and the server checks it', () => {
  const raw = (over: Partial<LapDoc>, edition = 'anniversary'): Uint8Array =>
    lapToBytes({ ...honestDoc(edition), ...over })

  it('refuses a lap that names no variant, and an id the aircraft does not have', () => {
    expect(refusal(validateLap(raw({ vehicle: 'hoverjet' }), null))).toBe(
      'course: vehicle "hoverjet" is not <vehicle>:<variant> (lapVehicle)',
    )
    // The list it names is the aircraft file's, in its order.
    const flies = (hoverjetJson as unknown as { variants: { id: string }[] }).variants
      .map((v) => v.id)
      .join(', ')
    expect(refusal(validateLap(raw({ vehicle: lapVehicle('hoverjet', 'warp') }), null))).toBe(
      `course: the hoverjet has no "warp" variant on anniversary; it flies ${flies}`,
    )
  })

  it("files the aircraft file's own variants: each shipped HoverJet variant has a board on Anniversary", () => {
    for (const { id } of (hoverjetJson as unknown as { variants: { id: string }[] }).variants) {
      expect(lapVariantRules(MISSION, 'anniversary', id)).not.toBeNull()
    }
  })

  it('accepts a REAL lap flown in the fastest shipped variant on its own board, and refuses it on standard’s', async () => {
    // The shipped variant with the highest terminal speed, flown by the
    // autopilot through `createHoverJet(hoverJetView(scale))` — the construction
    // seam the game builds a variant's flight at. A real lap, not a fixture.
    const variants = (hoverjetJson as unknown as { variants: { id: string; scale: SheetScale }[] })
      .variants
    const terminal = (id: string): number => {
      const c = lapVariantRules(MISSION, 'anniversary', id)?.ceiling
      return c ? speedCeiling(c, 0, 0) : 0
    }
    const fastest = [...variants].sort((a, b) => terminal(b.id) - terminal(a.id))[0]
    if (!fastest || fastest.id === 'standard') return // no faster variant ships; nothing to show
    const run = flyAutopilotLap(LEVEL, WORLD_OFFSET, hoverJetView(fastest.scale))
    expect(run.rings).toBe(COURSE.gates.length)
    const doc = recordedLap(run.rec, meta('anniversary', fastest.id))
    const v = await judge(doc, { seconds: run.finishAt })
    expect(refusal(v)).toBe('accepted')
    if (v.ok) expect([v.variant, v.board]).toEqual([fastest.id, true])
    // The cheat the variant check cannot see: the same lap RELABELLED as the
    // standard jet, under standard's rules. Refused by standard's own ceiling —
    // measured 2026-09-25 on DEV-381's speed jet: 201.8 m/s over 0.27 s at
    // 1.34 s with one ring banked, against 199.3. A property of that variant's
    // tuning, not of the code: if a retune ever lets a relabelled lap through,
    // this goes red to say the standard board can no longer tell them apart.
    const asStandard = { ...doc, vehicle: lapVehicle('hoverjet', 'standard'), rules: meta().rules }
    const relabelled = await judge(asStandard, { seconds: run.finishAt })
    expect(refusal(relabelled)).toMatch(/^(speed|continuity): /)
  })

  it('judges a variant lap by ITS ceiling, and on ITS rules', async () => {
    const courses = variantCourses()
    const standard = lapVariantRules(MISSION, 'anniversary', 'standard', courses)
    const fixture = lapVariantRules(MISSION, 'anniversary', FIXTURE_VARIANT, courses)
    if (!standard || !fixture) throw new Error('missing a variant board')
    // The over-the-ceiling forgery below, half as fast again with one ring
    // banked: refused in the standard HoverJet, inside the fixture's
    // x1.5 maxSpeed, which is the whole reason a variant needs its own board.
    const fast = docOf(overCeilingLap())
    const asVariant = (variant: string): LapDoc => ({
      ...fast,
      vehicle: lapVehicle('hoverjet', variant),
      rules: lapRules(MISSION, 'anniversary', variant, courses) as string,
    })
    const judged = (doc: LapDoc) => validateLap(lapToBytes(doc), selfClaim(doc), courses)
    expect(refusal(judged(asVariant('standard')))).toMatch(/^speed: /)
    const v = judged(asVariant(FIXTURE_VARIANT))
    expect(refusal(v)).toBe('accepted')
    if (v.ok) expect(v.variant).toBe(FIXTURE_VARIANT)
    // Each variant's rules string is its own: the standard's does not file a
    // fixture lap, and the other way round.
    expect(refusal(judged({ ...asVariant(FIXTURE_VARIANT), rules: standard.rules }))).toMatch(
      /^rules: /,
    )
  })

  it('refuses any variant but standard on Classic, which flies 2016 only', () => {
    const courses = variantCourses()
    const classic = { ...honestDoc('classic'), vehicle: lapVehicle('hoverjet', FIXTURE_VARIANT) }
    expect(refusal(validateLap(lapToBytes(classic), null, courses))).toBe(
      `course: the hoverjet has no "${FIXTURE_VARIANT}" variant on classic; it flies standard`,
    )
  })
})

describe('resets in an edition without crashes', () => {
  it('refuses a crash-style reset on Classic, where only the respawn marker is legal', async () => {
    const back = ringTick(5)
    const T = back + 60
    const run = lap()
    const keys: Key[] = []
    for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
    const shift = T + 1 - back
    for (let s = back; s <= run.finishTick; s++) keys.push({ tick: s + shift, src: s })
    const events = [
      ...remap((t) => (t <= T ? t : t + shift)),
      { tick: T + 1, kind: 'reset' as const },
    ]
    const v = await judge(docOf(forge(keys, events), 'classic'))
    expect(refusal(v)).toMatch(/^continuity: .*this edition has no crash reset/)
  })
})

// ── 2016's own laps ───────────────────────────────────────────────────────

describe("2016's laps pass the speed and continuity checks", () => {
  /** A 2016 clip's track and its ring times, in CLIP seconds. */
  const clip2016 = (doc: unknown) => {
    const clip = decodeGhostClip(doc as GhostDoc)
    const { gates, ghost } = ghostCourseOf(COURSE)
    // The shipped `GhostRacer` stagger, as `ghost-result.test.ts` scores them.
    const startTime = 0.55
    const r = scoreGhost(clip, { ...ghost, startTime }, FIXED_DT, { ringTimes: true })
    const rings = (r.ringTimes ?? []).map((t) =>
      t === null ? null : t + clip.launchAt - startTime,
    )
    return { track: trackOf(clip, WORLD_OFFSET), gates, rings, result: r }
  }

  for (const [name, doc] of [
    ['int_01_leftSpawn_fast_01', fastDoc],
    ['int_01_rightSpawn_slow_01', slowDoc],
  ] as const) {
    it(`${name}: continuous, and inside the chain-aware ceiling`, () => {
      const { track, gates, rings } = clip2016(doc)
      expect(
        checkContinuity(track, COURSE, STANDARD, COURSE.editions.anniversary ?? null, gates, rings),
      ).toBeNull()
      expect(checkSpeed(track, STANDARD, rings).reason).toBeNull()
    })
  }

  it("fast_01 reaches 0.9935 of the ceiling with NO margin, and §7.1's flat 182 m/s refuses it", () => {
    const { track, rings, result } = clip2016(fastDoc)
    // Pinned: the margin in `lap-policy.ts` is argued from this number.
    expect(checkSpeed(track, STANDARD, rings, 0).worstRatio).toBeCloseTo(0.9935, 4)
    // The same lap under a ceiling that never banks a ring — terminal(437.5),
    // 182.3 m/s, PORT_PLAN §7.1's cap — is refused by its own mean speed.
    expect(result.meanSpeed).toBeGreaterThan(speedCeiling(STANDARD, 0, 0))
    const flat = checkSpeed(
      track,
      STANDARD,
      rings.map(() => null),
    )
    expect(flat.reason).toMatch(/with 0 ring\(s\) banked/)
  })
})

describe('the courses the validator reads, and the caps', () => {
  it('holds every course a key cap, and every board a ceiling the chain raises', () => {
    for (const c of Object.values(LAP_COURSES.courses)) {
      expect(c.timeLimit).toBeGreaterThan(0)
      for (const edition of Object.values(c.editions)) {
        for (const { ceiling } of Object.values(edition.variants)) {
          expect(speedCeiling(ceiling, c.gates.length)).toBeGreaterThan(speedCeiling(ceiling, 0))
        }
      }
    }
  })

  it('sizes the inflate cap for the longest lap any course allows, at 32 bytes a key', () => {
    // `lap-policy.ts` argues 32 B a key is a ceiling nothing honest reaches.
    // The honest lap is well under it, and the cap covers the longest course.
    const doc = honestDoc()
    expect(lapToBytes(doc).byteLength / doc.keyCount).toBeLessThan(23)
    const longest = Math.max(...Object.values(LAP_COURSES.courses).map((c) => c.timeLimit))
    expect(LAP_INFLATED_MAX).toBeGreaterThanOrEqual(32 * lapKeyCap(longest) + 32 * 1024)
    // And the deflate cap leaves a real lap three times its size.
    expect(deflate(doc).byteLength * 3).toBeLessThan(LAP_COMPRESSED_MAX)
  })
})
