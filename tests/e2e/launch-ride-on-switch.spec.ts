/**
 * tests/e2e/launch-ride-on-switch.spec.ts — the lift rides, the room is a room,
 * and the next course you pick rides it too.
 *
 * ── The two bugs ─────────────────────────────────────────────────────────
 *
 * DEV-077 left both of these open in as many words: *"The alpine launch shaft is
 * still inside the hillside"* and *"A swapped mission does not ride the lift."*
 * The second turned out to be the smaller half of something worse — the spend
 * was an unconditional line in `frame`, so `rideSpec.skipRide` was true from the
 * first frame and **nothing had ridden the lift on any path**, boot included.
 * Measured before the fix, on `rookie_01_hoverJet`: the body sat at 112.037 —
 * spawn 5.39 plus the whole 106.647 rise — from the first frame to the release.
 *
 * A still frame cannot tell those apart. The ship is at the top either way, and
 * both readings look like a launch; what distinguishes them is 15.5 seconds of
 * climbing. So this file watches the rise over TIME and says what it saw.
 *
 * ── Why the room assertion is geometric and not a picture ────────────────
 *
 * *"Nothing of the world in the room"* is exactly the kind of claim a screenshot
 * proves for one mission and one camera angle. The room's base is 92–99 m inside
 * solid ground on four of the seven rigs and comfortably clear of it on the
 * other three, so a spec that checked the one environment anybody had looked at
 * would have passed all year — that is DEV-075's lesson and the agreement lesson
 * under it. What is asserted here instead is the property the fix makes true:
 * while the lift is below 2016's reveal, **nothing of the mission world has a
 * vertex inside the room's volume**, scanned over every drawn mesh in the scene
 * rather than over a list of the ones we remembered.
 *
 * It is a claim about the RIDE. The pad at the top of the shaft is a different
 * question and it has a different answer — see DEV-094 §6, where the alpine one
 * turns out to have a tree 5.4 m from it.
 *
 * ── And the mechanism is not the claim (DEV-268) ─────────────────────────
 *
 * The paragraph above was written and then not followed. Beside the geometric
 * scan, three assertions across this file and `completion.spec.ts` asked
 * whether the LAND GROUP's `visible` flag was false — which is one way the
 * build could satisfy the claim, not the claim. `07bf549` shipped
 * `?rideHide=bore` on (DEV-249), under which the group is deliberately drawn
 * for the whole ride and a single chunk comes and goes, and all three went
 * red while nothing a player can see had changed: measured over the full
 * climb, both arms put **zero** vertices of the world inside the sealed
 * volume, and the two are pixel-identical from the pad to within the 9-pixel,
 * 1-LSB noise floor that two shots of the SAME arm also differ by.
 *
 * So the state claim is `roomVisible` now — `app.ts` writes
 * `launchRoom.object.visible = !revealed` outside the `?rideHide` branch, so
 * it is the reveal itself — and the drawn-geometry claim is the scan, widened
 * from the room to the room PLUS the bore, which is the only line of sight out
 * of a sealed shaft and was never scanned before. `?rideHide`'s own two arms
 * are pinned in a test of their own, further down, which is where a default
 * flip belongs.
 *
 * `@gpu` because it needs a real world: hydrated `public/assets` and a GPU that
 * is not SwiftShader.
 */

import { REVEAL_RISE } from '../../src/render/elevator'
import { DEFAULT_HANGAR_DROP, hangarSpecFor } from '../../src/sim/hangar'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { aimAtCourse, throughDoors } from './fixtures/hangar'
import { hold as keysHold } from './fixtures/keys'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

interface LaunchProbe {
  phase: string
  rise: number
  ridePending: boolean | null
  shipY: number | null
  terrainVisible: boolean | null
  roomVisible: boolean | null
  /**
   * The cockpit HUD, read off the scene being DRAWN (`__ff2.stage()`): up
   * only on the mission screen, so "am I aboard". Not off `render.scene` —
   * see the note in the traverse below.
   */
  hudVisible: boolean
  countTotal: number
}

const launchProbe = (page: Page): Promise<LaunchProbe> =>
  page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    const ff = w.__ff2
    let terrainVisible: boolean | null = null
    let roomVisible: boolean | null = null
    let hudVisible = false
    ff?.render.scene.traverse((o) => {
      // `launch-room`, not `hangar`: `createHangar` names both of its groups
      // `hangar` and there are two, one per scene. `app.ts` renames this one so
      // a traverse of the MISSION scene cannot find the menu's by accident —
      // which is how two other specs came to assert the menu was up by reading
      // the launch shell (DEV-094).
      if (o.name === 'world-terrain') terrainVisible = o.visible === true
      if (o.name === 'launch-room') roomVisible = o.visible === true
    })
    // ── the HUD off the STAGE, not off the mission scene (DEV-355) ─────────
    //
    // Since DEV-355 a course switch builds the next world in the mission scene
    // while the player waits in the loading scene, and the new flight goes
    // live only when the build is WHOLE (`flight = loadedFlight`, after the
    // warm). Its object is added to `render.scene` at the start of the build,
    // and the frame loop's `hud.object.visible = inCockpit && !paused` reaches
    // only the LIVE flight — so for the whole build the new panel sits at
    // three's default `visible: true` in a scene nobody is drawing. Measured on
    // `rookie_01_hoverJet` from int_01's room: that HUD reads up at +0.65 s
    // after the press, the player is aboard at +3.0 s, and a probe of
    // `render.scene` called the loading scene "the cockpit" for 2.4 s. The
    // room is correctly hidden then (`revealed` is `screen !== 'mission' || …`)
    // and correctly up once aboard, so the red this made was the spec's.
    //
    // `stage()` is whichever scene the frame draws — the menu's while you wait,
    // the mission's once aboard — which is how `completion.spec.ts` has always
    // read it, and why its identical wait never went red.
    //
    // OR across the traverse, never last-wins: `completion.spec.ts` carries
    // the note — a submesh sharing a name reported a hidden screen as visible.
    ff?.stage().traverse((o) => {
      if (o.name === 'hud') hudVisible = hudVisible || o.visible === true
    })
    return {
      hudVisible,
      phase: ff?.launch().phase ?? 'none',
      rise: ff?.launch().rise ?? -1,
      ridePending: ff?.launch().ridePending ?? null,
      shipY: ff?.flight()?.jet.body.position.y ?? null,
      terrainVisible,
      roomVisible,
      countTotal: ff?.mission.countTotal ?? 0,
    }
  })

/**
 * How many vertices of the mission world are inside the SEALED VOLUME right
 * now — the room, plus the bore above it, all the way to the shaft's rim.
 *
 * Every mesh the renderer would draw — effective visibility, so a mesh under a
 * hidden group does not count — minus the room and the elevator that are
 * supposed to be in there, and minus the ship standing on the platform. A
 * world-space bounding sphere rejects the 600-odd terrain chunks that are
 * nowhere near before any vertex is touched.
 *
 * The volume is the room's own revolve out of `sim/hangar.ts`, composed on the
 * live `launch-anchor`, so it moves with the mission rather than being a box
 * somebody typed. Its TOP is measured the same way: the bounding box of
 * `elevator-shaft-wall`, the mesh that does the sealing (DEV-106), rather than
 * the 104.447 that `render/elevator.ts`'s comment works out for one rig. A rim
 * it cannot find is an exception and not a fallback — a scan of the wrong
 * volume reports zero for the wrong reason, which is the failure this whole
 * helper exists to avoid.
 *
 * ── Why the bore and not just the room (DEV-268) ─────────────────────────
 *
 * Because the room is not the whole of what you can see out of. With the shaft
 * sealed the eye's only line out is up the tube, so the tube is part of the
 * claim, and until now nothing scanned it. It is also the half that has teeth
 * under `?rideHide=bore`: measured on `rookie_01_hoverJet`, the one chunk that
 * flag hides — `chunk_5_5` — puts **53 vertices** inside this volume the
 * instant it is drawn. So a bore selection that ever picked the wrong chunk, or
 * none, lands here as a number rather than as nothing.
 */
const worldInsideShaft = (
  page: Page,
  shaft: { roomRadius: number; boreRadius: number; floorY: number; ceilingY: number },
) =>
  page.evaluate((vol) => {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const ff = (globalThis as any).__ff2
    if (!ff)
      return { anchor: null as number[] | null, rimY: 0, inside: -1, offenders: [] as string[] }
    const scene = ff.render.scene
    scene.updateMatrixWorld(true)
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    let anchor: any = null
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    let wall: any = null
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (o.name === 'launch-anchor') anchor = o
      if (o.name === 'elevator-shaft-wall') wall = o
    })
    if (!anchor) return { anchor: null, rimY: 0, inside: -1, offenders: [] }
    const a = anchor.matrixWorld.elements as number[]
    const ax = a[12] as number
    const ay = a[13] as number
    const az = a[14] as number

    // The top of the tube, in the anchor's frame. Thrown rather than defaulted:
    // see the note on this helper.
    if (!wall?.geometry) throw new Error('worldInsideShaft: no elevator-shaft-wall in the scene')
    if (!wall.geometry.boundingBox) wall.geometry.computeBoundingBox()
    const wm = wall.matrixWorld.elements as number[]
    const rimY =
      (wall.geometry.boundingBox.max.y as number) * (wm[5] as number) + (wm[13] as number) - ay

    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const drawn = (o: any): boolean => {
      for (let n = o; n; n = n.parent) if (n.visible === false) return false
      return true
    }
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const under = (o: any, name: string): boolean => {
      for (let n = o; n; n = n.parent) if (n.name === name) return true
      return false
    }

    let inside = 0
    const offenders: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return
      if (!drawn(o)) return
      // The room, the shaft and the ship belong in there.
      if (under(o, 'launch-anchor') || under(o, 'hoverjet') || under(o, 'jumpseat')) return
      const g = o.geometry
      if (!g.boundingSphere) g.computeBoundingSphere()
      const bs = g.boundingSphere
      const m = o.matrixWorld.elements as number[]
      const cx = (m[0] as number) * bs.center.x + (m[4] as number) * bs.center.y
      const cy = (m[1] as number) * bs.center.x + (m[5] as number) * bs.center.y
      const cz = (m[2] as number) * bs.center.x + (m[6] as number) * bs.center.y
      const wx = cx + (m[8] as number) * bs.center.z + (m[12] as number)
      const wy = cy + (m[9] as number) * bs.center.z + (m[13] as number)
      const wz = cz + (m[10] as number) * bs.center.z + (m[14] as number)
      // Uniform-scale-agnostic: take the largest axis scale off the matrix.
      const sx = Math.hypot(m[0] as number, m[1] as number, m[2] as number)
      const sy = Math.hypot(m[4] as number, m[5] as number, m[6] as number)
      const sz = Math.hypot(m[8] as number, m[9] as number, m[10] as number)
      const r = bs.radius * Math.max(sx, sy, sz)
      // The sealed volume's bounding sphere: the wider of the two radii, and
      // the half-height of floor-to-rim.
      const volHalf = (rimY - vol.floorY) / 2
      const volR = Math.hypot(Math.max(vol.roomRadius, vol.boreRadius), volHalf)
      const volY = ay + (rimY + vol.floorY) / 2
      if (Math.hypot(wx - ax, wy - volY, wz - az) > r + volR) return

      const p = g.attributes.position
      let hits = 0
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i)
        const y = p.getY(i)
        const z = p.getZ(i)
        const vx =
          (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number)
        const vy =
          (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number)
        const vz =
          (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number)
        const rel = vy - ay
        if (rel < vol.floorY || rel > rimY) continue
        // The room's full radius below its ceiling; the bore's above it.
        const rad = Math.hypot(vx - ax, vz - az)
        if (rad > (rel <= vol.ceilingY ? vol.roomRadius : vol.boreRadius)) continue
        hits++
      }
      if (hits > 0) {
        inside += hits
        offenders.push(`${o.name || o.parent?.name || o.type}:${hits}`)
      }
    })
    return { anchor: [ax, ay, az], rimY, inside, offenders: offenders.slice(0, 8) }
  }, shaft)

/**
 * Which step the level select is on: 'vehicles', 'modes', 'ranks' or 'courses'.
 *
 * Four since DEV-203 — Matt's *"aircraft > mode > difficulty > location"*.
 */
const view = (page: Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.view ?? null)

/** What the nose pointer is on, by name, whichever step is up. */
const aimedName = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const h = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()
    if (h?.aim?.kind === 'vehicle') return h.aim.vehicle?.vehicle ?? null
    if (h?.aim?.kind === 'mode') return h.aim.mode?.mode ?? null
    if (h?.aim?.kind === 'rank') return h.aim.rank?.difficulty ?? null
    if (h?.aim?.kind === 'mission') return h.aim.mission?.id ?? null
    return null
  })

/**
 * Turn the seat until `want` is under the pointer, sweeping BOTH ways.
 *
 * Short taps, and more of them than there are tables: the seat turns for as
 * long as the key is down, so a longer press steps further round the arc and
 * can jump straight over the one it was looking for. `completion.spec.ts` turns
 * in 80 ms nudges for the same reason, and this file overshot the target on one
 * run in four before it did the same.
 *
 * Right, then back left past home — the arc is 90 degrees wide and the room is
 * 360, so one direction alone takes the long way round from a table at the far
 * end. Measured: a notch is about 3.7 degrees.
 */
const turnUntil = async (page: Page, want: string): Promise<boolean> => {
  const nudge = async (key: 'KeyA' | 'KeyD'): Promise<void> => {
    await page.keyboard.down(key)
    await page.waitForTimeout(80)
    await page.keyboard.up(key)
    await page.waitForTimeout(80)
  }
  for (const key of ['KeyD', 'KeyA'] as const) {
    for (let i = 0; i < (key === 'KeyD' ? 32 : 64); i++) {
      if ((await aimedName(page)) === want) return true
      await nudge(key)
    }
  }
  return (await aimedName(page)) === want
}

/**
 * Press Enter until `done` says it landed, up to four times.
 *
 * A confirm is a level read once a frame, so a press that falls between two
 * frames is a press nothing saw — and in the level select that is not a lost
 * frame, it is a spec that then waits five minutes for a world nobody asked
 * for. Pressing again when nothing happened is what a person does; it drives the
 * shipped build through the shipped path and adds no switch to it.
 */
const pressUntil = async (page: Page, done: () => Promise<boolean>): Promise<boolean> => {
  for (let i = 0; i < 4; i++) {
    if (await done()) return true
    await hold(page, 'Enter')
  }
  return done()
}

/** Held, not tapped: every confirm is a level read once a frame. */
const hold = (page: Page, key: string, settle = 400): Promise<void> =>
  keysHold(page, key, { down: 200, settle })

const boot = async (page: Page, query: string): Promise<void> => {
  await page.goto(query)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  await page.waitForTimeout(1_200)
}

/** Watch the platform for `seconds`, sampling the rise. */
const watchRise = async (page: Page, seconds: number, every = 500): Promise<number[]> => {
  const rises: number[] = []
  for (let t = 0; t < seconds * 1000; t += every) {
    rises.push((await launchProbe(page)).rise)
    await page.waitForTimeout(every)
  }
  return rises
}

/**
 * The sealed volume, in the anchor's frame. The anchor IS the resting platform.
 *
 * The room's cylinder up to its ceiling, then the bore the platform rises
 * through. The top comes off the live shaft wall inside `worldInsideShaft`,
 * because it is a property of the rig rather than of the hangar spec.
 */
const SHAFT = (() => {
  const spec = hangarSpecFor()
  return {
    roomRadius: spec.roomRadius,
    boreRadius: spec.boreRadius,
    floorY: spec.floorY,
    ceilingY: spec.ceilingY,
  }
})()

/**
 * The rank and course the switch test drills into, and why they are not the
 * loaded ones.
 *
 * The boot mission is `int_01_hoverJet` — HoverJet, Ring Attack, Intermediate,
 * Simonet. Beginner is where `rookie_01_hoverJet` lives, in the Alpine Forest,
 * which is a different world and therefore a real swap. (DEV-105 turned the
 * middle step from a place into a rank and DEV-203 put the FLIGHT PLAN in front
 * of it; the test still swaps worlds, it just takes one more press to get
 * there. And DEV-420 took the rank page away again for Ring Attack: Beginner is
 * the green square on Alpine Forest's table, looked at rather than pressed.)
 *
 * The course is named now. It used to take whatever sat at the resting bearing,
 * which the rotation guaranteed was a course; with fixed slots a position can
 * be empty, and a press on nothing is a five-minute wait for a world nobody
 * asked for.
 */
const OTHER_COURSE = 'rookie_01_hoverJet'

test.describe('@gpu the launch elevator', () => {
  test.setTimeout(420_000)

  test('rides on the first launch of a world build, out of a room with no world in it', async ({
    page,
  }) => {
    // `rookie_01_hoverJet` on purpose: its shaft base is 98.8 m inside the
    // alpine hillside and its release only 7.8 m clear of the surface, which is
    // the mission DEV-077 named.
    await boot(page, '/?mission=rookie_01_hoverJet&xr=off&title=0&menu=0')

    const waiting = await launchProbe(page)
    expect(waiting.phase, 'waiting on the pad').toBe('waiting')
    expect(waiting.rise, 'at the bottom of the shaft').toBeLessThan(0.001)
    expect(waiting.ridePending, 'and this world build has its ride').toBe(true)
    // The bug DEV-077 described, as a state rather than as a picture.
    //
    // `roomVisible`, not `terrainVisible`: DEV-268. `app.ts` writes
    // `launchRoom.object.visible = !revealed` outside the `?rideHide` branch,
    // so it reads the reveal itself; the land group's flag is one arm's
    // MECHANISM for acting on it, and under the shipped `?rideHide=bore` that
    // group stays drawn for the whole ride on purpose. This line asserted the
    // mechanism and went red the day the default flipped, while the claim
    // underneath it never moved.
    expect(waiting.roomVisible, 'sealed in the room, with the world not yet revealed').toBe(true)

    // THE GEOMETRIC CLAIM, and since DEV-268 it is the only one here that
    // depends on what is DRAWN. Not "the terrain group is hidden" — that is a
    // mechanism, and an arm-specific one — but "nothing of the world reaches
    // into the room or the tube above it", over every mesh the renderer would
    // draw. True of both arms, and sensitive to the way either could fail.
    const below = await worldInsideShaft(page, SHAFT)
    expect(below.anchor, 'the launch anchor was found').not.toBeNull()
    expect(below.rimY, 'and the tube it scanned is a hundred-metre one').toBeGreaterThan(90)
    expect(
      below.inside,
      `nothing of the world is in the shaft: ${below.offenders.join(', ')}`,
    ).toBe(0)
    // And the anchor really is the deep one, so the volume just scanned is the
    // buried room rather than something at pad height.
    const anchorY = (below.anchor as number[])[1] as number
    expect(waiting.shipY as number, 'the ship is standing on that anchor').toBeCloseTo(anchorY, 1)

    // ── press A, and watch it climb ──────────────────────────────────────
    await hold(page, 'Enter', 100)
    const rises = await watchRise(page, 12)
    // Rising, not teleporting: every sample above the last, and the whole
    // sequence spread over seconds rather than jumping in one frame.
    for (let i = 1; i < rises.length; i++) {
      expect(rises[i] as number, `sample ${i} is above sample ${i - 1}`).toBeGreaterThanOrEqual(
        rises[i - 1] as number,
      )
    }
    const mid = rises[Math.floor(rises.length / 2)] as number
    expect(mid, 'halfway up, halfway up').toBeGreaterThan(5)
    expect(mid, 'and not yet out').toBeLessThan(REVEAL_RISE)

    // ── and the world is there when the platform breaks the surface ──────
    //
    // Polled on the ROOM going away, for DEV-268's reason: under the shipped
    // `?rideHide=bore` the land group is already drawn, so a poll on it
    // returns on the first tick and the rise assertion below then fires 100 m
    // early. `!revealed` is the same instant in both arms.
    await expect
      .poll(async () => (await launchProbe(page)).roomVisible, {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(false)
    const out = await launchProbe(page)
    expect(out.rise, 'revealed at 2016 trigger height or above').toBeGreaterThanOrEqual(REVEAL_RISE)
    expect(out.terrainVisible, 'and the island is drawn once you are out').toBe(true)
    expect(out.shipY as number, 'a full rise above the marker').toBeGreaterThan(
      anchorY + REVEAL_RISE,
    )
  })

  /**
   * `?rideHide`'s two arms, and which of them ships — DEV-268.
   *
   * This exists because the three gameplay assertions above USED to carry the
   * answer, as a bare `false`, in three places. `07bf549` flipped the default
   * to `bore` on a measured argument (DEV-249: the reveal's triangle step goes
   * from +3,719,556 to +67,572, and a latching compositor latches on a step),
   * and all three went red saying *"expected false, received true"* — which
   * names neither the flag nor the reason and reads exactly like the defect
   * they were written to catch.
   *
   * So the flag's behaviour is pinned HERE, once, where the failure message
   * can say what happened, and the gameplay tests assert the claim instead.
   * The arm is READ OFF THE BUILD rather than assumed: a no-flag boot is
   * compared against both explicit arms, and only then is the answer checked
   * against what is meant to ship. Flipping the default deliberately is a
   * one-line change to this test; flipping it by accident is one red test that
   * says which way round it went.
   *
   * The other half is the one that matters to a player, and it is asserted on
   * every arm: **nothing of the world inside the shaft**. Under `bore` that is
   * not a formality — `chunk_5_5` is 53 vertices inside this volume the moment
   * it is drawn, so a selection that picked the wrong chunk lands here.
   */
  test('hides the world for the ride on either arm, and ships the smaller one', async ({
    page,
  }) => {
    const armOf = async (query: string) => {
      await boot(page, `/?mission=${OTHER_COURSE}&xr=off&title=0&menu=0${query}`)
      const p = await launchProbe(page)
      expect(p.phase, `${query || '(default)'}: waiting on the pad`).toBe('waiting')
      expect(p.roomVisible, `${query || '(default)'}: sealed in the room`).toBe(true)

      const chunks = await page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
        const scene = (globalThis as any).__ff2.render.scene
        let total = 0
        let hidden = 0
        // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
        scene.traverse((o: any) => {
          if (!o.name?.startsWith('chunk_')) return
          // The LAND's chunks: the sea is a second faceted terrain with the
          // same naming, and it is never what `?rideHide` acts on.
          let land = false
          // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
          for (let n: any = o; n; n = n.parent) if (n.name === 'world-terrain') land = true
          if (!land) return
          total++
          if (o.visible === false) hidden++
        })
        return { total, hidden }
      })

      // The claim, on every arm.
      const inShaft = await worldInsideShaft(page, SHAFT)
      expect(
        inShaft.inside,
        `${query || '(default)'}: nothing of the world in the shaft: ${inShaft.offenders.join(', ')}`,
      ).toBe(0)

      return { groupVisible: p.terrainVisible === true, ...chunks }
    }

    const all = await armOf('&rideHide=all')
    expect(all.groupVisible, '?rideHide=all hides the land group whole').toBe(false)

    const bore = await armOf('&rideHide=bore')
    expect(bore.groupVisible, '?rideHide=bore leaves the land group drawn').toBe(true)
    expect(
      bore.total,
      'and the land is more than one chunk, so "hide the bore" is not "hide the world"',
    ).toBeGreaterThan(1)
    // The loud counterpart to the console line `app.ts` prints when the bore
    // selection comes up empty — *"NONE, so the ride shows the world and the
    // bore may show ground"*. A selection of nothing is `bore` doing nothing at
    // all, and a line in a console nobody reads is not a guard.
    //
    // On THIS rig the shaft scan above would catch it too — `chunk_5_5` is 53
    // vertices inside that volume whenever it is drawn — so the two are
    // independent readings of the same failure rather than one covering for
    // the other. That is the point of having both: the scan is the claim, and
    // this is the mechanism that is supposed to deliver it.
    expect(bore.hidden, '?rideHide=bore hides the chunks the bore crosses').toBeGreaterThanOrEqual(
      1,
    )
    expect(
      bore.hidden,
      'and only those — it is not a whole-group hide by another name',
    ).toBeLessThan(bore.total)

    // What a player gets with no flag at all.
    const shipped = await armOf('')
    const which =
      shipped.groupVisible === bore.groupVisible && shipped.hidden === bore.hidden
        ? 'bore'
        : shipped.groupVisible === all.groupVisible
          ? 'all'
          : 'neither'
    expect(which, 'the shipped default behaves like one of the two arms').not.toBe('neither')
    // DEV-249, turned on in `07bf549` on Matt's call: *"i'm a lil frustrated
    // that some of our perf wins today are defaulting to off."* Change this
    // line, and nothing else, if the default moves again.
    expect(which, 'the shipped default is ?rideHide=bore — DEV-249, commit 07bf549').toBe('bore')
  })

  test('spends the ride on that press, and a spent one starts at the top', async ({ page }) => {
    // *"An establishing shot, not a toll on every retry."* That rule is 2016's
    // too: `Trigger_EnableTerrain.Start()` turns the terrain straight back on
    // when `PlayerPrefs["Respawning"]` is set, because a respawn does not ride.
    //
    // Two halves, because the bug was in the seam between them. The spend used
    // to happen in `frame`, on every frame, so it was already gone before the
    // press that was supposed to use it.
    await boot(page, '/?mission=rookie_01_hoverJet&xr=off&title=0&menu=0')
    expect((await launchProbe(page)).ridePending, 'the first one is owed').toBe(true)

    await hold(page, 'Enter', 100)
    await expect
      .poll(async () => (await launchProbe(page)).phase, { timeout: 10_000, intervals: [200] })
      .toBe('rising')
    expect((await launchProbe(page)).ridePending, 'and spent by the press that used it').toBe(false)

    // ── and what a spent spec looks like from the first frame ────────────
    //
    // `?ride=0` is the same `LaunchSpec.skipRide` a retry lands on — `restartRun`
    // calls `resetLaunch` with whatever `rideSpec` currently is — so this is that
    // state, reached without driving the pause plate. The plate is
    // `pause.spec.ts`'s subject and `resetLaunch`'s own behaviour is pinned in
    // `tests/unit/launch-reveal.test.ts`; what is worth an e2e here is that the
    // world is DRAWN in it, which is the half no unit test can see.
    await boot(page, '/?mission=rookie_01_hoverJet&xr=off&title=0&menu=0&ride=0')
    const skipped = await launchProbe(page)
    expect(skipped.phase, 'waiting on the pad').toBe('waiting')
    expect(skipped.ridePending, 'with nothing owed').toBe(false)
    expect(skipped.rise, 'but already at the top').toBeGreaterThanOrEqual(REVEAL_RISE)
    expect(skipped.terrainVisible, 'and the island drawn from the first frame').toBe(true)
    expect(skipped.roomVisible, 'with no room around you').toBe(false)
  })

  test('rides again for the next course you pick, once per world build', async ({ page }) => {
    // The whole of DEV-077's second paragraph. `switchMission` builds a new
    // world under the room, and a new world is owed a ride — so the first course
    // you switch to shows the 106 m climb and the one after a retry does not.
    await boot(page, '/?xr=off&title=0')
    // DEV-558: the room opens on its doors; SINGLE PLAYER is the walk below,
    // and the seat goes back to rest, where the HoverJet is.
    await throughDoors(page)

    // The aircraft arc's first position is the HoverJet, which is also the one
    // the loaded mission flies, so one press goes in — and on Anniversary a
    // second takes the VARIANT step (DEV-382), whose resting table is
    // `standard` (`variant-step.test.ts` holds that), so pressing until the
    // plans are up walks both.
    expect(
      await pressUntil(page, async () => (await view(page)) === 'modes'),
      "inside the HoverJet's flight plans",
    ).toBe(true)

    // Ring Attack, searched rather than computed, for `completion.spec.ts`'s
    // reasons (it rests under the pointer since DEV-419, and this does not
    // lean on that).
    expect(await turnUntil(page, 'ringAttack'), 'found Ring Attack by looking').toBe(true)
    // Where the loaded mission's shaft base is, so the swap can be told from a
    // boarding of what was already there. `int_01_hoverJet` rests at 19.79.
    const wasY = (await launchProbe(page)).shipY as number

    // Into its PLACES — DEV-420: Ring Attack's rank is a mark on each place's
    // table, so there is no rank page between. Pressed until it lands rather
    // than once and hoped: a confirm is a LEVEL read once a frame, so a press
    // that falls between two frames is a press nothing saw, and this spec spent
    // one run of three sitting in the menu for five minutes waiting on a world
    // nobody had asked for. Pressing again when nothing happened is what a
    // person does.
    expect(
      await pressUntil(page, async () => (await view(page)) === 'courses'),
      "inside Ring Attack's places",
    ).toBe(true)
    // NAMED, since DEV-203: nothing rotates, so "whatever is at the resting
    // bearing" is no longer guaranteed to be the course wanted — and a press on
    // the wrong one would load the wrong world. The Beginner course in another
    // world: Alpine Forest's green square, looked at, which picks it.
    expect(await aimAtCourse(page, OTHER_COURSE), 'found the alpine course by looking').toBe(true)
    await hold(page, 'Enter')

    // `switchMission` boards you only once the whole world has landed, so the
    // COCKPIT appearing ON THE STAGE is the completion signal — on the stage,
    // because the new flight's panel is in the mission scene, at its default
    // `visible`, for the whole build (DEV-355; `launchProbe` has the note).
    // Polling the objective count would pass instantly — the mission already
    // loaded has one too, and alpine's two courses carry 16 and 21 against
    // simonet's 21, so the number cannot be the signal either.
    await expect
      .poll(async () => (await launchProbe(page)).hudVisible, {
        timeout: 300_000,
        intervals: [1_000],
      })
      .toBe(true)
    await page.waitForTimeout(1_000)
    // And the game's own word for it, beside the HUD: `data-switching` goes at
    // the black of the fade into the cockpit, which is what `board()` waits on.
    // Two readings of "aboard" from two places, so a probe that drifts off the
    // screen the player is looking at again says so here, not three lines on.
    expect(
      await page.evaluate(() => document.body.dataset.switching ?? null),
      'aboard: the swap has cleared data-switching',
    ).toBeNull()

    const swapped = await launchProbe(page)
    // A different course, said with the one number no flag could set by
    // accident: every rig rests at its own depth, and alpine's two are 5.39 and
    // 667.38 against the 19.79 this page booted on.
    expect(Math.abs((swapped.shipY as number) - wasY), 'a different world').toBeGreaterThan(5)
    expect(swapped.phase, 'on the pad of the new course').toBe('waiting')
    expect(swapped.ridePending, 'and the new world build is owed a ride').toBe(true)
    expect(swapped.rise, 'at the bottom of its shaft').toBeLessThan(0.001)
    // The reveal itself, not one arm's way of acting on it — DEV-268, and the
    // note in the first test.
    expect(swapped.roomVisible, 'sealed in the room the swap dropped you into').toBe(true)

    // The room the swap dropped you into is a room, on whatever environment the
    // picker landed on — and so is the tube above it.
    const inShaft = await worldInsideShaft(page, SHAFT)
    expect(inShaft.inside, `nothing of the world is in it: ${inShaft.offenders.join(', ')}`).toBe(0)

    await hold(page, 'Enter', 100)
    const rises = await watchRise(page, 8)
    expect(rises[rises.length - 1] as number, 'and it climbs').toBeGreaterThan(
      (rises[0] as number) + 10,
    )
    await expect
      .poll(async () => (await launchProbe(page)).roomVisible, {
        timeout: 30_000,
        intervals: [250],
      })
      .toBe(false)
    expect((await launchProbe(page)).terrainVisible, 'and the island is drawn').toBe(true)
  })

  test('never rides on a mission with no launch rig at all', async ({ page }) => {
    // Six of the thirteen. `DEFAULT_HANGAR_DROP` still puts a room under them —
    // `PlayerStart_jumpSeat.prefab` carries the same hangar and shaft — but
    // there is no elevator and no ride, so the world has to be drawn from the
    // first frame or half the game is a grey box.
    await boot(page, '/?mission=rookie_01_jumpSeat&xr=off&title=0&menu=0')
    const p = await launchProbe(page)
    expect(p.ridePending, 'no rig, nothing owed').toBeNull()
    expect(p.terrainVisible, 'and the island is drawn').toBe(true)
    expect(p.roomVisible, 'while its unreachable room is not').toBe(false)
    // The drop is the HoverJet's own rise, so a JumpSeat's room is as deep and
    // as far from anything as a HoverJet's. Stated here because the room is
    // invisible and nothing else would notice it moving.
    expect(DEFAULT_HANGAR_DROP).toBeGreaterThan(100)
  })
})
