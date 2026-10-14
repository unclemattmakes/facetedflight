// tests/unit/contamination-dev.test.ts: DEV-915, what the page does with the
// dev server's answer, and the one guard that keeps it out of a build.
//
// The lease rule has a trap in it that a single case hides: a lease held by an
// agent is contamination for a WEARER and the ordinary state of a test run.
// Each rule is therefore tested as a pair that differs in exactly one input.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageContaminationMask } from '@/boot/contamination'
import {
  type BoxState,
  boxMask,
  cpuContaminates,
  HOST_CPU_BUSY,
  leaseContaminates,
  RELOAD_MARKER_KEY,
  RELOAD_SETTLE_MS,
  selfLeaseFromSearch,
  startDevSignals,
} from '@/boot/contamination-dev'
import { CONTAMINATION } from '@/render/contamination'
import { appSource } from './helpers/app-source'

const agent = { holder: 'perf-b', ageSeconds: 30 }
const wearer = { holder: 'matt-testing', ageSeconds: 30 }

describe('the lease rule', () => {
  it('an agent holding the lease contaminates a presenting session', () => {
    expect(leaseContaminates(agent, true, null)).toBe(true)
  })

  it('the same lease on a flat page is just that agent testing: clean', () => {
    expect(leaseContaminates(agent, false, null)).toBe(false)
  })

  it('the wearer holding it is the wearer: clean', () => {
    expect(leaseContaminates(wearer, true, null)).toBe(false)
  })

  it('a lease the operator says is theirs (?lease=) is clean, someone else with ?lease= is not', () => {
    expect(leaseContaminates(agent, true, 'perf-b')).toBe(false)
    expect(leaseContaminates(agent, true, 'perf-c')).toBe(true)
  })

  it('no lease is no contamination', () => {
    expect(leaseContaminates(null, true, null)).toBe(false)
  })

  it('reads ?lease= from the query string', () => {
    expect(selfLeaseFromSearch('?perf=1&lease=perf-c')).toBe('perf-c')
    expect(selfLeaseFromSearch('?perf=1')).toBeNull()
    expect(selfLeaseFromSearch('?lease=')).toBeNull()
  })
})

describe('the CPU rule', () => {
  it('flags at the threshold and not below it', () => {
    expect(cpuContaminates({ busy: HOST_CPU_BUSY })).toBe(true)
    expect(cpuContaminates({ busy: HOST_CPU_BUSY - 0.01 })).toBe(false)
  })

  it('a missing reading is no evidence either way', () => {
    expect(cpuContaminates({ busy: null })).toBe(false)
    expect(cpuContaminates(null)).toBe(false)
  })

  it('boxMask composes both reasons', () => {
    const both: BoxState = { lease: agent, cpu: { busy: 0.99 } }
    expect(boxMask(both, true, null)).toBe(CONTAMINATION.LEASE | CONTAMINATION.HOST_CPU)
    expect(boxMask(both, false, null)).toBe(CONTAMINATION.HOST_CPU)
  })
})

describe('the page signal', () => {
  it('a hidden document and a hidden XR session are flagged', () => {
    expect(pageContaminationMask('hidden', undefined)).toBe(CONTAMINATION.HIDDEN)
    expect(pageContaminationMask('visible', 'hidden')).toBe(CONTAMINATION.HIDDEN)
  })

  it('visible-blurred is NOT flagged by default (the production behaviour), only when asked (dev)', () => {
    expect(pageContaminationMask('visible', 'visible-blurred')).toBe(0)
    expect(pageContaminationMask('visible', 'visible-blurred', false)).toBe(0)
    expect(pageContaminationMask('visible', 'visible-blurred', true)).toBe(CONTAMINATION.HIDDEN)
  })

  it('the controller wires dev-only for blurred: the call passes import.meta.env.DEV', () => {
    const src = readFileSync(
      path.resolve(__dirname, '..', '..', 'src/boot/contamination.ts'),
      'utf8',
    )
    expect(src).toMatch(/import\.meta\.env\.DEV,\s*\)/)
  })

  it('a visible page and a visible session are clean', () => {
    expect(pageContaminationMask('visible', 'visible')).toBe(0)
    expect(pageContaminationMask('visible', undefined)).toBe(0)
  })
})

/** A fake HMR client and a fake box, driven by hand. */
const rig = (box: () => Promise<BoxState>, opts: { storedAt?: number; wall?: number } = {}) => {
  const handlers = new Map<string, () => void>()
  const observed: number[] = []
  const store = new Map<string, string>()
  if (opts.storedAt !== undefined) store.set(RELOAD_MARKER_KEY, String(opts.storedAt))
  let clock = 0
  let tick: (() => void) | null = null
  const stop = startDevSignals({
    observe: (m) => observed.push(m),
    presenting: () => true,
    hot: { on: (e, cb) => void handlers.set(e, cb) },
    now: () => clock,
    fetchBox: box,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    wallClock: () => opts.wall ?? 1_000_000,
    setInterval: (fn) => {
      tick = fn
      return 1
    },
    clearInterval: () => {
      tick = null
    },
  })
  return {
    handlers,
    observed,
    store,
    stop,
    advance: (ms: number) => {
      clock += ms
    },
    poll: () => tick?.(),
    isPolling: () => tick !== null,
  }
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0))
const quiet: BoxState = { lease: null, cpu: { busy: 0.1 } }

describe('the HMR signal', () => {
  it('an update and a reload each raise HMR, and a reload leaves the marker', async () => {
    const r = rig(async () => quiet)
    await settle()
    r.observed.length = 0
    r.handlers.get('vite:beforeUpdate')?.()
    expect(r.observed).toEqual([CONTAMINATION.HMR])
    r.handlers.get('vite:beforeFullReload')?.()
    expect(r.observed).toEqual([CONTAMINATION.HMR, CONTAMINATION.HMR])
    expect(r.store.get(RELOAD_MARKER_KEY)).toBe('1000000')
  })

  it('a lost socket holds HMR on every poll until it comes back', async () => {
    const r = rig(async () => quiet)
    await settle()
    r.handlers.get('vite:ws:disconnect')?.()
    r.observed.length = 0
    r.poll()
    expect(r.observed).toContain(CONTAMINATION.HMR)
    r.handlers.get('vite:ws:connect')?.()
    await settle()
    r.observed.length = 0
    r.poll()
    await settle()
    expect(r.observed.filter((m) => m & CONTAMINATION.HMR)).toEqual([])
  })

  it('the page a reload produced is flagged while the dev server settles, then clean', async () => {
    const r = rig(async () => quiet, { storedAt: 999_000, wall: 1_000_000 })
    await settle()
    expect(r.observed.some((m) => m & CONTAMINATION.HMR)).toBe(true)
    r.advance(RELOAD_SETTLE_MS + 1)
    r.observed.length = 0
    r.poll()
    await settle()
    expect(r.observed.filter((m) => m & CONTAMINATION.HMR)).toEqual([])
  })

  it('a page that was NOT reloaded by HMR (an old marker, or none) is not flagged', async () => {
    const stale = rig(async () => quiet, { storedAt: 100, wall: 1_000_000 })
    await settle()
    expect(stale.observed.filter((m) => m & CONTAMINATION.HMR)).toEqual([])
    const none = rig(async () => quiet)
    await settle()
    expect(none.observed.filter((m) => m & CONTAMINATION.HMR)).toEqual([])
  })
})

describe('the box poll', () => {
  it('feeds the mask of what the server said', async () => {
    const r = rig(async () => ({ lease: agent, cpu: { busy: 0.95 } }))
    await settle()
    expect(r.observed).toContain(CONTAMINATION.LEASE | CONTAMINATION.HOST_CPU)
  })

  it('gives up after repeated failures: no endpoint here, so no request per half second', async () => {
    let calls = 0
    const r = rig(async () => {
      calls++
      throw new Error('404')
    })
    for (let i = 0; i < 6; i++) {
      await settle()
      r.poll()
    }
    await settle()
    expect(calls).toBe(3)
    expect(r.isPolling()).toBe(false)
  })

  it('does not stack requests while one is in flight', async () => {
    let calls = 0
    const r = rig(() => {
      calls++
      return new Promise<BoxState>(() => {})
    })
    r.poll()
    r.poll()
    expect(calls).toBe(1)
  })
})

describe('the dev half stays out of a build', () => {
  const root = path.resolve(__dirname, '..', '..')

  it('app.ts reaches it only through a dynamic import inside import.meta.env.DEV', () => {
    const app = appSource()
    const hits = [...app.matchAll(/contamination-dev/g)]
    expect(hits.length).toBeGreaterThan(0)
    // Never a static import of it: that would put the module in every bundle.
    expect(app).not.toMatch(/^import[^\n]*contamination-dev/m)
    const at = app.indexOf("import('./contamination-dev')")
    expect(at).toBeGreaterThan(0)
    // The nearest `if (` before the import is the DEV guard.
    const before = app.slice(Math.max(0, at - 400), at)
    expect(before).toContain('if (import.meta.env.DEV)')
  })

  it('nothing else under src/ imports it, and only it names the endpoint', () => {
    const importers = grepSrc(root, /(?:from\s+|import\()\s*['"][^'"]*contamination-dev['"]/)
    expect(importers.map((f) => path.basename(f))).toEqual(['app.ts'])
    expect(grepSrc(root, /__ff2\/box/).map((f) => f.replace(/\\/g, '/'))).toEqual([
      expect.stringContaining('src/boot/contamination-dev.ts'),
    ])
  })
})

/** Source files under src/ whose text matches. A plain walk: no dependency on a tool. */
function grepSrc(repo: string, pattern: RegExp): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSyncSafe(dir)) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|mjs)$/.test(entry.name) && pattern.test(readFileSync(full, 'utf8'))) {
        found.push(full)
      }
    }
  }
  walk(path.join(repo, 'src'))
  return found
}

function readdirSyncSafe(dir: string) {
  return readdirSync(dir, { withFileTypes: true })
}
