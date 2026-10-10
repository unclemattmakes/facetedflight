// src/game/course-library.ts — "Your courses": every player course this
// browser has loaded or saved, kept in IndexedDB. DEV-467, E1.
//
// docs/plan/EDITOR.md §5.6: *"Pick once."* A course opened from a link or a
// file goes in here under its id, and the title lists it from then on, so a
// course loaded on the desktop can be chosen again without the picker — which
// is what makes a desktop dialog bearable for a player about to put a headset
// on.
//
// ── IndexedDB, not localStorage ──────────────────────────────────────────
//
// §5.6's reason: a T1.5 course carries its heightmap, megabytes against
// localStorage's ~5 MB. A v1 course is ~1 KB, so today it would fit either;
// the store is the one the next tier needs.
//
// ── Wrapped, every call ──────────────────────────────────────────────────
//
// IndexedDB is absent in some webviews, THROWS on open in a private window in
// some browsers, and can fail any request later (quota, a blocked upgrade).
// The game must boot without it. So every call is inside a try and every
// request's error resolves rather than rejects; when the database cannot be
// opened the library falls back to memory, which keeps this session's courses
// listed and says so (`durable: false`). Nothing here ever throws to a caller.
//
// ── Untrusted, on the way back out ───────────────────────────────────────
//
// The database is visible and editable in devtools, so a record read back is
// held to what was written: the course validates (structurally), and its id
// is the id of that course. A record that fails is ABSENT, as a lap that fails
// is in `ghost-store.ts`.

import { heightmapSha } from '@/content/island-map'
import {
  legacyPlayerCourseId,
  type PlayerCourse,
  playerCourseId,
  validatePlayerCourse,
} from '@/content/player-course'

/** Where a course came from, the first time this browser saw it. */
export type CourseSource = 'link' | 'file' | 'made-here'

const SOURCES: ReadonlySet<string> = new Set<CourseSource>(['link', 'file', 'made-here'])

/** One course in the library. */
export interface LibraryEntry {
  /** `playerCourseId(course)`: the key. */
  readonly id: string
  readonly course: PlayerCourse
  /** Its two words, as a title reads them: `Amber Heron`. */
  readonly name: string
  /** The island, an environment id. */
  readonly island: string
  /** When it was last put here, ms since the epoch. The list is newest first. */
  readonly date: number
  /** Where it came from the FIRST time; a later put keeps it. */
  readonly source: CourseSource
}

export interface CourseLibrary {
  /** Every course, newest first. Empty when there is nothing, or no store. */
  list(): Promise<readonly LibraryEntry[]>
  get(id: string): Promise<LibraryEntry | null>
  /**
   * Keep a course (already validated by the caller's door). An existing entry
   * keeps its first source and takes the new date. Null only when the course
   * does not validate.
   */
  put(course: PlayerCourse, source: CourseSource): Promise<LibraryEntry | null>
  /** True when an entry was there to delete. */
  delete(id: string): Promise<boolean>
  /**
   * DEV-490: keep a heightmap's bytes under their SHA-256, the key a course's
   * `island.map` names. False when the bytes are not that SHA's, or the store
   * said no.
   */
  putMap(sha: string, bytes: Uint8Array): Promise<boolean>
  /**
   * DEV-490: a heightmap's bytes, or null. Held to its key on the way out: a
   * record whose bytes are not the SHA it is kept under is ABSENT.
   */
  getMap(sha: string): Promise<Uint8Array | null>
  /** False when IndexedDB could not be opened: this session's courses, in memory. */
  readonly durable: boolean
}

/** The database's name, version and store. */
export const COURSE_LIBRARY_DB = {
  name: 'ff2-courses',
  /** 2 (DEV-490): the maps store beside the courses. The upgrade only adds it. */
  version: 2,
  store: 'courses',
  /** DEV-490: imported heightmaps, `{ sha, bytes }`, keyed by their SHA-256. */
  maps: 'maps',
} as const

/** A raw record, as stored: exactly an entry. */
type Row = LibraryEntry

/** The storage under the library: whole rows in and out, never throwing. */
export interface LibraryBackend {
  all(): Promise<readonly unknown[]>
  one(id: string): Promise<unknown>
  save(row: Row): Promise<boolean>
  remove(id: string): Promise<boolean>
  /** DEV-490: a map record in, and one out (untrusted: `getMap` checks it). */
  saveMap(sha: string, bytes: Uint8Array): Promise<boolean>
  oneMap(sha: string): Promise<unknown>
  readonly durable: boolean
}

/**
 * A row read back, held to what could have been written; null for anything else.
 *
 * DEV-475: a row written before v2 holds a v1 course under its v1 id. It reads
 * as the v2 course the validator migrates it to, under the v2 id — so the
 * entry is kept, keyed anew — provided the row's id is the v1 id OF that v1
 * course (`legacyPlayerCourseId`), which is the check a v2 row gets against
 * its own id. `list` writes such an entry back under its new key.
 */
export const entryFrom = (raw: unknown): LibraryEntry | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const checked = validatePlayerCourse(r.course)
  if (!checked.ok) return null
  const course = checked.course
  const id = playerCourseId(course)
  if (r.id !== id && (r.id === null || r.id !== legacyPlayerCourseId(r.course))) return null
  if (typeof r.date !== 'number' || !Number.isFinite(r.date)) return null
  if (typeof r.source !== 'string' || !SOURCES.has(r.source)) return null
  return {
    id,
    course,
    name: courseTitle(course),
    island: course.island,
    date: r.date,
    source: r.source as CourseSource,
  }
}

/** A course's two words as a title: `Amber Heron`. */
export const courseTitle = (course: PlayerCourse): string =>
  course.name.map((w) => (w ? `${w.charAt(0).toUpperCase()}${w.slice(1)}` : w)).join(' ')

/** The library over a backend. `now` is injectable for the tests. */
export const createCourseLibrary = (
  backend: LibraryBackend,
  now: () => number = () => Date.now(),
): CourseLibrary => ({
  durable: backend.durable,
  async list() {
    const rows = await backend.all()
    const out: LibraryEntry[] = []
    for (const raw of rows) {
      const e = entryFrom(raw)
      if (!e) continue
      // DEV-475: a v1 row, read as v2 — keyed anew, its date and first source kept.
      const was = (raw as { id?: unknown }).id
      if (typeof was === 'string' && was !== e.id) {
        if (await backend.save(e)) await backend.remove(was)
      }
      if (!out.some((o) => o.id === e.id)) out.push(e)
    }
    // Newest first; the id breaks a tie, so the order is a function of the rows.
    return out.sort((a, b) => b.date - a.date || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  },
  async get(id) {
    const e = entryFrom(await backend.one(id))
    return e && e.id === id ? e : null
  },
  async put(course, source) {
    const checked = validatePlayerCourse(course)
    if (!checked.ok) return null
    const id = playerCourseId(checked.course)
    const was = entryFrom(await backend.one(id))
    const entry: LibraryEntry = {
      id,
      course: checked.course,
      name: courseTitle(checked.course),
      island: checked.course.island,
      date: now(),
      source: was?.source ?? source,
    }
    await backend.save(entry)
    return entry
  },
  async delete(id) {
    return backend.remove(id)
  },
  async putMap(sha, bytes) {
    if ((await heightmapSha(bytes)) !== sha) return false
    return backend.saveMap(sha, bytes)
  },
  async getMap(sha) {
    const raw = await backend.oneMap(sha)
    const bytes = (raw as { bytes?: unknown } | null)?.bytes
    const view =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : null
    if (!view) return null
    return (await heightmapSha(view)) === sha ? view : null
  },
})

/** Rows in a Map: the fallback when there is no database, and the tests' store. */
export const memoryBackend = (): LibraryBackend => {
  const rows = new Map<string, Row>()
  const maps = new Map<string, Uint8Array>()
  return {
    durable: false,
    saveMap: async (sha, bytes) => {
      maps.set(sha, bytes)
      return true
    },
    oneMap: async (sha) => (maps.has(sha) ? { sha, bytes: maps.get(sha) } : null),
    all: async () => [...rows.values()],
    one: async (id) => rows.get(id) ?? null,
    save: async (row) => {
      rows.set(row.id, row)
      return true
    },
    remove: async (id) => rows.delete(id),
  }
}

/** A request's result, or `fallback` on its error — never a rejection. */
const settle = <T>(request: IDBRequest, fallback: T): Promise<T> =>
  new Promise<T>((resolve) => {
    try {
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = (e) => {
        // Handled here: an unhandled request error also fires on the
        // transaction and the database, and would abort both.
        e.preventDefault?.()
        resolve(fallback)
      }
    } catch {
      resolve(fallback)
    }
  })

/** Open the database, or null when there is none to open. Never throws, never rejects. */
export const openCourseDb = (
  factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
): Promise<IDBDatabase | null> =>
  new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (!factory) {
        resolve(null)
        return
      }
      const open = factory.open(COURSE_LIBRARY_DB.name, COURSE_LIBRARY_DB.version)
      open.onupgradeneeded = () => {
        try {
          const db = open.result
          if (!db.objectStoreNames.contains(COURSE_LIBRARY_DB.store)) {
            db.createObjectStore(COURSE_LIBRARY_DB.store, { keyPath: 'id' })
          }
          // DEV-490: version 2 adds the maps; a version-1 database keeps its courses.
          if (!db.objectStoreNames.contains(COURSE_LIBRARY_DB.maps)) {
            db.createObjectStore(COURSE_LIBRARY_DB.maps, { keyPath: 'sha' })
          }
        } catch {
          // The open's own error follows, and resolves null below.
        }
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = (e) => {
        e.preventDefault?.()
        resolve(null)
      }
      // Another tab holds an older version open: wait no longer than it takes
      // to say so; this session falls back to memory.
      open.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })

/** The library's rows in an open database. Every call wrapped. */
export const idbBackend = (db: IDBDatabase): LibraryBackend => {
  const store = (
    mode: IDBTransactionMode,
    name: string = COURSE_LIBRARY_DB.store,
  ): IDBObjectStore | null => {
    try {
      return db.transaction(name, mode).objectStore(name)
    } catch {
      return null
    }
  }
  const call = async <T>(
    mode: IDBTransactionMode,
    go: (s: IDBObjectStore) => IDBRequest,
    fallback: T,
    name: string = COURSE_LIBRARY_DB.store,
  ): Promise<T> => {
    const s = store(mode, name)
    if (!s) return fallback
    try {
      return await settle<T>(go(s), fallback)
    } catch {
      return fallback
    }
  }
  return {
    durable: true,
    saveMap: async (sha, bytes) =>
      (await call<unknown>(
        'readwrite',
        (s) => s.put({ sha, bytes }),
        false,
        COURSE_LIBRARY_DB.maps,
      )) !== false,
    oneMap: (sha) => call<unknown>('readonly', (s) => s.get(sha), null, COURSE_LIBRARY_DB.maps),
    all: () => call<unknown[]>('readonly', (s) => s.getAll(), []),
    one: (id) => call<unknown>('readonly', (s) => s.get(id), null),
    save: async (row) => (await call<unknown>('readwrite', (s) => s.put(row), false)) !== false,
    remove: async (id) => {
      const had = (await call<unknown>('readonly', (s) => s.get(id), null)) != null
      if (!had) return false
      await call<unknown>('readwrite', (s) => s.delete(id), null)
      return true
    },
  }
}

/**
 * The library this page keeps: IndexedDB where it opens, memory where it does
 * not. Resolves in every case.
 */
export const openCourseLibrary = async (
  factory?: IDBFactory,
  now?: () => number,
): Promise<CourseLibrary> => {
  const db = await openCourseDb(factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB)
  return createCourseLibrary(db ? idbBackend(db) : memoryBackend(), now)
}
