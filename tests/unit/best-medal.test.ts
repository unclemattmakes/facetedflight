// tests/unit/best-medal.test.ts — the medal a stored best earns (DEV-113).
//
// Two things are guarded, and the second is the one that could rot.
//
// The first is the derivation: no best is no medal, a mode with no curve is no
// medal, below bronze is no medal (2016's "Lead", which `LevelEnd.cs:198` never
// writes), and each threshold is its tier — on all three modes, off the real
// level JSON.
//
// The second is a COINCIDENCE the derivation leans on. `game/mission.ts` hands
// the curve `missionScore` on a 'points' mode and `counted` on a 'count' mode,
// while `personal-best.ts` stores `missionScore` on every mode. Free Flight is
// the 'count' mode, and its score happens to equal its count because an orb is
// one point and there is no time bonus. That is a property of the mode table
// and nothing enforces it, so the test below FLIES a Free Flight course and
// checks, orb by orb, that the medal derived from what would be stored is the
// medal the run was actually awarded. Trap 24: it compares against the run,
// not against a second copy of the arithmetic.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { bestMedal } from '@/game/best-medal'
import {
  type Medal,
  type MissionState,
  medalFor,
  medalThresholds,
  missionScore,
  startMission,
  stepMission,
} from '@/game/mission'
import { cardFor } from '@/game/mission-index'
import { rulesFor, runningMode } from '@/game/modes'
import { bestKey, type PersonalBest } from '@/game/personal-best'
import { PROPS } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { levelJson as level } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

const best = (score: number): PersonalBest => ({ score, timeSeconds: 60, gates: 0, setAt: 0 })

/** Fly a straight line at `speed`. Same helper `mode-medals.test.ts` carries. */
const flyTo = (state: MissionState, L: Level, from: Vec3, to: Vec3, speed: number): Vec3 => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / (speed * FIXED_DT)))
  const at = v3(from.x, from.y, from.z)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    at.x = from.x + dx * t
    at.y = from.y + dy * t
    at.z = from.z + dz * t
    stepMission(state, L, at, FIXED_DT)
  }
  return v3(at.x, at.y, at.z)
}

/** One shipped mission per mode, in the mode it actually runs in. */
const ONE_PER_MODE = [
  ['int_01_hoverJet', 'ringAttack'],
  ['rookie_02_jumpSeat', 'targetPractice'],
  ['hoverJet_kauai_beg', 'freeFlight'],
] as const

describe('the medal a stored best earns', () => {
  it('is nothing with no best', () => {
    for (const [id] of ONE_PER_MODE) expect(bestMedal(level(id), null)).toBeNull()
  })

  for (const [id, mode] of ONE_PER_MODE) {
    it(`${id} (${mode}): below bronze is nothing, and each threshold is its tier`, () => {
      const L = level(id)
      expect(runningMode(L)).toBe(mode)
      const curve = medalThresholds(L, mode)
      expect(curve, 'this mode awards a medal at all').not.toBeNull()
      if (!curve) return
      expect(bestMedal(L, best(0))).toBeNull()
      expect(bestMedal(L, best(curve.bronze - 1))).toBeNull()
      for (const tier of ['bronze', 'silver', 'gold', 'platinum'] as const) {
        expect(bestMedal(L, best(curve[tier])), `at the ${tier} threshold`).toBe(tier)
      }
      expect(bestMedal(L, best(curve.platinum * 3))).toBe('platinum')
    })
  }

  it('is nothing on a course whose mode awards none, however good the best', () => {
    // No shipped mission is in this state under the live rules — `padStreak`
    // gives every JumpSeat course a curve off its pads, even `rookie_01_jumpSeat`
    // whose `medals` block is four nulls — so the case is a hand-authored ring
    // course with no thresholds at all. `medalCurve` says null, and a null curve
    // is no medal, not platinum-for-free (see `complete` in game/modes.ts).
    const L = {
      ...level('int_01_hoverJet'),
      medalsFf2: null,
      medals: { bronze: null, silver: null, gold: null, platinum: null },
    } as unknown as Level
    expect(medalThresholds(L, runningMode(L))).toBeNull()
    expect(bestMedal(L, best(1_000_000))).toBeNull()
  })

  it('agrees with the medal a FLOWN run was awarded, orb by orb, on the count scale', () => {
    const L = level('hoverJet_kauai_beg')
    expect(rulesFor(runningMode(L)).medalScale, 'this is the count-scale mode').toBe('count')
    const state = startMission(L)
    const orbs = state.orbs.orbs
    const first = orbs[0]
    expect(first).toBeDefined()
    if (!first) return
    let at = v3(first.centre.x, first.centre.y + 300, first.centre.z)
    const seen = new Set<Medal>()
    for (const orb of orbs) {
      at = flyTo(state, L, at, orb.centre, 90)
      // What `boot/app.ts` would store at this moment, and what the run says.
      const stored: PersonalBest = {
        score: missionScore(state),
        timeSeconds: state.elapsed,
        gates: state.ringsPassed,
        setAt: 0,
      }
      const derived = bestMedal(L, stored) ?? 'none'
      const awarded = medalFor(state, L) ?? 'none'
      expect(derived, `after ${state.counted} orbs`).toBe(awarded)
      seen.add(derived)
    }
    // Eleven live orbs, and since DEV-393 platinum is held to the eleven (2016
    // asked for twelve): the run climbs through all four tiers, so the agreement
    // above was tested across every transition the course can produce.
    expect(state.orbs.collected).toBe(11)
    expect([...seen].sort()).toEqual(['bronze', 'gold', 'none', 'platinum', 'silver'])
  })
})

describe('the medal on a mission card', () => {
  const L = level('int_01_hoverJet')
  const curve = medalThresholds(L, runningMode(L))

  /** An in-memory `localStorage`. */
  const memory = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial))
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
    }
  }

  it('is derived from the stored best', () => {
    if (!curve) throw new Error('int_01_hoverJet has a ring curve')
    const store = memory({
      [bestKey(L.id, runningMode(L))]: JSON.stringify({
        score: curve.gold,
        timeSeconds: 80,
        gates: 20,
        setAt: 1,
      }),
    })
    const card = cardFor(L, store)
    expect(card.best?.score).toBe(curve.gold)
    expect(card.medal).toBe('gold')
  })

  it('is nothing when the store holds garbage', () => {
    for (const raw of [
      '{"score":"platinum"}',
      'not json',
      '{"score":-5,"timeSeconds":1,"gates":1}',
    ]) {
      const card = cardFor(L, memory({ [bestKey(L.id, runningMode(L))]: raw }))
      expect(card.best, raw).toBeNull()
      expect(card.medal, raw).toBeNull()
    }
  })

  it('is nothing when the store throws, and when there is none', () => {
    const hostile = {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    }
    expect(cardFor(L, hostile).medal).toBeNull()
    expect(cardFor(L, null).medal).toBeNull()
  })
})

describe('the medal sheet (PROPS.medals), as extracted', () => {
  const M = PROPS.medals
  const OLD_DIALECT = ['lead', 'bronze', 'silver', 'gold', 'platinum'] as const

  it('read the five old-dialect materials the YAML parser cannot see (DEV-043)', () => {
    for (const tier of OLD_DIALECT) {
      expect(M.colorDialect[tier], tier).toBe('old')
      expect(M.parserSawColour[tier], `${tier}: the parser returned nothing`).toBe(false)
      const c = M.colors[tier]
      expect(c.length).toBe(4)
      for (const ch of c) expect(ch).toBeGreaterThanOrEqual(0)
      for (const ch of c) expect(ch).toBeLessThanOrEqual(1)
      expect(c[3], `${tier} is opaque`).toBe(1)
    }
    // The one file in the NEW dialect is the one the parser does read — which is
    // exactly why a parser-only extractor would have reported five of six
    // medals as having no colour and the sixth as fine.
    expect(M.colorDialect.missing).toBe('new')
    expect(M.parserSawColour.missing).toBe(true)
    expect(M.colors.missing[3]).toBeCloseTo(0.072, 3)
  })

  it('silver agrees with the value render/title.ts carried by hand, to a rounding step', () => {
    // `LOGO_SILVER = 0xc2c8e5` was read out of the same `medal_Silver.mat` by
    // eye, before this extractor existed — an independent reading of the same
    // bytes. One step of 1/255 is the rounding either reading is allowed.
    const hex = [0xc2, 0xc8, 0xe5]
    for (let i = 0; i < 3; i++) {
      expect(
        Math.abs((M.colors.silver[i] as number) * 255 - (hex[i] as number)),
        `channel ${i}`,
      ).toBeLessThanOrEqual(1)
    }
    // And the four live tiers are four DIFFERENT colours: a tier reading as
    // another tier is the failure a tint exists to prevent.
    const keys = OLD_DIALECT.filter((t) => t !== 'lead').map((t) =>
      M.colors[t].slice(0, 3).join(','),
    )
    expect(new Set(keys).size).toBe(4)
  })

  it('is the title emblem, spun over a slot that is live on every shipped mission page', () => {
    expect(M.emblemMesh).toBe('Assets/Faceted Flight/Meshes/logo_polys.fbx')
    // Cross-source: the title-logo asset's own provenance names the same FBX,
    // which is what lets `render/medal.ts` build a medal out of the title glTF.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'tools', 'assets', 'required-assets.json'), 'utf8'),
    ) as { assets: { path: string; source?: string }[] }
    const logo = manifest.assets.find((a) => a.path === 'assets/props/title-logo.glb')
    expect(logo?.source ?? '').toContain(M.emblemMesh)

    expect(M.emblemAgrees, 'every tier prefab carries the same emblem transform').toBe(true)
    expect(M.instanceForcedToUnitScale, 'Slot_Medal.cs sets the instance to Vector3.one').toBe(true)
    expect(M.slotLive).toBe(true)
    expect(M.slotSpawnOnStart).toBe(true)
    // Twelve stripped holotable instances under the six `missionSel_*` pages,
    // and none of them touches the slot — so the prefab's own transform is the
    // one every mission table's medal uses.
    expect(M.menu.underMissionPages).toBe(12)
    expect(M.menu.slotOverridden).toBe(0)
    expect(M.menu.pages.length).toBe(6)
    expect(M.spinDegPerSecond).toBe(55)
    expect(M.startYawMaxDeg).toBe(270)
  })
})
