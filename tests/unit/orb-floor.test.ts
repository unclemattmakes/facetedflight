// tests/unit/orb-floor.test.ts — DEV-067, and the number it is built on.
//
// 2016 built `hoverJet_kauai_beg` by copying `int_01_hoverJet` onto a second
// island. The eleven-orb `freeFlight_objects` scatter came across BYTE-IDENTICAL
// — every `_meta.raw.pos` matches — but simonet is mostly open water and kauai is
// one mountain, so five of the eleven finish inside the island, by up to 619 m.
// DEV-062 confirmed that against 2016's own bake with UnityPy and confirmed the
// island itself is placed correctly. The mission is `forceGameMode` Free Flight,
// which is the one mode that SCORES orbs, and `sim/terrain-collision.ts` pushes
// the hull back out of the ground — so five of the eleven things the HUD counts
// cannot be reached. Matt, 2026-09-13: *"fix kauai's buried orbs."*
//
// The fix is `posFf2` in the level JSON, beside an untouched `pos` — the same
// deal `medalsFf2` makes with `medals`. This file is why it is allowed to be a
// baked number: it RE-DERIVES the floor and every ground height against the real
// height field, and fails if the table in `tools/extract/level.mjs` has drifted.
//
// ── Two halves, and only one of them can run on CI ────────────────────────
//
// The structural half reads the JSON and needs nothing else, so it runs
// everywhere. The derivation half needs the height maps, which are gitignored
// and hydrated from R2, so it skips when they are absent — the same deal
// `route-clearance.test.ts` makes. It does NOT hide behind an env var: drift in
// this table is a real bug and a local `pnpm test` should catch it.
//
// ── Assert the relationship, not the value (trap 24) ──────────────────────
//
// Nothing below restates 35.346729. The floor is recomputed from the six orbs
// 2016 left above kauai's ground and the emitted table is checked against THAT,
// so a test that agrees with the code for the wrong reason is not available.

import { describe, expect, it } from 'vitest'
import { isLive, runningMode, scores } from '@/game/modes'
import { liveOrbs, ORB_COLLECT_RADIUS, orbPos } from '@/game/orbs'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  clearance,
  fieldFor,
  groundUnder,
  haveMaps,
  loadLevelJson,
  MISSIONS,
} from './helpers/terrain-field'

const KAUAI = 'hoverJet_kauai_beg'

// biome-ignore lint/suspicious/noExplicitAny: the level JSON is the truth and the types lag it
type OrbRow = any

const corrected = (level: OrbRow): OrbRow[] => level.orbs.filter((o: OrbRow) => o.posFf2)

describe('DEV-067: the orb correction is confined to one mission', () => {
  it('touches exactly five orbs, in exactly one of the thirteen missions', () => {
    const hits = MISSIONS.map((id) => [id, corrected(loadLevelJson(id)).length] as const).filter(
      ([, n]) => n > 0,
    )
    expect(hits).toEqual([[KAUAI, 5]])
  })

  it('leaves every other mission byte-identical in `pos`', () => {
    // The blast-radius check as a statement about 2016's own numbers: `pos` is
    // the z-flip of `_meta.raw.pos` and nothing else, in every mission including
    // the corrected one. A correction written into `pos` would fail here, which
    // is the whole reason it is not written into `pos`.
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      for (const orb of level.orbs as OrbRow[]) {
        const raw = orb._meta.raw.pos
        expect(orb.pos, `${id} orb ${orb.i}`).toEqual([raw[0], raw[1], -raw[2]])
      }
    }
  })

  it('only ever raises an orb, and never moves it sideways', () => {
    // Geometry, not belief: x and z are 2016's to the last bit, and the only
    // component that changed went UP. A sign error or a swapped axis dies here.
    for (const orb of corrected(loadLevelJson(KAUAI))) {
      expect(orb.posFf2[0], `orb ${orb.i} x`).toBe(orb.pos[0])
      expect(orb.posFf2[2], `orb ${orb.i} z`).toBe(orb.pos[2])
      expect(orb.posFf2[1] - orb.pos[1], `orb ${orb.i} lift`).toBeGreaterThan(0)
      expect(orb._meta.ff2.deviation).toBe('DEV-067')
      expect(orb._meta.ff2.liftM).toBeCloseTo(orb.posFf2[1] - orb.pos[1], 5)
    }
  })

  it('corrects only orbs a running mode can actually collect', () => {
    // The scoping decision, written down. `int_01_hoverJet` carries the SAME
    // eleven orbs and two of them are buried too (-144.2 and -115.0) — and they
    // are left exactly as 2016 authored them, because Ring Attack neither draws
    // nor collects orbs, so they are 2016 data at rest rather than broken
    // content. If `MODES.ringAttack` ever gains `orb`, this fails and the
    // question reopens, which is the point.
    expect(isLive(runningMode(loadLevelJson('int_01_hoverJet')), 'orb')).toBe(false)
    expect(corrected(loadLevelJson('int_01_hoverJet'))).toHaveLength(0)

    const kauai = loadLevelJson(KAUAI)
    expect(isLive(runningMode(kauai), 'orb')).toBe(true)
    expect(scores(runningMode(kauai), 'orb')).toBe(true)
    for (const orb of corrected(kauai)) expect(orb.live, `orb ${orb.i} live`).toBe(true)
  })

  it('changes nothing about how many orbs there are', () => {
    // Medals and the HUD count OBJECTS in Free Flight. Moving one must not
    // become adding or dropping one.
    const kauai = loadLevelJson(KAUAI)
    expect(kauai.orbs).toHaveLength(11)
    expect(liveOrbs(kauai)).toHaveLength(11)
  })

  it('is what `orbPos` hands to the sim and to the art', () => {
    // The single door. `orbSpheres` and `orb-art.ts` both read through this, so
    // the collection volume and the ball you fly at cannot disagree.
    const kauai = loadLevelJson(KAUAI)
    for (const orb of kauai.orbs as OrbRow[]) {
      expect(orbPos(orb)).toEqual(orb.posFf2 ?? orb.pos)
    }
    expect(kauai.orbs.filter((o: OrbRow) => orbPos(o) !== o.pos)).toHaveLength(5)
  })
})

describe.skipIf(!haveMaps)('DEV-067: the number, re-derived against the real ground', () => {
  const kauai = loadLevelJson(KAUAI)
  /**
   * LAZY, and that is the whole point of this line.
   *
   * `describe.skipIf` skips the TESTS; it does not stop vitest evaluating the
   * describe callback, so a `fieldFor(kauai)` here runs during collection and
   * throws `ENOENT` on a machine with no assets — which is CI, and only CI.
   * That is `turn-indicator.test.ts`'s bug from earlier today wearing a guard:
   * the guard was correct and the work was above it.
   */
  const field = (): HeightField => fieldFor(kauai)

  /**
   * The floor, recomputed from scratch: the smallest clearance, over this
   * mission's own live orbs, between an orb centre and the height field directly
   * beneath it, counting only the ones ABOVE it.
   *
   * That is what the number is the measure OF, and saying so is the DEV-027
   * discipline. It is not a median — these orbs span 3 km of altitude and the
   * median of the six is 917 m, which is not a float height, it is the middle of
   * a scatter.
   */
  const derivedFloor = (level: OrbRow): number =>
    Math.min(
      ...liveOrbs(level)
        .map((o: OrbRow) => clearance(fieldFor(level), o.pos))
        .filter((c: number) => c >= 0),
    )

  it('the emitted floor IS the least clearance 2016 leaves on this island', () => {
    const floor = derivedFloor(kauai)
    for (const orb of corrected(kauai)) {
      expect(orb._meta.ff2.floorM, `orb ${orb.i} floorM`).toBeCloseTo(floor, 4)
    }
    // Sanity on the shape of the answer: a floor of a few tens of metres, not a
    // few hundred. If this ever trips, the scatter or the island has moved.
    expect(floor).toBeGreaterThan(10)
    expect(floor).toBeLessThan(100)
  })

  it('the emitted ground heights are the height field, to a centimetre', () => {
    // The half of the table this file exists to guard: `tools/extract/level.mjs`
    // cannot sample the terrain, so it carries these, and they go stale silently
    // if the generator ever moves. Here they do not.
    for (const orb of corrected(kauai)) {
      expect(orb._meta.ff2.groundM, `orb ${orb.i} groundM`).toBeCloseTo(
        groundUnder(field(), orb.pos),
        2,
      )
    }
  })

  it('every live orb now clears the ground, and the worst one sits exactly at the floor', () => {
    const floor = derivedFloor(kauai)
    const after = liveOrbs(kauai).map((o: OrbRow) => clearance(field(), orbPos(o)))
    expect(Math.min(...after)).toBeGreaterThan(0)
    // Not merely "above ground": the rescued orbs land ON the floor, so the
    // tightest orb in the mission is still the one 2016 itself placed tightest.
    expect(Math.min(...after)).toBeCloseTo(floor, 4)
    expect(after.filter((c: number) => c < 0)).toHaveLength(0)
  })

  it('the clamp moves the buried orbs and PROVABLY nothing else', () => {
    // The minimality theorem, checked rather than asserted. Because the floor IS
    // the minimum of the above-ground clearances, every orb 2016 placed above the
    // ground already clears by at least the floor, so `max(y, ground + floor)` is
    // a no-op on it. Run the clamp over all thirteen missions' live orbs and the
    // set it would move must be exactly the set that carries a `posFf2` — in the
    // missions whose mode collects orbs, and empty everywhere else.
    const moved: string[] = []
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)
      if (!isLive(runningMode(level), 'orb')) continue
      const f = fieldFor(level)
      const live = liveOrbs(level)
      const above = live.map((o: OrbRow) => clearance(f, o.pos)).filter((c: number) => c >= 0)
      if (!above.length) continue
      const floor = Math.min(...above)
      for (const orb of live) {
        const target = groundUnder(f, orb.pos) + floor
        if (target > orb.pos[1] + 1e-6) moved.push(`${id}#${orb.i}`)
      }
    }
    expect(moved.sort()).toEqual(
      corrected(kauai)
        .map((o: OrbRow) => `${KAUAI}#${o.i}`)
        .sort(),
    )
  })

  it('no other mission has a live orb under its own ground in a mode that collects orbs', () => {
    // Said the other way round, so a new mission cannot inherit the deviation in
    // silence: if this ever fails, someone has shipped a second buried course and
    // DEV-067 needs a second row rather than a wider rule.
    for (const id of MISSIONS) {
      if (id === KAUAI) continue
      const level = loadLevelJson(id)
      if (!isLive(runningMode(level), 'orb')) continue
      for (const orb of liveOrbs(level)) {
        expect(clearance(fieldFor(level), orbPos(orb)), `${id} orb ${orb.i}`).toBeGreaterThan(0)
      }
    }
  })

  it('the floor is not a one-island accident', () => {
    // Corroboration, and stated as corroboration rather than as proof — the
    // agreement lesson is that a rule checked only where two readings agree has
    // not been checked. The SAME eleven orbs over simonet (`int_01_hoverJet`)
    // have their own tightest above-ground member, and it lands in the same band.
    // If these two ever diverge by an order of magnitude, "how close may an orb
    // come to the ground" was never a property of the scatter at all.
    const simonet = derivedFloor(loadLevelJson('int_01_hoverJet'))
    const kauaiFloor = derivedFloor(kauai)
    expect(simonet).toBeGreaterThan(kauaiFloor * 0.5)
    expect(simonet).toBeLessThan(kauaiFloor * 2)
  })

  it('the rescued orbs are still far enough apart to be collected one at a time', () => {
    // Five orbs all land at ground + floor, so this is the one new way they could
    // collide: two of them close enough that one collection volume swallows the
    // other. `pad-art.test.ts` asserts the same separation on the drawn shells;
    // this asserts it on the positions the sim collects at.
    const p: number[][] = liveOrbs(kauai).map((o: OrbRow) => orbPos(o) as unknown as number[])
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const a = p[i] as number[]
        const b = p[j] as number[]
        const d = Math.hypot(
          (a[0] as number) - (b[0] as number),
          (a[1] as number) - (b[1] as number),
          (a[2] as number) - (b[2] as number),
        )
        expect(d, `orbs ${i} and ${j}`).toBeGreaterThan(2 * ORB_COLLECT_RADIUS)
      }
    }
  })
})

// ── The loud counterpart ──────────────────────────────────────────────────
//
// Seven of the thirteen cases above are gated on the terrain maps, which are
// gitignored and absent on CI. A guarded suite that says nothing when it skips
// is a suite that can rot for months while every run stays green — so this says
// it, and the message is the whole point.
describe.skipIf(haveMaps)('DEV-067 — terrain maps not present', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    // Fine on CI. NOT fine locally: run `pnpm assets:pull`, because the numbers
    // this row rests on are only checked when the real height field is here.
    expect(haveMaps).toBe(false)
  })
})
