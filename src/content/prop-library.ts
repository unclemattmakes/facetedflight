// src/content/prop-library.ts — every prop mesh the islands use, as one table.
// DEV-504 (docs/plan/EDITOR-PROPS.md, "The library").
//
// Matt, 2026-09-28: *"ability to add hand-placed props (needs a prop library
// prob?)"*. A player course names a prop by an id from this table and carries
// no asset bytes: the meshes are the ones the four islands already draw, on R2
// and in the game already (hard rule 7: bought geometry may ship IN the game).
//
// ── Generated, never typed ───────────────────────────────────────────────
//
// `src/content/prop-library.generated.ts` is built by `buildPropLibrary` from
// `content/environments/*.json` — the scatter palettes and the hand-placed
// landmarks of every island a shipped mission flies over — and
// `tests/unit/prop-library.test.ts` builds it again and compares the BYTES
// (`PROP_LIBRARY_WRITE=1` writes them). So the table is the environments' own
// vocabulary, and a new prop in an environment is a red test until the table
// is rebuilt. The pattern is `content/lap-courses.json`'s (DEV-372), but the
// table is a TypeScript module, not a JSON file: this module is reached by
// Playwright specs (through `player-course.ts`), and Playwright's loader
// refuses a bare JSON import ("needs an import attribute of type: json"),
// which empties the WHOLE suite's collection — observed on this row's first
// e2e run. `e2e-import-graph.test.ts` now refuses one.
//
// ── What an entry holds ──────────────────────────────────────────────────
//
//   id       the mesh's bucket basename (`cactus-tall-01`): one entry per MESH,
//            not per palette slot (a palette repeats a mesh to weight it)
//   mesh     the legacy mesh path, the provenance a `MissionProp` carries
//   asset    the bucket path the renderer loads
//   rest     the transform the ISLAND draws the mesh under, below the
//            placement: a scatter entry's `meshTransform` (the wrapper
//            prefab's subtree, which for alpine's Tree Pack is what puts the
//            trunk on the placement point at all), or, for a mesh the islands
//            only hand-place (the spires, the big rock, one palm), the
//            authored rotation and scale of its first live instance. Unity
//            space, as the environment JSON writes it.
//   scale    the placement's own uniform scale: a scatter pass's
//            `scaleMin`..`scaleMax` and their midpoint; a hand-placed mesh's is
//            1, its instance's size
//   places   every island that uses it, in the table's island order
//
// ── Why a placed prop is a LANDMARK ──────────────────────────────────────
//
// A placed prop expands into `level.props` (DEV-218's `MissionProp`, the same
// shape and frame as a landmark), so `buildLandmarkGroup` draws it and
// `landmarkColliderInput` makes it solid, with no second path. The landmark
// path draws the authored transform and nothing of the glTF's node (DEV-196);
// every mesh a scatter palette names has an identity node (the spires are the
// only meshes whose node moves, and no scatter draws them), so the one
// composition `T(pivot) · R(yaw) · S(scale) · rest` is the island's own
// instance matrix exactly. `prop-library.test.ts` holds that against
// `instanceMatrixOf`, the scatter's own function, rather than against a
// second derivation of it (trap 24).
//
// Importable from a Playwright spec: nothing it reaches uses
// `import.meta.glob` or imports JSON (`tests/unit/e2e-import-graph.test.ts`).

import { PROP_LIBRARY_TABLE } from './prop-library.generated'

/** A Unity-space transform: position, an xyzw quaternion, a scale. */
export interface PropRest {
  readonly position: readonly [number, number, number]
  readonly rotation: readonly [number, number, number, number]
  readonly scale: readonly [number, number, number]
}

export interface PropLibraryEntry {
  /** The id a course names it by: its bucket file's basename. */
  readonly id: string
  /** What the desk lists it as. Derived from the prefab's or the landmark's own name. */
  readonly name: string
  /** `cactus`, `palm`, `tree`, `bush`, `spire`, `rock`: the environment's own classification. */
  readonly kind: string | null
  /** The legacy mesh path: the provenance, not something to load. */
  readonly mesh: string
  /** Bucket path, e.g. `assets/props/cactus-tall-01.glb`. */
  readonly asset: string
  readonly origin: string
  readonly licence: string
  /** `scatter`: a palette draws it. `landmark`: the islands only hand-place it. */
  readonly from: 'scatter' | 'landmark'
  /** Under the placement, Unity space. See the header. */
  readonly rest: PropRest
  /** The placement's uniform scale: its pass's range and their midpoint, or 1, 1, 1. */
  readonly scale: { readonly min: number; readonly max: number; readonly default: number }
  /** The islands that use it, in `PropLibrary.places` order. */
  readonly places: readonly string[]
}

export interface PropLibrary {
  /** The islands, in the order the table lists them. */
  readonly places: readonly string[]
  readonly entries: readonly PropLibraryEntry[]
}

// ── The builder ──────────────────────────────────────────────────────────

/** The part of an environment JSON the builder reads (`load-environment.ts`'s shape). */
export interface PropLibrarySource {
  readonly id: string
  readonly scatter: readonly {
    readonly scaleMin: number
    readonly scaleMax: number
    readonly palette: readonly {
      readonly prefab: string | null
      readonly mesh: string | null
      readonly meshAsset: string | null
      readonly origin: string
      readonly licence: string
      readonly kind?: string
      readonly meshTransform: {
        readonly position: readonly number[]
        readonly rotation: readonly number[]
        readonly scale: readonly number[]
      } | null
    }[]
  }[]
  readonly landmarks: readonly {
    readonly name: string
    readonly mesh: string
    readonly meshAsset?: string | null
    readonly kind?: string | null
    readonly origin: string
    readonly licence: string
    readonly live?: boolean
    readonly rotation: readonly number[] | null
    readonly scale: readonly number[] | null
  }[]
}

/** Six decimals, the extractor's own rounding: the table's bytes carry no float noise. */
const r6 = (x: number): number => {
  const q = Math.round(x * 1e6) / 1e6
  return Object.is(q, -0) ? 0 : q
}
/** A scale to the course's own quantum, 0.01. */
const r2 = (x: number): number => Math.round(x * 100) / 100

const idOf = (asset: string): string =>
  (asset.split('/').pop() ?? asset).replace(/\.glb$/i, '').toLowerCase()

/**
 * A display name out of an asset's own name: a prefab's (`Cactus_Tall_01` →
 * "Cactus tall 01", `Tree10` → "Tree 10") or a landmark's (`RocaGrandeLOW` →
 * "Roca grande low", `Spire_B_w_Collision` → "Spire B"); the bucket basename
 * where the landmark is only called `Mesh1`. No word is typed per prop.
 */
export const propDisplayName = (raw: string): string => {
  const s = (raw.split('/').pop() ?? raw)
    .replace(/\.(prefab|glb|fbx|asset)$/i, '')
    .replace(/^GL-/i, '')
    .replace(/_w_Collision$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
  const words = s.split(/[\s_-]+/).filter((w) => w.length > 0)
  return words
    .map((w, i) =>
      i === 0
        ? `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`
        : w.length === 1
          ? w.toUpperCase()
          : w.toLowerCase(),
    )
    .join(' ')
}

const GENERIC_NAME = /^Mesh\d*$/

const tuple3 = (v: readonly number[] | null | undefined, d: number): [number, number, number] => [
  r6(v?.[0] ?? d),
  r6(v?.[1] ?? d),
  r6(v?.[2] ?? d),
]
const tuple4 = (v: readonly number[] | null | undefined): [number, number, number, number] => [
  r6(v?.[0] ?? 0),
  r6(v?.[1] ?? 0),
  r6(v?.[2] ?? 0),
  r6(v?.[3] ?? 1),
]

const sameRest = (a: PropRest, b: PropRest): boolean =>
  [...a.position, ...a.rotation, ...a.scale].every(
    (x, i) => x === [...b.position, ...b.rotation, ...b.scale][i],
  )

/**
 * The table, from the islands' environment JSONs, IN THE ORDER GIVEN (the
 * caller's `places`). Throws on the one thing that would make a mesh ambiguous:
 * a mesh two scatter passes draw under two different wrapper transforms.
 */
export const buildPropLibrary = (sources: readonly PropLibrarySource[]): PropLibrary => {
  interface Building {
    entry: Omit<PropLibraryEntry, 'places' | 'scale'> & { scale: { min: number; max: number } }
    places: Set<string>
  }
  const byId = new Map<string, Building>()
  const order: string[] = []
  const place = (id: string, b: Building, where: string): void => {
    b.places.add(where)
    if (!byId.has(id)) {
      byId.set(id, b)
      order.push(id)
    }
  }
  // Scatter first: a mesh a palette draws is placed the way the palette places it.
  for (const env of sources) {
    for (const pass of env.scatter) {
      for (const p of pass.palette) {
        if (!p.meshAsset) continue
        const id = idOf(p.meshAsset)
        const rest: PropRest = {
          position: tuple3(p.meshTransform?.position, 0),
          rotation: tuple4(p.meshTransform?.rotation),
          scale: tuple3(p.meshTransform?.scale, 1),
        }
        const had = byId.get(id)
        if (had) {
          if (had.entry.from === 'scatter' && !sameRest(had.entry.rest, rest)) {
            throw new Error(`prop library: ${id} is drawn under two wrapper transforms`)
          }
          had.entry.scale.min = Math.min(had.entry.scale.min, pass.scaleMin)
          had.entry.scale.max = Math.max(had.entry.scale.max, pass.scaleMax)
          had.places.add(env.id)
          continue
        }
        place(
          id,
          {
            entry: {
              id,
              name: propDisplayName(p.prefab ?? p.meshAsset),
              kind: p.kind ?? null,
              mesh: p.mesh ?? p.meshAsset,
              asset: p.meshAsset,
              origin: p.origin,
              licence: p.licence,
              from: 'scatter',
              rest,
              scale: { min: pass.scaleMin, max: pass.scaleMax },
            },
            places: new Set(),
          },
          env.id,
        )
      }
    }
  }
  // Then the meshes the islands only hand-place: the rest pose is the first
  // LIVE instance's (the one the island draws), else, for a mesh no island
  // draws at all (the big rock, the AxeyWorks palm), the first authored one.
  // An island is one of a mesh's places when it DRAWS it (a scatter pass, a
  // live landmark); a mesh nobody draws is placed where it is authored.
  const deadOnly = new Set<string>()
  for (const live of [true, false]) {
    for (const env of sources) {
      for (const l of env.landmarks) {
        if (!l.meshAsset) continue
        const id = idOf(l.meshAsset)
        const had = byId.get(id)
        if (had) {
          if (live ? l.live === true : deadOnly.has(id)) had.places.add(env.id)
          continue
        }
        if (live && l.live !== true) continue
        if (!live) deadOnly.add(id)
        place(
          id,
          {
            entry: {
              id,
              name: propDisplayName(GENERIC_NAME.test(l.name) ? l.meshAsset : l.name),
              kind: l.kind ?? null,
              mesh: l.mesh,
              asset: l.meshAsset,
              origin: l.origin,
              licence: l.licence,
              from: 'landmark',
              rest: {
                position: [0, 0, 0],
                rotation: tuple4(l.rotation),
                scale: tuple3(l.scale, 1),
              },
              scale: { min: 1, max: 1 },
            },
            places: new Set(),
          },
          env.id,
        )
      }
    }
  }
  const places = sources.map((s) => s.id)
  const entries: PropLibraryEntry[] = order.map((id) => {
    const b = byId.get(id) as Building
    const { min, max } = b.entry.scale
    return {
      ...b.entry,
      scale: { min: r2(min), max: r2(max), default: r2((min + max) / 2) },
      places: places.filter((p) => b.places.has(p)),
    }
  })
  return { places, entries }
}

/** The table's bytes: one entry to a line, so a diff of it reads a mesh at a time. */
export const serialisePropLibrary = (lib: PropLibrary): string =>
  '// src/content/prop-library.generated.ts — GENERATED by `buildPropLibrary`\n' +
  '// (`src/content/prop-library.ts`) from content/environments/*.json. DEV-504.\n' +
  '// Never edit: `PROP_LIBRARY_WRITE=1 npx vitest run tests/unit/prop-library.test.ts`\n' +
  '// rewrites it, and that test fails while it is stale. Biome skips `*.generated.ts`.\n\n' +
  `export const PROP_LIBRARY_TABLE = {\n  "places": ${JSON.stringify(lib.places)},\n  "entries": [\n${lib.entries
    .map((e) => `    ${JSON.stringify(e)}`)
    .join(',\n')}\n  ]\n}\n`

// ── The table ────────────────────────────────────────────────────────────

/** The committed table. Regenerated and compared by `tests/unit/prop-library.test.ts`. */
export const PROP_LIBRARY = PROP_LIBRARY_TABLE as unknown as PropLibrary

const BY_ID: ReadonlyMap<string, PropLibraryEntry> = new Map(
  PROP_LIBRARY.entries.map((e) => [e.id, e]),
)

/** The entry a course's `kind` names, or null for one this build does not have. */
export const propEntry = (id: string): PropLibraryEntry | null => BY_ID.get(id) ?? null

const BY_ASSET: ReadonlyMap<string, PropLibraryEntry> = new Map(
  PROP_LIBRARY.entries.map((e) => [e.asset, e]),
)

/** The entry for a bucket path (`assets/props/…glb`), or null. */
export const propEntryByAsset = (asset: string): PropLibraryEntry | null =>
  BY_ASSET.get(asset) ?? null

// ── A placed prop, as the landmark the renderer draws ─────────────────────

/** What a course holds for one placed prop (`PlayerCourse.props`). */
export interface PlacedProp {
  /** A `PropLibraryEntry.id`. */
  readonly kind: string
  /** The PIVOT, THREE space: where the prop stands on the ground, the frame a course's points are in. */
  readonly pos: readonly [number, number, number]
  /** Degrees about +y, THREE's sense (counter-clockwise seen from above). */
  readonly yaw: number
  /** The placement's uniform scale, the scatter's own `s`. */
  readonly scale: number
}

/**
 * Where the landmark frame's origin stands in THREE space: a landmark at
 * Unity-space `L` (composed to the LevelArt root, `PropLandmark`'s frame) is
 * drawn at `(x0 + L.x, y0 + L.y, z0 − L.z)`. `player-course.ts`'s
 * `propFrameOf` makes one from the sheet; see there for the sum.
 */
export interface PropFrame {
  readonly x0: number
  readonly y0: number
  readonly z0: number
}

/** A THREE-space point in the landmark frame. */
export const toPropFrame = (f: PropFrame, p: readonly number[]): [number, number, number] => [
  (p[0] as number) - f.x0,
  (p[1] as number) - f.y0,
  f.z0 - (p[2] as number),
]

/** A landmark-frame point back in THREE space. */
export const fromPropFrame = (f: PropFrame, l: readonly number[]): [number, number, number] => [
  f.x0 + (l[0] as number),
  f.y0 + (l[1] as number),
  f.z0 - (l[2] as number),
]

/** `a ⊗ b` for xyzw tuples (apply b, then a). */
const qmul = (a: readonly number[], b: readonly number[]): [number, number, number, number] => {
  const [ax, ay, az, aw] = a as [number, number, number, number]
  const [bx, by, bz, bw] = b as [number, number, number, number]
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/** `v` rotated by the xyzw quaternion `q`. */
const qrot = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const [x, y, z, w] = q as [number, number, number, number]
  const [vx, vy, vz] = v as [number, number, number]
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ]
}

/**
 * The Unity-space yaw quaternion of a THREE-space yaw of `deg` degrees. THREE's
 * `(0, sin θ/2, 0, cos θ/2)` under the z mirror, which conjugates a rotation
 * to `(−x, −y, z, w)` (`render/unity-space.ts`'s `unityQuatTupleToThree`, read backwards).
 */
const unityYaw = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360
  return [0, -Math.sin(h), 0, Math.cos(h)]
}

/**
 * The `path` every placed prop's landmark carries, before its index. How the
 * renderer tells a course's placed props from the island's and the mission's
 * own (`load-props.ts` draws them in meshes of their own, which the desk hides
 * while it draws the draft's): a 2016 path is a GameObject chain from a scene
 * root, and no 2016 root is called this.
 */
export const PLACED_PROP_PATH = 'player/props/'

/** Is this landmark a course's placed prop? */
export const isPlacedProp = (landmark: { readonly path?: string }): boolean =>
  landmark.path?.startsWith(PLACED_PROP_PATH) === true

/**
 * One placed prop as a landmark: `T(pivot) · R(yaw) · S(scale) · rest`, in
 * the landmark frame (Unity, composed to the LevelArt root), which is the
 * whole of what a `MissionProp` holds. Exact, because the placement's scale is
 * uniform: `T R s · T' R' S'` is `T + R·s·T'`, `R R'`, `s S'`.
 */
export const placedLandmark = (
  prop: PlacedProp,
  entry: PropLibraryEntry,
  frame: PropFrame,
  index: number,
): {
  name: string
  mesh: string
  meshAsset: string
  kind: string | null
  origin: string
  licence: string
  live: boolean
  solid: boolean
  path: string
  position: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
} => {
  const pivot = toPropFrame(frame, prop.pos)
  const q = unityYaw(prop.yaw)
  const s = prop.scale
  const offset = qrot(q, [
    s * (entry.rest.position[0] as number),
    s * (entry.rest.position[1] as number),
    s * (entry.rest.position[2] as number),
  ])
  return {
    // 2016's clone naming, with this course's tag (the rings' pattern).
    name: `${String(index).padStart(4, '0')}${entry.id}(Player)`,
    mesh: entry.mesh,
    meshAsset: entry.asset,
    kind: entry.kind,
    origin: entry.origin,
    licence: entry.licence,
    live: true,
    solid: true,
    path: `${PLACED_PROP_PATH}${index}`,
    position: [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]],
    rotation: qmul(q, entry.rest.rotation),
    scale: [
      s * (entry.rest.scale[0] as number),
      s * (entry.rest.scale[1] as number),
      s * (entry.rest.scale[2] as number),
    ],
  }
}

/**
 * The entries grouped by place, `first`'s group first and the rest in the
 * table's order. Each entry is listed ONCE, under the first of its places in
 * that order, so the base's own group holds everything its island uses.
 */
export const propGroups = (
  first: string,
): { readonly place: string; readonly entries: readonly PropLibraryEntry[] }[] => {
  const order = [
    ...PROP_LIBRARY.places.filter((p) => p === first),
    ...PROP_LIBRARY.places.filter((p) => p !== first),
  ]
  const seen = new Set<string>()
  const groups: { place: string; entries: PropLibraryEntry[] }[] = []
  for (const place of order) {
    const entries = PROP_LIBRARY.entries.filter((e) => e.places.includes(place) && !seen.has(e.id))
    for (const e of entries) seen.add(e.id)
    if (entries.length > 0) groups.push({ place, entries })
  }
  return groups
}
