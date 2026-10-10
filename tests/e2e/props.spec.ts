/**
 * The prop layer draws, and the props you can see are the prop layer's.
 *
 * ── Why this is an A/B and not an assertion about pixels ─────────────────
 *
 * The first version of this looked for green pixels on a ridgeline. That
 * passes on a correct render and also on a green ring, a patch of vegetation
 * in the terrain's own colour map, or a shader bug — which is the mistake
 * `docs/DEVIATIONS.md` calls testing the attribution rather than the artifact.
 * One `?props=off` run separates "the trees are drawing" from "something green
 * is on that hill", and it is the same thirty-second move that separated "the
 * fog is wrong" from "something is drawn wrong at fog range".
 *
 * So the assertion is: with props on, the loader reports a non-zero instance
 * count in a small number of draw calls; with `?props=off`, it reports nothing
 * at all. The counts come from the app's own console line rather than from a
 * screenshot, because a number is stable and a ridgeline is not.
 *
 * ── @gpu, and it is about ASSETS as much as the GPU ──────────────────────
 *
 * Tagged `@gpu` to match `terrain-screenshot.spec.ts`, and for the same second
 * reason: it needs `public/assets/` hydrated. Those are gitignored and come
 * from `pnpm assets:pull`, so on a bare runner this cannot pass and must not
 * be asked to. `E2E_SKIP_GPU=1` excludes it.
 */

import { PROP_CELLS_PER_AXIS } from '../../src/game/props/cells'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const flyAndReadPropsLog = async (
  page: import('@playwright/test').Page,
  query: string,
): Promise<string[]> => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(m.text()))
  await page.goto(`/?mission=int_01_hoverJet&autopilot=1&xr=off${query}`)
  await firstPress(page)
  await missionReady(page, 150_000)
  await focusCanvas(page)
  await page.waitForTimeout(4_000)
  return logs.filter((l) => l.startsWith('props:'))
}

test.describe('@gpu props', () => {
  test.setTimeout(240_000)

  test('scatters instances onto int_01 and says how many', async ({ page }) => {
    knownRed('KR-05')
    const lines = await flyAndReadPropsLog(page, '')
    // Two `props:` lines since DEV-136 — the scatter's own, and the collider
    // build's ("props: N colliders in M cells"). This spec reads the first kind
    // and picks it by content, not by position: the collider line lands a
    // frame or two later and the boot's timing decides whether it is caught.
    const instanceLines = lines.filter((l) => l.includes(' instances in '))
    expect(instanceLines, 'the app should report what the prop layer built').toHaveLength(1)

    const line = instanceLines[0] as string
    // "props: 1240 instances in 8 draw calls (simonet, anniversary)"
    //
    // The PRESET is part of the line since DEV-102, and it has to be: Classic
    // and Anniversary now draw different passes, so a bare instance count no
    // longer says which game it counted. On simonet the difference is total —
    // its one generator was never baked in 2016, so Classic draws NO scatter
    // there at all and `loadProps` answers null. This spec runs the default
    // preset, which is Anniversary (DEV-078), and says so rather than assuming.
    const m = /^props: (\d+) instances in (\d+) draw calls \((\w+), (\w+)\)/.exec(line)
    expect(m, `unrecognised props line: ${line}`).not.toBeNull()

    const instances = Number(m?.[1])
    const draws = Number(m?.[2])
    expect(m?.[3]).toBe('simonet')
    expect(m?.[4], 'the default preset, and the one these counts belong to').toBe('anniversary')

    // A LOOSE floor, not a golden. The scatter is seeded so the number is
    // stable, but pinning it exactly would make every future palette or
    // probability edit a test failure rather than a decision. What matters is
    // that the forest is not empty and not accidentally the whole map.
    expect(instances).toBeGreaterThan(100)
    expect(instances).toBeLessThan(100_000)

    // Simonet's palette is 8 entries, and one InstancedMesh each is the whole
    // point of instancing; DEV-118 lets `?propCells=` split each entry over a
    // culling grid and ships that grid at one cell, so the bound is written as
    // the formula rather than the number. If this climbs into the hundreds,
    // someone has gone back to one object per prop.
    // DEV-135 draws the hand-placed landmarks (Simonet's one spire) as their
    // own instanced draws and says how many on the same line, so the ceiling
    // is the scatter's formula PLUS what the line itself declares — not a
    // number typed here that the next landmark would break.
    const landmarks = Number(/(\d+) landmarks/.exec(line)?.[1] ?? 0)
    expect(draws).toBeGreaterThan(0)
    expect(draws).toBeLessThanOrEqual(8 * PROP_CELLS_PER_AXIS * PROP_CELLS_PER_AXIS + landmarks)
  })

  test('draws nothing at all with ?props=off — so the trees ARE the prop layer', async ({
    page,
  }) => {
    const lines = await flyAndReadPropsLog(page, '&props=off')
    expect(lines, 'props=off must not build or report a prop layer').toHaveLength(0)
  })
})
