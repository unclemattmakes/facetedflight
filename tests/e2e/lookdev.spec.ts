/**
 * The lookdev panel: it builds, `L` toggles it, and a slider changes the frame.
 *
 * A tuning tool that silently does nothing is worse than no tool — you spend
 * the session deciding the value was already right. So this drags one and
 * asserts the PIXELS moved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { SUN_CAP_TRIANGLES } from '@/render/sky'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

/** DEV-528: the preset the panel's buffet sliders must start at. */
const SHIPPED_THROTTLE = (
  JSON.parse(fs.readFileSync(path.resolve('content/editions/anniversary.json'), 'utf8')) as {
    cockpit: { shake: { throttle: { fullThrottle: number } } }
  }
).cockpit.shake.throttle

test.describe('@gpu lookdev', () => {
  test.setTimeout(300_000)

  test('toggles, tunes and hands back numbers', async ({ page }) => {
    await page.goto('/?view=cam&cam=island-lit&xr=off&lookdev=1')
    await firstPress(page)
    await missionReady(page, 180_000)
    const panel = page.locator('.ff2-lookdev')
    await expect(panel).toBeHidden()

    await focusCanvas(page)
    await page.keyboard.press('KeyL')
    await expect(panel).toBeVisible()

    // Every control starts where the build is, not at a slider default.
    const thinning = panel
      .locator('label')
      .filter({ hasText: 'thinning' })
      .locator('input[type=range]')
    expect(Number(await thinning.inputValue())).toBe(1)

    // DEV-528: the buffet's engine curve is on the panel too, starting at the
    // preset's weight rather than at a slider default.
    const buffet = panel
      .locator('label')
      .filter({ hasText: 'full throttle, unboosted' })
      .locator('input[type=range]')
    expect(Number(await buffet.inputValue())).toBe(SHIPPED_THROTTLE.fullThrottle)

    await page.waitForTimeout(800)
    const before = await page.locator('#viewport').screenshot()

    // Drive the fog to something unmistakable and check the frame followed.
    await thinning.fill('2')
    await thinning.dispatchEvent('input')
    await page.waitForTimeout(800)
    const after = await page.locator('#viewport').screenshot()
    expect(Buffer.compare(before, after)).not.toBe(0)

    // And the copy button produces SOURCE LINES, not bare numbers — the whole
    // point is that a session ends with something pasteable.
    const messages: string[] = []
    page.on('console', (m) => messages.push(m.text()))
    // By NAME: the Placement folder (DEV-129) put Copy JSON and Reset buttons on
    // the panel too, and a bare `button` locator is ambiguous now.
    await panel.getByRole('button', { name: 'Copy settings' }).click()
    await expect
      .poll(() => messages.find((m) => m.includes('lookdev settings')) ?? '')
      .toContain('FF2_FOG_THINNING')

    await page.keyboard.press('KeyL')
    await expect(panel).toBeHidden()
  })

  test('rebuilds the sky dome, and the environment with it', async ({ page }) => {
    // The sky's colours are baked per face at load, so a slider here has to
    // re-run the bake AND the prefilter. Two ways for that to half-work and
    // both look fine in a thumbnail: the dome changes and the lighting does
    // not, or the mesh is replaced and falls out of the scene.
    await page.goto('/?view=cam&cam=sky-only&xr=off&lookdev=1')
    await firstPress(page)
    await missionReady(page, 180_000)
    await focusCanvas(page)
    await page.keyboard.press('KeyL')

    const liveDome = () =>
      page.evaluate(() => {
        const w = globalThis as unknown as {
          __ff2?: {
            render: {
              scene: {
                environment: unknown
                traverse: (
                  f: (o: {
                    name?: string
                    visible?: boolean
                    geometry?: { getAttribute(n: string): { count: number } }
                  }) => void,
                ) => void
              }
            }
          }
        }
        const domes: number[] = []
        w.__ff2?.render.scene.traverse((o) => {
          if (o.name === 'sky-dome' && o.visible === true) {
            domes.push((o.geometry?.getAttribute('position').count ?? 0) / 3)
          }
        })
        return {
          domes,
          env: String((w.__ff2?.render.scene.environment as { uuid?: string })?.uuid),
        }
      })

    const before = await liveDome()
    // Subdivision 5 is 20,480 faces, and exactly ONE dome is being drawn.
    //
    // ── The count is the whole fix, and it is a defect report ────────────
    //
    // This used to read `faces` off the LAST object named `sky-dome` the
    // traverse reached, and there are TWO of them: the mission's, and the
    // title screen's, which `app.ts` adds to the same scene and merely HIDES
    // when you are not on the title (`titleSky.dome.visible = false`). The
    // lookdev panel retunes the mission's. So the slider moved, the dome
    // really did rebuild, and the probe reported the other one — 20,480
    // before and 20,480 after, which reads exactly like a tuning tool that
    // silently does nothing. That is the failure this file's own header says
    // it exists to prevent, arriving as a false positive instead.
    //
    // Scoping to `visible` is not tidiness, it is the claim the test is
    // making: the dome you can SEE is the one a slider is supposed to move.
    // Asserting the COUNT as well means a third dome cannot quietly
    // reintroduce the ambiguity — the same guard, for the same reason, as
    // `ship-select.spec.ts` refusing a `startsWith` that counted the spinner.
    expect(before.domes, 'exactly one sky dome is drawn').toHaveLength(1)
    // Subdivision 5's 20,480 facets, PLUS the sun's cap (DEV-293) — the disc
    // is welded into the dome's own geometry rather than drawn as a second
    // object, so it is inside this count by construction. Imported rather
    // than added up here: the cap is retunable and a sum written down would
    // be a number this file has to be told about (DEV-266).
    expect(before.domes[0]).toBe(20_480 + SUN_CAP_TRIANGLES)

    // Drop it two levels and confirm the geometry, the scene membership AND the
    // environment texture all followed.
    // By LABEL, not by index. The first attempt used `.nth(3)`, which is the
    // sun-intensity slider — the test dragged the sun, the sky did not change,
    // and the failure looked like a broken rebuild rather than a broken
    // selector. An index here silently re-points every time a control is added.
    const subdiv = page
      .locator('.ff2-lookdev label')
      .filter({ hasText: 'subdivisions' })
      .locator('input[type=range]')
    await subdiv.fill('3')
    await subdiv.dispatchEvent('input')
    await page.waitForTimeout(1500)

    const after = await liveDome()
    expect(after.domes, 'still exactly one sky dome drawn').toHaveLength(1)
    // The dome dropped two levels; the sun did not, because the sun's size is
    // not a function of the sky's tessellation any more. That asymmetry IS the
    // fix — the old disc's shape moved with this slider, which is why
    // subdivision 3 gave one bright hexagon and 5 gave a shard.
    expect(after.domes[0]).toBe(1_280 + SUN_CAP_TRIANGLES)
    // A new prefilter, not the old one left in place — the dome lights the
    // world as well as backing it, and half a rebuild is the worse bug.
    expect(after.env).not.toBe(before.env)
  })

  test('is absent unless asked for', async ({ page }) => {
    await page.goto('/?view=cam&cam=island-lit&xr=off')
    await firstPress(page)
    await missionReady(page, 180_000)
    await expect(page.locator('.ff2-lookdev')).toHaveCount(0)
  })
})
