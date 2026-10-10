// tests/unit/override-writer-hmr.test.ts — does a Save reload the page it was
// made on? DEV-539 measures the plan's one open claim (SHIPPED-COURSE-EDITS §5,
// "[inferred, must be measured]").
//
// ── What is measured, and why here rather than in a browser ─────────────────
//
// A page reloads under Vite for exactly one reason: the dev server sends it a
// `full-reload` (or an `update`) over the HMR WebSocket. So this starts a REAL
// dev server (`createServer`, this repo's Vite, the real plugin), opens the
// page's own channel to it — a WebSocket on the `vite-hmr` protocol, with the
// server's token, which is what `/@vite/client` opens — and records every
// message the server sends. A page is stood up the way the game's is: an entry
// module importing a module that globs `/content/overrides/*.json`, exactly
// `load-level.ts`'s pattern, pulled into the client module graph.
//
// It could not be measured from a worktree's own `pnpm dev`: DEV-255's watch
// ignore (`**/.claude/worktrees/**`) meant that server saw NO file change under
// a worktree, so a "no reload" there was true of every write and proved
// nothing. (DEV-540 anchored the ignore to the checkout's root, so it now sees
// its own tree.) The server here is rooted in a temp directory, which the
// watcher does see — and the controls prove it does.
//
// ── Four arms, each POSITIVE ────────────────────────────────────────────────
//
//   A  control: a file CREATED by hand in the glob → the page gets a full-reload.
//   B  the plugin CREATES an override → the plugin reports it swallowed that
//      update (evidence the watcher fired), and the page got nothing. And the
//      glob's importer re-transforms with the new file in it: a manual reload
//      would see the override (the swallow invalidates without sending).
//   C  the plugin UPDATES it, with the file's module in the page's graph (as it
//      is once the game has loaded it) → swallowed, the page got nothing.
//   D  control: the SAME file edited by hand, same graph → the page reloads.
//   E  (DEV-540) the plugin DELETES it (the editor's "Back to 2016") →
//      swallowed, served on `GET /__ff2/override-hmr`, the page got nothing.
//   F  (DEV-540) control: the same file deleted by hand → the page reloads.
//
// B without A, or C without D, would be an absence nobody showed could have
// been a presence.
//
// ── And it separates (2026-09-30, Vite 8.2.2, run once each, not kept) ──────
//
// With the plugin's `hotUpdate` removed, B and C each received a full-reload.
// With the plan's own design — `handleHotUpdate` returning `[]` — C was
// swallowed and B was NOT: a create never reaches that hook, and an override's
// first save is a create. With the swallow but without the invalidation, B's
// assertion on the loader's next transform failed: the new file was not in it.

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { overrideWriter } from '../../tools/dev/override-writer.mjs'
import { REPO } from './helpers/repo-root'

const ID = 'int_01_hoverJet'
const fwd = (p: string): string => p.split(path.sep).join('/')

let root = ''
let server: ViteDevServer
let socket: WebSocket
let port = 0
// `lapBuilder: null` (DEV-544): this root holds one mission, not the course
// set the lap courses are built from; `override-writer-lap-courses.test.ts`
// drives that rebuild, and the swallow below is the same map for both files.
const plugin = overrideWriter({
  validator: fwd(path.join(REPO, 'src/content/level-override.ts')),
  lapBuilder: null,
})
const messages: { at: number; type: string; path?: string }[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll until `ok()` or throw after `ms`. */
const until = async (ok: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

/** The messages that reload or patch the page, since `t`. */
const reloadsSince = (t: number) =>
  messages.filter((m) => m.at >= t && (m.type === 'full-reload' || m.type === 'update'))

/** Put the page's modules in the client graph, as a browser loading it would. */
const loadPage = async (...extra: string[]): Promise<void> => {
  const env = server.environments.client
  for (const url of ['/main.js', '/loader.js', ...extra]) await env.transformRequest(url)
}

const putOverride = (body: unknown): Promise<number> =>
  new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/__ff2/override/${ID}`,
        headers: {
          origin: `http://127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(text)
  })

const fixture = (): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(REPO, 'content', 'overrides', `_fixture_${ID}.json`), 'utf8'),
  )

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-override-hmr-'))
  fs.mkdirSync(path.join(root, 'content', 'levels'), { recursive: true })
  fs.mkdirSync(path.join(root, 'content', 'overrides'), { recursive: true })
  fs.copyFileSync(
    path.join(REPO, 'content', 'levels', `${ID}.json`),
    path.join(root, 'content', 'levels', `${ID}.json`),
  )
  fs.copyFileSync(
    path.join(REPO, 'content', '_generated.sha256'),
    path.join(root, 'content', '_generated.sha256'),
  )
  // The page: an entry, and a loader globbing the override tree as load-level.ts does.
  fs.writeFileSync(
    path.join(root, 'main.js'),
    "import { ids } from './loader.js'\nexport default ids\n",
  )
  fs.writeFileSync(
    path.join(root, 'loader.js'),
    "export const overrides = import.meta.glob(['/content/overrides/*.json', '!/content/overrides/_*.json'])\n" +
      'export const ids = () => Object.keys(overrides)\n',
  )
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    resolve: { alias: { '@': fwd(path.join(REPO, 'src')) } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [plugin],
  })
  await server.listen()
  const address = server.httpServer?.address()
  port = typeof address === 'object' && address ? address.port : 0
  socket = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`,
    'vite-hmr',
  )
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; path?: string }
    messages.push({ at: Date.now(), type: m.type, ...(m.path ? { path: m.path } : {}) })
  })
  await until(() => messages.some((m) => m.type === 'connected'), 10_000, 'the HMR socket')
}, 30_000)

afterAll(async () => {
  socket?.close()
  await server?.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a Save does not reload the editor page (DEV-539, measured)', () => {
  it('A (control): a file CREATED by hand in the glob reloads the page', async () => {
    await loadPage()
    const t = Date.now()
    fs.writeFileSync(path.join(root, 'content', 'overrides', 'adv_01_hoverJet.json'), '{}\n')
    await until(() => reloadsSince(t).length > 0, 10_000, 'the control reload')
    expect(reloadsSince(t)[0]?.type).toBe('full-reload')
  }, 20_000)

  it('B: the plugin CREATING an override is swallowed, and the next load sees it', async () => {
    await loadPage()
    await sleep(300) // let arm A's events settle before this arm's clock starts
    const t = Date.now()
    expect(await putOverride(fixture())).toBe(200)
    const file = fwd(path.join(root, 'content', 'overrides', `${ID}.json`))
    await until(
      () => plugin.api.swallowed.some((s) => s.file === file && s.type === 'create' && s.at >= t),
      10_000,
      'the plugin to see its own create',
    )
    await sleep(500)
    expect(reloadsSince(t)).toEqual([])
    // Invalidated without a message: the loader's next transform has the new file.
    const loader = await server.environments.client.transformRequest('/loader.js')
    expect(loader?.code).toContain(`/content/overrides/${ID}.json`)
  }, 20_000)

  it('C: the plugin UPDATING it, with its module in the page, is swallowed', async () => {
    const url = `/content/overrides/${ID}.json`
    await loadPage(url)
    await sleep(300)
    const t = Date.now()
    const changed = { ...fixture(), timer: { timeLimit: 160, bonusParTime: 160 } }
    expect(await putOverride(changed)).toBe(200)
    const file = fwd(path.join(root, 'content', 'overrides', `${ID}.json`))
    await until(
      () => plugin.api.swallowed.some((s) => s.file === file && s.type === 'update' && s.at >= t),
      10_000,
      'the plugin to see its own update',
    )
    await sleep(500)
    expect(reloadsSince(t)).toEqual([])
  }, 20_000)

  it('D (control): the same file edited BY HAND, same page, reloads it', async () => {
    const url = `/content/overrides/${ID}.json`
    await loadPage(url)
    await sleep(300)
    const t = Date.now()
    const file = path.join(root, 'content', 'overrides', `${ID}.json`)
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('"timeLimit": 160', '"timeLimit": 150'),
    )
    await until(() => reloadsSince(t).length > 0, 10_000, 'the hand-edit reload')
    expect(reloadsSince(t)[0]?.type).toBe('full-reload')
  }, 20_000)
})

// DEV-540: the editor's "Back to 2016" is a DELETE through the plugin, and it
// must not reload a page either — nor any OTHER page on the server, which a
// `full-reload` broadcast would. Two more arms, the same shape as B and A.
const deleteOverride = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'DELETE',
        path: `/__ff2/override/${ID}`,
        headers: { origin: `http://127.0.0.1:${port}` },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })

/** The swallow record as the dev server serves it (`GET /__ff2/override-hmr`). */
const swallowRecord = (): Promise<{ type: string; file: string }[]> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/__ff2/override-hmr' }, (res) => {
        let text = ''
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => resolve((JSON.parse(text) as { swallowed: never[] }).swallowed))
      })
      .on('error', reject)
  })

describe('"Back to 2016" does not reload a page either (DEV-540, measured)', () => {
  const file = () => fwd(path.join(root, 'content', 'overrides', `${ID}.json`))

  it('E: the plugin DELETING its override is swallowed, and the record is served', async () => {
    await loadPage()
    expect(await putOverride(fixture())).toBe(200)
    await sleep(600) // the write's own event, swallowed, before this arm's clock
    const t = Date.now()
    expect(await deleteOverride()).toBe(200)
    await until(
      () => plugin.api.swallowed.some((s) => s.file === file() && s.type === 'delete' && s.at >= t),
      10_000,
      'the plugin to see its own delete',
    )
    await sleep(500)
    expect(reloadsSince(t)).toEqual([])
    expect(fs.existsSync(file())).toBe(false)
    const served = await swallowRecord()
    expect(served.some((s) => s.file === file() && s.type === 'delete')).toBe(true)
    // The loader's next transform no longer has it.
    const loader = await server.environments.client.transformRequest('/loader.js')
    expect(loader?.code).not.toContain(`/content/overrides/${ID}.json`)
  }, 20_000)

  it('F (control): the same file deleted BY HAND reloads the page', async () => {
    await loadPage()
    expect(await putOverride(fixture())).toBe(200)
    await sleep(600)
    const t = Date.now()
    fs.rmSync(file())
    await until(() => reloadsSince(t).length > 0, 10_000, 'the hand-delete reload')
    expect(reloadsSince(t)[0]?.type).toBe('full-reload')
  }, 20_000)
})
