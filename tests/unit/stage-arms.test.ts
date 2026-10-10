/**
 * tests/unit/stage-arms.test.ts — DEV-226's arm planner, and the one rule that
 * decides whether the additive table means anything.
 *
 * ── The bug this exists to make impossible ───────────────────────────────
 *
 * `WebGLRenderer.projectObject` returns early on `visible === false` **before**
 * it pushes a light. So a solo that hid the sun along with everything else
 * would draw its group UNLIT: a different program, a different fragment cost,
 * and a number that cannot be compared with any row in the subtractive table.
 *
 * It would not look wrong. `world-ocean` soloed without the sun is still an
 * ocean-shaped number, smaller than the lit one, and it would sit in the table
 * being read as *"the ocean is cheaper than the hide said"* — which is the
 * exact conclusion the two directions exist to test.
 *
 * The planner is built so it **cannot** name a light: `StageKeys` keeps
 * `drawable` and `lights` apart and every planner works over `drawable` alone.
 * This file is the proof of that, plus the tree rules — hiding a parent covers
 * its children, and soloing a child must not hide its parent.
 *
 * The runtime half is in `xr-vrto3d-trace.spec.ts`, which counts the lights
 * three would gather before and after the arm and refuses a run where the
 * number moved. Both halves, because this one cannot see a spec that forgets to
 * use the planner, and that one cannot run without a headset.
 */
import { describe, expect, it } from 'vitest'
import {
  armPlan,
  hidePlan,
  isAncestorKey,
  rootKeys,
  type StageKeys,
  soloPlan,
} from '../e2e/fixtures/stage-arms'

/** simonet at 20 s, as `perf-out/census-all/adv_02_jumpSeat-...json` rows it. */
const SIMONET: StageKeys = {
  drawable: [
    'world-terrain',
    'world-terrain/chunks',
    'world-terrain/props:simonet',
    'world-terrain/dressing:simonet',
    'world-ocean',
    'sky-dome',
    'clouds',
    'horizon-geo',
    'rings',
    'jumpseat',
    'pads',
    'turn-indicators',
    'particle-fx',
    'motes',
  ],
  lights: ['sun', 'ambient'],
}

describe('a light is never an arm’s to hide', () => {
  it('cannot be named by the empty stage, which hides everything else', () => {
    const plan = hidePlan(SIMONET, ['*'])
    for (const light of SIMONET.lights) expect(plan.hide).not.toContain(light)
    // ...and the empty stage really does hide the drawable world, so this is
    // not passing because the plan is empty.
    expect(plan.hide).toContain('world-terrain')
    expect(plan.hide).toContain('world-ocean')
    expect(plan.hide).toContain('sky-dome')
  })

  it('cannot be named by a solo, which hides everything but one group', () => {
    const plan = soloPlan(SIMONET, ['world-ocean'])
    for (const light of SIMONET.lights) expect(plan.hide).not.toContain(light)
    expect(plan.hide).toContain('sky-dome')
  })

  it('cannot be hidden by asking for it directly — it is MISSING, not hidden', () => {
    // The failure mode this closes is a quiet one: a `hide` that silently did
    // nothing would print a row saying the sun costs nothing.
    const plan = hidePlan(SIMONET, ['sun'])
    expect(plan.hide).toEqual([])
    expect(plan.missing).toEqual(['sun'])
  })

  it('cannot be SOLOED either — that would be an empty stage wearing a result', () => {
    const plan = soloPlan(SIMONET, ['sun'])
    expect(plan.missing).toEqual(['sun'])
    expect(plan.hide).toEqual([])
  })
})

describe('the keys are a tree', () => {
  it('reduces a hide to its roots, so a parent is not counted twice', () => {
    expect(rootKeys(['world-terrain', 'world-terrain/chunks', 'sky-dome'])).toEqual([
      'world-terrain',
      'sky-dome',
    ])
  })

  it('knows an ancestor from a look-alike prefix', () => {
    expect(isAncestorKey('world-terrain', 'world-terrain/chunks')).toBe(true)
    // `world-ocean` is not an ancestor of `world-oceanography`, and a bare
    // `startsWith` would say it was.
    expect(isAncestorKey('world-ocean', 'world-oceanography')).toBe(false)
    expect(isAncestorKey('world-terrain/chunks', 'world-terrain')).toBe(false)
  })

  it('hides the whole land with one key, so streamed chunks go with it', () => {
    const plan = hidePlan(SIMONET, ['world-terrain'])
    expect(plan.hide).toEqual(['world-terrain'])
  })

  it('soloing a CHILD leaves its parent alone, or the arm hides itself', () => {
    const plan = soloPlan(SIMONET, ['world-terrain/chunks'])
    // The parent must survive: hiding it would take the chunks with it and the
    // arm would report the empty stage's number while looking like a result.
    expect(plan.hide).not.toContain('world-terrain')
    // Its siblings must not.
    expect(plan.hide).toContain('world-terrain/props:simonet')
    expect(plan.hide).toContain('world-terrain/dressing:simonet')
    expect(plan.hide).toContain('sky-dome')
    expect(plan.hide).not.toContain('world-terrain/chunks')
  })

  it('soloing a PARENT keeps its children, which are covered by it', () => {
    const plan = soloPlan(SIMONET, ['world-terrain'])
    expect(plan.hide).not.toContain('world-terrain')
    expect(plan.hide).not.toContain('world-terrain/chunks')
    expect(plan.hide).not.toContain('world-terrain/props:simonet')
    expect(plan.hide).toContain('world-ocean')
  })
})

describe('a name that matches nothing is MISSING, never a quiet no-op', () => {
  it('reports an unknown hide', () => {
    expect(hidePlan(SIMONET, ['no-such-group']).missing).toEqual(['no-such-group'])
  })

  it('reports an unknown solo and plans nothing at all', () => {
    // Half-applying a solo whose target does not exist would leave an empty
    // stage carrying that arm's name — a result-shaped non-result.
    const plan = soloPlan(SIMONET, ['world-lagoon'])
    expect(plan.missing).toEqual(['world-lagoon'])
    expect(plan.hide).toEqual([])
  })
})

describe('armPlan', () => {
  it('is null for an arm that touches no group — a flag arm, or the baseline', () => {
    expect(armPlan(SIMONET, {})).toBeNull()
    expect(armPlan(SIMONET, { hide: [] })).toBeNull()
  })

  it('prefers the solo when an arm somehow carries both', () => {
    // It should never carry both — `floor-sweep.mjs`'s own test refuses one —
    // but the planner has to be decidable rather than depend on key order.
    const plan = armPlan(SIMONET, { hide: ['sky-dome'], solo: ['world-ocean'] })
    expect(plan?.hide).toContain('sky-dome')
    expect(plan?.hide).not.toContain('world-ocean')
  })

  it('an empty stage and a solo of everything are not the same plan', () => {
    const empty = armPlan(SIMONET, { hide: ['*'] })
    const ocean = armPlan(SIMONET, { solo: ['world-ocean'] })
    expect(empty?.hide).toContain('world-ocean')
    expect(ocean?.hide).not.toContain('world-ocean')
    // The solo hides one fewer root than the empty stage: its own.
    expect(ocean?.hide.length).toBe((empty?.hide.length ?? 0) - 1)
  })
})
