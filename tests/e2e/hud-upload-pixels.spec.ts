/**
 * tests/e2e/hud-upload-pixels.spec.ts — DEV-244. Dropping the HUD's mip chain
 * is a PIXEL decision, photographed.
 *
 *   E2E_PORT=<yours> HUD_PHOTO_DIR=perf-out/dev244 \
 *     pnpm exec playwright test tests/e2e/hud-upload-pixels.spec.ts --workers 1 --retries 0
 *
 * ── The claim, and why a picture is the only thing that can settle it ────
 *
 * `?hudUpload=nomip` removes `three.module.js:12396`'s unconditional
 * `generateMipmap` from every upload — and, because three refuses
 * `TEXTURE_MAX_ANISOTROPY_EXT` for any minFilter that is not mipmap-linear
 * (`:11701`), it removes the panel's `anisotropy = 4` with it. The panel is
 * raked back at dz/dy 1.08, carries small italic type, and is the instrument a
 * player reads while flying at 170 m/s. ART_DIRECTION: *a thing too small, too
 * dark, too fast or off-screen has not been reviewed, it has been rendered.*
 *
 * So the deliverable is pictures, and the numbers beside them exist to say
 * whether the pictures could have shown anything.
 *
 * ── The number that decides whether the chain was ever SAMPLED ───────────
 *
 * A mip chain is consulted only under MINIFICATION. If the panel's texels are
 * larger than the screen pixels sampling them, the hardware takes `magFilter`
 * and level 0 and the chain is inert — in which case `nomip` costs nothing
 * visible at that pose, and says so arithmetically rather than by taste.
 *
 * `panelMetrics` therefore computes, in the page and from the LIVE transforms,
 * **backing-store pixels per texel along the panel's own u and v axes** — a
 * projected screen length divided by the texels it spans. The backing-store
 * scale is read off the canvas (`canvas.width / canvas.clientWidth`) rather
 * than assumed from `devicePixelRatio`, which is a different quantity.
 *
 * **And it is measured on THREE lines across u, not one**, because the panel is
 * raked at dz/dy 1.08: its far edge is further from the eye and more
 * foreshortened than its near edge, so a single ratio taken across the middle
 * is a MEAN and can read 1.30 while the top row is being minified.
 * `pxPerTexelWorst` is the smallest of the three and it is the one that decides
 * whether a chain is sampled ANYWHERE on this panel. DEV-027: say what the
 * number is the ratio of, then check that it is the quantity you need.
 *
 * Under 1.0 anywhere and the chain is live there. Over 1.0 everywhere, and the
 * only thing `nomip` can change is what the hardware does at the sub-texel
 * edges.
 *
 * ── There is NO crawl statistic, and that is a finding ────────────────
 *
 * The first version measured one — four consecutive shots per arm, mean
 * frame-to-frame change, on the argument that the flying ship moves the eye for
 * free. `?snap=` took the motion away, and the snap is not optional: it is the
 * only thing that makes the crop quiet enough to read at all. The two
 * requirements are in direct conflict, and the numbers the snapped run produced
 * are the wave phase drifting behind an 86 %-opaque plate wearing a filtering
 * statistic's name. The block where it used to be says so in full.
 *
 * ── The bracket, and the first version of DEV-241's spec ─────────────────
 *
 * Every arm sits between two shipped shots — **A · arm · A · arm · A** — for
 * DEV-241's reason, which is worth restating because its first version was
 * wrong in a way that could not fail: it built the quiet mask from the two
 * control frames and then asserted the control moved no pixels inside it, which
 * is zero by construction. The mask here comes from the WIDEST bracket and BOTH
 * counts are then measured over it, so neither is definitional. And the control
 * is not decoration: **every pixel of this crop has world behind it** — the
 * plates are 86 % opaque and there are gaps between them — so the crop is only
 * readable because `?snap=` freezes the ship and `__ff2.hud('freeze')` holds
 * the canvas. Without the snap the quiet mask kept 36.3 % of the crop; with it,
 * 99.8 %.
 *
 * ── What this harness CANNOT reach, said out loud ────────────────────────
 *
 * **A worn LEAN.** In the cockpit the rig is the ship and the camera's local
 * pose is the head inside it; `game/flight.ts` sets that local pose to identity
 * on every frame (see `render/head-pose.ts`, which exists because ~150 lines
 * of that ordering cost DEV-199). So a flat harness cannot move the eye
 * relative to the panel, and the eye-to-panel geometry here is exactly the one
 * geometry the shipped seat has. A VR player leaning in can reach a grazing
 * angle this spec cannot produce.
 *
 * **And there is only ONE flat pose, which this spec found out by being
 * refused.** Its first version drove the game's own mouse-look to put the panel
 * at the frame edge and then checked that it had moved; it came back 1.7 % off
 * centre against a bar of 15 %. The cause is in the game: `input/look.ts`'s
 * `FREE_LOOK_RETURN_TAU` is **0.18 s**, so a flat view springs back to centre,
 * and a shot 1.2 s after the last mouse move is taken ~6.7 time constants in.
 * A player cannot hold a peripheral view either. And the pose would not have
 * answered the question anyway — under a perspective projection an off-axis
 * surface at constant distance subtends MORE pixels per metre, so the periphery
 * is more magnified, which is the wrong direction for minification.
 *
 * What stands in for it is the **perf plate** (`?perf=1`, DEV-160): the same
 * kind of panel, built by the same code at the same pixel density, sitting
 * beside the HUD and therefore at a genuinely different angle to the eye. Its
 * px-per-texel is the off-axis relation as a MEASUREMENT rather than as a
 * cosine law — DEV-041's rule, prefer the thing that cannot be wrong over the
 * score that is usually right.
 *
 * The worn lean stays bounded rather than reached: the spec prints how far off
 * normal the eye must get before level 0 stops being the sampled level, DERIVED
 * under a 1/cos footprint model and labelled as derived. The plate checks the
 * model's direction; its size is still the model's, and a worn pass is where
 * the lean belongs.
 *
 * Tagged `@gpu`, `?xr=off` so `isSessionSupported('immersive-vr')` does not
 * start this machine's OpenXR runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describeHudRaster, HUD_RASTER_SHIPPED } from '@/render/hud'
import { comparePng, decodePng } from '../../tools/perf/png-diff.mjs'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import {
  type DrawState,
  drawState,
  drawStateDiff,
  drawStateLine,
  PINNED,
} from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.HUD_PHOTO_DIR ?? 'perf-out/dev244'
const MISSION = process.env.HUD_PHOTO_MISSION ?? 'int_01_hoverJet'
const EDITION = process.env.HUD_PHOTO_EDITION ?? 'anniversary'
/**
 * The mission second `?snap=` freezes the sim on.
 *
 * Late enough that the panel is carrying a flight — gates scored, a clock
 * running down, a three-digit speed — and early enough that the autopilot has
 * not finished. 25 s on `int_01_hoverJet` is mid-course.
 */
const SNAP_AT = Number(process.env.HUD_PHOTO_AT ?? '25')

/**
 * DEV-266. Which raster arm SHIPS, **imported from the build rather than
 * spelled here** — and the reason is that this file spelled it and went red.
 *
 * DEV-256 shipped `cpu` on 2026-09-20 (`07bf549`), this spec went on asserting
 * that an unpinned load reports `gpu`, and it failed on `main` from that
 * commit until DEV-266. Nothing caught it, because a string literal in a spec
 * and a `??` in `boot/app.ts` are two copies of one fact with no link between
 * them — CLAUDE.md's *"do not write the count down"*, in the form a DEFAULT
 * takes.
 *
 * So the arms are DERIVED: `SHIPPED` is whatever `HUD_RASTER_SHIPPED` says
 * and `WAY_BACK` is the other one. The next flip of the default re-points
 * this spec by itself.
 *
 * **What that deliberately does NOT do is assert which arm ships** — this
 * file would agree with the build about anything, including a wrong answer,
 * which is exactly CLAUDE.md's *"a test that compares two of your own devices
 * has not tested either."* The VALUE is pinned outside, in
 * `tests/unit/hud-raster.test.ts`, against the ledger row. Here it is only
 * the thing that cannot be allowed to drift.
 */
const SHIPPED = describeHudRaster(HUD_RASTER_SHIPPED)
const WAY_BACK = SHIPPED === 'cpu' ? 'gpu' : 'cpu'

/**
 * ONE WORN EYE, the way `perf-trace.spec.ts` takes it — a CSS viewport at half
 * and a `deviceScaleFactor` of 2, because a headed Chromium window cannot be
 * 2016 px wide on this display and the backing store is what matters.
 *
 * 2016 is wave 4's own figure, so a legibility judgement taken here is taken at
 * the pixel count every measurement in §3.5 and §3.8 was taken at. At
 * Playwright's default 1280 x 720 the panel would be sampled at a third of the
 * density and a filtering question would answer itself wrongly in the
 * forgiving direction.
 */
const EYE_PX = Number(process.env.HUD_PHOTO_PX ?? '2016')
const DPR = 2

test.use({
  viewport: { width: Math.round(EYE_PX / DPR), height: Math.round(EYE_PX / DPR) },
  deviceScaleFactor: DPR,
})

interface PanelMetrics {
  /** The panel's screen rect in CSS pixels, page-relative — the clip. */
  readonly clip: { x: number; y: number; width: number; height: number }
  /** The canvas's own backing-store scale, `canvas.width / canvas.clientWidth`. */
  readonly backingScale: number
  /** The texture, in texels. */
  readonly texels: { readonly width: number; readonly height: number }
  /** Backing-store pixels per TEXEL along the panel's u axis, at this pose. */
  readonly pxPerTexelU: number
  /** ...and along v. Lower than u wherever the rake is foreshortening it. */
  readonly pxPerTexelV: number
  /** Across u at the panel's FAR (top) edge, which the rake pushes away. */
  readonly pxPerTexelTop: number
  /** Across u at the NEAR (bottom) edge. */
  readonly pxPerTexelBottom: number
  /**
   * The smallest of the three u figures — the number that decides whether the
   * mip chain is sampled ANYWHERE on this panel, rather than on average.
   */
  readonly pxPerTexelWorst: number
  /** Degrees between the panel's normal and the direction to the eye. */
  readonly offNormalDeg: number
  /** How far the panel's centre is from the frame's, as a share of half-width. */
  readonly offCentre: number
}

/**
 * Everything about where the panel is, computed in the page from the LIVE
 * transforms — not from `content/editions/*.json`, because what is wanted is
 * where the thing IS and a placement composed through a rig and a ship is
 * exactly the kind of chain DEV-042 got wrong by reading one end of it.
 */
const panelMetrics = (page: Page, objectName: string): Promise<PanelMetrics | null> =>
  page.evaluate((name: string) => {
    interface V3 {
      x: number
      y: number
      z: number
      set: (x: number, y: number, z: number) => V3
      copy: (o: V3) => V3
      sub: (o: V3) => V3
      normalize: () => V3
      dot: (o: V3) => number
      length: () => number
      applyMatrix4: (m: unknown) => V3
      project: (c: unknown) => V3
      constructor: new (x?: number, y?: number, z?: number) => V3
    }
    interface Cam {
      position: V3
      matrixWorld: unknown
      matrixWorldInverse: { copy: (m: unknown) => { invert: () => unknown } }
      updateMatrixWorld: (force?: boolean) => void
    }
    interface Mesh {
      name?: string
      matrixWorld: unknown
      updateWorldMatrix: (parents: boolean, children: boolean) => void
      // DEV-362: in the cockpit the panel is set into the dash and its mesh is
      // 2016's two screens on ONE canvas. `parameters` is then the UPPER
      // screen, and `upperShare` is how much of the canvas's height that
      // screen shows — the texels a v-span on it actually crosses.
      geometry?: { parameters?: { width: number; height: number; upperShare?: number } }
      material?: { map?: { image?: { width: number; height: number } } }
      children?: Mesh[]
      traverse?: (f: (o: Mesh) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: { scene: { getObjectByName: (n: string) => Mesh | undefined }; camera: Cam }
      }
    }
    const render = w.__ff2?.render
    const panel = render?.scene.getObjectByName(name)
    const canvas = document.getElementById('viewport') as HTMLCanvasElement | null
    if (!render || !panel || !canvas) return null
    const size = panel.geometry?.parameters
    const image = panel.material?.map?.image
    if (!size || !image) return null

    const camera = render.camera
    // `matrixWorld` is only recomputed inside `render()`, and this runs between
    // frames — the same staleness CLAUDE.md records for `grip.matrixWorld` in
    // an XR callback. `project()` then needs the INVERSE, which three keeps but
    // does not refresh outside a render either.
    panel.updateWorldMatrix(true, false)
    camera.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    const V = camera.position.constructor
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    /** A panel-local point, in CSS pixels on the page. */
    const toScreen = (lx: number, ly: number) => {
      const v = new V(lx, ly, 0)
      v.applyMatrix4(panel.matrixWorld)
      v.project(camera)
      return { x: (v.x * 0.5 + 0.5) * cssW, y: (1 - (v.y * 0.5 + 0.5)) * cssH }
    }
    const hw = size.width / 2
    const hh = size.height / 2
    const left = toScreen(-hw, 0)
    const right = toScreen(hw, 0)
    const top = toScreen(0, hh)
    const bottom = toScreen(0, -hh)
    const corners = [toScreen(-hw, hh), toScreen(hw, hh), toScreen(-hw, -hh), toScreen(hw, -hh)]

    // The eye, and the panel's own normal, both in world space. The normal is
    // the panel's local +z through its world matrix with the translation
    // dropped — two points a unit apart along z, differenced, which needs no
    // assumption about scale or handedness.
    const o = new V(0, 0, 0).applyMatrix4(panel.matrixWorld)
    const n = new V(0, 0, 1).applyMatrix4(panel.matrixWorld).sub(o).normalize()
    // `camera.position` is LOCAL in the cockpit (trap 18) — the head inside the
    // rig — so the world eye is the camera's own matrixWorld translation, which
    // is what applying the matrix to the local origin gives. Reading
    // `camera.position` here would give the head's offset inside the rig, which
    // is (0, 0, 0) on every flat frame and would put the eye at the world
    // origin.
    const eyeWorld = new V(0, 0, 0).applyMatrix4(camera.matrixWorld)
    const toEye = new V(0, 0, 0).copy(eyeWorld).sub(o).normalize()
    const cos = Math.max(-1, Math.min(1, n.dot(toEye)))

    const backingScale = cssW > 0 ? canvas.width / cssW : 1
    const spanU = Math.hypot(right.x - left.x, right.y - left.y) * backingScale
    const spanV = Math.hypot(bottom.x - top.x, bottom.y - top.y) * backingScale
    // THE PANEL IS RAKED, so the mid-line figure is a MEAN and the far edge is
    // worse. dz/dy is 1.08, which means the top of the panel is further from
    // the eye and more foreshortened than the bottom — a single ratio taken
    // across the middle can read 1.30 while the top row reads under 1 and is
    // being minified. DEV-027: say what the number is the ratio OF, and then
    // check whether the quantity you need is that one.
    //
    // So u is measured on BOTH edges as well as the middle, and the WORST of
    // the three is what decides whether a chain is sampled anywhere on this
    // panel. (v is a single span by construction — it runs along the rake.)
    const topL = toScreen(-hw, hh)
    const topR = toScreen(hw, hh)
    const botL = toScreen(-hw, -hh)
    const botR = toScreen(hw, -hh)
    const spanTop = Math.hypot(topR.x - topL.x, topR.y - topL.y) * backingScale
    const spanBot = Math.hypot(botR.x - botL.x, botR.y - botL.y) * backingScale

    const xs = corners.map((c) => c.x)
    const ys = corners.map((c) => c.y)
    const pad = 12
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
    const x1 = Math.min(cssW, Math.ceil(Math.max(...xs) + pad))
    const y1 = Math.min(cssH, Math.ceil(Math.max(...ys) + pad))
    const box = canvas.getBoundingClientRect()

    return {
      clip: {
        x: box.x + x0,
        y: box.y + y0,
        width: Math.max(1, x1 - x0),
        height: Math.max(1, y1 - y0),
      },
      backingScale,
      texels: { width: image.width, height: image.height },
      pxPerTexelU: spanU / image.width,
      pxPerTexelV: spanV / (image.height * (size.upperShare ?? 1)),
      pxPerTexelTop: spanTop / image.width,
      pxPerTexelBottom: spanBot / image.width,
      pxPerTexelWorst: Math.min(spanU, spanTop, spanBot) / image.width,
      offNormalDeg: (Math.acos(Math.abs(cos)) * 180) / Math.PI,
      offCentre: Math.abs((x0 + x1) / 2 - cssW / 2) / (cssW / 2),
    }
  }, objectName) as Promise<PanelMetrics | null>

interface HudProbe {
  upload: string
  liveUpload: string | null
  mipLevels: number
  mipBytes: number
  bytes: number
  uploadBytes: number
  cadence: string
  repaints: number
  /** DEV-256. The raster backend asked for. */
  raster: string
  /** DEV-256. What the live 2-D context says it was created with. */
  liveRaster: string | null
  /** DEV-256. Live raster flips so far — a flip REBUILDS the canvas. */
  rasterRebuilds: number
}

/** Set the upload mode on a live page and read what the TEXTURE then says. */
const setUpload = (page: Page, mode: string): Promise<HudProbe | null> =>
  page.evaluate((m) => {
    const w = globalThis as unknown as { __ff2?: { hudUpload?: (n?: string) => unknown } }
    return (w.__ff2?.hudUpload?.(m) ?? null) as never
  }, mode)

const setCadence = (page: Page, mode: string): Promise<HudProbe | null> =>
  page.evaluate((m) => {
    const w = globalThis as unknown as { __ff2?: { hud?: (n?: string | number) => unknown } }
    return (w.__ff2?.hud?.(m) ?? null) as never
  }, mode)

/** DEV-256. Set the RASTER backend on a live page and read what the CONTEXT says. */
const setRaster = (page: Page, mode: string): Promise<HudProbe | null> =>
  page.evaluate((m) => {
    const w = globalThis as unknown as { __ff2?: { hudRaster?: (n?: string) => unknown } }
    return (w.__ff2?.hudRaster?.(m) ?? null) as never
  }, mode)

/** Read the panel's report without moving anything. */
const readHud = (page: Page): Promise<HudProbe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2?: { hud?: (n?: string | number) => unknown } }
    return (w.__ff2?.hud?.() ?? null) as never
  })

/** DEV-256. What one capture of the panel's own canvas says about itself. */
interface CanvasDigest {
  /** FNV-1a over every byte of `getImageData`. Two equal hashes are one raster. */
  readonly hash: number
  readonly width: number
  readonly height: number
  /**
   * Pixels with any alpha at all.
   *
   * **The guard that stops a canvas comparison being trivially zero.** Two
   * BLANK canvases hash the same, so an equality result means nothing until
   * something says the surface has ink on it. This is that something.
   */
  readonly ink: number
}

/**
 * Read the HUD's canvas pixels and stash them in the page under `label`.
 *
 * `getImageData` on the panel's OWN context — the surface the "changes no
 * pixel" claim is actually about, with nothing composited over it and nothing
 * moving behind it. A screen crop cannot answer that question here and the
 * DEV-256 block below says why with the numbers.
 *
 * **This readback may push Chromium's own heuristics around**: repeatedly
 * reading a GPU canvas is exactly what `willReadFrequently` exists to make
 * cheap, and a browser is free to migrate a canvas to software after enough of
 * them. That is harmless for a pixel question and would be fatal for a timing
 * one, so **never take a duration on a page this helper has run.**
 */
const captureCanvas = (page: Page, label: string): Promise<CanvasDigest | null> =>
  page.evaluate((key: string) => {
    interface El {
      width: number
      height: number
      getContext: (id: string) => CanvasRenderingContext2D | null
    }
    const w = globalThis as unknown as {
      __ff2?: {
        render: {
          scene: {
            getObjectByName: (n: string) => { material?: { map?: { image?: El } } } | undefined
          }
        }
      }
      __dev256?: Record<string, Uint8ClampedArray>
    }
    const element = w.__ff2?.render.scene.getObjectByName('hud')?.material?.map?.image
    if (!element || typeof element.getContext !== 'function') return null
    const ctx = element.getContext('2d')
    if (!ctx) return null
    const { width, height } = element
    const { data } = ctx.getImageData(0, 0, width, height)
    let hash = 0x811c9dc5
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      for (let k = 0; k < 4; k++) {
        hash = Math.imul(hash ^ (data[i + k] as number), 0x01000193)
      }
      if ((data[i + 3] as number) > 0) ink++
    }
    if (!w.__dev256) w.__dev256 = {}
    w.__dev256[key] = new Uint8ClampedArray(data)
    return { hash: hash >>> 0, width, height, ink }
  }, label)

/** Byte-exact difference between two stashed captures. `null` if either is missing. */
const diffCanvas = (
  page: Page,
  a: string,
  b: string,
): Promise<{ diffPixels: number; maxDelta: number } | null> =>
  page.evaluate(
    ([x, y]: string[]) => {
      const w = globalThis as unknown as { __dev256?: Record<string, Uint8ClampedArray> }
      const p = w.__dev256?.[x as string]
      const q = w.__dev256?.[y as string]
      if (!p || !q || p.length !== q.length) return null
      let diffPixels = 0
      let maxDelta = 0
      for (let i = 0; i < p.length; i += 4) {
        let moved = false
        for (let k = 0; k < 4; k++) {
          const d = Math.abs((p[i + k] as number) - (q[i + k] as number))
          if (d > maxDelta) maxDelta = d
          if (d > 0) moved = true
        }
        if (moved) diffPixels++
      }
      return { diffPixels, maxDelta }
    },
    [a, b],
  )

/** Pixels where `a` and `b` agree on every channel to within 24 levels. */
const stableMask = (a: Buffer, b: Buffer): { keep: Uint8Array; share: number } => {
  const x = decodePng(a)
  const y = decodePng(b)
  if (x.w !== y.w || x.h !== y.h) throw new Error('hud-upload-pixels: the crop moved mid-pose')
  const n = x.w * x.h
  const keep = new Uint8Array(n)
  let kept = 0
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < n; p++) {
    let same = true
    for (let k = 0; k < rgb; k++) {
      if (Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)) > 24) {
        same = false
        break
      }
    }
    if (same) {
      keep[p] = 1
      kept++
    }
  }
  return { keep, share: kept / n }
}

/** How many pixels of `mask` differ by more than 24 levels — pixels, not samples. */
const pixelsMoved = (a: Buffer, b: Buffer, mask: Uint8Array): number => {
  const x = decodePng(a)
  const y = decodePng(b)
  // Throws rather than returning 0: an out-of-range read gives `undefined`,
  // `Math.abs(NaN) > 24` is false, and a size mismatch would then report
  // "nothing moved", which is this spec's benign answer. A guard whose failure
  // mode is a pass is not a guard (DEV-241).
  if (x.w !== y.w || x.h !== y.h) throw new Error('hud-upload-pixels: crops of different sizes')
  let moved = 0
  const rgb = Math.min(3, x.ch, y.ch)
  for (let p = 0; p < x.w * x.h; p++) {
    if (!mask[p]) continue
    for (let k = 0; k < rgb; k++) {
      if (Math.abs((x.data[p * x.ch + k] as number) - (y.data[p * y.ch + k] as number)) > 24) {
        moved++
        break
      }
    }
  }
  return moved
}

test.describe('@gpu DEV-244 — dropping the mip chain, photographed', () => {
  test.setTimeout(900_000)

  test('the panel at the seat and at the frame edge, mip against nomip', async ({
    page,
  }, testInfo) => {
    const problems = watchPageErrors(page)
    fs.mkdirSync(OUT, { recursive: true })

    // The cockpit, not `?view=cam`: the panel is IN the ship and the whole
    // question is what a player reads while flying. The autopilot flies the
    // same code a player does — `scoring-feedback-photos.spec.ts`'s recipe.
    //
    // ── `?snap=`, and the run that proved it is not optional ─────────────
    //
    // The first run of this spec refused itself: the quiet mask kept **36.3 %**
    // of the crop and the guard below wants half. The reason is the panel's own
    // construction — `draw()` clears the canvas and lays three plates at
    // `rgba(38, 92, 100, 0.86)` with a gap between them, so **every pixel of
    // this crop has some of the world behind it**, through the gaps at full
    // strength and through the plates at 14 %. With the ship flying, that world
    // moves, and so does the cockpit's own shading as the hull banks under a
    // sun 4° above the horizon. Freezing the PANEL leaves all of that moving.
    //
    // `?snap=<s>` is the game's own answer and it is the pause with a different
    // trigger (`boot/snap.ts`: the same `stepFixed`-with-zero-wall-time the
    // pause menu uses, not a path built for a test). The ship, the racers, the
    // mission clock and the score stop together; the ocean's wave phase and the
    // particles run on the render clock and do not, which is why the spec still
    // brackets rather than trusting a still frame.
    //
    // ── `?adaptive=0&quality=high`, added by DEV-245 ────────────────────
    //
    // `render/quality.ts` drops a tier when the box is starved, and a tier
    // drop moves MSAA and the framebuffer scale — which are *filtering*, the
    // exact subject of this spec. **The DEV-244 frames were shot without this
    // pin.** Its A·arm·A bracket is the form least exposed to a drift, since
    // a tier that moved between the arms would also have moved between the
    // controls and shown up in the quiet mask, but the pin was absent and the
    // row did not know it. `tiers` below is the proof from here on.
    await page.goto(
      `/?xr=off&ride=0&mission=${MISSION}&edition=${EDITION}&autopilot=1&perf=1` +
        `&snap=${SNAP_AT}&${PINNED}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await page.keyboard.down('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.up('Enter')

    // Fly until the snap fires, so the panel carries a real in-flight reading —
    // GATES, a clock and a three-digit speed — rather than the launch banner,
    // which is the content whose legibility is the question.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as { __ff2?: { snap: () => { frozen: boolean } } }
            return w.__ff2?.snap().frozen ?? false
          }),
        { timeout: 240_000, intervals: [250] },
      )
      .toBe(true)
    const elapsed = await page.evaluate(() => {
      const w = globalThis as unknown as { __ff2?: { mission?: { elapsed?: number } } }
      return w.__ff2?.mission?.elapsed ?? 0
    })
    expect(elapsed, 'the snap fired before the ship was flying').toBeGreaterThanOrEqual(SNAP_AT)
    // The render settles on the frozen state; the waves and the particles run
    // on wall time and a frame or two after the freeze is fine.
    await page.waitForTimeout(1_500)

    // ── FREEZE the panel's CONTENT, so filtering is the only variable ─────
    //
    // `hudSignature` carries the rounded speed, so on a flight the canvas
    // changes on most frames — and two shots of DIFFERENT text differ for
    // reasons that have nothing to do with a mip chain. `freeze` paints never
    // again and holds whatever was last drawn (`createHudRedrawBudget`:
    // `repaints === 0 ? paint : false`), so thrown HERE rather than at boot it
    // holds a real in-flight panel instead of DEV-243's `press A`.
    const frozen = await setCadence(page, 'freeze')
    expect(frozen?.cadence, 'the cadence pin did not reach the panel').toBe('freeze')
    expect(
      frozen?.repaints ?? 0,
      'the panel was frozen before it had ever painted a flight — the crop would be a banner',
    ).toBeGreaterThan(5)
    await page.waitForTimeout(1_000)

    const rows: string[] = []
    /** Poses whose crop was too noisy to judge — asserted after BOTH have run. */
    const unquiet: string[] = []

    // ── THE SECOND SURFACE, and why it is the PLATE and not a second pose ──
    //
    // This spec's first version had an `edge` pose: drive the game's own
    // mouse-look, put the panel at the frame edge, and read the projection
    // there. **It refused itself and it was right to** — the panel came back
    // 1.7 % off centre against a bar of 15 %. The cause is in the game and not
    // in the harness: `input/look.ts`'s `FREE_LOOK_RETURN_TAU` is **0.18 s**,
    // so a flat view springs back to centre exponentially, and a screenshot
    // 1.2 s after the last mouse move is taken ~6.7 time constants in. **That
    // is true for a player too**: on flat there is no held peripheral view, so
    // there is no second pose to photograph.
    //
    // And it would not have answered the question anyway. Under a perspective
    // projection an off-axis surface at constant distance subtends MORE pixels
    // per metre, not fewer, so the periphery is MORE magnified — the wrong
    // direction for minification. The `edge` pose was aimed at a case that
    // cannot exist.
    //
    // What IS available is a second panel that is genuinely off-axis, static,
    // and built by the same code at the same pixel density: the **perf plate**
    // (DEV-160), which sits beside the HUD at `WIDTH / 2 + gap + PLATE_W / 2`
    // and is therefore at a different angle to the eye. Measuring it gives the
    // off-axis relation as a MEASUREMENT rather than as a cosine law — which is
    // DEV-041's rule, prefer the thing that cannot be wrong over the score that
    // is usually right, and CLAUDE.md's, compare against something outside the
    // one object you came for.
    const plate = await panelMetrics(page, 'perf-plate')
    if (plate) {
      console.info(
        `\n  perf-plate (the off-axis control, ?perf=1): ` +
          `${plate.texels.width}x${plate.texels.height} texels · ` +
          `${plate.pxPerTexelU.toFixed(2)} / ${plate.pxPerTexelV.toFixed(2)} px per texel · ` +
          `${plate.offNormalDeg.toFixed(1)}° off ITS normal · ` +
          `${(100 * plate.offCentre).toFixed(0)} % off frame centre`,
      )
      rows.push(
        `perf-plate (off-axis control): ${plate.pxPerTexelU.toFixed(2)} / ` +
          `${plate.pxPerTexelV.toFixed(2)} px per texel at ${plate.offNormalDeg.toFixed(1)}° ` +
          'off normal',
      )
    } else {
      rows.push('perf-plate: absent — run with ?perf=1 for the off-axis control')
    }

    for (const pose of ['seat'] as const) {
      const metrics = await panelMetrics(page, 'hud')
      expect(metrics, `no panel metrics at the ${pose} pose`).not.toBeNull()
      const m = metrics as PanelMetrics
      // The WORST row across u, not the mid-line — see `pxPerTexelWorst`. The
      // panel is raked, so one ratio taken across the middle is a MEAN and the
      // far edge can be minified while it reads comfortably over 1.
      const minified = m.pxPerTexelWorst < 1 || m.pxPerTexelV < 1
      // How much further off the panel's normal a WORN lean would have to get
      // before level 0 stops being the sampled level. DERIVED, under a
      // 1/cos(theta) footprint model, from the measured px/texel — so it is a
      // model's answer and not a measurement's, and it is labelled as one
      // (DEV-027). The perf-plate row above is the empirical check on the
      // model's DIRECTION; its size is still the model's.
      const marginDeg = (axis: number): number =>
        axis <= 1
          ? 0
          : (Math.acos(Math.min(1, Math.cos((m.offNormalDeg * Math.PI) / 180) / axis)) * 180) /
            Math.PI
      rows.push(
        `seat->minification margin (DERIVED, 1/cos model): ` +
          `${marginDeg(m.pxPerTexelU).toFixed(0)}° off normal across u, ` +
          `${marginDeg(m.pxPerTexelV).toFixed(0)}° across v`,
      )
      console.info(
        `\n  ${pose}: panel ${m.texels.width}x${m.texels.height} texels, ` +
          `backing scale ${m.backingScale.toFixed(2)}, crop ${m.clip.width}x${m.clip.height} css\n` +
          `    across u: ${m.pxPerTexelTop.toFixed(2)} far edge · ` +
          `${m.pxPerTexelU.toFixed(2)} mid · ${m.pxPerTexelBottom.toFixed(2)} near edge — ` +
          `WORST ${m.pxPerTexelWorst.toFixed(2)}\n` +
          `    across v: ${m.pxPerTexelV.toFixed(2)} · ${m.offNormalDeg.toFixed(1)}° off the ` +
          `panel's normal · ${(100 * m.offCentre).toFixed(0)} % off frame centre\n` +
          `    => ${minified ? 'MINIFIED somewhere on the panel, so the chain IS sampled and nomip changes pixels' : 'MAGNIFIED everywhere, so the hardware takes magFilter and level 0 and the chain is INERT here'}`,
      )
      rows.push(
        `${pose}: px/texel u ${m.pxPerTexelTop.toFixed(2)}/${m.pxPerTexelU.toFixed(2)}/` +
          `${m.pxPerTexelBottom.toFixed(2)} far/mid/near (worst ${m.pxPerTexelWorst.toFixed(2)}), ` +
          `v ${m.pxPerTexelV.toFixed(2)}, ${m.offNormalDeg.toFixed(1)}° off normal — ` +
          `${minified ? 'MINIFIED somewhere' : 'magnified everywhere'}`,
      )

      /** DEV-245: what tier each shot was taken on, asserted once at the end. */
      const tiers: { label: string; state: DrawState }[] = []

      const shoot = async (label: string): Promise<Buffer> => {
        tiers.push({ label, state: await drawState(page) })
        const shot = await page.screenshot({ clip: m.clip })
        const file = path.join(OUT, `${MISSION}-${pose}-${label}.png`)
        fs.writeFileSync(file, shot)
        await testInfo.attach(`${MISSION}-${pose}-${label}.png`, {
          body: shot,
          contentType: 'image/png',
        })
        return shot
      }
      /** The whole frame, once per pose, so the crop is readable in context. */
      const wide = await page.locator('#viewport').screenshot()
      fs.writeFileSync(path.join(OUT, `${MISSION}-${pose}-frame.png`), wide)
      await testInfo.attach(`${MISSION}-${pose}-frame.png`, {
        body: wide,
        contentType: 'image/png',
      })

      // ── A · arm · A · arm · A ──────────────────────────────────────────
      const shipped: Buffer[] = []
      const arms: Buffer[] = []
      for (let k = 0; k < 2; k++) {
        const a = await setUpload(page, 'mip')
        expect(a?.liveUpload, 'the mip arm did not reach the texture').toBe('mip')
        await page.waitForTimeout(900)
        shipped.push(await shoot(`A${k}-mip`))

        const b = await setUpload(page, 'nomip')
        expect(b?.liveUpload, 'the nomip arm did not reach the texture').toBe('nomip')
        expect(b?.mipBytes, 'nomip left a chain on the texture').toBe(0)
        expect(b?.mipLevels).toBe(1)
        await page.waitForTimeout(900)
        arms.push(await shoot(`nomip-${k}`))
      }
      const last = await setUpload(page, 'mip')
      expect(last?.liveUpload).toBe('mip')
      await page.waitForTimeout(900)
      shipped.push(await shoot('A2-mip'))

      // ── DID THE PIN HOLD? DEV-245 ──────────────────────────────────────
      //
      // Thrown, not collected, and that is deliberate against the rule two
      // paragraphs down: a quiet mask that came back small is a READING about
      // this pose and the other pose deserves its own. A tier that moved is
      // not a reading at all — MSAA and the framebuffer scale ARE the
      // filtering this spec is measuring, so an arm taken on another tier is
      // measuring a different thing and there is nothing to collect.
      const baseTier = tiers[0] as { label: string; state: DrawState }
      console.info(`    ${drawStateLine(baseTier.state)}  (at ${baseTier.label})`)
      expect(
        tiers.slice(1).flatMap(({ label, state }) => {
          const moved = drawStateDiff(baseTier.state, state)
          return moved.length > 0 ? [`${baseTier.label} -> ${label}: ${moved.join(', ')}`] : []
        }),
        'the quality tier MOVED between two shots of this pose. MSAA and the framebuffer ' +
          'scale are filtering, which is the whole subject here, so an arm on another tier ' +
          'is not an arm of this comparison',
      ).toEqual([])

      const first = shipped[0] as Buffer
      const tail = shipped[shipped.length - 1] as Buffer
      const mask = stableMask(first, tail)
      console.info(
        `    quiet mask keeps ${(100 * mask.share).toFixed(1)} % of the crop ` +
          `(first shipped shot against the last, ${shipped.length} of them)`,
      )
      // A mask that kept almost nothing would let anything through. The panel's
      // own pixels are frozen and the sim is snapped, so most of the crop
      // SHOULD be quiet; if it is not, nothing below this line means anything.
      //
      // **COLLECTED, NOT THROWN.** The first version of this spec asserted here
      // and the `seat` pose failed, so the `edge` pose — the only one where the
      // panel can be minified, and therefore the only one where the mip chain
      // could matter — produced no data at all on the run that was meant to
      // price it. That is DEV-241's own mistake in a new file, and its header
      // had already written it down: *"a table you cannot read because its
      // first row failed is the same mistake as a filtered `pnpm e2e`."*
      if (mask.share <= 0.5) {
        unquiet.push(
          `${pose}: the quiet mask kept only ${(100 * mask.share).toFixed(1)} % of the crop`,
        )
      }

      for (const [k, arm] of arms.entries()) {
        const a = shipped[k] as Buffer
        const b = shipped[k + 1] as Buffer
        const pair = comparePng(a, arm)
        const control = comparePng(a, b)
        const movedPair = pixelsMoved(a, arm, mask.keep)
        const movedControl = pixelsMoved(a, b, mask.keep)
        const verdict =
          pair && control && pair.mean > control.mean * 1.5 ? 'DIFFERS' : 'inside the noise'
        console.info(
          `    nomip #${k}  mean ${pair?.mean.toFixed(2).padStart(6)} vs control ` +
            `${control?.mean.toFixed(2).padStart(6)}  ·  quiet px ` +
            `${String(movedPair).padStart(6)} vs ${String(movedControl).padStart(6)}` +
            `  ·  ${verdict}`,
        )
        rows.push(
          `  ${pose}/nomip#${k}: mean ${pair?.mean.toFixed(2)} vs ${control?.mean.toFixed(2)}, ` +
            `${movedPair} quiet px vs ${movedControl} — ${verdict}`,
        )
      }

      // ── THE CRAWL, AND WHY IT IS NOT HERE ────────────────────────────
      //
      // The first version of this spec measured one: four consecutive shots of
      // each arm, and the mean frame-to-frame change as a proxy for shimmer,
      // on the argument that "the ship is flying, so the eye moves on its own".
      //
      // **`?snap=` took the motion away, and the snap is not optional** — it is
      // the only thing that makes the crop quiet enough to read (the run
      // without it kept 36.3 % of the crop against a bar of 50; with it, 99.8).
      // So the two requirements are in direct conflict: a crawl needs the eye
      // to move, a quiet mask needs it not to, and a "crawl" measured on a
      // frozen eye is the wave phase drifting behind an 86 %-opaque plate
      // wearing a filtering statistic's name. The numbers it produced on the
      // snapped run (mip 2.485, nomip 3.072 mean levels per step) are exactly
      // that and are NOT evidence about filtering.
      //
      // The A/B above already answers the question the crawl was for, and
      // answers it better: if both arms sampled level 0 with the same linear
      // magFilter the crops would be IDENTICAL, so a `DIFFERS` verdict is
      // itself the finding that some of the panel is minified — which is what
      // `pxPerTexelWorst` then localises to the raked far edge.
      //
      // A real crawl measurement wants an unsnapped run with the crop taken
      // INSIDE one plate, where the background contributes 14 % instead of
      // 100. That is a second spec and it is not this one.
      await setUpload(page, 'mip')
    }

    console.info(`\n  DEV-244 summary\n${rows.map((r) => `    ${r}`).join('\n')}`)
    for (const r of rows) testInfo.annotations.push({ type: 'dev-244', description: r })

    // Every pose printed BEFORE anything is judged — see the collection above.
    expect(
      unquiet,
      'two shots of the shipped panel agree on less than half the crop. Every pixel of this ' +
        'crop has world behind it — the plates are 86 % opaque and there are gaps between ' +
        'them — so either `?snap=` did not freeze the ship, or `__ff2.hud("freeze")` did not ' +
        'hold the canvas. No filtering claim can be read off a crop this noisy.',
    ).toEqual([])

    // A page error here would mean a texture state three could not honour.
    expect(problems.list(), 'page errors — a bad texture parameter lands here').toEqual([])
  })
})

test.describe('@gpu DEV-256 — the software canvas must change NO pixel', () => {
  test.setTimeout(900_000)

  /**
   * `?hudRaster=cpu` asks Chromium for a software 2-D canvas
   * (`willReadFrequently: true`). Software and GPU raster of the same 2-D
   * calls are **intended** to be identical, and HUD-REDESIGN §5.1 lists
   * "changes no pixel" as a property of the option — so this is the spec that
   * turns that sentence from an assumption into a photograph.
   *
   * **The software canvas SHIPS since DEV-256 / `07bf549` (2026-09-20), so
   * the claim is now about the panel a player gets** rather than about an arm
   * behind a URL parameter, and `?hudRaster=gpu` is the way back. That flip is
   * also why this spec was red on `main` for a day: it asserted the shipped
   * arm as the literal `'gpu'`. Every arm below is DERIVED from the build's
   * own `HUD_RASTER_SHIPPED` now — see `SHIPPED` at the top of this file, and
   * DEV-266 for why a default with two copies is a default that goes stale.
   *
   * Unlike DEV-244 above, this arm touches nothing about FILTERING: the
   * texture keeps its chain, its `LinearMipmapLinearFilter` and its
   * `anisotropy = 4`. So the expected answer here is genuinely zero, where
   * DEV-244's expected answer was "something, at the raked edge".
   *
   * ── THE GUARD THAT STOPS THIS PASSING VACUOUSLY ───────────────────────
   *
   * `setRaster` REBUILDS the canvas and **carries the old pixels across** with
   * one `drawImage`, so the panel does not blink. That carry is exactly the
   * kind of thing that makes a comparison zero by construction — DEV-241's own
   * mistake, and the header of this file already records paying for it once.
   *
   * What saves it is the debt: a flip marks the panel as OWING a paint, and
   * the next admitted `update()` runs the real `draw()` — `clearRect` and all
   * ~22 calls — **through the new backend**, overwriting every carried pixel.
   * So the shot is of a natively rastered canvas, and the proof that it is is
   * arithmetic: **`repaints` must go UP across every flip**, asserted on each
   * one. If it does not, the crop is the carried pixels and the run is
   * refused rather than passed.
   *
   * That is also why the cadence is NOT frozen here, where DEV-244's case
   * freezes it. `?snap=` already stops the ship, the clock and the score, so
   * `hudSignature` does not move and the panel repaints only when it owes —
   * which is once per flip, exactly the frames this needs and no others.
   *
   * ── WHERE THE CLAIM IS MEASURED, AND WHY IT IS NOT THE SCREEN CROP ────
   *
   * The first version of this test gated on the screen crop, the way DEV-244's
   * does, and it was **refused by its own control**. Measured here, 2026-09-20,
   * `int_01_hoverJet` at the seat, 404 x 168 css crop — and taken BEFORE
   * DEV-256 shipped, so the control there is `gpu` and the arm `cpu`, which is
   * the way round the labels below now run (DEV-266). The numbers are left as
   * they were recorded; what they are evidence FOR does not depend on which
   * arm was the default that day:
   *
   *     cpu #0   mean 2.107  vs control 1.365   ·  quiet px 1088 vs 4597
   *     cpu #1   mean 3.325  vs control 3.293   ·  quiet px 5277 vs 5085
   *
   * **The control is two shots of the then-shipped canvas and it moves ~5,000
   * of 67,872 pixels — 7 % of the crop.** The arm's numbers sit inside that, and
   * they sit inside it INCONSISTENTLY: on the first bracket the arm moved a
   * QUARTER of the pixels its own control did while its mean was 1.5x as
   * large. Two statistics disagreeing about the direction is the signature of
   * both being noise.
   *
   * The cause is in this file's own header: the plates are 86 % opaque and
   * there are gaps between them, so **every pixel of this crop has world
   * behind it**, and `?snap=` freezes the sim while the ocean's wave phase and
   * the particles run on the RENDER clock. DEV-244 could live with that
   * because it was asking *"is there a visible difference at the raked edge"*
   * against a 1.5x bar. This row is asking *"are these two rasters the same"*,
   * and a 7 % noise floor cannot answer a question about exact equality.
   *
   * CLAUDE.md, trap 23: **when a candidate set all fails to separate, the
   * sample is wrong, not the question.** So the gate moved to the surface the
   * claim is about — `getImageData` on the panel's own canvas, which has
   * nothing composited over it, nothing behind it and no filtering in front of
   * it. That comparison is exact and its noise floor is provably zero, because
   * the same-arm control pairs are asserted byte-identical too.
   *
   * The crop is still shot, still bracketed and still printed: it is the
   * player-visible record and the thing a human looks at. It just is not what
   * decides, and the numbers above are why.
   *
   * ── No `?perf=1` ──────────────────────────────────────────────────────
   *
   * The perf plate is a SECOND canvas beside the panel and this arm does not
   * touch it, so it could only add a moving object next to the crop.
   * `quality-pin.ts`'s `drawState` reads `__ff2.render.quality.report`, not
   * `__ff2perf`, so the tier guard survives without it.
   */
  test('gpu against cpu, at the seat, with the repaint proved', async ({ page }, testInfo) => {
    const problems = watchPageErrors(page)
    const out = process.env.HUD_RASTER_PHOTO_DIR ?? `${OUT}-raster`
    fs.mkdirSync(out, { recursive: true })

    await page.goto(
      `/?xr=off&ride=0&mission=${MISSION}&edition=${EDITION}&autopilot=1` +
        `&snap=${SNAP_AT}&${PINNED}`,
    )
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await page.keyboard.down('Enter')
    await page.waitForTimeout(200)
    await page.keyboard.up('Enter')

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as { __ff2?: { snap: () => { frozen: boolean } } }
            return w.__ff2?.snap().frozen ?? false
          }),
        { timeout: 240_000, intervals: [250] },
      )
      .toBe(true)
    const elapsed = await page.evaluate(() => {
      const w = globalThis as unknown as { __ff2?: { mission?: { elapsed?: number } } }
      return w.__ff2?.mission?.elapsed ?? 0
    })
    expect(elapsed, 'the snap fired before the ship was flying').toBeGreaterThanOrEqual(SNAP_AT)
    await page.waitForTimeout(1_500)

    // The panel starts on the SHIPPED arm, which is what "no pin" means — and
    // `SHIPPED` is read off the build, not spelled here. See its comment.
    const born = await readHud(page)
    expect(born, 'no HUD report — is there a flight?').not.toBeNull()
    expect(born?.raster, `an unpinned load is not the shipped raster (${SHIPPED})`).toBe(SHIPPED)
    expect(
      born?.liveRaster,
      `the live 2-D context disagrees with the intent on a load nobody pinned (${SHIPPED})`,
    ).toBe(SHIPPED)
    expect(born?.rasterRebuilds, 'something rebuilt the canvas before the run started').toBe(0)
    expect(
      born?.repaints ?? 0,
      'the panel was read before it had ever painted a flight — the crop would be a banner',
    ).toBeGreaterThan(5)

    const metrics = await panelMetrics(page, 'hud')
    expect(metrics, 'no panel metrics at the seat').not.toBeNull()
    const m = metrics as PanelMetrics
    console.info(
      `\n  seat: panel ${m.texels.width}x${m.texels.height} texels, ` +
        `crop ${m.clip.width}x${m.clip.height} css, ` +
        `${m.pxPerTexelWorst.toFixed(2)} px/texel at worst`,
    )

    const rows: string[] = []
    const tiers: { label: string; state: DrawState }[] = []
    /** One canvas digest per shot, in order — the thing the verdict rests on. */
    const digests: { label: string; digest: CanvasDigest }[] = []
    const shoot = async (label: string): Promise<Buffer> => {
      tiers.push({ label, state: await drawState(page) })
      const shot = await page.screenshot({ clip: m.clip })
      fs.writeFileSync(path.join(out, `${MISSION}-seat-${label}.png`), shot)
      await testInfo.attach(`${MISSION}-seat-${label}.png`, {
        body: shot,
        contentType: 'image/png',
      })
      return shot
    }

    /**
     * Flip, prove the flip landed AND that it produced a native repaint, then
     * shoot. Both halves are needed and they fail differently: a pin that did
     * not reach the context is a broken switch, and a flip with no repaint
     * behind it is a photograph of the carried pixels.
     */
    const arm = async (mode: string, label: string): Promise<Buffer> => {
      // Read the counter IMMEDIATELY before the flip, not once at the top of
      // the run. A high-water mark carried across the whole bracket would let
      // a flip with no repaint behind it pass on the strength of some EARLIER
      // flip's repaint, which is the same class of hole as differencing a
      // column of sentinels (HUD-REWORK §3, trap 3).
      const before = await readHud(page)
      const probe = await setRaster(page, mode)
      expect(probe?.raster, `the ${mode} arm was not accepted`).toBe(mode)
      expect(probe?.liveRaster, `the ${mode} arm did not reach the 2-D context`).toBe(mode)
      // The panel is rebuilt on a real change, so the texture must be intact
      // afterwards: this arm is NOT a filtering change and anything that moved
      // the chain would make the comparison below one of DEV-244's, not this
      // one's.
      expect(probe?.mipLevels, `the ${mode} arm lost the mip chain`).toBe(born?.mipLevels)
      expect(probe?.mipBytes, `the ${mode} arm lost the mip chain`).toBe(born?.mipBytes)
      // Give the owed repaint a frame or two, then PROVE it happened.
      await page.waitForTimeout(900)
      const after = await readHud(page)
      expect(
        after?.repaints ?? 0,
        `no repaint after the ${label} flip — the crop would be the pixels the rebuild ` +
          'carried over, and the comparison would be zero by construction',
      ).toBeGreaterThan(before?.repaints ?? 0)
      // The canvas FIRST, then the screen. The canvas is what decides and it
      // is read off the surface the flip rebuilt; the screenshot is the
      // player-visible record taken of the same state a moment later.
      const digest = await captureCanvas(page, label)
      expect(digest, `could not read the panel's canvas at ${label}`).not.toBeNull()
      const d = digest as CanvasDigest
      expect(d.width, 'the canvas changed size across a flip').toBe(560)
      expect(d.height, 'the canvas changed size across a flip').toBe(203)
      // THE GUARD THAT STOPS EQUALITY BEING TRIVIAL. Two blank canvases hash
      // the same, so a byte-identical result proves nothing until something
      // says there is ink on the surface. The panel's three plates alone cover
      // most of it; a tenth of the pixels is a floor no drawn panel can miss
      // and no blank one can reach.
      expect(
        d.ink / (d.width * d.height),
        `the canvas at ${label} is essentially empty — an equality result off a blank ` +
          'surface is zero by construction, not a finding',
      ).toBeGreaterThan(0.1)
      digests.push({ label, digest: d })
      return shoot(label)
    }

    /** The whole frame once, so the crop is readable in context. */
    const wide = await page.locator('#viewport').screenshot()
    fs.writeFileSync(path.join(out, `${MISSION}-seat-frame.png`), wide)
    await testInfo.attach(`${MISSION}-seat-frame.png`, { body: wide, contentType: 'image/png' })

    // ── A · arm · A · arm · A, the same bracket DEV-241 argued for ──────
    //
    // Every shot is taken just after its own flip, so the controls and the
    // arms are symmetric: each is a freshly rastered canvas on the backend its
    // label names. A control that was NOT re-rastered would be comparing a
    // stale frame against a fresh one and the noise floor would be wrong.
    const shipped: Buffer[] = []
    const arms: Buffer[] = []
    // Start on the WAY-BACK arm without shooting, so that every `arm()` below
    // — controls included — is a genuine flip from the other mode and
    // therefore a genuine re-raster. A control shot taken off a page that had
    // simply not changed would be measuring a stale frame against a fresh one,
    // and the noise floor the verdict rests on would be the wrong quantity.
    //
    // DEV-266: the control is the SHIPPED arm and the arm is the way back,
    // both derived. Before DEV-256 shipped `cpu` those were `gpu` and `cpu`
    // spelled literally, and after it they were the wrong way round — the
    // array called `shipped` held the arm nobody gets. The equality claim
    // below is symmetric, so nothing about the verdict changed; what changed
    // is that the words now name the right canvas, and the bracket still
    // sandwiches the arm between two captures of the panel a player sees.
    await setRaster(page, WAY_BACK)
    for (let k = 0; k < 2; k++) {
      shipped.push(await arm(SHIPPED, `A${k}-${SHIPPED}`))
      arms.push(await arm(WAY_BACK, `${WAY_BACK}-${k}`))
    }
    shipped.push(await arm(SHIPPED, `A2-${SHIPPED}`))

    const baseTier = tiers[0] as { label: string; state: DrawState }
    console.info(`    ${drawStateLine(baseTier.state)}  (at ${baseTier.label})`)
    expect(
      tiers.slice(1).flatMap(({ label, state }) => {
        const moved = drawStateDiff(baseTier.state, state)
        return moved.length > 0 ? [`${baseTier.label} -> ${label}: ${moved.join(', ')}`] : []
      }),
      'the quality tier MOVED between two shots. MSAA and the framebuffer scale are in every ' +
        'pixel of this crop, so an arm on another tier is not an arm of this comparison',
    ).toEqual([])

    const first = shipped[0] as Buffer
    const tail = shipped[shipped.length - 1] as Buffer
    const mask = stableMask(first, tail)
    console.info(
      `    quiet mask keeps ${(100 * mask.share).toFixed(1)} % of the crop ` +
        `(first shipped shot against the last, ${shipped.length} of them)`,
    )
    rows.push(`quiet mask ${(100 * mask.share).toFixed(1)} % of the crop`)

    // ── The crop, REPORTED and not judged ──────────────────────────────
    //
    // Kept because it is the player-visible record and because its numbers are
    // the evidence for the paragraph in the header that says why it is not the
    // gate. Printing a measurement that cannot decide, and saying that it
    // cannot, is worth more than deleting it.
    for (const [k, shot] of arms.entries()) {
      const a = shipped[k] as Buffer
      const b = shipped[k + 1] as Buffer
      const pair = comparePng(a, shot)
      const control = comparePng(a, b)
      const movedPair = pixelsMoved(a, shot, mask.keep)
      const movedControl = pixelsMoved(a, b, mask.keep)
      console.info(
        `    ${WAY_BACK} #${k}  mean ${pair?.mean.toFixed(3).padStart(7)} vs control ` +
          `${control?.mean.toFixed(3).padStart(7)}  ·  quiet px ` +
          `${String(movedPair).padStart(6)} vs ${String(movedControl).padStart(6)}` +
          '  ·  reported, not judged — see the header',
      )
      rows.push(
        `crop ${WAY_BACK}#${k}: mean ${pair?.mean.toFixed(3)} vs control ` +
          `${control?.mean.toFixed(3)}, ` +
          `${movedPair} quiet px vs ${movedControl} (noise floor; not the gate)`,
      )
    }

    // ── THE VERDICT, on the canvas ─────────────────────────────────────
    //
    // Two things are asserted and the order matters. First the CONTROL: two
    // shipped captures must be byte-identical, which is what says the panel's
    // content is genuinely still and that this comparison has a zero noise
    // floor. Without it a difference between the arms could just be the panel
    // having drawn something else, and the arm would be blamed for the clock.
    //
    // Then the arm. `willReadFrequently` is a hint about WHERE the raster
    // happens, not about what it draws, so the expected answer is exact
    // equality — and a difference is a real finding about Chromium's two 2-D
    // backends, to be written into the ledger row rather than thresholded
    // past.
    const labels = digests.map((d) => d.label)
    console.info(
      `\n    canvas: ${digests
        .map((d) => `${d.label} ${d.digest.hash.toString(16).padStart(8, '0')}`)
        .join(' · ')}`,
    )
    const ink = (digests[0] as { digest: CanvasDigest }).digest.ink
    rows.push(
      `canvas 560x203, ${ink} px of ink (${((100 * ink) / (560 * 203)).toFixed(1)} % of the surface)`,
    )

    /** Every pair that must be byte-identical, and what a difference would mean. */
    const pairs: { a: string; b: string; why: string }[] = [
      {
        a: `A0-${SHIPPED}`,
        b: `A1-${SHIPPED}`,
        why: 'two shipped captures — the zero noise floor',
      },
      {
        a: `A1-${SHIPPED}`,
        b: `A2-${SHIPPED}`,
        why: 'two shipped captures — the zero noise floor',
      },
      { a: `A0-${SHIPPED}`, b: `${WAY_BACK}-0`, why: 'the arm against the control before it' },
      { a: `A1-${SHIPPED}`, b: `${WAY_BACK}-1`, why: 'the arm against the control before it' },
    ]
    const moved: string[] = []
    for (const { a, b, why } of pairs) {
      expect(labels, `missing a capture for ${a} / ${b}`).toEqual(expect.arrayContaining([a, b]))
      const diff = await diffCanvas(page, a, b)
      expect(diff, `could not diff ${a} against ${b}`).not.toBeNull()
      const { diffPixels, maxDelta } = diff as { diffPixels: number; maxDelta: number }
      const line = `${a} vs ${b}: ${diffPixels} px differ, max channel delta ${maxDelta} — ${why}`
      console.info(`    ${line}`)
      rows.push(`canvas ${line}`)
      if (diffPixels > 0) moved.push(line)
    }

    console.info(`\n  DEV-256 summary\n${rows.map((r) => `    ${r}`).join('\n')}`)
    for (const r of rows) testInfo.annotations.push({ type: 'dev-256', description: r })

    // Collected and thrown at the END, so every pair is printed whichever one
    // moves: a table you cannot read because its first row failed is the same
    // mistake as a filtered `pnpm e2e`.
    expect(
      moved,
      'HUD-REDESIGN §5.1 says the software canvas changes no pixel, and these are the panel’s ' +
        'OWN pixels with nothing composited over them. A same-arm pair that differs means the ' +
        'panel was not still and nothing below it means anything; a cross-arm pair that differs ' +
        'is a FINDING about Chromium’s two 2-D backends and belongs in the ledger row — do ' +
        'not raise a threshold past it',
    ).toEqual([])

    // Put the shipped arm back, so nothing downstream inherits the arm.
    await setRaster(page, SHIPPED)
    expect(problems.list(), 'page errors — a rebuilt canvas or texture lands here').toEqual([])
  })
})
