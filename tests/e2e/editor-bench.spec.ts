/**
 * The VR bench, end to end, in an emulated headset. DEV-492 (EDITOR.md §5.3,
 * "On the bench (headset)").
 *
 * IWER (`fixtures/emulated-xr.ts`) is a headset made of JavaScript: nothing
 * under `src/` knows it exists, and the game takes its own XR path —
 * `requestSession`, the rig, the laser (`render/xr-pointer.ts`), the
 * session's `xr-standard` pads. So everything here is what a person with two
 * controllers does:
 *
 *   · the door: the right controller is swept until EDIT ON THE BENCH is
 *     under its beam, and the trigger opens the bench;
 *   · three points by TRIGGER on the island, each landing where the ray met
 *     the island, at the placement height over the ground the bench judges
 *     against; the one placed at the bench's −x is WEST of the one at +x in
 *     the level (an asymmetric check: orientation bugs are a class here);
 *   · GRIP near a handle, the controller moved, GRIP released: the draft's
 *     point moved by exactly the hand's movement carried through the bench's
 *     axes and its 1:2000, in all three axes; and UNDO on the plate takes the
 *     whole drag back in one step (the core's coalescing);
 *   · FLY from the plate, and the pause plate's Back to editor brings the
 *     player back to the ROOM with the bench open on the same draft;
 *   · every program three holds linked, with draw calls and programs counted
 *     first (`fixtures/shader-link.ts`).
 *
 * THE PHOTOGRAPHS ARE THE EMULATOR'S VIEW: IWER draws both eyes side by side
 * into the page's canvas, and nothing here judges stereo. A thing that only
 * exists in a headset — reach, comfort, the scale in the hands — is answered by
 * WEARING it (the row's checklist says which).
 *
 * The controllers are aimed by MEASURING, not by a computed angle: the bench
 * reports each hand's world ray, the spec turns the controller by the angle
 * between that ray and the one it wants, and repeats. The rig carries only a
 * yaw, so this converges in a step or two whatever the room's layout is.
 */
import fs from 'node:fs'
import path from 'node:path'
import { switchGone } from './fixtures/boot'
import { emulatedXrInstalled, installEmulatedXr } from './fixtures/emulated-xr'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { hold } from './fixtures/hangar'
import { enterVr, loadSettled } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { sweepPrograms } from './fixtures/shader-link'
import { expect, type Page, test } from './fixtures/test'

/** 800 x 720 an eye: IWER sizes the canvas from the window (see the fixture). */
test.use({ viewport: { width: 1600, height: 720 }, deviceScaleFactor: 1 })

type Hand = 'left' | 'right'
type V3 = [number, number, number]

interface Probe {
  up: boolean
  ready: boolean
  slot: string | null
  island: string | null
  points: V3[]
  selection: number | null
  undo: number
  redo: number
  rings: number
  warnings: { kind: string; severity: string }[]
  ground: 'render' | 'field' | null
  placeHeight: number
  aimed: Record<Hand, string | null>
  held: Record<Hand, string | null>
  frame: { centreX: number; centreZ: number; seaY: number; scale: number; relief: number } | null
  axes: V3[] | null
  cells: Record<string, V3>
  status: string
  note: string
  rays: Record<Hand, { origin: V3; direction: V3 } | null>
  hits: Record<Hand, V3 | null>
  groundUnder: (number | null)[]
}
interface BenchState {
  up: boolean
  door: { up: boolean; aimed: boolean }
  flying: boolean
  probe: Probe | null
}

const benchState = (page: Page): Promise<BenchState | null> =>
  page.evaluate(
    () => ((globalThis as unknown as Ff2GlobalMaybe).__ff2?.bench?.() ?? null) as BenchState | null,
  )
const probe = async (page: Page): Promise<Probe> => {
  const s = await benchState(page)
  expect(s?.probe, 'the bench has loaded').toBeTruthy()
  return s?.probe as Probe
}

const presenting = (page: Page): Promise<boolean> =>
  page.evaluate(
    () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.render.renderer.xr.isPresenting ?? false,
  )

/** Where the photographs go: the session's scratch when set, else the test's output. */
const shotPath = (name: string, fallback: string): string => {
  const dir = process.env.BENCH_SHOTS_DIR
  if (!dir) return fallback
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

/** The yaw and pitch each controller was last turned to, degrees (yaw + is LEFT). */
const turned: Record<Hand, { yaw: number; pitch: number }> = {
  left: { yaw: 0, pitch: 0 },
  right: { yaw: 0, pitch: 0 },
}

/** Turn a controller: yaw about the vertical, then pitch about its own x. `q_yaw * q_pitch`. */
const turn = async (page: Page, hand: Hand, yawDeg: number, pitchDeg: number): Promise<void> => {
  turned[hand] = { yaw: yawDeg, pitch: pitchDeg }
  await page.evaluate(
    ({ hand, yawDeg, pitchDeg }) => {
      const r = Math.PI / 360
      const cy = Math.cos(yawDeg * r)
      const sy = Math.sin(yawDeg * r)
      const cx = Math.cos(pitchDeg * r)
      const sx = Math.sin(pitchDeg * r)
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<
                string,
                { quaternion: { set: (x: number, y: number, z: number, w: number) => void } }
              >
            }
          }
        }
      ).__emulatedXR.device.controllers[hand]
      c?.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
    },
    { hand, yawDeg, pitchDeg },
  )
  await page.waitForTimeout(90)
}

/** Move a controller by `d` in the reference space, over `steps` frames' worth, as a hand does. */
const shift = async (page: Page, hand: Hand, d: V3, steps = 6): Promise<void> => {
  const from = await page.evaluate((hand) => {
    const c = (
      globalThis as unknown as {
        __emulatedXR: {
          device: { controllers: Record<string, { position: { x: number; y: number; z: number } }> }
        }
      }
    ).__emulatedXR.device.controllers[hand]
    return c ? [c.position.x, c.position.y, c.position.z] : [0, 0, 0]
  }, hand)
  for (let i = 1; i <= steps; i++) {
    const f = i / steps
    await page.evaluate(
      ({ hand, at }) => {
        const c = (
          globalThis as unknown as {
            __emulatedXR: {
              device: {
                controllers: Record<
                  string,
                  { position: { set: (x: number, y: number, z: number) => void } }
                >
              }
            }
          }
        ).__emulatedXR.device.controllers[hand]
        c?.position.set(at[0] as number, at[1] as number, at[2] as number)
      },
      { hand, at: [0, 1, 2].map((k) => (from[k] as number) + (d[k] as number) * f) },
    )
    await page.waitForTimeout(60)
  }
}

/** Set a controller button, as a finger does, and let two frames see it. */
const button = async (page: Page, hand: Hand, id: string, value: number): Promise<void> => {
  await page.evaluate(
    ({ hand, id, value }) => {
      const c = (
        globalThis as unknown as {
          __emulatedXR: {
            device: {
              controllers: Record<string, { updateButtonValue: (id: string, v: number) => void }>
            }
          }
        }
      ).__emulatedXR.device.controllers[hand]
      c?.updateButtonValue(id, value)
    },
    { hand, id, value },
  )
  await page.waitForTimeout(160)
}
const press = async (page: Page, hand: Hand, id: string): Promise<void> => {
  await button(page, hand, id, 1)
  await button(page, hand, id, 0)
}

/** Turn the emulated head: yaw, then pitch (negative is down). */
const lookAt = async (page: Page, yawDeg: number, pitchDeg: number): Promise<void> => {
  await page.evaluate(
    ({ yawDeg, pitchDeg }) => {
      const r = Math.PI / 360
      const cy = Math.cos(yawDeg * r)
      const sy = Math.sin(yawDeg * r)
      const cx = Math.cos(pitchDeg * r)
      const sx = Math.sin(pitchDeg * r)
      ;(
        globalThis as unknown as {
          __emulatedXR: {
            device: { quaternion: { set: (x: number, y: number, z: number, w: number) => void } }
          }
        }
      ).__emulatedXR.device.quaternion.set(cy * sx, sy * cx, -sy * sx, cy * cx)
    },
    { yawDeg, pitchDeg },
  )
  await page.waitForTimeout(200)
}

const deg = (r: number): number => (r * 180) / Math.PI
/** A direction's yaw (+ is LEFT of −z) and pitch, degrees. */
const yawPitch = (d: V3): { yaw: number; pitch: number } => ({
  yaw: deg(Math.atan2(-d[0], -d[2])),
  pitch: deg(Math.asin(Math.max(-1, Math.min(1, d[1] / Math.hypot(d[0], d[1], d[2]))))),
})

/**
 * Aim `hand` at a WORLD point by measurement: read the ray the bench saw, turn
 * by the angle between it and the one wanted, repeat until within 0.05°.
 */
const aimAt = async (page: Page, hand: Hand, target: V3): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250)
    const ray = (await probe(page)).rays[hand]
    expect(ray, `the bench reads the ${hand} hand`).not.toBeNull()
    const o = (ray as { origin: V3 }).origin
    const want = yawPitch([target[0] - o[0], target[1] - o[1], target[2] - o[2]])
    const have = yawPitch((ray as { direction: V3 }).direction)
    let dy = want.yaw - have.yaw
    if (dy > 180) dy -= 360
    if (dy < -180) dy += 360
    const dp = want.pitch - have.pitch
    if (Math.abs(dy) < 0.05 && Math.abs(dp) < 0.05) return
    await turn(page, hand, turned[hand].yaw + dy, turned[hand].pitch + dp)
  }
}

/** A bench-frame point (metres on the table) in the WORLD, through the axes the bench reports. */
const benchToWorld = (p: Probe, b: V3): V3 => {
  const [o, ex, ey, ez] = p.axes as V3[]
  return [0, 1, 2].map(
    (k) =>
      ((o as V3)[k] as number) +
      ((ex as V3)[k] as number) * b[0] +
      ((ey as V3)[k] as number) * b[1] +
      ((ez as V3)[k] as number) * b[2],
  ) as V3
}
/** A level-frame point onto the table, through the island's own frame (the bench's mapping). */
const levelToBench = (p: Probe, w: V3): V3 => {
  const f = p.frame as NonNullable<Probe['frame']>
  return [
    (w[0] - f.centreX) * f.scale,
    (w[1] - f.seaY) * f.scale * f.relief,
    (w[2] - f.centreZ) * f.scale,
  ]
}
/** A world displacement onto the bench's axes. */
const ontoBench = (p: Probe, w: V3): V3 => {
  const [, ex, ey, ez] = p.axes as V3[]
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return [dot(w, ex as V3), dot(w, ey as V3), dot(w, ez as V3)]
}

test.describe('@gpu the VR bench', () => {
  test.setTimeout(600_000)

  test('the door, three points by trigger, a grab that moves one, undo, FLY and back', async ({
    page,
  }, testInfo) => {
    const logs: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (/bench|editor:|error/i.test(t)) logs.push(`[${m.type()}] ${t}`)
    })
    await installEmulatedXr(page, { fovyDeg: 90 })
    await page.goto(`/?title=0&${PINNED}`)
    await loadSettled(page, 240_000)
    expect(await emulatedXrInstalled(page), 'the emulated runtime took').toBe(true)
    await enterVr(page)
    await expect.poll(() => presenting(page), { timeout: 60_000 }).toBe(true)

    // ── DEV-558: the room opens on its doors; the beam takes SINGLE PLAYER ──
    //
    // The bench's door stands on the aircraft step, and in a headset the first
    // step is taken as every table is: the controller's ray, and the trigger.
    const roomView = (): Promise<string | null> =>
      page.evaluate(
        () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.view ?? null,
      )
    const onSingle = (): Promise<boolean> =>
      page.evaluate(() => {
        const aim = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()?.aim
        return aim?.kind === 'door' && aim.door?.id === 'single-player'
      })
    await expect.poll(roomView, { timeout: 60_000 }).toBe('doors')
    await turn(page, 'left', 0, 60)
    let single = false
    // DEV-565: to 75 either side; four doors put SINGLE PLAYER 45 left of the
    // head, and wider than that from the right hand, which sits right of it.
    for (const yaw of [0, 10, -10, 20, -20, 30, -30, 40, -40, 50, -50, 60, -60, 70, -70, 75, -75]) {
      for (let pitch = -5; pitch >= -50 && !single; pitch -= 2.5) {
        await turn(page, 'right', yaw, pitch)
        single = await onSingle()
      }
      if (single) break
    }
    expect(single, 'the right controller reached SINGLE PLAYER').toBe(true)
    await press(page, 'right', 'trigger')
    await expect.poll(roomView, { timeout: 10_000 }).toBe('vehicles')

    // ── the door: at the lap, in a headset ──────────────────────────────
    await expect
      .poll(async () => (await benchState(page))?.door.up ?? false, {
        message: 'EDIT ON THE BENCH stands in the room, in a headset',
        timeout: 60_000,
      })
      .toBe(true)
    await turn(page, 'left', 0, 60) // the other hand up, out of the way
    let onDoor = false
    for (const yaw of [0, 5, -5, 10, -10, 15, -15, 20, -20, 25, -25]) {
      for (let pitch = -20; pitch >= -80 && !onDoor; pitch -= 2.5) {
        await turn(page, 'right', yaw, pitch)
        onDoor = (await benchState(page))?.door.aimed ?? false
      }
      if (onDoor) break
    }
    expect(onDoor, 'the right controller reached the door').toBe(true)
    await press(page, 'right', 'trigger')
    await expect
      .poll(async () => (await benchState(page))?.probe?.ready ?? false, {
        message: 'the bench opens and sets out its island',
        timeout: 60_000,
      })
      .toBe(true)
    // The door is where the bench stands: put by while it is open (the first
    // photograph caught it standing inside the island).
    await expect.poll(async () => (await benchState(page))?.door.up).toBe(false)
    const opened = await probe(page)
    console.info(
      `DEV-492 bench: ${opened.island}, slot ${opened.slot}, ${opened.points.length} points, ` +
        `ground ${opened.ground}, place height ${opened.placeHeight} m`,
    )
    // DEV-799: a course over Simonet stands on the mission's waterline, not on
    // the seabed 35 m under it: the island's frame zero is the sea (about 95 m
    // in sim space on this map), and the pad, 20 m or more over it, is above it.
    expect(opened.island, 'the premise: the default sky is Simonet').toBe('simonet')
    const bedrock = opened.frame as NonNullable<Probe['frame']>
    expect(bedrock.seaY, 'the island is zeroed at the sea, not the seabed').toBeGreaterThan(50)
    // A fresh browser: the draft is new, its one point the pad's (DEV-501), so
    // the three below are ours, at 1..3.
    expect(opened.points.length).toBe(1)

    // ── three points by trigger, at −x, the middle and +x of the table ───
    await lookAt(page, 0, -35)
    const targets: V3[] = [
      [-0.35, 0, -0.3],
      [0.0, 0, -0.5],
      [0.35, 0, -0.3],
    ]
    const hits: V3[] = []
    for (const [i, b] of targets.entries()) {
      const p = await probe(page)
      await aimAt(page, 'right', benchToWorld(p, b))
      await expect
        .poll(async () => (await probe(page)).aimed.right, { timeout: 5_000 })
        .toBe('ground')
      const hit = (await probe(page)).hits.right as V3
      hits.push(hit)
      await press(page, 'right', 'trigger')
      await expect.poll(async () => (await probe(page)).points.length).toBe(i + 2)
    }
    const placed = await probe(page)
    for (const [i, p] of placed.points.slice(1).entries()) {
      const hit = hits[i] as V3
      // Where the ray met the island (1 mm of table is 2 m of world).
      expect(
        Math.hypot(p[0] - hit[0], p[2] - hit[2]),
        `point ${i} is where the ray landed`,
      ).toBeLessThan(6)
      // At the placement height over the ground the bench judges against.
      const g = placed.groundUnder[i + 1]
      expect(g, `point ${i} has ground under it`).not.toBeNull()
      expect(p[1] - (g as number)).toBeCloseTo(placed.placeHeight, 1)
    }
    // The asymmetric check: the table's −x is the island's −x, and its far
    // side (−z) is the island's −z.
    const [, west, north, east] = placed.points as [V3, V3, V3, V3]
    expect(west[0], 'bench −x is level −x').toBeLessThan(east[0] - 300)
    expect(north[2], 'bench −z is level −z').toBeLessThan(west[2] - 200)
    await page.screenshot({
      path: shotPath('bench-three-points.png', testInfo.outputPath('bench-three-points.png')),
    })

    // ── grab the middle point and move it with the hand ──────────────────
    const mid = placed.points[2] as V3
    const before = await probe(page)
    // Aim at the handle where the bench draws it, and grip: the ray takes it.
    await aimAt(page, 'right', benchToWorld(before, levelToBench(before, mid)))
    await expect
      .poll(async () => (await probe(page)).aimed.right, { timeout: 5_000 })
      .toBe('point:2')
    const handBefore = (await probe(page)).rays.right?.origin as V3
    await button(page, 'right', 'squeeze', 1)
    await expect.poll(async () => (await probe(page)).held.right).toBe('2')
    const move: V3 = [0.06, 0.04, -0.05]
    await shift(page, 'right', move)
    await page.waitForTimeout(700) // the pose smoother settles (`createPoseSmoother`)
    const during = await probe(page)
    const handAfter = during.rays.right?.origin as V3
    await button(page, 'right', 'squeeze', 0)
    await expect.poll(async () => (await probe(page)).held.right).toBe(null)
    const after = await probe(page)
    const moved = after.points[2] as V3
    const f = after.frame as { scale: number; relief: number }
    const handBench = ontoBench(after, [
      handAfter[0] - handBefore[0],
      handAfter[1] - handBefore[1],
      handAfter[2] - handBefore[2],
    ])
    const expected: V3 = [
      mid[0] + handBench[0] / f.scale,
      mid[1] + handBench[1] / (f.scale * f.relief),
      mid[2] + handBench[2] / f.scale,
    ]
    console.info(
      `DEV-492 drag: hand ${handBench.map((x) => x.toFixed(3)).join(', ')} m on the table → ` +
        `point ${[0, 1, 2].map((k) => ((moved[k] as number) - (mid[k] as number)).toFixed(1)).join(', ')} m`,
    )
    for (const k of [0, 1, 2]) {
      expect(
        Math.abs((moved[k] as number) - (expected[k] as number)),
        `axis ${k}: the point moved as the hand did, ×${1 / f.scale}`,
      ).toBeLessThan(2)
    }
    // And it moved a real distance in every axis: tens of metres, not noise.
    expect(Math.abs(moved[0] - mid[0])).toBeGreaterThan(40)
    expect(Math.abs(moved[1] - mid[1])).toBeGreaterThan(20)
    expect(Math.abs(moved[2] - mid[2])).toBeGreaterThan(40)
    // The other two did not move.
    expect(after.points[1]).toEqual(placed.points[1])
    expect(after.points[3]).toEqual(placed.points[3])
    await page.screenshot({
      path: shotPath('bench-dragged.png', testInfo.outputPath('bench-dragged.png')),
    })

    // ── UNDO on the plate: the whole drag is one step ────────────────────
    await aimAt(page, 'right', after.cells.undo as V3)
    await expect.poll(async () => (await probe(page)).aimed.right).toBe('cell:undo')
    await press(page, 'right', 'trigger')
    await expect.poll(async () => (await probe(page)).points[2]).toEqual(mid)
    await aimAt(page, 'right', after.cells.redo as V3)
    await expect.poll(async () => (await probe(page)).aimed.right).toBe('cell:redo')
    await press(page, 'right', 'trigger')
    await expect.poll(async () => (await probe(page)).points[2]).toEqual(moved)

    // ── DEV-501: a grip on ring 1's point takes the PAD, and ring 1 follows ─
    {
      const was = await probe(page)
      const r0 = was.points[0] as V3
      await aimAt(page, 'right', benchToWorld(was, levelToBench(was, r0)))
      await expect
        .poll(async () => (await probe(page)).aimed.right, { timeout: 5_000 })
        .toBe('point:0')
      const h0 = (await probe(page)).rays.right?.origin as V3
      await button(page, 'right', 'squeeze', 1)
      await expect.poll(async () => (await probe(page)).held.right).toBe('pad')
      await shift(page, 'right', [0.05, 0, 0.04])
      await page.waitForTimeout(700)
      const h1 = (await probe(page)).rays.right?.origin as V3
      await button(page, 'right', 'squeeze', 0)
      await expect.poll(async () => (await probe(page)).held.right).toBe(null)
      const now = await probe(page)
      const r1 = now.points[0] as V3
      const fr = now.frame as { scale: number }
      const hb = ontoBench(now, [h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]])
      console.info(
        `DEV-501 bench: ring 1 moved ${(r1[0] - r0[0]).toFixed(1)}, ${(r1[2] - r0[2]).toFixed(1)} m with the pad`,
      )
      for (const k of [0, 2]) {
        expect(
          Math.abs((r1[k] as number) - (r0[k] as number) - (hb[k] as number) / fr.scale),
          `axis ${k}: ring 1 moved as the hand moved the pad`,
        ).toBeLessThan(2)
      }
      expect(Math.hypot(r1[0] - r0[0], r1[2] - r0[2]), 'a real move').toBeGreaterThan(40)
      expect(now.points.slice(1), 'the rest of the line stayed').toEqual(was.points.slice(1))
      // One step, undone on the plate: the moved pad would stand ring 1 in a hill.
      await aimAt(page, 'right', now.cells.undo as V3)
      await expect.poll(async () => (await probe(page)).aimed.right).toBe('cell:undo')
      await press(page, 'right', 'trigger')
      await expect.poll(async () => (await probe(page)).points[0]).toEqual(r0)
    }

    // ── the draft is kept where the desk keeps it ─────────────────────────
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.evaluate(
              (slot) => localStorage.getItem(`ff2.editor.draft.v1.${slot}`),
              after.slot as string,
            )) ?? 'null',
          )?.course?.path?.points?.length ?? 0,
        { message: "the draft autosaves to the desktop editor's storage" },
      )
      .toBe(4) // DEV-501: the pad's point and the three

    // ── every program linked, and the bench was drawn ────────────────────
    const sweep = await sweepPrograms(page)
    expect(sweep.calls, 'the room with the bench drew').toBeGreaterThan(0)
    expect(sweep.programs, 'programs exist to be checked').toBeGreaterThan(0)
    expect(
      sweep.failed.map((x) => `#${x.id} ${x.type}`),
      'every program linked',
    ).toEqual([])

    // ── FLY, and back to the bench ───────────────────────────────────────
    // Every editor spec's course is flyable (DEV-478): LIFT on the plate, as a
    // person presses it, when anything is in or near the ground.
    let ready = await probe(page)
    if (ready.warnings.some((w) => /ground/.test(w.kind))) {
      await aimAt(page, 'right', ready.cells.lift as V3)
      await expect.poll(async () => (await probe(page)).aimed.right).toBe('cell:lift')
      await press(page, 'right', 'trigger')
      await expect.poll(async () => (await probe(page)).undo).toBe(ready.undo + 1)
      ready = await probe(page)
      console.info(`DEV-492 LIFT: ${ready.points.map((p) => p[1].toFixed(0)).join(', ')} m`)
    }
    const errors = ready.warnings.filter((w) => w.severity === 'error')
    expect(errors, 'the course has nothing to fix before it flies').toEqual([])
    expect(
      ready.warnings.filter((w) => /ground/.test(w.kind)),
      'nothing in or near the ground',
    ).toEqual([])
    await aimAt(page, 'right', ready.cells.fly as V3)
    await expect.poll(async () => (await probe(page)).aimed.right).toBe('cell:fly')
    await press(page, 'right', 'trigger')
    await expect
      .poll(async () => (await benchState(page))?.flying ?? false, { timeout: 30_000 })
      .toBe(true)
    await expect(page.locator('body')).toHaveAttribute('data-editor', 'flying', { timeout: 30_000 })
    await switchGone(page, 240_000)
    await page.waitForTimeout(3_000)
    await page.screenshot({
      path: shotPath('bench-flying.png', testInfo.outputPath('bench-flying.png')),
    })
    // Pause, then the bottom row: Back to editor stands where EXIT does.
    await hold(page, 'Backspace')
    for (let i = 0; i < 10; i++) await hold(page, 'ArrowDown', 120)
    await hold(page, 'Enter', 300)
    await expect
      .poll(async () => (await benchState(page))?.probe?.up ?? false, {
        message: 'back in the room with the bench open',
        timeout: 60_000,
      })
      .toBe(true)
    const back = await probe(page)
    // The draft as it was flown: the same points (lifted, if LIFT was pressed).
    expect(back.points).toEqual(ready.points)
    expect(back.slot).toBe(after.slot)
    // Now the world behind the room IS the draft's island: the render surface.
    expect(back.ground).toBe('render')
    await lookAt(page, 0, -35)
    await page.screenshot({
      path: shotPath('bench-back.png', testInfo.outputPath('bench-back.png')),
    })
    console.info(`DEV-492 console:\n  ${logs.slice(-12).join('\n  ')}`)
  })
})
