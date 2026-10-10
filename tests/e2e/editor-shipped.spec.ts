/**
 * The editor opens a SHIPPED mission, a ring is moved and saved, and no page
 * on the dev server is reloaded by it — with positive evidence that the
 * server's watcher SAW the save. DEV-540 (docs/plan/SHIPPED-COURSE-EDITS.md
 * §4, §5, §8).
 *
 * Every step is a gesture: the handle clicked, F to bring the eye to it, the
 * gizmo's Y arrow hovered and dragged, Save / Fly / Fly 2016's / Back to 2016
 * pressed, the pause plate's Back to editor chosen with the keys.
 *
 *  · `?edit=1&shipped=<id>` opens the shipped desk over the mission's world;
 *  · a ring is dragged up, and the draft says it moved (and, far enough, that
 *    it is off the racing line);
 *  · SAVE writes `content/overrides/<id>.json` through the dev server's write
 *    (DEV-539): the bytes on disk are the draft's own canonical text, pinned
 *    to the manifest's line, and their sha256 is the one the server answered;
 *  · THE WATCHER SAW IT: the writer's swallow record (`GET
 *    /__ff2/override-hmr`) holds a `create` of that file. A swallow is written
 *    only when a file event reached the plugin's hot-update hook, so this is
 *    the positive half the no-reload needs: on a server whose watcher cannot
 *    see `content/overrides/` (every worktree's, before DEV-540 anchored
 *    DEV-255's watch-ignore in `vite.config.ts`) it never appears and the spec
 *    fails, where a bare "no reload" would have passed;
 *  · and for NO_RELOAD_MS after it, the page is the same page (a marker set on
 *    `window` survives, and the main frame never navigated);
 *  · FLY builds the course as edited: the world's trigger for that ring
 *    stands where the draft moved it. FLY 2016's builds 2016's: it stands
 *    where 2016 put it. Neither is a page load;
 *  · BACK TO 2016 deletes the file through the same write: gone from disk, a
 *    swallowed `delete` in the record, and still no reload.
 *
 * ── Where the reload-positive control lives ─────────────────────────────
 *
 * Not here. A reload caused on purpose (a hand edit in the override glob)
 * reaches EVERY page on the dev server — Vite broadcasts `full-reload` — and
 * in a four-wide run the first version of this spec, which deleted the file by
 * hand as its control, reloaded two neighbours mid-test (`editor-seed` never
 * saw its world; `editor-input` hung to its timeout). The same-server controls
 * are `tests/unit/override-writer-hmr.test.ts`'s arms A, D and F: a create, an
 * edit and a delete BY HAND each reload the page, on a real Vite server with
 * the real plugin. Run alone, this spec's first version measured the hand
 * delete reloading its page in 380 ms against the 6 s window (DEVIATIONS
 * DEV-540).
 *
 * ── Why this writes a REAL mission's file, and how it keeps it safe ───────
 *
 * The brief was *"tests write only `_fixture_` overrides"*. A `_fixture_` file
 * cannot answer this spec's question: `load-level.ts` leaves `_`-files OUT of
 * its glob (DEV-538), so writing one never reaches the page's module graph,
 * with or without the writer's swallow; and the writer refuses a `_` id (404).
 * So the target is the first HoverJet mission with NO override on disk (int_01
 * first); the spec refuses to start if every one has one, never touches a file
 * it did not create, removes it with the editor's own Back to 2016, and
 * removes it again in `finally` if a failure left it. No override survives a
 * run, pass or fail.
 *
 * Tagged `@gpu`.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { missionReady, switchGone } from './fixtures/boot'
import { clickCanvasAt, dragCanvas, hoverCanvasAt } from './fixtures/canvas'
import { collectPageErrors, editorLinkUrl, editorHold as hold } from './fixtures/editor-boot'
import type { Ff2Global } from './fixtures/ff2'
import { expect, type Page, test } from './fixtures/test'

const ROOT = process.cwd()
const LEVELS = path.join(ROOT, 'content', 'levels')
const OVERRIDES = path.join(ROOT, 'content', 'overrides')

/** How long a page is watched for a reload that must not come: 15x the 380 ms a hand delete took to reload it (DEV-540). */
const NO_RELOAD_MS = 6_000

type V3 = [number, number, number]
interface ShippedProbe {
  kind: 'shipped'
  id: string
  groundReady: boolean
  dirty: boolean
  selection: { kind: string; key?: string } | null
  rings: { key: string; pos: V3; trigger: V3 }[]
  baseRings: { key: string; pos: V3; trigger: V3 }[]
  overrideText: string | null
  warnings: string[]
  saved: {
    path: string
    sha256: string
    bytes: number
    unchanged: boolean
    checked: boolean | null
  } | null
  saveError: string
  status: string
  onDisk: boolean
  drawnRings: number
  drawnTurns: number
  gizmo: { attached: boolean; axis: string | null; dragging: boolean; mode: string }
}

/** The HoverJet missions, int_01 first: the ones the door opens. */
const hoverjets = (): string[] => {
  const ids = fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => {
      const level = JSON.parse(fs.readFileSync(path.join(LEVELS, `${id}.json`), 'utf8'))
      return level.vehicle === 'hoverjet'
    })
    .sort()
  return ['int_01_hoverJet', ...ids.filter((id) => id !== 'int_01_hoverJet')]
}

const manifestLine = (id: string): string | null => {
  const manifest = fs.readFileSync(path.join(ROOT, 'content', '_generated.sha256'), 'utf8')
  for (const line of manifest.split('\n')) {
    const [sha, file] = line.trim().split(/\s+/)
    if (file === `content/levels/${id}.json`) return sha ?? null
  }
  return null
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

/** The world's ring triggers, as the game built them for the flight: world space, course order. */
const worldTriggers = (page: Page): Promise<V3[]> =>
  page.evaluate(async () => {
    const w = globalThis as unknown as Ff2Global
    const world = await w.__ff2.world
    return (world?.rings.triggers ?? []).map((t) => [t.centre.x, t.centre.y, t.centre.z]) as V3[]
  })

const nearest = (list: V3[], p: V3): number =>
  Math.min(...list.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])))

/** The writer's swallow record: every file event it delivered and suppressed. */
const swallowed = (page: Page): Promise<{ type: string; file: string }[]> =>
  page.evaluate(async () => {
    const res = await fetch('/__ff2/override-hmr', { cache: 'no-store' })
    return ((await res.json()) as { swallowed: { type: string; file: string }[] }).swallowed
  })

/** Is this still the page the spec marked? Null while a reload is under way. */
const marker = async (page: Page): Promise<string | null> => {
  try {
    return await page.evaluate(
      () => (globalThis as unknown as { __w30Marker?: string }).__w30Marker ?? null,
    )
  } catch {
    return null
  }
}

/** Fly (one of the two buttons), check the world, and come back by the pause plate. */
const flyAndBack = async (
  page: Page,
  button: string,
  check: () => Promise<void>,
): Promise<void> => {
  await page.locator(`[data-editor="${button}"]`).click()
  await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
  await switchGone(page)
  await missionReady(page)
  await check()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await hold(page, 'Backspace')
  for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
  await hold(page, 'Enter', 300)
  await editing(page)
}

test.describe('@gpu the editor opens a shipped mission (DEV-540)', () => {
  test.setTimeout(600_000)

  test('move a ring, save: the watcher saw it and nothing reloaded; fly it and 2016’s; back to 2016', async ({
    page,
  }) => {
    const id = hoverjets().find((m) => !fs.existsSync(path.join(OVERRIDES, `${m}.json`)))
    if (!id) {
      throw new Error(
        'every HoverJet mission has an override on disk; this spec will not overwrite one',
      )
    }
    const FILE = path.join(OVERRIDES, `${id}.json`)
    // DEV-544: a Save that moves the course rebuilds the lap server's courses
    // in the same write, and Back to 2016 puts them back.
    const LAPS = path.join(ROOT, 'content', 'lap-courses.json')
    const lapsBefore = fs.readFileSync(LAPS, 'utf8')
    const pageErrors = collectPageErrors(page)
    try {
      // ── open ─────────────────────────────────────────────────────────────
      await page.goto(editorLinkUrl({ shipped: id }))
      await missionReady(page)
      await editing(page)
      const opened = await desk(page)
      expect(opened.id).toBe(id)
      expect(opened.dirty, 'nothing on disk and no edit: clean').toBe(false)
      expect(opened.overrideText).toBeNull()
      expect(opened.warnings, '2016’s course, judged: nothing to say').toEqual([])
      await expect
        .poll(async () => (await desk(page)).drawnRings, { timeout: 60_000 })
        .toBe(opened.rings.length)
      await expect
        .poll(async () => (await desk(page)).drawnTurns, { timeout: 60_000 })
        .toBeGreaterThan(0)
      await expect(page.locator('#editor-panel')).toContainText('SHIPPED MISSION')

      // From here on, the page must stay THIS page until the control arm.
      await page.evaluate(() => {
        ;(globalThis as unknown as { __w30Marker?: string }).__w30Marker = 'alive'
      })
      let navigations = 0
      page.on('framenavigated', (f) => {
        if (f === page.mainFrame()) navigations++
      })

      // ── pick a ring by its handle, bring the eye to it ────────────────────
      const i = Math.floor(opened.rings.length / 2)
      const ring = opened.rings[i] as ShippedProbe['rings'][number]
      const at = await debug<{ x: number; y: number } | null>(page, 'screenOf', ...ring.pos)
      expect(at, 'the ring’s handle is on screen').not.toBeNull()
      await clickCanvasAt(page, (at as { x: number }).x, (at as { y: number }).y)
      await expect
        .poll(async () => (await desk(page)).selection)
        .toEqual({ kind: 'ring', key: ring.key })
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await hold(page, 'f')
      await page.waitForTimeout(1_500)

      // ── drag the gizmo's Y arrow up ───────────────────────────────────────
      const handle = await debug<{ x: number; y: number } | null>(page, 'gizmoHandle', 'Y')
      expect(handle, 'the Y arrow is on screen').not.toBeNull()
      const h = handle as { x: number; y: number }
      await hoverCanvasAt(page, h.x, h.y)
      await expect.poll(async () => (await desk(page)).gizmo.axis, { timeout: 5_000 }).toBe('Y')
      await dragCanvas(page, h, { x: h.x, y: h.y - 90 }, { steps: 18 })
      await expect.poll(async () => (await desk(page)).gizmo.dragging).toBe(false)
      const moved = await desk(page)
      const now = moved.rings[i] as ShippedProbe['rings'][number]
      expect(now.key).toBe(ring.key)
      const rise = now.pos[1] - ring.pos[1]
      console.log(`[DEV-540] ${id} ring ${i + 1} (${ring.key}) dragged up ${rise.toFixed(1)} m`)
      expect(rise, 'the ring went up').toBeGreaterThan(5)
      expect(Math.abs(now.pos[0] - ring.pos[0]), 'and only up').toBeLessThan(0.1)
      expect(Math.abs(now.pos[2] - ring.pos[2]), 'and only up').toBeLessThan(0.1)
      // Rigid: the trigger went with it, by the same rise.
      expect(now.trigger[1] - ring.trigger[1]).toBeCloseTo(rise, 1)
      expect(moved.dirty).toBe(true)
      expect(moved.overrideText).not.toBeNull()
      if (rise > 25) expect(moved.warnings).toContain('ring-off-line')
      expect(fs.existsSync(FILE), 'nothing written before Save').toBe(false)

      // ── SAVE ───────────────────────────────────────────────────────────────
      await page.locator('[data-editor="shipped-save"]').click()
      // The first save loads the validator into the dev server (`ssrLoadModule`),
      // which under a four-wide run took longer than 15 s once.
      await expect.poll(async () => (await desk(page)).saved, { timeout: 90_000 }).not.toBeNull()
      const saved = await desk(page)
      expect(saved.saveError).toBe('')
      expect(saved.dirty, 'saved is clean').toBe(false)
      expect(fs.existsSync(FILE), 'the file is in content/overrides/').toBe(true)
      const bytes = fs.readFileSync(FILE, 'utf8')
      expect(bytes, 'the file is the draft’s own text').toBe(saved.overrideText)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(saved.saved?.sha256)
      expect(saved.saved?.checked, 'the page checked the same sha').toBe(true)
      expect(saved.saved?.unchanged).toBe(false)
      // DEV-544: a moved ring moves the course, so the same Save rebuilt the lap courses.
      expect(fs.readFileSync(LAPS, 'utf8'), 'the Save rebuilt content/lap-courses.json').not.toBe(
        lapsBefore,
      )
      expect(saved.status).toContain('content/lap-courses.json')
      const file = JSON.parse(bytes) as {
        mission: string
        base: string
        rings?: { move?: Record<string, { pos: V3 }> }
      }
      expect(file.mission).toBe(id)
      expect(file.base, 'pinned to the manifest’s line').toBe(manifestLine(id))
      expect(Object.keys(file.rings?.move ?? {})).toEqual([ring.key])
      expect(
        Math.hypot(
          ...((file.rings?.move?.[ring.key]?.pos ?? [0, 0, 0]).map(
            (v, k) => v - (now.pos[k] as number),
          ) as V3),
        ),
      ).toBeLessThan(0.01)

      // ── THE WATCHER SAW IT, and NO RELOAD ──────────────────────────────────
      const where = `content/overrides/${id}.json`
      await expect
        .poll(
          async () =>
            (await swallowed(page)).some((w) => w.type === 'create' && w.file.endsWith(where)),
          {
            timeout: 10_000,
            message:
              'the dev server’s watcher delivered the save’s create, and the writer swallowed it',
          },
        )
        .toBe(true)
      await expect
        .poll(
          async () =>
            (await swallowed(page)).some((w) => w.file.endsWith('content/lap-courses.json')),
          {
            timeout: 10_000,
            message: 'the watcher delivered the lap courses’ rewrite, and the writer swallowed it',
          },
        )
        .toBe(true)
      await page.waitForTimeout(NO_RELOAD_MS)
      expect(await marker(page), 'the page that saved is the same page').toBe('alive')
      expect(navigations, 'and it never navigated').toBe(0)

      // ── FLY: the world's trigger is where the draft moved it ───────────────
      await flyAndBack(page, 'shipped-fly', async () => {
        const triggers = await worldTriggers(page)
        expect(triggers.length).toBe(saved.rings.length)
        expect(
          nearest(triggers, now.trigger),
          'the moved ring flies where it was moved',
        ).toBeLessThan(0.5)
        expect(nearest(triggers, ring.trigger), 'and not where 2016 had it').toBeGreaterThan(
          rise / 2,
        )
      })
      const back = await desk(page)
      expect(back.selection, 'the pick is as it was left').toEqual({ kind: 'ring', key: ring.key })
      expect(back.dirty).toBe(false)

      // ── FLY 2016's: the same ring where 2016 put it ───────────────────────
      await flyAndBack(page, 'shipped-fly-2016', async () => {
        const triggers = await worldTriggers(page)
        expect(triggers.length).toBe(opened.baseRings.length)
        expect(nearest(triggers, ring.trigger), '2016’s ring flies where 2016 put it').toBeLessThan(
          0.5,
        )
        expect(nearest(triggers, now.trigger)).toBeGreaterThan(rise / 2)
      })
      expect(await marker(page), 'two flights, still the same page').toBe('alive')
      expect(navigations).toBe(0)

      // ── BACK TO 2016: the file deleted through the same write ─────────────
      await page.locator('[data-editor="shipped-back-2016"]').click()
      await expect.poll(() => fs.existsSync(FILE), { timeout: 15_000 }).toBe(false)
      await expect
        .poll(
          async () =>
            (await swallowed(page)).some((w) => w.type === 'delete' && w.file.endsWith(where)),
          {
            timeout: 10_000,
            message: 'the watcher delivered the delete, and the writer swallowed it',
          },
        )
        .toBe(true)
      await expect
        .poll(() => fs.readFileSync(LAPS, 'utf8'), {
          timeout: 15_000,
          message: 'Back to 2016 put the committed lap courses back',
        })
        .toBe(lapsBefore)
      const reverted = await desk(page)
      expect(reverted.onDisk).toBe(false)
      expect(reverted.dirty, 'back to 2016 and nothing on disk: clean').toBe(false)
      expect(reverted.overrideText).toBeNull()
      expect((reverted.rings[i] as ShippedProbe['rings'][number]).pos).toEqual(ring.pos)
      await page.waitForTimeout(NO_RELOAD_MS)
      expect(await marker(page), 'deleted, and still the same page').toBe('alive')
      expect(navigations).toBe(0)
      expect(pageErrors).toEqual([])
    } finally {
      // Only after a failure. A save still in flight when the test gave up once
      // landed AFTER this cleanup and left a real override on disk, so wait for
      // the page's own save or delete to settle first. (A delete by hand here
      // reloads every page on the server; a passing run never gets here.)
      const settleBy = Date.now() + 90_000
      while (Date.now() < settleBy) {
        const s = await desk(page).catch(() => null)
        if (!s || !/^(Saving|Deleting)/.test(s.status)) break
        await page.waitForTimeout(500)
      }
      if (fs.existsSync(FILE)) fs.rmSync(FILE)
      // DEV-544: and the lap courses that Save rebuilt.
      if (fs.readFileSync(LAPS, 'utf8') !== lapsBefore) fs.writeFileSync(LAPS, lapsBefore)
    }
  })
})
