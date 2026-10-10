/**
 * tests/e2e/hangar-load.spec.ts — a course picked in the room is waited out IN
 * the room. DEV-465.
 *
 * Matt, 2026-09-27: *"would it be possible to stay in the hangar, but show the
 * loading indicator and spinning logo? (maybe hide the holo-tables that
 * weren't the last selected one)"*.
 *
 * The route a player takes, on both looks: the title, the room, the aimed
 * presses of `board()` onto `int_01_hoverJet`, and every animation frame from
 * then until the pad recorded in the page (what is on screen, the curtain, the
 * look). Then EXIT, back to the room.
 *
 *   - **Anniversary** (the menus' own look, so DEV-451's flip is a no-op): the
 *     room stays up and lit for the whole build — never hidden, never black —
 *     with the plate and the turning emblem in it, one table left (the one
 *     pressed), the page plates and the header down, and ONE black: the fade
 *     to the pad. The plate's materials link no program at the press (the
 *     primer, `render/loading-scene.ts`). Back in the room, the step is whole.
 *   - **Classic**: DEV-355's loading scene, as before. The flip to Classic is
 *     real and needs its black, and the room never wears Classic (D35), so
 *     this look keeps two blacks and the scene between them — and the look
 *     changes only on a black frame.
 *
 * Every reading is printed before anything is asserted. Photographs, pinned:
 * the room mid-load, and a second later.
 *
 *   E2E_PORT=<yours> HANGAR_LOAD_DIR=<dir> HANGAR_LOAD_LABEL=<after> \
 *     pnpm exec playwright test tests/e2e/hangar-load.spec.ts --workers 1
 *
 * `@gpu`: a real world and a headed browser.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { board, hold, INT_01_HOVERJET } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { drawState, drawStateDiff, PINNED } from './fixtures/quality-pin'
import { expect, type Page, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const OUT = process.env.HANGAR_LOAD_DIR ?? 'perf-out/dev-465'
const LABEL = process.env.HANGAR_LOAD_LABEL ?? 'run'

/** One animation frame, as the page drew it. */
interface Frame {
  readonly t: number
  /** The curtain, 0 clear .. 1 black. */
  readonly a: number
  readonly stage: string
  /** The room (`hangar`) drawn: its group visible, on the menu's stage. */
  readonly room: boolean
  /** The loading plate up, and the loading SCENE's dome up with it. */
  readonly plate: boolean
  readonly dome: boolean
  /** Holotables drawn in the room. */
  readonly tables: number
  /** The look worn (`edition.current.id`). */
  readonly look: string
  /** `data-switching` — the press to the black at the pad. */
  readonly switching: boolean
}

/** Record every animation frame, from now until `stopFrames`. */
const recordFrames = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    type Obj = {
      name: string
      visible: boolean
      parent: Obj | null
      getObjectByName: (n: string) => Obj | undefined
      traverse: (f: (o: Obj) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        stage: () => Obj
        fade: () => { amount: number }
        edition: { current: { id: string } }
      }
      __hlFrames?: unknown[]
      __hlStop?: boolean
    }
    const drawn = (o: Obj | undefined): boolean => {
      for (let n: Obj | null | undefined = o; n; n = n.parent) if (!n.visible) return false
      return o !== undefined
    }
    const frames: unknown[] = []
    w.__hlFrames = frames
    w.__hlStop = false
    const sample = (): void => {
      const app = w.__ff2
      if (!app) return
      const stage = app.stage()
      const menu = stage.name === 'menu'
      // The LAUNCH room is a `hangar` too, in the mission's stage: read the
      // room only on the menu's.
      const room = menu ? stage.getObjectByName('hangar') : undefined
      let tables = 0
      room?.traverse((o) => {
        if (o.name === 'hangar-holotable' && drawn(o)) tables++
      })
      const scene = stage.getObjectByName('loading-scene')
      frames.push({
        t: performance.now(),
        a: app.fade().amount,
        stage: stage.name,
        room: drawn(room),
        plate: drawn(scene?.getObjectByName('loading-plate')),
        dome: drawn(scene?.getObjectByName('loading-dome')),
        tables,
        look: app.edition.current.id,
        switching: document.body.dataset.switching === 'true',
      })
    }
    sample()
    const tick = (): void => {
      sample()
      if (!w.__hlStop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const stopFrames = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __hlFrames?: Frame[]; __hlStop?: boolean }
    w.__hlStop = true
    return (w.__hlFrames ?? []) as Frame[]
  })

/** Every program key three holds right now. */
const programKeys = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { render: { renderer: { info: { programs: { cacheKey: string }[] | null } } } }
        }
      ).__ff2?.render.renderer.info.programs?.map((p) => p.cacheKey) ?? [],
  )

interface MidLoad {
  readonly stage: string
  readonly fade: string | null
  readonly room: boolean
  readonly dome: boolean
  readonly plate: boolean
  readonly emblem: boolean
  /** The course each drawn holotable stands for. */
  readonly tables: string[]
  readonly pagePlates: boolean[]
  readonly header: boolean | null
  readonly look: string
  /** `__ff2.loading()`, where the build has one (null on a build without it). */
  readonly probe: { place: string | null; target: string | null; focus: string | null } | null
  /** Every program the plate's and the emblem's materials have been drawn with. */
  readonly plateKeys: string[]
  readonly markYaw: number | null
}

const midLoad = (page: Page): Promise<MidLoad> =>
  page.evaluate(() => {
    type Obj = {
      name: string
      visible: boolean
      isMesh?: boolean
      material?: unknown
      parent: Obj | null
      userData: Record<string, unknown>
      rotation: { y: number }
      getObjectByName: (n: string) => Obj | undefined
      traverse: (f: (o: Obj) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        stage: () => Obj
        edition: { current: { id: string } }
        loading?: () => { place: string | null; target: string | null; focus: string | null }
        render: {
          renderer: {
            properties: {
              get: (m: unknown) => { programs?: Map<string, unknown> }
            }
          }
        }
      }
    }
    const app = w.__ff2
    const drawn = (o: Obj | undefined): boolean => {
      for (let n: Obj | null | undefined = o; n; n = n.parent) if (!n.visible) return false
      return o !== undefined
    }
    const stage = app?.stage()
    const menu = stage?.name === 'menu'
    const room = menu ? stage?.getObjectByName('hangar') : undefined
    const tables: string[] = []
    room?.traverse((o) => {
      if (o.name === 'hangar-holotable' && drawn(o)) tables.push(String(o.userData.missionId))
    })
    const scene = stage?.getObjectByName('loading-scene')
    const plate = scene?.getObjectByName('loading-plate')
    const keys = new Set<string>()
    plate?.traverse((o) => {
      if (!o.isMesh || !app) return
      for (const k of app.render.renderer.properties.get(o.material).programs?.keys() ?? [])
        keys.add(k)
    })
    const header = room?.getObjectByName('hangar-header')
    return {
      stage: stage?.name ?? '',
      fade: document.body.dataset.fade ?? null,
      room: drawn(room),
      dome: drawn(scene?.getObjectByName('loading-dome')),
      plate: drawn(plate),
      emblem: drawn(scene?.getObjectByName('loading-emblem')),
      tables,
      pagePlates: ['hangar-page-prev', 'hangar-page-next'].map((n) =>
        drawn(room?.getObjectByName(n)),
      ),
      header: header ? drawn(header) : null,
      look: app?.edition.current.id ?? '',
      probe: app?.loading?.() ?? null,
      plateKeys: [...keys],
      markYaw: scene?.getObjectByName('loading-mark')?.rotation.y ?? null,
    }
  })

/** Runs of solid-black frames between two indices. */
const blacks = (frames: readonly Frame[], from: number, to: number): number => {
  let n = 0
  for (let i = from; i <= to && i < frames.length; i++) {
    if ((frames[i]?.a ?? 0) >= 1 && (frames[i - 1]?.a ?? 0) < 1) n++
  }
  return n
}

for (const look of ['anniversary', 'classic'] as const) {
  test.describe(`@gpu DEV-465 — a course picked in the room, ${look}`, () => {
    test.setTimeout(480_000)

    test(`int_01_hoverJet from the room, ${look}: where the load is waited out`, async ({
      page,
    }) => {
      const logs: string[] = []
      page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
      await page.goto(`/?xr=off&${PINNED}&edition=${look}`)
      await firstPress(page)
      await bootReady(page, 240_000)
      await dropFocus(page)
      await page.waitForTimeout(1_500)
      await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar
      const pinned = await drawState(page)
      // The emblem is its own small load of the logo (DEV-434); let it land so
      // the photographs show the plate a player sees.
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (
                  globalThis as unknown as {
                    __ff2?: { stage: () => { getObjectByName: (n: string) => unknown } }
                  }
                ).__ff2
                  ?.stage()
                  .getObjectByName('loading-emblem') !== undefined,
            ),
          { timeout: 20_000 },
        )
        .toBe(true)
      const atPress = new Set(await programKeys(page))

      fs.mkdirSync(OUT, { recursive: true })
      const stem = `hangar-load-int_01-${look}-${PINNED.replace(/[=&]/g, '-')}-${LABEL}`
      const shots: string[] = []

      await recordFrames(page)
      const boarding = board(page, INT_01_HOVERJET, 0)
      // The plate up, and whatever fade brought it there finished.
      await expect
        .poll(
          async () => {
            const m = await midLoad(page)
            return m.plate && m.fade === 'idle'
          },
          { timeout: 120_000, intervals: [50] },
        )
        .toBe(true)
      const first = await midLoad(page)
      const frameShot = path.join(OUT, `${stem}-1-mid.png`)
      await page.locator('#viewport').screenshot({ path: frameShot })
      shots.push(frameShot)
      await page.waitForTimeout(1_000)
      const later = await midLoad(page)
      if (later.plate) {
        const laterShot = path.join(OUT, `${stem}-2-a-second-later.png`)
        await page.locator('#viewport').screenshot({ path: laterShot })
        shots.push(laterShot)
      }

      await boarding
      await expect
        .poll(async () => (await midLoad(page)).plate, {
          timeout: 30_000,
          message: 'the plate is down once you are aboard',
        })
        .toBe(false)
      await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 60_000 })
      const frames = await stopFrames(page)
      const heldTier = drawStateDiff(pinned, await drawState(page))

      // ── and back to the room: the step whole again ─────────────────────
      await hold(page, 'Backspace')
      for (let i = 0; i < 8; i++) await hold(page, 'ArrowDown', 150)
      await hold(page, 'Enter', 2_500)
      await expect(page.locator('body')).toHaveAttribute('data-fade', 'idle', { timeout: 60_000 })
      const back = await midLoad(page)

      // ── the readings ──────────────────────────────────────────────────
      const from = frames.findIndex((f) => f.switching)
      const aboard = frames.findIndex((f, i) => i > from && f.stage === 'mission' && f.a < 1)
      const span = from < 0 || aboard < 0 ? [] : frames.slice(from, aboard)
      const firstBlack = span.findIndex((f) => f.a >= 1)
      const beforeBlack = firstBlack < 0 ? span : span.slice(0, firstBlack)
      const plateInRoom = beforeBlack.filter((f) => f.plate && f.room)
      const lookChanges = frames
        .map((f, i) => ({ f, prev: frames[i - 1] }))
        .filter(({ f, prev }) => prev !== undefined && f.look !== prev.look)
        .map(({ f }) => ({ look: f.look, a: f.a }))
      const compiledForPlate = first.plateKeys.filter((k) => !atPress.has(k))
      const turned =
        first.markYaw !== null && later.markYaw !== null
          ? (later.markYaw - first.markYaw + 2 * Math.PI) % (2 * Math.PI)
          : null
      const report = {
        look,
        label: LABEL,
        midLoad: first,
        framesPressToAboard: span.length,
        blacksPressToAboard: from < 0 || aboard < 0 ? null : blacks(frames, from, aboard),
        roomUpEveryFrameUntilTheBlack: beforeBlack.every((f) => f.stage === 'menu' && f.room),
        domeEverUp: span.some((f) => f.dome),
        plateInTheRoomFrames: plateInRoom.length,
        tablesWhilePlateInRoom: [...new Set(plateInRoom.map((f) => f.tables))],
        lookChanges,
        programsCompiledForThePlate: compiledForPlate.length,
        markTurnedInASecond: turned,
        back: { tables: back.tables, header: back.header, probe: back.probe, stage: back.stage },
        tierHeld: heldTier,
        shots: shots.map((s) => path.resolve(s)),
      }
      fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(report, null, 1))
      console.info(
        [
          `\nDEV-465 — int_01_hoverJet from the room, ${look}, ${PINNED}, ${LABEL}`,
          `  mid-load: stage ${first.stage}, room ${first.room}, dome ${first.dome}, plate ${first.plate}, ` +
            `emblem ${first.emblem}, look ${first.look}`,
          `  tables drawn [${first.tables.join(', ')}]; page plates [${first.pagePlates.join(', ')}]; ` +
            `header ${first.header}`,
          `  __ff2.loading(): ${JSON.stringify(first.probe)}`,
          `  press -> aboard: ${span.length} frames, ${report.blacksPressToAboard} black(s); ` +
            `room up every frame until the black: ${report.roomUpEveryFrameUntilTheBlack}; ` +
            `dome ever up: ${report.domeEverUp}`,
          `  plate in the room for ${plateInRoom.length} frames, tables then ${JSON.stringify(report.tablesWhilePlateInRoom)}`,
          `  look changes ${JSON.stringify(lookChanges)}`,
          `  programs the plate was drawn with that did not exist at the press: ${compiledForPlate.length}`,
          `  the mark turned ${turned?.toFixed(3) ?? 'n/a'} rad in a second`,
          `  back in the room: tables [${back.tables.join(', ')}], header ${back.header}, ` +
            `${JSON.stringify(back.probe)}`,
          ...shots.map((s) => `  ${path.resolve(s)}`),
          '',
        ].join('\n'),
      )

      // ── the claims ───────────────────────────────────────────────────
      expect(heldTier, 'the tier held for every reading').toEqual([])
      expect(from, 'the press was recorded').toBeGreaterThanOrEqual(0)
      expect(aboard, 'and the pad').toBeGreaterThan(from)
      expect(first.emblem, 'the turning emblem is on the plate').toBe(true)
      expect(turned, 'and it turned while the world built').toBeGreaterThan(0.1)
      // No look ever changed on a lit frame (DEV-427's rule, DEV-451's flip).
      for (const c of lookChanges) {
        expect(c.a, `the look became ${c.look} UNDER the curtain`).toBeGreaterThanOrEqual(1)
      }
      if (look === 'anniversary') {
        expect(first.room, 'the room stayed up: the player was not taken out of it').toBe(true)
        expect(first.dome, 'no loading scene around it').toBe(false)
        expect(
          report.roomUpEveryFrameUntilTheBlack,
          'the room was on screen until the pad’s black',
        ).toBe(true)
        expect(report.domeEverUp, 'the loading scene never came up').toBe(false)
        expect(report.blacksPressToAboard, 'ONE black: the fade to the pad').toBe(1)
        expect(plateInRoom.length, 'the plate stood in the room, in plain view').toBeGreaterThan(0)
        expect(first.tables, 'every table but the one pressed is put by').toEqual([
          INT_01_HOVERJET.id,
        ])
        expect(report.tablesWhilePlateInRoom, 'for as long as the plate stood').toEqual([1])
        expect(first.pagePlates, 'the page plates are down').toEqual([false, false])
        expect(first.header, 'and the step header').toBe(false)
        expect(first.probe, '__ff2.loading() names the room').toEqual({
          place: 'room',
          target: INT_01_HOVERJET.id,
          focus: INT_01_HOVERJET.id,
        })
        expect(first.look, 'the room wears Anniversary').toBe('anniversary')
        expect(lookChanges, 'and nothing was flipped').toEqual([])
        expect(compiledForPlate, 'the plate linked no program in view (the primer)').toEqual([])
        expect(back.tables.length, 'back in the room, the step is whole').toBeGreaterThan(1)
        expect(back.header, 'with its header').toBe(true)
        expect(back.probe?.focus ?? null, 'and nothing focused').toBeNull()
      } else {
        expect(first.room, 'the room is hidden behind the loading scene').toBe(false)
        expect(first.dome, 'DEV-355’s scene, dome and all').toBe(true)
        expect(report.blacksPressToAboard, 'two blacks: into the scene, and to the pad').toBe(2)
        expect(first.look, 'the Classic look went on at the first black').toBe('classic')
        if (first.probe) expect(first.probe.place).toBe('scene')
      }
      expect(
        logs.filter((l) => /^error: .*(shader|program|WebGL)/i.test(l)),
        'no GL errors',
      ).toEqual([])
    })
  })
}
