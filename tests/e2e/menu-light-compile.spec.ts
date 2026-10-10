/**
 * tests/e2e/menu-light-compile.spec.ts — walking the level select must compile
 * nothing.
 *
 * DEV-188, and it is DEV-186's mechanism one room over.
 *
 * ── The mechanism, in one paragraph ──────────────────────────────────────
 *
 * three's `projectObject` opens `if ( object.visible === false ) return;`
 * (`three.module.js:17827`), so an invisible subtree contributes **no lights**;
 * a removed subtree contributes none either. The scene's light COUNTS are
 * fields of every lit material's program cache key (`numPointLights` is one of
 * the nine light fields `getProgramCacheKeyParameters` pushes), and a change to
 * the count bumps `WebGLLights`' `state.version`, which is the branch of
 * `needsProgramChange` (`:18386`) that re-fetches a program for every lit
 * material in the frame.
 *
 * ── Why the level select is a candidate ──────────────────────────────────
 *
 * `render/holo-ship.ts` gives every aircraft on a holotable **two**
 * `PointLight`s of its own — a key and a fill — because both aircraft arrive
 * with lit materials and the room is dark (see that file's own note). They are
 * parented to the ship, the ship is added to the table group, and
 * `render/hangar.ts`'s `applyPage` tears every table's ship down on every step
 * (`clearShip`) and hides the tables a step does not use.
 *
 * The room asks aircraft -> flight plan -> rank -> place (DEV-076, DEV-077,
 * DEV-203), and only the AIRCRAFT step stands ships on its tables. So the menu
 * scene's point-light count moves every time the player presses inward and
 * every time they come back out, and each distinct count is a different program
 * cache key for every lit material in the room.
 *
 * ── Why the gate is a COUNT ──────────────────────────────────────────────
 *
 * `docs/testing/perf-protocol.md` §3a: a millisecond belongs to a machine and
 * this suite shares a GPU. A program count is the same integer on a quiet box
 * and a busy one.
 *
 * ── The three traps this file is built around ────────────────────────────
 *
 * 1. **Assert the premise.** `view-toggle-compile.spec.ts`'s first run reported
 *    "programs constant" and proved nothing, because the key press never
 *    registered. Every step here asserts what the room is HOLDING — the step
 *    name, the number of aircraft, the number of islands — so a walk that did
 *    not walk cannot come back green.
 * 2. **Effective visibility.** A light under a hidden parent still has
 *    `visible === true`. The counter walks the parent chain, exactly as
 *    `projectObject` does.
 * 3. **Held keys, not taps.** `hold()` presses for 200 ms. Every confirm in
 *    this game is a LEVEL read once a frame, and at 60 Hz a 10 ms tap falls
 *    between two frames. The BACK plate is not a key at all: it is a thing in
 *    the room that the look has to be pointed AT, which since DEV-203 this file
 *    does by measuring where it is rather than by sweeping for it — see
 *    `aimAtPlate`, and the geometry that forced it.
 *
 * ── What "compiled nothing" means when the content changes ───────────────
 *
 * A step change legitimately brings new materials with it: the aircraft step
 * has no island at all, and the rank step has three. Those are new programs
 * for an honest reason and the total count must be allowed to rise for them.
 *
 * So the gate is not the total. It is the count of **REPEATS**: a newly
 * compiled program whose cache key is an earlier key with different NUMBERS in
 * it — same shader, same defines, same maps, same booleans. `twinOf` is the
 * rule and its own note says why the bound on "a number" is what makes it one.
 * The total is printed beside it, because the total is what a player feels.
 */

import { bootReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { throughDoors } from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

const EDITION = process.env.MENU_EDITION ?? 'anniversary'
/**
 * The aircraft on the first step's tables, sorted as `snapshot` sorts them:
 * the glider beside 2016's two (DEV-399), whichever edition is chosen — the
 * room wears and offers Anniversary since DEV-451, so `MENU_EDITION=classic`
 * walks the same room (it offered 2016's two until then).
 */
const AIRCRAFT: readonly string[] = ['glider', 'hoverjet', 'jumpseat']

type Page = import('@playwright/test').Page

interface Snapshot {
  /** `renderer.info.programs.length` — three's own cache, one entry per key. */
  readonly programs: number
  /** Every cache key in that cache, so a later snapshot can say what is new. */
  readonly keys: readonly string[]
  /** Point lights that `projectObject` would actually reach. */
  readonly pointLights: number
  /**
   * Every one of them by name and intensity, so "which lamp, and how bright"
   * is answerable without a second run.
   *
   * The intensity is here because the fix turns lamps OFF rather than taking
   * them away, and "off" is a claim about a number rather than about the scene
   * graph. A lamp left burning over an empty table would keep the count
   * constant, pass every gate in this file, and light an island.
   */
  readonly lampNames: readonly string[]
  readonly lamps: readonly { readonly name: string; readonly intensity: number }[]
  /** Every kind of light the stage contributes, effective visibility applied. */
  readonly lights: Readonly<Record<string, number>>
  /** Aircraft standing on tables right now (`holo-ship-<id>`), drawn only. */
  readonly ships: readonly string[]
  /** Islands standing on tables right now (`diorama-island`), drawn only. */
  readonly islands: number
  /** Dioramas that have ARRIVED, island or not — the wait, since DEV-313. */
  readonly dioramas: number
  /**
   * Flight-plan marks standing on tables right now (`mode-mark`), drawn only —
   * the plan step's wait since DEV-354, which stands no diorama at all. A mark
   * is lit by its table's two lamps exactly as an aircraft is.
   */
  readonly marks: number
  /** Which step the room is on: `vehicles`, `ranks` or `courses`. */
  readonly view: string | null
}

/**
 * Read the renderer's program cache and the stage's effective light list.
 *
 * `__ff2.stage()` is the scene that is on screen — the MENU scene while the
 * room is up, which is a different `THREE.Scene` from the mission's by design
 * (`boot/app.ts`, and the note above `menuScene`). Reading `render.scene`
 * instead would count the mission's sun and the title screen's spot and miss
 * every lamp this file is about.
 */
const snapshot = async (page: Page): Promise<Snapshot> =>
  page.evaluate(() => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      type: string
      intensity?: number
      isLight?: boolean
      isPointLight?: boolean
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2: {
        render: { renderer: { info: { programs: { cacheKey: string }[] } } }
        stage: () => Node
        hangarAim: () => { view: string } | null
      }
    }
    // three's `projectObject` returns at the FIRST invisible ancestor, so a
    // light whose own flag is true under a hidden table is not in the scene's
    // light list at all. `view-toggle-compile.spec.ts` counted `o.visible`
    // alone on its first run and printed a constant while the programs moved.
    const drawn = (o: Node): boolean => {
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return false
      return true
    }
    let pointLights = 0
    const lampNames: string[] = []
    const lamps: { name: string; intensity: number }[] = []
    const lights: Record<string, number> = {}
    const ships: string[] = []
    let islands = 0
    // Dioramas that have ARRIVED, island or not. DEV-313's Ring Attack course
    // table drew a gate circuit and no terrain, so `islands > 0` stopped being
    // the right way to wait for a step's models; `createDiorama` names its
    // group and adds it in the same synchronous call that builds it, so this
    // fires at exactly the moment the island count used to. Since DEV-354
    // every land table has its island again, and the plan step has no diorama
    // at all — it is waited for by its MARKS instead.
    let dioramas = 0
    let marks = 0
    w.__ff2.stage().traverse((o) => {
      if (!drawn(o)) return
      if (o.isLight) {
        lights[o.type] = (lights[o.type] ?? 0) + 1
        if (o.isPointLight) {
          pointLights++
          lampNames.push(o.name || '(unnamed)')
          lamps.push({ name: o.name || '(unnamed)', intensity: o.intensity ?? 0 })
        }
      }
      // The OUTER group only: `holo-ship-spinner-<id>` hangs inside it and
      // shares the prefix, so a `startsWith` counts every aircraft twice.
      const ship = /^holo-ship-(?!spinner-)(.+)$/.exec(o.name)
      if (ship?.[1]) ships.push(ship[1])
      if (o.name === 'diorama-island') islands += 1
      if (o.name === 'diorama') dioramas += 1
      if (o.name === 'mode-mark') marks += 1
    })
    const programs = w.__ff2.render.renderer.info.programs
    return {
      programs: programs.length,
      keys: programs.map((p) => p.cacheKey),
      pointLights,
      lampNames: lampNames.sort(),
      lamps: lamps.sort((p, q) => p.name.localeCompare(q.name)),
      lights,
      ships: ships.sort(),
      islands,
      dioramas,
      marks,
      view: w.__ff2.hangarAim()?.view ?? null,
    }
  })

/**
 * Is this field one a LIGHT COUNT could be?
 *
 * The nine light fields are small non-negative integers. So is a handful of
 * other parameters — `numClippingPlanes`, the morph counts — and that is fine:
 * this is the outer bound of "a number that could have moved because a lamp
 * came or went", and a repeat is only claimed when the fields OUTSIDE this set
 * all agree.
 *
 * The ceiling is what earns the rule. `getProgramCacheKeyBooleans` packs 24
 * booleans into a `Layers` mask and pushes it as a NUMBER — `8388608` is bit 23
 * alone — so a rule that masked every run of digits would erase `vertexColors`,
 * `flatShading` and `fog` along with the counts and call two genuinely
 * different materials the same one. It did: the first draft of this file
 * reported the hangar shell and the parked jet as light-count twins of each
 * other, on the strength of two eight-million-digit bitmasks both being digits.
 */
const couldBeACount = (field: string | undefined): boolean =>
  field !== undefined && /^\d+$/.test(field) && Number(field) <= 64

interface Twin {
  /** The earlier key this one is a recompile of. */
  readonly of: string
  /** `field 36: 5 -> 1`, one per position that moved. */
  readonly moved: readonly string[]
}

/**
 * Find the earlier key that `key` is the SAME MATERIAL as, if there is one.
 *
 * Same length and the same field 0 and field 1 — the shader id, or the pair of
 * `customVertexShaderID` / `customFragmentShaderID` three hands to a material
 * with an `onBeforeCompile`. Those two are a monotonic counter, so a material
 * rebuilt from scratch gets fresh ones and is correctly NOT a twin of the one
 * it replaced: that is a different bug with a different fix (see the row).
 *
 * Then: every field that differs must be one a count could live in. One that
 * is not — a map, a boolean mask, a define — means this is a different
 * material that happens to look similar, and no twin is reported.
 */
const twinOf = (key: string, earlier: readonly string[]): Twin | null => {
  const now = key.split(',')
  for (const candidate of earlier) {
    const was = candidate.split(',')
    if (was.length !== now.length) continue
    if (was[0] !== now[0] || was[1] !== now[1]) continue
    const moved: string[] = []
    let clean = true
    for (let i = 0; i < now.length; i++) {
      if (was[i] === now[i]) continue
      if (!couldBeACount(was[i]) || !couldBeACount(now[i])) {
        clean = false
        break
      }
      moved.push(`field ${i}: ${was[i]} -> ${now[i]}`)
    }
    if (clean && moved.length > 0) return { of: candidate, moved }
  }
  return null
}

interface Delta {
  /** Programs compiled since the previous snapshot. */
  readonly added: number
  /** Of those, how many are an earlier material compiled again at new counts. */
  readonly repeats: number
  /** Programs three dropped (a material disposed to `usedTimes === 0`). */
  readonly dropped: number
  /**
   * One line per repeat, naming the shader and every field that moved. Without
   * it a repeat is a number to be taken on trust, and the point of bounding the
   * mask was to be able to say WHICH numbers moved. It is also the guard on the
   * rule itself: a repeat whose moved field is not a light count says the
   * bound is too loose, and a run that printed nothing would never say so.
   */
  readonly why: readonly string[]
}

const delta = (before: Snapshot, after: Snapshot): Delta => {
  const had = new Set(before.keys)
  const has = new Set(after.keys)
  const added = after.keys.filter((k) => !had.has(k))
  const why: string[] = []
  let repeats = 0
  for (const k of added) {
    const twin = twinOf(k, before.keys)
    if (twin) repeats++
    // Every added program gets a line, twin or not. An unexplained compile is
    // the thing a later reader will want named, and a list of only the ones
    // this file already understands is the shape of a diagnostic that cannot
    // surprise you.
    why.push(`${k.split(',')[0]} — ${twin ? twin.moved.join('; ') : 'new material'}`)
  }
  return {
    added: added.length,
    repeats,
    dropped: before.keys.filter((k) => !has.has(k)).length,
    why,
  }
}

const line = (label: string, s: Snapshot): string =>
  `${label.padEnd(16)} programs ${String(s.programs).padStart(4)} · ` +
  `point lights ${s.pointLights} [${s.lamps.map((l) => `${l.name}=${l.intensity.toFixed(2)}`).join(' ')}] · ` +
  `step ${s.view} · ships [${s.ships.join(' ')}] · islands ${s.islands} · marks ${s.marks}`

/** The live step, straight off the room. */
const view = async (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { hangarAim: () => { view: string } | null } }
      ).__ff2?.hangarAim()?.view ?? null,
  )

/** The steps this room walks (DEV-382): the variant step is Anniversary's. */
const stepsOf = async (page: Page): Promise<readonly string[]> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { __ff2?: { hangarAim: () => { views: string[] } | null } }
      ).__ff2?.hangarAim()?.views ?? [],
  )

/** The WHOLE aim, so a walk can name the option it wants. */
const aimFull = async (page: Page): Promise<{ kind: string } | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { hangarAim: () => { aim: { kind: string } | null } | null }
        }
      ).__ff2?.hangarAim()?.aim ?? null,
  )

const aimKind = async (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __ff2?: { hangarAim: () => { aim: { kind: string } | null } | null }
        }
      ).__ff2?.hangarAim()?.aim?.kind ?? null,
  )

/** One pulse of the look, `ms` long, then a beat for the frame to land. */
const nudge = async (page: Page, key: string, ms = 45): Promise<void> => {
  await page.keyboard.down(key)
  await page.waitForTimeout(ms)
  await page.keyboard.up(key)
  await page.waitForTimeout(60)
}

/**
 * Every drawn, pressable table in the room, and how far the pointer is from
 * each, as a YAW (positive to the right). Measured the way `lookError`
 * measures a plate: both directions in WORLD space and differenced, so the
 * room's `HANGAR_SPIN` cancels. `uuid` names a table across calls; the tables
 * are built with the room and never move between two readings.
 *
 * `aimable` is the room's own word for "the pointer can take it"
 * (`hangar.ts`, `slotAimable`), so a dead plate is not a candidate.
 */
const tablesInReach = async (page: Page): Promise<{ uuid: string; dYaw: number }[]> =>
  page.evaluate(() => {
    interface Node {
      name: string
      uuid: string
      visible: boolean
      parent: Node | null
      userData: { aimable?: boolean }
      matrixWorld: { elements: number[] }
      updateWorldMatrix: (a: boolean, b: boolean) => void
      traverse: (fn: (o: Node) => void) => void
    }
    const ff = (
      globalThis as unknown as { __ff2?: { stage: () => Node; render: { camera: Node } } }
    ).__ff2
    if (!ff) return []
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    const m = cam.matrixWorld.elements
    const yawOf = (x: number, z: number) => Math.atan2(x, -z)
    const facing = yawOf(-(m[8] ?? 0), -(m[10] ?? 0))
    const out: { uuid: string; dYaw: number }[] = []
    ff.stage().traverse((o) => {
      if (o.name !== 'hangar-holotable' || o.userData.aimable !== true) return
      for (let n: Node | null = o; n; n = n.parent) if (!n.visible) return
      o.updateWorldMatrix(true, false)
      const p = o.matrixWorld.elements
      const d = yawOf((p[12] ?? 0) - (m[12] ?? 0), (p[14] ?? 0) - (m[14] ?? 0)) - facing
      out.push({ uuid: o.uuid, dYaw: Math.atan2(Math.sin(d), Math.cos(d)) })
    })
    return out
  })

/**
 * Turn the seat until the pointer is on a table of `kind` — the one named
 * `want`, where given — by LOOKING AT the tables, nearest first.
 *
 * ── What this replaces, and why (DEV-379 follow-up) ─────────────────────
 *
 * It was a blind sweep: 32 nudges right, then 64 left, stopping on the first
 * table of the kind. A budget in NUDGES is a budget in degrees only while a
 * nudge is a fixed angle, and it is not one: a nudge is a 45 ms key hold read
 * once a frame, so its size is however many frames saw the key down — a
 * property of the machine's frame timing that day, not of the room. The walk
 * below takes HoverJet · Free Flight, whose one live rank, Beginner, sits at
 * the far LEFT end of the rank arc, so the right-first sweep spent its 32 going
 * the wrong way and then found Beginner on left nudge 52 to 55 of 64 (measured
 * 2026-09-25, four runs, quiet box). Twelve nudges of margin is 20 %: a busier
 * box's frames eat it, and `found a rank` went red on `main` for glider-wire.
 *
 * DEV-379's fourth flight plan did NOT change that route: `tableBearings` stood
 * slot 1 on the resting bearing for three plans and for four, so Ring Attack,
 * Target Practice and Free Flight kept -45 / -15 / +15 and Flight School was
 * ADDED at +45. The sweep still met Free Flight first (right nudge 11 of 32).
 *
 * Its follow-up DID change it, which a steer by name does not mind. Matt, *"move
 * flight school to the middle"*: the plan arc was laid centred on the resting
 * pointer (`stepBearings`) with Flight School in its middle — Ring Attack -60,
 * Target Practice -30, Flight School 0, Free Flight +30. And DEV-419 changed it
 * again the next day: the HoverJet's own three, Flight School -45, Ring Attack
 * -15 under the resting pointer, Free Flight +15, one table to its right.
 *
 * ── So it steers rather than hunts ──────────────────────────────────────
 *
 * `aimAtPlate`'s method, for tables: measure where each pressable table is,
 * turn toward the nearest one not yet tried, and read the aim once the
 * pointer is on it. It needs no notch calibration and it converges whatever
 * a nudge happens to be worth — a small nudge costs more nudges, not the
 * route. The input is the player's own: the look keys, and the gaze picking
 * what it points at. `KeyD` is BELIEVED to turn right, and the belief is
 * checked against the measurement after every nudge and flipped if the
 * error grew (the orientation lesson, applied to a helper).
 */
const turnUntil = async (
  page: Page,
  kind: string,
  want?: string,
  budget = 160,
): Promise<boolean> => {
  // `want` names WHICH one, the way `walkthrough.spec.ts` and
  // `mobile-controls.spec.ts` both had to learn on the same day: a search with
  // no target takes whatever it reaches first, and under fixed slots that is
  // not the same thing twice. Matched against the aim's own JSON — the ids,
  // modes and difficulties are distinct quoted strings.
  const on = async () => {
    const aim = await aimFull(page)
    if (aim?.kind !== kind) return false
    return want === undefined || JSON.stringify(aim).includes(`"${want}"`)
  }
  if (await on()) return true
  /** Inside this many radians of a table's centre the pointer is on it (its window is ~8°). */
  const ARRIVED = (2.5 * Math.PI) / 180
  let rightKey: 'KeyD' | 'KeyA' = 'KeyD'
  const leftOf = (k: 'KeyD' | 'KeyA') => (k === 'KeyD' ? 'KeyA' : 'KeyD')
  const tried = new Set<string>()
  let spent = 0
  while (spent < budget) {
    const next = (await tablesInReach(page))
      .filter((t) => !tried.has(t.uuid))
      .sort((a, b) => Math.abs(a.dYaw) - Math.abs(b.dYaw))[0]
    if (!next) return false
    tried.add(next.uuid)
    let prev: number | null = null
    let ms = 45
    while (spent < budget) {
      const at = (await tablesInReach(page)).find((t) => t.uuid === next.uuid)
      if (!at) break
      if (await on()) return true
      if (Math.abs(at.dYaw) <= ARRIVED) {
        // On it, and it is not the one: a frame for the aim to land, then on.
        await page.waitForTimeout(120)
        if (await on()) return true
        break
      }
      if (prev !== null) {
        // Pressing toward a table on the right makes its error FALL. If it rose,
        // the key believed to turn right turns left.
        const moved = at.dYaw - prev
        if (prev > 0 ? moved > 0 : moved < 0) rightKey = leftOf(rightKey)
        // Stepped over the centre: a finer nudge, or a window can be jumped.
        if (Math.sign(at.dYaw) !== Math.sign(prev)) ms = Math.max(15, ms / 2)
      }
      prev = at.dYaw
      await nudge(page, at.dYaw > 0 ? rightKey : leftOf(rightKey), ms)
      spent++
    }
    if (await on()) return true
  }
  return on()
}

/**
 * How far the nose pointer is from an object in the room, as two angles.
 *
 * Both directions are taken in WORLD space and then differenced, so the room's
 * own `HANGAR_SPIN` is common to the pair and cancels — the delta is a fact
 * about where you are looking relative to the thing, in any frame.
 *
 * `updateWorldMatrix(true, false)` on both, for CLAUDE.md's standing reason:
 * three does not recompute a world matrix until it renders, and a stale one is
 * the whole of that trap.
 */
const lookError = async (
  page: Page,
  name: string,
): Promise<{ dYaw: number; dPitch: number; aim: string | null; visible: boolean } | null> =>
  page.evaluate((target: string) => {
    interface Node {
      name: string
      visible: boolean
      parent: Node | null
      matrixWorld: { elements: number[] }
      updateWorldMatrix: (a: boolean, b: boolean) => void
      traverse: (fn: (o: Node) => void) => void
    }
    const w = globalThis as unknown as {
      __ff2?: {
        stage: () => Node
        render: { camera: Node }
        hangarAim: () => { aim: { kind: string } | null } | null
      }
    }
    const ff = w.__ff2
    if (!ff) return null
    let found: Node | null = null
    ff.stage().traverse((o) => {
      if (o.name === target) found = o
    })
    if (!found) return null
    const plate = found as Node
    plate.updateWorldMatrix(true, false)
    const cam = ff.render.camera
    cam.updateWorldMatrix(true, false)
    const m = cam.matrixWorld.elements
    const p = plate.matrixWorld.elements
    // A camera looks down its own -z, so its forward is the negated third axis.
    const fwd = [-(m[8] ?? 0), -(m[9] ?? 0), -(m[10] ?? 0)]
    const to = [
      (p[12] ?? 0) - (m[12] ?? 0),
      (p[13] ?? 0) - (m[13] ?? 0),
      (p[14] ?? 0) - (m[14] ?? 0),
    ]
    // Yaw measured the way `tableLocal` measures a BEARING — positive to the
    // right, about the -z forward — and pitch positive upward.
    const yawOf = (v: number[]) => Math.atan2(v[0] ?? 0, -(v[2] ?? 0))
    const pitchOf = (v: number[]) => {
      const l = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1
      return Math.asin(Math.min(1, Math.max(-1, (v[1] ?? 0) / l)))
    }
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    let vis = true
    for (let n: Node | null = plate; n; n = n.parent) if (!n.visible) vis = false
    return {
      dYaw: wrap(yawOf(to) - yawOf(fwd)),
      dPitch: pitchOf(to) - pitchOf(fwd),
      aim: ff.hangarAim()?.aim?.kind ?? null,
      visible: vis,
    }
  }, name)

/**
 * Aim the nose pointer AT the lap plate, by driving the look toward it.
 *
 * ── The bug this replaces, measured and then derived (DEV-203 follow-up) ──
 *
 * `stepBack` used to sweep PITCH only, and after DEV-203 that cannot work.
 * Four probe runs narrowed it and two of them refuted their own hypothesis:
 * doubling the sweep length changed nothing, and a probe that drove pitch to
 * the top limit and swept the WHOLE range down — seventy notches, logging the
 * aim at every one — found **nothing at any height**. Not the plate, not a page
 * arrow, not a table. The column was empty.
 *
 * The geometry says why, exactly, and `level-select.test.ts` now asserts it:
 * **a pitch-only sweep can reach a lap plate only from within about ±12° of
 * that plate's own bearing.** The plates sit at ∓20°; the arc's INNER tables at
 * ∓15° are 5° away and reachable (3.3° of miss against an 8.1° window), and its
 * OUTER tables at ∓45° are 25° away — 16.2° of miss, blind at every pitch. The
 * old walk pressed blind from the resting bearing and so always ended up near
 * -15°; the new one has to TURN to find a table, and half the arc's positions
 * leave the seat somewhere no amount of looking down will find a plate.
 *
 * **Re-acquiring a table first does not fix it**, which is why this is a rewrite
 * and not a tune: on `HoverJet · Free Flight` the only live rank is Beginner at
 * -45, so the one table the seat CAN acquire is one of the blind ones.
 *
 * ── So it drives rather than hunts ───────────────────────────────────────
 *
 * The plate is an object in the room with a name (`hangar-page-prev`), so the
 * spec can ask where it is and steer at it: measure the two angles, nudge the
 * axis with the larger error, repeat. It converges from anywhere in the room,
 * it needs no notch calibration, and it is strictly faster than the sweep it
 * replaces — a dozen nudges rather than a hundred.
 *
 * **The key directions are DISCOVERED, not asserted.** `KeyD` is believed to
 * turn right and `KeyS` to look down, and both beliefs are checked against the
 * measurement after every nudge and flipped if the error grew. That is the
 * orientation lesson applied to a test helper: a sign I reasoned out is my
 * belief written twice, and this one settles it from the room itself.
 */
const aimAtPlate = async (page: Page, name: string, budget = 80): Promise<boolean> => {
  // Beliefs, not facts. Checked against the measurement below.
  let rightKey: 'KeyD' | 'KeyA' = 'KeyD'
  let downKey: 'KeyS' | 'KeyW' = 'KeyS'
  let previous: { axis: 'yaw' | 'pitch'; size: number } | null = null

  for (let i = 0; i < budget; i++) {
    const e = await lookError(page, name)
    if (!e || !e.visible) return false
    if (e.aim === 'back') return true

    // Did the last nudge help? If it made its own axis worse, the key that
    // drives that axis is the other one.
    if (previous) {
      const now = previous.axis === 'yaw' ? Math.abs(e.dYaw) : Math.abs(e.dPitch)
      if (now > previous.size) {
        if (previous.axis === 'yaw') rightKey = rightKey === 'KeyD' ? 'KeyA' : 'KeyD'
        else downKey = downKey === 'KeyS' ? 'KeyW' : 'KeyS'
      }
    }

    const axis: 'yaw' | 'pitch' = Math.abs(e.dYaw) >= Math.abs(e.dPitch) ? 'yaw' : 'pitch'
    const key =
      axis === 'yaw'
        ? e.dYaw > 0
          ? rightKey
          : rightKey === 'KeyD'
            ? 'KeyA'
            : 'KeyD'
        : e.dPitch < 0
          ? downKey
          : downKey === 'KeyS'
            ? 'KeyW'
            : 'KeyS'
    previous = { axis, size: axis === 'yaw' ? Math.abs(e.dYaw) : Math.abs(e.dPitch) }
    await nudge(page, key)
  }
  return (await aimKind(page)) === 'back'
}

/**
 * Get OFF the plate, so its dwell cannot fire a second time.
 *
 * The file already warned about this — *"a lap plate that keeps the pointer
 * keeps dwelling, and the next press would then be a second step back"* — and
 * once `aimAtPlate` started landing dead centre, the warning collected: a test
 * overshot from `courses` to `vehicles`, two steps for one press.
 *
 * Looking UP is the move that cannot fail. The plate's window is 8.1° of angle
 * and the tables sit 26° above it, so a few notches of `KeyW` leave it whatever
 * the yaw is and whatever the arc happens to be holding. The old fix aimed at a
 * TABLE instead, which is the same hole one level up: on `HoverJet · Free
 * Flight` there may be no table within reach of where you are standing.
 */
const clearOfPlate = async (page: Page, notches = 8): Promise<void> => {
  for (let i = 0; i < notches; i++) {
    const kind = await aimKind(page)
    if (kind !== 'back' && kind !== 'page') return
    await nudge(page, 'KeyW')
  }
  // Loud, not silent. If `KeyW` ever stops meaning "look up" this says so in
  // one line, where the symptom otherwise arrives as a step count that is one
  // too many, three snapshots later, in a test about program compiles.
  expect(await aimKind(page), 'looking up left the lap plate').not.toBe('back')
}

/**
 * Climb one step out, the way a player does: find the lap plate, and let it
 * take.
 *
 * **The outcome is the claim, not the press.** `menu-screen.spec.ts` paid for
 * that one: the plate takes a 0.75 s dwell as well as an A press, finding it
 * burns some of the dwell, and which of the two fires is a race. Both routes
 * are the feature. So this waits for the STEP and does not care which took it.
 */
const stepBack = async (page: Page, to: string): Promise<void> => {
  if ((await view(page)) === to) return
  expect(await aimAtPlate(page, 'hangar-page-prev'), `found the BACK plate to reach ${to}`).toBe(
    true,
  )
  await hold(page, 'Enter')
  await expect.poll(async () => view(page), { timeout: 15_000, intervals: [250] }).toBe(to)
  // Before anything else reads the room: off the plate, or its dwell takes a
  // second step while the next snapshot is being taken.
  await clearOfPlate(page)
  expect(await view(page), 'and stayed on the step it landed on').toBe(to)
}

/** Settle: let the fade finish, the dioramas land and the frame draw them. */
const SETTLE_MS = 4_000

/**
 * The two ways into the room, and they are NOT the same measurement.
 *
 * `?title=0` draws the room as the page's first frame, which is before the two
 * aircraft GLBs have landed — so the room's lit materials all compile at ONE
 * point light, the ships arrive and everything compiles again at five, and the
 * first press back down to one is then a cache hit for all but whatever
 * appeared in between.
 *
 * A player goes through the TITLE. The GLBs land while it is up, the room's
 * first frame already has both aircraft on their tables, and the first press is
 * the first time anything in that room is drawn at a different count.
 *
 * Same bug, two different bills, and running only the switch would have
 * understated it by the whole room. *A rule tested only where two explanations
 * agree has not been tested* — and these two do not agree.
 */
const ROUTES = [
  { name: 'through the title', query: '', enterRoom: true },
  { name: 'straight in (?title=0)', query: '&title=0', enterRoom: false },
] as const

test.describe('@gpu walking the level select compiles nothing — DEV-188', () => {
  test.setTimeout(420_000)

  for (const route of ROUTES) {
    test(`${EDITION} ${route.name}: the menu's point-light count holds across every step`, async ({
      page,
    }) => {
      await page.goto(`/?xr=off&edition=${EDITION}${route.query}`)
      await firstPress(page)
      // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
      // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
      await bootReady(page, 240_000)
      // `dropFocus`, not `focusCanvas`: a click on the TITLE is a real press
      // since DEV-301, and this run has to leave the title with ENTER. See
      // `fixtures/canvas.ts` for the rule and why every other call site is safe.
      await dropFocus(page)

      // ── the player's route: let the aircraft land BEFORE the room is drawn ──
      //
      // The GLBs load on their own clock, unawaited, and the room is not rendered
      // at all while the title is up (`App.stage()` picks the scene by screen).
      // So waiting here is not padding: it is what puts both aircraft on their
      // tables for the room's FIRST frame, which is the order a player gets and
      // the order under which the first press costs the whole room.
      if (route.enterRoom) {
        await page.waitForTimeout(12_000)
        await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
        await expect
          .poll(async () => view(page), { timeout: 30_000, intervals: [250] })
          .toBe('doors')
      }
      // DEV-558: both routes meet the room on its doors; SINGLE PLAYER is the
      // walk this file measures, from the aircraft down.
      await throughDoors(page)

      // The two aircraft GLBs load on their own clock and the tables take them
      // when they land, the way the medals do. Poll rather than wait — and this
      // is the premise for the whole file: with no aircraft on the tables there
      // are no lamps to lose, and every number below would be a constant for the
      // wrong reason.
      await expect
        .poll(async () => (await snapshot(page)).ships.length, {
          timeout: 90_000,
          message: 'both aircraft reach their tables',
        })
        .toBe(AIRCRAFT.length)
      await page.waitForTimeout(SETTLE_MS)

      const steps: { readonly label: string; readonly snap: Snapshot }[] = []
      const take = async (label: string) => {
        const snap = await snapshot(page)
        steps.push({ label, snap })
        return snap
      }

      const aircraft = await take('aircraft')

      // ── down into the FLIGHT PLANS (DEV-203) ─────────────────────────────
      //
      // The aircraft arc's first position is the HoverJet and the resting
      // pointer is on it, so this press still needs no aiming. Everything below
      // is aimed BY NAME: with fixed slots what rests under the pointer is a
      // property of the step's layout (Ring Attack, on the HoverJet's plans,
      // since DEV-419), not of the route this walk takes.
      await hold(page, 'Enter')
      // ── DEV-382: the VARIANT step, where the room has one ────────────────
      //
      // It stands the aircraft again — one table per variant — and lights
      // their lamps, so it is a step this gate walks: a press that recompiled
      // the room here would be DEV-188 one step down. Standard is under the
      // resting pointer, so the first variant the sweep meets is it.
      const variantsUp = (await stepsOf(page)).includes('variants')
      let variants: Snapshot | null = null
      if (variantsUp) {
        await expect
          .poll(async () => view(page), { timeout: 15_000, intervals: [250] })
          .toBe('variants')
        await expect
          .poll(async () => (await snapshot(page)).ships.length, { timeout: 90_000 })
          .toBeGreaterThan(0)
        await page.waitForTimeout(SETTLE_MS)
        variants = await take('variants')
        expect(await turnUntil(page, 'variant'), 'found a variant').toBe(true)
        await hold(page, 'Enter')
      }
      await expect.poll(async () => view(page), { timeout: 15_000, intervals: [250] }).toBe('modes')
      // The plan step's MARKS, not dioramas: since DEV-354 it stands one lit
      // mark per plan and no diorama, so a diorama wait here would sit out its
      // whole timeout on an honest zero.
      await expect
        .poll(async () => (await snapshot(page)).marks, { timeout: 90_000 })
        .toBeGreaterThan(0)
      await page.waitForTimeout(SETTLE_MS)
      const modes = await take('flight plans')

      // ── down into the courses ────────────────────────────────────────────
      //
      // NAMED, as the route list below names its presses: HoverJet · Free
      // Flight. A search with no target takes whatever it meets first, and what
      // it meets first has moved twice in two days (the DEV-379 follow-up, then
      // DEV-419): today Ring Attack is under the resting aim, with Free Flight
      // one table to its right.
      //
      // DEV-800: Free Flight skips the rank step (2016's ChallengeSelection()
      // did), so this walk used to read HoverJet · Free Flight's one rank,
      // Beginner, and now goes plan -> places. The rank step is not walked here
      // any more: the HoverJet's other ranked plan, Flight School, BOARDS its
      // lesson from a rank (DEV-608), so it cannot be descended through.
      expect(await turnUntil(page, 'mode', 'freeFlight'), 'found Free Flight').toBe(true)
      await hold(page, 'Enter')
      await expect
        .poll(async () => view(page), { timeout: 15_000, intervals: [250] })
        .toBe('courses')
      await expect
        .poll(async () => (await snapshot(page)).dioramas, { timeout: 90_000 })
        .toBeGreaterThan(0)
      await page.waitForTimeout(SETTLE_MS)
      const courses = await take('courses')

      // ── and back out, one step at a time ─────────────────────────────────
      // `stepBack` clears the plate itself now — looking UP, which works from
      // any yaw, where the old `turnUntil(page, 'rank')` needed a table to be
      // reachable from wherever the plate left you. On `HoverJet · Free Flight`
      // there may not be one.
      await stepBack(page, 'modes')
      await page.waitForTimeout(SETTLE_MS)
      await take('flight plans again')

      if (variantsUp) {
        await stepBack(page, 'variants')
        await page.waitForTimeout(SETTLE_MS)
        await take('variants again')
      }

      await stepBack(page, 'vehicles')
      await expect
        .poll(async () => (await snapshot(page)).ships.length, { timeout: 90_000 })
        .toBe(AIRCRAFT.length)
      await page.waitForTimeout(SETTLE_MS)
      const back = await take('aircraft again')

      // ── the table, which is the finding whichever way it comes out ───────
      console.info(`DEV-188 route: ${route.name}`)
      for (const { label, snap } of steps) console.info(`DEV-188 ${line(label, snap)}`)
      for (let i = 1; i < steps.length; i++) {
        const from = steps[i - 1] as { label: string; snap: Snapshot }
        const to = steps[i] as { label: string; snap: Snapshot }
        const d = delta(from.snap, to.snap)
        console.info(
          `DEV-188 ${from.label} -> ${to.label}: ` +
            `+${d.added} programs, of which ${d.repeats} are the SAME material recompiled; ` +
            `-${d.dropped} dropped; point lights ${from.snap.pointLights} -> ${to.snap.pointLights}`,
        )
        for (const why of d.why) console.info(`DEV-188      ${why}`)
      }

      // ── THE PREMISE ──────────────────────────────────────────────────────
      //
      // Every one of these is a thing that, if it were false, would make the gate
      // below pass for a reason that has nothing to do with what this file is
      // named after.
      expect(aircraft.view, 'the room opens on the aircraft').toBe('vehicles')
      expect(aircraft.ships, 'every aircraft is on its table').toEqual(AIRCRAFT)
      expect(aircraft.islands, 'and no island — the aircraft step carries none').toBe(0)
      if (variants !== null) {
        // DEV-382: the variant step stands the aircraft it belongs to, once
        // per variant, and nothing else.
        expect(variants.view, 'a press on an aircraft opens its variants').toBe('variants')
        expect(variants.ships.length, 'a variant table stands its aircraft').toBeGreaterThan(0)
        expect(new Set(variants.ships), 'and only the one aircraft').toEqual(new Set(['hoverjet']))
        expect(variants.islands, 'and no island').toBe(0)
        expect(variants.marks, 'and no mark').toBe(0)
      }
      expect(modes.view, 'a press on a variant opens its flight plans').toBe('modes')
      expect(modes.ships, 'no aircraft on the plan step').toEqual([])
      // DEV-354: the plan step stands lit marks, which is what makes its lamps
      // a claim worth checking, and no island.
      expect(modes.marks, 'the plan step stands its marks').toBeGreaterThan(0)
      expect(modes.islands, 'and no island').toBe(0)
      expect(courses.view, 'a press on Free Flight opens its places (no rank, DEV-800)').toBe(
        'courses',
      )
      expect(back.view, 'three steps back is the aircraft again').toBe('vehicles')
      expect(back.ships, 'and the aircraft are back on their tables').toEqual(AIRCRAFT)

      // ── THE GATE ─────────────────────────────────────────────────────────
      //
      //  1. the EFFECTIVE point-light count never moves. This is the fix's own
      //     claim, and it is what makes (2) true for the right reason rather
      //     than by luck — a room that happened to compile nothing on a walk
      //     whose counts do move would fail the first press of the next walk.
      //  2. nothing is compiled twice. New programs are allowed: the rank step
      //     brings islands the aircraft step has none of. A new program that is
      //     an OLD program with different numbers in it is not.
      for (const { label, snap } of steps) {
        expect(snap.pointLights, `${label}: the room's lamps hold`).toBe(aircraft.pointLights)
      }
      // A lamp that is KEPT has to be DARK when its table is empty, and that is
      // a claim about a NUMBER rather than about the scene graph: a holotable
      // lamp still burning over an island would satisfy every count above and
      // light the wrong thing. Since DEV-354 a flight-plan MARK is lit by its
      // table's pair exactly as an aircraft is, so the rule is two lamps per
      // ship or mark. Never vacuous: the aircraft steps expect four, the plan
      // steps two per plan, and the rank and course steps zero.
      for (const { label, snap } of steps) {
        const lit = snap.lamps.filter((l) => l.name.startsWith('holotable-') && l.intensity > 0)
        expect(
          lit.length,
          `${label}: two lamps per aircraft or mark, none over an empty table`,
        ).toBe((snap.ships.length + snap.marks) * 2)
      }
      for (let i = 1; i < steps.length; i++) {
        const from = steps[i - 1] as { label: string; snap: Snapshot }
        const to = steps[i] as { label: string; snap: Snapshot }
        expect(
          delta(from.snap, to.snap).repeats,
          `${from.label} -> ${to.label}: no material compiled twice`,
        ).toBe(0)
      }
    })
  }

  /**
   * DEV-186 §4 left a sweep of `src/` open. This is the one site it named that
   * nobody had looked at, measured rather than argued.
   *
   * `render/title.ts` gives the 2016 logo a `SpotLight` of its own, on 2016's
   * own `SpecialLighting` layer, and it lives in the MISSION scene — the same
   * scene the flight is drawn from — until the world is torn down. The frame
   * loop writes `title?.setVisible(screen === 'title')`, so `numSpotLights` is
   * a function of which SCREEN you are on, and `numSpotLights` is a field of
   * the program cache key exactly as `numPointLights` is.
   *
   * Whether that COSTS anything is a second question with an answer already in
   * the tree: `boot/app.ts` hides the title for `warmWorld`'s draw, so the
   * variants the flight uses are built under the curtain at zero spot lights.
   * This test is the premise — that the count moves at all — because a sweep
   * that reports "handled" without showing the number is the kind of claim this
   * project keeps paying for.
   */
  test(`${EDITION}: the title screen's spot light is in the MISSION scene, and leaves it`, async ({
    page,
  }) => {
    await page.goto(`/?xr=off&edition=${EDITION}`)
    await firstPress(page)
    // `bootReady`, not `data-terrain-ready`: this URL boots the TITLE screen,
    // and since DEV-281 that builds no mission world. See `fixtures/boot.ts`.
    // The premise below is unchanged by that — the spot light is still in the
    // scene the flight is drawn from, and still leaves it — but it now leaves
    // by the title world being DISPOSED at the first course selection rather
    // than by sitting there hidden for the rest of the session.
    await bootReady(page, 240_000)
    // `dropFocus`, not `focusCanvas`: a click on the TITLE is a real press
    // since DEV-301, and this run has to leave the title with ENTER. See
    // `fixtures/canvas.ts` for the rule and why every other call site is safe.
    await dropFocus(page)
    await page.waitForTimeout(8_000)

    const onTitle = await snapshot(page)

    // Title -> room -> aircraft -> flight plan -> rank -> course.
    //
    // ── This used to be four blind presses, and DEV-203 ended that ────────
    //
    // The old comment here said *"the aircraft and the rank are under the
    // resting pointer by design (`currentSlots`), which is what makes a
    // straight run of presses land"*, and that was true: the arc rotated the
    // wanted table to the resting bearing. Nothing rotates now, a step's
    // resting position can be legitimately empty, and a blind press on an empty
    // slot does nothing — so the run never left the room, `stage().name` stayed
    // `menu`, and this failed on the poll sixty seconds later with no clue in it
    // about which of the four presses had missed.
    //
    // It also gained a step: the level select asks aircraft -> flight plan ->
    // rank -> place, which is five presses from the title and not four. A blind
    // loop could not have been fixed by counting to five, because the aiming is
    // the part that was load-bearing.
    //
    // Aimed, and each one asserted, so a press that misses names itself.
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-558: START, the hangar's doors
    await page.waitForTimeout(2_500)
    await throughDoors(page) // and SINGLE PLAYER, to the aircraft
    // DEV-382: on Anniversary the aircraft asks for its VARIANT, and standard
    // is 2016's. Named by NAME: a variant's JSON carries every bar's
    // `standard` as a key, so a quoted id would match any table.
    // And DEV-420: Ring Attack walks no rank step — the rank is a mark on its
    // place's table — which the room's own step list says once the plan is
    // open, so the list is asked before each press.
    const STEP = {
      vehicle: 'vehicles',
      variant: 'variants',
      mode: 'modes',
      rank: 'ranks',
      mission: 'courses',
    } as const
    for (const [kind, want] of [
      ['vehicle', 'hoverjet'],
      ['variant', 'Standard'],
      ['mode', 'ringAttack'],
      ['rank', 'intermediate'],
      ['mission', 'int_01_hoverJet'],
    ] as const) {
      if (!(await stepsOf(page)).includes(STEP[kind])) continue
      expect(await turnUntil(page, kind, want), `found ${want} to press`).toBe(true)
      await hold(page, 'Enter')
      await page.waitForTimeout(2_500)
    }
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                globalThis as unknown as { __ff2?: { stage: () => { name: string } } }
              ).__ff2?.stage().name ?? '',
          ),
        { timeout: 60_000, intervals: [500] },
      )
      .not.toBe('menu')
    await page.waitForTimeout(6_000)
    const flying = await snapshot(page)

    console.info(
      `DEV-188 title spot — on the title: programs ${onTitle.programs}, ` +
        `lights ${JSON.stringify(onTitle.lights)}; ` +
        `flying: programs ${flying.programs}, lights ${JSON.stringify(flying.lights)}`,
    )

    // The premise, and the finding: the count really does move, in the scene
    // the flight is drawn from. Written as two halves so a run where the logo
    // GLB never arrived (`opts.logo` null, no key light at all) fails loudly
    // rather than reporting 0 -> 0 and calling it stable.
    expect(onTitle.lights.SpotLight ?? 0, '2016 keys its logo, and so do we').toBe(1)
    expect(flying.lights.SpotLight ?? 0, 'and the flight is drawn without it').toBe(0)
  })
})
