/**
 * tests/e2e/life-leapers.spec.ts — DEV-449, the dolphins, in the real build.
 * (DEV-449's fish were cut by DEV-545, Matt 2026-09-30: "kill the fish"; the
 * first test holds the built game to that.)
 *
 * The unit tests hold the rule (pods in deep water), the ballistics (air time,
 * apex, symmetric arc) and the frame (a rotation, nose along the heading).
 * What only the running game can say:
 *
 *   · pods are there on Anniversary on the sea worlds, and some are in the
 *     air at any moment of a few seconds; NOT on Classic; quality `low` drops
 *     them;
 *   · WHAT THEY COST: a `renderer.info` delta on adjacent frames by hiding each
 *     kind (one draw each, always issued: they are not frustum-culled), a
 *     frame time, the program count against a load with both pinned off;
 *   · and what they LOOK like mid-leap, from a still camera beside a pod.
 *
 * `@gpu`, hydrated assets (the two GLBs are `staged` until the R2 push).
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import {
  bootStill,
  census,
  frameMs,
  onScreen,
  pairedDelta,
  programCount,
  setVisible,
  stand,
} from './fixtures/life'
import { PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'

const SHOT_DIR = process.env.LIFE_SHOT_DIR ?? 'test-results/life'
const PIN_TAG = PINNED.replace(/[=&]/g, '_')

interface LeaperProbe {
  wanted: boolean
  built: boolean
  visible: boolean
  count: number
  drawCalls: number
  triangles: number
  airborne: number
  animals: { x: number; z: number; pod: number }[]
}
/** The leaping kinds (`game/life/load-life.ts`'s `LEAPER_KINDS`): one since DEV-545. */
const KINDS = ['dolphins'] as const
type Kind = (typeof KINDS)[number]

const leapers = (page: Page): Promise<Record<Kind, LeaperProbe> | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      __ff2: {
        life: () => {
          seaRestY: number | null
          leapers: Record<string, LeaperProbe>
        } | null
      }
    }
    return w.__ff2.life()?.leapers ?? null
  })

/**
 * Where the animals of `kind` that are IN THE AIR are drawn right now, THREE
 * world, read off the field's own instance matrices (a submerged one is
 * scaled to nothing). The probe's count says somebody somewhere is up; this
 * says who and where, so a photograph can be aimed at one.
 */
const inAir = (page: Page, kind: Kind): Promise<{ x: number; y: number; z: number }[]> =>
  page.evaluate((k) => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          scene: {
            getObjectByName: (
              n: string,
            ) => { count: number; instanceMatrix: { array: ArrayLike<number> } } | undefined
          }
        }
      }
    }
    const mesh = w.__ff2.render.scene.getObjectByName(`life:${k}`)
    if (!mesh) return []
    const out: { x: number; y: number; z: number }[] = []
    const a = mesh.instanceMatrix.array
    for (let i = 0; i < mesh.count; i++) {
      const o = i * 16
      if (Math.hypot(a[o] as number, a[o + 1] as number, a[o + 2] as number) === 0) continue
      out.push({ x: a[o + 12] as number, y: a[o + 13] as number, z: a[o + 14] as number })
    }
    return out
  }, kind)

test.describe('@gpu the life pass — DEV-449, the dolphins', () => {
  test.setTimeout(600_000)

  test('pods on int_01_hoverJet leap, and what they cost', async ({ page }) => {
    await bootStill(page, 'int_01_hoverJet', `edition=anniversary&${PINNED}`)
    await expect
      .poll(
        async () => {
          const l = await leapers(page)
          return l?.dolphins.built
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    const l = (await leapers(page)) as Record<Kind, LeaperProbe>
    // DEV-545: no fish in the built game — the probe answers for the dolphins alone.
    expect(Object.keys(l)).toEqual([...KINDS])
    for (const kind of KINDS) {
      const k = l[kind]
      const pods = new Set(k.animals.map((a) => a.pod)).size
      console.log(
        `DEV-449 int_01_hoverJet ${kind}: ${k.count} in ${pods} pods, ${k.drawCalls} draw, ` +
          `${k.triangles} tris`,
      )
      expect(k.wanted).toBe(true)
      expect(k.visible).toBe(true)
      expect(k.drawCalls).toBe(1)
      expect(k.count).toBeGreaterThan(4)
    }
    // Over ten seconds, somebody is in the air: the periods are 3-9 s.
    let seen = 0
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250)
      const now = (await leapers(page)) as Record<Kind, LeaperProbe>
      seen = Math.max(seen, now.dolphins.airborne)
    }
    console.log(`  most in the air at once over 10 s: dolphins ${seen}`)
    expect(seen).toBeGreaterThan(0)
    // Programs at the START view after those ten seconds: the pinned-off load
    // reads at the same view after the same wait. A count SO FAR, so it is
    // compared like for like, before the camera moves and brings more in.
    console.log(`  programs at the start view, leapers on: ${await programCount(page)}`)

    const a = l.dolphins.animals[0] as { x: number; z: number }
    await stand(page, [a.x + 60, 150, a.z + 60], [a.x, 116, a.z])
    await page.waitForTimeout(400)
    const frame = await census(page, 40)
    console.log(`  the frame: ${frame.calls} calls, ${frame.tris} tris`)
    for (const kind of KINDS) {
      // Adjacent frames, shown-hidden-shown (see `pairedDelta`): a census
      // either side of one hide reads whatever else moved between windows.
      const d = await pairedDelta(page, `life:${kind}`, 30)
      console.log(
        `  ${kind}: PAIRED DELTA (median of 30 shown-hidden-shown) ${d.calls} call, ` +
          `${d.tris} tris (probe ${l[kind].triangles})`,
      )
      // One draw, always issued and never culled, so every animal's
      // triangles whether it is in the air or not. 2 %, as for the crowds.
      // (While the bakes drew with an RGB colour on programs of their own,
      // three reads of the dolphins came back ~70 over the probe's 1,764;
      // with RGBA, 1,758. Why the program should move the count is not
      // established — if this goes red by ~4 %, look there first.)
      expect(d.calls).toBe(1)
      expect(Math.abs(d.tris - l[kind].triangles)).toBeLessThanOrEqual(0.02 * l[kind].triangles)
    }
    const fA = await frameMs(page, 300)
    for (const kind of KINDS) await setVisible(page, `life:${kind}`, false)
    const fOff = await frameMs(page, 300)
    for (const kind of KINDS) await setVisible(page, `life:${kind}`, true)
    const fB = await frameMs(page, 300)
    console.log(
      `  frame ms (median of 300, vsync ${process.env.E2E_NO_VSYNC === '1' ? 'off' : 'ON'}): ` +
        `with ${fA.toFixed(2)} · hidden ${fOff.toFixed(2)} · with ${fB.toFixed(2)}`,
    )
    console.log(`  programs, leapers on: ${await programCount(page)}`)
  })

  test('programs with the leapers pinned off', async ({ page }) => {
    await bootStill(
      page,
      'int_01_hoverJet',
      `edition=anniversary&feature=life.dolphins:off&${PINNED}`,
    )
    // The same view and about the same wait as the leap test's reading.
    await page.waitForTimeout(11_000)
    const l = await leapers(page)
    expect(l?.dolphins.built).toBe(false)
    console.log(`DEV-449 programs, leapers pinned OFF: ${await programCount(page)}`)
  })

  test('Classic has none; quality low drops them', async ({ page }) => {
    await bootStill(page, 'int_01_hoverJet', `edition=classic&${PINNED}`)
    await page.waitForTimeout(3_000)
    const c = await leapers(page)
    expect(c?.dolphins.built).toBe(false)
    await bootStill(page, 'int_01_hoverJet', 'edition=anniversary&adaptive=0&quality=low')
    await page.waitForTimeout(3_000)
    const low = await leapers(page)
    expect(low?.dolphins.wanted).toBe(false)
  })

  // Kauai gets none, and that is the rule, not a slow build: its copy of the
  // course runs inland (the spawn stands ~178 m above the sea, and 825 of 828
  // samples round it to 900 m are land), so no water within either kind's
  // reach is deep enough. `life-leapers.test.ts`'s real-maps block says so.
  test('Kauai: none, because its course keeps inland', async ({ page }) => {
    await bootStill(page, 'hoverJet_kauai_beg', `edition=anniversary&${PINNED}`)
    const l = (await leapers(page)) as Record<Kind, LeaperProbe>
    expect(l.dolphins.wanted).toBe(true)
    expect(l.dolphins.count).toBe(0)
  })

  for (const mission of ['int_01_hoverJet']) {
    test(`photographs: a pod mid-leap on ${mission}`, async ({ page }) => {
      test.setTimeout(900_000)
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      // The world's load awaits the life builds (`boot/app.ts` awaits
      // `ready()` before `data-terrain-ready`), so a kind not built by now
      // found no water that fits it on this course — not a slow build.
      await bootStill(page, mission, `edition=anniversary&${PINNED}`)
      const settled = (await leapers(page)) as Record<Kind, LeaperProbe>
      console.log(
        `DEV-449 ${mission}: dolphins ${settled.dolphins.count} (built ${settled.dolphins.built})`,
      )
      expect(settled.dolphins.built).toBe(true)
      // Let the start screen's fade finish before the first frame is taken.
      await page.waitForTimeout(2_000)
      for (const kind of KINDS) {
        if (!settled[kind].built) {
          console.log(`  no ${kind} on ${mission}`)
          continue
        }
        // Catch one in the air, stand beside it at once, take it. A leap is
        // ~1 s, so the aim is by the instance matrix, not by the pod's centre.
        const back = 14
        let shot = 0
        for (let i = 0; i < 200 && shot < 2; i++) {
          await page.waitForTimeout(60)
          const up = await inAir(page, kind)
          const p = up[0]
          if (!p) continue
          await stand(page, [p.x + back, p.y + back / 5, p.z + back * 0.4], [p.x, p.y, p.z])
          const file = path.join(SHOT_DIR, `leap-${kind}-${mission}-${shot}-${PIN_TAG}.png`)
          await page.screenshot({ path: file })
          const still = (await inAir(page, kind)).length
          console.log(
            `  ${kind} ${file}: aimed at one ${(p.y - 116.6).toFixed(1)} m over the sea's rest ` +
              `height; ${still} of the kind in the air after the shot`,
          )
          shot++
          await page.waitForTimeout(1_500)
        }
        expect(shot).toBeGreaterThan(0)
      }

      // From the cockpit: an autopilot lap, a frame whenever a leaper is
      // bigger on screen than any taken so far.
      await page.goto(
        `/?xr=off&title=0&menu=0&edition=anniversary&autopilot=1&mission=${mission}&${PINNED}`,
      )
      await firstPress(page)
      await missionReady(page, 240_000)
      await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 30_000 })
      await focusCanvas(page)
      // Only animals IN THE AIR count: a submerged one is not drawn.
      let taken = 0
      let best = 0
      let framesWithOne = 0
      for (let t = 0; t < 1_200 && taken < 3; t++) {
        await page.waitForTimeout(100)
        if (t % 10 === 0 && (await page.getAttribute('body', 'data-finished')) === 'true') break
        // Out of the shaft first: `onScreen` projects, it does not occlude,
        // and the first cut's one "cockpit" frame was the shaft's wall with
        // eight leapers projected through it.
        const phase = await page.evaluate(
          () =>
            (globalThis as unknown as { __ff2: { launch: () => { phase: string } } }).__ff2.launch()
              .phase,
        )
        if (phase !== 'countdown' && phase !== 'flying') continue
        const up = (await Promise.all(KINDS.map((k) => inAir(page, k)))).flat()
        const on = await onScreen(page, up, 2)
        const top = on[0]
        if (!top) continue
        framesWithOne++
        if (top.px < Math.max(3, best * 1.4)) continue
        best = top.px
        const file = path.join(SHOT_DIR, `leap-cockpit-${mission}-${taken}-${PIN_TAG}.png`)
        await page.screenshot({ path: file })
        console.log(
          `  cockpit ${file}: ${on.length} in the air and in frame, nearest ` +
            `${top.dist.toFixed(0)} m, ~${top.px.toFixed(1)} px for 2 m`,
        )
        taken++
      }
      console.log(
        `  ${framesWithOne} sampled cockpit frame(s) had a leaper in the air in view; ` +
          `${taken} taken (biggest ~${best.toFixed(1)} px for 2 m)`,
      )
    })
  }
})
