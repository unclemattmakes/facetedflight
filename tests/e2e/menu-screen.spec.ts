/**
 * You are in the CHAIR during the menu, and in the ship on the mission.
 *
 * Matt, 2026-09-11: *"in the original game, we had a title screen, then the
 * mission select screen (the ship selection screen was in there too). players
 * were not in the cockpit while in the menus. that was only on the missions."*
 *
 * The first build of the hangar put the camera in the cockpit and argued the
 * cockpit WAS the seat. The source says otherwise — `MM_Commander_Chair_01`
 * sits 1.04 m below the eye in `setGameplayOptions`, with the jet parked 8–10 m
 * away — and so does he.
 *
 * The claim is a DISTANCE, not a screenshot: at the menu the eye is metres from
 * the ship, and after boarding it is centimetres. That is true regardless of
 * what anyone believed the camera was parented to.
 */

import { missionReady } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import {
  cameraYaw,
  hangarAim,
  lookUntilAimed,
  throughDoors,
  throughVariants,
  turnSeatTo,
} from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const eyeToShip = async (page: import('@playwright/test').Page): Promise<number> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const ship = w.__ff2?.flight?.()?.jet.body.position
    const camera = w.__ff2?.render.camera
    if (!ship || !camera) return -1
    // Straight off the matrix. `getWorldPosition` wants a real `Vector3`, and
    // this spec has no three import — handing it a plain object throws
    // `setFromMatrixPosition is not a function`, which cost a run to find out.
    camera.updateWorldMatrix(true, false)
    const m = camera.matrixWorld.elements
    // Ship is SIM space, camera is THREE space: z flips.
    return Math.hypot((m[12] ?? 0) - ship.x, (m[13] ?? 0) - ship.y, (m[14] ?? 0) - -ship.z)
  })

const hold = (page: import('@playwright/test').Page, key: string): Promise<void> =>
  keysHold(page, key, { down: 200, settle: 250 })

interface Aim {
  aim: { kind: string } | null
  view: string
  /** The door step's tables, left to right (DEV-558). */
  doors?: { id: string }[]
}

const aimed = async (page: import('@playwright/test').Page): Promise<Aim | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim() ?? null)

interface Attitude {
  pitch: number
  yaw: number
  roll: number
}

/**
 * The rig's attitude and the composed head's, in degrees, off the live page.
 *
 * Extracted from the quaternions by hand: this spec has no `three` import (`@/`
 * is a Vite alias the runner does not have), and borrowing three's own `Euler`
 * off a page object would be asserting the port against itself. The maths is
 * the textbook YXZ extraction and is the same for anybody's quaternion.
 */
const attitudes = async (
  page: import('@playwright/test').Page,
): Promise<{ rig: Attitude; head: Attitude } | null> =>
  page.evaluate(() => {
    interface Quat {
      x: number
      y: number
      z: number
      w: number
      clone(): Quat
      multiply(q: Quat): Quat
    }
    const ff = (globalThis as unknown as Ff2GlobalMaybe).__ff2
    if (!ff) return null
    const degrees = (q: Quat) => {
      const { x, y, z, w } = q
      const clamp = (v: number) => Math.max(-1, Math.min(1, v))
      const m13 = 2 * (x * z + w * y)
      const m23 = 2 * (y * z - w * x)
      const m33 = 1 - 2 * (x * x + y * y)
      const m21 = 2 * (x * y + w * z)
      const m22 = 1 - 2 * (x * x + z * z)
      const r = 180 / Math.PI
      const gimbal = Math.abs(m23) > 0.9999999
      return {
        pitch: Math.asin(-clamp(m23)) * r,
        yaw: gimbal ? 0 : Math.atan2(m13, m33) * r,
        roll: gimbal ? 0 : Math.atan2(m21, m22) * r,
      }
    }
    return {
      rig: degrees(ff.render.rig.quaternion),
      // What the player actually looks along: the rig with the camera's own
      // local pose composed under it, which is what `render/head-pose.ts`
      // builds and what the nose pointer is aimed from.
      head: degrees(ff.render.rig.quaternion.clone().multiply(ff.render.camera.quaternion)),
    }
  })

/**
 * Look in `key` until the pointer is on something of `kind`, or give up.
 *
 * A SEARCH rather than a computed hold, because the target is 8 degrees wide
 * and a fixed duration has to be re-tuned by anyone who changes `LOOK_RATE`, the
 * keyboard ramp or the plate's reach — three numbers in three files, none of
 * which would tell you they had broken this. It is also what a player does:
 * keep looking down until the thing you want lights up.
 */
const lookUntil = async (
  page: import('@playwright/test').Page,
  key: string,
  kind: string,
  steps = 16,
): Promise<boolean> => {
  for (let i = 0; i < steps; i++) {
    if ((await aimed(page))?.aim?.kind === kind) return true
    await page.keyboard.down(key)
    await page.waitForTimeout(70)
    await page.keyboard.up(key)
    await page.waitForTimeout(70)
  }
  return (await aimed(page))?.aim?.kind === kind
}

/**
 * Turn the seat until a table of `kind` is under the pointer, sweeping BOTH
 * ways, then press. One step down the menu.
 *
 * ── Why the search, which this spec did not used to need (DEV-203) ───────
 *
 * It used to press three times with no aiming at all, on the strength of
 * `restFirst` rotating each page so the option you arrived in sat under the
 * resting pointer. Matt asked for the opposite — *"these should be fixed, not
 * randomly placed"* — so nothing rotates, and a step's resting position can
 * legitimately be EMPTY: a place with no course at that rank is a dead plate,
 * and a press there does nothing, deliberately, and the player looks one table
 * over. So does this.
 *
 * ── The budget, DERIVED, because guessing it cost a run ─────────────────
 *
 * The first version swept 14 right then 28 left, which sounds symmetric and is
 * not: after 14 right the pointer is at `start + 14n`, so 28 left covers
 * `start + 14n` down to `start - 14n` — a window **centred on where you
 * started**, 90 degrees wide at a 3.2-degree notch. The arc is also 90 wide, so
 * from a table at one END the window reaches the other end exactly and in
 * practice not at all. It failed on the one cell that puts its single course at
 * the far end: HoverJet · Free Flight · Beginner, Kauai at +45, reached from
 * Beginner at -45. **A 90-degree traverse needs a 90-degree window in ONE
 * direction**, so the budget is `arc / notch` right and twice that back:
 * 32 x 3.2 = 102 degrees each way, which covers the whole arc from anywhere in
 * it with margin for the keyboard's ramp. It exits the moment it finds one, so
 * the budget costs nothing on the common path.
 */
const stepInto = async (
  page: import('@playwright/test').Page,
  kind: string,
  steps = 32,
): Promise<boolean> => {
  const on = async () => (await aimed(page))?.aim?.kind === kind
  if (!(await on())) {
    let found = false
    for (const key of ['KeyD', 'KeyA'] as const) {
      for (let i = 0; i < (key === 'KeyA' ? steps * 2 : steps); i++) {
        if (await on()) {
          found = true
          break
        }
        await page.keyboard.down(key)
        await page.waitForTimeout(70)
        await page.keyboard.up(key)
        await page.waitForTimeout(70)
      }
      if (found) break
    }
  }
  if (!(await on())) return false
  await hold(page, 'Enter')
  return true
}

test.describe('@gpu the menu screen', () => {
  test.setTimeout(300_000)

  /**
   * **The rig is LEVEL in the room, and the pointer is still on a table.**
   *
   * Matt, worn, 2026-09-21: *"in our menu, the rig is tilted."* It was, by 22.9°
   * — the chair's resting aim looks DOWN at the holotables and the whole aim,
   * pitch included, sat on `render.rig`. On a monitor that is a camera looking
   * down and looks correct; in a headset the head pose composes UNDER the rig,
   * so the world itself rotates away from the player's own gravity and the
   * hangar floor slopes for as long as the menu is up. `render/title.ts` had
   * already found this on the title screen (DEV-068) and the fix was never
   * carried to the room. DEV-264.
   *
   * ── Why a FLAT spec can prove a headset bug ──────────────────────────────
   *
   * Because the defect is not in the head pose, which only a headset produces —
   * it is in the split between the rig and the camera, and that split exists on
   * both. A monocular harness cannot see a monocular bug (DEV-141); it CAN see
   * which of two objects is carrying a rotation.
   *
   * ── Three claims, and none of them re-derives the implementation ─────────
   *
   * 1. the rig is level — pitch and roll zero, yaw whatever the chair faces;
   * 2. the composed head still looks DOWN, so the pitch was moved, not deleted
   *    — which is the fix a "just zero it" would produce, and it would leave
   *    the nose pointer sailing over every table (`hangar.ts:933`);
   * 3. and the pointer is on a table, which is the outcome both halves serve.
   *
   * The angle in (2) is bounded, not matched: asserting 22.8° here would be
   * `seatPitchLocal()` written out a second time, and a test that re-derives
   * its expectation the way the code does has not tested the code (trap 24).
   */
  test('seats you level — the room does not tilt, and the pointer still finds a table', async ({
    page,
  }) => {
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    // DEV-604: a click on the hangar presses the table under it, and a
    // `title=0` load is in the hangar: focus without clicking anything.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    const at = await attitudes(page)
    expect(at, 'the page answered').not.toBeNull()
    if (at === null) return

    expect(at.rig.pitch, `the rig is level in pitch (was ${at.rig.pitch.toFixed(2)}°)`).toBeCloseTo(
      0,
      4,
    )
    expect(at.rig.roll, `the rig is level in roll (was ${at.rig.roll.toFixed(2)}°)`).toBeCloseTo(
      0,
      4,
    )

    // And the pitch is not GONE, it is on the head: the tables are below the
    // eye, so the resting sightline must still fall. Ten degrees is a floor
    // nothing but a deleted pitch could fail.
    expect(
      at.head.pitch,
      `the resting sightline still falls to the tables (was ${at.head.pitch.toFixed(2)}°)`,
    ).toBeLessThan(-10)
    // The rig carries the seat's bearing, so the two differ in pitch alone.
    expect(at.head.yaw, 'and the yaw is all the rig ever needed').toBeCloseTo(at.rig.yaw, 4)

    // The outcome the split is for. Same claim `stepInto` leans on, made here
    // where it is the FIRST thing asserted rather than a precondition.
    // DEV-558: the room opens on its doors. DEV-565, DEV-578: four, on a
    // preview and a release build alike. Matt, 2026-10-02: *"single player under the pointer"*, so QUICK
    // RACE stands to its left and the resting sightline aims SINGLE PLAYER.
    // The pitch claim also survives a turn of the seat alone: `lookUntilAimed`
    // sweeps yaw and never pitch, so a door found by it is a door the resting
    // sightline's pitch already falls to.
    const doors = (await aimed(page))?.doors?.map((d) => d.id) ?? []
    // DEV-620: and CREDITS, first, off the left end, out of the frame.
    // DEV-879: and the COURSE EDITOR second, on a desktop (where MAKE A COURSE is offered).
    expect(doors, 'four doors (DEV-565), OPTIONS (DEV-832), the editor (DEV-879)').toEqual([
      'options',
      'course-editor',
      'quick-race',
      'single-player',
      'multiplayer',
      'tv',
    ])
    expect((await aimed(page))?.aim?.kind, 'resting on SINGLE PLAYER').toBe('door')
    expect(await lookUntilAimed(page, 'multiplayer'), 'a turn alone finds a door').toBe(true)
    expect((await aimed(page))?.aim?.kind, 'resting on a holotable').toBe('door')
  })

  test('seats you away from the ship, and boards you on confirm', async ({ page }) => {
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    // DEV-604: a click on the hangar presses the table under it, and a
    // `title=0` load is in the hangar: focus without clicking anything.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    // In the chair: metres from the jet, looking at it. The chair is 0.66 room
    // radii out, which on `int_01`'s platform is about 8.5 m.
    const seated = await eyeToShip(page)
    expect(seated, 'seated, not in the cockpit').toBeGreaterThan(4)

    // And no cockpit panel is up, because none of them is in this room.
    const panels = await page.evaluate(() => {
      const names: string[] = []
      ;(globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.scene.traverse((o) => {
        if (o.visible && ['hud', 'results', 'pause', 'briefing'].includes(o.name ?? '')) {
          names.push(o.name as string)
        }
      })
      return names
    })
    expect(panels, 'no cockpit panels from the chair').toEqual([])

    // ── The level select is FOUR STEPS: aircraft, plan, rank, place ────
    //
    // Matt, from the headset, 2026-09-17: **"free flight should be a mode. so
    // aircraft > mode > difficulty > location (these should be fixed, not
    // randomly placed as they are now)."** That is 2016's own chain restored —
    // `MenuManager.ChangePage` walks ship -> mode -> rank -> challenge and
    // `ChallengeSelection()` dispatches on all three axes (DEV-203). The port
    // had kept two, so the one Free Flight course landed on the Beginner rank
    // page, which is what he saw.
    //
    // Three presses became four, and none of them may be made blind any more:
    // nothing rotates, so the resting position on a step can be empty. Each
    // step is therefore aim-then-press, which is what a player does.
    // DEV-558: the room opens on its doors; SINGLE PLAYER is the aircraft.
    expect((await aimed(page))?.view, 'the room opens on its doors').toBe('doors')
    await throughDoors(page)
    expect((await aimed(page))?.view, 'Single Player opens the aircraft').toBe('vehicles')
    expect((await aimed(page))?.aim?.kind, 'and the pointer is resting on one').toBe('vehicle')

    expect(await stepInto(page, 'vehicle'), 'found an aircraft').toBe(true)
    // DEV-382: on Anniversary the aircraft asks for its VARIANT first, and
    // standard stands under the resting pointer, so the pointer does not move
    // and the dead plate below is still where it rests.
    expect(await eyeToShip(page), 'and boards nothing').toBeGreaterThan(4)
    await throughVariants(page)
    expect((await aimed(page))?.view, 'a press on an aircraft opens its plans').toBe('modes')
    expect(await eyeToShip(page), 'and boards nothing').toBeGreaterThan(4)

    // ── RING ATTACK IS UNDER THE RESTING POINTER (DEV-419) ────────────────
    //
    // This block was "a dead plate is not a button" (the HoverJet's greyed
    // Target Practice under the pointer), then "a press on nothing" (#41d made
    // that plate a gap, and the DEV-379 follow-up centred the plan arc so the
    // pointer rested between two). Matt, 2026-09-26: *"flight school, ring
    // attack, free flight"* — the HoverJet's own three plans, left to right, so
    // the middle one, Ring Attack, is where the pointer rests. A press with
    // nothing under the gaze still does nothing; the LOOK-UP test below makes
    // that press, above every table.
    const resting = (await aimed(page))?.aim as { kind: string; mode?: { mode: string } } | null
    expect(resting?.kind, 'a flight plan is under the resting pointer').toBe('mode')
    // DEV-884: this browser has never finished a run, so the seat rests on the FIRST
    // plan (Flight School, `lesson`), not the middle one. A returning player rests on
    // Ring Attack, as above; both are tables under the resting pointer.
    expect(resting?.mode?.mode, 'a first visit rests on Flight School').toBe('lesson')
    expect(await lookUntilAimed(page, 'ringAttack'), 'Ring Attack is one turn away').toBe(true)

    // ── Ring Attack opens its PLACES, the rank on their tables (DEV-420) ───
    //
    // Matt, 2026-09-26: *"ring attack > terrain"*. The press on the plan goes
    // straight to the places — no rank step — and each place table carries its
    // difficulty as a column of ski-map marks (`ski-map-place.test.ts`,
    // `ship-select.spec.ts`). Still nothing boards until the LAST press.
    expect(await stepInto(page, 'mode'), 'found a flight plan').toBe(true)
    expect(
      (await aimed(page))?.view,
      'a press on Ring Attack opens its places, with no rank step',
    ).toBe('courses')
    expect(await eyeToShip(page), 'and still boards nothing').toBeGreaterThan(4)

    // Board. The ONE press in the room that reloads the world, and it is on the
    // last step — which is why the blind press a player makes when they first
    // sit down can no longer launch anything at all (DEV-203). On a place, the
    // table boards the course it has picked (DEV-420).
    expect(await stepInto(page, 'mission'), 'found a course').toBe(true)
    const aboard = await eyeToShip(page)
    // In the cockpit the eye is at `EYE`, about 1.5 m from the body origin.
    expect(aboard, 'aboard').toBeLessThan(3)
    expect(aboard, 'and it actually moved').toBeLessThan(seated - 2)
  })

  test('boards only when the NOSE POINTER is on the holotable', async ({ page }) => {
    // Matt: *"UI was in-world and selection was 'nose pointer' based, so where
    // the user looked was the 'hovered over' item."* A press with the pointer
    // somewhere else must do nothing — which is what makes this a menu rather
    // than a single button wearing a room, and it is the behaviour a second
    // holotable will need the day M6 puts one there.
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    // DEV-604: a click on the hangar presses the table under it, and a
    // `title=0` load is in the hangar: focus without clicking anything.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    const seated = await eyeToShip(page)
    expect(seated, 'seated').toBeGreaterThan(4)

    // ── Look away, and note WHICH WAY ────────────────────────────────────
    //
    // This used to yaw right with `KeyE` into what was then empty room. It is
    // not empty any more: the level select put **four** holotables on a
    // 90-degree arc in front of the chair, at bearings -45/-15/+15/+45, so a
    // 64-degree yaw now lands on the +45 table and the press boards after all.
    //
    // The test's CLAIM was right and its premise expired, which is the honest
    // shape of this failure — so the fix is to look somewhere that is still
    // empty rather than to loosen the assertion. **Up.** Every table sits
    // 22.8 degrees BELOW the eye, and no page can ever put one above the
    // horizon, so pitching up clears all four whatever the arc is holding and
    // whatever a fourteenth mission does to it later.
    //
    // `KeyW` is `BINDINGS.pitchDown` — stick FORWARD — and in the seated look
    // that raises the view, because `seatLookPitch` subtracts `actions.pitch`.
    // Stated as the measured fact rather than derived, because the sign chain
    // runs through three negations and this file is not where to get it wrong:
    // what proves the direction is the assertion below, which only passes if
    // the pointer really did leave every table. The chair is bolted down and
    // there is no ship to steer.
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(500)
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(300)

    // Confirm with the pointer off every table: nothing happens.
    await hold(page, 'Enter')
    expect(await eyeToShip(page), 'a press above the tables does nothing').toBeGreaterThan(4)

    // Look back down, and now it takes — one press for the aircraft, one for
    // the flight plan, one for the rank, one for the course. Four steps since
    // DEV-203, and each one aimed rather than blind: with fixed slots a step's
    // resting position can be empty, so a press without aiming is a press that
    // legitimately does nothing.
    await page.keyboard.down('KeyS')
    await page.waitForTimeout(500)
    await page.keyboard.up('KeyS')
    await page.waitForTimeout(300)
    // DEV-558: the room opens on its doors, so SINGLE PLAYER first (aimed, as
    // every step below is), and the seat back to its resting look.
    await throughDoors(page)
    // DEV-382: and one for the VARIANT, where the room asks for it — and none
    // for the RANK where the plan's place carries it (DEV-420): the room's own
    // step list, asked before each step, says which.
    const STEP_OF = {
      vehicle: 'vehicles',
      variant: 'variants',
      mode: 'modes',
      rank: 'ranks',
      mission: 'courses',
    } as const
    for (const kind of ['vehicle', 'variant', 'mode', 'rank', 'mission'] as const) {
      if (!((await hangarAim(page))?.views.includes(STEP_OF[kind]) ?? false)) continue
      // DEV-884: a first visit rests on Flight School; this walk takes Ring Attack's places.
      if (kind === 'mode')
        expect(await lookUntilAimed(page, 'ringAttack'), 'Ring Attack is in reach').toBe(true)
      expect(await stepInto(page, kind), `found a ${kind}`).toBe(true)
    }
    expect(await eyeToShip(page), 'and on a table it boards').toBeLessThan(3)
  })

  test('the lap plate takes you back one step', async ({ page }) => {
    // The one plate a player uses on every visit. `plateAction` and `viewBehind`
    // are unit-tested in `tests/unit/level-steps.test.ts` — what is only
    // provable here is the WIRING: that aiming at it and pressing A really does
    // climb back out, in a browser, through the same gaze cast a head uses.
    await page.goto('/?xr=off&title=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    // DEV-604: a click on the hangar presses the table under it, and a
    // `title=0` load is in the hangar: focus without clicking anything.
    await dropFocus(page)
    await page.waitForTimeout(1_500)

    // Down one step, into the flight plans of the aircraft under the pointer.
    // One step, not two: BACK must land on the step above, not at the top, and
    // a test that started two deep could not tell those apart (`viewBehind` is
    // the rule, and a `showVehicles()` wired here by mistake would pass it).
    // DEV-558: through the doors first, SINGLE PLAYER.
    await throughDoors(page)
    expect(await stepInto(page, 'vehicle'), 'found an aircraft').toBe(true)
    // DEV-382: on Anniversary that press opened the VARIANTS, and the plans are
    // one more down. BACK from the plans must then land on the variants — the
    // step above — which a `showVehicles()` wired here by mistake would not.
    await throughVariants(page)
    expect((await aimed(page))?.view).toBe('modes')
    const above = (await hangarAim(page))?.views.includes('variants') ? 'variants' : 'vehicles'

    // The plates sit in your lap, 26 degrees below the nearest table. Look down
    // until one lights up.
    // DEV-858: the plates lie 30 degrees either side of the EYE's line (the left one is
    // BACK), so a seat at rest is blind to both: turn left to it, as a player does, then
    // look down. Not the other way round: the seat's resting yaw is read, not assumed.
    const rest = await cameraYaw(page)
    // DEV-884: a first visit's seat already rests turned 30 degrees left, on Flight School,
    // which is the line the BACK plate lies on: turning another 30 would walk past it.
    const resting = (await aimed(page))?.aim as { mode?: { mode: string } } | null
    const alreadyLeft = resting?.mode?.mode === 'lesson'
    // `cameraYaw` is minus three's yaw (atan2(-m8, m10)), so turning LEFT by 30 degrees lowers it.
    if (rest !== null && !alreadyLeft) await turnSeatTo(page, rest - (30 * Math.PI) / 180)
    expect(await lookUntil(page, 'KeyS', 'back'), 'found the BACK plate by looking down').toBe(true)

    // Take it — and do NOT board, which is the half of the claim that would go
    // unnoticed: a back plate that also launched a mission is a back plate
    // nobody would press twice.
    //
    // **Deliberately not "the press did it".** The plate takes a 0.75 s dwell as
    // well as an A press, and finding it by looking down burns some of that
    // dwell before the press can land — so which of the two fired is a race, and
    // a spec that asserts the press wins is a spec that goes red about once in
    // five runs. It did. Both routes are the feature, so the claim is the
    // OUTCOME: aim at it, and you end up back on the aircraft, still in the
    // chair.
    // (Whether the dwell is too eager for a player is a question for a head.)
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await aimed(page))?.view, { timeout: 10_000, intervals: [250] })
      .toBe(above)
    expect(await eyeToShip(page), 'and still in the chair').toBeGreaterThan(4)
  })

  test('?menu=0 starts you in the ship, for anyone who wants the old path', async ({ page }) => {
    await page.goto('/?xr=off&menu=0')
    await firstPress(page)
    await missionReady(page, 180_000)
    await page.waitForTimeout(1_500)
    expect(await eyeToShip(page)).toBeLessThan(3)
  })
})
