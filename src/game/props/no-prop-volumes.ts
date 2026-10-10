// src/game/props/no-prop-volumes.ts — authored volumes, resolved for one world.
//
// DEV-287. `content/no-prop-volumes.ts` is the schema and the file; this is the
// twenty lines that turn one environment's entries into the mesh-space capsules
// `sim/props/clearing.ts` tests, for the mission that is actually loading.
//
// ── One frame in, one frame out, and one subtraction between them ────────
//
// **Every anchor point handed to this module is SIM world space.** Not three
// space, not mesh space. The caller converts once, at the one place that knows
// which it holds (`level.spawn.pos` is three; `Gate.centre` is already sim),
// and everything here subtracts the terrain's SIM origin and nothing else:
//
//     meshX = simX - origin.x
//     meshZ = simZ - origin.z
//
// That is `tools/assets/bake-placements.mjs`'s expression for DEV-100's spawn
// cylinders, character for character, and it is checked against that tool's own
// receipt in `tests/unit/no-prop-volumes.test.ts` — the receipt is an
// independently derived oracle for this exact conversion, so a frame mistake
// here shows up as two numbers disagreeing rather than as a forest that is
// subtly in the wrong place. DEV-042 is what one uncrosschecked copy of that
// sum cost.
//
// An explicit `[x, z]` end is already in mesh space and is passed straight
// through: the whole point of authoring in that frame is that nothing happens
// to the numbers between the JSON and the test.

import type { Level } from '@/content/level-schema'
import type { NoPropVolumeFile, NoPropVolumeSpec, VolumeEnd } from '@/content/no-prop-volumes'
import { PLAYER_COURSE_GENERATOR } from '@/content/player-course'
import type { NoPropVolume } from '@/sim/props/clearing'

/** The points an anchor can name, SIM world space. See the header. */
export interface AnchorPoints {
  /** The mission's spawn. Absent on an environment with no mission. */
  readonly spawn?: { readonly x: number; readonly z: number } | undefined
  /** The running course's LIVE gates, in order. Empty on a mode with none. */
  readonly gates: readonly { readonly x: number; readonly z: number }[]
}

/** What `resolveNoPropVolumes` was asked about. */
export interface ResolveContext {
  readonly environmentId: string
  /** Null on the title valley and anywhere else with no mission. */
  readonly missionId: string | null
  /** The terrain's origin in SIM space — `terrainOriginSim(land, worldOffset).position`. */
  readonly origin: readonly number[]
  readonly anchors: AnchorPoints
}

/** Why a volume was left out, so the receipt can say rather than imply. */
export interface DroppedVolume {
  readonly id: string
  readonly reason: string
}

export interface ResolvedVolumes {
  readonly volumes: readonly NoPropVolume[]
  readonly dropped: readonly DroppedVolume[]
}

const GATE = /^gate:(\d+)$/

/**
 * One end, in the terrain's mesh space, or null when it cannot be resolved.
 *
 * Null is a real answer and the caller must drop the whole volume on it — see
 * `VolumeEnd`'s note on why a fallback would be worse than nothing.
 */
const endToMesh = (
  end: VolumeEnd,
  ctx: ResolveContext,
): { readonly x: number; readonly z: number } | null => {
  const ox = ctx.origin[0] ?? 0
  const oz = ctx.origin[2] ?? 0

  if (Array.isArray(end)) {
    const x = end[0]
    const z = end[1]
    if (typeof x !== 'number' || typeof z !== 'number') return null
    // Already mesh space. Nothing happens to it, which is the point.
    return { x, z }
  }
  if (typeof end !== 'string') return null

  if (end === 'spawn') {
    const s = ctx.anchors.spawn
    return s ? { x: s.x - ox, z: s.z - oz } : null
  }
  const gate = GATE.exec(end)
  if (gate) {
    const n = Number(gate[1])
    const g = ctx.anchors.gates[n]
    return g ? { x: g.x - ox, z: g.z - oz } : null
  }
  return null
}

/** Is this volume for the mission that is loading? */
const appliesToMission = (spec: NoPropVolumeSpec, missionId: string | null): boolean => {
  if (!spec.missions) return true
  return missionId !== null && spec.missions.includes(missionId)
}

/**
 * The volumes that apply to this world, as mesh-space capsules.
 *
 * Deterministic and order-preserving: the list is the file's order, so a
 * receipt naming "the second volume" means the second one written down.
 */
export const resolveNoPropVolumes = (
  file: NoPropVolumeFile | null,
  ctx: ResolveContext,
): ResolvedVolumes => {
  const specs = file?.environments?.[ctx.environmentId] ?? []
  const volumes: NoPropVolume[] = []
  const dropped: DroppedVolume[] = []

  for (const spec of specs) {
    if (!appliesToMission(spec, ctx.missionId)) {
      dropped.push({ id: spec.id, reason: `not for mission ${ctx.missionId ?? '(none)'}` })
      continue
    }
    if (!(spec.radius > 0)) {
      dropped.push({ id: spec.id, reason: `radius ${spec.radius} is not positive` })
      continue
    }
    if (spec.ends.length < 1 || spec.ends.length > 2) {
      // Refused rather than truncated — see `NoPropVolumeSpec.ends`.
      dropped.push({ id: spec.id, reason: `${spec.ends.length} ends; a volume takes one or two` })
      continue
    }
    const a = endToMesh(spec.ends[0] as VolumeEnd, ctx)
    if (!a) {
      dropped.push({ id: spec.id, reason: `unresolved end ${JSON.stringify(spec.ends[0])}` })
      continue
    }
    if (spec.ends.length === 1) {
      volumes.push({ x: a.x, z: a.z, radius: spec.radius })
      continue
    }
    const b = endToMesh(spec.ends[1] as VolumeEnd, ctx)
    if (!b) {
      dropped.push({ id: spec.id, reason: `unresolved end ${JSON.stringify(spec.ends[1])}` })
      continue
    }
    volumes.push({ x: a.x, z: a.z, radius: spec.radius, x2: b.x, z2: b.z })
  }
  return { volumes, dropped }
}

/**
 * The ground every live JumpSeat pad clears of scatter: its own landing
 * surface, wide as the bowl. DEV-345.
 *
 * DERIVED, not authored, and that is the difference from everything above.
 * Anniversary's unbaked passes (DEV-102) stand trees in five of the 49 live
 * pads — trunks 1–13 m from the bullseye's centre, one of them 29 m above the plate —
 * and a seat cannot land through a tree any more than through stone. The
 * scatter is a seeded re-roll (DEV-006), so no 2016 layout ever had those
 * trees there, and a hand-written list of the five would go stale the next
 * time the bake or its seed moves. The rule is DEV-100's instead: a structure
 * the player uses keeps its own footprint clear, measured off its own collider.
 *
 * `solid.outer` rather than the 28.4 m landing trigger: measured over the six
 * missions it takes 54 props and clears every tree case, where the trigger's
 * radius takes 108 and leaves a bald ring round every pad in alpine.
 *
 * Applied on BOTH presets, like DEV-100 and DEV-287: a tree through a pad's
 * floor is wrong to look at whether or not it is solid. Handed to
 * `loadProps` and `loadDressing` on the same list as the authored volumes, so
 * the palms and the rocks leave the same ground (DEV-103).
 */
export const padClearings = (
  pads: readonly { readonly x: number; readonly z: number; readonly radius: number }[],
  origin: readonly number[],
): NoPropVolume[] => {
  const ox = origin[0] ?? 0
  const oz = origin[2] ?? 0
  // SIM world to the terrain's mesh space: the header's one subtraction.
  return pads.map((p) => ({ x: p.x - ox, z: p.z - oz, radius: p.radius }))
}

/**
 * The ground a PLAYER COURSE's start pad keeps clear (DEV-475): one cylinder
 * round the ship on its pad, SIM space, for `padClearings` to carry into the
 * terrain's mesh space.
 *
 * The brief asked for "a DEV-287 prop clearing around the pad". Its radius is
 * not typed here: it is the environment's own DEV-100 `spawnClearing` radius,
 * the widest launch-deck footprint in the game (51.97 m, the same on every
 * island), which is what every shipped spawn is cleared by and which holds the
 * whole grid (2016's two pads 16 m off each shoulder, the chevron's apex
 * 27.5 m ahead, and each pad's half-width). Empty for anything but a player
 * course, so no shipped mission's scatter moves by a single prop.
 */
export const startPadClearings = (
  level: Level,
  radius: number | null | undefined,
): { x: number; z: number; radius: number }[] => {
  if (level.generated?.generator !== PLAYER_COURSE_GENERATOR) return []
  if (!(typeof radius === 'number' && radius > 0)) return []
  // THREE -> SIM is the z mirror.
  return [{ x: level.spawn.pos[0] as number, z: -(level.spawn.pos[2] as number), radius }]
}

/** A one-line receipt for the console. Says what applied AND what did not. */
export const describeVolumes = (resolved: ResolvedVolumes): string => {
  const head = `${resolved.volumes.length} no-prop volume${resolved.volumes.length === 1 ? '' : 's'}`
  if (resolved.dropped.length === 0) return head
  return `${head} (dropped ${resolved.dropped.map((d) => `${d.id}: ${d.reason}`).join('; ')})`
}
