// tests/unit/forced-mode.test.ts — DEV-061: which forcing FF2 obeys, and why.
//
// ── The finding, and the decision ─────────────────────────────────────────
//
// Two shipped scenes set `Level.ForceGameMode`, both to Free Flight. On
// `hoverJet_kauai_beg` that is coherent: all eleven of its `EnergyOrb`s are live
// and Free Flight is the mode that scores orbs. On `int_02_jumpSeat` it is not.
// All TWELVE of that mission's orbs ship `m_IsActive: 0` — the only mission of
// thirteen with none live — while NINE of its eleven jump pads are live, and the
// mode it is locked into scores orbs and not pads. So the mode it can enter has
// nothing to score and the content it has belongs to a mode it cannot enter.
//
// **Matt, 2026-09-13: _"int_02_jumpseat - option 2"_** — drop the forcing for
// that mission only. `docs/DEVIATIONS.md` DEV-061 carries the three options and
// what the other two would have cost.
//
// ── What is asserted here, and what is asserted elsewhere ─────────────────
//
// BEHAVIOUR, not the shape of a config object: the mode a run comes up in, what
// its HUD counts, what its holotable card says, whether its tank drains, and
// whether crossing a plate banks points. The one structural assertion is that
// 2016's own value is still in the JSON, because a deviation that erases the
// record is the failure mode this whole ledger exists to prevent.
//
//   · `pad-streak.test.ts` flies a PERFECT run through `stepMission` and checks
//     it reaches `arcadePadCeiling` exactly and earns platinum — on every
//     flyable mission, which now includes this one. That is the reachability
//     proof, and this file asserts the join rather than repeating it.
//   · `jumpseat-autopilot-missions.test.ts` flies the mission with the real
//     alpine height field and records what the autopilot can and cannot do.
//   · `mode-rules.test.ts` holds the seam itself.

import { describe, expect, it } from 'vitest'
import type { GameMode, Level } from '@/content/level-schema'
import { countLabel, countTotal, medalThresholds, startMission, stepMission } from '@/game/mission'
import { cardFor } from '@/game/mission-index'
import { isLive, MODES, rulesFor, runningMode, scores } from '@/game/modes'
import { arcadePadCeiling, livePads, padZones } from '@/game/targets'
import { FIXED_DT } from '@/sim/constants'
import { v3 } from '@/sim/math/vec3'
import { shippedLevelIds as ids, levelJson as level } from './helpers/content'

const UNFORCED = 'int_02_jumpSeat'
const STILL_FORCED = 'hoverJet_kauai_beg'

describe('DEV-061: the mission RUNS Target Practice', () => {
  it('comes up in Target Practice when nobody asks for a mode', () => {
    // The observable, and the whole row: `startMission` with no request is what
    // `boot/app.ts` calls, because there is no mode select yet.
    expect(startMission(level(UNFORCED)).mode).toBe('targetPractice')
  })

  it('counts its nine live PADS, not its zero live orbs', () => {
    const L = level(UNFORCED)
    const state = startMission(L)
    expect(state.countTotal).toBe(9)
    expect(livePads(L)).toHaveLength(9)
    expect(L.orbs.filter((o) => o.live)).toHaveLength(0)
    // Free Flight would have counted the orbs, of which there are none — the
    // HUD read `ORBS 00/00` for the whole life of the port.
    expect(countTotal(L, 'freeFlight')).toBe(0)
  })

  it('honours a requested mode now, and still refuses one on kauai', () => {
    // Dropping a forcing is not "force Target Practice instead": the mission is
    // simply no longer locked, so the day a mode select exists it obeys it. The
    // coherent forcing is untouched.
    expect(runningMode(level(UNFORCED), 'freeFlight')).toBe('freeFlight')
    expect(runningMode(level(UNFORCED), 'ringAttack')).toBe('ringAttack')
    expect(runningMode(level(STILL_FORCED), 'ringAttack')).toBe('freeFlight')
  })
})

describe('DEV-061: the pads actually score', () => {
  /** Drop through a pad's bullseye, which is the only tier on its axis. */
  const takeBullseye = (L: Level, pad: number): number => {
    const state = startMission(L)
    const eye = padZones(L).find((z) => z.pad === pad && z.points === 100)
    if (!eye) throw new Error(`no bullseye on pad ${pad}`)
    const from = v3(eye.centre.x, eye.centre.y + 60, eye.centre.z)
    const to = v3(eye.centre.x, eye.centre.y - 30, eye.centre.z)
    const steps = Math.ceil(90 / (40 * FIXED_DT))
    const at = v3(from.x, from.y, from.z)
    for (let i = 1; i <= steps; i++) {
      at.y = from.y + (to.y - from.y) * (i / steps)
      stepMission(state, L, at, FIXED_DT)
    }
    return state.score
  }

  it('banks points for a plate that used to be scenery', () => {
    // The bug, stated as the behaviour it was: nine live dartboards under a mode
    // that scores orbs. The ship flew the whole tour and the scorer was not
    // listening.
    const L = level(UNFORCED)
    expect(scores('freeFlight', 'padZone')).toBe(false)
    expect(scores(runningMode(L), 'padZone')).toBe(true)
    expect(takeBullseye(L, 0)).toBeGreaterThan(0)
  })

  it('has a live plate on every one of the nine', () => {
    const L = level(UNFORCED)
    for (let pad = 0; pad < livePads(L).length; pad++) {
      expect(takeBullseye(L, pad), `pad ${pad}`).toBeGreaterThan(0)
    }
  })

  it('puts platinum AT a ceiling a run can reach, unlike rookie_01_hoverJet', () => {
    // `rookie_01_hoverJet` ships 16 rings against a platinum of 1700 and is
    // mathematically unreachable, so "the mode scores" is not the same claim as
    // "the medals are winnable". Target Practice's curve is DERIVED from this
    // mission's own streak ceiling rather than typed, which makes platinum
    // reachable by construction — and `pad-streak.test.ts` flies a perfect run
    // and checks the flown score equals the ceiling exactly.
    const L = level(UNFORCED)
    const ceiling = arcadePadCeiling(L)
    const curve = medalThresholds(L, runningMode(L))
    expect(ceiling).toBe(4400)
    expect(curve).toEqual({ bronze: 1760, silver: 2640, gold: 3520, platinum: 4400 })
    expect(curve?.platinum).toBe(ceiling)
    for (const band of ['bronze', 'silver', 'gold', 'platinum'] as const) {
      expect(curve?.[band], band).toBeLessThanOrEqual(ceiling)
    }
    // The 2016 numbers on the same mission, for contrast: a bronze of 1600
    // against a flat ceiling of 900. Unreachable, recorded, and not what FF2
    // awards against (DEV-053).
    expect(L.medals.bronze).toBe(1600)
  })
})

describe('DEV-061: everything downstream agrees about which mode it is', () => {
  it('labels the holotable card Target Practice', () => {
    // A mission that RUNS Target Practice while its card says Free Flight is
    // worse than the bug being fixed. `cardFor` reads `runningMode`.
    const card = cardFor(level(UNFORCED), null)
    expect(card.mode).toBe('targetPractice')
    expect(card.modeName).toBe('Target Practice')
    expect(cardFor(level(STILL_FORCED), null).modeName).toBe('Free Flight')
  })

  it('labels the HUD row PADS, draws the pads and draws no orbs', () => {
    const L = level(UNFORCED)
    const mode = runningMode(L)
    expect(countLabel(L, mode)).toBe('PADS')
    expect(isLive(mode, 'padZone')).toBe(true)
    expect(isLive(mode, 'orb')).toBe(false)
  })

  it('drains the tank, because Target Practice does and Free Flight does not', () => {
    // `FuelManager.cs:30`. The pads' refuel spheres are decorative in Free Flight
    // and are the reason a nine-pad tour is flyable at all here.
    expect(rulesFor(runningMode(level(UNFORCED))).burnsFuel).toBe(true)
    expect(MODES.freeFlight.burnsFuel).toBe(false)
  })

  it('gives it a finish, where Free Flight ends only from the menu', () => {
    const L = level(UNFORCED)
    expect(rulesFor(runningMode(L)).endsOn).toBe('finishGate')
    expect(MODES.freeFlight.endsOn).toBe('never')
    expect(startMission(L).finish).not.toBeNull()
  })

  it('still races nobody', () => {
    expect(rulesFor(runningMode(level(UNFORCED))).opponents).toBe(false)
  })
})

describe('DEV-061: nothing else moved', () => {
  /** Every shipped mission's RUNNING mode. The blast radius, pinned. */
  const RUNNING: Record<string, GameMode> = {
    adv_01_hoverJet: 'ringAttack',
    adv_01_jumpSeat: 'targetPractice',
    adv_02_hoverJet: 'ringAttack',
    adv_02_jumpSeat: 'targetPractice',
    hoverJet_kauai_beg: 'freeFlight',
    int_01_hoverJet: 'ringAttack',
    int_01_jumpSeat: 'targetPractice',
    int_02_hoverJet: 'ringAttack',
    int_02_jumpSeat: 'targetPractice',
    rookie_01_hoverJet: 'ringAttack',
    rookie_01_jumpSeat: 'targetPractice',
    rookie_02_hoverJet: 'ringAttack',
    rookie_02_jumpSeat: 'targetPractice',
  }

  it('changes exactly one mission of the thirteen', () => {
    expect(ids()).toEqual(Object.keys(RUNNING).sort())
    for (const id of ids()) expect(runningMode(level(id)), id).toBe(RUNNING[id])
    // Said the other way: the only mission whose running mode is not its
    // vehicle's default is the one whose forcing FF2 keeps.
    const overridden = ids().filter((id) => {
      const L = level(id)
      return runningMode(L) !== (L.vehicle === 'hoverjet' ? 'ringAttack' : 'targetPractice')
    })
    expect(overridden).toEqual([STILL_FORCED])
  })

  it('touches exactly one level JSON', () => {
    const deviating = ids().filter((id) => level(id).forcedModeFf2 !== null)
    expect(deviating).toEqual([UNFORCED])
  })
})

describe('DEV-061: 2016 is still on the record', () => {
  it('keeps `forcedMode` saying what the scene says', () => {
    // The deviation is a SECOND field, exactly as `medalsFf2` sits beside
    // `medals` and `posFf2` beside `pos`. Deleting the record would make the
    // JSON disagree with the Unity project it was extracted from.
    expect(level(UNFORCED).forcedMode).toBe('freeFlight')
    expect(level(STILL_FORCED).forcedMode).toBe('freeFlight')
    const forced = ids().filter((id) => level(id).forcedMode !== null)
    expect(forced.sort()).toEqual([STILL_FORCED, UNFORCED].sort())
  })

  it('names the deviation and the mode it dropped, in the JSON', () => {
    const ff2 = level(UNFORCED).forcedModeFf2
    expect(ff2?.mode).toBeNull()
    expect(ff2?._meta?.deviation).toBe('DEV-061')
    expect(ff2?._meta?.mode2016).toBe('freeFlight')
  })

  it('keeps the extractor s provenance row for the 2016 field', () => {
    const meta = (level(UNFORCED) as unknown as { _meta: { provenance: Record<string, string>[] } })
      ._meta
    const row = meta.provenance.find((p) => p.field === 'forcedMode')
    expect(row?.value).toBe('freeFlight')
    expect(row?.source).toMatch(/Level\.ForceGameMode\/ForcedGameMode/)
    const dev = meta.provenance.find((p) => p.field === 'forcedModeFf2')
    expect(dev?.source).toMatch(/DEV-061/)
  })
})

describe('DEV-061: the fall-through trap the object shape exists to stop', () => {
  it('does NOT fall back to `forcedMode` when FF2 has decided not to force', () => {
    // `level.forcedModeFf2 ?? level.forcedMode` would be the natural thing to
    // write — it is the idiom `medalsFf2` and `posFf2` use — and here it is
    // WRONG, because the value FF2 wants is itself null. The object wrapper makes
    // that version a type error; this asserts the behaviour it protects.
    const L = level(UNFORCED)
    expect(L.forcedMode).toBe('freeFlight')
    expect(L.forcedModeFf2?.mode).toBeNull()
    expect(runningMode(L)).not.toBe('freeFlight')
  })

  it('lets an FF2 forcing override a 2016 one, not only cancel it', () => {
    // Nothing ships this today. It is asserted because a field that can only
    // express "off" would have been a boolean, and the next mission that needs a
    // different mode must not need a new field.
    const L = { ...level(UNFORCED), forcedModeFf2: { mode: 'ringAttack' as const } }
    expect(runningMode(L)).toBe('ringAttack')
    expect(runningMode(L, 'freeFlight')).toBe('ringAttack')
  })

  it('leaves a level with no `forcedModeFf2` at all obeying 2016', () => {
    // Hand-authored and generated courses go through the same loader and may
    // carry only `forcedMode`. Absent must mean "no deviation", never "unforced".
    // The key REMOVED, not set to undefined: `exactOptionalPropertyTypes` makes
    // those different things in the types and identical at runtime, and it is the
    // runtime one a level JSON without the field produces.
    const bare = JSON.parse(JSON.stringify(level(STILL_FORCED))) as Record<string, unknown>
    delete bare.forcedModeFf2
    expect('forcedModeFf2' in bare).toBe(false)
    expect(runningMode(bare as unknown as Level, 'ringAttack')).toBe('freeFlight')
  })
})
