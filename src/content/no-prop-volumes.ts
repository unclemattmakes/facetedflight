// src/content/no-prop-volumes.ts — ground the scatter is told to leave alone.
//
// DEV-287. Matt, 2026-09-21: *"in unity i used to place geo where i didn't want
// props to be, so it would make sure the flight paths were clear. i'd like to
// use that — in the titlescreen to remove the nearest large foreground tree,
// and in the levels to remove props that are in the main flight path (alpine is
// a main offender with giant trees between the launch pad and first gate)."*
//
// ── This is NEW, and 2016 is not the reason it works ─────────────────────
//
// `FacetedTerrainObjectGenerator.GenerateObjects()` has no exclusion of any
// kind: it is two nested loops over the density map's texels with one
// Bernoulli roll and four draws, and nothing in the file reads a collider, a
// volume or a mask. What 2016 gave Matt instead was that the generator ran in
// the EDITOR and left 6,097 real GameObjects in the scene, so the thing he
// remembers placing geometry against was almost certainly a pass he then made
// by hand, over objects that existed. The port re-rolls a seeded scatter
// (DEV-006 — Unity's PRNG is not portable, so 2016's exact layout is gone), so
// there is nothing to hand-delete and the intent has to be written down
// instead. That is this file.
//
// ── Hand-authored, and therefore NOT under `pnpm extract` ────────────────
//
// `content/{levels,environments,ghosts}` are generated and hash-guarded by
// `content/_generated.sha256`; this one is art direction and is edited by a
// person. It sits beside `content/editions/`, which is hand-authored for the
// same reason. Adding a volume must never require touching `src/` (hard rule
// 6) and it does not: the file is keyed by environment.
//
// ── The frame, and the one conversion that happens ───────────────────────
//
// A volume is written in the TERRAIN'S OWN MESH SPACE — 0..`terrainSize`,
// Unity's +z — because that is the frame the placements are in, the frame
// `spawnClearing` records its cylinders in, and the frame
// `src/render/title.ts`'s `TITLE_2016.cameraMesh` is in. So a title-screen
// volume's numbers are directly comparable with the camera constant three
// lines away in that file, and nothing has to compose `worldOffset + localPos
// + envRoot` a third time (DEV-042 cost a session to two copies of that sum).
//
// The exception is an ANCHOR. `"spawn"` and `"gate:N"` name points the MISSION
// carries in THREE world space, and `game/props/no-prop-volumes.ts` converts
// them with `terrainOriginSim` — the one function `bake-placements.mjs`
// already uses for exactly this, rather than a fourth copy of the sum.

/**
 * One end of a volume.
 *
 * Either an explicit `[x, z]` in the terrain's mesh space, or an anchor naming
 * a point the mission already carries:
 *
 *   - `"spawn"`   — the mission's spawn, which for an elevator launch is the
 *     vertical axis the ship rises on (`sim/props/clearing.ts` says why one
 *     vertical axis covers the room, the shaft, the deck and the release).
 *   - `"gate:N"`  — the centre of the Nth LIVE gate of the running course,
 *     zero-based. `"gate:0"` is the first gate of the run.
 *
 * An anchor that cannot be resolved — a gate index a course does not have, a
 * mission-less environment like the title valley — DROPS the whole volume
 * rather than falling back to a default. A corridor to a gate that is not
 * there has no meaning, and a silent fallback is how one environment's art
 * direction ends up applied to another's.
 */
export type VolumeEnd = readonly [number, number] | string

/** One authored no-prop volume, as `content/no-prop-volumes.json` carries it. */
export interface NoPropVolumeSpec {
  /** Stable name. Appears in the loader's receipt so a removal is attributable. */
  readonly id: string
  /** Why this exists, in Matt's terms. Read by people, asserted by nobody. */
  readonly why: string
  /**
   * Metres. Everything within this of the segment is cleared, unbounded in y —
   * a prop stands on the ground whatever the ship's altitude, and height is
   * what a capsule is deliberately blind to (`sim/props/clearing.ts`).
   */
  readonly radius: number
  /**
   * One end for a circle, two for a corridor. More than two is refused rather
   * than truncated: a polyline is a different shape with a different cost and
   * should be written as several volumes until something needs otherwise.
   */
  readonly ends: readonly VolumeEnd[]
  /**
   * Restrict to these mission ids. Absent applies to every mission of the
   * environment, which is what an anchored volume normally wants — alpine's
   * launch corridor is authored ONCE and resolves to each mission's own pad
   * and first gate.
   */
  readonly missions?: readonly string[]
}

/** The whole file. */
export interface NoPropVolumeFile {
  readonly $schema?: string
  readonly note?: string
  /** Keyed by environment id, exactly as a level's `environment` field spells it. */
  readonly environments: Readonly<Record<string, readonly NoPropVolumeSpec[]>>
}

// A glob rather than a bare dynamic import, for the reason `load-environment.ts`
// uses one: it keeps the file in Vite's content graph, it is a chunk of its own
// rather than part of the boot bundle, and a missing file is an absent key
// instead of a build error — which is what lets a clone with no art direction
// still fly.
const modules = import.meta.glob<{ default: NoPropVolumeFile }>('/content/no-prop-volumes.json')

const PATH = '/content/no-prop-volumes.json'

let cached: Promise<NoPropVolumeFile | null> | null = null

/**
 * The authored volumes, or null when the file is absent.
 *
 * Cached: it is read once per world build and a course swap inside one
 * environment must not re-fetch it.
 */
export const loadNoPropVolumes = async (): Promise<NoPropVolumeFile | null> => {
  cached ??= (async () => {
    const mod = modules[PATH]
    if (!mod) return null
    return (await mod()).default
  })()
  return cached
}

/** Drop the cache. For tests, which load more than one fixture per process. */
export const clearNoPropVolumeCache = (): void => {
  cached = null
}
