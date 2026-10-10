// tools/dev/override-writer.mjs — the dev server writes a shipped-course
// override into the repo. DEV-539, plan/SHIPPED-COURSE-EDITS.md §5.
//
// The loop Matt asked for is edit → Save → `git diff content/overrides/`. A
// download would be two steps per iteration, and a stale download can be
// imported over a newer file. So `pnpm dev` accepts
//
//     PUT /__ff2/override/<missionId>     body: the override, as JSON
//
// and writes `content/overrides/<missionId>.json` in canonical bytes. Git is the
// review and the undo; the write is not a commit.
//
// DEV-540 adds the other half of the editor's loop:
//
//     DELETE /__ff2/override/<missionId>  the editor's "Back to 2016"
//     GET    /__ff2/override-hmr          what the watcher delivered and this
//                                         plugin swallowed (read-only)
//
// A delete made here is swallowed as a write made here is: the page that asked
// for it is not reloaded, and neither is any other page on the server — Vite
// broadcasts `full-reload` to EVERY client. The GET is the proof that the
// watcher saw a save at all: a swallow is recorded only when a file event
// reached this plugin's hot-update hook (`editor-shipped.spec.ts` reads it, so
// "the page did not reload" cannot pass because nothing was watched).
//
// ── What it refuses, in order ─────────────────────────────────────────────
//
//   405  anything but PUT or DELETE
//   403  a request with no `Origin`, or one from another origin than the
//        request's host (`Host`, or HTTP/2's `:authority`). `pnpm dev`
//        listens on 0.0.0.0 (the headset is on the LAN), so any device there
//        can reach this; a browser always sends `Origin` on a PUT.
//   404  an id that is not a generated mission. The id is matched against the
//        files in `content/levels/` — an allowlist — and no path from the
//        request is ever used to build the one written.
//   413  a body over MAX_BODY_BYTES
//   400  not JSON; not a valid override (`validateOverride`, the SAME module
//        `loadLevel` runs); a `mission` that is not the URL's; or one that does
//        not fit its baseline (`checkOverride`, then `applyOverride`)
//   409  a `base` that is not the manifest's current line (`baseProblem`): the
//        editor was working on a baseline a re-extraction has since replaced
//   404  (DELETE) no override for that mission to delete
//
// ── It does not exist in a build ─────────────────────────────────────────
//
// `apply: 'serve'`. `vite build` never calls `configureServer`, and this file
// is config-side, so nothing of it is bundled; `tests/unit/override-writer.test.ts`
// says how that was checked.
//
// ── The page it saves from is not reloaded under the author ──────────────
//
// `content/overrides/*.json` is inside a glob the page imports
// (`load-level.ts`), so a write would reach the page as HMR — and nothing on
// that chain accepts an update, so Vite would reload the whole page and the
// editor with it. The plan said to return `[]` from `handleHotUpdate`. **That
// hook is not called for a file that did not exist** (Vite 8 calls
// `handleHotUpdate` only for `type === 'update'`), and the first save of an
// override IS a create — where `vite:import-glob`'s own `hotUpdate` adds the
// glob's importer to the update. So this uses `hotUpdate`, ordered `post` so it
// runs after that plugin, and swallows the update ONLY for bytes this plugin
// just wrote: a hand edit to the same file afterwards reloads as any edit does.
//
// Swallowing is not enough on its own: the importer's cached transform still
// holds the glob as it was, so a NEW override would be invisible to a manual
// reload until the server restarted. The swallowed modules are invalidated —
// their next request re-transforms — without anything being sent to the page.
// `tests/unit/override-writer-hmr.test.ts` measures both halves against a real
// dev server.
//
// ── A Save that moves the course rebuilds the lap server's courses ────────
//
// DEV-544. `content/lap-courses.json` holds every Ring Attack course the lap
// server judges, and `tests/unit/lap-courses.test.ts` goes red the moment a
// shipped mission's course (gates, finish, line, time) differs from it. So a
// PUT or a DELETE that reaches the disk also rebuilds that file, through
// `src/net/lap-courses-text.ts`'s `lapCoursesTextFrom`, the builder the test
// holds to the committed bytes — from the files as they will be AFTER this
// request. Built BEFORE either file is written, so a course the builder
// refuses refuses the Save (500) with nothing on disk. Written only when the
// bytes differ: a notes- or medals-only override moves no lap time, keeps
// every board, and writes nothing. Not on every edit (Matt, 2026-09-30): the
// desk keeps edits in memory and in its draft store; only Save and Back to
// 2016 reach this file. Swallowed like the override: the page that saved is
// not reloaded.
//
// Hard rule 8 forbids `server.headers`; this sets per-response headers only.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The one route. `/__ff2/` because the dev handle is `__ff2` (`src/main.ts`). */
export const OVERRIDE_ROUTE = '/__ff2/override/'

/** DEV-540: the swallow record, read-only. Not under OVERRIDE_ROUTE (no trailing `/`). */
export const OVERRIDE_HMR_ROUTE = '/__ff2/override-hmr'

/**
 * The largest body accepted: an override at the player course's caps (64 line
 * points, 100 rings, long notes) is a few KB, so 64 KB is garbage, not a course.
 */
export const MAX_BODY_BYTES = 64 * 1024

/** The validator's module, as the dev server loads it. */
const VALIDATOR = '/src/content/level-override.ts'

/** DEV-544: the lap courses' builder, as the dev server loads it. */
const LAP_BUILDER = '/src/net/lap-courses-text.ts'

/** DEV-544: the artefact a course-moving Save rebuilds, relative to the root. */
export const LAP_COURSES_PATH = 'content/lap-courses.json'

const MISSION_ID = /^[A-Za-z][A-Za-z0-9_]*$/

const forward = (p) => p.split('\\').join('/')

/** The generated mission ids, read off disk at request time. */
export const generatedIds = (root) =>
  fs
    .readdirSync(path.join(root, 'content', 'levels'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))

/** `<dir>/*.json` without the `_` files, parsed, by basename. */
const jsonFilesIn = (dir) =>
  Object.fromEntries(
    (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort()
      .map((f) => [
        f.slice(0, -'.json'.length),
        JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      ]),
  )

/**
 * DEV-544: `content/lap-courses.json` as it must read once mission `id`'s
 * override is `next` (an override object, or null for none), and whether that
 * differs from the file on disk. Reads every other input fresh from disk.
 */
export const plannedLapCourses = async ({ root, builder, id, next }) => {
  const content = path.join(root, 'content')
  const overrides = jsonFilesIn(path.join(content, 'overrides'))
  if (next === null) delete overrides[id]
  else overrides[id] = next
  const text = await builder.lapCoursesTextFrom({
    generated: jsonFilesIn(path.join(content, 'levels')),
    overrides,
    editions: Object.values(jsonFilesIn(path.join(content, 'editions'))),
    aircraft: Object.values(jsonFilesIn(path.join(content, 'aircraft'))),
  })
  const file = path.join(root, ...LAP_COURSES_PATH.split('/'))
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
  return { file, text, changed: now !== text }
}

const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(`${JSON.stringify(body)}\n`)
}

/** The body, or null past `MAX_BODY_BYTES` (the rest is drained, not buffered). */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) over = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/**
 * The request handler, as a function of the repo root and the validator — so
 * `tests/unit/override-writer.test.ts` drives it against a temp directory with
 * the module imported directly, and the plugin hands it the dev server's
 * `ssrLoadModule`. `onWrite(file, text)` is told before a file is written,
 * and `onDelete(file)` before one is deleted (DEV-540). `loadLapBuilder`
 * (DEV-544) is the lap courses' builder; absent, a Save writes the override
 * alone (the refusal tests' temp root holds two missions, not a course set).
 */
export const createOverrideHandler = ({
  root,
  loadValidator,
  loadLapBuilder = null,
  onWrite = () => {},
  onDelete = () => {},
}) => {
  const overridesDir = path.join(root, 'content', 'overrides')
  /** DEV-544: plan the lap courses for `next`, before anything is written. */
  const planLaps = async (id, next) =>
    loadLapBuilder ? plannedLapCourses({ root, builder: await loadLapBuilder(), id, next }) : null
  /** Write a planned rebuild if it changed anything; what the reply says of it. */
  const writeLaps = (plan) => {
    if (plan === null) return {}
    if (plan.changed) {
      onWrite(forward(plan.file), plan.text)
      fs.writeFileSync(plan.file, plan.text)
    }
    return { lapCourses: { path: LAP_COURSES_PATH, changed: plan.changed } }
  }
  return async (req, res, next) => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (!url.startsWith(OVERRIDE_ROUTE)) return next?.()
    try {
      if (req.method !== 'PUT' && req.method !== 'DELETE') {
        res.setHeader('Allow', 'PUT, DELETE')
        return send(res, 405, { error: 'PUT an override, or DELETE one' })
      }
      const origin = req.headers.origin
      let originHost = null
      try {
        originHost = origin ? new URL(origin).host : null
      } catch {
        originHost = null
      }
      // DEV-540: a BROWSER reaches `pnpm dev` over HTTP/2 (basicSsl's TLS, and
      // Vite serves h2 wherever no proxy is set), and an h2 request has no
      // `Host` header: its host is the `:authority` pseudo-header. Reading
      // `host` alone refused every save the editor made (403), while curl,
      // speaking HTTP/1.1, was let through.
      const host = req.headers.host ?? req.headers[':authority']
      if (!originHost || originHost !== host) {
        return send(res, 403, { error: 'an override is saved from this server’s own page' })
      }
      const id = decodeURIComponent(url.slice(OVERRIDE_ROUTE.length))
      if (!MISSION_ID.test(id) || !generatedIds(root).includes(id)) {
        return send(res, 404, { error: `no generated mission ${JSON.stringify(id)}` })
      }
      if (req.method === 'DELETE') {
        // DEV-540: "Back to 2016". Only the one file the allowlisted id names.
        const file = path.join(overridesDir, `${id}.json`)
        const where = `content/overrides/${id}.json`
        if (!fs.existsSync(file)) return send(res, 404, { error: `no ${where} to delete` })
        const laps = await planLaps(id, null)
        onDelete(forward(file))
        fs.rmSync(file)
        return send(res, 200, { path: where, deleted: true, ...writeLaps(laps) })
      }
      const text = await readBody(req)
      if (text === null) return send(res, 413, { error: `over ${MAX_BODY_BYTES} bytes` })
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return send(res, 400, { error: 'not JSON' })
      }

      const v = await loadValidator()
      const checked = v.validateOverride(body)
      if (!checked.ok) return send(res, 400, { error: 'refused', errors: checked.errors })
      const ov = checked.override
      if (ov.mission !== id) {
        return send(res, 400, { error: `the body names ${ov.mission}; the URL names ${id}` })
      }
      const manifest = fs.readFileSync(path.join(root, 'content', '_generated.sha256'), 'utf8')
      const stale = v.baseProblem(ov, manifest)
      if (stale) return send(res, 409, { error: stale })
      const base = JSON.parse(
        fs.readFileSync(path.join(root, 'content', 'levels', `${id}.json`), 'utf8'),
      )
      const problems = v.checkOverride(base, ov)
      if (problems.length > 0) return send(res, 400, { error: 'refused', errors: problems })
      // The loader's own path, end to end: what is written is what will load.
      v.applyOverride(base, ov)

      const out = v.canonicalOverrideText(ov)
      const file = path.join(overridesDir, `${id}.json`)
      const sha256 = createHash('sha256').update(out).digest('hex')
      const reply = {
        path: `content/overrides/${id}.json`,
        sha256,
        bytes: Buffer.byteLength(out),
      }
      // A re-save with no edit touches nothing, so no watcher fires at all.
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === out) {
        return send(res, 200, { ...reply, unchanged: true })
      }
      // DEV-544: the lap courses this override makes, from what it WILL be.
      const laps = await planLaps(id, JSON.parse(out))
      fs.mkdirSync(overridesDir, { recursive: true })
      onWrite(forward(file), out)
      fs.writeFileSync(file, out)
      return send(res, 200, { ...reply, unchanged: false, ...writeLaps(laps) })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * The Vite plugin. `apply: 'serve'`: it exists only under `pnpm dev`.
 * `enforce: 'post'` and a `post` hot-update hook, so it runs after
 * `vite:import-glob` has added the glob's importer to a create's update.
 * `validator` is the module the dev server loads the validator from; only
 * the HMR measurement, whose server has another root, names another — and
 * passes `lapBuilder: null`, since its root holds no course set (DEV-544).
 */
/** What `written` holds for a file this plugin DELETED (DEV-540). */
const DELETED = Symbol('deleted by the writer')

export const overrideWriter = ({ validator = VALIDATOR, lapBuilder = LAP_BUILDER } = {}) => {
  /** Absolute forward-slash path → the bytes this plugin wrote there last, or DELETED. */
  const written = new Map()
  /** Every update this plugin swallowed, for the measurement (DEV-539). */
  const swallowed = []
  return {
    name: 'ff2:override-writer',
    apply: 'serve',
    enforce: 'post',
    /** Read-only view for `override-writer-hmr.test.ts`. */
    api: { swallowed },
    configureServer(server) {
      server.middlewares.use(
        createOverrideHandler({
          root: server.config.root,
          loadValidator: () => server.ssrLoadModule(validator),
          loadLapBuilder: lapBuilder === null ? null : () => server.ssrLoadModule(lapBuilder),
          onWrite: (file, text) => written.set(file, text),
          onDelete: (file) => written.set(file, DELETED),
        }),
      )
      // DEV-540: the swallow record, for the e2e's proof that the watcher saw the save.
      server.middlewares.use(OVERRIDE_HMR_ROUTE, (req, res, next) => {
        if (req.method !== 'GET') return next()
        return send(res, 200, { swallowed })
      })
    },
    hotUpdate: {
      order: 'post',
      async handler({ type, file, modules, read }) {
        const expected = written.get(forward(file))
        if (expected === undefined) return
        if (
          expected === DELETED
            ? type !== 'delete'
            : type === 'delete' || (await read()) !== expected
        ) {
          // Somebody else's change to the file: it reloads as any edit does.
          written.delete(forward(file))
          return
        }
        const graph = this.environment.moduleGraph
        const seen = new Set()
        for (const mod of modules) graph.invalidateModule(mod, seen)
        swallowed.push({
          environment: this.environment.name,
          type,
          file: forward(file),
          at: Date.now(),
        })
        return []
      },
    },
  }
}
