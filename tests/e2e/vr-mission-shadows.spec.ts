/**
 * tests/e2e/vr-mission-shadows.spec.ts: in a headset a MISSION draws no sun
 * shadow map, the terrain is still shadowed by the far-field term, and the
 * hangar keeps its key light's shadows. DEV-932, lever 2 of
 * `docs/plan/ANNIVERSARY-VR-FRAMERATE.md`. `tests/unit/vr-mission-shadows.test.ts`
 * holds the same rules on the presets; this reads what GL compiled.
 *
 * The headset is IWER (`fixtures/emulated-xr.ts`): the page takes its real
 * ENTER VR path, and `vr.disable` is applied by the game's own `sessionstart`.
 * Everything below is a read (`gl.getShaderSource`, `gl.getUniform`, flags on
 * objects); nothing in the game is told it is being watched.
 *
 * Mission arm (`rookie_01_hoverJet`, Anniversary, frozen at 20 s, `quality=high`
 * so the tier cannot drop the map for its own reason):
 *   flat     the land's program compiles `USE_SHADOWMAP` (positive control)
 *   headset  the renderer's shadow machinery is ON (the hangar needs it), no
 *            light in the mission casts, the land's program has no
 *            `USE_SHADOWMAP` and carries the far-field multiply with the term
 *            switched on (`uSunTopC.x` 1), and the cockpit's own map is off
 *
 * Hangar arm: in a headset the 2016 key light casts and its map exists.
 *
 * Tagged `@gpu`.
 */
import type { Page } from '@playwright/test'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import { flyToFreeze } from './fixtures/freeze'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, test } from './fixtures/test'

interface MissionRead {
  readonly presenting: boolean
  readonly machinery: boolean
  readonly castingLights: string[]
  readonly land: {
    readonly found: number
    readonly shadowMapDefine: boolean
    readonly farMultiply: boolean
    readonly sunTermOn: number | null
  }
  readonly cockpitSelfShadowOn: boolean | null
}

/** Read the mission's shadow state off the live page. Runs in the browser. */
const readMission = (page: Page): Promise<MissionRead> =>
  page.evaluate(() => {
    type Obj = {
      name: string
      visible: boolean
      isMesh?: boolean
      isDirectionalLight?: boolean
      castShadow?: boolean
      material?: { defines?: Record<string, unknown> }
      userData: Record<string, unknown>
      traverse: (f: (o: Obj) => void) => void
    }
    type Gl = WebGL2RenderingContext
    const ff = (
      globalThis as unknown as {
        __ff2: {
          render: {
            scene: Obj
            renderer: {
              xr: { isPresenting: boolean }
              shadowMap: { enabled: boolean }
              getContext: () => Gl
              properties: {
                get: (m: unknown) => { currentProgram?: { program: WebGLProgram } }
              }
            }
          }
        }
      }
    ).__ff2
    const { scene, renderer } = ff.render
    const gl = renderer.getContext()
    const castingLights: string[] = []
    const programs = new Set<WebGLProgram>()
    let cockpitSelfShadowOn: boolean | null = null
    scene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow) castingLights.push(o.name || '(unnamed)')
      if (o.name === 'ship_first_person') {
        const report = o.userData.cockpitSelfShadow as (() => { on: boolean }) | undefined
        if (report) cockpitSelfShadowOn = report().on
      }
      if (!o.isMesh || !o.visible) return
      if (o.material?.defines?.FF2_SUN_GROUND === undefined) return
      const program = renderer.properties.get(o.material).currentProgram?.program
      if (program) programs.add(program)
    })
    let shadowMapDefine = false
    let farMultiply = programs.size > 0
    let sunTermOn: number | null = null
    for (const program of programs) {
      for (const shader of gl.getAttachedShaders(program) ?? []) {
        if (gl.getShaderParameter(shader, gl.SHADER_TYPE) !== gl.FRAGMENT_SHADER) continue
        const source = gl.getShaderSource(shader) ?? ''
        if (source.includes('#define USE_SHADOWMAP')) shadowMapDefine = true
        if (!source.includes('directLight.color *= ff2SunHeightTerm();')) farMultiply = false
      }
      const at = gl.getUniformLocation(program, 'uSunTopC')
      const v = at === null ? null : (gl.getUniform(program, at) as Float32Array | null)
      if (v) sunTermOn = v[0] ?? null
    }
    return {
      presenting: renderer.xr.isPresenting,
      machinery: renderer.shadowMap.enabled,
      castingLights,
      land: { found: programs.size, shadowMapDefine, farMultiply, sunTermOn },
      cockpitSelfShadowOn,
    }
  })

test.describe('@gpu in a headset a mission has no sun map and the menus keep theirs (DEV-932)', () => {
  test.setTimeout(420_000)
  // 800 x 720 an eye: IWER sizes the canvas from the window.
  test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

  test('a mission: no map, the far-field term still on the land', async ({ page }) => {
    await installEmulatedXr(page, { fovyDeg: 90 })
    await flyToFreeze(page, {
      mission: 'rookie_01_hoverJet',
      edition: 'anniversary',
      snapAt: 20,
      params: { adaptive: '0', quality: 'high' },
      xrProbe: true,
    })
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
    const flat = await readMission(page)
    console.info(`VR-MISSION-SHADOWS flat ${JSON.stringify(flat)}`)
    // Positive control: flat, the land samples the sun's map and the sun casts.
    expect(flat.land.found, 'found the land’s program').toBeGreaterThan(0)
    expect(flat.land.shadowMapDefine, 'flat: the land samples the map').toBe(true)
    expect(flat.castingLights.length, 'flat: the sun casts').toBeGreaterThan(0)

    await enterVr(page)
    await expect
      .poll(async () => (await readMission(page)).presenting, { timeout: 60_000 })
      .toBe(true)
    // The flags move on `sessionstart`; the programs on the next draw. Wait for the land's.
    await expect
      .poll(async () => (await readMission(page)).land.shadowMapDefine, { timeout: 30_000 })
      .toBe(false)
    const vr = await readMission(page)
    console.info(`VR-MISSION-SHADOWS headset ${JSON.stringify(vr)}`)
    expect(vr.machinery, 'the machinery stays on, for the hangar’s key light').toBe(true)
    expect(vr.castingLights, 'no light in the mission casts').toEqual([])
    expect(vr.land.found, 'found the land’s program').toBeGreaterThan(0)
    expect(vr.land.shadowMapDefine, 'nothing on the land samples a map').toBe(false)
    expect(vr.land.farMultiply, 'the no-map branch multiplies the far-field term').toBe(true)
    expect(vr.land.sunTermOn, 'and the term is switched on').toBe(1)
    expect(vr.cockpitSelfShadowOn, 'the cockpit’s own map is off with it').toBe(false)
  })

  test('the hangar: the key light still casts', async ({ page }) => {
    await installEmulatedXr(page, { fovyDeg: 90 })
    await page.goto('/?title=0&adaptive=0&quality=high')
    await loadSettled(page, 240_000)
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
    await enterVr(page)
    const read = () =>
      page.evaluate(() => {
        type Obj = {
          name: string
          castShadow?: boolean
          shadow?: { map: unknown }
          traverse: (f: (o: Obj) => void) => void
        }
        const ff = (
          globalThis as unknown as {
            __ff2: {
              stage: () => Obj
              render: {
                renderer: { xr: { isPresenting: boolean }; shadowMap: { enabled: boolean } }
              }
            }
          }
        ).__ff2
        let key: Obj | null = null
        ff.stage().traverse((o) => {
          if (o.name === 'hangar-2016-key') key = o
        })
        const k = key as Obj | null
        return {
          presenting: ff.render.renderer.xr.isPresenting,
          machinery: ff.render.renderer.shadowMap.enabled,
          found: k !== null,
          casts: k?.castShadow === true,
          mapDrawn: k?.shadow?.map !== null && k?.shadow?.map !== undefined,
        }
      })
    await expect.poll(async () => (await read()).presenting, { timeout: 60_000 }).toBe(true)
    await expect.poll(async () => (await read()).mapDrawn, { timeout: 30_000 }).toBe(true)
    const r = await read()
    console.info(`VR-MISSION-SHADOWS hangar ${JSON.stringify(r)}`)
    expect(r.found, 'the room’s key light is in the stage').toBe(true)
    expect(r.machinery, 'the renderer’s shadow machinery is on').toBe(true)
    expect(r.casts, 'the 2016 key light casts in a headset').toBe(true)
    expect(r.mapDrawn, 'and its map has been drawn').toBe(true)
  })
})
