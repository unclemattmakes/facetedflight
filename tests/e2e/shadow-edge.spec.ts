/**
 * The sun map's box has no edge you can see. DEV-453.
 *
 * Matt, 2026-09-27: *"the "far shadow" line is very noticable and jarring on
 * the alpine courses. (it's like a line where from it to the player, shadows
 * exist, beyond it - no shadows)"*.
 *
 * ── The mechanism, which is what this measures ───────────────────────────
 *
 * Inside the box (`render/shadows.ts`, ±700 m round the camera on
 * Anniversary) the scatter casts into the map, and DEV-304 hands the canopy
 * bake's DIRECT half to the map so the ground is not darkened twice. Outside,
 * the map answers lit. So before DEV-453 the forest floor past the box had
 * neither the trees' shadows nor the bake's direct darkening — a lit floor,
 * starting at a line. The far-field terms (`render/far-shadow.ts`) are exactly
 * what a frame with NO map at all draws everywhere, which makes that frame the
 * reference: the map may add whatever it likes inside the box, but where it
 * ends it must have handed everything back.
 *
 * ── Three claims, one reference ──────────────────────────────────────────
 *
 * Two loads per stand, same camera, same tier: the shipped preset, and the
 * same preset with `render.shadows` off. `fixtures/shadow-box.ts` says, per
 * pixel, how many metres the ground under it is from the box's nearest face.
 *
 *   1. **Past the box, the two frames agree.** Mean |shipped − no map| over
 *      the ground MARGIN..OUTSIDE_TO metres outside. This is the half that was
 *      wrong: before the fix the far forest floor was brighter than the far
 *      rule by the whole of the bake's direct term.
 *   2. **At the box's face, they agree too** — the ground within EDGE_BAND
 *      metres inside it. A fix that corrected the far field and left the map
 *      at full strength up to its face would pass (1) and draw the same line
 *      from the other side; this is what makes it a gradient.
 *   3. **Deep inside, they do NOT agree.** The map is doing something there —
 *      the trees' own shadows — or claims 1 and 2 are true of a build whose
 *      map is off in both loads, which is the vacuous pass.
 *
 * `SHADOW_EDGE_DIR` writes both frames and the box mask for the ledger's
 * before/after photographs. `?view=cam` because the claim is about the box,
 * which follows whatever camera is drawing, and a fixed camera is a frame two
 * loads can reproduce to the pixel; the seat frames are in the DEVIATIONS row.
 *
 * Tagged `@gpu`. `?xr=off` so the OpenXR runtime is not started.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { missionReady } from './fixtures/boot'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { type DrawState, drawState, drawStateDiff, PINNED } from './fixtures/quality-pin'
import { boxDistanceAt, type ShadowBoxMask, shadowBoxMask } from './fixtures/shadow-box'
import { expect, type Page, test } from './fixtures/test'

/** Alpine: DEV-295's launch valley, forest on both slopes, 650 m up. */
const MISSION = 'rookie_01_hoverJet'

/**
 * Two stands, one eye, looking up and down the valley. East puts the box's
 * UP-sun face across a forest; west puts it across the valley floor with a
 * ridge's shadow line nearby — the case where a picture misleads.
 */
const STANDS = [
  { name: 'valley-east', eye: '300,650,-950', look: '1300,300,-950' },
  { name: 'valley-west', eye: '300,650,-950', look: '-700,300,-950' },
] as const

/** Metres past the face before "outside" is claimed — `shadow-box.ts` says why. */
const MARGIN = 60
/** How far outside the claim reaches. Beyond it the ground is fog and haze. */
const OUTSIDE_TO = 300
/** The band just inside the face that must already have handed over. */
const EDGE_BAND = 30
/**
 * Levels of 255, mean |shipped − no map|, past the box. The two frames run
 * the same arithmetic out there — `mix(1, lit, 0)` is `1` — so the fix reads
 * **0.02 / 0.01** (east / west) and the bug read **6.54 / 1.22**. The bound
 * sits well inside the bug's smaller reading and ten times the fix's.
 */
const OUTSIDE_AGREE = 0.25
/**
 * The same, over the band just inside the face. Not zero there — the fade is
 * a smoothstep, so 30 m into a 150 m band the map still has ~10 % — and it
 * read **0.51 / 0.12** fixed against **7.20 / 1.63** with the line.
 */
const EDGE_AGREE = 1.0
/**
 * The map must move the deep interior by at least this much, or claims 1 and
 * 2 are true of a build with no map in either load. It read **2.90 / 0.52**
 * on both builds (deep inside, the fix changes nothing), against ~0 for two
 * loads that are the same frame.
 */
const MAP_WORKS = 0.2
/**
 * Where "deep inside" starts, metres, at the least: past the fade and the
 * margin. A floor rather than `edgeFade + MARGIN` alone so that the same spec
 * run against a build from before the key existed still measures a deep band,
 * and goes red on the claim it is about rather than on a missing number.
 */
const DEEP_FROM = 250

const SAMPLE = 4

const luminance = (png: Buffer): { width: number; height: number; lum: Float64Array } => {
  const { width, height, channels, data } = decodePngBuffer(png, 'shadow-edge')
  const lum = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * channels
    lum[i] =
      0.2126 * (data[o] as number) +
      0.7152 * (data[o + 1] as number) +
      0.0722 * (data[o + 2] as number)
  }
  return { width, height, lum }
}

interface Shot {
  readonly png: Buffer
  readonly state: DrawState
  readonly mask: ShadowBoxMask | null
  readonly edgeFade: number
}

const shoot = async (
  page: Page,
  stand: (typeof STANDS)[number],
  extra: string,
  withMask: boolean,
): Promise<Shot> => {
  await page.goto(
    `/?xr=off&ride=0&edition=anniversary&mission=${MISSION}&view=cam&${PINNED}${extra}` +
      `&eye=${stand.eye}&look=${stand.look}`,
  )
  await firstPress(page)
  await missionReady(page, 240_000)
  await page.waitForTimeout(3500)
  const png = await page.locator('#viewport').screenshot()
  const size = await page.locator('#viewport').boundingBox()
  const mask = withMask
    ? await shadowBoxMask(page, Math.round(size?.width ?? 0), Math.round(size?.height ?? 0), SAMPLE)
    : null
  const edgeFade = await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: { edition: { current: { render: { shadows: { edgeFade: number } } } } }
    }
    return w.__ff2.edition.current.render.shadows.edgeFade ?? 0
  })
  return { png, state: await drawState(page), mask, edgeFade }
}

test.describe('@gpu the shadow map has no edge — DEV-453', () => {
  test.setTimeout(600_000)

  for (const stand of STANDS) {
    test(`${stand.name}: past the box and at its face the frame is the far rule's`, async ({
      page,
    }) => {
      knownRed('KR-19', stand.name === 'valley-west')
      const shipped = await shoot(page, stand, '', true)
      const noMap = await shoot(page, stand, '&feature=render.shadows:off', false)

      expect(
        drawStateDiff(shipped.state, noMap.state),
        'the two loads drew at different tiers',
      ).toEqual([])
      const mask = shipped.mask
      expect(mask, 'no box mask — is the map on in the shipped load?').not.toBeNull()
      if (!mask) return

      const a = luminance(shipped.png)
      const b = luminance(noMap.png)
      expect(a.width).toBe(mask.width)
      expect(a.height).toBe(mask.height)

      const dir = process.env.SHADOW_EDGE_DIR
      if (dir) {
        fs.mkdirSync(dir, { recursive: true })
        const tag = `${MISSION}-${stand.name}-adaptive0-qhigh`
        fs.writeFileSync(path.join(dir, `${tag}-shipped.png`), shipped.png)
        fs.writeFileSync(path.join(dir, `${tag}-nomap.png`), noMap.png)
        fs.writeFileSync(path.join(dir, `${tag}-mask.json`), JSON.stringify(mask))
      }

      const bands = {
        outside: { n: 0, sum: 0 },
        edge: { n: 0, sum: 0 },
        deep: { n: 0, sum: 0 },
      }
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
          const m = boxDistanceAt(mask, x, y)
          if (!Number.isFinite(m)) continue
          const i = y * a.width + x
          const d = Math.abs((a.lum[i] as number) - (b.lum[i] as number))
          const band =
            m <= -MARGIN && m >= -OUTSIDE_TO
              ? bands.outside
              : m >= 0 && m <= EDGE_BAND
                ? bands.edge
                : m >= Math.max(DEEP_FROM, shipped.edgeFade + MARGIN)
                  ? bands.deep
                  : null
          if (!band) continue
          band.n++
          band.sum += d
        }
      }
      const mean = (s: { n: number; sum: number }): number => (s.n > 0 ? s.sum / s.n : Number.NaN)
      console.info(
        `DEV-453 ${stand.name}: edgeFade ${shipped.edgeFade} m; mean |shipped - no map| ` +
          `outside ${mean(bands.outside).toFixed(2)} (${bands.outside.n} px), ` +
          `edge ${mean(bands.edge).toFixed(2)} (${bands.edge.n} px), ` +
          `deep ${mean(bands.deep).toFixed(2)} (${bands.deep.n} px); box ${mask.extents
            .map((e) => e.toFixed(0))
            .join(' / ')} m`,
      )
      // Enough of each band that a mean means something.
      for (const [name, s] of Object.entries(bands)) {
        expect(s.n, `the ${name} band has almost no pixels — has the stand moved?`).toBeGreaterThan(
          2000,
        )
      }
      // 3 first: a map that draws nothing makes 1 and 2 true by default.
      expect(mean(bands.deep), 'the map changes nothing deep inside its box').toBeGreaterThan(
        MAP_WORKS,
      )
      // 1. Past the box: the far rule, all of it.
      expect(
        mean(bands.outside),
        'past the box the frame is not the far rule — the canopy bake has not taken the sun back',
      ).toBeLessThan(OUTSIDE_AGREE)
      // 2. At the face: already handed over, so the edge is a gradient.
      expect(
        mean(bands.edge),
        'the map is still at strength at its own face — the edge is a line',
      ).toBeLessThan(EDGE_AGREE)
    })
  }
})
