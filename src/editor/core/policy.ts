// src/editor/core/policy.ts — every number the editor core decides. DEV-468, E2.
//
// ONE exported name, pinned by value in `tests/unit/editor-core.test.ts` (the
// `HUD_RASTER_SHIPPED` pattern, CLAUDE.md "CHANGING A SHIPPED DEFAULT"): moving
// one is an edit somebody makes there on purpose. Each is policy, not physics,
// and each is a Matt call in DEVIATIONS DEV-468.
//
// What is NOT here, on purpose: every number a warning compares against that
// already exists somewhere true. The ring's opening is the DONOR's trigger
// radius, the finish's reach is the donor's finish radius, the ground clearance
// is the HoverJet's `hoverMotor.hoverHeight` off the generated sheet, and the
// cruise speed a turn is judged at is `cruiseSpeed()` of that same sheet. None
// of them is retyped (hard rule 3).

import { type Level, liveRings } from '@/content/level-schema'
import { HOVERJET_LAT_ACCEL_MEASURED } from '@/game/measured'
import { HOVERJET } from '@/generated/constants.generated'
import { cruiseSpeed } from '@/sim/hoverjet'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'

export const EDITOR_POLICY = {
  /**
   * Undo entries kept. king-tide's `UNDO_LIMIT`, lifted with the file. A drag
   * coalesces to one entry, so this is fifty ACTIONS, not fifty mouse moves.
   */
  undoDepth: 50,
  /**
   * Drafts kept in `localStorage`: the SHELF (DEV-889, Matt, 2026-10-09: keep
   * the last few, newest first). A draft is a few hundred bytes to ~2 KB
   * (64 points at most); past this the least recently edited is dropped, and
   * the desk asks before it does (`draftToDrop`). It was 24 while no list
   * showed them: four islands built, one draft reachable.
   */
  maxDrafts: 5,
  /**
   * Points sampled round a ring's opening when asking whether the ground
   * reaches into it. 16 is every 22.5°: on the 22.6 m trigger radius of every
   * shipped HoverJet ring that is a chord of 8.8 m, finer than the terrain's
   * 8 m grid, so a single facet cannot rise between two samples unseen.
   */
  ringOpeningSamples: 16,
  /**
   * DEV-475: points sampled round a start pad's rim (and a racer's pad) when
   * asking what ground is under it. On the sky's 9.35 m lift pad 16 is a chord
   * of 1.8 m, finer than the terrain's 8 m grid, as the ring's sampling is.
   */
  padFootprintSamples: 16,
  /**
   * The HoverJet's lateral limit, m/s², MEASURED off its own flight model in
   * DEV-027 (a 136 m turn at 149 m/s, about 5 g). It is `SHIP_LAT_ACCEL` in
   * `boot/app/pins.ts`; both read `game/measured.ts`, so a re-measurement
   * cannot move one and leave the other.
   */
  latAccelMeasured: HOVERJET_LAT_ACCEL_MEASURED,
  /**
   * The PROPOSED par rule's ratio (Matt call): the time bonus's par is this
   * many times the author's clean lap, never past the time limit. It is 2016's
   * own relation between its one clean recorded flight and its par: the slow
   * `int_01` ghost takes all 21 rings in 102.44 s against a par of 180, a ratio
   * of 1.757. Rounded DOWN to 1.75 so the rule never pays more than 2016 did.
   * The test re-scores that ghost and holds this within 1 % of the ratio.
   */
  parPerAuthorSecond: 1.75,
  /**
   * DEV-478: the most rounds "Lift clear of the ground" (`lift.ts`) measures
   * and raises before it stops. A bound on work, not a tuning: each round
   * raises every short point by what it needs, so a line clears in a handful
   * (the property test in `editor-lift.test.ts` records the most it took, and
   * holds it well under this).
   */
  liftRounds: 48,
  /**
   * DEV-486: metres between the samples of the run-in (the straight from the
   * pad to the line's first point) when it is judged against the ground: half
   * the terrain's 8 m grid, so no facet rises between two samples unseen, as
   * the ring's and the pad's samplings are chosen.
   */
  runInSampleMetres: 4,
  /**
   * DEV-486: metres between the places tried when the fix moves the pad
   * behind the line's first point (`run-in.ts`), walking back along the line's
   * first tangent: the step `desk/slots.ts`'s `padSpot` walks, under a pad's
   * 9.35 m width, so no pad-sized patch of good ground is stepped over.
   */
  runInMoveStepMetres: 8,
  /**
   * DEV-501: degrees between the headings tried when a new pad (or "Anchor to
   * pad") looks for one whose anchored ring 1 stands clear of the ground
   * (`anchorHeading`), alternating either side of the one it has. At a 497 m
   * gap a step swings ring 1 about 43 m. 15° was tried first and stepped over
   * the one way out of the desert canyon's new pad, which is under 15° wide
   * (clear at 75°, short at 62.7° and 77.7°; a sweep, in DEV-501's row).
   */
  anchorHeadingStepDegrees: 5,
} as const

/**
 * The ground clearance every terrain warning uses, metres: the HoverJet's
 * `hoverMotor.hoverHeight`, 4 on the shipped prefab. Inside it the hover motor
 * pushes the ship UP (`sim/hover-motor.ts`), so a ring opening or a stretch of
 * line lower than this over the ground cannot be flown where it is drawn.
 */
export const groundClearance = (): number => HOVERJET.hoverMotor.hoverHeight

/**
 * DEV-503: the HoverJet's own collision radius, metres: how far its hull
 * reaches from the body's origin — the furthest edge of its widest-flung hull
 * sphere (`HOVERJET_GROUND`, off the shipped prefab's five colliders). A prop
 * closer to the flown line than this is struck by a ship flying the line
 * exactly, whichever way it is rolled.
 */
export const shipCollisionRadius = (): number =>
  Math.max(0, ...HOVERJET_GROUND.collision.hull.map((h) => Math.hypot(h.x, h.y, h.z) + h.radius))

/**
 * DEV-503: how near the flown line a collidable prop may stand before the
 * editor says so (`line-through-prop`): the ship's collision radius plus the
 * clearance every ground warning keeps (`groundClearance`). Derived, so a hull
 * or a hover height that moves moves it; no number of its own.
 */
export const propReach = (): number => shipCollisionRadius() + groundClearance()

/**
 * The tightest radius, metres, the HoverJet holds at its unboosted cruise:
 * `cruise² / latAccel`, about 50 m on 2016's sheet (89.8 m/s). Tighter than
 * this the line asks for more than 5 g at the speed a held throttle settles
 * at, so a pilot must brake for it; the AI racers (whose velocity profile uses
 * the same two numbers) will.
 */
export const tightestTurnRadius = (): number =>
  cruiseSpeed(HOVERJET) ** 2 / EDITOR_POLICY.latAccelMeasured

/**
 * DEV-501: the height, metres, of a new point over the ground under it — and
 * of an ANCHORED first point over the pad's foot. The least at which the
 * sky's ring, centred on the point over flat ground, clears it by the
 * clearance: its trigger radius (the opening, 22.6 m on every shipped HoverJet
 * ring) plus the hover height (4 m), to the metre above. 27 m on every shipped
 * sky. Derived, so a sky with a bigger ring gets a higher one. (It was the
 * desk's `placeHeightFor`; the anchor made the core need it.)
 *
 * Over the PAD rather than over the ground where the ring stands, because the
 * anchor is a rigid offset of the pad's transform (Matt, 2026-09-28: "moving
 * and rotating the control object will move and rotate the control point
 * relative to that object's transform"). Ground that rises between the pad and
 * the ring is the buried-ring error, whose fix is to turn or move the pad.
 */
export const anchorHeightFor = (donor: Level): number => {
  const ring = liveRings(donor)[0]
  const opening = ring ? ring.trigger.radius : 0
  return Math.ceil(opening + groundClearance())
}
