// tests/unit/haze-follows-fog.test.ts — the haze follows the mission fog across
// a course switch. DEV-552.
//
// `createUnityFog` builds its haze uniforms at zero, and `setHaze` is the only
// thing that ever writes them (`render/unity-fog.ts`). `boot/app.ts` called
// `attachEditionHaze` ONCE, on the boot fog, and `switchMission` then built a
// fresh fog that every material in the new world was fogged through — so the
// haze lived on whatever world boot built and was gone from every mission
// reached by a switch. Since DEV-281 the boot world is the title, which made
// that every mission a player could reach; every spec that boots `?mission=`
// is on the one path where the boot fog IS the mission's. DEV-363's sun, in a
// second system.
//
// Two halves, the way `tests/e2e/sun-switch.spec.ts` holds DEV-363:
//
//  1. **The behaviour of the pair**, with the real fog and a real edition
//     state: the unsubscribe `attachEditionHaze` returns really does stop the
//     old fog following, and the fog attached next carries the preset's
//     numbers — not zero — and follows a flip of the look.
//  2. **The structure of the app**, at the source, because reaching the real
//     path needs a world, a Worker and a GL context: a mission fog comes
//     through ONE door, and that door attaches the haze and detaches the last.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { attachEditionHaze, HAZE_OFF, hazePack } from '@/render/haze'
import { createUnityFog, type UnityFogParams } from '@/render/unity-fog'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { appFileWith, appSourceThroughCtx } from './helpers/app-source'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

const FOG_PARAMS: UnityFogParams = {
  mode: 2,
  density: 0.00025,
  linearStart: 0,
  linearEnd: 300,
  color: [0.867, 0.659, 0.698],
  distanceFog: true,
  heightFog: true,
  useRadialDistance: true,
  height: 500,
  heightDensity: 0.015,
  startDistance: 0,
}

/** `uHaze` as a plain array, off the fog's own uniform block. */
const uHaze = (fog: ReturnType<typeof createUnityFog>): number[] =>
  fog.uniforms.uHaze.value.toArray()

/** What `uHaze` reads with Anniversary's haze on: the preset's own numbers, packed. */
const ANNIVERSARY_HAZE = hazePack(ANNIVERSARY.render.haze)
const NO_HAZE = hazePack(HAZE_OFF)

describe('the pair: a fog that replaces another is hazed, and the old one is let go (DEV-552)', () => {
  it('the premise: Anniversary has the haze on, and a new fog is built with none', () => {
    // If either of these stops being true the rest of this file proves nothing.
    expect(ANNIVERSARY.render.haze.enabled).toBe(true)
    expect(ANNIVERSARY.render.haze.strength).toBeGreaterThan(0)
    expect(uHaze(createUnityFog(FOG_PARAMS))).toEqual(NO_HAZE)
  })

  it('detach the boot fog and attach the switch fog: the switch fog carries the haze and follows flips', () => {
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const boot = createUnityFog(FOG_PARAMS)
    const detach = attachEditionHaze(boot, state)
    expect(uHaze(boot)).toEqual(ANNIVERSARY_HAZE)

    // The switch, the way `wiredMissionFog` does it.
    detach()
    const next = createUnityFog(FOG_PARAMS)
    attachEditionHaze(next, state)
    expect(uHaze(next), 'the fog the new world is fogged through is hazed').toEqual(
      ANNIVERSARY_HAZE,
    )

    // A flip reaches the live fog, and only the live fog.
    state.setLook(CLASSIC)
    expect(uHaze(next), 'Classic turns the live fog off').toEqual(NO_HAZE)
    expect(uHaze(boot), 'the discarded fog no longer follows').toEqual(ANNIVERSARY_HAZE)
    state.setLook(ANNIVERSARY)
    expect(uHaze(next)).toEqual(ANNIVERSARY_HAZE)
  })

  it('the bug, as it was: a fog built beside an attached one draws no haze', () => {
    // Not a test of the fix — a statement of what a switch without the door
    // produces, so the row above is not passing for a reason that would also
    // pass without it.
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    attachEditionHaze(createUnityFog(FOG_PARAMS), state)
    const next = createUnityFog(FOG_PARAMS)
    state.setLook(ANNIVERSARY)
    expect(uHaze(next)).toEqual(NO_HAZE)
  })
})

/** The whole boot tree, for counts (APP-SPLIT phase 0); a body is read from ONE file. */
// Read through the split's `ctx.` plumbing (APP-SPLIT 4.7b moved the switch
// and 4 the atmosphere into modules that read these bindings through it).
const app = appSourceThroughCtx()

/** The body of a `const name = (...) => { ... }`, by brace count. */
const bodyOf = (name: string): string => {
  const app = appFileWith(`const ${name} = (`).text
  const at = app.indexOf(`const ${name} = (`)
  expect(at, `boot/app.ts has no ${name} — re-read this test`).toBeGreaterThan(-1)
  const open = app.indexOf('{', app.indexOf('=>', at))
  let depth = 0
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++
    else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

describe('the app: every mission fog comes through the one door that hazes it (DEV-552)', () => {
  const DOOR = 'wiredMissionFog'

  it('missionFog is called in exactly one place, and that place is the door', () => {
    const calls = [...app.matchAll(/\bmissionFog\(/g)]
    expect(calls.length, 'one call to missionFog in boot/app.ts').toBe(1)
    expect(bodyOf(DOOR)).toMatch(/\bmissionFog\(/)
  })

  it('the door detaches the last fog, then attaches the one it builds', () => {
    const body = bodyOf(DOOR)
    const detach = body.indexOf('detachFogHaze()')
    const build = body.search(/\bmissionFog\(/)
    const attach = body.indexOf('detachFogHaze = attachEditionHaze(')
    expect(detach, 'the door lets the previous fog go').toBeGreaterThan(-1)
    expect(attach, 'the door keeps the unsubscribe it is handed').toBeGreaterThan(-1)
    expect(detach).toBeLessThan(build)
    expect(build).toBeLessThan(attach)
  })

  it('nothing else attaches a haze, so no subscription is left behind', () => {
    expect([...app.matchAll(/\battachEditionHaze\(/g)].length).toBe(1)
  })

  it('every assignment to the mission fog — the boot and the switch — goes through the door', () => {
    const assigns = [...app.matchAll(/(?:\blet |[;{}\n]\s*)fog = ([\w.]+)\(/g)]
    expect(assigns.length, 'the boot and the switch both build a fog').toBeGreaterThanOrEqual(2)
    for (const a of assigns) expect(a[1], a[0].trim()).toBe(DOOR)
  })
})
