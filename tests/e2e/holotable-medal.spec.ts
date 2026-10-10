/**
 * A finished course wears its medal over its holotable; an unflown one does not.
 *
 * Matt, 2026-09-15: *"when a course is finished - it's medal should be displayed
 * in the menu on it's holo table. (the 2016 game had them floating above the
 * terrain table)"* — DEV-113.
 *
 * The claim is a POSITION, read through `__ff2.stage()` and not off a
 * screenshot: the medal object exists, it is tagged with the flown course's id,
 * and its world position is above that course's table and within the table's
 * footprint — while the other table on the same page, never flown, has none.
 * The best is seeded into `localStorage` BEFORE boot, the way a returning
 * player's browser would hold it; nothing in the build is told it is under
 * test.
 *
 * One screenshot goes to the scratch folder for a human to look at, because a
 * medal that is four pixels across has been rendered and not reviewed
 * (orientation lesson §5c). The assertions do not read it.
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { aimAtCourse, throughDoors, throughVariants } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

test.describe.configure({ timeout: 300_000 })

/**
 * The boot mission, and the other place on the same HoverJet · Ring Attack ·
 * Intermediate page. Both run in Ring Attack, which is now half of the key.
 */
const FLOWN = 'int_01_hoverJet'
const UNFLOWN = 'int_02_hoverJet'
const MODE = 'ringAttack'

/**
 * `bestKey` in `src/game/personal-best.ts`. Spelled out: an e2e spec may not
 * import src.
 *
 * The MODE joined it in DEV-204 — Matt's *"key every medal and personal best by
 * mission id + mode, one namespace for all four modes"*. A seed written under
 * the old unmoded key would still be READ (the fallback is deliberate and
 * non-destructive), so this spec would go on passing while testing the
 * migration path instead of the live one. `personal-best.test.ts` owns the
 * fallback; this spells the current key so it cannot drift silently.
 */
const bestKey = (id: string, mode: string) => `ff2.best.${id}.${mode}.v1`

/**
 * Held, not tapped. Every confirm in this game is a LEVEL read once a frame.
 * `switch-course.spec.ts` carries the same note.
 */
const hold = (page: import('@playwright/test').Page, key: string, settle = 600) =>
  keysHold(page, key, { down: 200, settle })

/** One notch of seat yaw. `KeyD`/`KeyA`'s directions are pinned by `mouse-look.spec.ts`. */
const turn = async (page: import('@playwright/test').Page, key: 'KeyA' | 'KeyD' = 'KeyD') => {
  await page.keyboard.down(key)
  await page.waitForTimeout(80)
  await page.keyboard.up(key)
  await page.waitForTimeout(80)
}

const aim = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const h = (
      globalThis as unknown as {
        __ff2?: {
          hangarAim: () => {
            view: string
            aim: {
              kind: string
              vehicle?: { vehicle: string }
              mode?: { mode: string }
              rank?: { difficulty: string }
              mission?: { id: string }
            } | null
          } | null
        }
      }
    ).__ff2?.hangarAim()
    if (!h) return null
    const named =
      h.aim?.kind === 'vehicle'
        ? (h.aim.vehicle?.vehicle ?? null)
        : h.aim?.kind === 'mode'
          ? (h.aim.mode?.mode ?? null)
          : h.aim?.kind === 'rank'
            ? (h.aim.rank?.difficulty ?? null)
            : h.aim?.kind === 'mission'
              ? (h.aim.mission?.id ?? null)
              : null
    return { view: h.view, kind: h.aim?.kind ?? null, named }
  })

/** Turn the seat until `want` is under the nose pointer, sweeping both ways. */
const lookUntil = async (
  page: import('@playwright/test').Page,
  want: string,
  steps = 20,
): Promise<boolean> => {
  const on = async () => (await aim(page))?.named === want
  for (let i = 0; i < steps; i++) {
    if (await on()) return true
    await turn(page)
  }
  for (let i = 0; i < steps * 2; i++) {
    if (await on()) return true
    await turn(page, 'KeyA')
  }
  return on()
}

interface Placed {
  missionId: string | null
  tier: string | null
  world: [number, number, number]
}

/** Every visible holotable and every medal on the menu stage, in WORLD space. */
const placed = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    interface Vec3 {
      x: number
      y: number
      z: number
    }
    interface Node {
      name: string
      visible: boolean
      userData: { missionId?: string | null; tier?: string }
      getWorldPosition: (v: Vec3) => void
      updateWorldMatrix: (a: boolean, b: boolean) => void
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (
      globalThis as unknown as {
        __ff2?: { stage: () => Node; render: { camera: { position: Vec3 } } }
      }
    ).__ff2
    if (!ff) return null
    // A real `THREE.Vector3`, borrowed off the camera: `getWorldPosition` calls
    // `setFromMatrixPosition` on whatever it is handed, and the spec has no
    // three import.
    const Vector3 = ff.render.camera.position.constructor as new () => Vec3
    const stage = ff.stage()
    stage.updateWorldMatrix(true, true)
    const tables: Placed[] = []
    const medals: Placed[] = []
    const at = (o: Node): [number, number, number] => {
      const v = new Vector3()
      o.getWorldPosition(v)
      return [v.x, v.y, v.z]
    }
    stage.traverse((o) => {
      if (o.name === 'hangar-holotable' && o.visible) {
        tables.push({ missionId: o.userData.missionId ?? null, tier: null, world: at(o) })
      }
      if (o.name === 'hangar-medal') {
        medals.push({
          missionId: o.userData.missionId ?? null,
          tier: o.userData.tier ?? null,
          world: at(o),
        })
      }
    })
    return { tables, medals }
  })

test('a finished course wears its medal over its table, and an unflown one does not', async ({
  page,
}) => {
  test.setTimeout(300_000)

  // A returning player's browser: one best on the boot mission, set before the
  // page exists. A score no threshold can beat, so whichever curve is live it
  // is platinum. And the other place on the same page is guaranteed unflown.
  await page.addInitScript(
    ([flownKey, unflownKey, record]) => {
      localStorage.setItem(flownKey, record)
      localStorage.removeItem(unflownKey)
    },
    [
      bestKey(FLOWN, MODE),
      bestKey(UNFLOWN, MODE),
      JSON.stringify({ score: 100_000, timeSeconds: 88.8, gates: 21, setAt: 1 }),
    ] as const,
  )

  await page.goto('/?xr=off')
  await firstPress(page)
  // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
  // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
  await bootReady(page, 240_000)
  // `dropFocus`, not `focusCanvas`: a click on the TITLE is a real press
  // since DEV-301, and this run has to leave the title with ENTER. See
  // `fixtures/canvas.ts` for the rule and why every other call site is safe.
  await dropFocus(page)
  await page.waitForTimeout(1_200)

  // Title -> aircraft -> HoverJet's plans -> Ring Attack's places (DEV-420; its
  // ranks page is gone, the rank is a mark on each place). DEV-203's plan step
  // stays: Matt's *"aircraft > mode > difficulty > location"*.
  await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
  await throughDoors(page) // and SINGLE PLAYER, to the aircraft
  expect((await aim(page))?.view, 'Single Player opens the aircraft').toBe('vehicles')
  expect(await lookUntil(page, 'hoverjet')).toBe(true)
  await hold(page, 'Enter')
  // DEV-382: Anniversary asks for the VARIANT next. Standard is under the
  // pointer, and the best seeded above is standard's.
  await throughVariants(page)
  expect((await aim(page))?.view).toBe('modes')
  expect(await lookUntil(page, 'ringAttack')).toBe(true)
  await hold(page, 'Enter')
  // DEV-420: Ring Attack opens its PLACES, the rank a mark on each table. A
  // place table wears the medal of the course it has PICKED, so the two
  // Intermediate courses are picked by looking at their marks — the unflown
  // one first, then the flown one, which leaves the pointer on its table.
  expect((await aim(page))?.view, 'a press on Ring Attack opens its places').toBe('courses')
  expect(await aimAtCourse(page, UNFLOWN), 'the unflown course is on this page').toBe(true)
  expect(await aimAtCourse(page, FLOWN), 'the flown course is on this page').toBe(true)

  // The logo mesh loads on its own; the medal appears when it lands.
  await expect
    .poll(async () => (await placed(page))?.medals.length ?? -1, {
      timeout: 30_000,
      message: 'a medal is on the stage',
    })
    .toBeGreaterThan(0)

  const scene = await placed(page)
  expect(scene).not.toBeNull()
  const { tables, medals } = scene as { tables: Placed[]; medals: Placed[] }

  const flownTable = tables.find((t) => t.missionId === FLOWN)
  const unflownTable = tables.find((t) => t.missionId === UNFLOWN)
  expect(flownTable, `${FLOWN} has a table up`).toBeDefined()
  expect(unflownTable, `${UNFLOWN} has a table up`).toBeDefined()

  // ── the assertion ────────────────────────────────────────────────────────
  //
  // Exactly one medal, and it is the flown course's, at platinum.
  expect(medals.map((m) => m.missionId)).toEqual([FLOWN])
  expect(medals[0]?.tier).toBe('platinum')
  expect(
    medals.some((m) => m.missionId === UNFLOWN),
    'nothing over the unflown table',
  ).toBe(false)

  // ABOVE the table and INSIDE it: a table stands 0.45 m tall and its rim is
  // 0.26 m from its axis, so the medal's axis is higher than the top and
  // horizontally within the rim of ITS table — and not of the other one.
  const medal = medals[0] as Placed
  const table = flownTable as Placed
  const other = unflownTable as Placed
  const above = medal.world[1] - table.world[1]
  expect(above, 'clear of the table top').toBeGreaterThan(0.45)
  expect(above, 'and not floating off into the room').toBeLessThan(0.8)
  const out = Math.hypot(medal.world[0] - table.world[0], medal.world[2] - table.world[2])
  expect(out, 'within its own table').toBeLessThan(0.26)
  const fromOther = Math.hypot(medal.world[0] - other.world[0], medal.world[2] - other.world[2])
  expect(fromOther, 'and not over the other one').toBeGreaterThan(0.26)

  // For a person. Not asserted. Four frames 0.4 s apart, because the emblem
  // turns at 55 deg/s and one frame can catch it edge-on, three pixels wide —
  // and where on the screen it is, so the reviewer looks at the right place.
  const dir = process.env.MEDAL_SHOT_DIR
  if (dir) {
    const onScreen = await page.evaluate(() => {
      interface Vec3 {
        x: number
        y: number
        z: number
        project: (camera: unknown) => Vec3
      }
      const ff = (
        globalThis as unknown as {
          __ff2?: {
            stage: () => {
              traverse: (
                fn: (o: { name: string; getWorldPosition: (v: Vec3) => void }) => void,
              ) => void
            }
            render: { camera: { position: Vec3 } }
          }
        }
      ).__ff2
      if (!ff) return null
      const Vector3 = ff.render.camera.position.constructor as new () => Vec3
      let found: Vec3 | null = null
      ff.stage().traverse((o) => {
        if (o.name !== 'hangar-medal') return
        const v = new Vector3()
        o.getWorldPosition(v)
        found = v.project(ff.render.camera)
      })
      if (!found) return null
      const v = found as Vec3
      return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight }
    })
    console.log(`medal on screen at ${JSON.stringify(onScreen)}`)
    for (let i = 0; i < 4; i++) {
      await page.screenshot({ path: `${dir}/holotable-medal-${i}.png` })
      await page.waitForTimeout(400)
    }
  }
})
