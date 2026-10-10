// src/game/tv/tv-framing.ts: where the Director may put its eye. DEV-652.
//
// Seen on production (CONSULTANT-REVIEW-2026-10-05 §4): twice in a minute the
// camera sat INSIDE a gate's frame and half the picture was green slab, and the
// long shots held the pack at a few pixels. This module is the rules those two
// came from, as GEOMETRY a test can sweep:
//
//   · `eyeInGateFrame`: is an eye (a sphere of the near plane's keep-out) in or
//     against the SOLID of any gate frame, ring or finish?
//   · `eyeInGround`: is it under (or within `groundClearance` of) the terrain
//     over a disk, or is the subject hidden behind a ridge?
//   · `subjectFraction` / `pullInTo`: how much of the frame's height the
//     subject fills from here, and the nearest eye along the same line that
//     fills at least the floor.
//
// ── The gate's solid, and where the number comes from ────────────────────
//
// The gate frame (`jumpGate_diamond`, `game/rings.ts`) is a tube, not a card:
// in the gate's own frame, with `gateFramePose` applied and before the ring's
// own scale (2 on every shipped ring), it stands 36 m wide by 24 m tall with
// bars about 3 m thick, and 17 m deep along the opening's axis (z). Those were
// MEASURED off the real glb through the real `gateFramePose`; `GATE_FRAME` is
// the conservative envelope of them (an ellipse band that contains the hexagon,
// the inner edge pulled in so the bars read thicker than they are), and
// `tests/unit/tv-framing.test.ts` re-measures the glb and fails if the mesh
// ever leaves the envelope or the envelope drifts far off the mesh. A literal
// here is justified only because that test holds it to the asset.
//
// The finish gate is the same mesh at world scale 23.56 (3x a ring's) WITHOUT
// the ring's 90-degree roll, so its hole stands tall where a ring's lies wide:
// the same envelope with x and y swapped (`GateFrame.tall`). Found by flying
// the recorded racers through it: every one crosses at 2.5 to 9.4 profile
// units up the y axis, which is inside a tall hole and in the top bar of a
// wide one (`tests/unit/tv-framing.test.ts` keeps that).
//
// Pure: no three, no DOM. THREE world, Y up.

import type { HeightAt, Vec3T } from './tv-vantage'

/** A gate frame's solid, gate-local metres before the ring's scale. The opening runs along z. */
export const GATE_FRAME = {
  outerX: 18.2,
  outerY: 12.4,
  innerX: 13.5,
  innerY: 8.2,
  zMin: -9.5,
  zMax: 8,
} as const

/** `jumpGate_diamond`'s `framePose` scale (3.885): what a finish at world scale S is, in rings' terms. */
const FRAME_POSE_SCALE = 3.885

/** One gate frame in the world. */
export interface GateFrame {
  /** THREE world. */
  readonly pos: Vec3T
  /** The gate's orientation, x y z w. */
  readonly quat: readonly [number, number, number, number]
  /** The ring's uniform scale (`ring.scale[0]`); a finish's is `finishFrameScale`. */
  readonly scale: number
  /** The finish: its mesh stands without the ring's roll, so the hole is TALL (x and y swapped). */
  readonly tall?: boolean
}

/** The ring-equivalent scale of a finish frame drawn at `worldScale`. */
export const finishFrameScale = (worldScale: number): number => worldScale / FRAME_POSE_SCALE

/** The policy: a camera operator's choices, not 2016 data. Metres and fractions. */
export const FRAMING = {
  /**
   * An eye stays this far (world metres) from any gate frame's solid. The near
   * plane is a fraction of a metre; the rest is the margin that keeps a 3 m
   * bar from filling a quarter of the picture, and the room a few frames of
   * the eye's own motion need.
   */
  gateKeepOut: 11,
  /** The least air between the eye and the highest ground in a small disk under it. */
  groundClearance: 4,
  groundDisk: 5,
  /** The subject must stay above the ground along the sightline by this much. */
  sightClearance: 1.5,
  sightSamples: 18,
  /**
   * The followed racer's hull, metres across: what `subjectFraction` sizes.
   * About the wing span of the racer mesh.
   */
  hull: 6,
  /** The followed racer fills at least this share of the frame's HEIGHT, or the shot moves in or cuts. */
  minSubject: 0.045,
  /** Never pulled nearer than this to the subject (metres): a camera inside the hull is no shot. */
  nearest: 5,
} as const

const rotateInverse = (
  q: readonly [number, number, number, number],
  x: number,
  y: number,
  z: number,
): [number, number, number] => {
  // v' = q^-1 v: conjugate, then q v q*.
  const qx = -q[0]
  const qy = -q[1]
  const qz = -q[2]
  const qw = q[3]
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ]
}

/** The radius of the ellipse (`ax`, `ay`) along the direction (`dx`, `dy`), unit. */
const ellipseRadius = (ax: number, ay: number, dx: number, dy: number): number =>
  1 / Math.sqrt((dx / ax) ** 2 + (dy / ay) ** 2)

/**
 * World metres from `p` to the gate's solid; 0 when `p` is in it. The in-plane
 * gap is measured radially, which over-reads the true gap a little on an
 * ellipse's flanks: `FRAMING.gateKeepOut` has the margin for it.
 */
export const distanceToGateFrame = (g: GateFrame, p: Vec3T): number => {
  const [lx, ly, lz] = rotateInverse(g.quat, p[0] - g.pos[0], p[1] - g.pos[1], p[2] - g.pos[2])
  const x = (g.tall ? ly : lx) / g.scale
  const y = (g.tall ? lx : ly) / g.scale
  const z = lz / g.scale
  const rp = Math.hypot(x, y)
  const dx = rp > 1e-9 ? x / rp : 1
  const dy = rp > 1e-9 ? y / rp : 0
  const G = GATE_FRAME
  const outer = ellipseRadius(G.outerX, G.outerY, dx, dy)
  const inner = ellipseRadius(G.innerX, G.innerY, dx, dy)
  const radial = rp < inner ? inner - rp : rp > outer ? rp - outer : 0
  const depth = z < G.zMin ? G.zMin - z : z > G.zMax ? z - G.zMax : 0
  return Math.hypot(radial, depth) * g.scale
}

/**
 * How strict the eye rules are. The Director's automatic eyes keep a wide berth
 * (`DIRECTOR_LIMITS`: a bar must not fill a quarter of the picture, and a subject
 * must not hide behind a ridge). A viewer's own ORBIT (a click-drag) is where they
 * chose to look from, so it keeps only what is a fault from anywhere: the near plane
 * must not be in a gate's solid or the ground (`USER_LIMITS`).
 */
export interface EyeLimits {
  readonly gateKeepOut: number
  readonly groundClearance: number
  /** Is a subject hidden behind a ridge a fault? */
  readonly sight: boolean
}
export const DIRECTOR_LIMITS: EyeLimits = {
  gateKeepOut: FRAMING.gateKeepOut,
  groundClearance: FRAMING.groundClearance,
  sight: true,
}
/** The camera's near plane is under a metre; this is a few times it, so a bar is never in the lens. */
export const USER_LIMITS: EyeLimits = { gateKeepOut: 3, groundClearance: 2, sight: false }

/** The first gate whose solid is within `keepOut` of `eye`, as its index, or -1. */
export const eyeInGateFrame = (
  gates: readonly GateFrame[],
  eye: Vec3T,
  keepOut: number = FRAMING.gateKeepOut,
): number => {
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] as GateFrame
    // A cheap reject: the solid's reach from its centre bounds the test.
    const reach = Math.hypot(GATE_FRAME.outerX, GATE_FRAME.outerY, GATE_FRAME.zMax) * g.scale
    if (Math.hypot(eye[0] - g.pos[0], eye[1] - g.pos[1], eye[2] - g.pos[2]) > reach + keepOut)
      continue
    if (distanceToGateFrame(g, eye) < keepOut) return i
  }
  return -1
}

/**
 * Is `eye` too near the ground, or is `subject` hidden behind it? The ground is
 * sampled over a disk (CLAUDE.md's heightField trap: the surface you see is up
 * to 21.8 m off the one you hit, so one sample under the eye is blind to the
 * hillside a metre away).
 */
export const eyeInGround = (
  heightAt: HeightAt,
  eye: Vec3T,
  subject: Vec3T | null,
  limits: EyeLimits = DIRECTOR_LIMITS,
): boolean => {
  let top = heightAt(eye[0], eye[2])
  const r = FRAMING.groundDisk
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const h = heightAt(eye[0] + Math.cos(a) * r, eye[2] + Math.sin(a) * r)
    if (h > top) top = h
  }
  if (Number.isFinite(top) && eye[1] < top + limits.groundClearance) return true
  if (!subject || !limits.sight) return false
  for (let i = 1; i < FRAMING.sightSamples; i++) {
    // Not all the way: a racer skimming a slope is near the ground itself, and the
    // last stretch before it is its own surroundings, not a ridge in the way.
    const t = (i / FRAMING.sightSamples) * 0.85
    const x = eye[0] + (subject[0] - eye[0]) * t
    const y = eye[1] + (subject[1] - eye[1]) * t
    const z = eye[2] + (subject[2] - eye[2]) * t
    if (y < heightAt(x, z) + FRAMING.sightClearance) return true
  }
  return false
}

/** Everything that makes an eye unusable. Null when it is clear; else the first reason. */
export const eyeProblem = (
  world: { readonly heightAt: HeightAt; readonly gates: readonly GateFrame[] },
  eye: Vec3T,
  subject: Vec3T | null,
  limits: EyeLimits = DIRECTOR_LIMITS,
): 'gate' | 'ground' | null =>
  eyeInGateFrame(world.gates, eye, limits.gateKeepOut) >= 0
    ? 'gate'
    : eyeInGround(world.heightAt, eye, subject, limits)
      ? 'ground'
      : null

// ── how big the subject is ────────────────────────────────────────────────

/** The share of the frame's HEIGHT a hull of `hull` metres fills at `distance` m under a vertical `fovDeg`. */
export const subjectFraction = (
  distance: number,
  fovDeg: number,
  hull: number = FRAMING.hull,
): number => hull / (2 * Math.max(1e-6, distance) * Math.tan(((fovDeg / 2) * Math.PI) / 180))

/** The farthest an eye may stand (metres) for the subject to fill `fraction` of the height. */
export const farthestFor = (
  fovDeg: number,
  fraction: number = FRAMING.minSubject,
  hull: number = FRAMING.hull,
): number => hull / (2 * fraction * Math.tan(((fovDeg / 2) * Math.PI) / 180))
