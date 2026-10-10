/**
 * Fly-to-author: a flight recorded from the editor becomes the course's line.
 * DEV-491 (docs/plan/EDITOR-WAVE-3.md; `src/editor/core/fit.ts`).
 *
 * EDITOR.md §5.3: *"2016's Recording mode handed to players."* Every step is a
 * person's gesture — a click on the panel, a key held on the keyboard:
 *
 *  · in by the title's door (COURSES → MAKE A COURSE), to int_01's island;
 *  · RECORD A FLIGHT: the game switches to a Free Flight from the draft's pad;
 *  · R on the pad ARMS the recording, Enter launches, and it starts at the
 *    lift-off; the ship is flown by hand — throttle, boost, a bank one way
 *    and then the other, a climb, for about eighteen seconds;
 *  · R again: back in the editor, the flight is the line;
 *  · the line is held to the flight by THIS FILE's own measure (a two-way
 *    distance between the drawn line's samples and the drawn flight's), not
 *    by the fit's; the pad stands at the flight's start; it is ONE undo step;
 *  · and the course is flyable: DEV-478's `liftToFlyable`.
 *
 * NOT the autopilot, though the brief asked for it: Free Flight does not offer
 * it (DEV-435, Matt: *"unavailable in free flight"* — it flies gates, and a
 * recording has none), so a recording flight is flown the way a person flies
 * one. Photographs of the flight and of the line it became go to
 * `EDITOR_RECORD_PHOTOS` (or test-results). The tier is pinned in the URL
 * (`fixtures/quality-pin.ts`). Tagged `@gpu`.
 */

import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { collectPageErrors, editorHold as hold, openEditorFromTitle } from './fixtures/editor-boot'
import { liftToFlyable } from './fixtures/editor-course'
import type { Ff2Global } from './fixtures/ff2'
import { photographer } from './fixtures/photo'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

const OUT = process.env.EDITOR_RECORD_PHOTOS ?? path.join('test-results', 'editor-record')

/** `FIT_POLICY.toleranceMetres` (pinned by value in `editor-fit.test.ts`). NOT imported: no edge into src/. */
const TOLERANCE = 8

type V3 = [number, number, number]

interface RecordProbe {
  gap: number // DEV-501
  groundReady: boolean
  sky: string
  points: V3[]
  undoDepth: number
  canUndo: boolean
  canRedo: boolean
  start: { pos: V3; yaw: number }
  recording: {
    seconds: number
    metres: number
    samples: number
    points: number
    error: number
    tolerance: number
    within: boolean
  } | null
  recordNote: string
}
interface EditorProbe {
  editing: boolean
  desk: RecordProbe | null
}

const editor = (page: Page): Promise<EditorProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    return w.__ff2.editor()
  }) as Promise<EditorProbe>
const desk = async (page: Page): Promise<RecordProbe> => {
  const e = await editor(page)
  if (!e.desk) throw new Error('the desk has not loaded')
  return e.desk
}

/** The drawn line and the drawn flight, read back off their buffers. */
const drawn = (page: Page): Promise<{ line: V3[]; flight: V3[] }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2Global
    const d = w.__ff2.editorDebug()
    return d ? { line: d.lineSamples(), flight: d.recordedFlight() } : { line: [], flight: [] }
  })

const launchPhase = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.launch().phase)

const photo = photographer(OUT)

// ── This file's own geometry ──────────────────────────────────────────────

const segDist = (p: V3, a: V3, b: V3): number => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
  const ll = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
  let t = ll > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / ll : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2])
}
const toLine = (p: V3, line: readonly V3[]): number => {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < line.length; i++) {
    best = Math.min(best, segDist(p, line[i] as V3, line[i + 1] as V3))
  }
  return best
}
/** The most either polyline strays from the other, metres. */
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const twoWay = (a: readonly V3[], b: readonly V3[]): number => {
  let d = 0
  for (const p of a) d = Math.max(d, toLine(p, b))
  for (const p of b) d = Math.max(d, toLine(p, a))
  return d
}

test.describe('@gpu fly-to-author (DEV-491)', () => {
  test.setTimeout(900_000)

  test('record a flight from the editor: it becomes the line, within the tolerance, in one undo step, and flyable', async ({
    page,
  }) => {
    const pageErrors = collectPageErrors(page)
    const said: string[] = []
    page.on('console', (m) => {
      if (m.text().includes('recording') || m.text().includes('recorded')) said.push(m.text())
    })

    // ── in by the title's door ─────────────────────────────────────────────
    await openEditorFromTitle(page)
    const before = await desk(page)
    expect(before.sky).toBe('int_01_hoverJet')

    // ── RECORD A FLIGHT: Free Flight from the pad ─────────────────────────
    const record = page.locator('[data-editor="record"]')
    await expect(record).toBeEnabled()
    await record.click()
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'recording', {
      timeout: 30_000,
    })
    await switchGone(page)
    await missionReady(page)
    await expect.poll(async () => launchPhase(page), { timeout: 30_000 }).toBe('waiting')
    await expect(page.locator('body')).toHaveAttribute('data-mode', 'freeFlight')
    await expect(page.locator('body')).toHaveAttribute('data-rings-live', 'false')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

    // R on the pad arms it; the line on the screen says so.
    await expect(page.locator('#editor-record')).toContainText('R to start recording')
    await hold(page, 'r', 150)
    await expect(page.locator('body')).toHaveAttribute('data-editor-record', 'armed')
    await hold(page, 'v', 120) // the chase view, to see the ship fly
    await hold(page, 'Enter', 150)
    await expect.poll(async () => launchPhase(page), { timeout: 15_000 }).toBe('flying')
    await expect(page.locator('body')).toHaveAttribute('data-editor-record', 'recording', {
      timeout: 10_000,
    })

    // ── flown by hand: throttle and boost, a bank each way, a climb ───────
    await page.keyboard.down('Space')
    await page.keyboard.down('z')
    // DEV-630: Anniversary starts the boost tank EMPTY, and a Free Flight has no
    // rings to fill it, so boost lights only once the recharge reaches a
    // quarter (about 1.6 s) and cycles from there. The full-tank flight went
    // 2.2 km; the empty-tank one went 1.9 km and its fit kept only the pad's
    // two points. Fly the straight longer, and the last leg too, so the line
    // still has points past the pad's stretch (point 2, DEV-501).
    await page.waitForTimeout(4_000)
    await hold(page, 's', 700) // nose up: climb away from the ground
    await hold(page, 'a', 900) // bank left
    await page.waitForTimeout(2_500)
    await photo(page, 'record-1-in-flight.png')
    await hold(page, 'd', 1_600) // and right
    await page.waitForTimeout(3_000)
    await hold(page, 'a', 800)
    await page.waitForTimeout(4_500)
    await photo(page, 'record-2-in-flight.png')
    await page.keyboard.up('z')
    await page.keyboard.up('Space')

    // ── R again: the flight becomes the line ──────────────────────────────
    await hold(page, 'r', 150)
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'editing', {
      timeout: 180_000,
    })
    await expect.poll(async () => (await editor(page)).editing, { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => (await desk(page)).groundReady, { timeout: 60_000 }).toBe(true)
    await expect.poll(async () => (await desk(page)).recording, { timeout: 30_000 }).not.toBeNull()
    await expect(page.locator('#editor-record')).toBeHidden()
    const made = await desk(page)
    const rec = made.recording as NonNullable<RecordProbe['recording']>
    console.log(`[DEV-491] ${JSON.stringify(rec)} — ${made.recordNote}`)
    console.log(`[DEV-491] ${said.join(' | ')}`)
    expect(rec.seconds, 'a flight of some seconds was recorded').toBeGreaterThan(8)
    expect(rec.metres, 'and it went somewhere').toBeGreaterThan(500)
    expect(rec.within, 'the fit met the tolerance').toBe(true)
    expect(rec.tolerance).toBe(TOLERANCE)
    // DEV-501: a new draft is anchored, so the fit's points up to one gap from
    // the flight's start are the pad's stretch now: at most the fit's count.
    expect(made.points.length).toBeLessThanOrEqual(rec.points)
    expect(made.points.length).toBeGreaterThanOrEqual(2)
    await expect(page.locator('[data-editor="record-note"]')).toContainText('Recorded')

    // The line lies within the tolerance of the flight — measured HERE, both
    // ways, between what the desk DRAWS: the line's samples and the flight's.
    const { line, flight } = await drawn(page)
    expect(flight.length, 'the flight is drawn').toBeGreaterThan(50)
    expect(line.length, 'the line is drawn').toBeGreaterThan(10)
    // DEV-501: from point 2 on — the line past the pad's own stretch, whose
    // segments have only fitted points for neighbours — and the flight past
    // the place nearest point 2. Ring 1's height is the pad's, not the flight's.
    const nearestIn = (list: readonly V3[], q: V3): number => {
      let best = 0
      list.forEach((p, i) => {
        if (Math.hypot(...sub(p, q)) < Math.hypot(...sub(list[best] as V3, q))) best = i
      })
      return best
    }
    const p2 = made.points[2] as V3
    const off = twoWay(flight.slice(nearestIn(flight, p2)), line.slice(nearestIn(line, p2)))
    console.log(`[DEV-491] line vs flight, two-way: ${off.toFixed(2)} m (tolerance ${TOLERANCE} m)`)
    // 0.3 m: the fit sees the flight resampled every 10 m (its own sagitta).
    expect(off).toBeLessThanOrEqual(TOLERANCE + 0.3)

    // The pad stands at the flight's start, aimed along it; point 1 (ring 1)
    // is the pad's, one gap straight ahead of it (DEV-501).
    const f0 = flight[0] as V3
    expect(Math.hypot(made.start.pos[0] - f0[0], made.start.pos[2] - f0[2])).toBeLessThan(0.11)
    const p0 = made.start.pos
    const a0 = made.points[0] as V3
    expect(Math.abs(Math.hypot(a0[0] - p0[0], a0[2] - p0[2]) - made.gap)).toBeLessThan(0.2)
    const yaw = (made.start.yaw * Math.PI) / 180
    const fwd = [-Math.sin(yaw), -Math.cos(yaw)]
    const onward = line.find((q) => Math.hypot(q[0] - p0[0], q[2] - p0[2]) > 40) as V3
    const dir = [onward[0] - p0[0], onward[2] - p0[2]]
    const n = Math.hypot(dir[0] as number, dir[1] as number)
    expect(
      ((fwd[0] as number) * (dir[0] as number) + (fwd[1] as number) * (dir[1] as number)) / n,
      'the pad faces along the line',
    ).toBeGreaterThan(0.95)

    // ── the photographs: the flight (blue) and the line it became (white) ─
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(800)
    await photo(page, 'record-3-flight-and-line-top-down.png')
    await page.locator('[data-editor="top-down"]').click()
    await page.waitForTimeout(800)
    await photo(page, 'record-4-flight-and-line-orbit.png')

    // ── ONE undo step: undo gives back the draft, redo the recording ──────
    expect(made.undoDepth).toBe(before.undoDepth + 1)
    await page.locator('[data-editor="undo"]').click()
    await expect.poll(async () => (await desk(page)).points).toEqual(before.points)
    await page.locator('[data-editor="redo"]').click()
    await expect.poll(async () => (await desk(page)).points).toEqual(made.points)

    // ── flyable, by DEV-478's fixture ─────────────────────────────────────
    const lifted = await liftToFlyable(page, 'the recorded course')
    console.log(`[DEV-491] lift pressed: ${lifted}`)
    await photo(page, 'record-5-flyable.png')

    // ── every program linked (the flight's line is a new material) ─────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the editor frame drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(sweep.failed.map((f) => `#${f.id} ${f.type}`)).toEqual([])
    expect(pageErrors).toEqual([])
  })
})
