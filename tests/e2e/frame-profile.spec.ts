/**
 * tests/e2e/frame-profile.spec.ts — WHICH FUNCTION is the stall? A CPU sampling
 * profile of a window of real flight, aggregated by self time.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `docs/testing/perf-protocol.md` §0 says survey along a run first, and the
 * first survey found something no instrument in this repo could then explain.
 * Every JumpSeat mission — **six of six** — spends one frame of ~42 ms in its
 * first half second:
 *
 *     int_02_jumpSeat   frame 46.3 ms   sim 0.3   render 3.7   => 42.3 unexplained
 *     rookie_01_jumpSeat frame 42.7 ms  sim 0.2   render 2.9   => 39.6 unexplained
 *
 * `boot/perf-trace.ts` brackets the sim and the render, so it can prove the
 * stall is in NEITHER — and then it has nothing more to say. No HoverJet
 * mission has anything above 10.8 ms. "About thirty-eight milliseconds is
 * somewhere else in the loop" is where that instrument stops, and it is not
 * something anybody can act on.
 *
 * A sampling profiler is the thing that finishes the sentence. `Profiler` over
 * CDP at a 100 µs interval puts ~400 samples inside a 40 ms stall, which is
 * plenty to name the function rather than the file.
 *
 * ── It is a CAPTURE TOOL, and it gates nothing ───────────────────────────
 *
 * Same standing as `perf-trace.spec.ts`: it prints, it writes the profile
 * somewhere a person can open it in DevTools, and it asserts only that it
 * actually profiled something. **No millisecond is asserted** — a self time is
 * a property of this machine (protocol rule 1), and a CPU profile in particular
 * is perturbed by its own sampling.
 *
 * The OUTPUT is a `.cpuprofile`, which Chrome DevTools opens directly
 * (Performance -> Load profile). The console table is the fast read; the file is
 * for when the table is not enough.
 *
 *   PROFILE_MISSION=rookie_01_jumpSeat PROFILE_FROM=0.2 PROFILE_FOR=3 \
 *     E2E_PORT=<yours> pnpm exec playwright test tests/e2e/frame-profile.spec.ts --workers 1
 *
 * `@gpu`, hydrated assets, headed, by hand. Output goes to `PROFILE_DIR ??
 * 'perf-out'` and NOT to `test-results/`, which Playwright wipes at the start of
 * every run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

type Page = import('@playwright/test').Page

const MISSION = process.env.PROFILE_MISSION ?? 'rookie_01_jumpSeat'
const EDITION = process.env.PROFILE_EDITION ?? 'anniversary'
/**
 * Mission seconds at which to start sampling, and for how long.
 *
 * **`0` means "before the launch lets go"** and is not the same as a small
 * number. The stall this spec was written for is at mission **0.38 s**, and
 * waiting for the clock to pass even 0.05 costs a poll interval plus three CDP
 * round trips — by which time the mission is past 0.38 and the capture misses
 * it entirely. The first attempt did exactly that: 2.2 seconds of flight whose
 * longest contiguous run was 3.8 ms, i.e. no stall in it at all.
 *
 * So anything in the first second is captured by arming BEFORE the keypress and
 * letting the launch happen inside the profile.
 */
const FROM = Number(process.env.PROFILE_FROM ?? '0.2')
const FOR = Number(process.env.PROFILE_FOR ?? '3')
const OUT_DIR = process.env.PROFILE_DIR ?? 'perf-out'
/**
 * Microseconds between samples. Chrome's default is 1000; at that rate a 40 ms
 * stall is forty samples, which names a file and argues about the function.
 * 100 makes it four hundred.
 */
const INTERVAL_US = Number(process.env.PROFILE_INTERVAL_US ?? '100')

const elapsed = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2perf?: { sim: () => { elapsed: number } } }).__ff2perf?.sim()
        .elapsed ?? 0,
  )

interface ProfileNode {
  readonly id: number
  readonly callFrame: { functionName: string; url: string; lineNumber: number }
  readonly children?: number[]
}
interface Profile {
  readonly nodes: ProfileNode[]
  readonly samples?: number[]
  readonly timeDeltas?: number[]
  readonly startTime: number
  readonly endTime: number
}

/**
 * Self time per call frame, in milliseconds.
 *
 * SELF time, not total: a stall inside one function shows up as that function's
 * own samples, while total time would hand the answer to whatever happens to be
 * at the top of the loop and tell you the frame callback is slow, which is the
 * thing already known.
 */
const selfTime = (profile: Profile): { name: string; ms: number; hits: number }[] => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const ms = new Map<string, { ms: number; hits: number }>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i] as number)
    if (!node) continue
    const frame = node.callFrame
    const where = frame.url ? `${frame.url.split('/').pop()}:${frame.lineNumber + 1}` : 'native'
    const key = `${frame.functionName || '(anonymous)'}  ${where}`
    const prev = ms.get(key) ?? { ms: 0, hits: 0 }
    // `timeDeltas[i]` is the gap BEFORE sample i, in microseconds.
    prev.ms += (deltas[i] ?? 0) / 1000
    prev.hits += 1
    ms.set(key, prev)
  }
  return [...ms.entries()]
    .map(([name, v]) => ({ name, ms: v.ms, hits: v.hits }))
    .sort((a, b) => b.ms - a.ms)
}

/**
 * The longest CONTIGUOUS run of samples in one function, and when it happened.
 *
 * The aggregate above answers "what does this flight cost", which is a
 * different question from "what was that one 40 ms frame". A three-second
 * capture puts a 40 ms stall at 1.25 % of the total, underneath every ordinary
 * per-frame cost — the first run of this spec returned three's `getParameters`,
 * `updateMatrixWorld` and `getProgram` at the top, which is what a renderer
 * looks like and says nothing about the stall.
 *
 * A synchronous stall has a shape the aggregate cannot show: the sampler runs
 * on its own thread, so 40 ms blocked inside one function is ~400 CONSECUTIVE
 * samples with that function on top. Nothing in normal flight does that — the
 * loop returns to idle every frame. So the longest run IS the stall, and its
 * length is its duration.
 */
const longestRun = (
  profile: Profile,
): { name: string; ms: number; samples: number; atMs: number } | null => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const nameOf = (id: number): string => {
    const f = byId.get(id)?.callFrame
    if (!f) return '?'
    const where = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : 'native'
    return `${f.functionName || '(anonymous)'}  ${where}`
  }
  let best: { name: string; ms: number; samples: number; atMs: number } | null = null
  let i = 0
  let clock = 0
  while (i < samples.length) {
    const id = samples[i] as number
    const startedAt = clock
    let ms = 0
    let n = 0
    while (i < samples.length && samples[i] === id) {
      ms += (deltas[i] ?? 0) / 1000
      clock += (deltas[i] ?? 0) / 1000
      n++
      i++
    }
    // `(idle)` and `(program)` are not stalls in the game's code — idle is the
    // loop waiting for the next frame, which is the healthy state.
    const name = nameOf(id)
    if (name.startsWith('(idle)') || name.startsWith('(program)')) continue
    if (best === null || ms > best.ms) best = { name, ms, samples: n, atMs: startedAt }
  }
  return best
}

test.describe('@measure @gpu a CPU profile of real flight', () => {
  test.setTimeout(900_000)

  test(`${MISSION} ${EDITION}: ${FOR} s from mission ${FROM} s`, async ({ page }) => {
    await page.goto(`/?perf=1&autopilot=1&xr=off&mission=${MISSION}&edition=${EDITION}`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)

    const cdp = await page.context().newCDPSession(page)
    const arm = async (): Promise<void> => {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: INTERVAL_US })
      await cdp.send('Profiler.start')
    }

    if (FROM <= 0) {
      // Arm first, then launch: the profile contains the release and everything
      // after it. The only way to catch a stall in the first half second.
      await arm()
      await hold(page, 'Enter')
    } else {
      await hold(page, 'Enter')
      // Wait for the MISSION clock rather than a wall timer: the flight to
      // reach a mark varies by seconds from load to load (`fixtures/freeze.ts`
      // on the boot tick).
      await expect
        .poll(() => elapsed(page), { timeout: 300_000, intervals: [50] })
        .toBeGreaterThan(FROM)
      await arm()
    }
    await page.waitForTimeout(FOR * 1000)
    const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile }
    await cdp.detach()

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `${MISSION}-${EDITION}-from${FROM}s`
    const file = path.join(OUT_DIR, `${stem}.cpuprofile`)
    fs.writeFileSync(file, JSON.stringify(profile))

    const rows = selfTime(profile).slice(0, 14)
    const run = longestRun(profile)
    console.info(
      [
        `\nCPU profile — ${MISSION} ${EDITION}, ${FOR} s from mission ${FROM} s, ${INTERVAL_US} us interval`,
        `  ${(profile.samples ?? []).length} samples over ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms`,
        `  open in DevTools: ${file}`,
        '',
        run === null
          ? '  no contiguous run found'
          : `  LONGEST CONTIGUOUS RUN — the shape a synchronous stall makes:
` +
            `    ${run.ms.toFixed(1)} ms over ${run.samples} consecutive samples, ` +
            `${run.atMs.toFixed(0)} ms into the capture
` +
            `    ${run.name}`,
        '',
        `  ${'self ms'.padStart(9)} ${'hits'.padStart(6)}  function`,
        ...rows.map(
          (r) => `  ${r.ms.toFixed(1).padStart(9)} ${String(r.hits).padStart(6)}  ${r.name}`,
        ),
        '',
      ].join('\n'),
    )

    // Gates the MECHANISM only: it profiled, and it profiled the game rather
    // than an idle tab. Never a self time.
    expect((profile.samples ?? []).length, 'the profiler returned no samples').toBeGreaterThan(100)
    expect(rows.length, 'no call frames were resolved').toBeGreaterThan(0)
  })
})
