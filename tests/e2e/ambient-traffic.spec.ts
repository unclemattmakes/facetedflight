/**
 * tests/e2e/ambient-traffic.spec.ts — DEV-146, in the real build.
 *
 * The unit tests hold the sim: seeded on the line, facing along it, two
 * populations that cannot leak into each other. What no unit test can see is
 * the WIRING and the COST, which is where every real finding in this port has
 * come from:
 *
 *   · the ships are there on a JumpSeat mission — the mission whose mode has
 *     NO opponents, which is the whole point of the feature and also the
 *     reason nothing else would have loaded a racer there;
 *   · they are NOT opponents: `data-opponents` stays 0, the results panel has
 *     no rows for them, and `__ff2.racers()` is null;
 *   · Classic draws none;
 *   · WHAT THEY COST, as an exact `renderer.info` delta taken by hiding the
 *     group on the frame that is already being drawn — `render-census.spec.ts`
 *     paid for that lesson: a delta between two flights measures the flights.
 *     The visible reading is taken twice, either side of the hidden one, so a
 *     drifting scene shows up as the two disagreeing rather than as a number;
 *   · and WHERE they are, in metres from the player, because a feature nobody
 *     can see has been rendered rather than shipped (DEV-044).
 *
 * `@gpu`, hydrated assets.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import type { Ff2Global } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { expect, type Page, test } from './fixtures/test'

/**
 * Where the close-pass frames go. NOT `test-results/` by default: Playwright
 * wipes that at the start of every run, so a frame kept to compare against a
 * later one is gone before anyone looks at it.
 */
const SHOT_DIR = process.env.TRAFFIC_SHOT_DIR ?? 'test-results/traffic'

interface Probe {
  elapsed: number
  edition: string
  traffic: number
  trafficMission: string | null
  opponents: number | null
  racers: number | null
  /** Metres from the player's ship to each traffic ship, nearest first. */
  distances: number[]
  /** Per ship, in racer order: how it is getting on. */
  ships: {
    id: string
    speed: number
    /** Raw arc length along the donor's line. Resets when a lap is recycled. */
    s: number
    /** Metres off the authored line, from its own cursor. */
    offset: number
    crashes: number
    gates: number
    finished: boolean
    /** Metres from the player. */
    distance: number
    /**
     * Where it is on the canvas, in device-independent pixels, or null when it
     * is behind the eye or outside the frustum — and how many pixels across the
     * hull is at that range.
     */
    screen: { x: number; y: number; px: number } | null
  }[]
  recycled: number
}

/**
 * The HoverJet hull's width, metres, for the on-screen size.
 *
 * `HOVERJET.shipCollisionColliders` puts it at 5.5-6 m and the preset note
 * rounds it to 6. Hard-coded HERE rather than imported because this file cannot
 * reach the constants sheet from inside `page.evaluate`, and because it is
 * being used for an order-of-magnitude "is it more than four pixels", not for
 * anything the sim reads.
 */
const HULL_METRES = 6

const probe = async (page: Page): Promise<Probe> =>
  (await page.evaluate((hull) => {
    const w = globalThis as unknown as Ff2Global
    const t = w.__ff2.traffic()
    const ship = w.__ff2.flight()?.jet.body.position ?? { x: 0, y: 0, z: 0 }
    const distances = (t?.racers ?? [])
      .map((r) => {
        const p = r.jet.body.position
        return Math.hypot(p.x - ship.x, p.y - ship.y, p.z - ship.z)
      })
      .sort((a, b) => a - b)
    // ── where a sim point lands on the canvas ─────────────────────────────
    //
    // Done by hand rather than with `Vector3.project`, because THREE is not on
    // `window` and a spec that imports it would be measuring a second copy of
    // the maths. The camera's own two matrices are the ones that drew the
    // frame. SIM space is THREE space mirrored in z, so the flip comes first.
    const cam = w.__ff2.render.camera
    const canvas = w.__ff2.render.renderer.domElement
    const apply = (m: number[], x: number, y: number, z: number) => ({
      x: (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
      y: (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
      z: (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
      w: (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number),
    })
    const onScreen = (sim: { x: number; y: number; z: number }, distance: number) => {
      const view = apply(cam.matrixWorldInverse.elements, sim.x, sim.y, -sim.z)
      const clip = apply(cam.projectionMatrix.elements, view.x, view.y, view.z)
      if (clip.w <= 0) return null
      const ndcX = clip.x / clip.w
      const ndcY = clip.y / clip.w
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null
      // Pixels across: the hull's angular size, in the same units the
      // projection gives. Two points a hull apart in x at the same depth
      // differ in NDC by `hull * P[0] / w`, and NDC spans the canvas width.
      const px =
        Math.abs(((hull * (cam.projectionMatrix.elements[0] as number)) / clip.w) * 0.5) *
        canvas.clientWidth
      return {
        x: ((ndcX + 1) / 2) * canvas.clientWidth,
        y: ((1 - ndcY) / 2) * canvas.clientHeight,
        px,
        distance,
      }
    }
    return {
      elapsed: w.__ff2.mission.elapsed,
      edition: w.__ff2.edition.current.id,
      traffic: t?.count ?? 0,
      trafficMission: t?.mission ?? null,
      opponents: Number(document.body.dataset.opponents ?? '0'),
      racers: w.__ff2.racers()?.count ?? null,
      distances,
      ships: (t?.racers ?? []).map((r) => {
        const v = r.jet.body.velocity
        const p = r.jet.body.position
        const distance = Math.hypot(p.x - ship.x, p.y - ship.y, p.z - ship.z)
        return {
          id: r.spec.id,
          speed: Math.hypot(v.x, v.y, v.z),
          s: r.cursor.s,
          offset: r.cursor.offset,
          crashes: r.crash.count,
          gates: r.gates,
          finished: r.finished,
          distance,
          screen: onScreen(p, distance),
        }
      }),
      recycled: t?.recycled ?? 0,
    }
  }, HULL_METRES)) as Probe

/** `renderer.info.render.calls` and triangles, sampled over `frames` frames, median. */
const census = async (page: Page, frames: number): Promise<{ calls: number; tris: number }> => {
  const samples = await page.evaluate(async (n) => {
    const w = globalThis as unknown as Ff2Global
    const calls: number[] = []
    const tris: number[] = []
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      calls.push(w.__ff2.render.renderer.info.render.calls)
      tris.push(w.__ff2.render.renderer.info.render.triangles)
    }
    return { calls, tris }
  }, frames)
  const mid = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
  return { calls: mid(samples.calls), tris: mid(samples.tris) }
}

const setTrafficVisible = (page: Page, visible: boolean): Promise<void> =>
  page.evaluate((v) => {
    const w = globalThis as unknown as Ff2Global
    const t = w.__ff2.traffic()
    if (t) t.group.visible = v
  }, visible)

/**
 * Into the MISSION, not onto the title screen.
 *
 * `title=0&menu=0` is `modes.spec.ts`'s own opening, and it matters here more
 * than anywhere: `liveTraffic.render()` is skipped while `screen === 'title'`,
 * so a spec that boots and waits measures a sim that is stepping and meshes
 * that are not moving. The first run of this file did exactly that and reported
 * the traffic group as 3 draw calls and ZERO triangles — the shape of three
 * ships frozen at their spawn and frustum-culled, which read as "they cost
 * nothing" rather than as "they are not being drawn".
 */
const boot = async (page: Page, edition: string): Promise<void> => {
  await page.goto(`/?xr=off&title=0&menu=0&edition=${edition}&mission=int_01_jumpSeat`)
  await firstPress(page)
  await missionReady(page, 240_000)
}

const atLeast = async (page: Page, seconds: number): Promise<void> => {
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as Ff2Global).__ff2.mission.elapsed), {
      timeout: 300_000,
      intervals: [500],
    })
    .toBeGreaterThan(seconds)
}

test.describe('@gpu ambient traffic — DEV-146', () => {
  test.setTimeout(600_000)

  test('Anniversary flies another mission’s ships over a JumpSeat course', async ({ page }) => {
    test.setTimeout(600_000)
    await boot(page, 'anniversary')
    await expect(page.locator('body')).toHaveAttribute('data-traffic', '3')
    // A ship that is not really flying — stalled, turned round, scraping a
    // ridge — separates from one that is over a minute. The samples are
    // printed rather than only asserted, because the numbers a headset pass
    // needs are "how close, how often" and no assertion can carry that.
    const say = (s: Probe) => {
      console.log(`t=${s.elapsed.toFixed(0)}s  nearest ${Math.min(...s.distances).toFixed(0)} m`)
      for (const ship of s.ships) {
        console.log(
          `    ${ship.id.padEnd(8)} ${ship.speed.toFixed(0).padStart(4)} m/s  at ${ship.s.toFixed(0).padStart(5)} m of 11268  off-line ${ship.offset.toFixed(0).padStart(4)} m  gates ${ship.gates}  crashes ${ship.crashes}${ship.finished ? '  FINISHED' : ''}`,
        )
      }
      console.log(
        `    distances from the player, m: ${s.distances.map((d) => d.toFixed(0)).join(', ')}  recycled ${s.recycled}`,
      )
    }

    await atLeast(page, 12)
    say(await probe(page))
    await atLeast(page, 40)
    say(await probe(page))
    await atLeast(page, 100)
    const before = await probe(page)
    say(before)
    // A SHORT window, so "it is going somewhere" is a delta rather than a
    // total: `cursor.s` is arc length along the donor's line and a recycle
    // puts it back to zero, so a total over ninety seconds measures how many
    // laps have been erased rather than how far anything flew.
    await atLeast(page, before.elapsed + 4)
    const p = await probe(page)
    say(p)

    expect(p.traffic).toBe(3)
    expect(p.trafficMission).toBe('int_01_hoverJet')

    // ── they are not opponents ──────────────────────────────────────────
    //
    // Target Practice races nobody (DEV-055), so this mission has no racers at
    // all — and it has traffic anyway. That pair of facts IS the feature.
    expect(p.opponents).toBe(0)
    expect(p.racers).toBeNull()

    // ── they are FLYING, not parked, and ON the line ────────────────────
    //
    // A minute and a half in, which is past the first recycles: every ship is
    // still moving, still near the line, and has not hit the island. 60 m is
    // well over twice the 2016 gate trigger radius (22.6 m); a ship that had
    // lost the line would be hundreds of metres out. The crash count is zero
    // because the traffic gets the same terrain avoidance and the same crash
    // rule the player does, and it has to fly 2016's own line without either
    // of them firing.
    p.ships.forEach((s, i) => {
      expect(s.speed, `${s.id} speed`).toBeGreaterThan(30)
      expect(s.offset, `${s.id} off-line`).toBeLessThan(60)
      expect(s.crashes, `${s.id} crashes`).toBe(0)
      // And it went SOMEWHERE over the last four seconds: 30 m/s is 120 m.
      // A recycle in the window is the other way for `s` to move, so it is
      // allowed for explicitly rather than by widening the bound.
      const advanced = s.s - (before.ships[i] as { s: number }).s
      const recycledInWindow = p.recycled > before.recycled
      expect(advanced > 100 || recycledInWindow, `${s.id} advanced ${advanced.toFixed(0)} m`).toBe(
        true,
      )
    })

    // ── the lap LOOPS ───────────────────────────────────────────────────
    //
    // The property that makes this ambient traffic rather than a flyby: a ship
    // that finishes is put back at the START of the line, so it flies the whole
    // circuit again and the sky does not empty. Nothing in the unit tests can
    // see this — it needs the real step, the real course and the real finish
    // gate. Four recycles in 100 s across three ships is roughly one lap each,
    // which is what an 11.3 km circuit at 90-170 m/s should give; the first
    // version of this feature put a ship back at its own PHASE instead and
    // scored fourteen, because each ship was trapped on the short arc between
    // its phase and the finish.
    expect(p.recycled).toBeGreaterThanOrEqual(1)
    expect(p.recycled).toBeLessThan(12)

    // ── and they are near enough to SEE ─────────────────────────────────
    //
    // The pairing was chosen on a median 452 m from this mission's anchors to
    // that route. This is the live version of the same question, and it is the
    // one that decides whether the feature exists for a player: a 6 m hull at
    // 3 km is under three pixels on a Quest 3 and has been rendered rather
    // than seen (DEV-044). The player has not moved off the spawn here, so this
    // is the WORST case of one anchor rather than a median over all of them.
    expect(Math.min(...p.distances)).toBeLessThan(3_000)
  })

  test('costs what it costs — an exact draw-call delta on one frame', async ({ page }) => {
    test.setTimeout(600_000)
    await boot(page, 'anniversary')
    await atLeast(page, 12)
    const p = await probe(page)
    const withA = await census(page, 40)
    await setTrafficVisible(page, false)
    const without = await census(page, 40)
    await setTrafficVisible(page, true)
    const withB = await census(page, 40)

    console.log(`DEV-146 frame cost, ${p.traffic} ships, int_01_jumpSeat, Anniversary:`)
    console.log(`  with traffic     ${withA.calls} calls, ${withA.tris} tris`)
    console.log(`  traffic hidden   ${without.calls} calls, ${without.tris} tris`)
    console.log(`  with traffic     ${withB.calls} calls, ${withB.tris} tris  (repeat)`)
    console.log(
      `  DELTA            ${withA.calls - without.calls} calls, ${withA.tris - without.tris} tris`,
    )
    // And WHOSE they are, from three's own render list folded by top-level
    // group (`boot/render-census.ts`). The traffic group is named `traffic`,
    // so it is its own row — which is the difference between "3 calls appeared"
    // and "3 calls, and here is what they drew".
    const rows = await page.evaluate(() => {
      const w = globalThis as unknown as Ff2Global
      const c = w.__ff2.census()
      return { calls: c.calls, rows: c.rows }
    })
    console.log(`  census, ${rows.calls} calls in the frame, by group:`)
    for (const r of rows.rows) {
      console.log(`    ${r.group.padEnd(20)} ${String(r.calls).padStart(4)} calls  ${r.triangles}`)
    }

    // The self-check: the two visible readings must agree, or the scene moved
    // under the measurement and the delta is measuring the scene.
    expect(Math.abs(withA.calls - withB.calls)).toBeLessThanOrEqual(2)
    // Three ships cannot be free, and they cannot be the whole frame either.
    expect(withA.calls - without.calls).toBeGreaterThan(0)
    expect(withA.calls - without.calls).toBeLessThan(40)
  })

  /**
   * HOW CLOSE, HOW OFTEN — a capture, not a gate.
   *
   * The pairing was chosen on a static measurement: `int_01_hoverJet`'s line
   * passes 548 m from this mission's spawn and 111 m from its nearest jump
   * pad. That says the LINE is near. It does not say a SHIP is, because three
   * ships on an 11.3 km circuit are somewhere else most of the time — and the
   * number a headset pass needs is the distribution, not the geometry.
   *
   * So this flies the actual mission under the autopilot, samples every two
   * seconds, and prints the quantiles. It is the evidence for `count`, which
   * is the one number in this feature that a monitor cannot settle.
   *
   * Since DEV-403 the autopilot's run can RESTART about 92 s in, on a head
   * strike against a palm (`completion.spec.ts`, `HEAD_STRIKE_OPEN`). Nothing
   * here depends on the seat's progress — only on what passes near it — so the
   * samples after a restart count the same.
   */
  test('how close the traffic comes while the mission is flown', async ({ page }) => {
    test.setTimeout(900_000)
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.goto('/?xr=off&title=0&menu=0&autopilot=1&mission=int_01_jumpSeat')
    await firstPress(page)
    await missionReady(page, 240_000)
    const nearest: number[] = []
    // And PHOTOGRAPH the close passes. Three of this port's four orientation
    // bugs were caught by Matt from a screenshot rather than by any number, and
    // the thing that is new here is the seeded orientation: a ship whose mesh
    // faced backwards would still fly forwards, score gates and advance its
    // cursor, so every assertion in this file would stay green. A frame at
    // 500 m is the only thing that can say otherwise.
    let shots = 0
    let biggest = 0
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2_000)
      const s = await probe(page)
      if (s.distances.length === 0) continue
      const near = Math.min(...s.distances)
      nearest.push(near)
      // Only when one is actually ON SCREEN — a frame of a jet that is behind
      // the eye is a frame of nothing, and the whole point is to look at it.
      const seen = s.ships
        .filter((x) => x.screen !== null)
        .sort((a, b) => a.distance - b.distance)[0]
      if (seen?.screen && seen.distance < 900 && shots < 4) {
        shots++
        const g = seen.screen
        console.log(
          `  shot ${shots}: ${seen.id} at ${seen.distance.toFixed(0)} m, ${g.px.toFixed(0)} px across, canvas (${g.x.toFixed(0)}, ${g.y.toFixed(0)})`,
        )
        biggest = Math.max(biggest, g.px)
        await page.screenshot({
          path: path.join(
            SHOT_DIR,
            `traffic-${seen.distance.toFixed(0)}m-${g.px.toFixed(0)}px-at-${g.x.toFixed(0)}-${g.y.toFixed(0)}.png`,
          ),
        })
      }
      for (const x of s.ships) if (x.screen) biggest = Math.max(biggest, x.screen.px)
    }
    console.log(`  ${shots} frame(s) of a close pass in ${SHOT_DIR}`)
    console.log(`  largest a traffic ship ever appeared: ${biggest.toFixed(0)} px across`)
    // DEV-044's threshold, stated as a gate rather than as a hope: the title
    // jets flew backwards for a session because they were FOUR PIXELS across
    // and nobody could have seen it either way. Ten is not generous; it is the
    // floor below which this feature has been rendered rather than shipped.
    expect(biggest).toBeGreaterThan(10)
    const sorted = [...nearest].sort((a, b) => a - b)
    const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0
    console.log(`DEV-146 nearest traffic ship over ${nearest.length} samples, ~2 s apart:`)
    console.log(
      `  min ${q(0).toFixed(0)} m   p10 ${q(0.1).toFixed(0)} m   median ${q(0.5).toFixed(0)} m   p90 ${q(0.9).toFixed(0)} m   max ${q(1).toFixed(0)} m`,
    )
    for (const r of [500, 1000, 1500, 2000]) {
      const n = sorted.filter((d) => d < r).length
      console.log(
        `  within ${String(r).padStart(4)} m: ${((100 * n) / sorted.length).toFixed(0)}% of the time`,
      )
    }
    // The only gate: over two minutes of flying the course, SOMETHING came
    // within a kilometre at least once. Below that this is a feature nobody
    // can see, and the row should say so rather than the suite staying green.
    expect(q(0)).toBeLessThan(1_000)
  })

  test('Classic draws none of it', async ({ page }) => {
    test.setTimeout(600_000)
    // DEV-452 (D35): traffic lives in `gameplay`, the rules every run flies,
    // so a player's Classic look has it too; 2016's none is `?rules=classic`.
    await boot(page, 'classic&rules=classic')
    await expect(page.locator('body')).toHaveAttribute('data-traffic', '0')
    const p = await probe(page)
    expect(p.edition).toBe('classic')
    expect(p.traffic).toBe(0)
  })
})
