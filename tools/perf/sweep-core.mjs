// tools/perf/sweep-core.mjs: what floor-sweep.mjs (DEV-226) and vehicle-mode-sweep.mjs
// (DEV-230/233) share. TL-15 (docs/plan/code-reuse/tools.md): the two had grown ten
// copied functions, and the one that drifts is the reader of the trace CSV, whose
// column list is a wire format that is appended to.
//
// Only what was IDENTICAL, or a strict superset, lives here. What differs stays in
// the sweep that differs: floor-sweep's residue sidecar, vehicle-mode-sweep's rig
// pixels and flight-agreement checks, each sweep's `armEnv`, `plan` and `report`.
// No measurement changes: both sweeps' `*.json` outputs keep their exact key set and
// key order (floor-sweep trims `readTrace` back to the three fields it always
// carried). The only text that moved is two log lines whose separator was an em-dash.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  BUSY_BROWSERS,
  COOL_MAX_SECONDS,
  COOL_TO_C,
  coolDown,
  gpuState,
  machineLoad,
} from './measure-queue.mjs'

/** The spec every arm drives. One flight, through the real compositor. */
export const SPEC = 'tests/e2e/xr-vrto3d-trace.spec.ts'

/** Seconds of recorded flight per arm. Wave 3's whole ranking is at 60. */
export const DEFAULT_SECONDS = 60

/**
 * Boot, load, Enter VR and the launch, per arm, over and above the flight.
 * Used only to print an estimate; measured runtimes replace it in the report.
 */
export const ARM_OVERHEAD_SECONDS = 75

/** `p50`/`p95` of a summary stat, or null when the key is absent. */
export const stat = (summary, key) => {
  const s = summary?.[key]
  if (!s || typeof s.p50 !== 'number') return null
  return { p50: s.p50, p95: s.p95 }
}

/** The median of a numeric array. Empty is null, never 0: `0.00` reads as free. */
export const median = (xs) => {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

export const f2 = (n) => (n === null || n === undefined ? '  n/a' : n.toFixed(2))
export const mtri = (n) => (n === null || n === undefined ? ' n/a' : `${(n / 1e6).toFixed(2)}M`)

/**
 * Median `calls` and `tris` over the recorded frames, PLUS the flight and the
 * resolution: an arm's runtime signature, read from the CSV's own header line
 * and never by index. The trace's column list is a wire format that is APPENDED
 * to (perf-protocol section 5a), so `row[8]` is right until the day it is not.
 *
 * DEV-233's four columns (`ship_x`, `ship_z`, `elapsed_s`, `scale`) are what the
 * first sixteen-arm vehicle/mode run went to a report without, and they were the
 * whole answer:
 *
 *   `path`   metres over the ground, summed frame to frame in x/z. The camera
 *            rides the ship, and a renderer this fill-bound is priced by where
 *            the camera IS.
 *   `span`   `elapsed_s` first to last: SIM seconds actually recorded, which is
 *            not the arm's `--seconds` when a finish volume stops the recorder.
 *   `bbox`   how far the flight ranged in x and z (a long path in a tiny box is
 *            an aircraft in a circle).
 *   `scale`  the median adaptive render scale. Two arms at 0.6 and 1.0 rasterised
 *            2.78x different pixel counts and their GPU times are not comparable.
 *
 * A trace without those columns still reads: the four fields are `null`.
 * `null` for a missing file or a trace without `calls`/`tris`, never a zero.
 */
export const readTrace = (csvPath) => {
  if (!fs.existsSync(csvPath)) return null
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)
  // Line 0 is a JSON header object; line 1 is the column names.
  const names = (lines[1] ?? '').split(',')
  const iCalls = names.indexOf('calls')
  const iTris = names.indexOf('tris')
  if (iCalls < 0 || iTris < 0) return null
  const iX = names.indexOf('ship_x')
  const iZ = names.indexOf('ship_z')
  const iElapsed = names.indexOf('elapsed_s')
  const iScale = names.indexOf('scale')
  const calls = []
  const tris = []
  const scales = []
  let flown = null
  let span = null
  let bbox = null
  let previous = null
  let firstElapsed = null
  let lastElapsed = null
  for (const line of lines.slice(2)) {
    if (line.length === 0) continue
    const cells = line.split(',')
    const c = Number(cells[iCalls])
    const t = Number(cells[iTris])
    if (Number.isFinite(c)) calls.push(c)
    if (Number.isFinite(t)) tris.push(t)
    if (iScale >= 0) {
      const s = Number(cells[iScale])
      if (Number.isFinite(s)) scales.push(s)
    }
    if (iElapsed >= 0) {
      const e = Number(cells[iElapsed])
      if (Number.isFinite(e)) {
        if (firstElapsed === null) firstElapsed = e
        lastElapsed = e
      }
    }
    if (iX >= 0 && iZ >= 0) {
      const x = Number(cells[iX])
      const z = Number(cells[iZ])
      if (Number.isFinite(x) && Number.isFinite(z)) {
        flown ??= 0
        bbox ??= { minX: x, maxX: x, minZ: z, maxZ: z }
        if (previous) flown += Math.hypot(x - previous.x, z - previous.z)
        previous = { x, z }
        bbox.minX = Math.min(bbox.minX, x)
        bbox.maxX = Math.max(bbox.maxX, x)
        bbox.minZ = Math.min(bbox.minZ, z)
        bbox.maxZ = Math.max(bbox.maxZ, z)
      }
    }
  }
  if (firstElapsed !== null && lastElapsed !== null) span = lastElapsed - firstElapsed
  return {
    calls: median(calls),
    triangles: median(tris),
    rows: calls.length,
    path: flown,
    span,
    scale: median(scales),
    bbox: bbox ? { x: bbox.maxX - bbox.minX, z: bbox.maxZ - bbox.minZ } : null,
  }
}

/**
 * The summary an arm's run wrote and the paths beside it, or null if it wrote none.
 *
 * The stem carries the MISSION, so a cell that loaded the wrong level writes
 * somewhere this will not find, which fails loudly rather than reading the
 * previous arm's file. `base` is the part of an arm's record both sweeps keep, in
 * the key order both sweeps' JSON has always had; each sweep appends its own.
 */
export const readSummary = (dir, mission, edition, seconds) => {
  const stem = `${mission}-${edition}-${seconds}s-vrto3d`
  const summaryPath = path.join(dir, `${stem}.summary.json`)
  if (!fs.existsSync(summaryPath)) return null
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  return {
    stem,
    csv: path.join(dir, `${stem}.trace.csv`),
    base: {
      gpu: stat(summary, 'gpu'),
      dt: stat(summary, 'dt'),
      render: stat(summary, 'render'),
      frames: summary.frames ?? null,
      gpuFrames: summary.gpuFrames ?? null,
      hitches: summary.hitches ?? null,
      tierFraction: summary.tierFraction ?? null,
    },
  }
}

/**
 * Run ONE arm: print it, cool the GPU, spawn the spec with `env`, keep the log, read
 * what it wrote. `read(dir)` is the sweep's own `readArm`. A run that fails still
 * leaves its log; a run that fails SILENTLY is the one to refuse, so an arm with no
 * summary on disk is carried as a null `read` and the report prints `DID NOT RUN`
 * rather than dropping it.
 *
 * `mission` is carried on the row only when the sweep varies it per arm.
 */
export const runArm = ({ arm, dir, env, mission, dryRun, index, total, read }) => {
  console.log(`\n── ${index}/${total}  ${arm.name}`)
  console.log(`   ${arm.why}`)
  const shown = Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  console.log(`   ${shown} pnpm exec playwright test ${SPEC} --workers 1 --retries 0`)
  const head = mission === undefined ? { arm, dir } : { arm, dir, mission }
  if (dryRun) return { ...head, skipped: true }

  const before = coolDown(COOL_TO_C, COOL_MAX_SECONDS)
  const load = machineLoad()
  console.log(
    `   gpu ${before?.temp ?? '?'} C, ${before?.clock ?? '?'} MHz · ` +
      `chrome ${load.chrome ?? '?'} · node ${load.node ?? '?'} · cpu ${load.cpu ?? '?'} %`,
  )
  fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()
  const res = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', SPEC, '--workers', '1', '--retries', '0'],
    { env: { ...process.env, ...env }, encoding: 'utf8', shell: true },
  )
  fs.writeFileSync(path.join(dir, 'run.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`)
  const wallSeconds = Math.round((Date.now() - started) / 1000)
  const after = gpuState()
  const got = read(dir)
  console.log(
    `   exit ${res.status} in ${wallSeconds} s, gpu p50 ${got?.gpu ? got.gpu.p50.toFixed(2) : 'n/a'}` +
      `  calls ${got?.trace?.calls ?? 'n/a'}  tris ${got?.trace?.triangles ?? 'n/a'}` +
      `  (${before?.clock ?? '?'} -> ${after?.clock ?? '?'} MHz)`,
  )
  return {
    ...head,
    status: res.status,
    wallSeconds,
    clockBefore: before?.clock ?? null,
    clockAfter: after?.clock ?? null,
    load,
    read: got,
  }
}

/**
 * Print the machine line, and refuse (exit 1) next to a fan-out of browsers: a GPU
 * measurement taken beside one is not a measurement (perf-protocol section 3a).
 */
export const refuseIfBusy = () => {
  const load = machineLoad()
  console.log(
    `machine: chrome ${load.chrome ?? '?'} · node ${load.node ?? '?'} · cpu ${load.cpu ?? '?'} %`,
  )
  if (load.chrome !== null && load.chrome > BUSY_BROWSERS) {
    console.error(
      `\nREFUSING TO RUN: ${load.chrome} independent Chrome browsers are alive.\n` +
        'A GPU measurement taken next to a fan-out is not a measurement; see\n' +
        'docs/testing/perf-protocol.md §3a. Let them finish, then re-run.',
    )
    process.exit(1)
  }
}
