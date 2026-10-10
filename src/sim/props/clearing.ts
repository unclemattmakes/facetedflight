// src/sim/props/clearing.ts — the ground the scatter leaves alone.
//
// DEV-100. A prop standing on a mission's launch platform is scenery inside a
// building, and on `rookie_01_hoverJet` and `rookie_01_jumpSeat` it is the whole
// pad view (DEV-094 §6). This is the rule that stops it.
//
// ── The shape is a VERTICAL CYLINDER, and that is not a shortcut ───────────
//
// A launch platform rises straight up: the release is `spawn + (0, rise, 0)`
// exactly, so one cylinder on the spawn's own vertical axis covers the room ~95 m
// underground, the 106.647 m of shaft above it, the platform, and the release
// point where the player's eye actually opens. Checked independently: 2016's own
// `SinglePlayerRespawnPosition` markers, which are hand-placed at the release,
// sit within 2.65 m of that axis on all seven shipped rigs and within 0.1 mm on
// `rookie_01_hoverJet`.
//
// **This is the opposite of the call DEV-089 made for the racing line, and both
// are right.** A route is hundreds of points, so a horizontal-only rule there
// carves a bald corridor down the whole course and DEV-089 measures to the line
// in three dimensions. A spawn is ONE point per mission — four circles on a
// 4,096 m map — and the thing being avoided is not a collision but an occlusion:
// a 60 m tree on the ground 10 m away fills the viewport from a cockpit whether
// the ship is 8 m up or 95 m down. Height is what a cylinder is deliberately
// blind to.
//
// ── Where the radius comes from ───────────────────────────────────────────
//
// `footprintRadius` below, over the mission's own `spawn.startGrid` boxes: the
// race start deck, which `render/start-grid.ts` traced to Unity **built-in
// cubes** (mesh fileID 10202, no guid, no FBX, no importer) inside
// `PlayerStart_ElevatorShaft_Photon_02.prefab` — the one rig every shipped
// HoverJet mission instances. It is 2016's own answer to "how much ground does
// the launch site occupy", it stands at the SURFACE beside the release rather
// than 95 m under it, and it is already extracted into every level JSON.
//
// Six shipped scenes materialise that deck and all six agree to 13 cm
// (51.84 / 51.84 / 51.84 / 51.87 / 51.84 / 51.97 m), which is the same fact
// `sim/hangar.ts` states about `platform.size`: 2016 authored one launch rig and
// instanced it. The other seven missions do not materialise it in their scene —
// the rig is a stripped prefab instance there (DEV-045) — so they get the same
// rig's radius, which is `DEFAULT_HANGAR_DROP`'s precedent exactly.
//
// SIM LAYER: pure, THREE-free, deterministic. No tuned constant lives here; the
// only literals are the arithmetic of a box (halving a size, eight corners) and
// of a quaternion.

/**
 * Cleared ground, in the terrain's own mesh space — the frame `positions` uses.
 *
 * A CAPSULE in x/z: everything within `radius` of the segment `(x,z)-(x2,z2)`,
 * unbounded in y. Leave `x2`/`z2` off and the segment is a point, which is the
 * cylinder DEV-100 has always described — every spawn clearing in the game is
 * that degenerate case and its arithmetic is unchanged.
 *
 * The second endpoint arrived with DEV-287's authored no-prop volumes, where
 * the shape wanted is a CORRIDOR (a launch pad to the first gate) and a chain
 * of overlapping circles would be a worse way to write one down.
 */
export interface Clearing {
  /** Terrain-local x, metres (0..terrainSize). */
  readonly x: number
  /** Terrain-local z, metres (0..terrainSize), Unity's +z. */
  readonly z: number
  /** Metres. Nothing is placed strictly inside this. */
  readonly radius: number
  /** Terrain-local x of the far end, when this is a capsule rather than a point. */
  readonly x2?: number
  /** Terrain-local z of the far end. Both or neither; one alone is ignored. */
  readonly z2?: number
}

/**
 * An AUTHORED clearing — DEV-287, Matt's "no prop volumes".
 *
 * Structurally a `Clearing` and deliberately so: the test is the same, and one
 * implementation of a point-in-capsule test cannot drift from another. The
 * alias exists because the two have different PROVENANCE and therefore
 * different lifecycles — a spawn clearing is derived from a mission's launch
 * deck by `tools/assets/bake-placements.mjs` and would be wrong to hand-edit,
 * while a no-prop volume is art direction in `content/no-prop-volumes.json` and
 * would be wrong to generate.
 */
export type NoPropVolume = Clearing

/**
 * Is this placement inside any clearing?
 *
 * Squared distances: the scatter calls this once per accepted texel and a
 * `Math.hypot` per clearing per texel is measurable on a 1,024² map. The
 * capsule branch costs a dot product and a divide, and only for a clearing
 * that carries a second endpoint — a cylinder walks exactly the same two
 * subtractions and one compare it always did.
 */
export const insideAnyClearing = (
  x: number,
  z: number,
  clearings: readonly Clearing[],
): boolean => {
  for (const c of clearings) {
    let cx = c.x
    let cz = c.z
    if (c.x2 !== undefined && c.z2 !== undefined) {
      // Closest point on the SEGMENT, clamped to its ends — that clamp is what
      // makes this a capsule and not an infinite slab, and it is why the two
      // end caps are round rather than square.
      const ex = c.x2 - c.x
      const ez = c.z2 - c.z
      const len2 = ex * ex + ez * ez
      if (len2 > 0) {
        const t = Math.min(1, Math.max(0, ((x - c.x) * ex + (z - c.z) * ez) / len2))
        cx = c.x + t * ex
        cz = c.z + t * ez
      }
    }
    const dx = x - cx
    const dz = z - cz
    if (dx * dx + dz * dz < c.radius * c.radius) return true
  }
  return false
}

/** A world-space oriented box, the shape `spawn.startGrid`'s entries carry. */
export interface OrientedBox {
  /** Centre, THREE space, world. */
  readonly pos: readonly number[]
  /** `(x, y, z, w)`. */
  readonly quat: readonly number[]
  /** Full size, not half-extents — Unity sizes a collider by the transform. */
  readonly size: readonly number[]
}

/** Just the fields of a `SpawnPoint` this needs. Deliberately structural. */
export interface LaunchSite {
  /** THREE space, world. Only x and z are read: the axis is vertical. */
  readonly pos: readonly number[]
  readonly startGrid?: {
    readonly slabs?: readonly OrientedBox[]
    readonly lightBar?: OrientedBox | null
    readonly pads?: readonly OrientedBox[]
  } | null
}

/**
 * How far the launch structure reaches from the spawn's vertical axis.
 *
 * The largest horizontal distance from that axis to any CORNER of any start-grid
 * box, rotation composed. Corners rather than centres because a 22 m slab whose
 * centre is 30 m out reaches considerably further than 30 m, and DEV-027 is the
 * price of measuring the wrong end of a thing.
 *
 * Returns 0 for a mission whose scene does not materialise the deck — the caller
 * decides what to do with that, because "this mission has no rig" and "this
 * mission's rig is a stripped instance" are the same silence (DEV-045).
 */
export const footprintRadius = (site: LaunchSite): number => {
  const grid = site.startGrid
  if (!grid) return 0
  const boxes: readonly OrientedBox[] = [
    ...(grid.slabs ?? []),
    ...(grid.lightBar ? [grid.lightBar] : []),
    ...(grid.pads ?? []),
  ]
  const ax = site.pos[0] ?? 0
  const az = site.pos[2] ?? 0
  let worst = 0

  for (const box of boxes) {
    const qx = box.quat[0] ?? 0
    const qy = box.quat[1] ?? 0
    const qz = box.quat[2] ?? 0
    const qw = box.quat[3] ?? 1
    // Rows 0 and 2 of the rotation matrix; row 1 is never needed, the axis being
    // vertical.
    const m00 = 1 - 2 * (qy * qy + qz * qz)
    const m01 = 2 * (qx * qy - qz * qw)
    const m02 = 2 * (qx * qz + qy * qw)
    const m20 = 2 * (qx * qz - qy * qw)
    const m21 = 2 * (qy * qz + qx * qw)
    const m22 = 1 - 2 * (qx * qx + qy * qy)

    const hx = (box.size[0] ?? 0) / 2
    const hy = (box.size[1] ?? 0) / 2
    const hz = (box.size[2] ?? 0) / 2
    const cx = (box.pos[0] ?? 0) - ax
    const cz = (box.pos[2] ?? 0) - az

    for (let i = 0; i < 8; i++) {
      const lx = i & 1 ? hx : -hx
      const ly = i & 2 ? hy : -hy
      const lz = i & 4 ? hz : -hz
      const wx = cx + m00 * lx + m01 * ly + m02 * lz
      const wz = cz + m20 * lx + m21 * ly + m22 * lz
      const d2 = wx * wx + wz * wz
      if (d2 > worst) worst = d2
    }
  }
  return Math.sqrt(worst)
}

/**
 * The clearing radius the whole game uses: the widest launch footprint in it.
 *
 * One number rather than one per mission, for the reason above — 2016 authored
 * one rig — and the MAX rather than the mean so the clearing covers every shipped
 * deck rather than the average of six readings of the same object. The spread
 * that decision is taken across is 13 cm.
 *
 * Returns 0 if no mission materialises a deck, which is a caller's error to
 * report rather than a radius to use.
 */
export const gameClearingRadius = (sites: readonly LaunchSite[]): number => {
  let worst = 0
  for (const site of sites) worst = Math.max(worst, footprintRadius(site))
  return worst
}
