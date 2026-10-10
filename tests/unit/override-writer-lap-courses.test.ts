// tests/unit/override-writer-lap-courses.test.ts — the shipped desk's Save
// rebuilds `content/lap-courses.json` in the same write. DEV-544.
//
// Matt, 2026-09-30: *"we don't want a new download each edit. so probably just
// when saving manually. you can have a in-memory save every edit."* So the
// dev server's override write (`tools/dev/override-writer.mjs`, DEV-539) also
// rebuilds the lap server's courses when — and only when — the Save moves
// them, and `tests/unit/lap-courses.test.ts`'s byte comparison stays green
// with no manual `node tools/net/write-lap-courses.mjs`.
//
// The handler runs against a temp copy of the content tree, with the REAL
// validator and the REAL builder (`src/net/lap-courses-text.ts`), and the
// repo's own test fixture override, which moves rings, the finish and the time.
// The expectations are read from outside the builder (trap 24): the committed
// file's bytes, and the fixture's own numbers.

import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as validator from '@/content/level-override'
import * as builder from '@/net/lap-courses-text'
import {
  createOverrideHandler,
  LAP_COURSES_PATH,
  OVERRIDE_ROUTE,
  plannedLapCourses,
} from '../../tools/dev/override-writer.mjs'
import { REPO } from './helpers/repo-root'

const ID = 'int_01_hoverJet'
const HOST = '127.0.0.1:5542'
const ORIGIN = `https://${HOST}`
const COMMITTED = fs.readFileSync(path.join(REPO, LAP_COURSES_PATH), 'utf8').replace(/\r\n/g, '\n')

let root = ''
const writes: string[] = []

const copyDir = (rel: string) => {
  const from = path.join(REPO, rel)
  const to = path.join(root, rel)
  fs.mkdirSync(to, { recursive: true })
  for (const f of fs.readdirSync(from)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(from, f), path.join(to, f))
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-override-laps-'))
  for (const rel of ['content/levels', 'content/editions', 'content/aircraft']) copyDir(rel)
  // The override tree as the repo has it, minus any real override of the
  // mission under test, so "Back to 2016" lands on the committed bytes.
  copyDir('content/overrides')
  fs.rmSync(path.join(root, 'content', 'overrides', `${ID}.json`), { force: true })
  for (const f of ['_generated.sha256', 'lap-courses.json']) {
    fs.copyFileSync(path.join(REPO, 'content', f), path.join(root, 'content', f))
  }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const fixture = (): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.join(REPO, 'content', 'overrides', `_fixture_${ID}.json`), 'utf8'),
  )

const lapFile = () => path.join(root, ...LAP_COURSES_PATH.split('/'))
const overrideFile = () => path.join(root, 'content', 'overrides', `${ID}.json`)
const fwd = (p: string) => p.split('\\').join('/')

interface Reply {
  status: number
  body: Record<string, unknown>
}

const request = async (
  method: 'PUT' | 'DELETE',
  body: unknown,
  lapBuilder: () => Promise<Record<string, unknown>> = async () => builder,
): Promise<Reply> => {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(text === '' ? [] : [Buffer.from(text)]) as unknown as IncomingMessage
  Object.assign(req, {
    method,
    url: `${OVERRIDE_ROUTE}${ID}`,
    headers: { host: HOST, origin: ORIGIN },
  })
  const reply: Reply = { status: 0, body: {} }
  let ended: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    ended = resolve
  })
  const res = {
    statusCode: 0,
    setHeader() {},
    end(out: string) {
      reply.status = res.statusCode
      reply.body = JSON.parse(out)
      ended()
    },
  } as unknown as ServerResponse
  await createOverrideHandler({
    root,
    loadValidator: async () => validator,
    loadLapBuilder: lapBuilder,
    onWrite: (file) => writes.push(file),
  })(req, res, ended)
  await done
  return reply
}

interface Courses {
  courses: Record<string, { timeLimit: number; finish: { y: number }; gates: unknown[] }>
}
const parse = (text: string) => JSON.parse(text) as Courses

describe('DEV-544: a Save that moves the course rebuilds content/lap-courses.json', () => {
  it('reads the repo the way the check does: with no change planned, nothing would be written', async () => {
    // The writer's own reader over the REAL tree, planning a change for no
    // mission: the bytes it would write are the committed ones. If the Save's
    // path and `lap-courses.test.ts`'s ever disagree, this goes red first.
    const plan = await plannedLapCourses({ root: REPO, builder, id: '_nobody', next: null })
    expect(plan.changed).toBe(false)
    expect(plan.text).toBe(COMMITTED)
  })

  it('a course-moving Save writes the override AND the lap courses, in one request', async () => {
    writes.length = 0
    const reply = await request('PUT', fixture())
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(reply.body.lapCourses).toEqual({ path: LAP_COURSES_PATH, changed: true })
    // Both told before they were written (the HMR swallow's premise), the override first.
    expect(writes).toEqual([fwd(overrideFile()), fwd(lapFile())])
    const was = parse(COMMITTED).courses[ID]
    const now = parse(fs.readFileSync(lapFile(), 'utf8')).courses[ID]
    // The fixture's own numbers, not the builder's: its time, and its finish height.
    const ov = fixture() as { timer: { timeLimit: number }; finish: { pos: number[] } }
    expect(now?.timeLimit).toBe(ov.timer.timeLimit)
    expect(was?.timeLimit).not.toBe(ov.timer.timeLimit)
    expect(now?.finish.y).toBe(ov.finish.pos[1])
    expect(was?.finish.y).not.toBe(ov.finish.pos[1])
    // Every OTHER course is byte-for-byte the committed one.
    const others = (c: Courses) =>
      JSON.stringify(Object.entries(c.courses).filter(([id]) => id !== ID))
    expect(others(parse(fs.readFileSync(lapFile(), 'utf8')))).toBe(others(parse(COMMITTED)))
  })

  it('a re-save with no edit touches neither file', async () => {
    writes.length = 0
    const before = fs.statSync(lapFile()).mtimeMs
    const reply = await request('PUT', fixture())
    expect(reply.status).toBe(200)
    expect(reply.body.unchanged).toBe(true)
    expect(reply.body.lapCourses).toBeUndefined()
    expect(writes).toEqual([])
    expect(fs.statSync(lapFile()).mtimeMs).toBe(before)
  })

  it('a notes-only Save writes the override and leaves the lap courses alone', async () => {
    const lapsBefore = fs.readFileSync(lapFile(), 'utf8')
    const ov = fixture() as { notes: { at: string; what: string }[] }
    ov.notes = [...ov.notes, { at: '2026-09-30', what: 'DEV-544: a note moves no lap time.' }]
    writes.length = 0
    const reply = await request('PUT', ov)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(reply.body.unchanged).toBe(false)
    expect(reply.body.lapCourses).toEqual({ path: LAP_COURSES_PATH, changed: false })
    expect(writes).toEqual([fwd(overrideFile())])
    expect(fs.readFileSync(lapFile(), 'utf8')).toBe(lapsBefore)
  })

  it('a builder that refuses the course refuses the Save, with nothing written', async () => {
    const overrideBefore = fs.readFileSync(overrideFile(), 'utf8')
    const lapsBefore = fs.readFileSync(lapFile(), 'utf8')
    writes.length = 0
    const reply = await request('PUT', fixture(), async () => ({
      lapCoursesTextFrom: async () => {
        throw new Error('lap-courses: refused')
      },
    }))
    expect(reply.status).toBe(500)
    expect(reply.body.error).toContain('refused')
    expect(writes).toEqual([])
    expect(fs.readFileSync(overrideFile(), 'utf8')).toBe(overrideBefore)
    expect(fs.readFileSync(lapFile(), 'utf8')).toBe(lapsBefore)
  })

  it('Back to 2016 deletes the override and puts the committed lap courses back', async () => {
    writes.length = 0
    const reply = await request('DELETE', undefined)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    expect(reply.body.deleted).toBe(true)
    expect(reply.body.lapCourses).toEqual({ path: LAP_COURSES_PATH, changed: true })
    expect(fs.existsSync(overrideFile())).toBe(false)
    expect(writes).toEqual([fwd(lapFile())])
    expect(fs.readFileSync(lapFile(), 'utf8')).toBe(COMMITTED)
  })
})
