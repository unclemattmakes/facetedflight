/**
 * The shipped desk's racing line: Edit the line, drag a point of it, Snap a
 * ring back onto it, and Fly it. DEV-541 (docs/plan/SHIPPED-COURSE-EDITS.md
 * §4.4, §9).
 *
 * Every step is a gesture: the Edit the line button, a handle clicked, F, the
 * gizmo's Y arrow dragged, Snap to line pressed, Ctrl+Z and Ctrl+Y, Fly, the
 * pause plate's Back to editor chosen with the keys, 2016's line pressed.
 *
 *  · EDIT THE LINE seeds the file's own line from 2016's (`fitFlight`): a
 *    handle per control point, at most the format's 64, and the draft's text
 *    now carries `route.points` and nothing else under `route`;
 *  · a control point near a ring dragged up takes the line off that ring, and
 *    the desk says so (`ring-off-line`);
 *  · SNAP TO LINE stands the ring back on the line as it now runs, and the
 *    warning goes; Ctrl+Z brings it back, Ctrl+Y snaps again;
 *  · FLY builds the course as edited: the world's trigger for that ring stands
 *    where it was snapped;
 *  · 2016'S LINE drops the file's line, and keeps the ring's snap.
 *
 * NOTHING IS SAVED: the spec never presses Save, and checks that no file
 * appeared for its mission. It opens `rookie_02_hoverJet`, which
 * `editor-shipped.spec.ts` (the one spec that writes a real override, int_01
 * first) reaches only after every other HoverJet mission has a file, so the
 * two can run side by side. Whether the AI racers take every ring on an edited
 * line is the unit proof's (`tests/unit/override-racers.test.ts`).
 *
 * Tagged `@gpu`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt, dragCanvas, hoverCanvasAt } from './fixtures/canvas'
import { collectPageErrors, editorLinkUrl, editorHold as hold } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const ID = 'rookie_02_hoverJet'
const FILE = path.join(process.cwd(), 'content', 'overrides', `${ID}.json`)

type V3 = [number, number, number]
interface ShippedProbe {
  kind: 'shipped'
  id: string
  groundReady: boolean
  dirty: boolean
  selection: { kind: string; key?: string; index?: number } | null
  rings: { key: string; pos: V3; trigger: V3 }[]
  handles: { entity: { kind: string; index?: number; key?: string }; at: V3; state: string }[]
  linePoints: V3[] | null
  overrideText: string | null
  warnings: string[]
  status: string
  onDisk: boolean
  gizmo: { attached: boolean; axis: string | null; dragging: boolean; mode: string }
}

const editor = (page: Page): Promise<{ editing: boolean; flying: string | null; desk: unknown }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editor()
  }) as Promise<{ editing: boolean; flying: string | null; desk: unknown }>

const desk = async (page: Page): Promise<ShippedProbe> => {
  const d = (await editor(page)).desk as ShippedProbe | null
  if (!d) throw new Error('the desk has not loaded')
  return d
}

const debug = <T>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([n, a]) => {
      const w = globalThis as unknown as Ff2Global
      const d = w.__ff2.editorDebug() as unknown as Record<
        string,
        (...x: unknown[]) => unknown
      > | null
      if (!d) throw new Error('no editor debug')
      return (d[n as string] as (...x: unknown[]) => unknown)(...(a as unknown[]))
    },
    [name, args] as const,
  ) as Promise<T>

const blur = (page: Page): Promise<void> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

const editing = async (page: Page): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', { timeout: 240_000 })
  await expect
    .poll(
      async () => {
        const d = (await editor(page)).desk as ShippedProbe | null
        return d?.kind === 'shipped' && d.groundReady
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}

/** Metres from `p` to the polyline `line`, to its segments. */
const toLine = (p: V3, line: V3[]): number => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as V3
    const b = line[i] as V3
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
    const L = (ab[0] ?? 0) ** 2 + (ab[1] ?? 0) ** 2 + (ab[2] ?? 0) ** 2
    const u =
      L > 0
        ? Math.max(
            0,
            Math.min(
              1,
              ((ap[0] ?? 0) * (ab[0] ?? 0) +
                (ap[1] ?? 0) * (ab[1] ?? 0) +
                (ap[2] ?? 0) * (ab[2] ?? 0)) /
                L,
            ),
          )
        : 0
    best = Math.min(
      best,
      Math.hypot(
        (ap[0] ?? 0) - u * (ab[0] ?? 0),
        (ap[1] ?? 0) - u * (ab[1] ?? 0),
        (ap[2] ?? 0) - u * (ab[2] ?? 0),
      ),
    )
  }
  return best
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Click the handle at world point `p`, and wait for the pick. */
const pick = async (page: Page, p: V3, want: Record<string, unknown>): Promise<void> => {
  const at = await debug<{ x: number; y: number } | null>(page, 'screenOf', ...p)
  expect(at, 'the handle is on screen').not.toBeNull()
  await clickCanvasAt(page, (at as { x: number }).x, (at as { y: number }).y)
  await expect.poll(async () => (await desk(page)).selection).toEqual(want)
}

/** The world's ring triggers, as the game built them for the flight. */
const worldTriggers = (page: Page): Promise<V3[]> =>
  page.evaluate(async () => {
    const w = globalThis as unknown as Ff2Global
    const world = await w.__ff2.world
    return (world?.rings.triggers ?? []).map((t) => [t.centre.x, t.centre.y, t.centre.z]) as V3[]
  })

test.describe('@gpu the shipped desk edits the racing line (DEV-541)', () => {
  test.setTimeout(600_000)

  test('edit the line, drag a point off a ring, snap the ring back, fly it; 2016’s line', async ({
    page,
  }) => {
    if (fs.existsSync(FILE)) {
      throw new Error(`${ID} has an override on disk; this spec opens a mission with none`)
    }
    const pageErrors = collectPageErrors(page)

    // ── open ───────────────────────────────────────────────────────────────
    await page.goto(editorLinkUrl({ shipped: ID }))
    await missionReady(page)
    await editing(page)
    const opened = await desk(page)
    expect(opened.id).toBe(ID)
    expect(opened.linePoints, '2016’s line: the file has none').toBeNull()
    expect(opened.warnings).toEqual([])
    await expect(page.locator('[data-editor="shipped-facts"]')).toContainText('2016’s line')

    // ── EDIT THE LINE ──────────────────────────────────────────────────────
    await page.locator('[data-editor="shipped-edit-line"]').click()
    await expect.poll(async () => (await desk(page)).linePoints !== null).toBe(true)
    const seeded = await desk(page)
    const points = seeded.linePoints as V3[]
    console.log(`[DEV-541] ${ID}: Edit the line seeded ${points.length} points`)
    expect(points.length).toBeGreaterThan(1)
    expect(points.length).toBeLessThanOrEqual(64)
    expect(seeded.handles.filter((h) => h.entity.kind === 'point')).toHaveLength(points.length)
    expect(seeded.warnings, 'the seeded line runs through every ring').toEqual([])
    expect(seeded.dirty).toBe(true)
    const text = JSON.parse(seeded.overrideText as string) as { route?: Record<string, unknown> }
    expect(Object.keys(text.route ?? {}), 'the file holds points and nothing else').toEqual([
      'points',
    ])
    await expect(page.locator('[data-editor="shipped-status"]')).toContainText('The line is yours')
    await expect(page.locator('[data-editor="shipped-facts"]')).toContainText(
      `your line, ${points.length} points`,
    )
    await expect(page.locator('[data-editor="shipped-edit-line"]')).toBeDisabled()

    // ── the ring in the middle, and the line point nearest it ──────────────
    const i = Math.floor(seeded.rings.length / 2)
    const ring = seeded.rings[i] as ShippedProbe['rings'][number]
    let j = 0
    points.forEach((p, k) => {
      if (dist(p, ring.trigger) < dist(points[j] as V3, ring.trigger)) j = k
    })
    // The ring first, then F, so the point's handle stands clear of it on screen.
    await pick(page, ring.pos, { kind: 'ring', key: ring.key })
    await blur(page)
    await hold(page, 'f')
    await page.waitForTimeout(1_500)
    await pick(page, points[j] as V3, { kind: 'point', index: j })
    await expect(page.locator('[data-editor="shipped-selection"]')).toContainText(
      `Line point ${j + 1}`,
    )
    await expect(page.locator('[data-editor="shipped-rotate"]')).toBeDisabled()

    // ── drag the point up: the line leaves the ring ────────────────────────
    const off0 = toLine(ring.trigger, await debug<V3[]>(page, 'lineSamples'))
    const handle = await debug<{ x: number; y: number } | null>(page, 'gizmoHandle', 'Y')
    expect(handle, 'the Y arrow is on screen').not.toBeNull()
    const h = handle as { x: number; y: number }
    await hoverCanvasAt(page, h.x, h.y)
    await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('Y')
    await dragCanvas(page, h, { x: h.x, y: h.y - 140 }, { steps: 20 })
    await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
    const lifted = await desk(page)
    const was = points[j] as V3
    const now = (lifted.linePoints as V3[])[j] as V3
    const rise = now[1] - was[1]
    console.log(`[DEV-541] line point ${j + 1} dragged up ${rise.toFixed(1)} m`)
    expect(rise, 'the point went up').toBeGreaterThan(30)
    expect(Math.abs(now[0] - was[0]), 'and only up').toBeLessThan(0.1)
    expect(Math.abs(now[2] - was[2]), 'and only up').toBeLessThan(0.1)
    const line = await debug<V3[]>(page, 'lineSamples')
    const off = toLine(ring.trigger, line)
    console.log(`[DEV-541] ring ${i + 1}'s trigger is now ${off.toFixed(1)} m off the line`)
    // The desk's own judgement (past the trigger's radius), and the spec's measure agreeing it moved.
    expect(lifted.warnings).toContain('ring-off-line')
    expect(off, 'the line left the ring').toBeGreaterThan(off0)

    // ── SNAP the ring back onto the line ───────────────────────────────────
    await pick(page, ring.pos, { kind: 'ring', key: ring.key })
    await page.locator('[data-editor="shipped-snap"]').click()
    await expect.poll(async () => (await desk(page)).warnings).not.toContain('ring-off-line')
    const snapped = await desk(page)
    const onto = snapped.rings[i] as ShippedProbe['rings'][number]
    expect(onto.key).toBe(ring.key)
    expect(toLine(onto.pos, line), 'the ring stands on the line').toBeLessThan(0.2)
    expect(dist(onto.pos, ring.pos), 'it moved to get there').toBeGreaterThan(10)

    // ── Ctrl+Z, Ctrl+Y ─────────────────────────────────────────────────────
    await blur(page)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await desk(page)).warnings).toContain('ring-off-line')
    expect(((await desk(page)).rings[i] as ShippedProbe['rings'][number]).pos).toEqual(ring.pos)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await desk(page)).warnings).not.toContain('ring-off-line')

    // ── FLY: the world's trigger stands where the ring was snapped ─────────
    await page.locator('[data-editor="shipped-fly"]').click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page)
    await missionReady(page)
    const triggers = await worldTriggers(page)
    expect(triggers).toHaveLength(snapped.rings.length)
    expect(Math.min(...triggers.map((t) => dist(t, onto.trigger)))).toBeLessThan(0.5)
    await blur(page)
    await hold(page, 'Backspace')
    for (let k = 0; k < 10; k++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await editing(page)

    // ── 2016'S LINE: the file's line goes; the snapped ring stays ──────────
    await page.locator('[data-editor="shipped-line-2016"]').click()
    await expect.poll(async () => (await desk(page)).linePoints).toBeNull()
    const back = await desk(page)
    expect(back.handles.filter((h2) => h2.entity.kind === 'point')).toHaveLength(0)
    const file = JSON.parse(back.overrideText as string) as {
      route?: unknown
      rings?: { move?: Record<string, unknown> }
    }
    expect(file.route).toBeUndefined()
    expect(Object.keys(file.rings?.move ?? {})).toEqual([ring.key])
    await expect(page.locator('[data-editor="shipped-facts"]')).toContainText('2016’s line')

    // Nothing was saved.
    expect(back.onDisk).toBe(false)
    expect(fs.existsSync(FILE), 'no file was written').toBe(false)
    expect(pageErrors).toEqual([])
  })
})
