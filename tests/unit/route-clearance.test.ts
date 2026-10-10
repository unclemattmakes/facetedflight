// tests/unit/route-clearance.test.ts — is the course above the ground?
//
// A TOOL *and* a small gate: the printing half reads the height maps out of
// `public/assets`, which is gitignored and hydrated from R2 (`pnpm assets:pull`),
// so CI has nothing to run it against and it skips itself when the maps are
// absent.
//
//   ROUTE_CLEARANCE=1 pnpm exec vitest run tests/unit/route-clearance.test.ts --reporter=verbose
//
// ── What it was built to answer, and the answer ───────────────────────────
//
// `hoverJet_kauai_beg` flies **218 of its 421 route points underground**, the
// worst by 856.3 m, where no other mission is worse than -33.5 m. That read as
// a misplaced island — kauai is the one environment with a non-zero `envRoot`
// (-2218, 0, -1691), and two candidate origins cleared the course completely
// and agreed on the spawn to the metre, which is the agreement lesson in its
// purest form.
//
// **The island is not misplaced. The course is dead content.** Settled from the
// Unity data, three ways, none of them this instrument:
//
//  1. **The parent chain.** `LevelArt_Kauai.unity` is
//     `levelOffset(-2048,0,-2048) < LevelArt_Kauai(-2218,0,-1691) <
//     terrain_kauai(0,68,0)`, every node unrotated and unit-scaled, composing to
//     world (-4266, 68, -3739) — which is what the sheet emits.
//     `LoadLevelArt.cs` is a plain `LoadSceneAsync(Additive)`, so the
//     environment scene's own world position IS the in-game one.
//  2. **2016's OWN BAKE.** `terrain_kauai_FacetedChunks.asset`, read with
//     UnityPy, sampled at the nearest baked LOD0 vertex under each point:
//     route worst **-856.1** (219/421 below), orbs -619.6 (5/11), finish
//     -710.8. Our generator says -856.3, -619.0, -712.4. 2016's own kauai has
//     this course inside the mountain. Run against simonet as a control the
//     same oracle gives route worst +29.2, 0 below, against our +32.7.
//  3. **The anchor 2016 actually MOVED.** Rings, orbs, route, finish and turn
//     indicators are byte-identical to `int_01_hoverJet`'s; the launch
//     elevator is NOT. Its pads, spawn and respawn were re-placed for kauai,
//     and at the shipped origin they sit +12.1 m and +16.7 m over kauai's
//     ground — in family with alpine (+9.2/+12.5) and desert (+11.7/+14.2).
//     Under either "fix" they would float ~240 m up. The sweep never asked the
//     one anchor whose position is evidence.
//
// `hoverJet_kauai_beg` is `forceGameMode` Free Flight, so `Level.cs` disables
// `ringAttackParent` — the rings, the racing line and the finish gate are all
// switched off in 2016 and were never re-authored for the new island. So the
// route print below is a fact about 2016's authoring, not about this port, and
// nothing here asserts on it.
//
// What IS live is the orbs, and **5 of the 11 were inside the mountain in 2016
// too**. Matt took that call on 2026-09-13 (*"fix kauai's buried orbs"*) and it
// is **DEV-067**: the extractor emits a `posFf2` beside the untouched `pos` and
// the game flies at that. The derivation, the drift guard and the proof that it
// touches no other mission are `tests/unit/orb-floor.test.ts`; this file keeps
// only the end-to-end statement that the mission's orbs are now reachable.
//
// ── So what this file guards ──────────────────────────────────────────────
//
// The route print stays, because it is two seconds and it is how the question
// got asked. The assertion moved to the thing that is actually evidence: every
// mission's LAUNCH SITE and RESPAWN point clear their own terrain. That is the
// per-environment anchor — 2016 placed it by hand against the ground it sits
// on — so an environment origin that drifts by kilometres puts it underground
// or in the sky, and this fails. A course being underground does not mean the
// island moved; a launch pad being underground does.
//
// The SPAWN is deliberately not asserted: it is the bottom of the elevator
// shaft and is ~95 m under the surface in five of the thirteen missions by
// design (kauai -92.7, alpine -95.4, desert -93.2, rookie_01 -98.8).
//
// All of that is behind `ROUTE_CLEARANCE=1` and stays there. What is NOT is the
// section at the foot of the file: a body nobody runs is a body nobody
// typechecks either, because the level JSON arrives as `any`. It makes the same
// calls without the maps, so a rename lands red on an ordinary `pnpm check`.

import { describe, expect, it } from 'vitest'
import { liveOrbs, orbPos } from '@/game/orbs'
import type { HeightField } from '@/sim/terrain/height-field'
// The placement rule (`worldOffset + local + envRoot`) and the four map paths are
// SHARED with `orb-floor.test.ts` rather than written out twice — that sum has
// been wrong twice already (DEV-042, DEV-047) and two copies is how the two specs
// would start disagreeing about where kauai is.
import {
  clearance,
  fieldFor,
  haveMaps,
  loadLevelJson,
  MAPS,
  MISSIONS,
} from './helpers/terrain-field'

/** The ones with a route to print. Target Practice missions have none. */
const ROUTED = new Set([
  'int_01_hoverJet',
  'hoverJet_kauai_beg',
  'rookie_01_hoverJet',
  'rookie_02_hoverJet',
  'int_02_hoverJet',
  'adv_01_hoverJet',
  'adv_02_hoverJet',
  'rookie_02_jumpSeat',
])

const load = loadLevelJson

const worstOf = (field: HeightField, pts: readonly (readonly number[])[]) => {
  let worst = Number.POSITIVE_INFINITY
  let worstAt = -1
  let below = 0
  for (let i = 0; i < pts.length; i++) {
    const c = clearance(field, pts[i] as number[])
    if (c < worst) {
      worst = c
      worstAt = i
    }
    if (c < 0) below++
  }
  return { worst, worstAt, below, of: pts.length }
}

describe.skipIf(process.env.ROUTE_CLEARANCE !== '1' || !haveMaps)('route clearance', () => {
  it('prints every mission route against its own terrain', () => {
    for (const id of MISSIONS) {
      if (!ROUTED.has(id)) continue
      const level = load(id)
      const r = worstOf(fieldFor(level), level.route ?? [])
      console.log(
        `${id.padEnd(20)} ${level.environment.padEnd(9)} worst=${r.worst.toFixed(1).padStart(9)} m at i=${String(r.worstAt).padStart(3)}  below=${r.below}/${r.of}`,
      )
    }
    expect(true).toBe(true)
  })

  it('every launch site and respawn point is above its own ground', () => {
    // The guard. See the header: this is the anchor 2016 re-placed per
    // environment, so it is the one that moves when an origin is wrong.
    for (const id of MISSIONS) {
      const level = load(id)
      const field = fieldFor(level)
      const pads = level.spawn.startGrid?.pads ?? []
      for (const pad of pads) {
        const c = clearance(field, pad.pos)
        console.log(`${id.padEnd(20)} pad(${pad.role.padEnd(6)}) ${c.toFixed(1).padStart(8)} m`)
        expect(c, `${id}: ${pad.role} launch pad clearance`).toBeGreaterThan(0)
      }
      const r = clearance(field, level.respawn.pos)
      console.log(`${id.padEnd(20)} respawn       ${r.toFixed(1).padStart(8)} m`)
      expect(r, `${id}: respawn clearance`).toBeGreaterThan(0)
    }
  })

  it("kauai's launch site sits on kauai, in family with the other environments", () => {
    // The number that settles DEV-059. At the shipped origin the pads and the
    // respawn point are a normal dozen metres over the ground. Negating
    // `envRoot` — the candidate that cleared the dead racing line — puts them
    // ~240 m in the air, because it moves the island out from under them.
    const level = load('hoverJet_kauai_beg')
    const field = fieldFor(level)
    for (const pad of level.spawn.startGrid?.pads ?? []) {
      const c = clearance(field, pad.pos)
      expect(c, `kauai ${pad.role} pad`).toBeGreaterThan(0)
      expect(c, `kauai ${pad.role} pad`).toBeLessThan(60)
    }
    const r = clearance(field, level.respawn.pos)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(60)
  })

  it("kauai's DEAD course is still underground and its LIVE orbs no longer are", () => {
    // The two halves of DEV-062 and DEV-067 in one line, and the asymmetry is the
    // point. The Ring Attack content is switched off by `forceGameMode`, so its
    // clearance is 2016's authoring and stays exactly as 2016 left it — if this
    // ever comes out positive, somebody has "fixed" content nothing can score.
    // The ORBS are what Free Flight collects, and after DEV-067 every one of them
    // is above the ground the ship is allowed to occupy.
    const level = load('hoverJet_kauai_beg')
    const field = fieldFor(level)
    const route = worstOf(field, level.route ?? [])
    const orb = worstOf(field, liveOrbs(level).map(orbPos))
    console.log(
      `kauai  mode=${level.mode}  DEAD route worst=${route.worst.toFixed(1)} below=${route.below}/${route.of}` +
        `  |  LIVE orbs worst=${orb.worst.toFixed(1)} below=${orb.below}/${orb.of}`,
    )
    expect(level.mode).toBe('freeFlight')
    expect(
      route.below,
      'the dead ring course is 2016 content and is not to be moved',
    ).toBeGreaterThan(0)
    expect(orb.below, 'DEV-067: no live orb is inside the island').toBe(0)
    expect(orb.worst).toBeGreaterThan(0)
  })
})

// ── The always-on counterpart: the calls above, kept honest ───────────────
//
// Everything above is off unless `ROUTE_CLEARANCE=1`, and that stays true — the
// print is a tool and the guard behind it decodes four 969 KB height maps that
// CI does not have. But a body that never runs is a set of CALLS that never run,
// and the compiler does not cover for it: `loadLevelJson` returns `any`, so
// every `level.respawn.pos`, `pad.role` and `level.route` above is unchecked by
// `tsc` as well as by vitest. Rename one in `tools/extract/level.mjs` and the
// suite lands green, rots quietly, and is found by whoever next types the env
// var — and nothing in the repo says when that is.
//
// So this section makes the same calls with the same shapes and no height maps:
// the helpers resolve, `clearance` still means what the assertions above read it
// as, and all thirteen missions still carry the fields the sweep reaches for.
//
// It is NOT `orb-floor.test.ts`'s loud counterpart. That one asserts its guard
// is false because a false guard is the failure; here the guard being off is the
// intended state, and nothing below tries to turn the suite on.

/** The one shape every position in this file has: three finite numbers. */
const expectVec3 = (v: unknown, what: string): void => {
  expect(Array.isArray(v), what).toBe(true)
  const a = v as unknown[]
  expect(a, what).toHaveLength(3)
  for (const n of a) expect(Number.isFinite(n), `${what}: finite components`).toBe(true)
}

describe('route clearance: the guarded suite still fits the code it calls', () => {
  it('imports helpers that exist and take what the suite hands them', () => {
    expect(typeof loadLevelJson).toBe('function')
    expect(typeof clearance).toBe('function')
    expect(typeof liveOrbs).toBe('function')
    expect(typeof orbPos).toBe('function')
    expect(MISSIONS).toHaveLength(13)

    // `haveMaps` is a VALUE and the guard reads it as one. As a function it would
    // still typecheck under `!haveMaps` — and be permanently truthy, so the skip
    // would invert in silence. `tsc` has nothing to say about `!someFunction`.
    expect(typeof haveMaps).toBe('boolean')

    // `fieldFor` is the one helper this section cannot call — calling it is the
    // expensive half the guard exists to avoid. Arity is what is free, and a new
    // required parameter is the drift that would break every call above.
    expect(typeof fieldFor).toBe('function')
    expect(fieldFor.length).toBe(1)
    expect(clearance.length).toBe(2)
  })

  it('`clearance` is still metres of air, and still flips z on the way in', () => {
    // A hand-built field, so the expected answers are arithmetic rather than a
    // measurement: 2x2 samples on a 10 m step, normalised height 0 along the
    // z=0 edge and 1 along z=10, `terrainHeight` 100. The ground is flat in x
    // and climbs 10 m per metre of SIM z.
    const field: HeightField = {
      vertPerSide: 2,
      heights: Float32Array.from([0, 0, 1, 1]),
      step: 10,
      terrainSize: 10,
      terrainHeight: 100,
      originX: 0,
      originY: 0,
      originZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    }
    // THREE space in, SIM space sampled. Same x, same altitude, mirrored z, and
    // the two answers differ — the flip asserted as a difference rather than as
    // a restatement of the line that performs it (trap 24). Drop the minus in
    // `groundUnder` and the first of these becomes the second.
    expect(clearance(field, [0, 80, -5])).toBeCloseTo(30, 6)
    expect(clearance(field, [0, 80, 5])).toBeCloseTo(80, 6)
    // And the sign convention that every `toBeGreaterThan(0)` above rests on.
    expect(clearance(field, [0, 20, -5])).toBeCloseTo(-30, 6)
  })

  it('every mission still carries the fields the guarded suite reads off it', () => {
    for (const id of MISSIONS) {
      const level = loadLevelJson(id)

      // What `fieldFor` needs before it can decode anything. A renamed
      // environment key reaches it as a map path of `undefined`.
      expect(typeof level.environment, `${id}.environment`).toBe('string')
      expect(MAPS[level.environment], `${id}: a height map for '${level.environment}'`).toBeTruthy()
      expectVec3(level.worldOffset, `${id}.worldOffset`)
      expect(typeof level.mode, `${id}.mode`).toBe('string')

      // What the launch-site guard walks, in the shape it walks it.
      for (const pad of level.spawn.startGrid?.pads ?? []) {
        expect(typeof pad.role, `${id}: pad.role`).toBe('string')
        expectVec3(pad.pos, `${id}: ${pad.role} pad.pos`)
      }
      expectVec3(level.respawn.pos, `${id}.respawn.pos`)

      // What the route print walks, where `ROUTED` says there is one.
      if (ROUTED.has(id)) {
        expect(level.route?.length, `${id}.route`).toBeGreaterThan(0)
        expectVec3(level.route[0], `${id}.route[0]`)
      }

      // And the orb half of the kauai row, through the one door orbs have.
      for (const orb of liveOrbs(level)) expectVec3(orbPos(orb), `${id}: orb ${orb.i}`)
    }
  })
})
