// src/game/tv/tv-camera.ts: Faceted Flight TV's viewer control. DEV-481.
//
// Matt, 2026-09-30: *"viewer control (spectate each racer, a director
// auto-cam, and a free-mode)"*. plan/FF-TV.md §5.3 is the spec; this is the
// one module that implements it, over A LIST OF CRAFT: a room's remote ships
// (`?watch=`, and TV's live races), DEV-483's exhibition field, or later board
// ghosts. It does not care which.
//
// ── The three modes ───────────────────────────────────────────────────────
//
//   DIRECTOR (the default). Automatic: wide on the START, then the LEADER, a
//     BATTLE when two craft are within a few hull lengths, the FINISH. A shot
//     holds at least `directorMinHold` seconds unless its subject vanishes.
//   FOLLOW: the chosen racer. `next()` / `previous()` cycle every craft and
//     wrap; `follow(n)` picks Racer n (a `?follow=` link).
//   FREE. Flat: the editor's fly-look (`editor/desk/fly.ts`): look with the
//     mouse, W/S/A/D/Q/E, the wheel for speed; a pad's two sticks. Kept above
//     the ground and inside the course's bounds. Headset: continuous flight
//     along the head's gaze with a smooth turn (below); with the comfort cuts
//     on, TELEPORT and SNAP TURN instead (`tv-teleport.ts`).
//
// ── Flat, and in a headset: the rule that decides the whole shape ─────────
//
// FLAT, Director and Follow fly `watchCamera`'s chase (24 m behind, 7 m above,
// the heading settled and never the roll): the rig is the camera and moves
// every frame, which on a monitor is just a camera. A click-drag there ORBITS
// the chase about its racer and the wheel zooms it (DEV-616, Matt: "if i do
// click and drag, i want to orbit (in chase cam)"); let go, and after
// `orbitHoldSeconds` it eases back to the director's framing. In Free (the
// first-person view) the same drag is the mouse-look. TV never captures the
// pointer: a tab of TV on a second monitor keeps its cursor.
//
// PRESENTING, AT LAUNCH: **the same as flat** (Matt, 2026-10-01: *"let's keep
// it functionally identical to flat at launch. (don't limit VR users to
// teleport and snap turn)"*). Director and Follow fly the same chase, the rig
// at the flat camera's eye but LEVEL (yaw only: a pitched rig tilts the
// wearer's world, DEV-264), the head free inside it and never written. Free
// flies the HEAD: the left stick along its gaze and its level right, the right
// stick's x a smooth turn about the head, its y up and down.
//
// PRESENTING WITH `headsetCuts` (`gameplay.tv.headsetCuts`, off at launch; kept
// for a comfort option): **the rig never moves between cuts.** Director and Follow are
// shown from trackside vantage points (`tv-vantage.ts`), and the move from one
// to the next is a CUT THROUGH BLACK (`cutOut` + `cutIn`, 0.3 s): the screen
// goes black, the rig is placed once, the screen comes back. Free is a
// teleport (the same cut) or a 30° snap. No chase, no ride-along, no smooth
// flight. `frame()` re-writes the HELD pose every frame (the mission's own
// camera code writes the rig before this runs (`flight.render`), so a module
// that wrote only on the cut frame would leave the wearer in the cockpit of a
// hidden ship), and the pose it writes is bit-identical between cuts.
// `tests/unit/tv-camera.test.ts` records a race and asserts exactly that.
//
// ── Inputs, and what this module does NOT own ─────────────────────────────
//
// Pure maths over three's types: no DOM, no listeners, no clock (time is the
// sum of the `dt`s it is handed). The boot block reads the devices and hands
// a `TvCameraInput` each frame; `boot/app.ts` owns the keys, the plate row
// (DEV-480) and the standings' picks (DEV-482) and calls `setMode`, `next`,
// `previous`, `follow`.
//
// ── The craft convention ──────────────────────────────────────────────────
//
// A craft's quaternion is its DRAWN hull's, THREE world, and a hull out of the
// Unity mirror noses along its local −Z (CLAUDE.md trap 22; `remote-ships.ts`
// draws them so, and `watchCamera` read them so). A source whose hulls are not
// mirrored hands `forward` instead.

import * as THREE from 'three'
import { HOVERJET } from '@/generated/constants.generated'
import { shapeAxis } from '@/input/gamepad'
import {
  anglesOf,
  FLY_LOOK_POLICY,
  type FlyAngles,
  type FlyKeys,
  flyForward,
  flyLook,
  flyQuaternion,
  flyRight,
  flySpeed,
  flyStep,
  flyWheel,
  viewOf,
} from '@/render/fly-look'
import {
  DIRECTOR_LIMITS,
  type EyeLimits,
  eyeProblem,
  FRAMING,
  farthestFor,
  type GateFrame,
  subjectFraction,
  USER_LIMITS,
} from './tv-framing'
import { createFinishTracker, createStandingsTracker } from './tv-standings'
import { headWorld, type RigPose, rigForEye, snapTurn, teleportTarget } from './tv-teleport'
import {
  buildRoute,
  buildVantages,
  groundInDisk,
  type HeightAt,
  type Obstructed,
  projectOnRoute,
  type Route,
  type RouteFix,
  routeHeadingAt,
  routePointAt,
  type TvBounds,
  type TvCourse,
  type Vantage,
  type Vec3T,
} from './tv-vantage'

export type TvCameraMode = 'director' | 'follow' | 'free'
export const TV_CAMERA_MODES: readonly TvCameraMode[] = ['director', 'follow', 'free']

/** What the Director is showing. */
export type TvShot = 'start' | 'leader' | 'battle' | 'finish'

/**
 * How the Director films its shot (DEV-618). `chase`: behind and above (the
 * chase Follow flies). `wide`: back and up from the pack (the start).
 * `side`: a tracking shot from beside the line. `aerial`: high and wide over
 * the island. `pair`: the racer and its rival, or the next in the pack, in one
 * frame. `trackside`: a fixed camera at the gate the racer is coming to.
 * `flyby`: a fixed camera low beside the course ahead, as the racer whips past.
 * DEV-652: `lead`: a camera AHEAD of the racer, looking back at it, kept at its
 * speed. `shoulder`: an onboard, just behind and above the racer, looking where
 * it is going. `opening`: in FRONT of the start line, looking back at the grid,
 * held through the countdown and the launch until the field has passed it.
 * DEV-654: `orbit`: the WINNER's shot at the finish, a camera circling the first
 * racer across the line for `winnerSeconds`; never in a pool, it is cut to by the
 * finish itself.
 */
export type TvFraming =
  | 'chase'
  | 'wide'
  | 'side'
  | 'aerial'
  | 'pair'
  | 'trackside'
  | 'flyby'
  | 'lead'
  | 'shoulder'
  | 'opening'
  | 'orbit'

/**
 * Each shot's framings, in the order the Director moves through them. The
 * start is wide; a leader gets every framing; a battle the ones that hold two
 * craft or show the gap; the finish its trackside camera and the chase.
 */
export const TV_FRAMING_POOLS: Readonly<Record<TvShot, readonly TvFraming[]>> = {
  // DEV-652: the opening is in front of the line, then the wide shot behind the pack.
  start: ['opening', 'wide'],
  leader: ['chase', 'lead', 'trackside', 'shoulder', 'flyby', 'side', 'pair', 'aerial'],
  battle: ['pair', 'side', 'chase', 'lead'],
  finish: ['trackside', 'chase', 'lead'],
}

/** One craft on screen, this frame. */
export interface TvCraft {
  /** Stable across frames (a slot, a racer index). */
  readonly id: string
  /** What the lower third and `report()` call it. */
  readonly name: string
  /** THREE world. */
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  /** The drawn hull's, THREE world; noses along local −Z unless `forward` is given. */
  readonly quaternion: {
    readonly x: number
    readonly y: number
    readonly z: number
    readonly w: number
  }
  /** Its nose, THREE world, when the hull is not a mirrored one. */
  readonly forward?: { readonly x: number; readonly y: number; readonly z: number } | undefined
  /** 1 leads. Null or absent: derived from progress along the route. */
  readonly place?: number | null | undefined
  /** The N of "Racer N", what `follow(n)` and a `?follow=` link name. Absent: its 1-based list position. */
  readonly racer?: number | null | undefined
  /** DEV-653: its hull colour as CSS, for the marker over it; absent or null: the accent. */
  readonly colour?: string | null | undefined
}

/** What the devices said this frame. Every field optional; absent is "nothing". */
export interface TvCameraInput {
  /** Flat look, CSS pixels this frame (mouse with the right button held or pointer-locked; a phone's drag). */
  readonly lookDx?: number
  readonly lookDy?: number
  /** A pad's right stick, −1..1 (up is −1). */
  readonly padLookX?: number
  readonly padLookY?: number
  /** A pad's left stick, −1..1 (up is −1). */
  readonly padMoveX?: number
  readonly padMoveY?: number
  /** Q/E, or a pad's triggers: −1 down … 1 up. */
  readonly padRise?: number
  /** W/S/A/D/Q/E (and a phone's held Forward as `forward`). */
  readonly keys?: Partial<FlyKeys>
  /** The wheel's deltaY summed over the frame. */
  readonly wheel?: number
  /** Headset: the aiming hand's ray, THREE world, or null with no hand. */
  readonly aim?: { readonly origin: Vec3T; readonly direction: Vec3T } | null
  /** Headset: the trigger was pulled this frame (an edge). In Free it teleports. */
  readonly teleport?: boolean
  /** Headset: a stick flick this frame (an edge): +1 right, −1 left. In Free it snaps. */
  readonly snap?: -1 | 0 | 1
  /**
   * Headset, Free, without the cuts (DEV-481 follow-up): the sticks, -1..1.
   * `xrMoveX`/`xrMoveY` the left stick (up is -1): along the head's gaze and
   * its level right; `xrTurn` the right stick's x (right turns right);
   * `xrRise` the right stick's y, pushed up to rise (up is +1 here).
   */
  readonly xrMoveX?: number
  readonly xrMoveY?: number
  readonly xrTurn?: number
  readonly xrRise?: number
  /** Headset: the head's WORLD orientation (`render/head-pose.ts`), x, y, z, w. Free flies along it. */
  readonly gaze?: readonly [number, number, number, number] | null
}

export interface TvCameraOptions {
  /** The craft on screen, read every frame. */
  readonly craft: () => readonly TvCraft[]
  /** Is a headset presenting? Read every frame. */
  readonly presenting: () => boolean
  /** The higher of the rendered and collision surfaces, land or sea, THREE world; −∞ off the map. */
  readonly heightAt: HeightAt
  /** The course's play area; null for none. */
  readonly bounds: TvBounds | null
  /** The course: its route, rings, start and finish, THREE world. */
  readonly course: TvCourse
  /** A sphere touching a prop? Optional: without it props are not avoided. */
  readonly obstructed?: Obstructed
  /** The mode to open in. Director unless a link said otherwise. */
  readonly mode?: TvCameraMode
  /**
   * In a headset, the comfort CUTS (trackside vantages, teleport and snap turn)
   * instead of the flat camera's behaviour. Read every frame. Absent or false:
   * a headset gets exactly what a flat screen gets (Matt, 2026-10-01: "let's
   * keep it functionally identical to flat at launch"); `gameplay.tv.headsetCuts`.
   */
  readonly headsetCuts?: () => boolean
  /** DEV-652: the flat camera's vertical field, degrees, read every frame, for the subject-size floor. Absent: 60. */
  readonly fovDeg?: () => number
}

/** A rig and a camera, as three has them: the camera is the rig's child. */
export interface TvRig {
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
}
export interface TvEye {
  /** LOCAL to the rig (CLAUDE.md: a camera's position is local). */
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
}

export interface TvCameraReport {
  readonly mode: TvCameraMode
  readonly shot: TvShot | null
  /** The craft the camera is on (Director's subject, Follow's target), or null. */
  readonly following: string | null
  /** That craft's racer number (what `follow(n)` takes), or null. */
  readonly racer: number | null
  /** The second craft of a battle, or null. */
  readonly with: string | null
  readonly presenting: boolean
  /** The headset comfort cuts are on (`gameplay.tv.headsetCuts`). */
  readonly headsetCuts: boolean
  /** The vantage held in a headset (its index in `vantages()`), or −1. */
  readonly vantage: number
  /** Cuts made in a headset since creation: each is one rig placement. */
  readonly cuts: number
  /** Director cuts (subject or shot changes) since creation. */
  readonly directorCuts: number
  /** 0..1 black over everything: the headset cut's curtain. */
  readonly black: number
  readonly vantages: number
  readonly liftedVantages: number
  /** DEV-616: the flat chase's orbit, [yaw, pitch] radians and the zoom, or null on the chase itself. */
  readonly orbit: readonly [number, number, number] | null
  /** DEV-618: how the Director is filming (null outside the Director, or under a headset's comfort cuts). */
  readonly framing: TvFraming | null
  /** DEV-618: framing changes (and trackside cameras moved on to the next gate) since creation. */
  readonly framingCuts: number
  /**
   * DEV-652: what was wrong with the eye the Director proposed this frame
   * before it was moved (`gate`: in a gate frame's solid, `ground`: under or
   * behind the terrain), or null when it was clear as proposed.
   */
  readonly eyeProblem: 'gate' | 'ground' | null
  /** Frames since creation on which the proposed eye had to be moved. */
  readonly eyeAdjusted: number
  /** The followed racer's share of the frame's height from the Director's eye (0 outside the Director). */
  readonly subjectShare: number
  /** Overtakes seen among the racers still racing, and the framings cut on a gate pass. */
  readonly overtakes: number
  readonly gateCuts: number
  /**
   * DEV-654: the last overtake among the racers still racing: who moved up (the
   * craft's id and name), to which place, and `n`, the running count (`overtakes`)
   * it was, so a reader can tell a new one from the one it has shown.
   */
  readonly lastOvertake: {
    readonly id: string
    readonly name: string
    readonly to: number
    readonly n: number
  } | null
  /** DEV-654: gates behind the craft the camera is on (0 with none), so a reader sees it pass one. */
  readonly followedGates: number
  /**
   * DEV-871: the last racer to cross the line and the place it crossed in
   * (settled at the crossing); `n` is the running count of crossings.
   */
  readonly lastFinish: {
    readonly id: string
    readonly name: string
    readonly place: number
    readonly n: number
  } | null
  /** DEV-654: the winner's shot is on (the Director is orbiting the first racer home). */
  readonly winnerShot: boolean
}

export interface TvCamera {
  mode(): TvCameraMode
  setMode(mode: TvCameraMode): void
  /** Director → Follow → Free → Director (the Camera key: C, a pad's Y). */
  cycleMode(): TvCameraMode
  /** Follow the next craft (wrapping); from Director, the one after its subject. */
  next(): void
  previous(): void
  /** Follow Racer `n` (1-based): a `?follow=` link. Held until that racer is on screen. */
  follow(n: number): void
  /** Place the rig (and, flat, zero the camera's local pose) for this frame. */
  frame(dt: number, rig: TvRig, camera: TvEye, input?: TvCameraInput): void
  /** 0..1 black: the boot block lays this over the frame (the vignette's fade). */
  black(): number
  vantages(): readonly Vantage[]
  /** DEV-866: the course outline and every craft's dot, for the broadcast's mini-map. */
  mapView(): TvMapView
  report(): TvCameraReport
}

/**
 * The policy, by name. A camera operator's choices, not 2016 data. The flat
 * chase's three numbers are `watchCamera`'s (DEV-436), moved here.
 */
export const TV_CAMERA_POLICY = {
  /** Flat chase: metres behind and above, and how fast the heading settles (per second). */
  chaseBehind: 24,
  chaseAbove: 7,
  chaseSettlePerSecond: 3,
  /** Flat start shot: metres back from the pack's centre, and up. */
  wideBack: 90,
  wideUp: 35,
  /** No flat eye goes nearer the ground than this. */
  flatClearance: 3,
  /** The Director's least hold, seconds (plan §5.3: ~4 s). */
  directorMinHold: 4,
  /** DEV-886: a speed sample (m/s) above this is a teleport or a stale pose, not flight: the sim's fastest chain terminal is 182. */
  flySampleMax: 300,
  /** DEV-886: a flat eye keeps this far (metres) from any prop. */
  eyePropRadius: 2,
  /** DEV-886: seconds of flight a speed sample is read over. */
  flyWindow: 0.25,
  /** The start shot lasts while the front of the field is less than this far along the route (and the hold). */
  startUntilArc: 250,
  /** Two craft this close (metres) are a battle: a few hull lengths. */
  battleDistance: 40,
  /** A craft this close to the finish (metres along the route) is the finish shot. */
  finishApproach: 450,
  /** Headset: a cut is out, then in, seconds (0.3 s through black). */
  cutOut: 0.15,
  cutIn: 0.15,
  /** Headset: the least hold at a vantage before it may cut on, seconds. */
  headsetMinHold: 3,
  /** Headset: a new vantage is at least this far ahead of its subject (metres), or `leadSeconds` of its speed. */
  minLead: 80,
  leadSeconds: 2,
  /** Headset: cut on once the subject is this far past the vantage's anchor (metres). */
  passBeyond: 60,
  /** Headset: a subject this far from the held vantage is lost: re-pick (metres). */
  lostDistance: 900,
  /** Free in a headset without the cuts: the right stick's smooth turn, radians a second at full deflection. */
  headsetTurnPerSecond: Math.PI / 2,
  /** Free (flat): the least air under the eye, metres, over a small disk. */
  freeClearance: 2.5,
  freeDisk: 2,
  /** Free (flat): a pad stick's look, radians a second at full deflection. */
  padLookPerSecond: 2.2,
  /**
   * The pad's TRIGGER pair (Q/E rise) is gated by the ships' own trigger gate, the
   * sheet's `hoverjet.input.triggerDeadZone` (DEV-801), a hard cut like theirs. Sticks do not:
   * DEV-725 gives every stick the ships' 2016 response (`shapeAxis`, 0.2 / 0.9).
   */
  padTriggerDeadzone: HOVERJET.input.triggerDeadZone,
  /** A frame longer than this is clamped (a backgrounded tab), seconds. */
  maxDt: 0.1,
  /**
   * DEV-616, flat: a click-drag in Director or Follow ORBITS the chase about
   * the racer it is on, at the mouse-look's own rate per pixel
   * (`FLY_LOOK_POLICY.flyLookDegreesPerPixel`). Its elevation is the chase's
   * plus this much either way, radians.
   */
  orbitPitchDown: 0.3,
  orbitPitchUp: 1.2,
  /** The wheel zooms the orbit: a factor per 100 px of wheel, held within `orbitZoomMin..Max`. */
  orbitZoomPer100: 1.15,
  orbitZoomMin: 0.4,
  orbitZoomMax: 3,
  /** Seconds after the last drag or wheel before the orbit goes back to the director's framing. */
  orbitHoldSeconds: 2.5,
  /** Then back at this rate (an exponential, per second: 95 % in about 1 s). */
  orbitReturnPerSecond: 3,
  /**
   * DEV-618: the Director re-frames after this long on one framing, seconds
   * (king-tide's broadcast director holds 4.5 to 7.5 s; `directorMinHold` is
   * the floor).
   */
  framingMaxHold: 7,
  /** Side: metres out from the racer, back, up, and the nose room it looks ahead. */
  sideOut: 32,
  sideBack: 4,
  sideUp: 4,
  sideLead: 14,
  /**
   * Aerial: metres back, up and out, and how far ahead of the racer it looks.
   * DEV-652: 110 back and 75 up held the racer at 3 % of the frame (a few
   * pixels); 75 and 50 hold it at about 5 %, over `FRAMING.minSubject`.
   */
  aerialBack: 75,
  aerialUp: 50,
  aerialOut: 24,
  aerialLead: 45,
  /**
   * DEV-652. Lead (a camera ahead looking back): metres ahead, tried in this
   * order (the first clear of every gate and the ground), and its height over the racer.
   */
  leadAhead: [38, 30, 23, 17] as readonly number[],
  leadUp: 5,
  /** Shoulder (an onboard): metres behind, above and to the side of the hull, and how far ahead it looks. */
  shoulderBack: 9,
  shoulderUp: 3.2,
  shoulderOut: 3,
  shoulderLook: 45,
  /**
   * Opening: metres in front of the grid's centre along the line, to the side,
   * and up over the ground; tried in this order of distance. It holds until the
   * field has passed (`openingPassed` metres of progress beyond the eye).
   */
  openingAhead: [44, 34, 56, 26] as readonly number[],
  openingOut: 7,
  openingUp: 5,
  openingPassed: 12,
  /** The opening looks at the grid until the leader is this far (metres) from the field's centre. */
  openingSpread: 30,
  /** The opening ends by itself after this long, seconds (a field that never leaves). */
  openingMaxHold: 30,
  /**
   * DEV-654: the winner's shot. The first racer across the line is orbited for
   * this long, seconds, at this radius and height (metres) and this rate (radians
   * a second): a circle a little over a lap a quarter minute, slow enough to read.
   */
  winnerSeconds: 6,
  /** The orbit starts this long after the line, seconds: the finish camera has the crossing first. */
  winnerDelay: 1.5,
  orbitRadius: 38,
  orbitUp: 9,
  orbitRate: 0.8,
  /** DEV-652: a framing may cut on the subject passing a gate once held this long, seconds. */
  gateCutMinHold: 3,
  /** And on an overtake once held this long (the Director's own floor is `directorMinHold`). */
  overtakeMinHold: 1.5,
  /** The chase's arm shortens at once to stay out of a gate frame, and grows back at this rate (m/s). */
  chaseArmOut: 12,
  /** The chase's arms, longest first: the first whose eye is clear of every gate and the ground. */
  chaseArms: [24, 18, 13, 9, 6] as readonly number[],
  /** A fixed camera is only chosen for a racer that would fill this share of the frame's height from there. */
  fixedSubject: 0.02,
  /** A subject under this share of the frame's height for this long cuts the shot (seconds). */
  smallSubjectSeconds: 0.8,
  /** Pair: metres back and up from the two's midpoint, before the gap between them adds to both. */
  pairBack: 26,
  pairUp: 10,
  /** Two craft further apart than this are not one frame, metres. */
  pairDistance: 140,
  /** Flyby: the least lead ahead of the racer, metres out from the line, under it, and the least air over the ground. */
  flybyLead: 160,
  flybyOut: 16,
  flybyBelow: 3,
  flybyClearance: 3,
  /** A flyby eye lifted more than this above the line (by the ground or a prop) is not low: tried on the other side. */
  flybyHighest: 25,
  /**
   * Trackside: the vantage is at least `tracksideAhead` and at most
   * `tracksideReach` along the route ahead of the racer, and at most
   * `tracksideReach` from it, when the cut lands, metres.
   */
  tracksideAhead: 40,
  tracksideReach: 400,
} as const

const P = TV_CAMERA_POLICY
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const NO_KEYS: FlyKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  up: false,
  down: false,
}

/** DEV-866: one craft's dot on the broadcast's mini-map. THREE world x and z. */
export interface TvMapDot {
  readonly id: string
  readonly name: string
  readonly x: number
  readonly z: number
  readonly colour: string | null
  readonly followed: boolean
  readonly finished: boolean
}

/** DEV-866: what the mini-map draws: the course to the finish and the field, THREE world x and z. */
export interface TvMapView {
  readonly outline: readonly { readonly x: number; readonly z: number }[]
  readonly finish: { readonly x: number; readonly z: number } | null
  readonly dots: readonly TvMapDot[]
  /** The followed craft's name (as `report().following`), or null. */
  readonly following: string | null
  /** The followed craft's speed through the air, m/s (settled), or null. */
  readonly speed: number | null
}

interface Track {
  hint: number
  arc: number
  /** DEV-866: the craft's last position and its settled speed through the air, m/s. */
  last: [number, number, number] | null
  fly: number
  /** DEV-886: metres and seconds gathered toward the next speed sample (a window, never one frame). */
  flyDist: number
  flyTime: number
  speed: number
  finishedAt: number | null
}

/** Per-frame view of one craft. Rebuilt each frame into a reused array. */
interface Seen {
  craft: TvCraft
  index: number
  track: Track
  place: number
}

export const createTvCamera = (opts: TvCameraOptions): TvCamera => {
  const route: Route = buildRoute(opts.course.route)
  const vantages: Vantage[] = buildVantages(opts.course, {
    heightAt: opts.heightAt,
    obstructed: opts.obstructed,
    bounds: opts.bounds,
  })
  const fix: RouteFix = { arc: 0, segment: 0, distance: 0 }
  const finishArc = (() => {
    const f = opts.course.finish
    if (!f || route.points.length < 2) return route.length
    projectOnRoute(route, f[0], f[1], f[2], -1, fix)
    return fix.arc
  })()

  let mode: TvCameraMode = opts.mode ?? 'director'
  let time = 0
  const tracks = new Map<string, Track>()
  const seen: Seen[] = []
  // DEV-652: where the gate frames are (to stay out of), where each gate is
  // along the route (to cut on a pass), and who passed whom (to cut on an overtake).
  const gateFrames: readonly GateFrame[] = opts.course.gateFrames ?? []
  const framingWorld = { heightAt: opts.heightAt, gates: gateFrames }
  // DEV-866: the route up to the finish (every shipped route runs about a km past it), for the mini-map.
  const mapOutline: { x: number; z: number }[] = (() => {
    const out: { x: number; z: number }[] = []
    for (let i = 0; i < route.points.length; i++) {
      const p = route.points[i] as Vec3T
      if ((route.arcs[i] as number) >= finishArc) break
      out.push({ x: p[0], z: p[2] })
    }
    const end = routePointAt(route, finishArc)
    out.push({ x: end[0], z: end[2] })
    return out
  })()
  const gateArcs: number[] = (() => {
    const out: number[] = []
    const probe: RouteFix = { arc: 0, segment: 0, distance: 0 }
    let hint = -1
    for (const g of opts.course.gates) {
      projectOnRoute(route, g[0], g[1], g[2], hint, probe, 80, 200)
      hint = probe.segment
      out.push(probe.arc)
    }
    return out
  })()
  const standings = createStandingsTracker()
  /** The time of the last overtake the Director has not yet cut on, or null. */
  let overtakeAt: number | null = null
  let overtakes = 0
  /** DEV-654: the last overtake, for the lower third; and the winner of the race. */
  let lastOvertake: { id: string; name: string; to: number; n: number } | null = null
  /** DEV-871: who crossed the line in which place, said once each. */
  const finishes = createFinishTracker()
  let lastFinish: { id: string; name: string; place: number; n: number } | null = null
  let finishCount = 0
  let winnerId: string | null = null
  let winnerAt: number | null = null
  /**
   * DEV-654: gates behind each craft, as a HIGH-WATER mark. The route projection
   * wobbles a metre either side of a gate's arc, and a count that flips 20, 21,
   * 20 would flash the marker at every flip; a drop of more than a few is a
   * recorded racer looping back to the start, and that resets.
   */
  const gatesHigh = new Map<string, number>()
  /**
   * The winner's shot is on: the first racer crossed the line `winnerDelay` ago
   * (the finish camera has the crossing) and `winnerSeconds` have not passed.
   */
  const winnerLive = (): boolean =>
    winnerAt !== null &&
    time - winnerAt >= P.winnerDelay &&
    time - winnerAt < P.winnerDelay + P.winnerSeconds
  let smallFor = 0
  const fov = (): number => opts.fovDeg?.() ?? 60

  // Director
  let shot: TvShot | null = null
  let subjectId: string | null = null
  let withId: string | null = null
  let shotSince = Number.NEGATIVE_INFINITY
  let directorCuts = 0
  // Follow
  let targetId: string | null = null
  let targetIndex = 0
  let pendingRacer: number | null = null
  // Flat chase
  const fwd = new THREE.Vector3(0, 0, -1)
  let chaseSubject: string | null = null
  let chaseShot: TvShot | null = null
  // DEV-616: the flat chase's orbit (a click-drag), and how long since it was touched.
  let orbitYaw = 0
  let orbitPitch = 0
  let orbitZoom = 1
  let orbitIdle = Number.POSITIVE_INFINITY
  // DEV-628: the last pose THIS module wrote to the rig. The mission's own
  // camera code writes the rig before every `frame` (the hidden craft's
  // cockpit, standing on the launch pad), so the rig is never "where TV was
  // looking from" when a frame begins. Anything that continues from the
  // previous view (Free's seed, the headset's Free) reads this instead.
  const placedEye = new THREE.Vector3()
  const placedQuat = new THREE.Quaternion()
  let placed = false
  const remember = (rig: TvRig): void => {
    placedEye.copy(rig.position)
    placedQuat.copy(rig.quaternion)
    placed = true
  }
  // Free (flat)
  const freeEye = new THREE.Vector3()
  let freeAngles: FlyAngles = { yaw: 0, pitch: 0 }
  let freeScale = 1
  let freeSeeded = false
  // Headset
  let held: RigPose | null = null
  let heldVantage = -1
  let heldSince = Number.NEGATIVE_INFINITY
  let heldFor: string | null = null
  let pending: { pose: RigPose; vantage: number; phase: 'out' | 'in'; t: number } | null = null
  let blackAmount = 0
  let cuts = 0
  let wasPresenting = false
  /** This frame: a headset presenting WITHOUT the cuts, so the flat behaviour with a level rig. */
  let headsetParity = false

  // Volatile scratch (trap 19: valid inside one call).
  const _eye = new THREE.Vector3()
  const _aim = new THREE.Vector3()
  const _m = new THREE.Matrix4()
  const _q = new THREE.Quaternion()
  const _v = new THREE.Vector3()
  const _f = new THREE.Vector3()
  const _r = new THREE.Vector3()

  const ground = (x: number, z: number, r: number): number =>
    groundInDisk(opts.heightAt, x, z, r, 6)

  const noseOf = (c: TvCraft, out: THREE.Vector3): THREE.Vector3 => {
    if (c.forward) out.set(c.forward.x, c.forward.y, c.forward.z)
    else
      out
        .set(0, 0, -1)
        .applyQuaternion(_q.set(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w))
    return out
  }

  // ── the craft, this frame ───────────────────────────────────────────────

  const observe = (dt: number): void => {
    const list = opts.craft()
    seen.length = 0
    list.forEach((c, index) => {
      let t = tracks.get(c.id)
      const p = c.position
      if (!t) {
        projectOnRoute(route, p.x, p.y, p.z, -1, fix)
        t = {
          hint: fix.segment,
          arc: fix.arc,
          last: [p.x, p.y, p.z],
          fly: 0,
          flyDist: 0,
          flyTime: 0,
          speed: 0,
          finishedAt: null,
        }
        tracks.set(c.id, t)
      } else {
        // DEV-866: the speed through the air, settled, for the mini-map's readout.
        if (t.last && dt > 0) {
          const step = Math.hypot(p.x - t.last[0], p.y - t.last[1], p.z - t.last[2])
          if (step / dt >= P.flySampleMax) {
            // A teleport or a respawn is not a speed: the window it sits in is dropped.
            t.flyDist = 0
            t.flyTime = 0
          } else {
            // DEV-886: craft poses arrive in steps (a fixed step, a snapshot), so one
            // frame's distance over one frame's dt read 1220 km/h in a race's first
            // seconds. Speed is sampled over a window of P.flyWindow seconds.
            t.flyDist += step
            t.flyTime += dt
            if (t.flyTime >= P.flyWindow) {
              const v = t.flyDist / t.flyTime
              if (v < P.flySampleMax) t.fly += (v - t.fly) * Math.min(1, t.flyTime * 4)
              t.flyDist = 0
              t.flyTime = 0
            }
          }
        }
        t.last = [p.x, p.y, p.z]
        projectOnRoute(route, p.x, p.y, p.z, t.hint, fix)
        const rate = dt > 0 ? (fix.arc - t.arc) / dt : 0
        // A settled speed along the route, m/s: a fix that jumps legs does not spike it for long.
        t.speed += (Math.max(0, Math.min(400, rate)) - t.speed) * Math.min(1, dt * 2)
        t.hint = fix.segment
        t.arc = fix.arc
      }
      if (t.finishedAt === null && t.arc >= finishArc - 1 && finishArc > 0) t.finishedAt = time
      seen.push({ craft: c, index, track: t, place: 0 })
      const g = gatesBehind(t.arc)
      const hw = gatesHigh.get(c.id) ?? 0
      gatesHigh.set(c.id, g > hw || g < hw - 4 ? g : hw)
    })
    // Places: the source's, else finishers in the order they finished, then by progress.
    const order = [...seen].sort((a, b) => {
      const pa = a.craft.place
      const pb = b.craft.place
      if (pa != null && pb != null) return pa - pb
      const fa = a.track.finishedAt
      const fb = b.track.finishedAt
      if (fa !== null && fb !== null) return fa - fb
      if (fa !== null) return -1
      if (fb !== null) return 1
      return b.track.arc - a.track.arc
    })
    order.forEach((s, i) => {
      s.place = i + 1
    })
    // DEV-652: an overtake among the racers still racing is a cut's cause. A
    // finisher's place is settled, so only the order of those in the air counts.
    const airborne = order.filter((s) => s.track.finishedAt === null).map((s) => s.craft.id)
    const gains = standings.step(airborne, dt)
    // DEV-871: `airborne` counts places from 1 again once somebody is home, so an
    // overtake's place is lifted by the racers already across (all ahead of it).
    const home = order.length - airborne.length
    const crossed = seen
      .filter((s) => s.track.finishedAt !== null)
      .sort(
        (a, b) =>
          (a.track.finishedAt as number) - (b.track.finishedAt as number) || a.place - b.place,
      )
    for (const call of finishes.step(crossed.map((s) => s.craft.id))) {
      finishCount++
      lastFinish = {
        id: call.id,
        name: byId(call.id)?.craft.name ?? call.id,
        place: call.place,
        n: finishCount,
      }
    }
    if (gains.length > 0) {
      overtakes += gains.length
      overtakeAt = time
      // DEV-654: the gain that reached the highest place is the one worth a line.
      let best = gains[0] as (typeof gains)[number]
      for (const g of gains) if (g.to < best.to) best = g
      const who = byId(best.id)
      lastOvertake = {
        id: best.id,
        name: who ? who.craft.name : best.id,
        to: best.to + home,
        n: overtakes,
      }
    }
    // DEV-654: the winner is the first across the line, and stays so.
    let first: Seen | null = null
    for (const s of seen) {
      const f = s.track.finishedAt
      if (f !== null && (first === null || f < (first.track.finishedAt as number))) first = s
    }
    if (first === null) {
      winnerId = null
      winnerAt = null
    } else if (winnerId === null) {
      winnerId = first.craft.id
      winnerAt = first.track.finishedAt
    }
  }

  const byId = (id: string | null): Seen | null => {
    if (id === null) return null
    for (const s of seen) if (s.craft.id === id) return s
    return null
  }
  const byPlace = (): Seen[] => [...seen].sort((a, b) => a.place - b.place)

  // ── the Director ───────────────────────────────────────────────────────

  const directorWants = (): { shot: TvShot; subject: string; with: string | null } | null => {
    if (seen.length === 0) return null
    const ranked = byPlace()
    const racing = ranked.filter((s) => s.track.finishedAt === null)
    const leader = (racing[0] ?? ranked[0]) as Seen
    // The start: while the field is still near the line's beginning (on the
    // grid, or just away). A viewer who arrives mid-race never sees it.
    // DEV-654: the winner's shot outranks everything: the first racer home.
    if (winnerLive() && winnerId !== null && byId(winnerId) !== null) {
      return { shot: 'finish', subject: winnerId, with: null }
    }
    const front = Math.max(...seen.map((s) => s.track.arc))
    if (front < P.startUntilArc) return { shot: 'start', subject: leader.craft.id, with: null }
    if (racing.length === 0) {
      const last = ranked[ranked.length - 1] as Seen
      return { shot: 'finish', subject: last.craft.id, with: null }
    }
    let finishing: Seen | null = null
    for (const s of racing) {
      const left = finishArc - s.track.arc
      if (left > 0 && left <= P.finishApproach && (!finishing || s.track.arc > finishing.track.arc))
        finishing = s
    }
    if (finishing) return { shot: 'finish', subject: finishing.craft.id, with: null }
    for (let i = 0; i + 1 < racing.length; i++) {
      const a = (racing[i] as Seen).craft.position
      const b = (racing[i + 1] as Seen).craft.position
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= P.battleDistance) {
        // Chase the TRAILING craft: the one it is fighting is in front of the lens.
        return {
          shot: 'battle',
          subject: (racing[i + 1] as Seen).craft.id,
          with: (racing[i] as Seen).craft.id,
        }
      }
    }
    return { shot: 'leader', subject: leader.craft.id, with: null }
  }

  const direct = (): void => {
    const want = directorWants()
    if (!want) return
    const lost = byId(subjectId) === null
    // DEV-652: an overtake cuts at once (past a short floor), not after the full hold.
    const overtaken = overtakeAt !== null && time - shotSince >= P.overtakeMinHold
    // DEV-654: the winner's shot cuts at once, past every hold.
    const winnerCut = winnerLive() && subjectId !== winnerId
    if (!lost && !overtaken && !winnerCut && time - shotSince < P.directorMinHold) return
    if (!lost && want.shot === shot && want.subject === subjectId) {
      withId = want.with
      return
    }
    if (shot !== null) directorCuts++
    shot = want.shot
    subjectId = want.subject
    withId = want.with
    shotSince = time
  }

  // ── Follow ─────────────────────────────────────────────────────────────

  const followTarget = (): Seen | null => {
    if (seen.length === 0) return null
    if (pendingRacer !== null) {
      const n = pendingRacer
      const hit = seen.find((s) => s.craft.racer === n) ?? seen[n - 1] ?? null
      if (hit) {
        targetId = hit.craft.id
        targetIndex = hit.index
        pendingRacer = null
      }
    }
    const t = byId(targetId)
    if (t) {
      targetIndex = t.index
      return t
    }
    const s = seen[((targetIndex % seen.length) + seen.length) % seen.length] as Seen
    targetId = s.craft.id
    return s
  }

  const step = (by: 1 | -1): void => {
    observeIfEmpty()
    if (seen.length === 0) {
      targetIndex += by
      if (mode !== 'free') mode = 'follow'
      return
    }
    let from = targetIndex
    if (mode === 'director') {
      const s = byId(subjectId)
      from = s ? s.index : 0
    } else {
      const t = byId(targetId)
      if (t) from = t.index
    }
    const n = seen.length
    targetIndex = (((from + by) % n) + n) % n
    targetId = (seen[targetIndex] as Seen).craft.id
    pendingRacer = null
    mode = 'follow'
  }
  // `next()` can arrive before the first frame has looked at the craft.
  const observeIfEmpty = (): void => {
    if (seen.length === 0) observe(0)
  }

  /** The craft the camera is on this frame, and the Director's shot (null outside Director). */
  const subjectNow = (): { s: Seen | null; shot: TvShot | null } => {
    if (mode === 'director') {
      direct()
      return { s: byId(subjectId), shot }
    }
    if (mode === 'follow') return { s: followTarget(), shot: null }
    return { s: null, shot: null }
  }

  // ── flat ───────────────────────────────────────────────────────────────

  // ── DEV-652: no eye in a gate frame or the ground ──────────────────────
  //
  // Every flat eye goes through here last. A framing proposes where it would
  // stand; `ensureClear` keeps it out of every gate's solid and the ground (its
  // near plane would clip them) and keeps its subject from being hidden behind
  // a ridge, by moving the eye toward the subject, then up, then over it. The
  // result is what `report().eyeProblem` and the sweep test hold to null.
  const _clearFrom = new THREE.Vector3()
  const _eyeT: [number, number, number] = [0, 0, 0]
  const _aimT: [number, number, number] = [0, 0, 0]
  /** The rules in force this placement: the Director's, or (a viewer's own orbit) the near plane's alone. */
  let limitsNow: EyeLimits = DIRECTOR_LIMITS
  const problemAt = (e: THREE.Vector3, a: THREE.Vector3): 'gate' | 'ground' | null => {
    _eyeT[0] = e.x
    _eyeT[1] = e.y
    _eyeT[2] = e.z
    _aimT[0] = a.x
    _aimT[1] = a.y
    _aimT[2] = a.z
    const problem = eyeProblem(framingWorld, _eyeT, _aimT, limitsNow)
    if (problem !== null) return problem
    // DEV-886: a prop is rock to the near plane too. The terrain is not the only
    // solid at a finish (Mesa Canyon's spires): an eye inside one filled the
    // frame with brown. It is a 'ground' problem, so it is left by going up.
    return opts.obstructed?.(e.x, e.y, e.z, P.eyePropRadius) ? 'ground' : null
  }
  let lastProblem: 'gate' | 'ground' | null = null
  let eyeMoved = 0
  const ensureClear = (eye: THREE.Vector3, subject: THREE.Vector3): void => {
    lastProblem = problemAt(eye, subject)
    if (lastProblem === null) return
    eyeMoved++
    _clearFrom.copy(eye)
    const up = (): boolean => {
      for (let k = 1; k <= 14; k++) {
        eye.copy(_clearFrom)
        eye.y += 3 * k
        if (problemAt(eye, subject) === null) return true
      }
      return false
    }
    const inward = (): boolean => {
      // Toward the subject, never nearer than the nearest.
      for (let k = 1; k <= 6; k++) {
        eye.lerpVectors(_clearFrom, subject, k / 7)
        if (eye.distanceTo(subject) < FRAMING.nearest) return false
        if (problemAt(eye, subject) === null) return true
      }
      return false
    }
    // A gate is left by moving in (into its opening, where the subject is); the
    // ground by going up.
    if (lastProblem === 'ground' ? up() || inward() : inward() || up()) return
    // High and back from the subject, on the side the eye was: the placement
    // that cannot be wrong (DEV-041), kept off the vertical so the view has a
    // heading (a camera looking straight down has none, and a headset's level
    // rig would swing on it).
    _arm.copy(_clearFrom).sub(subject)
    _arm.y = 0
    if (_arm.lengthSq() < 1e-6) _arm.set(0, 0, 1)
    _arm.normalize()
    // Farther and higher until one is clear (a finish gate's tube is 100 m deep).
    for (const [back, high] of [
      [30, 60],
      [60, 90],
      [100, 130],
      [150, 190],
    ] as const) {
      eye.copy(subject).addScaledVector(_arm, back)
      eye.y += high
      if (problemAt(eye, subject) === null) return
    }
  }

  const placeFlat = (
    rig: TvRig,
    camera: TvEye,
    eye: THREE.Vector3,
    aim: THREE.Vector3,
    /** What the shot is OF, when that is not where it looks (the shoulder looks ahead of its racer). */
    subject: THREE.Vector3 = aim,
  ): void => {
    const g = ground(eye.x, eye.z, 4)
    if (Number.isFinite(g) && eye.y < g + P.flatClearance) eye.y = g + P.flatClearance
    limitsNow = orbiting() ? USER_LIMITS : DIRECTOR_LIMITS
    ensureClear(eye, subject)
    limitsNow = DIRECTOR_LIMITS
    // An eye that had to move looks AT its subject: the framing's own aim point
    // (nose room ahead of it, say) belonged to the eye it proposed.
    if (lastProblem !== null && aim !== subject) aim.copy(subject)
    rig.position.copy(eye)
    if (headsetParity) {
      // The same eye as flat, but the rig stays LEVEL (a pitched rig tilts the
      // wearer's world, DEV-264) and the head's pose is the runtime's.
      rig.quaternion.setFromAxisAngle(WORLD_UP, Math.atan2(-(aim.x - eye.x), -(aim.z - eye.z)))
      remember(rig)
      return
    }
    _m.lookAt(eye, aim, WORLD_UP)
    rig.quaternion.setFromRotationMatrix(_m)
    camera.position.set(0, 0, 0)
    camera.quaternion.identity()
    remember(rig)
  }

  // ── the headset's Free without the cuts: continuous flight, smooth turning ──
  // The HEAD is what flies: it moves along its own gaze (the left stick) and
  // the rig turns about it (the right stick), so the wearer turns on the spot.
  // Bounded as the flat eye is (above the ground, out of props, in bounds).
  let parityYaw = 0
  let paritySeeded = false
  const _gq = new THREE.Quaternion()
  const freeHeadset = (dt: number, rig: TvRig, camera: TvEye, input: TvCameraInput): void => {
    const head = headOf(camera)
    // DEV-628: from the pose TV last wrote, never the rig as this frame found
    // it (the mission's camera put the hidden craft's cockpit there).
    const from = placed ? placedEye : rig.position
    if (!paritySeeded) {
      _v.set(0, 0, -1).applyQuaternion(placed ? placedQuat : rig.quaternion)
      parityYaw = Math.atan2(-_v.x, -_v.z)
      paritySeeded = true
    }
    const at = headWorld({ position: [from.x, from.y, from.z], yaw: parityYaw }, head)
    const turn = dead(input.xrTurn)
    parityYaw -= turn * P.headsetTurnPerSecond * dt
    const g0 = ground(at[0], at[2], P.freeDisk)
    const speed = flySpeed(Number.isFinite(g0) ? at[1] - g0 : 100, freeScale)
    const g = input.gaze
    if (g) _gq.set(g[0], g[1], g[2], g[3])
    else _gq.setFromAxisAngle(WORLD_UP, parityYaw)
    _f.set(0, 0, -1).applyQuaternion(_gq)
    _r.set(1, 0, 0).applyQuaternion(_gq)
    _r.y = 0
    if (_r.lengthSq() > 1e-9) _r.normalize()
    const mx = dead(input.xrMoveX)
    const my = dead(input.xrMoveY)
    const rise = dead(input.xrRise)
    _eye.set(at[0], at[1], at[2])
    _eye.addScaledVector(_f, -my * speed * dt).addScaledVector(_r, mx * speed * dt)
    _eye.y += rise * speed * dt
    clampFree(_eye, _eye)
    if (opts.obstructed?.(_eye.x, _eye.y, _eye.z, 1)) _eye.set(at[0], at[1], at[2])
    const pose = rigForEye([_eye.x, _eye.y, _eye.z], parityYaw, head)
    rig.position.set(pose.position[0], pose.position[1], pose.position[2])
    rig.quaternion.setFromAxisAngle(WORLD_UP, parityYaw)
    remember(rig)
  }

  const orbiting = (): boolean => orbitYaw !== 0 || orbitPitch !== 0 || orbitZoom !== 1

  /**
   * DEV-616: a drag (`lookDx`, `lookDy`, CSS px) swings the orbit, the wheel
   * zooms it; untouched for `orbitHoldSeconds`, it eases back to the
   * director's framing and lands on it exactly. DEV-628: a pad's right stick
   * swings it too (it used to throw the view into Free), at the rate it looks
   * in Free, read as the pixels a drag would have moved.
   */
  const stepOrbit = (dt: number, input: TvCameraInput): void => {
    const perPx =
      THREE.MathUtils.radToDeg(P.padLookPerSecond * dt) / FLY_LOOK_POLICY.flyLookDegreesPerPixel
    const dx = (input.lookDx ?? 0) + dead(input.padLookX) * perPx
    const dy = (input.lookDy ?? 0) + dead(input.padLookY) * perPx
    const wheel = input.wheel ?? 0
    if (dx !== 0 || dy !== 0 || wheel !== 0) {
      const k = THREE.MathUtils.degToRad(FLY_LOOK_POLICY.flyLookDegreesPerPixel)
      orbitYaw -= dx * k
      orbitPitch = THREE.MathUtils.clamp(orbitPitch + dy * k, -P.orbitPitchDown, P.orbitPitchUp)
      orbitZoom = THREE.MathUtils.clamp(
        orbitZoom * P.orbitZoomPer100 ** (wheel / 100),
        P.orbitZoomMin,
        P.orbitZoomMax,
      )
      orbitIdle = 0
      return
    }
    orbitIdle += dt
    if (orbitIdle < P.orbitHoldSeconds || !orbiting()) return
    const keep = Math.exp(-dt * P.orbitReturnPerSecond)
    // The shortest way round, so a full turn and a half comes back the short way.
    orbitYaw = Math.atan2(Math.sin(orbitYaw), Math.cos(orbitYaw)) * keep
    orbitPitch *= keep
    orbitZoom = 1 + (orbitZoom - 1) * keep
    if (
      Math.abs(orbitYaw) < 1e-4 &&
      Math.abs(orbitPitch) < 1e-4 &&
      Math.abs(orbitZoom - 1) < 1e-4
    ) {
      orbitYaw = 0
      orbitPitch = 0
      orbitZoom = 1
    }
  }

  // DEV-652: the chase's arm (metres behind the racer), and how high the eye
  // stands over it for an arm: shorter arms stand a little lower.
  let chaseArm = 0
  const _arm = new THREE.Vector3()
  const _subj = new THREE.Vector3()
  const armHeight = (arm: number): number => P.chaseAbove * (0.5 + (0.5 * arm) / P.chaseBehind)
  /** The longest arm whose eye is clear of every gate frame and the ground, from the aim `_v`. */
  const clearArm = (p: { readonly x: number; readonly y: number; readonly z: number }): number => {
    for (const arm of P.chaseArms) {
      _arm.set(p.x, p.y, p.z).addScaledVector(fwd, -arm)
      _arm.y += armHeight(arm)
      if (problemAt(_arm, _v) === null) return arm
    }
    return P.chaseArms[P.chaseArms.length - 1] as number
  }

  const flatChase = (dt: number, rig: TvRig, camera: TvEye, s: Seen, sh: TvShot | null): void => {
    const c = s.craft
    const cut = chaseSubject !== c.id || (sh === 'start') !== (chaseShot === 'start')
    if (sh === 'start') {
      // Wide on the pack: back along the route from its centre, and up.
      _v.set(0, 0, 0)
      for (const o of seen) {
        _v.x += o.craft.position.x
        _v.y += o.craft.position.y
        _v.z += o.craft.position.z
      }
      _v.multiplyScalar(1 / seen.length)
      const [hx, hz] = routeHeadingAt(route, Math.max(0, s.track.arc))
      _aim.set(hx, 0, hz)
      if (cut) fwd.copy(_aim)
      else fwd.lerp(_aim, 1 - Math.exp(-dt * P.chaseSettlePerSecond)).normalize()
      _eye.copy(_v).addScaledVector(fwd, -P.wideBack)
      _eye.y += P.wideUp
      placeFlat(rig, camera, _eye, _aim.copy(_v))
    } else {
      // `watchCamera`'s chase (DEV-436): the HEADING settles, not the position:
      // a camera that chased the ship would trail it by speed / settle.
      noseOf(c, _aim)
      _aim.y = 0
      if (_aim.lengthSq() < 1e-6) _aim.set(0, 0, -1)
      _aim.normalize()
      if (cut) fwd.copy(_aim)
      else fwd.lerp(_aim, 1 - Math.exp(-dt * P.chaseSettlePerSecond)).normalize()
      const p = c.position
      if (orbiting()) {
        // DEV-616: the same eye, swung about the racer: the chase's offset
        // (behind and above) turned `orbitYaw` about the vertical, raised
        // `orbitPitch`, and scaled by the wheel's zoom. Off the orbit the
        // branch below is the chase, bit for bit.
        const reach = Math.hypot(P.chaseBehind, P.chaseAbove) * orbitZoom
        const el = Math.atan2(P.chaseAbove, P.chaseBehind) + orbitPitch
        _r.copy(fwd).negate().applyAxisAngle(WORLD_UP, orbitYaw)
        _eye
          .set(p.x, p.y, p.z)
          .addScaledVector(_r, reach * Math.cos(el))
          .addScaledVector(WORLD_UP, reach * Math.sin(el))
        _v.set(p.x, p.y, p.z).addScaledVector(fwd, 10)
      } else {
        _v.set(p.x, p.y, p.z).addScaledVector(fwd, 10)
        // DEV-652: the arm shortens at once to stay out of a gate frame (the
        // racer that has just flown through one has the frame 24 m behind it,
        // which is where the old chase parked) and grows back as it clears.
        const safe = clearArm(p)
        if (cut || chaseArm === 0) chaseArm = safe
        else if (safe < chaseArm) chaseArm = safe
        else chaseArm = Math.min(safe, chaseArm + P.chaseArmOut * dt)
        _eye.set(p.x, p.y, p.z).addScaledVector(fwd, -chaseArm)
        _eye.y += armHeight(chaseArm)
      }
      placeFlat(rig, camera, _eye, _v, _subj.set(p.x, p.y, p.z))
    }
    chaseSubject = c.id
    chaseShot = sh
  }

  // ── DEV-618: the Director's framings ───────────────────────────────────
  //
  // Matt: "look at the polyfish and king-tide repos for inspiration on how to
  // frame interesting shots ... (more than just chase-cam)". The Director's
  // SHOT (start, leader, battle, finish) says WHO; a FRAMING says how it is
  // filmed. Each shot has a pool (`TV_FRAMING_POOLS`); the Director moves
  // through it in order, never the framing it just used nor the one before
  // (polyfish's anti-A-B-A-B), holding each `directorMinHold` at least and
  // re-framing after `framingMaxHold`, or as soon as a fixed camera's racer
  // has gone past it (a cut on the gate). Every framing reads the DRAWN craft
  // (DEV-612), never a body. Every eye is held over the ground by `placeFlat`
  // and lifted out of any prop.
  let framing: TvFraming = 'chase'
  let framingSince = Number.NEGATIVE_INFINITY
  let framingFor: string | null = null
  let framingShot: TvShot | null = null
  let framingCuts = 0
  const recentFramings: TvFraming[] = []
  /** A fixed camera's eye (trackside, flyby), and what ends it. */
  const fixedEye = new THREE.Vector3()
  let fixedPassAt = 0
  /**
   * The side of the racing line the side, aerial and flyby shots stand on
   * (its right): one side for the whole race, so a cut never crosses the line.
   */
  const lineSide = 1
  const _p2 = new THREE.Vector3()
  const _side = new THREE.Vector3()

  /** The settled heading for `c` (level), snapped on a cut. Writes `fwd`. */
  const settleHeading = (dt: number, c: TvCraft, snap: boolean): void => {
    noseOf(c, _aim)
    _aim.y = 0
    if (_aim.lengthSq() < 1e-6) _aim.set(0, 0, -1)
    _aim.normalize()
    if (snap) fwd.copy(_aim)
    else fwd.lerp(_aim, 1 - Math.exp(-dt * P.chaseSettlePerSecond)).normalize()
  }

  /** The craft a two-shot pairs `s` with: the battle's other, else the next by place, if near. */
  const partnerOf = (s: Seen, sh: TvShot | null): Seen | null => {
    if (sh === 'battle') return byId(withId)
    const ranked = byPlace()
    const i = ranked.indexOf(s)
    const other = ranked[i + 1] ?? ranked[i - 1] ?? null
    if (!other) return null
    const a = s.craft.position
    const b = other.craft.position
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= P.pairDistance ? other : null
  }

  /** A low point beside the course ahead of `s`, or false: where a flyby waits. */
  const flybyPoint = (s: Seen): boolean => {
    const lead = Math.max(P.flybyLead, s.track.speed * P.leadSeconds)
    const at = s.track.arc + lead
    if (at >= route.length) return false
    const [px, py, pz] = routePointAt(route, at)
    const [hx, hz] = routeHeadingAt(route, at)
    // Beside the line on the side shots keep, then the other.
    for (const sign of [lineSide, -lineSide]) {
      fixedEye.set(px - hz * sign * P.flybyOut, py - P.flybyBelow, pz + hx * sign * P.flybyOut)
      const g = ground(fixedEye.x, fixedEye.z, 6)
      if (!Number.isFinite(g)) continue
      if (fixedEye.y < g + P.flybyClearance) fixedEye.y = g + P.flybyClearance
      liftClear(fixedEye)
      // Lifted far above the line (a hillside beside it, a tall prop) it is no longer low: the other side.
      if (fixedEye.y - py > P.flybyHighest) continue
      fixedPassAt = at + P.passBeyond
      return true
    }
    return false
  }

  // ── DEV-652: the three framings that stand near the racer ───────────────
  //
  // Each reads the racer's DRAWN pose and the settled heading, proposes an eye,
  // and lets `placeFlat`'s `ensureClear` keep it out of the gates and the ground.
  const _lp = new THREE.Vector3()
  const _la = new THREE.Vector3()
  const _pc = new THREE.Vector3()

  /** The racer's level nose, unit, into `out` (the nose in the XZ plane; −Z where it has none). */
  const levelNose = (c: TvCraft, out: THREE.Vector3): THREE.Vector3 => {
    noseOf(c, out)
    out.y = 0
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1)
    return out.normalize()
  }

  /** A clear eye AHEAD of the racer, looking back at it: the first distance that clears every gate and the ground. */
  const leadPoint = (s: Seen, out: THREE.Vector3): boolean => {
    const p = s.craft.position
    levelNose(s.craft, _f)
    _la.set(p.x, p.y, p.z)
    for (const ahead of P.leadAhead) {
      out.set(p.x, p.y + P.leadUp, p.z).addScaledVector(_f, ahead)
      if (problemAt(out, _la) === null) return true
    }
    return false
  }

  /** The centre of every craft on screen, into `out`. */
  const packCentre = (out: THREE.Vector3): THREE.Vector3 => {
    out.set(0, 0, 0)
    for (const o of seen) {
      out.x += o.craft.position.x
      out.y += o.craft.position.y
      out.z += o.craft.position.z
    }
    return seen.length > 0 ? out.multiplyScalar(1 / seen.length) : out
  }

  /**
   * The opening shot's eye: in FRONT of the grid along the line, a little to the
   * side and low, looking back at it (Matt: "in front of the starting line,
   * like a race"). The first distance that clears is held; `fixedPassAt` is the
   * progress at which the field has gone by it.
   */
  const openingPoint = (s: Seen): boolean => {
    packCentre(_pc)
    let front = 0
    for (const o of seen) front = Math.max(front, o.track.arc)
    const [hx, hz] = routeHeadingAt(route, Math.max(0, front))
    for (const ahead of P.openingAhead) {
      _lp.set(
        _pc.x + hx * ahead - hz * P.openingOut,
        _pc.y + P.openingUp,
        _pc.z + hz * ahead + hx * P.openingOut,
      )
      const g = ground(_lp.x, _lp.z, 4)
      if (Number.isFinite(g) && _lp.y < g + FRAMING.groundClearance + 1)
        _lp.y = g + FRAMING.groundClearance + 1
      if (problemAt(_lp, _pc) !== null) continue
      fixedEye.copy(_lp)
      fixedPassAt = front + ahead + P.openingPassed
      void s
      return true
    }
    return false
  }

  /** Can `f` film `s` now? Sets up a fixed camera's eye as a side effect. */
  const feasible = (f: TvFraming, s: Seen, sh: TvShot | null): boolean => {
    if (f === 'pair') return partnerOf(s, sh) !== null
    if (f === 'lead') return leadPoint(s, _lp)
    if (f === 'opening') return sh === 'start' && !openingUsed && openingPoint(s)
    if (f === 'trackside') {
      // The finish shot keeps its finish camera (the headset's own pick).
      const finish = sh === 'finish' ? vantages[pickVantage(s, sh)] : undefined
      const p = s.craft.position
      // DEV-652: and the racer must fill the floor's share of the frame by the
      // time it is anywhere near, so the camera is not chosen while it is a dot.
      const reach = Math.min(P.tracksideReach, farthestFor(fov(), P.fixedSubject))
      // Otherwise the first standing (not lifted) vantage the racer is coming
      // to: ahead of it by `tracksideAhead` (a camera it has passed shows its
      // tail), and near enough that it reads as a racer when the cut lands.
      for (const v of finish ? [finish] : vantages) {
        if (v.lifted || v.arc < s.track.arc + P.tracksideAhead) continue
        if (v.arc > s.track.arc + reach) continue
        if (Math.hypot(v.eye[0] - p.x, v.eye[1] - p.y, v.eye[2] - p.z) > reach) continue
        fixedEye.set(v.eye[0], v.eye[1], v.eye[2])
        fixedPassAt = v.arc + P.passBeyond
        return true
      }
      return false
    }
    if (f === 'flyby') return flybyPoint(s)
    return true
  }

  /** The next framing for `s` in shot `sh`: the pool in order, past the recent ones; `prefer` first if it can. */
  const chooseFraming = (s: Seen, sh: TvShot | null, prefer?: TvFraming): TvFraming => {
    const pool = TV_FRAMING_POOLS[sh ?? 'leader']
    if (prefer && pool.includes(prefer) && prefer !== recentFramings[recentFramings.length - 1]) {
      if (feasible(prefer, s, sh)) return prefer
    }
    const last = recentFramings[recentFramings.length - 1]
    const start = last === undefined ? 0 : pool.indexOf(last) + 1
    for (let k = 0; k < pool.length; k++) {
      const f = pool[(start + k) % pool.length] as TvFraming
      if (pool.length > 2 && recentFramings.slice(-2).includes(f)) continue
      if (pool.length === 2 && f === last) continue
      if (feasible(f, s, sh)) return f
    }
    return sh === 'start' ? 'wide' : 'chase'
  }

  /** How many gates lie at or behind route arc `arc`. */
  const gatesBehind = (arc: number): number => {
    let n = 0
    for (const a of gateArcs) if (a <= arc) n++
    return n
  }
  let framingGates = 0
  /** The opening is once per course: a field that has gone by does not get another. */
  let openingUsed = false
  let gateCuts = 0

  /**
   * Step the framing: a new subject or shot, a hold run out, a fixed camera
   * passed, and (DEV-652) the subject flying through a gate, an overtake, or the
   * subject too small to read. The opening is the exception: it stands until the
   * field has gone by it.
   */
  const stepFraming = (s: Seen, sh: TvShot | null): boolean => {
    // DEV-654: the winner is orbited from the moment it is across the line.
    const orbitWanted = winnerLive() && s.craft.id === winnerId
    if (orbitWanted && framing !== 'orbit') {
      if (framingFor !== null) framingCuts++
      framing = 'orbit'
      recentFramings.push('orbit')
      if (recentFramings.length > 4) recentFramings.shift()
      framingFor = s.craft.id
      framingShot = sh
      framingSince = time
      framingGates = gatesBehind(s.track.arc)
      return true
    }
    if (orbitWanted) return false
    const opening = framing === 'opening'
    // The opening looks at the GRID: who leads it is not a new shot.
    if (opening && sh === 'start' && framingShot === 'start' && framingFor !== null) {
      framingFor = s.craft.id
    }
    const changed = framingFor !== s.craft.id || framingShot !== sh
    const held = time - framingSince
    const fixed = framing === 'trackside' || framing === 'flyby' || opening
    const passed = fixed && s.track.arc > fixedPassAt
    const gatePass = !opening && gatesBehind(s.track.arc) > framingGates && held >= P.gateCutMinHold
    const overtaken = !opening && overtakeAt !== null && held >= P.overtakeMinHold
    const small = !opening && smallFor >= P.smallSubjectSeconds && held >= P.overtakeMinHold
    const due =
      changed ||
      framing === 'orbit' ||
      (opening
        ? passed || held >= P.openingMaxHold
        : (held >= P.directorMinHold && (held >= P.framingMaxHold || passed)) ||
          gatePass ||
          overtaken ||
          small ||
          (fixed && held >= P.framingMaxHold * 2))
    if (!due) return false
    if (!changed && gatePass) gateCuts++
    // A trackside camera passed early in its hold moves to the next gate's.
    if (!changed && passed && framing === 'trackside' && held < P.framingMaxHold) {
      if (feasible('trackside', s, sh)) {
        framingSince = time
        framingGates = gatesBehind(s.track.arc)
        framingCuts++
        return true
      }
    }
    const next = chooseFraming(s, sh, overtaken ? 'pair' : undefined)
    overtakeAt = null
    smallFor = 0
    if (framingFor !== null) framingCuts++
    framing = next
    if (next === 'opening') openingUsed = true
    recentFramings.push(next)
    if (recentFramings.length > 4) recentFramings.shift()
    framingFor = s.craft.id
    framingShot = sh
    framingSince = time
    framingGates = gatesBehind(s.track.arc)
    return true
  }

  /** Lift an eye out of any prop, a few metres at a time (never down, never sideways). */
  const liftClear = (eye: THREE.Vector3): void => {
    for (let i = 0; i < 8 && opts.obstructed?.(eye.x, eye.y, eye.z, 2); i++) eye.y += 4
  }

  /** DEV-652: an eye nearer than the floor allows is moved in along its line to the subject. */
  const capDistance = (eye: THREE.Vector3, subject: { x: number; y: number; z: number }): void => {
    _p2.set(subject.x, subject.y, subject.z)
    const d = eye.distanceTo(_p2)
    const max = farthestFor(fov())
    if (d > max) eye.lerpVectors(_p2, eye, max / d)
  }

  let leadArm = 0
  /** The subject's share of the frame's height this frame, for `report()`. */
  let subjectShare = 0

  /** The Director, flat (and a headset at launch): the framing machine over the shot. */
  const flatDirector = (
    dt: number,
    rig: TvRig,
    camera: TvEye,
    s: Seen,
    sh: TvShot | null,
  ): void => {
    const cut = stepFraming(s, sh)
    if (framing === 'chase' || framing === 'wide') {
      if (cut) chaseSubject = null
      flatChase(dt, rig, camera, s, framing === 'wide' ? 'start' : sh === 'start' ? 'leader' : sh)
      return
    }
    const c = s.craft
    const p = c.position
    settleHeading(dt, c, cut || chaseSubject !== c.id)
    chaseSubject = c.id
    chaseShot = sh
    // Right of the heading, level: three's -Z forward has +X on its right.
    _side.set(-fwd.z, 0, fwd.x)
    if (framing === 'side') {
      // A tracking shot from beside the line (king-tide's `side`, polyfish's
      // SIDE_TRACK): level with the racer, nose room ahead of it.
      _eye
        .set(p.x, p.y, p.z)
        .addScaledVector(_side, P.sideOut * lineSide)
        .addScaledVector(fwd, -P.sideBack)
      _eye.y += P.sideUp
      _v.set(p.x, p.y, p.z).addScaledVector(fwd, P.sideLead)
    } else if (framing === 'aerial') {
      // High and wide over the island (king-tide's crane, polyfish's ESTABLISHING).
      _eye
        .set(p.x, p.y, p.z)
        .addScaledVector(fwd, -P.aerialBack)
        .addScaledVector(_side, P.aerialOut * lineSide)
      _eye.y += P.aerialUp
      _v.set(p.x, p.y, p.z).addScaledVector(fwd, P.aerialLead)
    } else if (framing === 'pair') {
      // The racer and its rival (or the next in the pack) in one frame, from behind and above.
      const o = partnerOf(s, sh)
      const q = o ? o.craft.position : p
      _p2.set((p.x + q.x) / 2, (p.y + q.y) / 2, (p.z + q.z) / 2)
      const sep = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
      _eye.copy(_p2).addScaledVector(fwd, -(P.pairBack + sep * 0.6))
      _eye.y += P.pairUp + sep * 0.3
      _v.copy(_p2)
    } else if (framing === 'lead') {
      // A camera AHEAD of the racer, looking back at it, kept at its speed (it
      // moves as the racer does). The arm shortens at once when a gate or the
      // ground is in the way and grows back as it clears.
      _la.set(p.x, p.y, p.z)
      let safe = P.leadAhead[P.leadAhead.length - 1] as number
      for (const ahead of P.leadAhead) {
        _lp.set(p.x, p.y + P.leadUp, p.z).addScaledVector(fwd, ahead)
        if (problemAt(_lp, _la) === null) {
          safe = ahead
          break
        }
      }
      if (cut || leadArm === 0 || safe < leadArm) leadArm = safe
      else leadArm = Math.min(safe, leadArm + P.chaseArmOut * dt)
      _eye.set(p.x, p.y + P.leadUp, p.z).addScaledVector(fwd, leadArm)
      _v.set(p.x, p.y + 1, p.z)
    } else if (framing === 'shoulder') {
      // An onboard: just behind, above and to one side of the hull, looking where it goes.
      _eye
        .set(p.x, p.y + P.shoulderUp, p.z)
        .addScaledVector(fwd, -P.shoulderBack)
        .addScaledVector(_side, P.shoulderOut * lineSide)
      _v.set(p.x, p.y, p.z).addScaledVector(fwd, P.shoulderLook)
    } else if (framing === 'orbit') {
      // DEV-654: the winner's shot. A circle round the racer that crossed first,
      // from the moment it crossed; the eye never nearer the ground than a fixed
      // camera is allowed to stand.
      const a = (time - (winnerAt ?? time) - P.winnerDelay) * P.orbitRate
      _eye.set(
        p.x + Math.cos(a) * P.orbitRadius,
        p.y + P.orbitUp,
        p.z + Math.sin(a) * P.orbitRadius,
      )
      const g = ground(_eye.x, _eye.z, 4)
      if (Number.isFinite(g) && _eye.y < g + FRAMING.groundClearance + 1) {
        _eye.y = g + FRAMING.groundClearance + 1
      }
      _v.set(p.x, p.y, p.z)
    } else if (framing === 'opening') {
      // In front of the line, looking back at the grid: it stands, and pans.
      _eye.copy(fixedEye)
      packCentre(_v)
      // Once the field has strung out (the leader leaves the grid's own
      // spread) the shot follows the leader past the camera instead.
      if (Math.hypot(p.x - _v.x, p.y - _v.y, p.z - _v.z) > P.openingSpread) _v.set(p.x, p.y, p.z)
    } else {
      // A fixed camera (a trackside vantage, a low flyby): it stands, and pans.
      _eye.copy(fixedEye)
      _v.set(p.x, p.y, p.z)
    }
    if (framing === 'side' || framing === 'aerial' || framing === 'pair' || framing === 'orbit') {
      capDistance(_eye, p)
    }
    liftClear(_eye)
    placeFlat(rig, camera, _eye, _v, _subj.set(p.x, p.y, p.z))
    // The racer's share of the frame, and how long it has been too small to read.
    subjectShare = subjectFraction(Math.hypot(_eye.x - p.x, _eye.y - p.y, _eye.z - p.z), fov())
    smallFor = framing !== 'opening' && subjectShare < FRAMING.minSubject * 0.6 ? smallFor + dt : 0
  }

  /**
   * Director or Follow, flat (and a headset at launch). The Director films
   * through its framings; Follow, and a Director the viewer is orbiting
   * (DEV-616), is the chase.
   */
  let framingNow: TvFraming | null = null
  const flatShot = (dt: number, rig: TvRig, camera: TvEye, s: Seen, sh: TvShot | null): void => {
    if (mode === 'director' && !orbiting()) {
      flatDirector(dt, rig, camera, s, sh)
      framingNow = framing
      return
    }
    // The next Director frame re-frames from here rather than resuming a stale fixed camera.
    framingFor = null
    framingNow = mode === 'director' ? 'chase' : null
    flatChase(dt, rig, camera, s, sh)
  }

  /**
   * DEV-628: Free starts where the viewer was watching from: the pose TV last
   * placed, not the rig, which the mission's camera has just set to the hidden
   * craft's cockpit on the launch pad (Matt: "takes me to a first person cam
   * at launch position"). The rig is the seed only before TV has placed it.
   */
  const seedFree = (rig: TvRig): void => {
    freeEye.copy(placed ? placedEye : rig.position)
    freeAngles = anglesOf(viewOf(placed ? placedQuat : rig.quaternion, _v))
    freeSeeded = true
    clampFree(freeEye, freeEye)
  }

  /** Bound a free eye: inside the course, above the ground. Writes `out`. */
  const clampFree = (p: THREE.Vector3, out: THREE.Vector3): void => {
    out.copy(p)
    const b = opts.bounds
    if (b) {
      _r.set(out.x - b.centre[0], out.y - b.centre[1], out.z - b.centre[2])
      const r = _r.length()
      if (r > b.radius) {
        _r.multiplyScalar(b.radius / r)
        out.set(b.centre[0] + _r.x, b.centre[1] + _r.y, b.centre[2] + _r.z)
      }
    }
    const g = ground(out.x, out.z, P.freeDisk)
    if (Number.isFinite(g) && out.y < g + P.freeClearance) out.y = g + P.freeClearance
  }

  /** DEV-725: a stick is read through the ships' own response, 2016's 0.2 / 0.9 rescaled. */
  const dead = (v: number | undefined): number => (v === undefined ? 0 : shapeAxis(v))
  /** The pad's trigger pair: a hard cut (a trigger is not a stick). */
  const deadTrigger = (v: number | undefined): number =>
    v === undefined || Math.abs(v) < P.padTriggerDeadzone ? 0 : v

  const freeFlat = (dt: number, rig: TvRig, camera: TvEye, input: TvCameraInput): void => {
    if (!freeSeeded) seedFree(rig)
    freeAngles = flyLook(freeAngles, input.lookDx ?? 0, input.lookDy ?? 0)
    const lx = dead(input.padLookX)
    const ly = dead(input.padLookY)
    if (lx !== 0 || ly !== 0) {
      // The view follows the stick as `flyLook` follows the hand: right lowers the yaw, up raises the pitch.
      const k =
        THREE.MathUtils.radToDeg(P.padLookPerSecond * dt) / FLY_LOOK_POLICY.flyLookDegreesPerPixel
      freeAngles = flyLook(freeAngles, lx * k, ly * k)
    }
    freeScale = flyWheel(freeScale, input.wheel ?? 0)
    const g = ground(freeEye.x, freeEye.z, P.freeDisk)
    const height = Number.isFinite(g) ? freeEye.y - g : 100
    const speed = flySpeed(height, freeScale)
    const keys: FlyKeys = { ...NO_KEYS, ...(input.keys ?? {}) }
    flyStep(freeAngles, keys, speed, dt, _v)
    const mx = dead(input.padMoveX)
    const my = dead(input.padMoveY)
    const rise = deadTrigger(input.padRise)
    if (mx !== 0 || my !== 0 || rise !== 0) {
      flyForward(freeAngles, _f)
      flyRight(freeAngles, _r)
      _v.addScaledVector(_f, -my * speed * dt).addScaledVector(_r, mx * speed * dt)
      _v.y += rise * speed * dt
    }
    _eye.copy(freeEye).add(_v)
    clampFree(_eye, _eye)
    // Never INTO a prop: a move that would touch one is refused whole.
    if (!opts.obstructed?.(_eye.x, _eye.y, _eye.z, 1)) freeEye.copy(_eye)
    rig.position.copy(freeEye)
    flyQuaternion(freeAngles, rig.quaternion)
    camera.position.set(0, 0, 0)
    camera.quaternion.identity()
    remember(rig)
  }

  /**
   * A Free control used outside Free switches to it. Not the mouse's drag, the
   * wheel (DEV-616) or a pad's right stick (DEV-628): in Director and Follow
   * those orbit the chase. Moving the eye (W/A/S/D/Q/E, the left stick, the
   * triggers) is Free's alone.
   */
  const freeTouched = (input: TvCameraInput): boolean => {
    const k = input.keys
    return (
      dead(input.padMoveX) !== 0 ||
      dead(input.padMoveY) !== 0 ||
      deadTrigger(input.padRise) !== 0 ||
      (k !== undefined && Object.values(k).some(Boolean))
    )
  }

  // ── the headset ────────────────────────────────────────────────────────

  const writeHeld = (rig: TvRig): void => {
    if (!held) return
    rig.position.set(held.position[0], held.position[1], held.position[2])
    rig.quaternion.setFromAxisAngle(WORLD_UP, held.yaw)
    remember(rig)
  }

  const headOf = (camera: TvEye): Vec3T => [camera.position.x, camera.position.y, camera.position.z]

  /** Begin a cut through black to `pose`; ignored while one is running. */
  const cutTo = (pose: RigPose, vantage: number): void => {
    if (pending) return
    if (!held) {
      // The first placement of a session: already behind the session's own start, so place now and fade in.
      held = pose
      heldVantage = vantage
      heldSince = time
      cuts++
      pending = { pose, vantage, phase: 'in', t: 0 }
      blackAmount = 1
      return
    }
    pending = { pose, vantage, phase: 'out', t: 0 }
  }

  const advanceCut = (dt: number): void => {
    if (!pending) return
    pending.t += dt
    if (pending.phase === 'out') {
      blackAmount = Math.min(1, pending.t / P.cutOut)
      if (pending.t >= P.cutOut) {
        // Solid black: the ONE moment the rig moves.
        held = pending.pose
        heldVantage = pending.vantage
        heldSince = time
        cuts++
        pending = { pose: pending.pose, vantage: pending.vantage, phase: 'in', t: 0 }
        blackAmount = 1
      }
    } else {
      blackAmount = Math.max(0, 1 - pending.t / P.cutIn)
      if (pending.t >= P.cutIn) {
        pending = null
        blackAmount = 0
      }
    }
  }

  const vantageIndex = (want: (v: Vantage) => boolean): number => vantages.findIndex(want)

  /** The vantage a subject should be watched from now: the first far enough ahead of it. */
  const pickVantage = (s: Seen, sh: TvShot | null): number => {
    if (vantages.length === 0) return -1
    if (sh === 'start') {
      const i = vantageIndex((v) => v.anchor === 'start')
      if (i >= 0) return i
    }
    if (sh === 'finish') {
      const i = vantageIndex((v) => v.anchor === 'finish')
      if (i >= 0 && s.track.arc <= (vantages[i] as Vantage).arc + P.passBeyond) return i
    }
    const lead = Math.max(P.minLead, s.track.speed * P.leadSeconds)
    const ahead = vantageIndex((v) => v.arc >= s.track.arc + lead)
    if (ahead >= 0) return ahead
    return vantages.length - 1
  }

  const vantagePose = (i: number, camera: TvEye): RigPose => {
    const v = vantages[i] as Vantage
    return rigForEye(v.eye, v.yaw, headOf(camera))
  }

  const headsetWatch = (camera: TvEye, s: Seen | null, sh: TvShot | null): void => {
    if (!s) {
      if (!held && vantages.length > 0) cutTo(vantagePose(0, camera), 0)
      return
    }
    const subjectChanged = heldFor !== s.craft.id
    if (!held || heldVantage < 0) {
      const i = pickVantage(s, sh)
      if (i >= 0) cutTo(vantagePose(i, camera), i)
      heldFor = s.craft.id
      return
    }
    if (pending) return
    const v = vantages[heldVantage] as Vantage
    const p = s.craft.position
    const far = Math.hypot(p.x - v.eye[0], p.y - v.eye[1], p.z - v.eye[2]) > P.lostDistance
    const passed = s.track.arc > v.arc + P.passBeyond
    const wantStart = sh === 'start' && v.anchor !== 'start'
    const wantFinish = sh === 'finish' && v.anchor !== 'finish'
    const due = subjectChanged || far || passed || wantStart || wantFinish
    if (!due) return
    // A new subject cuts at once (the Director already held its own minimum); the same subject waits out the hold.
    if (!subjectChanged && time - heldSince < P.headsetMinHold) return
    const i = pickVantage(s, sh)
    heldFor = s.craft.id
    if (i >= 0 && i !== heldVantage) cutTo(vantagePose(i, camera), i)
  }

  const headsetFree = (camera: TvEye, input: TvCameraInput): void => {
    if (pending || !held) return
    const head = headOf(camera)
    if (input.snap === 1 || input.snap === -1) {
      // A snap is instant (no fade, as every headset title does it) and is still a cut: one placement.
      held = snapTurn(held, head, input.snap)
      heldSince = time
      cuts++
      return
    }
    if (input.teleport && input.aim) {
      const target = teleportTarget(input.aim.origin, input.aim.direction, {
        heightAt: opts.heightAt,
        obstructed: opts.obstructed,
        bounds: opts.bounds,
      })
      if (target) cutTo(rigForEye(target.eye, held.yaw, head), -1)
    }
  }

  // ── the camera ─────────────────────────────────────────────────────────

  const setMode = (m: TvCameraMode): void => {
    if (m === mode) return
    if (m === 'follow' && mode === 'director' && subjectId !== null) {
      targetId = subjectId
      const s = byId(subjectId)
      if (s) targetIndex = s.index
    }
    if (m === 'free') freeSeeded = false
    if (m === 'director') {
      shot = null
      subjectId = null
      shotSince = Number.NEGATIVE_INFINITY
    }
    mode = m
  }

  return {
    mode: () => mode,
    setMode,
    cycleMode() {
      const i = TV_CAMERA_MODES.indexOf(mode)
      setMode(TV_CAMERA_MODES[(i + 1) % TV_CAMERA_MODES.length] as TvCameraMode)
      return mode
    },
    next: () => step(1),
    previous: () => step(-1),
    follow(n: number) {
      if (!Number.isInteger(n) || n < 1) return
      pendingRacer = n
      targetId = null
      targetIndex = n - 1
      mode = 'follow'
    },

    frame(dtIn, rig, camera, input = {}) {
      const dt = Math.max(0, Math.min(P.maxDt, dtIn))
      time += dt
      observe(dt)
      const presenting = opts.presenting()
      const cutsOn = opts.headsetCuts?.() === true
      headsetParity = presenting && !cutsOn
      if (!headsetParity || mode !== 'free') paritySeeded = false
      if (presenting !== wasPresenting) {
        // In or out of a session: forget the held pose (a new session places afresh) and the flat seed.
        held = null
        heldVantage = -1
        heldFor = null
        pending = null
        blackAmount = 0
        freeSeeded = false
        chaseSubject = null
        wasPresenting = presenting
        // DEV-616: the orbit is a flat screen's, and a headset starts on the chase.
        orbitYaw = 0
        orbitPitch = 0
        orbitZoom = 1
        orbitIdle = Number.POSITIVE_INFINITY
      }
      if (!presenting && mode !== 'free' && freeTouched(input)) setMode('free')
      const { s, shot: sh } = subjectNow()

      if (headsetParity) {
        // Matt, 2026-10-01: functionally identical to flat. Director and Follow
        // fly the flat chase (the rig level); Free is continuous flight.
        if (mode === 'free') freeHeadset(dt, rig, camera, input)
        else if (s) flatShot(dt, rig, camera, s, sh)
        return
      }
      if (presenting) {
        advanceCut(dt)
        if (mode === 'free') {
          if (!held) headsetWatch(camera, s, sh)
          headsetFree(camera, input)
        } else {
          headsetWatch(camera, s, sh)
        }
        writeHeld(rig)
        // The camera's local pose is the runtime's: never touched in a session.
        return
      }

      if (mode === 'free') {
        freeFlat(dt, rig, camera, input)
        return
      }
      stepOrbit(dt, input)
      if (s) flatShot(dt, rig, camera, s, sh)
    },

    black: () => blackAmount,
    vantages: () => vantages,
    mapView() {
      const s = mode === 'director' ? byId(subjectId) : mode === 'follow' ? byId(targetId) : null
      return {
        outline: mapOutline,
        finish: opts.course.finish ? { x: opts.course.finish[0], z: opts.course.finish[2] } : null,
        dots: seen.map((q) => ({
          id: q.craft.id,
          name: q.craft.name,
          x: q.craft.position.x,
          z: q.craft.position.z,
          colour: q.craft.colour ?? null,
          followed: s !== null && q.craft.id === s.craft.id,
          finished: q.track.finishedAt !== null,
        })),
        following: s ? s.craft.name : null,
        speed: s ? s.track.fly : null,
      }
    },

    report() {
      const s = mode === 'director' ? byId(subjectId) : mode === 'follow' ? byId(targetId) : null
      return {
        mode,
        shot: mode === 'director' ? shot : null,
        following: s ? s.craft.name : null,
        racer: s ? (s.craft.racer ?? s.index + 1) : null,
        with: mode === 'director' ? (byId(withId)?.craft.name ?? null) : null,
        presenting: wasPresenting,
        headsetCuts: wasPresenting && !headsetParity,
        vantage: wasPresenting ? heldVantage : -1,
        cuts,
        directorCuts,
        black: blackAmount,
        vantages: vantages.length,
        liftedVantages: vantages.filter((v) => v.lifted).length,
        orbit: orbiting() ? [orbitYaw, orbitPitch, orbitZoom] : null,
        framing: mode === 'director' && (headsetParity || !wasPresenting) ? framingNow : null,
        framingCuts,
        eyeProblem: lastProblem,
        eyeAdjusted: eyeMoved,
        subjectShare: mode === 'director' ? subjectShare : 0,
        overtakes,
        gateCuts,
        lastOvertake,
        lastFinish,
        followedGates: s ? (gatesHigh.get(s.craft.id) ?? 0) : 0,
        winnerShot: mode === 'director' && framing === 'orbit' && winnerLive(),
      }
    },
  }
}

/** The head's world position under a held pose, for a test, and for the beam's reticle. */
export const tvHeadWorld = headWorld
