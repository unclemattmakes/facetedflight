/**
 * tests/e2e/hangar-art.spec.ts — 2016's level-select room, flown (DEV-430).
 *
 * Matt, 2026-09-26: *"would also like the original hangar art, holotable art,
 * etc, ported so we can have better parity with the 2016 version."*
 * `render/hangar-art.ts` loads `setGameplayOptions`' own meshes and, when they
 * land, stands them where the generated room was. The unit suite owns the
 * geometry (`hangar-art.test.ts`: the floor under the seat, the clearances, the
 * chair's facing, all measured on the real GLBs). What only a browser can say
 * is that the art ARRIVES on the path a player takes — title, ENTER, the room —
 * that the generated pieces step aside when it does, and what the frame costs.
 *
 * Two tests, and the split is what makes a before/after pair possible:
 *
 *   `photographs the room from the seat` asserts nothing about the art. It
 *     walks in, reads the frame's census, and — with `HANGAR_ART_SHOT_DIR` set —
 *     photographs three views, pinned. It runs on ANY build, which is how the
 *     BEFORE arm was taken: on the base commit, with this spec on disk and
 *     `src/` untouched.
 *   `stands 2016's room in place of the generated one` is the gate: the art is
 *     drawn, every generated piece it replaces is not, every live table stands
 *     a pedestal, and the draw calls went DOWN.
 *
 * Counts are of ONE FRAME (`renderer.info.render`, median over 30), which is
 * contention-proof (AGENT-NOTES §1). The program count is a count SO FAR and is
 * printed, never asserted.
 */

import { decodePng } from '../../tools/perf/png-diff.mjs'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { hangarAim, throughDoors } from './fixtures/hangar'
import { type LabelContrast, labelContrast } from './fixtures/label-contrast'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateLine, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 300_000 })

/** The pin as it goes in a file name. */
const PIN_TAG = PINNED.replace(/[=&]/g, '-')

/**
 * The chosen edition, for the photographs. Since DEV-451 the room wears
 * Anniversary whatever was chosen (a Classic choice is worn inside a mission
 * only), so a `classic` run photographs the same room: kept as the arm that
 * would show a Classic choice reaching the room again. Unset is the default.
 */
const EDITION = process.env.HANGAR_ART_EDITION ?? null

/** Title -> the room, which opens on the aircraft every time (DEV-105). */
const intoTheRoom = async (page: Page, edition: string | null = EDITION) => {
  await page.goto(`/?xr=off&${PINNED}${edition ? `&edition=${edition}` : ''}`)
  await firstPress(page)
  await bootReady(page, 240_000)
  await dropFocus(page)
  await page.waitForTimeout(1_200)
  await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
  await throughDoors(page) // and SINGLE PLAYER, to the aircraft
  expect((await hangarAim(page))?.view, 'Single Player opens the aircraft').toBe('vehicles')
}

interface Census {
  readonly calls: number
  readonly triangles: number
  readonly programs: number
}

/** One frame's draw calls and triangles (median of 30), and the programs so far. */
const census = async (page: Page): Promise<Census> => {
  const s = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __ff2: {
        render: {
          renderer: {
            info: { render: { calls: number; triangles: number }; programs: unknown[] | null }
          }
        }
      }
    }
    const info = w.__ff2.render.renderer.info
    const calls: number[] = []
    const tris: number[] = []
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      calls.push(info.render.calls)
      tris.push(info.render.triangles)
    }
    return { calls, tris, programs: info.programs?.length ?? -1 }
  })
  const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
  return { calls: mid(s.calls), triangles: mid(s.tris), programs: s.programs }
}

/** What the room is drawing, by name: the 2016 pieces and the generated ones. */
const roomState = async (page: Page) =>
  page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      isMesh?: boolean
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return null
    const drawn = (o: Node): boolean => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const names: Record<string, number> = {}
    let liveTables = 0
    let pedestals = 0
    ff.stage().traverse((o) => {
      if (!drawn(o)) return
      if (o.name) names[o.name] = (names[o.name] ?? 0) + 1
      if (o.name === 'hangar-holotable') {
        liveTables++
        o.traverse((c) => {
          if (c.name === 'holotable-pedestal' && drawn(c)) pedestals++
        })
      }
    })
    return { names, liveTables, pedestals }
  })

/**
 * Turn the seat until the camera's forward is within `tolerance` of pointing at
 * the named object's world position — yaw first, then pitch plus `pitchOffset`.
 * `KeyD`/`KeyA` and `KeyW`/`KeyS` as the menu specs use them; the sign of each is
 * discovered from its own effect, never assumed (the orientation lesson applied
 * to a helper, as `fixtures/hangar.ts`'s `aimAtMark` does).
 */
const aimAt = async (page: Page, name: string, pitchOffset = 0, tolerance = 0.03) => {
  const error = () =>
    page.evaluate(
      ({ name, pitchOffset }) => {
        interface Node {
          name: string
          matrixWorld: { elements: number[] }
          updateWorldMatrix: (a: boolean, b: boolean) => void
          getObjectByName: (n: string) => Node | undefined
        }
        const ff = (
          globalThis as unknown as { __ff2?: { stage: () => Node; render: { camera: Node } } }
        ).__ff2
        const target = ff?.stage().getObjectByName(name)
        if (!ff || !target) return null
        target.updateWorldMatrix(true, false)
        const cam = ff.render.camera
        cam.updateWorldMatrix(true, false)
        const m = cam.matrixWorld.elements
        const p = target.matrixWorld.elements
        const fwd = [-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)]
        const to = [
          (p[12] ?? 0) - (m[12] ?? 0),
          (p[13] ?? 0) - (m[13] ?? 0),
          (p[14] ?? 0) - (m[14] ?? 0),
        ]
        const yawOf = (v: number[]) => Math.atan2(v[0] ?? 0, -(v[2] ?? 0))
        const pitchOf = (v: number[]) =>
          Math.asin(
            Math.max(
              -1,
              Math.min(1, (v[1] ?? 0) / (Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1)),
            ),
          )
        const d = yawOf(to) - yawOf(fwd)
        return {
          dYaw: Math.atan2(Math.sin(d), Math.cos(d)),
          dPitch: pitchOf(to) + pitchOffset - pitchOf(fwd),
        }
      },
      { name, pitchOffset },
    )
  let right: 'KeyD' | 'KeyA' = 'KeyD'
  let up: 'KeyW' | 'KeyS' = 'KeyW'
  for (let i = 0; i < 160; i++) {
    const e = await error()
    if (!e) return false
    if (Math.abs(e.dYaw) < tolerance && Math.abs(e.dPitch) < tolerance) return true
    const yawing = Math.abs(e.dYaw) >= Math.abs(e.dPitch)
    const key = yawing
      ? e.dYaw > 0
        ? right
        : right === 'KeyD'
          ? 'KeyA'
          : 'KeyD'
      : e.dPitch > 0
        ? up
        : up === 'KeyW'
          ? 'KeyS'
          : 'KeyW'
    const size = yawing ? Math.abs(e.dYaw) : Math.abs(e.dPitch)
    await page.keyboard.down(key)
    await page.waitForTimeout(size > 0.3 ? 120 : 40)
    await page.keyboard.up(key)
    await page.waitForTimeout(120)
    const after = await error()
    if (!after) return false
    // A nudge that made its own axis WORSE had the sign backwards: flip it.
    if (yawing && Math.abs(after.dYaw) > size + 0.005) right = right === 'KeyD' ? 'KeyA' : 'KeyD'
    if (!yawing && Math.abs(after.dPitch) > size + 0.005) up = up === 'KeyW' ? 'KeyS' : 'KeyW'
  }
  return false
}

/** A shot, with the tier read back beside it — a pin is a fact only once read. */
const shoot = async (page: Page, file: string) => {
  const state = await drawState(page)
  await page.screenshot({ path: file })
  console.log(`[DEV-430] ${file.split('/').at(-1)} · ${drawStateLine(state)}`)
}

test('photographs the room from the seat', async ({ page }) => {
  await intoTheRoom(page)
  // The parked jet, the aircraft on the tables and — where it exists — the 2016
  // room are all unawaited loads. Give them the time ship-select.spec.ts does.
  await page.waitForTimeout(8_000)
  const at = await census(page)
  const state = await roomState(page)
  const ported = (state?.names['hangar-2016'] ?? 0) > 0
  console.log(
    `[DEV-430] room at rest: ${at.calls} draw calls · ${at.triangles} triangles · ${at.programs} programs so far · 2016 art ${ported ? 'DRAWN' : 'absent'}`,
  )
  const dir = process.env.HANGAR_ART_SHOT_DIR
  if (!dir) return
  const tag = `${process.env.HANGAR_ART_ARM ?? (ported ? 'after' : 'before')}${EDITION ? `-${EDITION}` : ''}-${PIN_TAG}`
  await shoot(page, `${dir}/hangar-rest-${tag}.png`)
  // The 2016 video's aircraft-select frame (0:12) looks at the parked jet.
  expect(await aimAt(page, 'hangar-parked-ship'), 'turned to the jet').toBe(true)
  await shoot(page, `${dir}/hangar-jet-${tag}.png`)
  // And up, where the girders and the shaft are (0:22 shows the truss).
  expect(await aimAt(page, 'hangar-parked-ship', 0.6), 'looked up').toBe(true)
  await shoot(page, `${dir}/hangar-up-${tag}.png`)
  // And down past the tables to the deck the jet stands on, and the floor.
  expect(await aimAt(page, 'hangar-parked-ship', -0.35), 'looked down at the jet').toBe(true)
  await shoot(page, `${dir}/hangar-low-${tag}.png`)
})

test("stands 2016's room in place of the generated one", async ({ page }) => {
  await intoTheRoom(page)
  await expect
    .poll(async () => (await roomState(page))?.names['hangar-2016'] ?? 0, {
      timeout: 60_000,
      message: "2016's room arrives (the three GLBs under public/assets/hangar/)",
    })
    .toBe(1)
  const state = await roomState(page)
  expect(state, 'the stage is readable').not.toBeNull()
  const names = state?.names ?? {}
  expect(names['hangar-2016-lamps'], "2016's light tubes are drawn").toBe(1)
  // DEV-439: the two reflective materials are their own draws, and the primer
  // that compiled their program with the room's first frame has gone.
  expect(names['hangar-2016-deck'], "2016's deck is drawn").toBe(1)
  expect(names['hangar-2016-shaft'], "2016's shaft is drawn").toBe(1)
  expect(names['hangar-2016-reflective-primer'] ?? 0, 'the primer is gone').toBe(0)
  // Every generated piece the art stands in for is hidden, not merely covered.
  for (const generated of [
    'hangar-shell',
    'hangar-floor',
    'hangar-strips',
    'hangar-dressing',
    'hangar-chair',
  ]) {
    expect(names[generated] ?? 0, `${generated} is not drawn once 2016's room is in`).toBe(0)
  }
  // What stays: the port's lamp (dark, DEV-437), the parked jet, and the tables.
  expect(names['menu-room-lamp'], 'the room keeps its lamp').toBe(1)
  expect(state?.liveTables ?? 0, 'the aircraft step stands tables').toBeGreaterThan(0)
  expect(state?.pedestals, 'every drawn table stands on a 2016 pedestal').toBe(state?.liveTables)

  // ── DEV-437: 2016's light is up, and the port's is down ───────────────────
  //
  // Read off the live stage: the three lights the room built dark, each now
  // burning, and the port's point lamp and the menu scene's flat ambient at
  // zero — dark, not gone, so no program key moved.
  const levels = await lightLevels(page)
  expect(levels, 'the stage lists its lights').not.toBeNull()
  for (const name of ['hangar-2016-spot', 'hangar-2016-key', 'hangar-2016-ibl']) {
    expect(levels?.[name] ?? 0, `${name} is lit`).toBeGreaterThan(0)
  }
  expect(levels?.['menu-room-lamp'], "the port's lamp is dark").toBe(0)
  expect(levels?.ambient, "the menu's flat ambient is dark").toBe(0)

  // ── What it costs, as an exact delta on ONE page ──────────────────────────
  //
  // The same frame both ways, by flipping visibility on the pieces the art
  // swapped — `ambient-traffic.spec.ts`'s method: a harness measurement of the
  // build, not a different build. Restored before the test ends.
  const ported = await census(page)
  expect(await showGenerated(page, true), 'the swap is reversible').toBeGreaterThan(0)
  const generated = await census(page)
  await showGenerated(page, false)
  const again = await census(page)
  console.log(
    `[DEV-430] one frame at rest — generated room: ${generated.calls} draw calls · ${generated.triangles} triangles; 2016's room: ${ported.calls} draw calls · ${ported.triangles} triangles (${again.calls} after the flip back); ${again.programs} programs so far`,
  )
  // Both 2016 readings, not only the first: the room's other loads (an aircraft,
  // a medal) can land between them and move the frame by a draw, which is
  // theirs, not this row's — seen on the first run as 50 then 49.
  expect(ported.calls, "2016's room draws in fewer calls than the generated one").toBeLessThan(
    generated.calls,
  )
  expect(again.calls, 'and still does after the flip back').toBeLessThan(generated.calls)
})

// ── DEV-437 addendum: every label reads against the room ────────────────────
//
// The room's labels are canvas text floating in a lit room, and the room is
// whatever the lighting makes it: with the deck lit near-white, the header
// over it read close to illegible (the coordinator, from `hangar-rest-final`).
// So whatever the light ends up as, the WORDS get a floor. Per label, on the
// seat's two framings, both editions: the letters' median luminance against
// the pixels immediately round them in the frame the player sees — WCAG 2's
// ratio, and 4.5 is its bar for body text. `fixtures/label-contrast.ts` has
// the method; the ratio against the bare room behind is printed beside it.

/** WCAG 2's AA bar for ordinary text. The labels are small, so the ordinary bar. */
const LABEL_CONTRAST_FLOOR = 4.5

interface LabelReading extends LabelContrast {
  readonly where: string
  readonly label: string
}

/** Every drawn canvas label, measured alone: shown, tinted magenta, and against none at all. */
const legibility = async (page: Page, where: string): Promise<LabelReading[]> => {
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const shot = async () => decodePng(await page.screenshot())
  const labels = await page.evaluate(() => {
    interface Node {
      visible: boolean
      parent: Node | null
      isMesh?: boolean
      geometry: {
        computeBoundingBox: () => void
        boundingBox: { min: Record<'x' | 'y' | 'z', number>; max: Record<'x' | 'y' | 'z', number> }
      }
      matrixWorld: { elements: number[] }
      updateWorldMatrix: (a: boolean, b: boolean) => void
      material?: {
        color: {
          getHex: () => number
          setRGB: (r: number, g: number, b: number) => void
          setHex: (h: number) => void
        }
        map?: { isCanvasTexture?: boolean; image: { width: number; height: number } }
      }
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (
      globalThis as unknown as {
        __ff2: {
          stage: () => Node
          render: {
            camera: Node & {
              matrixWorldInverse: { elements: number[] }
              projectionMatrix: { elements: number[] }
            }
          }
        }
      }
    ).__ff2
    const drawn = (o: Node) => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    const mul = (m: number[], v: number[]) =>
      [0, 1, 2, 3].map(
        (r) =>
          (m[r] ?? 0) * (v[0] ?? 0) +
          (m[r + 4] ?? 0) * (v[1] ?? 0) +
          (m[r + 8] ?? 0) * (v[2] ?? 0) +
          (m[r + 12] ?? 0) * (v[3] ?? 0),
      )
    const found: Node[] = []
    ff.stage().traverse((o) => {
      if (o.isMesh && o.material?.map?.isCanvasTexture && drawn(o)) found.push(o)
    })
    ;(globalThis as unknown as { __labels: Node[] }).__labels = found
    return found.map((o, i) => {
      o.updateWorldMatrix(true, false)
      o.geometry.computeBoundingBox()
      const b = o.geometry.boundingBox
      const xs: number[] = []
      const ys: number[] = []
      let behind = false
      for (const x of [b.min.x, b.max.x])
        for (const y of [b.min.y, b.max.y])
          for (const z of [b.min.z, b.max.z]) {
            const c = mul(
              cam.projectionMatrix.elements,
              mul(cam.matrixWorldInverse.elements, mul(o.matrixWorld.elements, [x, y, z, 1])),
            )
            const w = c[3] ?? 0
            if (w <= 0) behind = true
            xs.push((((c[0] ?? 0) / w) * 0.5 + 0.5) * innerWidth)
            ys.push((0.5 - ((c[1] ?? 0) / w) * 0.5) * innerHeight)
          }
      const { width, height } = o.material?.map?.image ?? { width: 0, height: 0 }
      return {
        i,
        kind: height === 128 ? 'header' : height === 256 ? 'table' : 'plate',
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [
          number,
          number,
          number,
          number,
        ],
        behind,
        canvas: [width, height],
      }
    })
  })
  const show = (only: number | null, tint: boolean) =>
    page.evaluate(
      ({ only, tint }) => {
        interface Node {
          visible: boolean
          material: { color: { setRGB: (r: number, g: number, b: number) => void } }
        }
        const labels = (globalThis as unknown as { __labels: Node[] }).__labels
        labels.forEach((o, i) => {
          o.visible = only === null ? true : i === only
          if (i === only && tint) o.material.color.setRGB(1, 0, 1)
          else o.material.color.setRGB(1, 1, 1)
        })
      },
      { only, tint },
    )
  const out: LabelReading[] = []
  try {
    await show(-1, false)
    await frames()
    const hidden = await shot()
    for (const l of labels) {
      if (l.behind || l.box[2] < 0 || l.box[0] > hidden.w || l.box[3] < 0 || l.box[1] > hidden.h)
        continue
      await show(l.i, false)
      await frames()
      const shown = await shot()
      await show(l.i, true)
      await frames()
      const tinted = await shot()
      const c = labelContrast(shown, tinted, hidden, l.box)
      if (c) out.push({ ...c, where, label: `${l.kind}#${l.i}` })
    }
  } finally {
    await show(null, false)
  }
  return out
}

for (const edition of ['anniversary', 'classic'] as const) {
  test(`every label reads against the room: ${edition}`, async ({ page }) => {
    await intoTheRoom(page, edition)
    await expect
      .poll(async () => (await roomState(page))?.names['hangar-2016'] ?? 0, {
        timeout: 60_000,
        message: "2016's room arrives",
      })
      .toBe(1)
    // The aircraft on the tables, the medals: unawaited loads, as above.
    await page.waitForTimeout(4_000)
    const rows: LabelReading[] = []
    rows.push(...(await legibility(page, `${edition} rest`)))
    expect(await aimAt(page, 'hangar-parked-ship'), 'turned to the jet').toBe(true)
    rows.push(...(await legibility(page, `${edition} jet`)))
    for (const r of rows) {
      console.log(
        `[DEV-437] label ${r.where} ${r.label}: ${r.vsSurround.toFixed(2)}:1 against its surround, ${r.vsBehind.toFixed(2)}:1 against the room behind (text L ${r.text.toFixed(3)}, surround ${r.surround.toFixed(3)}, behind ${r.behind.toFixed(3)}; ${r.glyphs} px)`,
      )
    }
    // Positive first: labels were found and measured on both framings.
    expect(rows.filter((r) => r.where.endsWith('rest')).length, 'labels at rest').toBeGreaterThan(1)
    expect(rows.filter((r) => r.where.endsWith('jet')).length, 'labels at the jet').toBeGreaterThan(
      1,
    )
    for (const r of rows) {
      expect(r.vsSurround, `${r.where} ${r.label} reads against the room`).toBeGreaterThanOrEqual(
        LABEL_CONTRAST_FLOOR,
      )
    }
  })
}

/** Every light on the stage by name, with its intensity; ambient lights summed as `ambient`. */
const lightLevels = async (page: Page): Promise<Record<string, number> | null> =>
  page.evaluate(() => {
    interface Node {
      name: string
      isLight?: boolean
      isAmbientLight?: boolean
      intensity?: number
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return null
    const out: Record<string, number> = { ambient: 0 }
    ff.stage().traverse((o) => {
      if (!o.isLight) return
      if (o.isAmbientLight) out.ambient = (out.ambient ?? 0) + (o.intensity ?? 0)
      else if (o.name) out[o.name] = o.intensity ?? 0
    })
    return out
  })

/**
 * Show the generated room (true) or 2016's (false), by visibility alone: the
 * 2016 meshes and pedestals one way, the generated shell, floor, strips,
 * dressing, chair and each table's cylinder plinth the other. Returns how many
 * objects it touched.
 */
const showGenerated = async (page: Page, generated: boolean): Promise<number> =>
  page.evaluate((generated) => {
    interface Node {
      name: string
      visible: boolean
      isMesh?: boolean
      geometry?: { type: string }
      children: Node[]
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (globalThis as unknown as { __ff2?: { stage: () => Node } }).__ff2
    if (!ff) return 0
    let touched = 0
    const set = (o: Node, v: boolean) => {
      o.visible = v
      touched++
    }
    ff.stage().traverse((o) => {
      if (
        [
          'hangar-2016',
          'hangar-2016-shell',
          'hangar-2016-deck',
          'hangar-2016-shaft',
          'hangar-2016-lamps',
          'holotable-pedestal',
        ].includes(o.name)
      )
        set(o, !generated)
      if (
        [
          'hangar-shell',
          'hangar-floor',
          'hangar-strips',
          'hangar-dressing',
          'hangar-chair',
        ].includes(o.name)
      )
        set(o, generated)
      if (o.name === 'hangar-holotable')
        for (const c of o.children)
          if (c.isMesh && c.geometry?.type === 'CylinderGeometry') set(c, generated)
    })
    return touched
  }, generated)
