// tools/dev/box-state.mjs: what the dev server can tell the page about the BOX
// it is running on. DEV-915, docs/plan/perf-wave/perf-contamination.md.
//
// `render/quality.ts` times the frame and acts on the answer, so a frame
// starved by somebody else's `pnpm check` looks exactly like a slow build
// (`docs/testing/perf-protocol.md` section 3a-quater). The page cannot see the
// box; the dev server can, so under `pnpm dev` it answers
//
//     GET /__ff2/box   ->   { lease, cpu }
//
//   lease  who holds the GPU lease (tools/agent/gpu.sh), or null. Read from the
//          lock's own `holder` file; the script is NEVER run, so nothing here
//          can queue, take or disturb a lease, and nothing reads gpu.sh while a
//          waiter has it open.
//   cpu    the host's busy fraction over about the last second, from two
//          `os.cpus()` reads. `busy` is null until the sampler has two.
//
// What the page DOES with it (a lease held by someone other than the wearer, a
// busy host) is `src/boot/contamination-dev.ts`'s decision, not this file's.
//
// ── It does not exist in a build ──────────────────────────────────────────
//
// `apply: 'serve'`: `vite build` never calls `configureServer`, and this file is
// config-side, so nothing of it is bundled. The page half is reached only
// through `import.meta.env.DEV`, which a build folds to false.
// `tests/unit/box-state.test.ts` builds the app and greps the output for both
// halves' marker strings.
//
// ── What it refuses ───────────────────────────────────────────────────────
//
// Anything but GET (405). `pnpm dev` listens on 0.0.0.0 because the headset is
// on the LAN, so any device there can ask; the answer is a holder's name and a
// number between 0 and 1, and no path or parameter from the request is ever
// used to build a file name. No CORS headers, so another origin's page cannot
// read it.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The route. The page half imports nothing from here; it spells the same string. */
export const BOX_ROUTE = '/__ff2/box'

/** How often the sampler reads the CPU counters, ms. */
export const SAMPLE_INTERVAL_MS = 250

/** The window `busy` is computed over, ms. About one second, so a poll sees a fresh answer. */
export const BUSY_WINDOW_MS = 1000

/**
 * The lease's `holder` file: three lines, name, epoch seconds of the booking,
 * minutes asked for (`gpu.sh`'s `take_lock`). Null for anything else, so a lock
 * directory caught half-written reads as no lease rather than as a lease held
 * by "".
 *
 * @param {string} text
 * @param {number} nowSeconds
 * @returns {{ holder: string, ageSeconds: number, askedMinutes: number | null } | null}
 */
export const parseHolder = (text, nowSeconds) => {
  const lines = String(text).split(/\r?\n/)
  const holder = (lines[0] ?? '').trim()
  if (holder === '') return null
  const since = Number(lines[1])
  const asked = Number(lines[2])
  return {
    holder,
    ageSeconds: Number.isFinite(since) && since > 0 ? Math.max(0, nowSeconds - since) : 0,
    askedMinutes: Number.isFinite(asked) && asked > 0 ? asked : null,
  }
}

/**
 * Busy fraction between two `os.cpus()` snapshots, 0 to 1, over every core. The
 * counters are cumulative, so the answer is the difference: idle against total.
 * Null when the clock did not advance (two reads inside one tick) or the
 * snapshots do not describe the same cores.
 *
 * @param {ReadonlyArray<{ times: Record<string, number> }>} before
 * @param {ReadonlyArray<{ times: Record<string, number> }>} after
 * @returns {number | null}
 */
export const busyBetween = (before, after) => {
  if (before.length === 0 || before.length !== after.length) return null
  let idle = 0
  let total = 0
  for (let i = 0; i < after.length; i++) {
    const a = /** @type {Record<string, number>} */ (before[i]?.times)
    const b = /** @type {Record<string, number>} */ (after[i]?.times)
    let sumA = 0
    let sumB = 0
    for (const k of Object.keys(b)) {
      sumA += a[k] ?? 0
      sumB += b[k] ?? 0
    }
    total += sumB - sumA
    idle += (b.idle ?? 0) - (a.idle ?? 0)
  }
  if (!(total > 0)) return null
  return Math.min(1, Math.max(0, 1 - idle / total))
}

/**
 * A ring of CPU snapshots and the busy fraction across the newest window.
 * Injected `cpus` and `now` so a test drives it without a machine.
 *
 * @param {{ cpus?: () => ReturnType<typeof os.cpus>, now?: () => number, windowMs?: number }} [opts]
 */
export const createCpuSampler = (opts = {}) => {
  const cpus = opts.cpus ?? (() => os.cpus())
  const now = opts.now ?? (() => Date.now())
  const windowMs = opts.windowMs ?? BUSY_WINDOW_MS
  /** @type {{ at: number, cpus: ReturnType<typeof os.cpus> }[]} */
  let ring = []
  const sample = () => {
    const at = now()
    ring.push({ at, cpus: cpus() })
    // Keep one snapshot older than the window, so the span covers it.
    while (ring.length > 2 && (ring[1]?.at ?? 0) <= at - windowMs) ring.shift()
  }
  return {
    sample,
    /** @returns {{ busy: number | null, cores: number, spanMs: number }} */
    read() {
      const newest = ring[ring.length - 1]
      const oldest = ring[0]
      if (!newest || !oldest || newest === oldest) {
        return { busy: null, cores: newest?.cpus.length ?? 0, spanMs: 0 }
      }
      return {
        busy: busyBetween(oldest.cpus, newest.cpus),
        cores: newest.cpus.length,
        spanMs: newest.at - oldest.at,
      }
    },
    clear() {
      ring = []
    },
  }
}

/**
 * The main checkout's lock directory, from any worktree. `gpu.sh` does exactly
 * this (`--git-common-dir`, then its parent), because the lock must be one
 * place for every copy of the script. Falls back to the root itself, which is
 * right for a plain clone.
 *
 * @param {string} root
 */
export const leaseDirFor = (root) => {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    if (common) return path.join(path.dirname(common), 'tools', 'agent', 'gpu.lock')
  } catch {
    // Not a git checkout: use ours.
  }
  return path.join(root, 'tools', 'agent', 'gpu.lock')
}

/**
 * The lease right now, or null. A missing directory is the common case (the
 * card is free) and is not an error.
 *
 * @param {string} lockDir
 * @param {number} [nowSeconds]
 */
export const readLease = (lockDir, nowSeconds = Math.floor(Date.now() / 1000)) => {
  try {
    return parseHolder(readFileSync(path.join(lockDir, 'holder'), 'utf8'), nowSeconds)
  } catch {
    return null
  }
}

/**
 * The connect-style handler, separated from Vite so a test calls it with a
 * request double.
 *
 * @param {{ lockDir: string, sampler: ReturnType<typeof createCpuSampler>, now?: () => number }} deps
 */
export const createBoxHandler =
  ({ lockDir, sampler, now = () => Date.now() }) =>
  /**
   * @param {{ method?: string }} req
   * @param {{ statusCode: number, setHeader: (k: string, v: string) => void, end: (b?: string) => void }} res
   */
  (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(
      JSON.stringify({
        lease: readLease(lockDir, Math.floor(now() / 1000)),
        cpu: sampler.read(),
      }),
    )
  }

/** The Vite plugin. */
export const boxState = () => ({
  name: 'ff2-box-state',
  apply: /** @type {const} */ ('serve'),
  /** @param {import('vite').ViteDevServer} server */
  configureServer(server) {
    const sampler = createCpuSampler()
    sampler.sample()
    // `unref`: the sampler must never be the thing keeping a stopped dev server
    // alive. Cleared with the server as well, for a restart inside one process.
    const timer = setInterval(sampler.sample, SAMPLE_INTERVAL_MS)
    timer.unref?.()
    server.httpServer?.once('close', () => clearInterval(timer))
    const handler = createBoxHandler({ lockDir: leaseDirFor(server.config.root), sampler })
    server.middlewares.use(BOX_ROUTE, (req, res, next) => {
      // `use(route)` matches the prefix: only the route itself answers.
      if (req.url !== '/' && req.url !== '' && req.url !== undefined && !req.url.startsWith('/?')) {
        return next()
      }
      return handler(req, res)
    })
  },
})
