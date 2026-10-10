/**
 * tests/e2e/loading-emblem.spec.ts — the loading plate's spinner is the title's
 * emblem, and it costs the switch no program. DEV-434.
 *
 * Matt: *"the loading spinner - let's center it and make it a lil version of the
 * logo from the title screen. but where the text stays put and the logo spins."*
 * The plate shows during a course switch, which is DEV-355's stall budget, so
 * what is measured here is what a compile would cost there: which programs the
 * loading scene's own materials are drawn with, and whether any of them was new
 * at the press.
 *
 * The route a player takes, on both presets: the title, the room, the aimed
 * presses of `board()` onto `int_01_hoverJet`, and the readings taken while the
 * loading scene is up and faded in.
 *
 * Since DEV-465 the two presets take the two ROUTES: on Anniversary the plate
 * stands in the room itself (the scene's group is up with its dome and ground
 * down, so "a loading frame" below is the room's frame, plate included), and
 * on Classic it is DEV-355's scene, as before. The emblem's claims are the
 * same on both. `hangar-load.spec.ts` holds the routes themselves.
 *
 *   - **programs**: three's program list at the press, then every program each
 *     loading-scene material has been drawn with (`renderer.properties`), and
 *     which of those did not exist at the press, i.e. were compiled during the
 *     switch FOR the loading scene. The emblem's must be the ground's, by
 *     construction (`render/loading-scene.ts`), so it can add none.
 *   - **draw calls**: `renderer.info.render.calls` of a loading frame, both
 *     passes on Anniversary (bloom's own passes included, DEV-091).
 *   - **the turn**: the mark's yaw at two moments a quarter second apart, and the
 *     wordmark's world matrix at both — it must not move.
 *   - **photographs**, pinned: the whole frame and a crop of the plate.
 *
 * Every reading is printed BEFORE anything is asserted, so a run against a build
 * without the emblem (the base, DEV-355's gem) still reports its numbers and
 * then fails on the emblem's absence. That run is how this spec was shown red.
 *
 *   E2E_PORT=<yours> LOADING_EMBLEM_DIR=<dir> LOADING_EMBLEM_LABEL=<after> \
 *     pnpm exec playwright test tests/e2e/loading-emblem.spec.ts --workers 1
 *
 * `@gpu`: a real world and a headed browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const OUT = process.env.LOADING_EMBLEM_DIR ?? 'perf-out/dev-434'
const LABEL = process.env.LOADING_EMBLEM_LABEL ?? 'run'

/** The slice of the page this reads, typed once. */
interface PageHandle {
  readonly __ff2?: {
    stage: () => Obj
    render: {
      camera: Obj & { position: { constructor: new () => Vec } }
      renderer: {
        /**
         * Read between frames: the LAST frame's counts. On the bloom path
         * `render/bloom.ts` resets it once and counts both passes; on the
         * direct path `render()` resets it itself. Not `__ff2perf.info()`,
         * which exists only under `?perf=1` and would put its panel in the
         * photographs.
         */
        info: {
          programs: { cacheKey: string }[] | null
          render: { calls: number; triangles: number }
        }
        properties: {
          get: (m: unknown) => {
            currentProgram?: { cacheKey: string }
            programs?: Map<string, unknown>
          }
        }
        domElement: { getBoundingClientRect: () => DOMRect }
      }
    }
  }
}
interface Vec {
  fromArray: (a: ArrayLike<number>, o: number) => Vec
  applyMatrix4: (m: unknown) => Vec
  project: (c: unknown) => Vec
  x: number
  y: number
  z: number
}
interface Obj {
  name: string
  visible: boolean
  isMesh?: boolean
  material?: unknown
  matrixWorld: { elements: number[] }
  rotation: { y: number }
  geometry?: { attributes: { position: { array: ArrayLike<number>; count: number } } }
  getObjectByName: (n: string) => Obj | undefined
  traverse: (f: (o: Obj) => void) => void
}

/** Every program key three holds right now. */
const programKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (globalThis as unknown as PageHandle).__ff2?.render.renderer.info.programs?.map(
        (p) => p.cacheKey,
      ) ?? [],
  )

/** Is the emblem in the loading scene yet? It arrives with its own load of the logo. */
const emblemIn = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const ff = (globalThis as unknown as PageHandle).__ff2
    const scene = ff?.stage().getObjectByName('loading-scene')
    return scene?.getObjectByName('loading-emblem') !== undefined
  })

interface MeshReading {
  readonly name: string
  readonly visible: boolean
  /** Index of the program it is drawn with in `keys`, or -1. */
  readonly current: number
  /** Every program this mesh's material has been drawn with, as indices into `keys`. */
  readonly used: number[]
}

interface Reading {
  readonly shown: boolean
  readonly fade: string | null
  readonly calls: number
  readonly triangles: number
  readonly programs: number
  readonly keys: string[]
  readonly meshes: MeshReading[]
  readonly markYaw: number | null
  readonly wordMatrix: number[] | null
  /** The plate and the emblem's box on the canvas, CSS pixels. */
  readonly clip: { x: number; y: number; width: number; height: number } | null
}

const read = (page: Page): Promise<Reading> =>
  page.evaluate(() => {
    const w = globalThis as unknown as PageHandle
    const ff = w.__ff2
    const scene = ff?.stage().getObjectByName('loading-scene')
    const three = ff?.render.renderer.info
    const info = three
      ? {
          calls: three.render.calls,
          triangles: three.render.triangles,
          programs: three.programs?.length ?? 0,
        }
      : null
    const keys: string[] = []
    const index = (key: string | undefined): number => {
      if (key === undefined) return -1
      const at = keys.indexOf(key)
      if (at >= 0) return at
      keys.push(key)
      return keys.length - 1
    }
    const meshes: MeshReading[] = []
    let clip: Reading['clip'] = null
    if (ff && scene) {
      const renderer = ff.render.renderer
      scene.traverse((o) => {
        if (!o.isMesh) return
        const props = renderer.properties.get(o.material)
        meshes.push({
          name: o.name,
          visible: o.visible,
          current: index(props.currentProgram?.cacheKey),
          used: [...(props.programs?.keys() ?? [])].map(index),
        })
      })
      // The crop: the plate's corners and every vertex of the mark and the
      // wordmark, projected, padded.
      const Vector3 = ff.render.camera.position.constructor
      const rect = renderer.domElement.getBoundingClientRect()
      let x0 = Number.POSITIVE_INFINITY
      let y0 = Number.POSITIVE_INFINITY
      let x1 = Number.NEGATIVE_INFINITY
      let y1 = Number.NEGATIVE_INFINITY
      for (const name of ['loading-plate', 'loading-emblem', 'loading-wordmark', 'loading-gem']) {
        const mesh = scene.getObjectByName(name)
        const pos = mesh?.geometry?.attributes.position
        if (!mesh || !pos) continue
        for (let i = 0; i < pos.count; i++) {
          const p = new Vector3().fromArray(pos.array, i * 3).applyMatrix4(mesh.matrixWorld)
          p.project(ff.render.camera)
          if (p.z > 1) continue
          const px = rect.left + ((p.x + 1) / 2) * rect.width
          const py = rect.top + ((1 - p.y) / 2) * rect.height
          x0 = Math.min(x0, px)
          y0 = Math.min(y0, py)
          x1 = Math.max(x1, px)
          y1 = Math.max(y1, py)
        }
      }
      if (Number.isFinite(x0)) {
        const pad = 24
        const x = Math.max(rect.left, Math.floor(x0 - pad))
        const y = Math.max(rect.top, Math.floor(y0 - pad))
        clip = {
          x,
          y,
          width: Math.min(rect.left + rect.width, Math.ceil(x1 + pad)) - x,
          height: Math.min(rect.top + rect.height, Math.ceil(y1 + pad)) - y,
        }
      }
    }
    const mark = scene?.getObjectByName('loading-mark')
    const word = scene?.getObjectByName('loading-wordmark')
    return {
      shown: scene?.visible === true,
      fade: document.body.dataset.fade ?? null,
      calls: info?.calls ?? -1,
      triangles: info?.triangles ?? -1,
      programs: info?.programs ?? -1,
      keys,
      meshes,
      markYaw: mark ? mark.rotation.y : null,
      wordMatrix: word ? [...word.matrixWorld.elements] : null,
      clip,
    }
  })

for (const edition of ['anniversary', 'classic'] as const) {
  test.describe(`@gpu DEV-434 — the loading plate's emblem, ${edition}`, () => {
    test.setTimeout(300_000)

    test(`int_01_hoverJet from the room, ${edition}: programs, draws, the turn, photographed`, async ({
      page,
    }) => {
      const logs: string[] = []
      page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
      await page.goto(`/?xr=off&${PINNED}&edition=${edition}`)
      await firstPress(page)
      await bootReady(page, 240_000)
      await dropFocus(page)
      await page.waitForTimeout(1_500)
      await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
      const pinned = await drawState(page)

      // The logo is its own small load; give it the time the room takes to
      // settle, and record whether it came rather than failing here, so a base
      // build still reports its numbers.
      let installed = false
      for (let i = 0; i < 40 && !installed; i++) {
        installed = await emblemIn(page)
        if (!installed) await page.waitForTimeout(250)
      }
      const atPress = new Set(await programKeys(page))

      fs.mkdirSync(OUT, { recursive: true })
      const stem = `loading-emblem-int_01-${edition}-${PINNED.replace(/[=&]/g, '-')}-${LABEL}`
      const shots: string[] = []

      const boarding = board(page, INT_01_HOVERJET, 0)
      await expect
        .poll(
          async () => {
            const r = await read(page)
            return r.shown && r.fade === 'idle'
          },
          { timeout: 120_000, intervals: [50] },
        )
        .toBe(true)

      const first = await read(page)
      const whole = path.join(OUT, `${stem}-frame.png`)
      await page.locator('#viewport').screenshot({ path: whole })
      shots.push(whole)
      if (first.clip) {
        const crop = path.join(OUT, `${stem}-plate.png`)
        await page.screenshot({ path: crop, clip: first.clip })
        shots.push(crop)
      }
      await page.waitForTimeout(250)
      const later = await read(page)
      if (later.shown && later.clip) {
        const crop = path.join(OUT, `${stem}-plate-later.png`)
        await page.screenshot({ path: crop, clip: later.clip })
        shots.push(crop)
      }

      await boarding
      await expect
        .poll(async () => (await read(page)).shown, {
          timeout: 30_000,
          message: 'the loading scene is gone once you are aboard',
        })
        .toBe(false)
      const heldTier = drawStateDiff(pinned, await drawState(page))

      // ── the readings, printed before anything is asserted ───────────────
      const newAt = (i: number): boolean => !atPress.has(first.keys[i] as string)
      const ground = first.meshes.find((m) => m.name === 'loading-ground')
      const emblem = first.meshes.find((m) => m.name === 'loading-emblem')
      const word = first.meshes.find((m) => m.name === 'loading-wordmark')
      const compiledForScene = new Set(
        first.meshes.flatMap((m) => m.used.filter(newAt).map((i) => first.keys[i] as string)),
      )
      const turned =
        first.markYaw !== null && later.markYaw !== null
          ? (later.markYaw - first.markYaw + 2 * Math.PI) % (2 * Math.PI)
          : null
      const wordStill =
        first.wordMatrix !== null &&
        later.wordMatrix !== null &&
        first.wordMatrix.every((v, i) => v === later.wordMatrix?.[i])
      const report = {
        edition,
        label: LABEL,
        emblemInstalled: installed,
        programsAtPress: atPress.size,
        loadingFrame: { calls: first.calls, triangles: first.triangles, programs: first.programs },
        meshes: first.meshes.map((m) => ({
          name: m.name,
          visible: m.visible,
          program: m.current,
          newAtPress: m.current >= 0 ? newAt(m.current) : null,
          used: m.used,
        })),
        programsCompiledForTheLoadingScene: compiledForScene.size,
        emblemSharesGroundProgram:
          emblem && ground ? emblem.current === ground.current && emblem.current >= 0 : null,
        wordmarkSharesGroundProgram:
          word && ground ? word.current === ground.current && word.current >= 0 : null,
        markTurnedIn250ms: turned,
        wordmarkStill: first.wordMatrix === null ? null : wordStill,
        tierHeld: heldTier,
        shots: shots.map((s) => path.resolve(s)),
      }
      fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(report, null, 1))
      console.info(
        [
          `\nDEV-434 — the loading plate, ${edition}, ${PINNED}, ${LABEL}`,
          `  emblem installed before the press: ${installed}`,
          `  programs at the press ${atPress.size}; a loading frame: ${first.calls} calls, ` +
            `${first.triangles} triangles, ${first.programs} programs`,
          ...report.meshes.map(
            (m) =>
              `    ${m.name.padEnd(18)} ${m.visible ? 'shown' : 'hidden'}  program #${m.program}` +
              `${m.newAtPress ? ' NEW at the press' : ''}  used [${m.used.join(',')}]`,
          ),
          `  programs compiled during the switch for the loading scene: ${compiledForScene.size}`,
          `  emblem on the ground's program: ${report.emblemSharesGroundProgram}; ` +
            `wordmark: ${report.wordmarkSharesGroundProgram}`,
          `  the mark turned ${turned?.toFixed(3) ?? 'n/a'} rad in ~250 ms; wordmark still: ${report.wordmarkStill}`,
          ...shots.map((s) => `  ${path.resolve(s)}`),
          '',
        ].join('\n'),
      )

      // ── and the claims ──────────────────────────────────────────────────
      expect(heldTier, 'the tier held for every reading').toEqual([])
      expect(first.calls, 'a loading frame drew something').toBeGreaterThan(0)
      expect(first.programs, 'and with programs').toBeGreaterThan(0)
      expect(installed, "the title's emblem is the mark before any press").toBe(true)
      expect(emblem?.visible, 'the emblem is drawn').toBe(true)
      expect(word?.visible, 'the wordmark is drawn').toBe(true)
      expect(
        first.meshes.some((m) => m.name === 'loading-gem'),
        'the gem has gone',
      ).toBe(false)
      // By construction, and measured: whatever the ground's program costs, the
      // emblem and the wordmark add nothing to it.
      expect(
        report.emblemSharesGroundProgram,
        "the emblem is drawn with the ground's program",
      ).toBe(true)
      expect(report.wordmarkSharesGroundProgram, 'and the wordmark').toBe(true)
      for (const m of [emblem, word]) {
        for (const i of m?.used ?? []) {
          expect(first.keys[i], `${m?.name}: every program it used is the ground's`).toBe(
            first.keys[ground?.current ?? -1],
          )
        }
      }
      // It turns while the frames flow, and only it: ~0.9 rad/s, so a quarter
      // second is ~0.2 rad; anything above zero and under a half turn is a turn.
      expect(turned, 'the emblem turned between two readings').toBeGreaterThan(0.02)
      expect(turned as number).toBeLessThan(Math.PI)
      expect(report.wordmarkStill, 'the wordmark did not move').toBe(true)
      expect(
        logs.filter((l) => /^error: .*(shader|program|WebGL)/i.test(l)),
        'no GL errors while the plate was up',
      ).toEqual([])
    })
  })
}
