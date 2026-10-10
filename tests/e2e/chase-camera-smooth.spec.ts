/**
 * tests/e2e/chase-camera-smooth.spec.ts — a camera that follows the ship
 * follows the ship that is DRAWN (DEV-319).
 *
 * ── The bug ──────────────────────────────────────────────────────────────
 *
 * Matt, 2026-09-23, watching a Playwright flight under
 * `?view=chase&chase=player`: *"our player ship appears to jitter."* The sim
 * steps at 82 Hz and the screen runs at 180, so `flight.render` draws the hull
 * at a pose INTERPOLATED between the last two steps (D4). `chaseCamera` placed
 * the camera off `flight.jet.body` — the raw step — instead. The camera held
 * the body and the hull glided up to 1.6 m past it at the step phase, which is
 * the shake. Nothing in the tree measured it: every camera spec here samples a
 * DISTANCE a second apart, and a distance a second apart is the same number
 * with the bug and without it.
 *
 * ── The measurement ──────────────────────────────────────────────────────
 *
 * 240 consecutive frames read inside the page's own `requestAnimationFrame`,
 * all three positions at one instant: the body (z flipped into three space),
 * the hull (`flight.object`, where the render put it) and the camera's WORLD
 * position (its `matrixWorld`, so a camera inside the rig reads the same as
 * one at the scene root). What is judged is **how the hull moves in the
 * CAMERA's frame from one frame to the next** — the thing an eye sees as
 * shake — in metres, and as a change of velocity. A camera tied to the drawn
 * hull holds it nearly still or lets it drift smoothly; one tied to the body
 * moves it by the interpolation offset every frame.
 *
 * ── The premise, checked rather than trusted ────────────────────────────
 *
 * The bug is invisible in a sample where the hull always sits on the body —
 * a ship at rest, or a frame rate that locks to the step so the interpolation
 * factor never moves. So each arm first asserts the ship is flying and that
 * the hull-to-body offset actually VARIES across the sample. Without that, a
 * green here would be a sample that could not separate anything (trap 23).
 *
 * ── What each arm measured, both ways (2026-09-23, 180 Hz, 5.6 ms frames) ─
 *
 * The negatives were taken by pointing each camera at the body for one run
 * and putting it back — not by reasoning about what a body read would do:
 *
 *   camera                      hull shake p95    lurch p95
 *                               fixed    body     fixed    body
 *   ?view=chase&chase=player    0.008    0.93 m   0.012    309 m/s
 *   ?camera=third (spring arm)  0.007    0.44 m   0.25     133 m/s
 *   ?camera=third, Classic      0.025    0.067 m  0.33     22 m/s
 *
 * Classic is the case that decided the metric. 2016's SmoothDamp filters a
 * body read down to 2.7x in metres, which no bound separates safely; in m/s
 * it is 66x. The lagged cameras' fixed floor is not noise either: D4's
 * interpolation is linear between steps, so the drawn hull's velocity kinks by
 * its acceleration times one step (~0.3 m/s at the autopilot's turn) and a
 * lagged camera sees the kink. `LURCH_LIMIT` sits between the floor and
 * Classic's body read, about 9x from the first and 7x from the second.
 *
 * ── Same build, same code path ───────────────────────────────────────────
 *
 * The URLs are the game's own switches (`?view=chase`, `?camera=third`, the
 * autopilot, the tier pin); the probe only reads. `@gpu`: it flies.
 */

import { bootReady, missionReady, switchSettled } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { PINNED } from './fixtures/quality-pin'
import { type Crowd, loadLevel, startCrowd } from './fixtures/room-crowd'
import { startRoomSidecar } from './fixtures/room-sidecar'
import { expect, type Page, test } from './fixtures/test'
import { titleRowsUp } from './fixtures/title'
import { tvOfRoom, tvProbe } from './fixtures/tv'

type Vec = [number, number, number]

/** m/s of change in the hull's velocity in view, frame to frame. The header has the table. */
const LURCH_LIMIT = 3

interface Frame {
  /** The frame's `requestAnimationFrame` timestamp — the game's own clock for it, ms. */
  t: number
  /** The body, the drawn hull and the camera's world position, three space. */
  body: Vec
  hull: Vec
  camera: Vec
  /** The hull in the camera's own frame — what the eye sees move. */
  hullInView: Vec
  speed: number
}

/** One frame of the page, read at one instant, `frames` times in a row. */
const sampleFrames = async (page: Page, frames: number): Promise<Frame[]> =>
  (await page.evaluate(
    (count) =>
      new Promise<unknown[]>((resolve) => {
        const w = globalThis as unknown as Ff2Global
        const rows: unknown[] = []
        const tick = (t: number): void => {
          const f = w.__ff2.flight()
          if (f) {
            const b = f.jet.body.position
            const h = f.object.position
            const v = f.jet.body.velocity
            const m = w.__ff2.render.camera.matrixWorld.elements
            const at = (i: number): number => m[i] ?? 0
            const c = [at(12), at(13), at(14)]
            const d = [h.x - (c[0] ?? 0), h.y - (c[1] ?? 0), h.z - (c[2] ?? 0)]
            // A rigid camera: its local axes are the matrix's first three
            // columns, so the hull in its frame is those axes dotted with d.
            const local = [0, 4, 8].map(
              (k) => at(k) * (d[0] ?? 0) + at(k + 1) * (d[1] ?? 0) + at(k + 2) * (d[2] ?? 0),
            )
            rows.push({
              t,
              body: [b.x, b.y, -b.z],
              hull: [h.x, h.y, h.z],
              camera: c,
              hullInView: local,
              speed: Math.hypot(v.x, v.y, v.z),
            })
          }
          if (rows.length >= count) resolve(rows)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    frames,
  )) as Frame[]

const dist = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}

interface Verdict {
  frames: number
  minSpeed: number
  /** The premise: how much the drawn hull's offset from the body varies. */
  hullOffBodyRange: number
  /** Metres the hull moves in the camera's frame between frames. */
  hullShakeP50: number
  hullShakeP95: number
  hullShakeMax: number
  /**
   * How much the hull's VELOCITY in view changes from one frame to the next,
   * m/s. A lagged camera legitimately lets the hull drift in view, so the
   * metres above are not zero for it; a drift that is SMOOTH changes speed
   * slowly, and one tied to the step lurches at the step phase. Divided by the
   * frame's own timestamps, so a late frame — which moves everything further —
   * is not read as a lurch.
   */
  hullLurchP95: number
  hullLurchMax: number
  /** The frame intervals the sample saw, ms — so an odd verdict can be read against them. */
  frameMsP50: number
  frameMsMax: number
}

const judge = (rows: readonly Frame[]): Verdict => {
  const offsets = rows.map((r) => dist(r.hull, r.body))
  const view = rows.map((r) => r.hullInView)
  const shake = view.slice(1).map((p, i) => dist(p, view[i] as Vec))
  const frameMs = rows.slice(1).map((r, i) => r.t - (rows[i] as Frame).t)
  // m/s in view, per interval; frames with no time between them are skipped.
  const velocity = view.slice(1).flatMap((p, i) => {
    const seconds = (frameMs[i] ?? 0) / 1000
    const a = view[i] as Vec
    return seconds > 0
      ? [[(p[0] - a[0]) / seconds, (p[1] - a[1]) / seconds, (p[2] - a[2]) / seconds] as Vec]
      : []
  })
  const lurch = velocity.slice(1).map((v, i) => dist(v, velocity[i] as Vec))
  return {
    frames: rows.length,
    minSpeed: Math.min(...rows.map((r) => r.speed)),
    hullOffBodyRange: Math.max(...offsets) - Math.min(...offsets),
    hullShakeP50: quantile(shake, 0.5),
    hullShakeP95: quantile(shake, 0.95),
    hullShakeMax: Math.max(...shake),
    hullLurchP95: quantile(lurch, 0.95),
    hullLurchMax: Math.max(...lurch),
    frameMsP50: quantile(frameMs, 0.5),
    frameMsMax: Math.max(...frameMs),
  }
}

/** Boot a mission, launch, and wait until the autopilot is genuinely flying. */
const flyAndSample = async (page: Page, query: string): Promise<Verdict> => {
  await page.goto(
    `/?mission=rookie_01_hoverJet&xr=off&title=0&menu=0&autopilot=1&${PINNED}${query}`,
  )
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  // Held, not tapped — `pause.spec.ts` says why.
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
  // Out of the shaft and up to speed: the ride is over well before 8 s.
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.mission.elapsed), {
      timeout: 120_000,
      intervals: [500],
    })
    .toBeGreaterThan(8)
  const verdict = judge(await sampleFrames(page, 240))
  console.log(`chase-camera-smooth ${query}: ${JSON.stringify(verdict)}`)
  // The premise, before the claim.
  expect(verdict.frames).toBe(240)
  expect(verdict.minSpeed).toBeGreaterThan(30)
  expect(verdict.hullOffBodyRange).toBeGreaterThan(0.1)
  return verdict
}

test.describe('@gpu the chase cameras follow the DRAWN ship', () => {
  test.setTimeout(420_000)
  // In order, one worker: three browsers flying at once share the GPU and pace
  // each other's frames. `default`, not `serial`, so one red arm does not skip
  // the other two.
  test.describe.configure({ mode: 'default' })

  test('?view=chase&chase=player holds the hull still in the frame (DEV-319)', async ({ page }) => {
    const v = await flyAndSample(page, '&view=chase&chase=player')
    // Rigid to the hull's heading, so the hull barely moves in view.
    expect(v.hullShakeP95).toBeLessThan(0.05)
    expect(v.hullShakeMax).toBeLessThan(0.15)
    expect(v.hullLurchP95).toBeLessThan(LURCH_LIMIT)
  })

  // The two cameras a PLAYER sees. Both already read `flight.object`; these
  // arms are what keeps them reading it.
  test('?camera=third, anniversary: the spring arm', async ({ page }) => {
    const v = await flyAndSample(page, '&camera=third')
    expect(v.hullLurchP95).toBeLessThan(LURCH_LIMIT)
  })

  test('?camera=third, classic: 2016’s own chase', async ({ page }) => {
    const v = await flyAndSample(page, '&camera=third&edition=classic')
    expect(v.hullLurchP95).toBeLessThan(LURCH_LIMIT)
  })
})

// ── DEV-612: Faceted Flight TV's camera, over the craft TV shows ─────────
//
// Matt, 2026-10-03, watching the TV specs: *"the hoverjet that's being chases
// is juddery."* TV's camera (`game/tv/tv-camera.ts`, through
// `boot/tv-watch-camera.ts`) reads the craft's DRAWN Object3Ds, as DEV-319 left
// every camera reading them. What it read them BEFORE, on the base: the
// exhibition's racers are placed by `liveRacers.render(alpha)` and a room's
// ships by `roomShips.update`, both further down the frame than TV's camera, so
// the camera sat on the pose the PREVIOUS frame drew while the hull was drawn
// at this frame's. The hull then leads the camera by one frame's travel, which
// changes with every frame's length: a judder whenever the frames are uneven.
//
// The same measurement as above, on the craft the camera FOLLOWS (its
// `following`, off the rig's `tvCamera` report), with no sim body to compare
// against: the premise is instead that the craft is flying and the frames are
// uneven enough for a one-frame lag to show (`travelRange`, the spread of the
// hull's own per-frame travel in metres). Measured 2026-10-03, 180 Hz, pinned,
// the base placing the craft after the cameras (its two runs: the first and
// the retry), the fix before them:
//
//   arm                    lurch p95, base      fixed       shake p95, base   fixed
//   exhibition, Follow     87 / 42 m/s          4e-11 m/s   0.054 / 0.098 m   1e-13 m
//   watched room, Follow   198 / 173 m/s        4e-11 m/s   0.64 / 0.74 m     1e-13 m
//
// Fixed, a craft flying straight sits still in view to float noise: the camera
// is built from the very pose the frame draws.

interface TvFrame {
  t: number
  hull: Vec
  camera: Vec
  hullInView: Vec
  following: string | null
  mode: string | null
}

/** `frames` consecutive frames of TV's camera and the hull it follows, read at one instant each. */
const sampleTvFrames = async (page: Page, frames: number): Promise<TvFrame[]> =>
  (await page.evaluate(
    (count) =>
      new Promise<unknown[]>((resolve, reject) => {
        interface Obj {
          position: { x: number; y: number; z: number }
          visible: boolean
        }
        const w = globalThis as unknown as Ff2Global
        const ff = w.__ff2
        // The hull is looked up when the name changes, not every frame: a
        // scene-wide search per frame would cost the frames it measures.
        let name: string | null = null
        let hull: Obj | null = null
        const resolveHull = (n: string): Obj | null => {
          // DEV-651: the camera reports the racer's CALLSIGN, while its node
          // keeps the tuning id (`racer:<spec.id>`), so go through the spec.
          const id = ff.racers()?.racers.find((r) => r.spec.callsign === n)?.spec.id ?? n
          const racer = ff.render.scene.getObjectByName(`racer:${id}`)
          if (racer) return racer
          const ship = ff.watch()?.ships.find((s) => s.handle === n && s.visible)
          if (!ship) return null
          return (
            ff.render.scene.getObjectByName(
              ship.bot === null ? `room-ship:${ship.slot}` : `room-bot:${ship.bot}`,
            ) ?? null
          )
        }
        const rows: unknown[] = []
        let blind = 0
        const tick = (t: number): void => {
          const cam = ff.render.rig.userData.tvCamera ?? null
          const following = cam?.following ?? null
          if (following !== name) {
            name = following
            hull = following === null ? null : resolveHull(following)
          }
          if (hull) {
            const h = hull.position
            const m = ff.render.camera.matrixWorld.elements
            const at = (i: number): number => m[i] ?? 0
            const c = [at(12), at(13), at(14)]
            const d = [h.x - (c[0] ?? 0), h.y - (c[1] ?? 0), h.z - (c[2] ?? 0)]
            const local = [0, 4, 8].map(
              (k) => at(k) * (d[0] ?? 0) + at(k + 1) * (d[1] ?? 0) + at(k + 2) * (d[2] ?? 0),
            )
            rows.push({
              t,
              hull: [h.x, h.y, h.z],
              camera: c,
              hullInView: local,
              following,
              // DEV-618: the Director's framing beside its mode, `director:side`.
              mode: cam ? (cam.framing ? `${cam.mode}:${cam.framing}` : cam.mode) : null,
            })
          } else if (++blind > 600) {
            // A followed craft whose node is not found would otherwise hang
            // the evaluate until the test timeout: fail with the name instead.
            reject(new Error(`no drawn hull for the followed craft '${String(name)}'`))
            return
          }
          if (rows.length >= count) resolve(rows)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    frames,
  )) as TvFrame[]

interface TvVerdict extends Verdict {
  /** The spread of the hull's own per-frame travel, m: zero would hide a one-frame lag. */
  travelRange: number
  following: string[]
  modes: string[]
}

const judgeTv = (rows: readonly TvFrame[]): TvVerdict => {
  // `judge` over the same rows, with the hull as its own "body": the offset
  // premise is replaced by `travelRange` below.
  const base = judge(rows.map((r) => ({ ...r, body: r.hull, speed: Number.POSITIVE_INFINITY })))
  const travel = rows.slice(1).map((r, i) => dist(r.hull, (rows[i] as TvFrame).hull))
  const speeds = rows.slice(1).flatMap((r, i) => {
    const seconds = (r.t - (rows[i] as TvFrame).t) / 1000
    return seconds > 0 ? [(travel[i] ?? 0) / seconds] : []
  })
  return {
    ...base,
    minSpeed: Math.min(...speeds),
    hullOffBodyRange: 0,
    travelRange: Math.max(...travel) - Math.min(...travel),
    following: [...new Set(rows.map((r) => r.following ?? ''))],
    modes: [...new Set(rows.map((r) => r.mode ?? ''))],
  }
}

/** Sample, log, and check the premise: one craft, followed, flying, on uneven frames. */
const sampleTv = async (page: Page, label: string, want = 'follow'): Promise<TvVerdict> => {
  const v = judgeTv(await sampleTvFrames(page, 240))
  console.log(`chase-camera-smooth ${label}: ${JSON.stringify(v)}`)
  expect(v.frames).toBe(240)
  expect(v.modes).toEqual([want])
  expect(v.following, 'one craft, followed the whole sample').toHaveLength(1)
  expect(v.minSpeed).toBeGreaterThan(30)
  expect(v.travelRange, 'frames uneven enough for a one-frame lag to show').toBeGreaterThan(0.1)
  return v
}

/**
 * TV's Follow, held to the bar the lagged DEV-319 arms are held to: its heading
 * settles (`chaseSettlePerSecond`), so the hull may drift in view, smoothly.
 */
const expectTvSmooth = (v: TvVerdict): void => {
  expect(v.hullLurchP95).toBeLessThan(LURCH_LIMIT)
}

test.describe('@gpu TV’s camera follows the DRAWN craft (DEV-612)', () => {
  test.setTimeout(480_000)
  test.describe.configure({ mode: 'default' })

  test('TV Follow over the exhibition’s AI racers', async ({ page }) => {
    // The title the way a player reaches it, then the exhibition's own entry
    // (`__ff2.exhibition.start` calls the `startExhibition` TV's door calls).
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await titleRowsUp(page)
    const probe = (): Promise<{ phase: string; raceSeconds: number }> =>
      page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.exhibition.probe())
    await page.evaluate(() =>
      (globalThis as unknown as Ff2Global).__ff2.exhibition.start({ course: 'rookie_01_hoverJet' }),
    )
    await expect.poll(async () => (await probe()).phase, { timeout: 240_000 }).toBe('racing')
    await expect
      .poll(async () => (await probe()).raceSeconds, { timeout: 60_000 })
      .toBeGreaterThan(10)
    // → is Follow, on the racer after the Director's subject: a player's key.
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as Ff2Global).__ff2.render.rig.userData.tvCamera?.mode ?? null,
        ),
      )
      .toBe('follow')
    await page.waitForTimeout(1500)
    expectTvSmooth(await sampleTv(page, 'tv follow, exhibition'))
  })

  test('TV Follow over a watched room’s racers', async ({ page }) => {
    const PROXY = process.env.FF2_API_PROXY ?? ''
    test.skip(
      !PROXY,
      'set FF2_API_PROXY=http://127.0.0.1:<port> so Vite forwards /api to the room sidecar',
    )
    const sidecar = await startRoomSidecar(Number(new URL(PROXY).port))
    let crowd: Crowd | null = null
    try {
      const answer = await fetch(`${PROXY}/api/room-sidecar`).then((r) => r.text())
      expect(answer, 'a stale sidecar is answering on this port').toBe(sidecar.nonce)
      const roomId = `tvs${Date.now().toString(32)}abcdefghijklm`
        .slice(0, 16)
        .replace(/[^a-z2-7]/g, 'a')
      crowd = await startCrowd({
        url: `${PROXY.replace(/^http/, 'ws')}/api/room/${roomId}`,
        level: loadLevel('int_01_hoverJet'),
        count: 2,
        players: 2,
      })
      const racing = crowd
      await expect.poll(() => racing.goAt(), { timeout: 60_000 }).not.toBeNull()
      const tv = await tvOfRoom(PROXY, roomId)
      // A WATCH ME link (`/tv/<id>?follow=1`), opened the way a player opens one.
      await page.goto(`/?tv=${tv}&follow=1&xr=off&${PINNED}`)
      await bootReady(page, 240_000)
      await firstPress(page)
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await switchSettled(page, 180_000)
      await expect
        .poll(
          async () => {
            const t = await tvProbe(page)
            return t ? `${t.mode} ${t.camera} ${t.following}` : null
          },
          { timeout: 120_000 },
        )
        .toBe('live follow Racer 1')
      await page.waitForTimeout(3000)
      expectTvSmooth(await sampleTv(page, 'tv follow, watched room'))
    } finally {
      crowd?.stop()
      await sidecar.close()
    }
  })

  // DEV-618: the Director's framings that MOVE with their racer (side, aerial,
  // pair) are held to the same bar. The fixed ones (trackside, flyby) stand
  // still and pan, so they have no eye of their own to judder.
  test('the Director’s moving framings over the exhibition (DEV-618)', async ({ page }) => {
    await page.goto(`/?xr=off&${PINNED}`)
    await bootReady(page, 240_000)
    await firstPress(page)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await titleRowsUp(page)
    await page.evaluate(() =>
      (globalThis as unknown as Ff2Global).__ff2.exhibition.start({ course: 'rookie_01_hoverJet' }),
    )
    const framing = (): Promise<string | null> =>
      page.evaluate(
        () =>
          (globalThis as unknown as Ff2Global).__ff2.render.rig.userData.tvCamera?.framing ?? null,
      )
    // Whichever of them the Director cuts to next, caught at its start so the
    // sample (about 1.3 s) fits inside its hold; a sample a cut lands inside
    // is thrown away. The race decides the order (a pair needs two racers
    // near each other), so the loop takes them as they come.
    const want = new Set(['side', 'aerial', 'pair'])
    const measured = new Map<string, TvVerdict>()
    const until = Date.now() + 360_000
    let was = await framing()
    while (measured.size < want.size && Date.now() < until) {
      const now = await framing()
      if (now !== was && now !== null && want.has(now) && !measured.has(now)) {
        const got = judgeTv(await sampleTvFrames(page, 240))
        if (got.modes.length === 1 && got.following.length === 1) measured.set(now, got)
        else console.log(`chase-camera-smooth director:${now}: a cut inside the sample`)
      }
      was = now
      await page.waitForTimeout(50)
    }
    expect([...measured.keys()].sort(), 'a whole sample of each moving framing').toEqual(
      [...want].sort(),
    )
    for (const [name, verdict] of measured) {
      console.log(`chase-camera-smooth tv director:${name}: ${JSON.stringify(verdict)}`)
      expect(verdict.modes).toEqual([`director:${name}`])
      expect(verdict.minSpeed).toBeGreaterThan(30)
      expectTvSmooth(verdict)
    }
  })
})
