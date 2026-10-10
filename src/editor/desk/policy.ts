// src/editor/desk/policy.ts — every number the desktop editor decides. DEV-469.
//
// ONE exported name, pinned by value in `tests/unit/editor-desk.test.ts` (the
// `HUD_RASTER_SHIPPED` pattern): moving one is an edit made on purpose. These
// are feel, not physics — how far a click may miss a handle, how long the
// editor waits before it saves — and none of them reaches a course's bytes.
//
// What is NOT here: the height a new point sits above the ground. That is
// derived from the sky (`placeHeightFor`, below), so it is 2016's ring and the
// HoverJet's hover height, not a number typed in this file.

import type { Level } from '@/content/level-schema'
import { anchorHeightFor, EDITOR_POLICY } from '@/editor/core'
import { HOVERJET, WORLD } from '@/generated/constants.generated'
import { FLY_LOOK_POLICY } from '@/render/fly-look'
import { cruiseSpeed } from '@/sim/hoverjet'

export const DESK_POLICY = {
  /**
   * CSS pixels a click may land from a control point's handle and still pick
   * it. About a fingertip's width on a laptop screen, and wider than the
   * handle is drawn, so a point is easy to catch and hard to miss.
   */
  pickPixels: 14,
  /**
   * CSS pixels a click may land from the drawn line and INSERT a point on it
   * (rather than add one at the end). Narrower than the handle's reach, so a
   * click beside a handle picks the handle.
   */
  linePixels: 7,
  /** CSS pixels the pointer may travel between down and up and still be a click, not a drag. */
  clickSlopPixels: 5,
  /** A handle's drawn radius, as a fraction of its distance from the eye: constant on screen. */
  handleScreenFraction: 0.012,
  /** Milliseconds after the last edit before the draft is written to storage. */
  autosaveMs: 400,
  /** Milliseconds after the last edit before the rings are rebuilt from the expanded level. */
  ringRebuildMs: 200,
  /** Milliseconds between live evaluations (the warnings) while a point is being dragged. */
  dragEvaluateMs: 120,
  /** The orbit camera's field of view, degrees. The game's own flat lens is wider than a map wants. */
  fovDegrees: 50,
  /**
   * How much of the viewport the play area fills when the camera frames it,
   * as a margin on its radius: 1.15 leaves a little ground showing round it.
   */
  frameMargin: 1.15,
  /** Degrees above the horizon the orbit starts at when it frames the island: a map's oblique. */
  frameElevationDegrees: 50,
  /** The orbit may not tip past this from straight down, degrees: never under the ground plane. */
  maxPolarDegrees: 85,
} as const

/**
 * DEV-472: the desk camera's depth range, and how close F stands to a point.
 * Pinned by value beside `DESK_POLICY` in `tests/unit/editor-desk.test.ts`.
 *
 * WHY THE NEAR PLANE MOVES. The desk used to copy the game camera's near
 * plane, `CAMERA_NEAR` (0.08 m), which is sized for an eye in a cockpit. A
 * perspective depth buffer resolves about `z * z / (near * 2^24)` metres at
 * distance z (24-bit depth, far much larger than near), so from an orbit a few
 * kilometres out that near plane leaves the ground metres of depth resolution:
 * derived, 6.7 m at 3 km and 74 m at 10 km. The sea and the land meet at a
 * shallow angle along every shore, so the two surfaces traded pixels there and
 * the coast shimmered as the waves moved: Matt's "z-fighting/jitter at the
 * shoreline when zoomed out a bit", which "stabilized as i zoomed in".
 *
 * So the near plane is a fixed FRACTION of the orbit distance (never below the
 * game's), which holds the resolution at the orbit's target to
 * `distance / (nearFraction * 2^24)`: 0.04 m at 3 km, 0.12 m at 10 km. Nothing
 * the desk shows stands that close to the eye: the eye is at least
 * `sin(90 - maxPolarDegrees)` of the distance above its target's plane, which
 * is 17 times further than the near plane at the lowest orbit.
 */
export const DESK_CAMERA_POLICY = {
  /** The near plane, as a fraction of the distance from the eye to the orbit's target. */
  nearFraction: 0.005,
  /** The far plane reaches this many play-area radii past the orbit's target. */
  farRadii: 2,
  /**
   * F frames the selected point from where the view shows about this many
   * metres of ground round it: a few rings each side (the gap's range is
   * PLAYER_COURSE_LIMITS'), close enough to place the point, far enough to see
   * where the line comes from and goes.
   */
  focusSpanMetres: 400,
  // ── DEV-472 follow-up: right-drag FLY, Unreal's viewport (`fly.ts`) ────
  /** Degrees the view turns per CSS pixel of mouse travel: a 900 px sweep is a half turn. */
  flyLookDegreesPerPixel: FLY_LOOK_POLICY.flyLookDegreesPerPixel,
  /** The fly's pitch stops this many degrees from straight up and straight down. */
  flyPitchLimitDegrees: FLY_LOOK_POLICY.flyPitchLimitDegrees,
  /**
   * Fly speed, metres a second per metre of height above the render surface:
   * at 30 m it moves 30 m/s (a ring every few seconds), at 1 km 1 km/s (the
   * island in seconds). A Matt call, with the two below.
   */
  flySpeedPerMetre: FLY_LOOK_POLICY.flySpeedPerMetre,
  /** The slowest the fly goes, m/s, whatever the height: low over a hill, it still moves. */
  flySpeedMin: FLY_LOOK_POLICY.flySpeedMin,
  /** The fastest, m/s: from 10 km up, a 2 km/s eye still lets a hand stop over the island. */
  flySpeedMax: FLY_LOOK_POLICY.flySpeedMax,
  /** One wheel notch while flying multiplies (or divides) the speed by this. */
  flyWheelStep: FLY_LOOK_POLICY.flyWheelStep,
  /** The wheel's scale on the speed stays within this factor either way. */
  flyWheelRange: FLY_LOOK_POLICY.flyWheelRange,
} as const

/** The near plane for an eye `distance` metres from the orbit's target: never nearer than `floor`. */
export const deskNear = (distance: number, floor: number): number =>
  Math.max(floor, distance * DESK_CAMERA_POLICY.nearFraction)

/**
 * The height, metres, a new point sits above the RENDER surface: the least at
 * which the sky's ring, centred on the point over flat ground, clears it by
 * the core's clearance. Its trigger radius (the opening, 22.6 m on every
 * shipped HoverJet ring) plus the hover height (4 m), to the metre above.
 * Derived, so a sky with a bigger ring gets a higher default.
 */
export const placeHeightFor = (donor: Level): number => anchorHeightFor(donor) // DEV-501: one derivation

// ── DEV-474: the fly-by ──────────────────────────────────────────────────
//
// Ships launched along the race line so it reads as a flight. Pinned by value
// in `tests/unit/editor-flyby.test.ts`. Only the launch interval and the
// on-screen size are typed here; the pace and the bank are the HoverJet's own.

export const FLYBY_POLICY = {
  /** Seconds between launches: Matt's "every 4 seconds or so" (EDITOR-PLAYTEST-2026-09-27). */
  launchSeconds: 4,
  /**
   * Ships in flight at most. At cruise, 4 s apart is 359 m of line, so twelve
   * cover 4.3 km; a longer line spaces its ships further apart rather than
   * adding more, so the count stays bounded however long a course is drawn.
   */
  maxShips: 12,
  /**
   * A ship's drawn length, as a fraction of its distance from the eye, when
   * that is more than its real length: about 30 px on a 720 px view at the
   * desk's 50 degree lens. From the framing distance a real 10 m hull is two
   * or three pixels, which is rendered, not seen (CLAUDE.md, DEV-044).
   */
  shipScreenFraction: 0.04,
  /**
   * The longest step the fly-by takes in one frame, seconds. The editor's frame
   * does not run while a playtest flies; coming back, the ships carry on from
   * where they were rather than leaping a whole flight's worth along the line.
   */
  maxStepSeconds: 0.1,
  // ── DEV-487: the arrow when small ──────────────────────────────────────
  //
  // Matt, 2026-09-28: *"can LOD to fall back to pyramids or something more
  // obviously directional"*. From above, the hull's long end is the EXHAUST
  // (DEV-040), so a ship a few dozen pixels long read as flying backwards.
  /**
   * The hull is drawn only where its REAL length is at least this fraction of
   * its distance from the eye: twice what a far ship is grown to
   * (`shipScreenFraction`), about 60 px on a 720 px view at the desk's lens.
   * Smaller than that it is the arrow. Every ship grown to be seen is an arrow.
   */
  hullScreenFraction: 0.08,
  /**
   * The hysteresis: a ship showing its hull keeps it until its fraction falls
   * below this multiple of `hullScreenFraction`. A ship hovering at the
   * boundary changes shape once, not every frame.
   */
  lodHysteresis: 0.8,
  /** The arrow's span across its tail, as a fraction of its length (the hull's own length). */
  arrowWidth: 0.7,
  /** How far the notch in its tail reaches forward, as a fraction of its length. */
  arrowNotch: 0.3,
  /** The height of its ridge over the notch, as a fraction of its length: a wedge from the side. */
  arrowHeight: 0.22,
} as const

/** The fly-by's pace, m/s: the HoverJet's unboosted cruise, the speed DEV-468's turn warning judges a bend at. */
export const flybySpeed = (): number => cruiseSpeed(HOVERJET)

/**
 * The most a fly-by ship banks, radians: the bank of a coordinated turn at the
 * HoverJet's measured lateral limit (DEV-027's 162 m/s²) against 2016's world
 * gravity (32 m/s²), about 79°. A tighter bend than the jet can hold banks no
 * further; the tight-turn warning is what says so.
 */
export const flybyMaxBank = (): number =>
  Math.atan(EDITOR_POLICY.latAccelMeasured / Math.abs(WORLD.gravity.y))

/**
 * DEV-504: the heading the desk gives the `n`th prop it places, degrees. The
 * GOLDEN ANGLE, `180 (3 − √5)` ≈ 137.5°, turned `n` times: no two props of a
 * garden face alike and none repeats the one before, which is what a scatter's
 * random yaw buys the island (`sim/props/placements.ts`) — and it is derived,
 * not a number to argue with. The author spins any of them after.
 */
export const propYawFor = (n: number): number => (n * 180 * (3 - Math.sqrt(5))) % 360
