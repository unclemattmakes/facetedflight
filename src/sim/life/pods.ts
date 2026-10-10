// src/sim/life/pods.ts — sea life that leaps (the dolphins). DEV-449; the fish went with DEV-545.
//
// The life pass's third slice. NEXT.md P4 #16: *"dolphins and polyfish
// jumping — boats plus a jump arc"*. The animals are polyfish's (Matt's own);
// this file is where they swim and when they leap.
//
// ── Where: a pod is a boat that never surfaces for long ───────────────────
//
// Pods are aimed where the boats aim — `alongRoute` at `(i + 0.5)/n` of the
// course's line, `atStart` at the spawn — and each takes the first water,
// searched outward in rings (`sim/life/search.ts`), that is on the sea, at
// least `depth` metres deep (open ocean counts: a dolphin wants room, not a
// shore), off the spawn clearings, and `spacing` from every other pod. Then
// `perPod` animals round the pod's centre inside `podRadius`, all heading one
// way (a pod travels together) give or take `swing`.
//
// ── When: a periodic ballistic leap, a pure function of the clock ─────────
//
// Each animal carries a period, a phase, a height and a length. Once a period
// it leaves the water, flies the parabola a thrown body flies under `gravity`
// — `h = 4 H s (1 - s)` over the leap's fraction `s`, for `2 sqrt(2H/g)`
// seconds — and goes back in; the rest of the period it is under, and not
// drawn. Its nose follows the arc's tangent. Nothing integrates: `leapAt`
// is a pure function of time, like `birdAt` (DEV-089), so a dropped frame or
// a paused second costs a pod nothing.
//
// `gravity` is the preset's, and it is NOT the sim's (0, −32, 0), which is
// 2016's tuning for the SHIPS. An animal leaping under −32 hangs for two thirds
// of the time a real one does and reads as wrong; this is scenery, and the
// number a person would argue with is in the JSON.
//
// ── What a leaper is NOT ─────────────────────────────────────────────────
//
// Not a collider, not a score, not seen by any sim module (DEV-146's rule).
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`.

import { type KeepOut, waterDepthAt } from '@/sim/life/boats'
import { searchRings } from '@/sim/life/search'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { type Route, routeAt } from '@/sim/route'
import { makeRandom } from '@/sim/terrain/faceted'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'

/** The placement and leap half of `life.dolphins` (and any leaping kind after it). See `_schema.json`. */
export interface PodSpec {
  readonly seed: number
  readonly alongRoute: number
  readonly atStart: number
  readonly routeReach: readonly [number, number]
  readonly startReach: readonly [number, number]
  /** Metres of water a pod needs under it (open ocean counts). */
  readonly depth: number
  /** Metres between two pods. */
  readonly spacing: number
  /** Animals a pod, `[min, max]`. */
  readonly perPod: readonly [number, number]
  /** Metres a pod spreads round its centre. */
  readonly podRadius: number
  /** Degrees either side of the pod's shared heading. */
  readonly swing: number
  /** Seconds between one animal's leaps, `[min, max]`. */
  readonly period: readonly [number, number]
  /** Metres a leap clears the water by, `[min, max]`. */
  readonly height: readonly [number, number]
  /** Metres a leap covers, `[min, max]`. */
  readonly length: readonly [number, number]
  /** Uniform scale on the mesh, `[min, max]`. */
  readonly scale: readonly [number, number]
  readonly search: { readonly step: number; readonly angles: number }
  /**
   * DEV-532: metres the LINE may stand over the sea's base at an aim and still
   * aim a pod there. Absent: every aim. A pod under a line flown 300 m up is a
   * pod nobody sees (DEV-532's row measured it), so the aims go where the lap
   * comes down to the water.
   */
  readonly lineAbove?: number
}

export interface PodInput {
  readonly spec: PodSpec
  readonly courseSeed: number
  readonly line: Route | null
  readonly start: { readonly x: number; readonly z: number }
  readonly sea: HeightField
  readonly land: HeightField | null
  readonly keepOut: readonly KeepOut[]
}

/** One animal. SIM space. */
export interface Leaper {
  /** The middle of its leap, SIM plan. */
  readonly x: number
  readonly z: number
  /** Radians about +y, SIM: it travels along `(sin, cos)`. */
  readonly heading: number
  readonly period: number
  /** Seconds added to the clock before the period is taken. */
  readonly phase: number
  readonly height: number
  readonly length: number
  readonly scale: number
  /** Which pod, for a probe. */
  readonly pod: number
}

const lerp = (r: readonly [number, number], t: number): number =>
  (r[0] as number) + t * ((r[1] as number) - (r[0] as number))

/** Place every pod. Deterministic: one stream, one fixed order, every draw before the search. */
export const placePods = (input: PodInput): Leaper[] => {
  const { spec, sea, land } = input
  const rnd = makeRandom((spec.seed ^ input.courseSeed) >>> 0)
  const out: Leaper[] = []
  const centres: { x: number; z: number }[] = []
  const perMin = Math.max(0, Math.floor(spec.perPod[0] as number))
  const perMax = Math.max(perMin, Math.floor(spec.perPod[1] as number))
  const swing = (spec.swing * Math.PI) / 180

  const water = (x: number, z: number): boolean => waterDepthAt(sea, land, x, z) >= spec.depth

  const pod = (cx: number, cz: number, band: readonly [number, number]): void => {
    const phase = rnd() * Math.PI * 2
    const heading = rnd() * Math.PI * 2
    const count = perMin + Math.floor(rnd() * (perMax - perMin + 1))
    const draws = Array.from({ length: count }, () => [
      rnd(),
      rnd(),
      rnd(),
      rnd(),
      rnd(),
      rnd(),
      rnd(),
    ])
    const at = searchRings(
      cx,
      cz,
      band,
      spec.search,
      phase,
      (x, z) =>
        water(x, z) &&
        !input.keepOut.some((k) => (x - k.x) ** 2 + (z - k.z) ** 2 < k.radius ** 2) &&
        !centres.some((o) => (x - o.x) ** 2 + (z - o.z) ** 2 < spec.spacing ** 2),
    )
    if (!at) return
    centres.push(at)
    const index = centres.length - 1
    for (const d of draws) {
      const r = spec.podRadius * Math.sqrt(d[0] as number)
      const a = (d[1] as number) * Math.PI * 2
      const x = at.x + Math.cos(a) * r
      const z = at.z + Math.sin(a) * r
      if (!water(x, z)) continue
      const period = lerp(spec.period, d[2] as number)
      out.push({
        x,
        z,
        heading: heading + ((d[3] as number) * 2 - 1) * swing,
        period,
        phase: (d[4] as number) * period,
        height: lerp(spec.height, d[5] as number),
        length: lerp(spec.length, d[6] as number),
        scale: lerp(spec.scale, (d[5] as number) * 0.5 + (d[6] as number) * 0.5),
        pod: index,
      })
    }
  }

  for (let i = 0; i < spec.atStart; i++) pod(input.start.x, input.start.z, spec.startReach)
  if (input.line && spec.alongRoute > 0) {
    const p: Vec3 = v3()
    for (let i = 0; i < spec.alongRoute; i++) {
      const f = (i + 0.5) / spec.alongRoute
      routeAt(input.line, f * input.line.length, p)
      // The line's height over the sea's base here (off the sea's plate there
      // is no sea to leap from, and the search will say so anyway).
      const high =
        spec.lineAbove !== undefined &&
        !outsideField(sea, p.x, p.z) &&
        p.y - terrainHeightAt(sea, p.x, p.z) > spec.lineAbove
      if (!high) pod(p.x, p.z, spec.routeReach)
    }
  }
  return out
}

/** Where a leaper is at a moment. SIM offsets from its leap's middle. */
export interface LeapPose {
  /** Out of the water this instant. False: under, not drawn. */
  airborne: boolean
  /** Metres along its heading from the leap's middle, −length/2 … +length/2. */
  along: number
  /** Metres above the water surface. */
  up: number
  /** Radians the nose is raised: +up the arc, −down it. */
  pitch: number
}

/** A pose to fill. Callers keep one; `leapAt` writes it. */
export const leapPose = (): LeapPose => ({ airborne: false, along: 0, up: 0, pitch: 0 })

/**
 * The leap at `seconds`, into `out`. Airborne for `2 sqrt(2H/g)` of every
 * period, starting at the period's beginning (after the phase shift).
 */
export const leapAt = (l: Leaper, seconds: number, gravity: number, out: LeapPose): LeapPose => {
  const u = (((seconds + l.phase) % l.period) + l.period) % l.period
  return leapSince(l, u, gravity, out)
}

/** Seconds a leap of `height` stays out of the water under `gravity`: `2 sqrt(2H/g)`. */
export const airTime = (height: number, gravity: number): number =>
  2 * Math.sqrt((2 * height) / Math.max(1e-6, gravity))

/**
 * The leap `u` seconds after it left the water, into `out`: airborne while
 * `0 <= u < airTime`, under otherwise. `leapAt` is this at the period's phase;
 * a breach (below) is this at the seconds since the pod was cued.
 */
export const leapSince = (l: Leaper, u: number, gravity: number, out: LeapPose): LeapPose => {
  const air = airTime(l.height, gravity)
  if (!(u >= 0) || u >= air || !(l.length > 0)) {
    out.airborne = false
    out.along = 0
    out.up = 0
    out.pitch = 0
    return out
  }
  const s = u / air
  out.airborne = true
  out.along = (s - 0.5) * l.length
  out.up = 4 * l.height * s * (1 - s)
  // d(up)/d(along) = 4H(1 - 2s) / L: the arc's own slope.
  out.pitch = Math.atan2(4 * l.height * (1 - 2 * s), l.length)
  return out
}

// ── The breach: a pod leaps together as the player comes at it (DEV-532) ──
//
// Matt, 2026-09-29: *"i haven't seen the dolphins."* Measured over int_01's
// racing line with the land in the way (DEV-532's row): a dolphin was in the
// air, in view and ten pixels or more for about a third of a second a lap.
// The period alone cannot fix that — a pod is in view for well under two
// seconds at 600 km/h, and a leap is up for about one and a half of every
// four to nine — so a pod also BREACHES: when the eye is coming at it, fast,
// with the pod ahead, every animal leaps once, `stagger` seconds apart, timed
// so the arcs' apex falls when the pod is `apexAhead` metres off — or farther,
// when the eye is high: never nearer than puts the pod `below` degrees under
// the eye's level, which is where it leaves the bottom of the frame (the
// cockpit's view reaches 35 degrees down). Then the
// pod rests `rest` seconds before it can be cued again, and goes back to its
// period in between. The eye is the only input that is not the clock; the
// leap itself is still `leapSince`, a function of time.
//
// Scenery that reacts to the player is not a gameplay rule (DEV-146): nothing
// here can touch a ship, a score or a board.

/** `life.<kind>.breach`: the cue, in the preset. See `_schema.json`. */
export interface BreachSpec {
  /** Metres ahead of the eye the arcs' apex should fall. */
  readonly apexAhead: number
  /**
   * Degrees under the eye's level the apex may fall, at most: from a height
   * `h` the apex is kept `h / tan(below)` out, so it stays in the frame.
   */
  readonly below: number
  /** Degrees either side of the eye's travel the pod must stand in. */
  readonly ahead: number
  /** Metres, the farthest a pod is cued from (a guard for very fast eyes). */
  readonly reach: number
  /** m/s: slower than this the eye is not "coming at" anything (the deck, a stop). */
  readonly minSpeed: number
  /** Seconds between one animal of the pod leaving the water and the next. */
  readonly stagger: number
  /** Seconds a pod rests after a breach before it can be cued again. */
  readonly rest: number
}

/**
 * Should a pod at `(px, pz)` breach now, for an eye at `(ex, ez)` moving
 * `(vx, vz)` m/s? Any plan frame, so long as all three share it. `air` is the
 * pod's leap time: the cue leads the apex by half of it at the closing speed.
 * `above` is the eye's height over the water, metres (0 if unknown).
 */
export const breachDue = (
  px: number,
  pz: number,
  ex: number,
  ez: number,
  vx: number,
  vz: number,
  air: number,
  spec: BreachSpec,
  above = 0,
): boolean => {
  const dx = px - ex
  const dz = pz - ez
  const d = Math.hypot(dx, dz)
  const speed = Math.hypot(vx, vz)
  if (!(speed >= spec.minSpeed) || !(d > 0) || d > spec.reach) return false
  const cos = (dx * vx + dz * vz) / (d * speed)
  if (cos < Math.cos((spec.ahead * Math.PI) / 180)) return false
  const closing = speed * cos
  const apex = Math.max(spec.apexAhead, above / Math.tan((spec.below * Math.PI) / 180))
  return d <= apex + (closing * air) / 2
}
