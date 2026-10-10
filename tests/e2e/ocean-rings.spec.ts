/**
 * tests/e2e/ocean-rings.spec.ts: DEV-339. The sea as camera-centred rings, on a
 * real GPU, against the plate it replaces.
 *
 *   E2E_PORT=<yours> PHOTO_DIR=perf-out/dev339 \
 *     pnpm exec playwright test tests/e2e/ocean-rings.spec.ts --workers 1 --retries 0
 *
 * What `tests/unit/ocean-ring-lattice.test.ts` and `ocean-rings.test.ts` cannot
 * say: that the GLSL does what its TypeScript twin does. Three checks, each of
 * which a wrong corner, a wrong diagonal, a wrong lattice index or a wrong
 * hole would fail loudly:
 *
 *  1. **The near field is the plate's.** Level 0 of the rings is the plate's
 *     LOD 0 at the same 8 x 8 split, vertex for vertex, so a frame looking
 *     down on the water inside level 0's window, drawn at ONE wave time by
 *     both seas through the same shaders, must be the same picture. Rendered
 *     synchronously twice in one task (the sea's clock is render time and
 *     `?snap=` does not freeze it), so there is no bracket and no noise
 *     floor: the only difference is the geometry.
 *  2. **No cracks.** Everything but the sea is hidden, the clear colour is
 *     magenta, the eye looks down from heights that put every ring boundary
 *     in view at many positions and headings, and not one magenta pixel may
 *     appear. A hole in a window, a T-junction between levels and a collapsed
 *     cell that should have drawn all show as magenta.
 *  3. **Every program links** with the rings on (`fixtures/shader-link.ts`),
 *     and the counts say which sea drew: triangles and draw calls of the
 *     frame, the handle's `on`, never a belief.
 *
 * `int_02_hoverJet` is alpine and has no ocean: the negative control, where the
 * handle must be null (an arm that cannot find a sea must not report one).
 *
 * Tagged `@gpu`, `?xr=off`, quality pinned (`fixtures/quality-pin.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { PINNED } from './fixtures/quality-pin'
import { describeFailedProgram, sweepPrograms, watchShaderConsole } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.PHOTO_DIR ?? 'perf-out/dev339'
const EDITION = process.env.PHOTO_EDITION ?? 'anniversary'

const MISSIONS = [
  { id: 'int_01_hoverJet', hasOcean: true, why: 'the release mission, simonet' },
  { id: 'adv_02_jumpSeat', hasOcean: true, why: 'the gate queue mission, simonet' },
  { id: 'hoverJet_kauai_beg', hasOcean: true, why: 'kauai: the water under a levelOffset parent' },
  { id: 'int_02_hoverJet', hasOcean: false, why: 'alpine, no ocean: the negative control' },
] as const

type Vec = readonly [number, number, number]

interface Handle {
  wanted: boolean
  on: boolean
  reason: string | null
  triangles: number
  submitted: number
  cellMetres: readonly number[]
  bytes: number
}

const handle = (page: Page, on?: boolean, normals?: 'derived' | 'face'): Promise<Handle | null> =>
  page.evaluate(
    async ([want, mode]) => {
      const w = globalThis as unknown as {
        __ff2?: { oceanRings?: (on?: boolean, normals?: string) => Promise<Handle | null> }
      }
      return (
        (await w.__ff2?.oceanRings?.(
          want as boolean | undefined,
          mode as 'derived' | 'face' | undefined,
        )) ?? null
      )
    },
    [on, normals] as const,
  )

interface Shot {
  /** A data URL. */
  readonly png: string
  readonly calls: number
  readonly triangles: number
}

/**
 * Render the world ONCE, synchronously, with the chosen sea, at a fixed wave
 * time, from `eye` toward `look`, and read the canvas back in the same task.
 *
 * `only` hides everything but the sea and clears to magenta: the crack scan.
 */
const shoot = (
  page: Page,
  arm: 'plate' | 'rings' | 'face',
  eye: Vec,
  look: Vec,
  only: boolean,
): Promise<Shot> =>
  page.evaluate(
    async ([armName, e, l, onlySea]) => {
      interface Node {
        visible: boolean
        isLight?: boolean
        name: string
        children: Node[]
      }
      interface Sea {
        rings: { set: (on: boolean) => Promise<unknown>; setNormals: (m: string) => void }
        water: { setTime: (s: number) => void }
        updateLod: (x: number, z: number, dt: number) => number
        group: Node
      }
      const w = globalThis as unknown as {
        __ff2: {
          terrain: () => { ocean: Sea | null } | null
          render: {
            scene: Node
            camera: {
              far: number
              updateProjectionMatrix: () => void
              position: { set: (x: number, y: number, z: number) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: (f?: boolean) => void
            }
            renderer: {
              render: (s: unknown, c: unknown) => void
              setRenderTarget: (t: null) => void
              setClearColor: (c: number, a: number) => void
              getClearAlpha: () => number
              domElement: HTMLCanvasElement
              info: { render: { calls: number; triangles: number } }
            }
          }
        }
      }
      const ff2 = w.__ff2
      const sea = ff2.terrain()?.ocean
      if (!sea) throw new Error('ocean-rings: no sea in this world')
      const r = ff2.render
      const eyeV = e as readonly number[]
      const lookV = l as readonly number[]
      r.camera.position.set(eyeV[0] as number, eyeV[1] as number, eyeV[2] as number)
      r.camera.lookAt(lookV[0] as number, lookV[1] as number, lookV[2] as number)
      r.camera.updateMatrixWorld(true)
      // Awaited, but the plate and the rings are both BUILT by now: the body runs
      // to its end without yielding, so no frame of the app's own can intervene.
      await sea.rings.set(armName !== 'plate')
      if (armName !== 'plate') sea.rings.setNormals(armName === 'face' ? 'face' : 'derived')
      sea.updateLod(eyeV[0] as number, eyeV[2] as number, 0)
      sea.water.setTime(7.25)
      const hidden: Node[] = []
      let farWas = 0
      // The clear colour is not restored exactly (reading it needs a THREE.Color this
      // page-side code cannot construct): the next shot of this test overwrites it.
      const priorAlpha = r.renderer.getClearAlpha()
      if (onlySea) {
        for (const c of r.scene.children) {
          if (c === sea.group || c.isLight || !c.visible) continue
          c.visible = false
          hidden.push(c)
        }
        r.renderer.setClearColor(0xff00ff, 1)
        // The game's far plane is 6 km, so a ray's far end is clipped to the clear
        // colour on a high shot: that is not a hole in the sea. See the call site.
        farWas = r.camera.far
        r.camera.far = 40000
        r.camera.updateProjectionMatrix()
      }
      r.renderer.setRenderTarget(null)
      r.renderer.render(r.scene, r.camera)
      const png = r.renderer.domElement.toDataURL('image/png')
      const calls = r.renderer.info.render.calls
      const triangles = r.renderer.info.render.triangles
      for (const c of hidden) c.visible = true
      if (onlySea) {
        r.renderer.setClearColor(0x000000, priorAlpha)
        r.camera.far = farWas
        r.camera.updateProjectionMatrix()
      }
      return { png, calls, triangles }
    },
    [arm, eye, look, only] as const,
  )

/** Put the camera at the stand and let the app's own frames catch the eye-dependent uniforms up. */
const aim = async (page: Page, eye: Vec, look: Vec): Promise<void> => {
  await page.evaluate(
    ([e, l]) => {
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            camera: {
              position: { set: (x: number, y: number, z: number) => void }
              lookAt: (x: number, y: number, z: number) => void
              updateMatrixWorld: (f?: boolean) => void
            }
          }
        }
      }
      const c = w.__ff2.render.camera
      const ev = e as readonly number[]
      const lv = l as readonly number[]
      c.position.set(ev[0] as number, ev[1] as number, ev[2] as number)
      c.lookAt(lv[0] as number, lv[1] as number, lv[2] as number)
      c.updateMatrixWorld(true)
    },
    [eye, look] as const,
  )
  await page.waitForTimeout(700)
}

const decode = (url: string): ReturnType<typeof decodePng> =>
  decodePng(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))

/** The sea's rest surface, world y: the plate's origin plus its tallest height. */
const seaLevel = (page: Page): Promise<{ y: number; cx: number; cz: number }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        terrain: () => {
          terrain: { group: { position: { x: number; z: number }; scale: { x: number } } }
          ocean: {
            heightField: {
              originY: number
              originX: number
              originZ: number
              scaleX: number
              scaleY: number
              terrainSize: number
              terrainHeight: number
              heights: Float32Array
            }
            group: { position: { x: number; y: number; z: number }; scale: { x: number } }
          } | null
        } | null
      }
    }
    const world = w.__ff2.terrain()
    const o = world?.ocean
    if (!world || !o) throw new Error('no sea')
    const f = o.heightField
    let sum = 0
    let n = 0
    for (let i = 0; i < f.heights.length; i += 997) {
      sum += f.heights[i] as number
      n++
    }
    // The group's own y is the plate's transform (the bob is a few metres); the
    // surface is that plus the mean height in mesh units.
    return {
      y: o.group.position.y + (sum / n) * f.terrainHeight,
      cx: world.terrain.group.position.x + (world.terrain.group.scale.x * 4096) / 2,
      cz: world.terrain.group.position.z - (world.terrain.group.scale.x * 4096) / 2,
    }
  })

/** The magenta mask of a sea-only shot, as pixel indices. */
const magentaMask = (url: string): { w: number; h: number; hit: Set<number> } => {
  const img = decode(url)
  const hit = new Set<number>()
  for (let q = 0; q < img.w * img.h; q++) {
    const r = img.data[q * img.ch] as number
    const g = img.data[q * img.ch + 1] as number
    const b = img.data[q * img.ch + 2] as number
    if (r > 200 && g < 70 && b > 200) hit.add(q)
  }
  return { w: img.w, h: img.h, hit }
}

/** Pixels magenta in `a` and not in `b`, and the first three of them. */
const magentaOnlyIn = (
  a: { w: number; hit: Set<number> },
  b: { hit: Set<number> },
): { count: number; where: string[] } => {
  const where: string[] = []
  let count = 0
  for (const q of a.hit) {
    if (b.hit.has(q)) continue
    count++
    if (where.length < 3) where.push(`(${q % a.w},${Math.floor(q / a.w)})`)
  }
  return { count, where }
}

/** A deterministic stream in [0, 1), so a failure names a reproducible eye. */
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Pitch (radians below the horizon) and heading to a look-at point `dist` away. */
const lookFrom = (eye: Vec, pitch: number, heading: number, dist = 1000): Vec => [
  eye[0] + Math.sin(heading) * Math.cos(pitch) * dist,
  eye[1] - Math.sin(pitch) * dist,
  eye[2] + Math.cos(heading) * Math.cos(pitch) * dist,
]

/** The sun's bearing off the live directional light, as draw-order-pixels does. */
const sunBearing = (page: Page): Promise<[number, number]> =>
  page.evaluate(() => {
    interface N {
      isDirectionalLight?: boolean
      position?: { x: number; z: number }
      traverse: (f: (o: N) => void) => void
    }
    const w = globalThis as unknown as { __ff2: { render: { scene: N } } }
    let out: [number, number] = [1, 0]
    let found = false
    w.__ff2.render.scene.traverse((o) => {
      if (found || o.isDirectionalLight !== true || !o.position) return
      found = true
      const l = Math.hypot(o.position.x, o.position.z) || 1
      out = [o.position.x / l, o.position.z / l]
    })
    return out
  })

test.describe('@measure @gpu DEV-339: the photographs', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS.filter((m) => m.hasOcean)) {
    test(`${mission.id}: plate, rings, rings + face`, async ({ page }) => {
      const problems = watchPageErrors(page)
      fs.mkdirSync(OUT, { recursive: true })
      await page.goto(
        `/?xr=off&ride=0&mission=${mission.id}&edition=${EDITION}&view=cam&${PINNED}` +
          '&eye=0,4000,0&look=200,0,200',
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await page.waitForTimeout(6_000)
      const before = await handle(page)
      if (before?.on) await handle(page, false)
      await handle(page, true, 'face')
      await page.waitForTimeout(2_000)
      const sea = await seaLevel(page)
      const [sx, sz] = await sunBearing(page)
      const stands: { name: string; eye: Vec; look: Vec }[] = [
        {
          name: 'over-land',
          eye: [sea.cx + 1700, sea.y + 900, sea.cz + 1700],
          look: [sea.cx - 600, sea.y + 40, sea.cz - 600],
        },
        {
          name: 'horizon',
          eye: [sea.cx, sea.y + 700, sea.cz],
          look: [sea.cx + sx * 20000, sea.y + 700, sea.cz + sz * 20000],
        },
        {
          name: 'low-sun',
          eye: [sea.cx - sx * 1800, sea.y + 90, sea.cz - sz * 1800],
          look: [sea.cx + sx * 5000, sea.y + 130, sea.cz + sz * 5000],
        },
        {
          name: 'down',
          eye: [sea.cx + 400, sea.y + 450, sea.cz - 300],
          look: lookFrom([sea.cx + 400, sea.y + 450, sea.cz - 300], (50 * Math.PI) / 180, 1.1),
        },
      ]
      for (const stand of stands) {
        await handle(page, false)
        await aim(page, stand.eye, stand.look)
        await page.waitForTimeout(2_500)
        const arms = ['plate', 'rings', 'face'] as const
        const shots: Record<string, ReturnType<typeof decode>> = {}
        for (const arm of arms) {
          const shot = await shoot(page, arm, stand.eye, stand.look, false)
          fs.writeFileSync(
            path.join(OUT, `${mission.id}-${stand.name}-${arm}.png`),
            Buffer.from(shot.png.split(',')[1] as string, 'base64'),
          )
          shots[arm] = decode(shot.png)
          console.info(
            `  ${mission.id} ${stand.name} ${arm}: ${shot.triangles.toLocaleString('en-US')} tris / ${shot.calls} calls`,
          )
        }
        const diff = (a: ReturnType<typeof decode>, b: ReturnType<typeof decode>): string => {
          let moved = 0
          let sum = 0
          const n = a.w * a.h
          for (let p2 = 0; p2 < n; p2++) {
            let d = 0
            for (let k = 0; k < 3; k++) {
              d = Math.max(
                d,
                Math.abs((a.data[p2 * a.ch + k] as number) - (b.data[p2 * b.ch + k] as number)),
              )
            }
            sum += d
            if (d > 24) moved++
          }
          return `mean ${(sum / n).toFixed(2)} levels, ${((100 * moved) / n).toFixed(2)} % of pixels over 24`
        }
        console.info(
          `  ${mission.id} ${stand.name}: plate vs rings: ${diff(shots.plate as never, shots.rings as never)} | rings vs face: ${diff(shots.rings as never, shots.face as never)}`,
        )
      }
      expect(problems.list(), 'page errors').toEqual([])
    })
  }
})

/**
 * DEV-583's mirror: the ultra tier reads a mirrored render of the scene at the
 * sea's own screen position. The rings recompute the mirror's clip position for
 * the vertices their snap moved, so this is the picture that says it still lines
 * up: the same stand, plate against rings, at quality ultra.
 */
test.describe('@measure @gpu DEV-339: the mirror', () => {
  test.setTimeout(900_000)

  test("int_01_hoverJet at ultra: the mirror under the rings is the plate's", async ({ page }) => {
    const problems = watchPageErrors(page)
    const ledger = watchShaderConsole(page)
    fs.mkdirSync(OUT, { recursive: true })
    await page.goto(
      `/?xr=off&ride=0&mission=int_01_hoverJet&edition=${EDITION}&view=cam&${PINNED.replace('quality=high', 'quality=ultra')}` +
        '&eye=0,4000,0&look=200,0,200',
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await page.waitForTimeout(6_000)
    const before = await handle(page)
    if (before?.on) await handle(page, false)
    await handle(page, true)
    await page.waitForTimeout(2_000)
    const sea = await seaLevel(page)
    const [sx, sz] = await sunBearing(page)
    const stands: { name: string; eye: Vec; look: Vec }[] = [
      {
        name: 'low-sun',
        eye: [sea.cx - sx * 1800, sea.y + 90, sea.cz - sz * 1800],
        look: [sea.cx + sx * 5000, sea.y + 130, sea.cz + sz * 5000],
      },
      {
        name: 'over-land',
        eye: [sea.cx + 1700, sea.y + 900, sea.cz + 1700],
        look: [sea.cx - 600, sea.y + 40, sea.cz - 600],
      },
    ]
    for (const stand of stands) {
      await handle(page, false)
      await aim(page, stand.eye, stand.look)
      await page.waitForTimeout(2_500)
      const a = await shoot(page, 'plate', stand.eye, stand.look, false)
      const b = await shoot(page, 'rings', stand.eye, stand.look, false)
      for (const [arm, shot] of [
        ['plate', a],
        ['rings', b],
      ] as const) {
        fs.writeFileSync(
          path.join(OUT, `int_01_hoverJet-ultra-${stand.name}-${arm}.png`),
          Buffer.from(shot.png.split(',')[1] as string, 'base64'),
        )
      }
      const x = decode(a.png)
      const y = decode(b.png)
      let moved = 0
      let sum = 0
      for (let q = 0; q < x.w * x.h; q++) {
        let d = 0
        for (let k = 0; k < 3; k++) {
          d = Math.max(
            d,
            Math.abs((x.data[q * x.ch + k] as number) - (y.data[q * y.ch + k] as number)),
          )
        }
        sum += d
        if (d > 24) moved++
      }
      console.info(
        `  ultra ${stand.name}: plate ${a.triangles.toLocaleString('en-US')} tris, rings ${b.triangles.toLocaleString('en-US')} tris, mean ${(sum / (x.w * x.h)).toFixed(2)} levels, ${((100 * moved) / (x.w * x.h)).toFixed(2)} % of pixels over 24`,
      )
      // The mirror is the same scene at the same plane: the two seas agree as they
      // do without it (run 3: 0.2 to 4 % of pixels over 24 across stands).
      expect(moved / (x.w * x.h), `ultra ${stand.name}`).toBeLessThan(0.1)
    }
    expect(
      ledger.lines().filter((l) => l.kind === 'link-failure'),
      'console shader errors at ultra',
    ).toEqual([])
    expect(problems.list(), 'page errors').toEqual([])
  })
})

test.describe('@measure @gpu DEV-339: the ocean rings', () => {
  test.setTimeout(900_000)

  for (const mission of MISSIONS) {
    test(`${mission.id}: ${mission.why}`, async ({ page }, testInfo) => {
      const problems = watchPageErrors(page)
      const ledger = watchShaderConsole(page)
      fs.mkdirSync(OUT, { recursive: true })
      await page.goto(
        `/?xr=off&ride=0&mission=${mission.id}&edition=${EDITION}&view=cam&${PINNED}` +
          '&eye=0,4000,0&look=200,0,200',
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await page.waitForTimeout(6_000)

      const before = await handle(page)
      if (!mission.hasOcean) {
        expect(before, 'a world with no sea must not report rings').toBeNull()
        expect(problems.list()).toEqual([])
        return
      }
      expect(before, 'the sea has no rings handle').not.toBeNull()
      // The preset may ship the rings on (the proposed default): then the plate is
      // built here, on demand, so the plate arm below has something to draw.
      console.info(`  preset: rings wanted ${before?.wanted}, on at load ${before?.on}`)
      if (before?.on) await handle(page, false)
      const plate = (await handle(page)) as Handle
      expect(plate.on).toBe(false)
      expect(plate.triangles, 'the plate draws something').toBeGreaterThan(10_000)

      // Build the rings (the first call is a build), let a few frames pass.
      const rings = (await handle(page, true)) as Handle
      await page.waitForTimeout(2_000)
      console.info(
        `\n  ${mission.id}: plate ${plate.triangles.toLocaleString('en-US')} triangles -> ` +
          `rings ${rings.triangles.toLocaleString('en-US')} live of ${rings.submitted.toLocaleString('en-US')} ` +
          `submitted, cells ${rings.cellMetres.join('/')} m, ${(rings.bytes / 1048576).toFixed(1)} MB`,
      )
      expect(rings.reason, 'the rings were refused').toBeNull()
      expect(rings.on).toBe(true)
      expect(rings.submitted).toBe(rings.cellMetres.length * 64 * 64 * 2)
      expect(rings.cellMetres, 'the preset ladder').toEqual([32, 64, 128, 256, 512])
      expect(rings.triangles, 'live is fewer than submitted').toBeLessThan(rings.submitted)

      // DEV-340: the face-normal variant, built outside the shots, and linking.
      const faced = (await handle(page, true, 'face')) as Handle & { normals?: string }
      expect(faced.normals, 'the face arm did not fire').toBe('face')
      await page.waitForTimeout(2_000)
      const sweepFace = await sweepPrograms(page)
      expect(
        sweepFace.failed.map(describeFailedProgram),
        'face programs that did not link',
      ).toEqual([])
      expect(
        ledger.lines().filter((l) => l.kind === 'link-failure'),
        'console shader errors with the face normal',
      ).toEqual([])
      await handle(page, true, 'derived')

      // 3. every program links with the rings drawing.
      const sweep = await sweepPrograms(page)
      expect(sweep.calls, 'the frame drew nothing').toBeGreaterThan(0)
      expect(sweep.programs).toBeGreaterThan(0)
      expect(sweep.checkShaderErrors).toBe(true)
      expect(sweep.failed.map(describeFailedProgram), 'programs that did not link').toEqual([])
      expect(
        ledger.lines().filter((l) => l.kind === 'link-failure'),
        'console shader errors',
      ).toEqual([])

      const sea = await seaLevel(page)
      console.info(
        `  sea level ${sea.y.toFixed(1)} m, plate centre ${sea.cx.toFixed(0)}, ${sea.cz.toFixed(0)}`,
      )

      // 1. the near field IS the plate's. Looking down from 450 m, 50 degrees
      // below the horizon: the bottom 55 % of the frame is inside 600 m.
      const rnd = lcg(339)
      const failures: string[] = []
      const nearShares: number[] = []
      for (let i = 0; i < 6; i++) {
        const eye: Vec = [sea.cx + (rnd() - 0.5) * 2400, sea.y + 450, sea.cz + (rnd() - 0.5) * 2400]
        const look = lookFrom(eye, (50 * Math.PI) / 180, rnd() * Math.PI * 2)
        // The plate streams its LOD only while it is the sea that draws (with the
        // rings on, `updateLod` follows the eye instead), so put it on, aim, and
        // let it settle at THIS eye before it is photographed.
        await handle(page, false)
        await aim(page, eye, look)
        for (let t = 0; t < 12; t++) {
          await page.waitForTimeout(1_000)
          const busy = await page.evaluate(() => {
            const w = globalThis as unknown as {
              __ff2: {
                terrain: () => { ocean: { fadingChunks: number; pending: number } | null } | null
              }
            }
            const o = w.__ff2.terrain()?.ocean
            return (o?.fadingChunks ?? 0) + (o?.pending ?? 0)
          })
          if (t >= 2 && busy === 0) break
        }
        const plateState = await page.evaluate(() => {
          const w = globalThis as unknown as {
            __ff2: {
              terrain: () => {
                ocean: {
                  lodLive: Record<number, number>
                  fadingChunks: number
                  pending: number
                } | null
              } | null
            }
          }
          const o = w.__ff2.terrain()?.ocean
          return {
            lods: o?.lodLive ?? {},
            fading: o?.fadingChunks ?? 0,
            pending: o?.pending ?? 0,
          }
        })
        const lods = plateState.lods
        // Comparable where the plate is settled and no chunk is at LOD 1 or 2 (a far
        // LOD 3 chunk is kilometres away and not in the lower frame).
        const plateAtLod0 =
          plateState.fading === 0 &&
          plateState.pending === 0 &&
          lods[1] === undefined &&
          lods[2] === undefined &&
          lods[-1] === undefined
        const a = await shoot(page, 'plate', eye, look, false)
        const b = await shoot(page, 'rings', eye, look, false)
        fs.writeFileSync(
          path.join(OUT, `${mission.id}-near${i}-plate.png`),
          Buffer.from(a.png.split(',')[1] as string, 'base64'),
        )
        fs.writeFileSync(
          path.join(OUT, `${mission.id}-near${i}-rings.png`),
          Buffer.from(b.png.split(',')[1] as string, 'base64'),
        )
        const x = decode(a.png)
        const y = decode(b.png)
        expect(x.w).toBe(y.w)
        expect(x.h).toBe(y.h)
        // Like with like: two rasterisations of one surface differ by a sub-pixel at
        // facet edges (the vertex arithmetic is float32 in two code paths), and a
        // glint pixel flips on it. A pixel agrees when the other frame has the same
        // colour at it or at a neighbour (and the neighbour agrees back), so only a
        // different FACET (a seam, an unsettled plate, another vertex) counts.
        const near = (u: typeof x, v: typeof y, pu: number, pv: number): boolean => {
          for (let k = 0; k < 3; k++) {
            if (
              Math.abs((u.data[pu * u.ch + k] as number) - (v.data[pv * v.ch + k] as number)) > 3
            ) {
              return false
            }
          }
          return true
        }
        let same = 0
        let total = 0
        for (let row = Math.floor(x.h * 0.45); row < x.h - 1; row++) {
          for (let col = 1; col < x.w - 1; col++) {
            const q = row * x.w + col
            total++
            let ok = false
            for (let dy = -1; dy <= 1 && !ok; dy++) {
              for (let dx = -1; dx <= 1 && !ok; dx++) {
                const r = q + dy * x.w + dx
                ok = near(x, y, q, r) && near(y, x, q, r)
              }
            }
            if (ok) same++
          }
        }
        const share = same / total
        if (plateAtLod0) nearShares.push(share)
        else
          console.info(
            `  near ${i}: plate LODs ${JSON.stringify(lods)}: not at LOD 0 everywhere, left out`,
          )
        console.info(
          `  near ${i}: eye ${eye.map((n) => n.toFixed(0)).join(',')} ` +
            `plate ${a.triangles.toLocaleString('en-US')} tris / ${a.calls} calls, ` +
            `rings ${b.triangles.toLocaleString('en-US')} tris / ${b.calls} calls, ` +
            `${(100 * share).toFixed(2)} % of the near field identical`,
        )
      }
      if (nearShares.length < 2) {
        failures.push(`only ${nearShares.length} near-field eyes had the plate at LOD 0 everywhere`)
      }
      if (Math.min(...nearShares) <= 0.98) {
        failures.push(
          `level 0 of the rings must draw the plate LOD 0 picture inside its window: shares ${nearShares.map((n) => n.toFixed(4)).join(', ')}`,
        )
      }

      // DEV-340: the face normal against the derived one, same geometry, same
      // wave time. They agree on the inside of every facet and may differ on the
      // pixels at facet edges (where the derivative straddles two faces: that is
      // the speckle DEV-050 repaired and the face normal removes).
      const faceShares: number[] = []
      for (let i = 0; i < 3; i++) {
        const eye: Vec = [sea.cx + (rnd() - 0.5) * 3000, sea.y + 450, sea.cz + (rnd() - 0.5) * 3000]
        const look = lookFrom(eye, (50 * Math.PI) / 180, rnd() * Math.PI * 2)
        await aim(page, eye, look)
        const a = await shoot(page, 'rings', eye, look, false)
        const b = await shoot(page, 'face', eye, look, false)
        fs.writeFileSync(
          path.join(OUT, `${mission.id}-face${i}-derived.png`),
          Buffer.from(a.png.split(',')[1] as string, 'base64'),
        )
        fs.writeFileSync(
          path.join(OUT, `${mission.id}-face${i}-face.png`),
          Buffer.from(b.png.split(',')[1] as string, 'base64'),
        )
        const x = decode(a.png)
        const y = decode(b.png)
        let same = 0
        let total = 0
        for (let row = Math.floor(x.h * 0.45); row < x.h; row++) {
          for (let col = 0; col < x.w; col++) {
            const p = row * x.w + col
            let d = 0
            for (let k = 0; k < 3; k++) {
              d = Math.max(
                d,
                Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)),
              )
            }
            total++
            if (d <= 3) same++
          }
        }
        faceShares.push(same / total)
        console.info(
          `  face ${i}: ${(100 * (same / total)).toFixed(2)} % of the near field identical to the derived normal`,
        )
      }
      if (Math.min(...faceShares) <= 0.9) {
        failures.push(
          `the face normal must agree with the derived one inside facets: shares ${faceShares.map((n) => n.toFixed(4)).join(', ')}`,
        )
      }

      // The launch shaft's bore (DEV-106) is a hole cut in the sea at the spawn on
      // purpose and shows magenta wherever the eye looks at it, under the plate too.
      // Run 7's blobs (1 to 17 px) all sat at one world point whatever the eye. It is
      // switched off for the scan, so any magenta left is a crack or a hole.
      await page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2: {
            terrain: () => { ocean: { water: { clearShaftBore: () => void } } | null } | null
          }
        }
        w.__ff2.terrain()?.ocean?.water.clearShaftBore()
      })

      // 2. no cracks: only the sea, magenta behind it, ring boundaries in view.
      let cracks = 0
      let scanned = 0
      for (let i = 0; i < 14; i++) {
        const height = [180, 450, 1200, 3000][i % 4] as number
        const eye: Vec = [
          sea.cx + (rnd() - 0.5) * 5000,
          sea.y + height,
          sea.cz + (rnd() - 0.5) * 5000,
        ]
        const look = lookFrom(eye, (62 * Math.PI) / 180, rnd() * Math.PI * 2)
        await aim(page, eye, look)
        const sPlate = await shoot(page, 'plate', eye, look, true)
        const s = await shoot(page, 'rings', eye, look, true)
        const maskPlate = magentaMask(sPlate.png)
        const maskRings = magentaMask(s.png)
        // Zero under the rings is the bar; what the PLATE shows is printed beside it
        // as the control (it has skirts, so it should read zero too).
        const only = magentaOnlyIn(maskRings, { hit: new Set() })
        const magenta = only.count
        const where = only.where
        const img = { w: maskRings.w, h: maskRings.h }
        scanned++
        cracks += magenta
        if (magenta > 0 || i < 2) {
          fs.writeFileSync(
            path.join(OUT, `${mission.id}-crack${i}.png`),
            Buffer.from(s.png.split(',')[1] as string, 'base64'),
          )
        }
        console.info(
          `  crack scan ${i}: eye ${eye.map((n) => n.toFixed(0)).join(',')} height ${height} ` +
            `-> ${magenta} magenta px under the rings and not the plate (${maskRings.hit.size} / ${maskPlate.hit.size} each, the shaft bore and the plate's own edge) of ${img.w * img.h} ${where.join(' ')}`,
        )
      }
      if (cracks > 0) failures.push(`${cracks} magenta pixels across ${scanned} sea-only frames`)

      // The face variant draws the same geometry: no cracks there either.
      let faceCracks = 0
      for (let i = 0; i < 4; i++) {
        const eye: Vec = [
          sea.cx + (rnd() - 0.5) * 4000,
          sea.y + 1200,
          sea.cz + (rnd() - 0.5) * 4000,
        ]
        const look = lookFrom(eye, (62 * Math.PI) / 180, rnd() * 6.28)
        await aim(page, eye, look)
        const sPlate = await shoot(page, 'plate', eye, look, true)
        const sFace = await shoot(page, 'face', eye, look, true)
        faceCracks += magentaOnlyIn(magentaMask(sFace.png), magentaMask(sPlate.png)).count
      }
      if (faceCracks > 0) failures.push(`${faceCracks} magenta pixels in the face-normal variant`)

      // Back to the plate, as the bracket's closing A, and the page stayed clean.
      const after = (await handle(page, false)) as Handle
      expect(after.on).toBe(false)
      expect(after.triangles).toBe(plate.triangles)
      if (before?.on) await handle(page, true)
      expect(problems.list(), 'page errors').toEqual([])
      expect(failures, 'the rings disagree with the plate, or crack').toEqual([])
      await testInfo.attach('summary', {
        body: JSON.stringify({ plate: plate.triangles, rings: rings.triangles, nearShares }),
        contentType: 'application/json',
      })
    })
  }
})
