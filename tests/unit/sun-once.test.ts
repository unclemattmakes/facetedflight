// tests/unit/sun-once.test.ts — one sun for the life of the page. DEV-363.
//
// `createSunShadows` and `createCockpitSelfShadow` are handed a light ONCE, at
// boot, and keep it. `applyLighting` used to build a new `DirectionalLight` on
// every course switch, so after the first switch both shadow systems cast from a
// light no longer in the scene and the mission's own sun cast nothing — every
// mission a player could reach, since the title became the boot world (DEV-281).
//
// The fix is structural: the boot builds ONE sun, in the shell that no teardown
// removes, and `applyLighting` only aims it. This guards the structure at the
// source, the way `shadows.test.ts` guards the scatter/landmark split, because
// reaching the real path needs two megapixel PNGs, a Worker and a GL context.
// The spec that asks the FRAME is `tests/e2e/sun-switch.spec.ts`.

import { describe, expect, it } from 'vitest'
import { appFileWith, appSourceThroughCtx, inOrder } from './helpers/app-source'

/**
 * The whole boot tree as text (APP-SPLIT phase 0): the counts and the bodies
 * below are true of the code wherever the split puts it. Order is not, so the
 * one ordering claim reads ONE file through `appFileWith` + `inOrder`.
 */
// Read through the split's `ctx.` plumbing (APP-SPLIT 4.7b moved the switch
// and 4 the atmosphere into modules that read these bindings through it).
const app = appSourceThroughCtx()

/** The body of a top-level `const name = (...) => { ... }`, by brace count. */
const bodyOf = (name: string): string => {
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

describe('one sun for the life of the page (DEV-363)', () => {
  it('the boot builds exactly one DirectionalLight, and it is createSun that builds it', () => {
    expect(app.match(/new THREE\.DirectionalLight\(/g)?.length).toBe(1)
    expect(bodyOf('createSun')).toContain('new THREE.DirectionalLight(')
  })

  it('applyLighting aims the light it is handed and builds none', () => {
    const body = bodyOf('applyLighting')
    expect(body).not.toContain('new THREE.DirectionalLight')
    // Nor adds a light to the scene: the one sun is already in it.
    expect(body).not.toMatch(/scene\.add\(\s*light/)
  })

  it('the sun is made BEFORE the shell is captured, so no teardown removes it', () => {
    const shellAnchor = 'const shellChildren = new Set(render.scene.children)'
    // Throws if either is missing, or if the sun is made only AFTER the shell.
    inOrder(appFileWith(shellAnchor).text, ['= createSun(render.scene)', shellAnchor])
  })

  it('every applyLighting call, and both shadow systems, take that one light', () => {
    const name = /const (\w+) = createSun\(render\.scene\)/.exec(app)?.[1]
    expect(name).toBeTruthy()
    // DEV-509: a fourth argument, the ambient source, follows the light.
    const calls = [...app.matchAll(/applyLighting\(render\.scene, level(?:, (\w+))?(?:, \w+)?\)/g)]
    expect(calls.length, 'the boot and the switch both light a level').toBeGreaterThanOrEqual(2)
    for (const call of calls) expect(call[1], call[0]).toBe(name)
    // APP-SPLIT 4: the call moved to `boot/app/atmosphere.ts`, where the longer
    // `ctx.` reads wrap it over lines; the arguments are the claim, not the layout.
    expect(app).toMatch(
      new RegExp(`createSunShadows\\(\\s*render\\.renderer,\\s*${name},\\s*editionState,?\\s*\\)`),
    )
    const self = app.slice(
      app.indexOf('createCockpitSelfShadow('),
      app.indexOf('createCockpitSelfShadow(') + 400,
    )
    expect(self, 'the cockpit near map is handed the same sun').toContain(`${name},`)
    expect(self).not.toContain('missionSun')
  })
})
