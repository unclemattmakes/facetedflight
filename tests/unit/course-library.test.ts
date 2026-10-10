// tests/unit/course-library.test.ts — DEV-467: "Your courses", the IndexedDB
// store (`src/game/course-library.ts`).
//
// Node has no IndexedDB, so the store's LOGIC is held here over the memory
// backend, and its WRAPPING — that a factory which is absent, throws, errors
// or blocks leaves a library that works in memory rather than a boot that
// fails — over hand-made factories that do exactly those things. The real
// IndexedDB path is `tests/e2e/player-course-share.spec.ts`'s: a course
// opened there is listed after a reload.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { type PlayerCourse, playerCourseId } from '@/content/player-course'
import {
  COURSE_LIBRARY_DB,
  courseTitle,
  createCourseLibrary,
  entryFrom,
  memoryBackend,
  openCourseDb,
  openCourseLibrary,
} from '@/game/course-library'
import { REPO } from '../../tools/test/import-graph.mjs'

type V = [number, number, number]
const int01 = JSON.parse(
  fs.readFileSync(path.join(REPO, 'content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
) as Level

const course = (name: [string, string], shift = 0): PlayerCourse => {
  const route = int01.route as V[]
  const points = [0, 40, 80, 120].map((i) => {
    const p = route[i] as V
    return [p[0] + shift, p[1], p[2]] as V
  })
  return {
    v: 2,
    island: 'simonet',
    sky: 'int_01_hoverJet',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points, gap: 300 },
    rings: [],
    start: { pos: points[0] as V, yaw: 0 },
    finish: { t: 1 },
    timeLimit: 120,
    name,
  }
}

const A = course(['Amber', 'Heron'])
const B = course(['Amber', 'Heron'], 10)

describe('DEV-467 — the course library', () => {
  it('pins the database name, version and store', () => {
    // DEV-490: version 2 adds the maps store beside the courses.
    expect(COURSE_LIBRARY_DB).toEqual({
      name: 'ff2-courses',
      version: 2,
      store: 'courses',
      maps: 'maps',
    })
  })

  it('puts, lists newest first, gets, deletes', async () => {
    let t = 1000
    const lib = createCourseLibrary(memoryBackend(), () => t)
    expect(await lib.list()).toEqual([])
    const a = await lib.put(A, 'link')
    t = 2000
    const b = await lib.put(B, 'file')
    expect(a?.id).toBe(playerCourseId(A))
    expect(b?.id).toBe(playerCourseId(B))
    expect(a?.id).not.toBe(b?.id)
    expect((await lib.list()).map((e) => e.id)).toEqual([b?.id, a?.id])
    const got = await lib.get(playerCourseId(A))
    expect(got).toMatchObject({
      name: 'Amber Heron',
      island: 'simonet',
      source: 'link',
      date: 1000,
    })
    expect(await lib.delete(playerCourseId(A))).toBe(true)
    expect(await lib.delete(playerCourseId(A))).toBe(false)
    expect((await lib.list()).map((e) => e.id)).toEqual([b?.id])
  })

  it('a second put keeps the FIRST source and takes the new date', async () => {
    let t = 1
    const lib = createCourseLibrary(memoryBackend(), () => t)
    await lib.put(A, 'link')
    t = 5
    const again = await lib.put(A, 'file')
    expect(again).toMatchObject({ source: 'link', date: 5 })
    expect((await lib.list()).length).toBe(1)
  })

  it('refuses to keep a course that does not validate', async () => {
    const lib = createCourseLibrary(memoryBackend())
    expect(await lib.put({ ...A, timeLimit: -1 }, 'file')).toBeNull()
    expect(await lib.list()).toEqual([])
  })

  it('a record edited in devtools is absent, not believed', async () => {
    const good = await createCourseLibrary(memoryBackend(), () => 7).put(A, 'made-here')
    expect(entryFrom(good)).not.toBeNull()
    expect(entryFrom({ ...good, id: 'pc_000000000000' })).toBeNull()
    expect(entryFrom({ ...good, source: 'server' })).toBeNull()
    expect(entryFrom({ ...good, date: 'yesterday' })).toBeNull()
    expect(entryFrom({ ...good, course: { ...A, v: 9 } })).toBeNull()
    expect(entryFrom(null)).toBeNull()
    expect(entryFrom('pc_x')).toBeNull()
  })

  it('titles a course by its two words', () => {
    expect(courseTitle(A)).toBe('Amber Heron')
  })
})

describe('DEV-467 — no IndexedDB is a library in memory, never a failed boot', () => {
  /** A request that fires `onerror` (or `onblocked`) on the next turn. */
  const failing = (event: 'onerror' | 'onblocked') =>
    ({
      open() {
        const req: Record<string, unknown> = {}
        setTimeout(() =>
          (req[event] as ((e: unknown) => void) | undefined)?.({ preventDefault() {} }),
        )
        return req
      },
    }) as unknown as IDBFactory

  it('absent', async () => {
    expect(await openCourseDb(undefined)).toBeNull()
  })

  it('throws on open (a private window, some browsers)', async () => {
    const throwing = {
      open() {
        throw new DOMException('denied', 'SecurityError')
      },
    } as unknown as IDBFactory
    expect(await openCourseDb(throwing)).toBeNull()
    const lib = await openCourseLibrary(throwing)
    expect(lib.durable).toBe(false)
    // …and it still works, for this session.
    await lib.put(A, 'link')
    expect((await lib.list()).map((e) => e.id)).toEqual([playerCourseId(A)])
  })

  it('errors, or is blocked by another tab', async () => {
    expect(await openCourseDb(failing('onerror'))).toBeNull()
    expect(await openCourseDb(failing('onblocked'))).toBeNull()
    expect((await openCourseLibrary(failing('onerror'))).durable).toBe(false)
  })
})
