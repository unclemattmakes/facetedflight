// src/render/terrain-bake-client.ts: where a mission load finds its terrain bakes. DEV-955.
//
// Three places, in this order, and the last is always there:
//
//   1. IndexedDB: bytes kept from an earlier visit (a shipped file we fetched,
//      or a bake this machine ran itself, which is what a custom course gets).
//   2. The shipped file, `assets/terrain-bake/<kind>-<key>.bin`, but ONLY for a
//      key `content/terrain-bake.json` lists. A custom course, the editor and a
//      moved sun are not listed, so they never make a request.
//   3. Nothing: the caller runs the bake it always ran.
//
// Every answer is checked before it is believed: the file must hash to the
// manifest's sha256 and then `decodeSunBake`/`decodeSkyBake` check magic,
// version, key and length. A failed fetch, a 404 (R2 before the push), a static
// host's HTML shell answering a missing path, a truncated body and a private
// window with no IndexedDB all come out as "not found", and the bake runs.
//
// The manifest names the LEVELS each file serves, so the fetch can start the
// moment a mission is chosen, in parallel with the terrain's own load, and be
// waiting by the time the inputs are known and the key can be computed.

import { terrainBakeOff } from '@/boot/switches'
import { assetUrl } from '@/content/asset-url'
import type { HeightField } from '@/sim/terrain/height-field'
import type { SkyVisibilityField } from '@/sim/terrain/sky-visibility'
import type { SunHeightField } from '@/sim/terrain/sun-height'
import manifestJson from '../../content/terrain-bake.json' with { type: 'json' }
import {
  type BakeKind,
  bakeAssetPath,
  decodeSkyBake,
  decodeSunBake,
  digestHex,
  encodeSkyBake,
  encodeSunBake,
} from './terrain-bake'

export interface BakeManifest {
  readonly files: Readonly<
    Record<string, { readonly sha256: string; readonly users: readonly string[] }>
  >
}

export type BakeSource = 'idb' | 'file' | 'runtime'

/** Small byte store keyed by name. IndexedDB in the page; a Map in a test. */
export interface BakeStore {
  get(name: string): Promise<Uint8Array | null>
  put(name: string, bytes: Uint8Array): Promise<void>
}

/** How many baked fields IndexedDB keeps. A sun field is 2 to 8 MB, a sky field 1 MB. */
export const IDB_KEEP = 8

const DB_NAME = 'ff2-terrain-bake'
const STORE = 'bakes'

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

/** IndexedDB, or null where it is missing or blocked (private window, a worker with none). */
export const createIdbStore = (keep = IDB_KEEP): BakeStore | null => {
  if (typeof indexedDB === 'undefined') return null
  let opened: Promise<IDBDatabase> | null = null
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'name' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('blocked'))
    })
    return opened
  }
  return {
    async get(name) {
      try {
        const db = await open()
        const row = (await request(db.transaction(STORE).objectStore(STORE).get(name))) as
          | { bytes: ArrayBuffer }
          | undefined
        return row ? new Uint8Array(row.bytes) : null
      } catch {
        return null
      }
    },
    async put(name, bytes) {
      try {
        const db = await open()
        const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
        // A copy: the caller's view may sit inside a larger buffer.
        const copy = bytes.slice().buffer
        await request(store.put({ name, at: Date.now(), bytes: copy }))
        const all = (await request(store.getAll())) as { name: string; at: number }[]
        const extra = all.sort((a, b) => b.at - a.at).slice(keep)
        for (const row of extra) store.delete(row.name)
      } catch {
        // Quota, a private window: the bake just is not remembered.
      }
    },
  }
}

export interface BakeSourceOptions {
  readonly manifest?: BakeManifest
  readonly store?: BakeStore | null
  /** Bytes at an asset path, or null for anything but a 200 with a body. */
  readonly fetchBytes?: (path: string) => Promise<Uint8Array | null>
}

const defaultFetchBytes = async (path: string): Promise<Uint8Array | null> => {
  try {
    const res = await fetch(assetUrl(path))
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

export interface FoundField<T> {
  readonly field: T
  readonly from: BakeSource
}

export interface TerrainBakeSource {
  /** Start fetching the files the manifest lists for this level and preset, before their keys are known. */
  prefetch(levelId: string, editionId: string): void
  findSun(key: string, land: HeightField): Promise<FoundField<SunHeightField> | null>
  findSky(key: string, land: HeightField): Promise<FoundField<SkyVisibilityField> | null>
  /** A bake this machine just ran: keep it for next time. */
  rememberSun(key: string, field: SunHeightField): Promise<void>
  rememberSky(key: string, field: SkyVisibilityField): Promise<void>
}

const nameOf = (kind: BakeKind, key: string): string => `${kind}-${key}`

export const createTerrainBakeSource = (options: BakeSourceOptions = {}): TerrainBakeSource => {
  const manifest = options.manifest ?? (manifestJson as BakeManifest)
  const store = options.store === undefined ? createIdbStore() : options.store
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes
  const inflight = new Map<string, Promise<Uint8Array | null>>()

  /** The shipped file for `kind`-`key`, hash-checked against the manifest. Null when unlisted or wrong. */
  const file = (kind: BakeKind, key: string): Promise<Uint8Array | null> => {
    const name = nameOf(kind, key)
    const entry = manifest.files[name]
    if (!entry) return Promise.resolve(null)
    let p = inflight.get(name)
    if (!p) {
      p = fetchBytes(bakeAssetPath(kind, key)).then(async (bytes) => {
        if (!bytes) return null
        return (await digestHex(bytes)) === entry.sha256 ? bytes : null
      })
      inflight.set(name, p)
    }
    return p
  }

  const find = async <T>(
    kind: BakeKind,
    key: string,
    decode: (bytes: Uint8Array) => T | null,
  ): Promise<FoundField<T> | null> => {
    const name = nameOf(kind, key)
    const kept = store ? await store.get(name) : null
    const fromStore = kept ? decode(kept) : null
    if (fromStore) return { field: fromStore, from: 'idb' }
    const bytes = await file(kind, key)
    const fromFile = bytes ? decode(bytes) : null
    if (!fromFile || !bytes) return null
    void store?.put(name, bytes)
    return { field: fromFile, from: 'file' }
  }

  return {
    prefetch(levelId, editionId) {
      for (const [name, entry] of Object.entries(manifest.files)) {
        const dash = name.indexOf('-')
        const kind = name.slice(0, dash) as BakeKind
        const key = name.slice(dash + 1)
        const wanted =
          kind === 'sun'
            ? entry.users.includes(levelId)
            : entry.users.includes(`${levelId}@${editionId}`)
        if (wanted) void file(kind, key)
      }
    },
    findSun: (key, land) => find('sun', key, (b) => decodeSunBake(b, key, land)),
    findSky: (key, land) => find('sky', key, (b) => decodeSkyBake(b, key, land)),
    async rememberSun(key, field) {
      await store?.put(nameOf('sun', key), encodeSunBake(key, field))
    },
    async rememberSky(key, field) {
      await store?.put(nameOf('sky', key), encodeSkyBake(key, field))
    },
  }
}

let shared: TerrainBakeSource | null = null
/** The page's one source, built on first use. */
export const terrainBakeSource = (): TerrainBakeSource => {
  // `?terrainBake=off`: an empty manifest and no store, so nothing is looked for or kept.
  shared ??= terrainBakeOff()
    ? createTerrainBakeSource({ manifest: { files: {} }, store: null })
    : createTerrainBakeSource()
  return shared
}
