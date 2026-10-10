/**
 * tests/e2e/fixtures/shadow-box.ts — where the sun map's box edge is, per pixel.
 *
 * DEV-453. The line Matt reported is the box's edge on the ground, and a pixel
 * test of it has to know which pixels are just inside it and which are just
 * outside — a band of screen that moves with every camera, every sun and every
 * hill in between. Guessing it from a picture is how the first probe of this
 * row misread a terrain shadow's edge as the box's (the ridge's shade line and
 * the box's face both ran across the same valley, ~150 px apart).
 *
 * So this asks the page, in the page, with nothing but numbers the running
 * game already holds:
 *
 *   - the CAMERA's projection inverse and world matrix, for each pixel's ray;
 *   - the LAND's collision field (`__ff2.heightFields().autopilot[0]`), which
 *     the ray is marched over and bisected into — the same bilinear read as
 *     `sim/terrain/height-field.ts`'s `terrainHeightAt`, restated because an
 *     e2e spec cannot import the sim's terrain chain (it reaches an
 *     `import.meta.glob` and Playwright then collects nothing);
 *   - the sun's `shadow.matrix` and `shadow.camera` extents — THREE's own
 *     matrix, the one the shader samples through, never a re-derived one.
 *
 * and returns, per sampled pixel, the SIGNED distance in metres from the
 * ground under it to the nearest face the fade honours: the four lateral faces
 * and the far depth plane (`render/shadows.ts`'s `shadowEdgeFadeUv` says why
 * not the near one). Positive inside. NaN where the ray meets no land.
 *
 * ── What it cannot see, and the margin that pays for it ──────────────────
 *
 * The collision field is not the drawn surface: it has no jitter and it is not
 * facetised, and CLAUDE.md's `heightField` trap measured the gap at up to
 * 21.8 m on steep desert. A grazing ray turns a vertical gap into a longer
 * horizontal one. And a tree in front of the ground is judged by the ground
 * behind it. So a claim about "the pixels just outside" is made past a margin,
 * never at the metre. The spec says how wide.
 *
 * Pure reads: nothing here moves the camera, the light or the preset.
 */
import type { Page } from '@playwright/test'

export interface ShadowBoxMask {
  readonly width: number
  readonly height: number
  /** Every `stride`-th pixel on both axes was marched. */
  readonly stride: number
  /** Row-major, `ceil(width / stride)` per row. Metres, positive inside. */
  readonly dist: readonly number[]
  /** The box's own extents: lateral width, lateral height, depth range. Metres. */
  readonly extents: readonly [number, number, number]
}

/** Signed metres to the box edge at screenshot pixel (x, y). NaN off the land. */
export const boxDistanceAt = (mask: ShadowBoxMask, x: number, y: number): number => {
  const cols = Math.ceil(mask.width / mask.stride)
  return mask.dist[Math.floor(y / mask.stride) * cols + Math.floor(x / mask.stride)] ?? Number.NaN
}

export const shadowBoxMask = (
  page: Page,
  width: number,
  height: number,
  stride: number,
): Promise<ShadowBoxMask> =>
  page.evaluate(
    ({ width, height, stride }) => {
      type Elements = { elements: number[] }
      interface Field {
        vertPerSide: number
        heights: Float32Array
        step: number
        terrainHeight: number
        originX: number
        originY: number
        originZ: number
        scaleX: number
        scaleY: number
        scaleZ: number
      }
      const w = globalThis as unknown as {
        __ff2: {
          render: {
            camera: {
              updateMatrixWorld(): void
              projectionMatrixInverse: Elements
              matrixWorld: Elements
            }
            scene: { traverse(f: (o: unknown) => void): void }
          }
          heightFields(): { autopilot: Field[] }
        }
      }
      const cam = w.__ff2.render.camera
      cam.updateMatrixWorld()
      const Pi = cam.projectionMatrixInverse.elements
      const Mw = cam.matrixWorld.elements
      const f = w.__ff2.heightFields().autopilot[0]
      if (!f) throw new Error('shadow-box: no land field on __ff2.heightFields()')
      let S: number[] | null = null
      let extents: [number, number, number] = [0, 0, 0]
      w.__ff2.render.scene.traverse((o) => {
        const l = o as {
          isDirectionalLight?: boolean
          castShadow?: boolean
          shadow: {
            matrix: Elements
            camera: {
              left: number
              right: number
              top: number
              bottom: number
              near: number
              far: number
            }
          }
        }
        if (l.isDirectionalLight && l.castShadow) {
          S = l.shadow.matrix.elements
          const c = l.shadow.camera
          extents = [c.right - c.left, c.top - c.bottom, c.far - c.near]
        }
      })
      if (!S) throw new Error('shadow-box: no shadow-casting directional light in the scene')
      const Sm: number[] = S
      const n = f.vertPerSide
      const grid = (ix: number, iz: number): number => {
        const cx = ix < 0 ? 0 : ix > n - 1 ? n - 1 : ix
        const cz = iz < 0 ? 0 : iz > n - 1 ? n - 1 : iz
        return f.heights[cz * n + cx] as number
      }
      // THREE (x, z) -> the land's THREE y. Sim z is THREE's negated.
      const groundAt = (x: number, zThree: number): number => {
        const gx = (x - f.originX) / (f.scaleX || 1) / f.step
        const gz = (-zThree - f.originZ) / (f.scaleZ || 1) / f.step
        const ix = Math.floor(gx)
        const iz = Math.floor(gz)
        const fx = gx - ix
        const fz = gz - iz
        const a = grid(ix, iz) + (grid(ix + 1, iz) - grid(ix, iz)) * fx
        const b = grid(ix, iz + 1) + (grid(ix + 1, iz + 1) - grid(ix, iz + 1)) * fx
        return f.originY + (a + (b - a) * fz) * f.terrainHeight * (f.scaleY || 1)
      }
      const mul = (m: number[], x: number, y: number, z: number): number[] => {
        const e = (i: number) => m[i] as number
        return [
          e(0) * x + e(4) * y + e(8) * z + e(12),
          e(1) * x + e(5) * y + e(9) * z + e(13),
          e(2) * x + e(6) * y + e(10) * z + e(14),
          e(3) * x + e(7) * y + e(11) * z + e(15),
        ]
      }
      const unproject = (nx: number, ny: number, nz: number): number[] => {
        const v = mul(Pi, nx, ny, nz)
        const vw = v[3] as number
        return mul(Mw, (v[0] as number) / vw, (v[1] as number) / vw, (v[2] as number) / vw)
      }
      const dist: number[] = []
      for (let py = 0; py < height; py += stride) {
        for (let px = 0; px < width; px += stride) {
          const nx = (2 * (px + 0.5)) / width - 1
          const ny = 1 - (2 * (py + 0.5)) / height
          const a = unproject(nx, ny, -1)
          const b = unproject(nx, ny, 1)
          const ox = a[0] as number
          const oy = a[1] as number
          const oz = a[2] as number
          let dx = (b[0] as number) - ox
          let dy = (b[1] as number) - oy
          let dz = (b[2] as number) - oz
          const len = Math.hypot(dx, dy, dz)
          dx /= len
          dy /= len
          dz /= len
          const below = (t: number): boolean => oy + dy * t <= groundAt(ox + dx * t, oz + dz * t)
          // March out with a step that grows with range, then bisect the crossing.
          let t = 0
          let prev = 0
          let hit = -1
          while (t < 9000) {
            if (below(t)) {
              let lo = prev
              let hi = t
              for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2
                if (below(mid)) hi = mid
                else lo = mid
              }
              hit = hi
              break
            }
            prev = t
            t += Math.max(1, t * 0.004)
          }
          if (hit < 0) {
            dist.push(Number.NaN)
            continue
          }
          const s = mul(Sm, ox + dx * hit, oy + dy * hit, oz + dz * hit)
          const sw = s[3] as number
          const u = (s[0] as number) / sw
          const v = (s[1] as number) / sw
          const d = (s[2] as number) / sw
          const lateral = Math.min(
            u * extents[0],
            (1 - u) * extents[0],
            v * extents[1],
            (1 - v) * extents[1],
          )
          dist.push(Math.min(lateral, (1 - d) * extents[2]))
        }
      }
      return { width, height, stride, dist, extents }
    },
    { width, height, stride },
  )
