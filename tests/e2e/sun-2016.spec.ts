/**
 * tests/e2e/sun-2016.spec.ts — every mission's sun by 2016's rule, photographed
 * against the port's old one at the same tick, on both looks. DEV-454.
 *
 * Matt, 2026-09-27: *"plz add the 2016 tints to each of our missions."* The
 * extractor now writes Unity 5.4's light rule into the level JSON, and
 * `?sunlight=port` is the rule the port drew by before (`render/sun-light-rule.ts`).
 * One frozen frame under each, per mission and per edition, so the pair
 * differs in nothing but the sun.
 *
 * What it asserts is the PREMISE of the pair, read off the live
 * `DirectionalLight`: the default is 2016's colour and the switch reached the
 * scene — `colour x intensity` matches the level JSON's product under each
 * rule. What it PRINTS is the brief's question, *"does Anniversary read wrong
 * (crushed, over-saturated)?"*, as numbers per frame: mean luma, mean
 * saturation, and the share of pixels near black and at clip. The pictures are
 * the deliverable; the person looking at them is the judge (hard rule 9).
 *
 *   SUN_DIR=<dir> SUN_MISSIONS=int_01_hoverJet,rookie_01_hoverJet \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/sun-2016.spec.ts
 *
 * Tagged `@gpu` with the rest of the flying specs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodePng } from '../../tools/perf/png-diff.mjs'
import { flyToFreeze } from './fixtures/freeze'
import { drawState, drawStateDiff, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

/** One mission on each environment: Simonet, alpine, desert, Kauai. */
const MISSIONS = (
  process.env.SUN_MISSIONS ??
  'int_01_hoverJet,rookie_01_hoverJet,adv_01_hoverJet,hoverJet_kauai_beg'
).split(',')
const AT = Number(process.env.SUN_AT ?? '20')
const OUT = process.env.SUN_DIR ?? 'test-results/sun-2016'

interface Sun {
  readonly light: [number, number, number]
  readonly intensity: number
}

/** The level's own sun, off disk: the numbers the scene's light is held against. */
const levelSun = (
  mission: string,
): { colorLinear: number[]; colorGamma: number[]; intensity: number } =>
  JSON.parse(fs.readFileSync(path.join('content/levels', `${mission}.json`), 'utf8')).lighting.sun

/** The scene's live sun. */
const readSun = (page: Page): Promise<Sun | null> =>
  page.evaluate(() => {
    interface Node {
      isDirectionalLight?: boolean
      visible: boolean
      intensity: number
      color: { r: number; g: number; b: number }
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as { __ff2: { render: { scene: Node } } }
    let found: Node | null = null
    w.__ff2.render.scene.traverse((o) => {
      if (!found && o.isDirectionalLight && o.visible) found = o
    })
    const s = found as Node | null
    return s
      ? {
          light: [s.color.r, s.color.g, s.color.b] as [number, number, number],
          intensity: s.intensity,
        }
      : null
  })

interface Stats {
  readonly luma: number
  readonly saturation: number
  readonly nearBlack: number
  readonly atClip: number
}

/** Frame statistics over the world band (the top 30 %, past the canopy). */
const stats = (png: Buffer): Stats => {
  const img = decodePng(png)
  const y1 = Math.round(img.h * 0.3)
  let luma = 0
  let sat = 0
  let black = 0
  let clip = 0
  let n = 0
  for (let y = 0; y < y1; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * img.ch
      const r = img.data[i] as number
      const g = img.data[i + 1] as number
      const b = img.data[i + 2] as number
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
      sat += max > 0 ? (max - min) / max : 0
      if (max <= 12) black += 1
      if (max >= 254) clip += 1
      n += 1
    }
  }
  return { luma: luma / n, saturation: sat / n, nearBlack: black / n, atClip: clip / n }
}

test.describe('@gpu every mission’s sun by 2016’s rule (DEV-454)', () => {
  test.setTimeout(480_000)
  for (const mission of MISSIONS) {
    for (const edition of ['classic', 'anniversary'] as const) {
      test(`${mission} at ${AT} s — ${edition}, the port’s rule against 2016’s`, async ({
        page,
      }) => {
        const rows: string[] = []
        for (const rule of ['port', '2016'] as const) {
          await flyToFreeze(page, {
            mission,
            edition,
            snapAt: AT,
            params: {
              ...Object.fromEntries(new URLSearchParams(PINNED)),
              ...(rule === 'port' ? { sunlight: 'port' } : {}),
            },
          })
          const pin = await drawState(page)
          const sun = await readSun(page)
          expect(sun, 'the mission has a sun').not.toBeNull()
          if (!sun) return
          // The premise: the light IS the level's product under this rule.
          const lvl = levelSun(mission)
          const colour = rule === 'port' ? lvl.colorGamma : lvl.colorLinear
          const want = colour.map((c) => c * lvl.intensity * 2 * Math.PI)
          const got = sun.light.map((c) => c * sun.intensity)
          for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c] as number, 4)

          const shot = await page.locator('#viewport').screenshot()
          const file = path.join(
            OUT,
            `${mission}-${AT}s-${edition}-sun-${rule}-${PINNED.replace(/[=&]/g, '-')}.png`,
          )
          fs.mkdirSync(OUT, { recursive: true })
          fs.writeFileSync(file, shot)
          const s = stats(shot)
          rows.push(
            `${rule}: light ${sun.light.map((c) => c.toFixed(3)).join('/')} x ${sun.intensity.toFixed(3)} · luma ${s.luma.toFixed(1)} · sat ${s.saturation.toFixed(3)} · black ${(s.nearBlack * 100).toFixed(2)} % · clip ${(s.atClip * 100).toFixed(2)} % · ${file}`,
          )
          expect(drawStateDiff(pin, await drawState(page))).toEqual([])
          if (rule === '2016') rows.push(`  ${drawStateLine(pin)}`)
        }
        for (const r of rows) console.info(`[sun-2016] ${mission} ${edition} ${r}`)
      })
    }
  }
})
