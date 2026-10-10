// tests/unit/gate-visibility.test.ts — a passed gate goes away (DEV-122).
//
// The event -> visibility MAPPING, without a renderer. In the order these
// would hurt:
//
//  1. **Classic is 2016.** The hold is the sheet's `passedHideDelay`, imported
//     by key (DEV-069's lesson), and the sheet is checked against the ONE thing
//     outside the port that knows the number: the coroutine literal in
//     `TriggerCheckpoint.cs` — guarded on the legacy project, with the loud
//     counterpart CLAUDE.md asks for.
//  2. **A pop is a pop.** Classic must never draw a frame of a gate mid-shrink:
//     at the delay it is 1, one tick later it is 0, nothing in between.
//  3. **The second gate did not move.** Passing gate 3 shrinks gate 3. The
//     guard for a shared state is "step a second one and assert the first did
//     not move" (trap 19), so every scale test reads a neighbour too.
//  4. **A restart puts every gate back.**
//  5. **The presets say what they claim.** Anniversary's fade is a fade
//     (seconds above zero) and Classic's flag is off.
//
// ── And since DEV-195, WHEN the clock starts ─────────────────────────────
//
// The mapping was right and its ANCHOR was wrong: a pass is stamped on the IN
// edge of a 22.619 m trigger sphere, a measured median of 21.5 m before the
// gate's own plane, so the 0.3 s shrink ran out while the ship was still in the
// hole — on the six Ring Attack courses, 246 ticks of a 90 s run were spent
// inside a gate that had already reached scale ZERO. The last describe flies the
// autopilot down the real courses and asserts the property directly — **a gate
// is full size on every tick the ship is inside its trigger sphere** — because
// that is a statement about the geometry rather than about the arithmetic I
// just wrote, and it is the one a re-derivation cannot fake (trap 24).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateEdition } from '@/content/edition-schema'
import {
  CLASSIC_PASSED_FADE,
  createGateVisibility,
  EXIT_BACKSTOP_SECONDS,
  fadeAnchor,
  passedFadeSpec,
  passedGateScale,
} from '@/game/gate-visibility'
import { courseGates, type MissionLevers, startMission, stepMission } from '@/game/mission'
import { PROPS } from '@/generated/constants.generated'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainGate } from '@/sim/speed-chain'
import { legacyRootOrAbsent } from '../../tools/legacy-root.mjs'
import { editionJson as edition, levelJson as level } from './helpers/content'

const CS = path.join(legacyRootOrAbsent(), 'Assets/Faceted Flight/Scripts/TriggerCheckpoint.cs')
const haveLegacy = fs.existsSync(CS)

describe('Classic is 2016', () => {
  it('holds for the sheet`s passedHideDelay, by key, then pops', () => {
    expect(CLASSIC_PASSED_FADE.delaySeconds).toBe(PROPS.checkpointRing.passedHideDelay)
    expect(CLASSIC_PASSED_FADE.seconds).toBe(0)
  })

  it('the sheet`s trust is code-default: a coroutine literal, not a field', () => {
    // A number out of a .cs file may ship only as code-default (hard rule 2).
    expect(PROPS.checkpointRing.passedHideDelay).toBe(2)
  })

  describe.skipIf(!haveLegacy)('against the 2016 source', () => {
    it('matches the WaitForSeconds literal inside Deactivate()', () => {
      const source = fs.readFileSync(CS, 'utf8')
      const body = source.slice(source.indexOf('IEnumerator Deactivate'))
      const m = /WaitForSeconds\s*\(\s*([0-9.]+)f?\s*\)/.exec(body)
      expect(m, 'Deactivate() has a WaitForSeconds').not.toBeNull()
      expect(Number(m?.[1])).toBe(PROPS.checkpointRing.passedHideDelay)
      // And the thing that is deactivated is checkpointArt, in that coroutine.
      expect(body).toMatch(/checkpointArt\.SetActive\(false\)/)
    })

    it('hides on the PLAYER`s pass only — the npc branch plays effects and nothing else', () => {
      const source = fs.readFileSync(CS, 'utf8')
      const npc = source.slice(source.indexOf('CompareTag("npc")'))
      const npcBlock = npc.slice(0, npc.indexOf('}', npc.indexOf('{')) + 1)
      expect(npcBlock).toMatch(/effects\.Play\(\)/)
      expect(npcBlock).not.toMatch(/Deactivate|SetActive|Destroy/)
    })
  })

  describe.skipIf(haveLegacy)('legacy project not mounted', () => {
    it('is skipping the source check, loudly', () => {
      expect(haveLegacy).toBe(false)
    })
  })
})

describe('passedGateScale', () => {
  // The 2016 anchor, which is what `passedGateScale` measures from: these
  // exercise the SHAPE of the fade, and `fadeAnchor` below is what decides
  // where its zero is.
  const pop = { delaySeconds: 2, seconds: 0, waitForExit: false }
  const fade = { delaySeconds: 0, seconds: 0.3, waitForExit: false }

  it('is 1 before the delay and 0 after, with nothing between, when seconds is 0', () => {
    expect(passedGateScale(0, pop)).toBe(1)
    expect(passedGateScale(1.99, pop)).toBe(1)
    expect(passedGateScale(2, pop)).toBe(0)
    expect(passedGateScale(2.0001, pop)).toBe(0)
    expect(passedGateScale(60, pop)).toBe(0)
  })

  it('shrinks linearly over `seconds` once the delay has passed', () => {
    expect(passedGateScale(0, fade)).toBe(1)
    expect(passedGateScale(0.15, fade)).toBeCloseTo(0.5, 6)
    expect(passedGateScale(0.3, fade)).toBe(0)
    expect(passedGateScale(1, fade)).toBe(0)
    const both = { delaySeconds: 1, seconds: 0.5, waitForExit: false }
    expect(passedGateScale(1, both)).toBe(1)
    expect(passedGateScale(1.25, both)).toBeCloseTo(0.5, 6)
    expect(passedGateScale(1.5, both)).toBe(0)
  })

  it('reads a pass in the future, or NaN, as "not yet" — the safe side', () => {
    expect(passedGateScale(-0.1, fade)).toBe(1)
    expect(passedGateScale(Number.NaN, fade)).toBe(1)
  })

  it('never leaves [0, 1]', () => {
    for (let t = -1; t <= 5; t += 0.05) {
      for (const spec of [pop, fade, { delaySeconds: 0.5, seconds: 1.5, waitForExit: false }]) {
        const s = passedGateScale(t, spec)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('createGateVisibility', () => {
  const fade = { delaySeconds: 0, seconds: 0.3, waitForExit: false }

  it('shrinks the gate that was passed and leaves its neighbours alone', () => {
    const v = createGateVisibility(21)
    v.pass(3, 10)
    expect(v.scaleAt(3, 10.15, fade)).toBeCloseTo(0.5, 6)
    expect(v.scaleAt(3, 10.3, fade)).toBe(0)
    // The second-object guard: 2 and 4 never moved.
    expect(v.scaleAt(2, 10.3, fade)).toBe(1)
    expect(v.scaleAt(4, 10.3, fade)).toBe(1)
    expect(v.scaleAt(20, 99, fade)).toBe(1)
  })

  it('keeps the FIRST pass time — a triggerOnce gate does not restart its fade', () => {
    const v = createGateVisibility(3)
    v.pass(1, 5)
    v.pass(1, 7)
    expect(v.passedAt(1)).toBe(5)
    expect(v.scaleAt(1, 7.1, fade)).toBe(0)
  })

  it('ignores an index outside the course rather than throwing', () => {
    const v = createGateVisibility(2)
    expect(() => v.pass(-1, 1)).not.toThrow()
    expect(() => v.pass(2, 1)).not.toThrow()
    expect(v.scaleAt(0, 5, fade)).toBe(1)
    expect(v.scaleAt(1, 5, fade)).toBe(1)
  })

  it('reset puts every gate back to 1', () => {
    const v = createGateVisibility(4)
    for (let i = 0; i < 4; i++) v.pass(i, i)
    expect(v.scaleAt(0, 50, fade)).toBe(0)
    v.reset()
    for (let i = 0; i < 4; i++) {
      expect(Number.isNaN(v.passedAt(i))).toBe(true)
      expect(v.scaleAt(i, 50, fade)).toBe(1)
    }
  })

  it('under the Classic spec holds two seconds of sim time and then pops', () => {
    const v = createGateVisibility(1)
    v.pass(0, 100)
    expect(v.scaleAt(0, 101.9, CLASSIC_PASSED_FADE)).toBe(1)
    expect(v.scaleAt(0, 102, CLASSIC_PASSED_FADE)).toBe(0)
  })
})

describe('the presets', () => {
  it('Classic`s flag is off, and off resolves to 2016`s timing whatever its numbers say', () => {
    const classic = edition('classic').gates.passedFade
    expect(classic.enabled).toBe(false)
    expect(passedFadeSpec(classic)).toEqual(CLASSIC_PASSED_FADE)
  })

  it('Anniversary`s flag is on and it HIDES, never shrinks (DEV-869)', () => {
    const fade = edition('anniversary').gates.passedFade
    expect(fade.enabled).toBe(true)
    // Matt: never scale the rings down. A shrink is seconds > 0.
    expect(fade.seconds).toBe(0)
    expect(passedFadeSpec(fade)).toEqual({
      delaySeconds: fade.delaySeconds,
      seconds: fade.seconds,
      waitForExit: fade.waitForExit,
    })
    // Short: a gate at 100 m/s is 30 m behind you by the time it is gone.
    expect(fade.delaySeconds + fade.seconds).toBeLessThanOrEqual(1)
  })

  it('Anniversary waits for the EXIT and Classic does not (DEV-195)', () => {
    // The whole of the defect, as two booleans. Classic counts from
    // `OnTriggerEnter` because that is where 2016's coroutine starts; anything
    // else here is not 2016.
    expect(edition('anniversary').gates.passedFade.waitForExit).toBe(true)
    expect(edition('classic').gates.passedFade.waitForExit).toBe(false)
    expect(CLASSIC_PASSED_FADE.waitForExit).toBe(false)
  })
})

// ── DEV-195: the fade starts when you LEAVE the gate ──────────────────────

describe('fadeAnchor', () => {
  const exitRule = { delaySeconds: 0, seconds: 0.3, waitForExit: true }
  const passRule = { delaySeconds: 0, seconds: 0.3, waitForExit: false }

  it('under 2016`s rule is the pass, and the exit is not consulted at all', () => {
    expect(fadeAnchor(10, Number.NaN, passRule)).toBe(10)
    expect(fadeAnchor(10, 10.2, passRule)).toBe(10)
    // Even an exit BEFORE the pass — which cannot happen, but which would be
    // the one way to make a gate vanish on contact — cannot move this anchor.
    expect(fadeAnchor(10, 9, passRule)).toBe(10)
  })

  it('under waitForExit is the exit', () => {
    expect(fadeAnchor(10, 10.207, exitRule)).toBeCloseTo(10.207, 9)
  })

  it('without an exit is the BACKSTOP, never Infinity — a gate always goes', () => {
    expect(fadeAnchor(10, Number.NaN, exitRule)).toBe(10 + EXIT_BACKSTOP_SECONDS)
  })

  it('takes the EARLIER of the two, so a late exit cannot push a fading gate back', () => {
    const late = 10 + EXIT_BACKSTOP_SECONDS + 5
    expect(fadeAnchor(10, late, exitRule)).toBe(10 + EXIT_BACKSTOP_SECONDS)
  })

  it('is NaN for a gate never passed, under either rule', () => {
    expect(fadeAnchor(Number.NaN, 5, exitRule)).toBeNaN()
    expect(fadeAnchor(Number.NaN, 5, passRule)).toBeNaN()
  })

  it('the backstop is 2016`s own hold, by key — not a number anybody picked', () => {
    // So the degenerate case of waitForExit is Classic's timing rather than a
    // third behaviour, and there is no new constant to argue with.
    expect(EXIT_BACKSTOP_SECONDS).toBe(PROPS.checkpointRing.passedHideDelay)
    expect(EXIT_BACKSTOP_SECONDS).toBe(CLASSIC_PASSED_FADE.delaySeconds)
  })
})

describe('createGateVisibility, waiting for the exit', () => {
  const exitRule = { delaySeconds: 0, seconds: 0.3, waitForExit: true }

  it('holds the gate at FULL SIZE for the whole crossing, then shrinks', () => {
    const v = createGateVisibility(21)
    v.pass(3, 100)
    // The measured spread of a crossing: 0.098 s at the fast end, 0.634 s at
    // the slowest a 2016 human ever flew one. Under the old pass-anchored rule
    // the gate was GONE by 0.3 s — a third of the way into the slow crossing.
    for (const t of [0, 0.098, 0.2, 0.3, 0.5, 0.634, 1.0]) {
      expect(v.scaleAt(3, 100 + t, exitRule), `still inside at +${t}s`).toBe(1)
    }
    v.exit(3, 100.634)
    expect(v.scaleAt(3, 100.634, exitRule)).toBe(1)
    expect(v.scaleAt(3, 100.784, exitRule)).toBeCloseTo(0.5, 6)
    expect(v.scaleAt(3, 101, exitRule)).toBe(0)
    // Trap 19: step a second one and assert the first did not move.
    expect(v.scaleAt(2, 101, exitRule)).toBe(1)
    expect(v.scaleAt(4, 101, exitRule)).toBe(1)
  })

  it('goes anyway if the exit never comes — capped at the backstop', () => {
    // A run that FINISHES while the ship is inside a gate freezes
    // `CourseState.inside[]`, because `stepMission` early-returns on
    // `state.finished`. A gate that should be gone and is not is a visible bug.
    const v = createGateVisibility(2)
    v.pass(0, 0)
    expect(v.scaleAt(0, EXIT_BACKSTOP_SECONDS - 0.01, exitRule)).toBe(1)
    expect(v.scaleAt(0, EXIT_BACKSTOP_SECONDS + 1, exitRule)).toBe(0)
  })

  it('will not stamp an exit for a gate that was never passed', () => {
    // The dangerous shape: every gate on the course is OUTSIDE the ship on
    // every tick, so an unarmed `exit` would hand all 21 an anchor in the past
    // and the first pass would vanish its gate on contact.
    const v = createGateVisibility(3)
    v.exit(0, 0)
    v.exit(1, 0)
    expect(Number.isNaN(v.exitedAt(0))).toBe(true)
    v.pass(0, 10)
    expect(Number.isNaN(v.exitedAt(0))).toBe(true)
    expect(v.scaleAt(0, 10, exitRule)).toBe(1)
    expect(v.scaleAt(0, 10.3, exitRule)).toBe(1)
  })

  it('keeps the FIRST exit — the renderer calls it every frame', () => {
    // `game/rings.ts` stamps from the sim's `inside[]` on every frame the ship
    // is not in the sphere, which is every frame for the rest of the run.
    const v = createGateVisibility(2)
    v.pass(0, 10)
    v.exit(0, 10.2)
    for (let t = 10.2; t < 12; t += 0.05) v.exit(0, t)
    expect(v.exitedAt(0)).toBeCloseTo(10.2, 9)
    expect(v.scaleAt(0, 10.5, exitRule)).toBe(0)
  })

  it('reset clears the exit as well as the pass', () => {
    const v = createGateVisibility(2)
    v.pass(0, 1)
    v.exit(0, 1.2)
    v.reset()
    expect(Number.isNaN(v.exitedAt(0))).toBe(true)
    expect(v.scaleAt(0, 99, exitRule)).toBe(1)
  })

  it('never grows back: the scale is monotone through a crossing', () => {
    const v = createGateVisibility(1)
    v.pass(0, 0)
    let last = 1
    for (let t = 0; t < 4; t += FIXED_DT) {
      if (t >= 0.5) v.exit(0, Math.max(0.5, t))
      const s = v.scaleAt(0, t, exitRule)
      expect(s).toBeLessThanOrEqual(last + 1e-12)
      last = s
    }
    expect(last).toBe(0)
  })

  it('CLASSIC is untouched by any of this — stamp an exit and it still pops at 2 s', () => {
    const v = createGateVisibility(1)
    v.pass(0, 100)
    v.exit(0, 100.2)
    expect(v.scaleAt(0, 100.2, CLASSIC_PASSED_FADE)).toBe(1)
    expect(v.scaleAt(0, 101.999, CLASSIC_PASSED_FADE)).toBe(1)
    expect(v.scaleAt(0, 102, CLASSIC_PASSED_FADE)).toBe(0)
    // One frame, no intermediate value, exactly as 2016.
    expect(v.scaleAt(0, 102 - 1e-9, CLASSIC_PASSED_FADE)).toBe(1)
  })
})

// ── Flown, on the real courses (DEV-195) ──────────────────────────────────
//
// Everything above is arithmetic, and arithmetic cannot tell you that the
// ANCHOR was in the wrong place — a test that re-derives its expectation the
// way the code does has not tested the code (trap 24). So this one flies.
//
// The autopilot goes down each Ring Attack course through the same per-tick
// sequence `boot/app.ts` runs, and `GateVisibility` is driven exactly as
// `game/rings.ts` drives it: `pass` on the index `stepMission` returns, `exit`
// from the sim's own `CourseState.inside[]`. The assertion is a statement about
// the GEOMETRY and is true independently of what I believed:
//
//   **a gate is at full size on every tick the ship is inside its sphere.**
//
// It is red on the pass-anchored code by a wide margin — measured over these
// same 129 crossings, the gate is at a median of 0.675 by the time the ship
// reaches the gate's own plane, and the worst tick inside a sphere is 0.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
/**
 * Every shipped course a ring can actually be SCORED on, from the JSON rather
 * than a hand-kept list.
 *
 * `mode` and not just "has rings": `hoverJet_kauai_beg` is `int_01`'s course
 * re-authored in a second environment and forced to Free Flight, so its 21
 * gates are drawn and none of them is ever passed. A run there spends no ticks
 * inside a passed gate, which would make the assertion below vacuous rather
 * than true.
 */
const RING_COURSES = fs
  .readdirSync(path.join(ROOT, 'content/levels'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace('.json', ''))
  .filter(
    (id) =>
      level(id).vehicle === 'hoverjet' &&
      level(id).mode === 'ringAttack' &&
      courseGates(level(id)).length > 0,
  )
  .sort()

interface Flown {
  /** The worst scale seen on any tick the ship was INSIDE a passed gate. */
  worstInside: number
  /** Ticks spent inside a passed gate, across the run. Zero would be a dead test. */
  ticksInside: number
  /** The longest crossing, sim seconds. Must stay under the backstop. */
  longestDwell: number
  /** Ticks on which a gate that had been left was still at full size. */
  everFades: boolean
}

/**
 * One course, flown, with the fade driven the way the renderer drives it.
 *
 * `spec` is the rule under test, so the same flight can be scored against the
 * old anchor and the new one — which is how this was proved red.
 */
const flyAndWatch = (id: string, spec: ReturnType<typeof passedFadeSpec>): Flown => {
  const lvl = level(id)
  const gates = courseGates(lvl)
  const drawn = lvl.routes[0]?.rings.length ?? 0
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, lvl.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, lvl.spawn.quat as number[])
  jet.body.position.y += lvl.spawn.launch?.rise ?? 0
  const mission = startMission(lvl)
  const anniversary = validateEdition(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'content/editions/anniversary.json'), 'utf8')),
  )
  const floorY = Math.min(...gates.map((g) => g.centre.y))
  const input = noInput()
  const visibility = createGateVisibility(drawn)
  const passedAtTick = new Map<number, number>()

  const out: Flown = { worstInside: 1, ticksInside: 0, longestDwell: 0, everFades: false }
  const steps = Math.ceil(90 / FIXED_DT)
  for (let i = 0; i < steps && !mission.finished; i++) {
    const target = nextGate(mission.course.gates, mission.course.passed)
    const g = target >= 0 ? gates[target] : undefined
    if (g) {
      autopilotActions(
        jet.body,
        g.centre,
        input,
        undefined,
        [],
        Number.POSITIVE_INFINITY,
        gates[target + 1]?.centre ?? null,
      )
    }
    stepHoverJet(jet, input)
    const v = jet.body.velocity
    const levers: MissionLevers = {
      clearance: jet.body.position.y - floorY,
      speed: Math.hypot(v.x, v.y, v.z),
      struck: false,
      proximity: anniversary.gameplay.proximity,
      gateEvents: anniversary.gameplay.gateEvents,
    }
    const ring = stepMission(mission, lvl, jet.body.position, FIXED_DT, levers)
    if (ring >= 0) {
      chainGate(jet.chain)
      visibility.pass(ring, mission.elapsed)
      passedAtTick.set(ring, mission.elapsed)
    }
    // Exactly `game/rings.ts`'s update: stamp an exit for everything the sim
    // says the ship is not in, then read the scale.
    for (let k = 0; k < drawn; k++) {
      if (!mission.course.inside[k]) visibility.exit(k, mission.elapsed)
    }
    for (let k = 0; k < drawn; k++) {
      const at = passedAtTick.get(k)
      if (at === undefined) continue
      const scale = visibility.scaleAt(k, mission.elapsed, spec)
      if (mission.course.inside[k]) {
        out.ticksInside++
        out.worstInside = Math.min(out.worstInside, scale)
        out.longestDwell = Math.max(out.longestDwell, mission.elapsed - at)
      } else if (scale === 0) {
        out.everFades = true
      }
    }
  }
  return out
}

describe('flown: a gate you are still inside is a gate you can still see', () => {
  const anniversary = passedFadeSpec(edition('anniversary').gates.passedFade)

  for (const id of RING_COURSES) {
    it(`${id}: full size on every tick inside the sphere`, () => {
      const flown = flyAndWatch(id, anniversary)
      // A dead test would pass this vacuously, so say out loud that the ship
      // really did spend ticks inside gates it had scored.
      expect(flown.ticksInside, 'ticks spent inside a passed gate').toBeGreaterThan(20)
      expect(flown.worstInside, 'smallest gate scale seen from inside it').toBe(1)
      // And the gate really does go away afterwards — the other half of the
      // rule, and the half a `waitForExit` that never fires would break.
      expect(flown.everFades, 'some gate reached scale 0 after being left').toBe(true)
      // The backstop must not be the thing doing the work: if a crossing ever
      // gets longer than 2016's hold, this assertion is what says so, rather
      // than the gate quietly starting to shrink inside the sphere again.
      expect(flown.longestDwell, 'longest crossing').toBeLessThan(EXIT_BACKSTOP_SECONDS)
    })
  }

  it('and it was the ANCHOR: the same flight under the old pass-anchored rule shrinks inside', () => {
    // The red half, kept. This is the shipped Anniversary numbers with
    // `waitForExit` off — which is exactly the spec this build ran before
    // DEV-195 — flown down the same course, and the gate is part gone while the
    // ship is still in it.
    const old = { ...anniversary, waitForExit: false }
    const flown = flyAndWatch('int_01_hoverJet', old)
    expect(flown.ticksInside).toBeGreaterThan(20)
    expect(flown.worstInside).toBe(0)
  })
})
