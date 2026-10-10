// tools/perf/measure-queue.mjs — run a list of GPU measurements SERIALLY, on a
// machine you have checked is quiet, and write one log per row.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// `docs/testing/perf-protocol.md` §3a: a fan-out and a GPU measurement cannot
// share a box. Six agents driving headed Chrome put nineteen Chrome processes
// on the one RTX 5050 and took the A/B drift column from 0.01–0.19 ms to 6.37;
// `clouds` — three draw calls carrying four thousand triangles — scored
// 5.15 ms, and four rows came out negative. Two conclusions had to be
// withdrawn.
//
// So the working pattern for a fan-out is: agents BUILD and unit-test, and
// write their ledger's §3 as "TO BE TAKEN ON A QUIET MACHINE" with the command
// ready to paste. This is what then takes them — one at a time, back to back,
// on the merged build, which is better data than any of them would have got.
//
//   node tools/perf/measure-queue.mjs <queue.json> [--dry-run]
//
// The queue is a JSON array of `{ name, env, spec }`. `spec` defaults to
// `tests/e2e/perf-scale.spec.ts` — the instrument with the empty-stage control
// and an R² of 0.999, and the one to reach for unless there is a reason not to.
//
// It REFUSES to start when the machine is busy, because a runner that silently
// produces contaminated numbers is worse than no runner: the numbers look
// exactly like real ones.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * How many independent Chrome BROWSERS may be alive before a measurement is
 * refused. One is the desktop's own; a second is somebody driving a page.
 *
 * **Parents, not processes, and the first version of this got it wrong.** It
 * counted `Get-Process chrome` and refused above eight — but one idle browser
 * is one parent and twenty renderer children, so on a perfectly quiet machine
 * it read 21 and refused. What contaminates a GPU reading is another browser
 * being DRIVEN, and Playwright launches its own parent, so parents are the
 * thing to count. A parent is a `chrome.exe` with no `--type=` in its command
 * line; every renderer, GPU and utility process has one.
 */
export const BUSY_BROWSERS = 1

/** Cool to this before a row, and give up waiting after this long. */
export const COOL_TO_C = Number(process.env.QUEUE_COOL_TO_C ?? '55')
export const COOL_MAX_SECONDS = Number(process.env.QUEUE_COOL_MAX_SECONDS ?? '180')

/** Independent Chrome browsers alive. `null` when it cannot be established. */
export const chromeCount = () => {
  const probe = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '@(Get-CimInstance Win32_Process | Where-Object Name -eq chrome.exe |' +
        " Where-Object { $_.CommandLine -notlike '*--type=*' }).Count",
    ],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) return null
  const n = Number(probe.stdout.trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Chrome browsers, node processes and total CPU load, in ONE probe.
 *
 * ── Why counting browsers was not enough ─────────────────────────────────
 *
 * `chromeCount` exists because what contaminates a GPU reading is another
 * browser being DRIVEN. That is true and it is not the whole truth, and a peer
 * session found the hole the same afternoon the per-sweep sampling landed:
 *
 * **A sibling running `pnpm check` is node and tsc with ZERO Chrome.** tsc on
 * this project pegs a core for a while, and a renderer starved of CPU produces
 * a frame pinned by a fixed non-GPU term that stops responding to resolution —
 * which is *precisely* the signature `docs/plan/VR-PERF-WAVE-2-WORK.md` §11.11
 * calls the cliff: flat across all four sizes, fixed term only, fill slope
 * holding. So the probe built to defend the measurement was blind to the one
 * contaminant that most resembles the finding, which is trap 24's shape — a
 * guard that cannot see the thing it guards against.
 *
 * One PowerShell invocation for all three, because the spec samples this at
 * every reading and two spawns cost twice.
 *
 * `cpu` is `Win32_Processor.LoadPercentage`, the OS's own maintained figure —
 * a snapshot, not a sleep. `null` for any field that cannot be established.
 */
export const machineLoad = () => {
  const probe = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '$p = Get-CimInstance Win32_Process;' +
        " $c = @($p | Where-Object Name -eq chrome.exe | Where-Object { $_.CommandLine -notlike '*--type=*' }).Count;" +
        ' $n = @($p | Where-Object Name -eq node.exe).Count;' +
        ' $u = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;' +
        ' "$c,$n,$u"',
    ],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) return { chrome: null, node: null, cpu: null }
  const [chrome, node, cpu] = probe.stdout
    .trim()
    .split(',')
    .map((v) => {
      const n = Number(v.trim())
      return Number.isFinite(n) ? n : null
    })
  return { chrome: chrome ?? null, node: node ?? null, cpu: cpu ?? null }
}

/**
 * The GPU's clock, temperature and utilisation, or null without `nvidia-smi`.
 *
 * ── Why a serial queue needs this ────────────────────────────────────────
 *
 * Measured 2026-09-17, and it invalidated a whole queue. Seven rows run back to
 * back came out ordered by WHEN THEY RAN rather than by what they measured: the
 * first read 4.72 ms, identical-looking rows four places later read 6.6–7.4,
 * and `?ocean=1` — which removes 98 % of the sea's triangles — read MORE than
 * the ladder it was meant to beat. At the end of the queue `nvidia-smi` said
 * **1567 MHz against a 3090 MHz maximum, at 64 °C**: twenty-five minutes of
 * back-to-back rendering had taken the GPU to half its boost clock.
 *
 * So on a laptop a cross-row A/B is a comparison of two thermal states unless
 * something controls for it. Recorded per row; `docs/testing/perf-protocol.md`
 * §3a says what to do about it.
 */
export const gpuState = () => {
  const probe = spawnSync(
    'nvidia-smi',
    [
      '--query-gpu=temperature.gpu,clocks.current.graphics,clocks.max.graphics,utilization.gpu',
      '--format=csv,noheader,nounits',
    ],
    { encoding: 'utf8' },
  )
  if (probe.status !== 0) return null
  const [temp, clock, maxClock, util] = probe.stdout
    .trim()
    .split(',')
    .map((v) => Number(v.trim()))
  if (!Number.isFinite(clock) || !Number.isFinite(maxClock) || maxClock === 0) return null
  return { temp, clock, maxClock, util, fraction: clock / maxClock }
}

const describeGpu = (g) =>
  g === null
    ? 'gpu: unknown (nvidia-smi not on PATH)'
    : `gpu: ${g.clock} / ${g.maxClock} MHz (${(100 * g.fraction).toFixed(0)} % of boost), ${g.temp} C, ${g.util} % busy`

/**
 * Wait for the GPU to come back down to `toC`, or give up after `maxSeconds`.
 *
 * The number that says this is needed: the SAME row, run first in a queue and
 * again after the GPU had cooled, reads `fixed 1.91 + 0.45 ms/Mpx` and
 * `fixed 2.03 + 0.45` — **the same fill slope to two figures**. Rows three to
 * six of that queue, taken back to back in between, read 6.6–7.4 ms for
 * configurations that should have been CHEAPER than the first.
 *
 * One 170 s row takes this GPU from 52 °C to 59 °C, so the first row of any
 * queue is the only cold one unless something waits. 55 °C is the bar because
 * it is where this laptop sits a minute after a row and still boosts; it is a
 * property of this machine and belongs in the rig, not in a ledger row.
 */
export const coolDown = (toC, maxSeconds) => {
  const started = Date.now()
  for (;;) {
    const g = gpuState()
    if (g === null || g.temp <= toC) return g
    if ((Date.now() - started) / 1000 > maxSeconds) {
      console.log(`   (still ${g.temp} C after ${maxSeconds} s — going anyway)`)
      return g
    }
    // A busy-wait would heat the CPU and keep the fans loaded; sleep instead.
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 10'])
  }
}

const run = (row, outDir, dryRun) => {
  const spec = row.spec ?? 'tests/e2e/perf-scale.spec.ts'
  const dir = path.join(outDir, row.name)
  const env = { ...process.env, ...row.env, SCALE_DIR: dir, FILL_DIR: dir }
  const args = ['exec', 'playwright', 'test', spec, '--workers', '1', '--retries', '0']
  const shown = Object.entries(row.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  console.log(`\n── ${row.name}\n   ${shown} pnpm ${args.join(' ')}`)
  if (dryRun) return { name: row.name, skipped: true }
  const before = coolDown(COOL_TO_C, COOL_MAX_SECONDS)
  console.log(`   ${describeGpu(before)}`)
  fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()
  const res = spawnSync('pnpm', args, { env, encoding: 'utf8', shell: true })
  const log = path.join(dir, 'run.log')
  fs.writeFileSync(log, `${res.stdout ?? ''}\n${res.stderr ?? ''}`)
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  // The spec writes its own table; surface it here so one scroll has everything.
  const table = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')
  if (table) console.log(table)
  const after = gpuState()
  console.log(`   exit ${res.status} in ${seconds} s — ${log}\n   ${describeGpu(after)}`)
  return {
    name: row.name,
    status: res.status,
    seconds: Number(seconds),
    clockBefore: before?.clock ?? null,
    clockAfter: after?.clock ?? null,
  }
}

const main = () => {
  const queueFile = process.argv[2]
  const dryRun = process.argv.includes('--dry-run')
  if (!queueFile) {
    console.error('usage: node tools/perf/measure-queue.mjs <queue.json> [--dry-run]')
    process.exit(2)
  }
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'))
  const outDir = process.env.QUEUE_DIR ?? 'perf-out/queue'

  const chrome = chromeCount()
  console.log(
    `chrome browsers: ${chrome === null ? 'unknown' : chrome} (renderer children not counted)`,
  )
  if (!dryRun && chrome !== null && chrome > BUSY_BROWSERS) {
    console.error(
      `\nREFUSING TO RUN: ${chrome} independent Chrome browsers are alive.\n` +
        'A GPU measurement taken next to a fan-out is not a measurement — see\n' +
        'docs/testing/perf-protocol.md §3a. Let the agents finish, then re-run.',
    )
    process.exit(1)
  }

  const results = []
  for (const row of queue) results.push(run(row, outDir, dryRun))
  console.log('\n── queue done')
  for (const r of results) {
    const clocks = r.clockBefore == null ? '' : `   ${r.clockBefore} -> ${r.clockAfter} MHz`
    console.log(`   ${r.skipped ? 'DRY ' : r.status === 0 ? ' ok ' : 'FAIL'} ${r.name}${clocks}`)
  }
  // What the first queue learned the hard way: if the clock fell across the
  // run, the rows are ordered by WHEN as much as by WHAT, and an A/B between
  // two of them compares two thermal states.
  const first = results.find((r) => r.clockBefore != null)
  const last = [...results].reverse().find((r) => r.clockAfter != null)
  if (first && last && (last.clockAfter ?? 0) < (first.clockBefore ?? 0) * 0.85) {
    console.warn(
      `\nWARNING: the GPU clock fell ${first.clockBefore} -> ${last.clockAfter} MHz across this queue.\n` +
        'Rows late in it were measured on a slower GPU than rows early in it, so a\n' +
        'CROSS-ROW comparison is not evidence. Within-row group differences are\n' +
        'unaffected. See docs/testing/perf-protocol.md §3a.',
    )
  }
  if (results.some((r) => !r.skipped && r.status !== 0)) process.exit(1)
}

// ── Run main() only when this file IS the program ────────────────────────
//
// This guard used to read `import.meta.url.endsWith('measure-queue.mjs')`,
// which is a test of THIS MODULE'S OWN NAME and is therefore always true. It
// was harmless for exactly as long as nothing imported the file.
//
// `perf-scale.spec.ts` then imported `machineLoad` from it, and every
// Playwright invocation in the repo began running the queue runner at import
// time — reading `process.argv[2]`, which for `playwright test ...` is the word
// **`test`**, as a path to a queue file:
//
//     Error: ENOENT: no such file or directory, open '<repo>/test'
//     Error: No tests found.
//
// Two rows of a measurement queue died in 13 and 5 seconds. Compare the module
// URL against the RESOLVED entry path instead, which is the thing the guard was
// always meant to ask. `pathToFileURL` because `process.argv[1]` is a path and
// `import.meta.url` is a URL, and on Windows those differ by more than a prefix.
const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) main()
