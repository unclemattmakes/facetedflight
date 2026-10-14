// tests/unit/box-state.test.ts: DEV-915, the dev server's view of the box.
//
// `tools/dev/box-state.mjs` answers `GET /__ff2/box` with the GPU lease's holder
// and the host's CPU load, so a dev page can tell a starved frame from a slow
// build. These tests hold each half against a double AND the whole against a
// real Vite dev server, because a handler that is right and a plugin that is
// never mounted look the same from the inside.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOX_ROUTE,
  boxState,
  busyBetween,
  createBoxHandler,
  createCpuSampler,
  parseHolder,
  readLease,
} from '../../tools/dev/box-state.mjs'

const cpu = (idle: number, busy: number) => ({
  times: { user: busy, sys: 0, idle, irq: 0, nice: 0 },
})

describe('parseHolder: the lease file gpu.sh writes', () => {
  it('reads name, booking time and minutes asked', () => {
    expect(parseHolder('perf-c\n1000\n20\n', 1090)).toEqual({
      holder: 'perf-c',
      ageSeconds: 90,
      askedMinutes: 20,
    })
  })

  it('reads CRLF, and a missing booking time as age 0', () => {
    expect(parseHolder('matt-testing\r\n', 5)).toEqual({
      holder: 'matt-testing',
      ageSeconds: 0,
      askedMinutes: null,
    })
  })

  it('an empty or half-written file is no lease, never a lease held by nobody', () => {
    expect(parseHolder('', 1)).toBeNull()
    expect(parseHolder('\n\n', 1)).toBeNull()
  })
})

describe('busyBetween: the host load from two os.cpus() reads', () => {
  it('is the busy share of the elapsed counter time, over every core', () => {
    const before = [cpu(100, 0), cpu(100, 0)]
    const after = [cpu(100, 100), cpu(200, 0)] // core 0 fully busy, core 1 fully idle
    expect(busyBetween(before, after)).toBeCloseTo(0.5, 6)
  })

  it('a fully idle interval is 0 and a fully busy one is 1', () => {
    expect(busyBetween([cpu(0, 0)], [cpu(100, 0)])).toBe(0)
    expect(busyBetween([cpu(0, 0)], [cpu(0, 100)])).toBe(1)
  })

  it('no elapsed time, or a different core count, is no reading (null, not 0)', () => {
    expect(busyBetween([cpu(5, 5)], [cpu(5, 5)])).toBeNull()
    expect(busyBetween([cpu(5, 5)], [cpu(5, 5), cpu(5, 5)])).toBeNull()
    expect(busyBetween([], [])).toBeNull()
  })
})

describe('the sampler', () => {
  it('has no reading until it has two, then reads the newest window', () => {
    let t = 0
    let snapshot = [cpu(0, 0)]
    const sampler = createCpuSampler({
      cpus: () => snapshot as never,
      now: () => t,
      windowMs: 1000,
    })
    sampler.sample()
    expect(sampler.read().busy).toBeNull()
    t = 250
    snapshot = [cpu(25, 75)]
    sampler.sample()
    expect(sampler.read().busy).toBeCloseTo(0.75, 6)
    expect(sampler.read().spanMs).toBe(250)
  })

  it('forgets what is older than the window, so a quiet second is not averaged with a loud one', () => {
    let t = 0
    let snapshot = [cpu(0, 0)]
    const sampler = createCpuSampler({
      cpus: () => snapshot as never,
      now: () => t,
      windowMs: 1000,
    })
    sampler.sample()
    // two seconds fully busy
    for (let i = 1; i <= 8; i++) {
      t += 250
      snapshot = [cpu(0, i * 100)]
      sampler.sample()
    }
    expect(sampler.read().busy).toBe(1)
    // then two seconds fully idle
    for (let i = 1; i <= 8; i++) {
      t += 250
      snapshot = [cpu(i * 100, 800)]
      sampler.sample()
    }
    expect(sampler.read().busy).toBe(0)
  })
})

describe('the handler', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ff2-box-'))
  afterEach(() => rmSync(path.join(dir, 'holder'), { force: true }))

  const call = (method: string, lockDir: string) => {
    const out: { status: number; body: string; headers: Record<string, string> } = {
      status: 0,
      body: '',
      headers: {},
    }
    const res = {
      statusCode: 0,
      setHeader: (k: string, v: string) => {
        out.headers[k] = v
      },
      end: (b?: string) => {
        out.status = res.statusCode
        out.body = b ?? ''
      },
    }
    createBoxHandler({
      lockDir,
      sampler: { read: () => ({ busy: 0.4, cores: 8, spanMs: 1000 }) },
      now: () => 2_000_000,
    })({ method }, res)
    return out
  }

  it('answers GET with the lease and the load, uncached', () => {
    writeFileSync(path.join(dir, 'holder'), 'perf-b\n1900\n30\n')
    const r = call('GET', dir)
    expect(r.status).toBe(200)
    expect(r.headers['Cache-Control']).toBe('no-store')
    expect(JSON.parse(r.body)).toEqual({
      lease: { holder: 'perf-b', ageSeconds: 100, askedMinutes: 30 },
      cpu: { busy: 0.4, cores: 8, spanMs: 1000 },
    })
  })

  it('a free card is lease: null', () => {
    expect(JSON.parse(call('GET', path.join(dir, 'nope')).body).lease).toBeNull()
    expect(readLease(path.join(dir, 'nope'))).toBeNull()
  })

  it('refuses anything but GET and sets no CORS header', () => {
    const r = call('POST', dir)
    expect(r.status).toBe(405)
    expect(Object.keys(call('GET', dir).headers).some((h) => /access-control/i.test(h))).toBe(false)
  })
})

describe('the plugin, mounted on a real dev server', () => {
  it('is serve-only', () => {
    expect(boxState().apply).toBe('serve')
  })

  it('answers the route on /__ff2/box and nothing under it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ff2-box-root-'))
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title>')
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [boxState()],
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    })
    try {
      await server.listen()
      const address = server.httpServer?.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const ok = await fetch(`http://127.0.0.1:${port}${BOX_ROUTE}`)
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { lease: unknown; cpu: { cores: number } }
      expect('lease' in body).toBe(true)
      expect(body.cpu.cores).toBeGreaterThan(0)
      const post = await fetch(`http://127.0.0.1:${port}${BOX_ROUTE}`, { method: 'POST' })
      expect(post.status).toBe(405)
      // A sibling path is not the route: it falls through to Vite, which does not serve JSON for it.
      const under = await fetch(`http://127.0.0.1:${port}${BOX_ROUTE}/x`)
      expect(under.headers.get('content-type') ?? '').not.toContain('application/json')
    } finally {
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)
})
