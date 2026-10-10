/**
 * tests/e2e/title-foreground.spec.ts — nothing may stand in front of the logo.
 *
 * DEV-287. Matt, 2026-09-21: *"in the titlescreen [remove] the nearest large
 * foreground tree."* There was one, and it covered **32.8 % of the frame** —
 * a 420x720 px column across the right half of FACETED FLIGHT, on the first
 * screen a stranger sees. It had been there since DEV-155 put the title
 * screen in a forest, through every session since, and nothing could see it:
 * the existing title specs assert positions and counts and every one of them
 * was correct (DEV-044, the same blind spot from the other side).
 *
 * ── It is a MEASUREMENT first and an assertion second ────────────────────
 *
 * Authoring a no-prop volume needs two numbers nobody can eyeball: WHICH prop
 * is in the way, and WHERE it stands in the frame `content/no-prop-volumes.json`
 * is written in. Both come out of this spec, and it writes the whole ranked
 * census to `TITLE_CENSUS_OUT` (default `title-foreground-census.json`) so the
 * next volume is a `cat` and a paste rather than a research project. The top
 * rows are printed.
 *
 * ── Why it is measured through the LIVE camera ───────────────────────────
 *
 * Because reasoning about it did not work, twice. `TITLE_2016.cameraYaw` is a
 * WORLD yaw and `TITLE_2016.cameraMesh` is in the terrain's mesh frame, and
 * the valley carries an 86.8-degree rotation between them; two readings of
 * "which way is the camera looking" put the offending tree on OPPOSITE SIDES
 * of the screen, and a check against the logo's known bearing failed to
 * separate them. So nothing here derives a frame: it projects the composed
 * instance matrix through `render.camera` and reads pixels.
 *
 * ── And the PLACEMENT is recovered, then proved ──────────────────────────
 *
 * The drawn matrix is `root * child * source` and only `root`'s translation is
 * the placement — for the menu's Materialized Mesh palette `child` carries
 * 36..63 m of offset (`load-environment.ts`'s `meshTransform` says so in as
 * many words), so the matrix's own translation is not a coordinate anyone can
 * author against. This inverts `childMatrixOf` to get `root` back, and then
 * PROVES the recovery rather than asserting it: every recovered placement must
 * land on the scatter's own 4 m texel grid, which it cannot do by accident and
 * which is false for every way of getting the inverse wrong. That is the same
 * shape as trap 24 — assert the relationship, not the value.
 *
 * ── If this spec ever photographs anything, pin the quality tier ─────────
 *
 * It does not today: it reads matrices, not pixels, which is why
 * `e2e-photo-pin-debt.test.ts` does not classify it as a photo spec. But it is
 * exactly the file that will grow a frame one day — its whole subject is what
 * the title screen looks like.
 *
 * When it does, add the quality pin from `tests/e2e/fixtures/quality-pin.ts` to
 * the navigation above. A starved frame drops a quality tier, and a tier drop
 * moves MSAA, the framebuffer scale, the shadow map and the prop LOD — all of
 * which change how much of the frame a tree covers, which is the one number
 * this file exists to measure. Do NOT instead add this file's name to that
 * guard's frozen ledger: the list only ever shrinks, and a new name in it would
 * be a frame taken on a tier nobody chose to accept. The guard's own message
 * offers both branches and the wrong one reads first.
 *
 * **And do not quote that guard's two marker strings in here.** Its classifier
 * is a SUBSTRING match over the whole file — a screenshot call for *is this a
 * photo spec*, the pin's constant for *is it pinned* — so quoting either in a
 * comment answers its question with prose. The first draft of this block did
 * both at once and made this file read as a pinned photo spec, which it is not
 * and which would have kept the guard quiet the day somebody added a real
 * screenshot here. Describe them; do not spell them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { bootReady } from './fixtures/boot'
import { expect, test } from './fixtures/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = process.env.TITLE_CENSUS_OUT ?? path.join(ROOT, 'title-foreground-census.json')

/**
 * The most of the frame any one prop may cover.
 *
 * The bug was **32.8 %**; with `title-foreground-tree` authored the worst is
 * **9.9 %**, and the three behind it are 9.5, 9.2 and 5.8 — so there is a real
 * gap to sit in rather than a cliff to balance on. 15 % leaves half again of
 * headroom for the camera's aspect (this is NDC area over the full 2x2 clip
 * square, so it moves with the viewport's shape) without coming close to
 * readmitting a tree that stands in front of the emblem.
 */
const MAX_FRAME_FRACTION = 0.15

/** The scatter's texel pitch on `menu`: 4096 m over a 1024-wide density map. */
const TEXEL_METRES = 4

interface CensusRow {
  /** `props:scatter:<n>`, the pass's group. */
  pass: string
  /** The InstancedMesh's name, which is `props:<glb basename>`. */
  mesh: string
  /** Instance index inside that mesh. Not stable across a re-bake. */
  i: number
  /** The composed instance matrix, in the terrain group's frame. */
  mat: number[]
  /** Clip-space bounding rectangle, clipped to the frame, as a fraction of it. */
  frameFraction: number
  /** Pixel rectangle on a 1280x720 frame, for eyeballing against a screenshot. */
  px: [number, number, number, number]
}

test('no prop covers the title screen', async ({ page }) => {
  await page.goto('/?xr=off')
  await bootReady(page)
  // The flypast's jets are moving and the reveal is settling; the props are
  // not, but a frame that has not drawn yet has no matrices to read.
  await page.waitForTimeout(1200)

  const census = await page.evaluate(() => {
    // Untyped: this walks the live scene graph, whose types are not in scope
    // inside the page.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = globalThis as any
    const scene = w.__ff2.render.scene
    const camera = w.__ff2.render.camera
    camera.updateMatrixWorld(true)
    scene.updateMatrixWorld(true)

    const rows: any[] = []
    let valleyFound = false
    scene.traverse((o: any) => {
      if (o.name === 'title-valley') valleyFound = true
    })

    scene.traverse((o: any) => {
      if (!o.isInstancedMesh) return
      let p = o.parent
      const passName = o.parent?.name ?? ''
      let underValley = false
      while (p) {
        if (p.name === 'title-valley') underValley = true
        p = p.parent
      }
      if (!underValley) return

      o.geometry.computeBoundingBox()
      const bb = o.geometry.boundingBox
      const m = new o.matrixWorld.constructor()
      const c = new camera.position.constructor()
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m)
        const world = new o.matrixWorld.constructor().multiplyMatrices(o.matrixWorld, m)
        // All EIGHT corners of the instance's own bounds. "How much screen
        // does it take" is a rectangle, and an origin-plus-top pair
        // understates a wide crown by most of its width.
        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (let k = 0; k < 8; k++) {
          c.set(
            k & 1 ? bb.max.x : bb.min.x,
            k & 2 ? bb.max.y : bb.min.y,
            k & 4 ? bb.max.z : bb.min.z,
          )
          c.applyMatrix4(world)
          // Behind the eye a perspective divide mirrors the point through the
          // origin, so a corner with camera-space z >= 0 is dropped rather
          // than projected — otherwise a tree behind the camera reports a
          // rectangle across the whole frame.
          const camZ = c.clone().applyMatrix4(camera.matrixWorldInverse).z
          if (camZ >= 0) continue
          c.project(camera)
          minX = Math.min(minX, c.x)
          maxX = Math.max(maxX, c.x)
          minY = Math.min(minY, c.y)
          maxY = Math.max(maxY, c.y)
        }
        if (minX === Infinity) continue
        const w0 = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX))
        const h0 = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY))
        if (w0 <= 0 || h0 <= 0) continue
        rows.push({
          pass: passName,
          mesh: o.name,
          i,
          mat: Array.from(m.elements as number[]),
          // The clip square is 2x2, so an area of 4 is the whole frame.
          frameFraction: (w0 * h0) / 4,
          px: [
            Math.round((minX + 1) * 640),
            Math.round((1 - maxY) * 360),
            Math.round((maxX + 1) * 640),
            Math.round((1 - minY) * 360),
          ],
        })
      }
    })
    rows.sort((a, b) => b.frameFraction - a.frameFraction)
    return { valleyFound, total: rows.length, rows: rows.slice(0, 60) }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })

  // ── the census is not vacuous ──────────────────────────────────────────
  //
  // A traverse that found nothing would sail through the assertion below by
  // having no worst case. The title valley draws ~8,200 instances and a few
  // hundred of them are in frame; the floor is deliberately far under that,
  // because the number that matters is "more than none".
  expect(census.valleyFound, 'the title valley is in the scene').toBe(true)
  expect(census.total, 'props measured in frame').toBeGreaterThan(200)

  // ── recover each placement, and prove the recovery ─────────────────────
  const env = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'content', 'environments', 'menu.json'), 'utf8'),
  ) as {
    scatter: {
      index: number
      palette: {
        meshAsset: string | null
        meshTransform: {
          position: number[]
          rotation: number[]
          scale: number[]
        } | null
      }[]
    }[]
  }
  const childByMesh = new Map<string, THREE.Matrix4>()
  for (const entry of env.scatter) {
    for (const spec of entry.palette) {
      if (!spec.meshAsset) continue
      const mt = spec.meshTransform
      // `childMatrixOf` in src/game/props/load-props.ts, exactly: the position
      // flips z and the quaternion conjugates under the z mirror.
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(mt?.position[0] ?? 0, mt?.position[1] ?? 0, -(mt?.position[2] ?? 0)),
        new THREE.Quaternion(
          -(mt?.rotation[0] ?? 0),
          -(mt?.rotation[1] ?? 0),
          mt?.rotation[2] ?? 0,
          mt?.rotation[3] ?? 1,
        ),
        new THREE.Vector3(mt?.scale[0] ?? 1, mt?.scale[1] ?? 1, mt?.scale[2] ?? 1),
      )
      childByMesh.set(`props:${spec.meshAsset.split('/').pop()}`, m)
    }
  }

  const placed: (CensusRow & { meshX: number; meshZ: number; gridError: number })[] = []
  for (const row of census.rows as CensusRow[]) {
    const child = childByMesh.get(row.mesh)
    if (!child) continue
    const root = new THREE.Matrix4().fromArray(row.mat).multiply(child.clone().invert())
    const p = new THREE.Vector3().setFromMatrixPosition(root)
    // The props group hangs under the terrain group, whose geometry flipped
    // mesh z on the way in — so mesh z is the negation of the local one.
    const meshX = p.x
    const meshZ = -p.z
    const off = (v: number) => Math.abs(v / TEXEL_METRES - Math.round(v / TEXEL_METRES))
    placed.push({
      ...row,
      meshX,
      meshZ,
      gridError: Math.hypot(off(meshX), off(meshZ)) * TEXEL_METRES,
    })
  }
  expect(placed.length, 'rows whose palette entry was found').toBe(census.rows.length)
  // THE PROOF. `scatterProps` writes `wx = tx * terrainSize / width` with
  // integer texels, so every placement is an exact multiple of the pitch. A
  // recovery that dropped the child transform, or applied it the wrong way
  // round, or missed the z flip, lands off the grid — and could not land on it
  // by chance 60 times.
  const worst = Math.max(...placed.map((p) => p.gridError))
  expect(worst, 'every recovered placement sits on the 4 m texel grid').toBeLessThan(0.02)

  fs.writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        note: 'DEV-287. Ranked by the fraction of the title frame each prop covers. `meshX`/`meshZ` are the terrain mesh-space coordinates to paste into content/no-prop-volumes.json under "menu".',
        maxFrameFraction: MAX_FRAME_FRACTION,
        measured: census.total,
        rows: placed.map((p) => ({
          pass: p.pass,
          mesh: p.mesh,
          meshX: +p.meshX.toFixed(2),
          meshZ: +p.meshZ.toFixed(2),
          frameFraction: +p.frameFraction.toFixed(4),
          px: p.px,
        })),
      },
      null,
      2,
    )}\n`,
  )
  console.info(
    `title foreground: ${census.total} props in frame; worst ${placed
      .slice(0, 4)
      .map(
        (p) =>
          `${(p.frameFraction * 100).toFixed(1)}% @ (${p.meshX.toFixed(0)}, ${p.meshZ.toFixed(0)})`,
      )
      .join(', ')} — full census in ${path.relative(ROOT, OUT)}`,
  )

  const biggest = placed[0]
  expect(biggest, 'a worst case exists').toBeTruthy()
  expect(
    biggest?.frameFraction,
    `${biggest?.mesh} at mesh (${biggest?.meshX.toFixed(1)}, ${biggest?.meshZ.toFixed(1)}) ` +
      `covers ${((biggest?.frameFraction ?? 0) * 100).toFixed(1)}% of the title screen. ` +
      'Add a no-prop volume for it in content/no-prop-volumes.json under "menu" ' +
      '(DEV-287), or raise this threshold on purpose.',
  ).toBeLessThan(MAX_FRAME_FRACTION)
})
