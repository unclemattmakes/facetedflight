// tests/unit/override-writer.test.ts — the dev server's override write, as a
// handler, against a temp directory. DEV-539, plan/SHIPPED-COURSE-EDITS.md §5.
//
// The handler is `tools/dev/override-writer.mjs`'s `createOverrideHandler`,
// driven with the validator imported directly (the plugin hands it the dev
// server's `ssrLoadModule` of the same file). The temp root holds a copy of the
// real manifest and two real generated missions, so every refusal below is the
// real validator refusing a real baseline.
//
// Whether a write reloads the page is a question about a live dev server, and
// `override-writer-hmr.test.ts` answers it there.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as validator from '@/content/level-override'
import {
  createOverrideHandler,
  MAX_BODY_BYTES,
  OVERRIDE_ROUTE,
  overrideWriter,
} from '../../tools/dev/override-writer.mjs'
import { REPO } from './helpers/repo-root'

const ID = 'int_01_hoverJet'
const HOST = '192.168.1.20:5173'
const ORIGIN = `https://${HOST}`

let root = ''
const writes: [string, string][] = []
/** DEV-540: what the handler said it was about to delete. */
const deletes: string[] = []

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-override-writer-'))
  fs.mkdirSync(path.join(root, 'content', 'levels'), { recursive: true })
  for (const id of [ID, 'int_01_jumpSeat']) {
    fs.copyFileSync(
      path.join(REPO, 'content', 'levels', `${id}.json`),
      path.join(root, 'content', 'levels', `${id}.json`),
    )
  }
  // The format's schema sits beside the missions in the real tree; it is not one.
  fs.copyFileSync(
    path.join(REPO, 'content', 'levels', '_schema.json'),
    path.join(root, 'content', 'levels', '_schema.json'),
  )
  fs.copyFileSync(
    path.join(REPO, 'content', '_generated.sha256'),
    path.join(root, 'content', '_generated.sha256'),
  )
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const fixture = (): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(REPO, 'content', 'overrides', `_fixture_${ID}.json`), 'utf8'),
  )

interface Reply {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
  nexted: boolean
}

/** One request through the handler: a readable body, and a response that records. */
const request = async (
  opts: {
    method?: string
    url?: string
    origin?: string | null
    /** Null: no `Host` header, as an HTTP/2 request has none. */
    host?: string | null
    /** HTTP/2's `:authority` pseudo-header (DEV-540). */
    authority?: string
    body?: string | Buffer
  } = {},
): Promise<Reply> => {
  const body = opts.body ?? ''
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(req, {
    method: opts.method ?? 'PUT',
    url: opts.url ?? `${OVERRIDE_ROUTE}${ID}`,
    headers: {
      ...(opts.host === null ? {} : { host: opts.host ?? HOST }),
      ...(opts.authority === undefined ? {} : { ':authority': opts.authority }),
      ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
    },
  })
  const reply: Reply = { status: 0, headers: {}, body: {}, nexted: false }
  let ended: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    ended = resolve
  })
  const res = {
    statusCode: 0,
    setHeader(k: string, v: string) {
      reply.headers[k.toLowerCase()] = v
    },
    end(text: string) {
      reply.status = res.statusCode
      reply.body = JSON.parse(text)
      ended()
    },
  } as unknown as ServerResponse
  const handler = createOverrideHandler({
    root,
    loadValidator: async () => validator,
    onWrite: (file, text) => writes.push([file, text]),
    onDelete: (file) => deletes.push(file),
  })
  await handler(req, res, () => {
    reply.nexted = true
    ended()
  })
  await done
  return reply
}

const put = (body: unknown, extra: Parameters<typeof request>[0] = {}) =>
  request({ body: JSON.stringify(body), ...extra })

const written = () => path.join(root, 'content', 'overrides', `${ID}.json`)

describe('PUT /__ff2/override/<id> writes the override (§5)', () => {
  it('writes canonical bytes, whatever order and precision the editor sent', async () => {
    // The editor's object: keys in another order, a quaternion un-normalised
    // and with w < 0, a position off the grid.
    const ov = fixture()
    const rings = ov.rings as { move: Record<string, { pos: number[]; quat: number[] }> }
    const [key, pose] = Object.entries(rings.move)[0] as [string, { pos: number[]; quat: number[] }]
    const messy = {
      ...Object.fromEntries(Object.entries(ov).reverse()),
      rings: {
        ...rings,
        move: {
          [key]: {
            pos: pose.pos.map((x) => x + 0.0004),
            quat: pose.quat.map((x) => -2 * x),
          },
        },
      },
    }
    writes.length = 0
    const reply = await put(messy)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    const text = fs.readFileSync(written(), 'utf8')
    const checked = validator.validateOverride(fixture())
    if (!checked.ok) throw new Error('fixture refused')
    // The same bytes the repo's own fixture holds: the grid and the sign are canonical.
    expect(text).toBe(validator.canonicalOverrideText(checked.override))
    expect(reply.body).toEqual({
      path: `content/overrides/${ID}.json`,
      sha256: createHash('sha256').update(text).digest('hex'),
      bytes: Buffer.byteLength(text),
      unchanged: false,
    })
    expect(reply.headers['content-type']).toContain('application/json')
    // Told before the write, with the bytes written: the HMR swallow's premise.
    expect(writes).toEqual([[written().split('\\').join('/'), text]])
  })

  it('touches nothing on a re-save with no edit', async () => {
    const before = fs.statSync(written()).mtimeMs
    writes.length = 0
    const reply = await put(fixture())
    expect(reply.status).toBe(200)
    expect(reply.body.unchanged).toBe(true)
    expect(writes).toEqual([])
    expect(fs.statSync(written()).mtimeMs).toBe(before)
  })

  // DEV-540: the editor's own Save was refused 403 in a real browser, which
  // speaks HTTP/2 to `pnpm dev`: an h2 request has no `Host`, only `:authority`.
  it('accepts a browser’s HTTP/2 request, whose host is its :authority', async () => {
    const reply = await put(fixture(), { host: null, authority: HOST })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
  })

  it('and refuses one from another origin over HTTP/2 as over HTTP/1.1', async () => {
    const reply = await put(fixture(), {
      host: null,
      authority: HOST,
      origin: 'https://evil.example',
    })
    expect(reply.status).toBe(403)
    expect((await put(fixture(), { host: null })).status, 'no host at all').toBe(403)
  })

  it('passes every other URL on', async () => {
    const reply = await request({ url: '/src/main.ts', method: 'GET' })
    expect(reply.nexted).toBe(true)
  })
})

describe('what it refuses (§5)', () => {
  it.each([
    ['anything but PUT', { method: 'POST', body: '{}' }, 405],
    ['a request with no Origin', { origin: null, body: '{}' }, 403],
    ['another origin', { origin: 'https://evil.example', body: '{}' }, 403],
    ['a malformed Origin', { origin: 'not a url', body: '{}' }, 403],
    ['an id that is not a generated mission', { url: `${OVERRIDE_ROUTE}nope`, body: '{}' }, 404],
    ['a path', { url: `${OVERRIDE_ROUTE}..%2F..%2Fsrc%2Fmain`, body: '{}' }, 404],
    ['the levels schema', { url: `${OVERRIDE_ROUTE}_schema`, body: '{}' }, 404],
    ['a body past the cap', { body: 'x'.repeat(MAX_BODY_BYTES + 1) }, 413],
    ['a body that is not JSON', { body: '{"v": 1' }, 400],
  ] as const)('refuses %s', async (_name, opts, status) => {
    const reply = await request(opts)
    expect(reply.status, JSON.stringify(reply.body)).toBe(status)
  })

  it('answers a refused method with the one it accepts', async () => {
    expect((await request({ method: 'GET' })).headers.allow).toBe('PUT, DELETE')
  })

  it('refuses a field off the closed list, with the validator’s own words', async () => {
    const reply = await put({ ...fixture(), fog: {} })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body.errors)).toContain('is not an overridable field')
  })

  it('refuses a body that names another mission than the URL', async () => {
    const reply = await put(fixture(), { url: `${OVERRIDE_ROUTE}int_01_jumpSeat` })
    expect(reply.status).toBe(400)
    expect(String(reply.body.error)).toContain('the URL names int_01_jumpSeat')
  })

  it('refuses, 409, an override made against a baseline the manifest has moved on from', async () => {
    const reply = await put({ ...fixture(), base: 'f'.repeat(64) })
    expect(reply.status).toBe(409)
    expect(String(reply.body.error)).toContain('the baseline moved under this override')
  })

  it('refuses what does not fit the baseline', async () => {
    const reply = await put({
      ...fixture(),
      rings: { move: { '424242': { pos: [0, 0, 0], quat: [0, 0, 0, 1] } } },
    })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body.errors)).toContain('names no ring in the baseline')
  })

  it('never writes outside content/overrides/, and never on a refusal', async () => {
    const dir = path.join(root, 'content', 'overrides')
    const before = fs.readdirSync(dir).sort()
    await put({ ...fixture(), fog: {} })
    await request({ url: `${OVERRIDE_ROUTE}..%2Fescape`, body: JSON.stringify(fixture()) })
    expect(fs.readdirSync(dir).sort()).toEqual(before)
    expect(fs.readdirSync(path.join(root, 'content')).sort()).toEqual([
      '_generated.sha256',
      'levels',
      'overrides',
    ])
  })
})

// DEV-540: the editor's "Back to 2016" deletes the file through the same door,
// so the plugin can swallow the delete as it swallows its own writes.
describe('DELETE /__ff2/override/<id> takes the override away (DEV-540)', () => {
  it('deletes only the file the allowlisted id names, and says so first', async () => {
    expect((await put(fixture())).status).toBe(200)
    expect(fs.existsSync(written())).toBe(true)
    deletes.length = 0
    const reply = await request({ method: 'DELETE' })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(reply.body).toEqual({ path: `content/overrides/${ID}.json`, deleted: true })
    expect(fs.existsSync(written())).toBe(false)
    expect(deletes).toEqual([written().split('\\').join('/')])
    // The format's own files stand.
    expect(fs.existsSync(path.join(root, 'content', 'levels', `${ID}.json`))).toBe(true)
  })

  it.each([
    ['nothing to delete', {}, 404],
    ['another origin', { origin: 'https://evil.example' }, 403],
    ['no Origin', { origin: null }, 403],
    ['a path', { url: `${OVERRIDE_ROUTE}..%2F..%2Fcontent%2Flevels%2F${ID}` }, 404],
    ['the levels schema', { url: `${OVERRIDE_ROUTE}_schema` }, 404],
  ] as const)('refuses %s', async (_name, opts, status) => {
    deletes.length = 0
    const reply = await request({ method: 'DELETE', ...opts })
    expect(reply.status, JSON.stringify(reply.body)).toBe(status)
    expect(deletes).toEqual([])
    expect(fs.existsSync(path.join(root, 'content', 'levels', `${ID}.json`))).toBe(true)
  })
})

describe('the plugin exists only under `pnpm dev`', () => {
  it('is a serve-only plugin that runs after vite:import-glob', () => {
    const plugin = overrideWriter()
    expect(plugin.apply).toBe('serve')
    expect(plugin.enforce).toBe('post')
    expect((plugin.hotUpdate as { order?: string }).order).toBe('post')
    // `handleHotUpdate` is NOT the hook: Vite 8 never calls it for a create,
    // and an override's first save is one (DEV-539).
    expect(plugin.handleHotUpdate).toBeUndefined()
  })

  it('is registered in vite.config.ts, which sets no server.headers (hard rule 8)', () => {
    const config = fs.readFileSync(path.join(REPO, 'vite.config.ts'), 'utf8')
    expect(config).toContain('overrideWriter()')
    expect(config).not.toMatch(/\bheaders\s*:\s*\{\s*['"]?Cross-Origin/)
  })
})
