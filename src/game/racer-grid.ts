// src/game/racer-grid.ts — where the opposition stands at the start.
//
// Matt, 2026-09-16: *"add 3 more racers to the hover jet. these should be
// aligned in front of the player at the race start."* DEV-125.
//
// ── Two sources, one list ─────────────────────────────────────────────────
//
// 2016 authored TWO positions for its opposition: the `starting_platform` pads
// tagged `ai` in `spawn.startGrid`, 15.7 m off one shoulder and 16.4 m off the
// other, 2 m behind the player. Those are measured and they stay. The three
// more are FF2's, and they are content: `gameplay.racers.slots` in the edition
// preset, each one metres AHEAD and metres RIGHT of the player's release point.
//
// This module turns both into one list of world-space starts in THREE space —
// the same space the level JSON is in — so `game/racers.ts` spawns from it and
// `boot/app.ts` draws a pad under each one, and the two cannot disagree about
// where a racer is.
//
// ── The frame ─────────────────────────────────────────────────────────────
//
// "Ahead" is the spawn heading. Measured on `int_01`: the spawn quaternion's
// forward is (0.747, 0, −0.665) and the route's first leg runs (0.731, 0.044,
// −0.681) — the same direction to 1.3°, which is why a slot laid along the
// spawn heading is also laid along the course. `tests/unit/racer-grid.test.ts`
// holds that on all six RACING courses (0.6° to 6.3°, gate 0 79–122 m ahead
// within 4°) rather than trusting the one that was measured — and records the
// counter-case: `hoverJet_kauai_beg`, the same course forced to Free Flight,
// spawns 86° off its own line with gate 0 2.5 km away. No grid is ever drawn
// there (Free Flight has no opponents), so the property this file needs is a
// property of exactly the courses that use it.
//
// The z-flip is NOT here. Everything in this file is three space; the sim
// mirror happens once, in `racers.ts`, the same way it does for the pads.
//
// No three: two rotations by a quaternion, done with the sim's own quat maths.

import type { EditionRacerSlot, EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import { hoverEquilibriumHeight } from '@/sim/hover-motor'
import { quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { hullFromColliders } from '@/sim/terrain-collision'

/** One place a racer starts. THREE space, like the level JSON. */
export interface RacerStart {
  /** World position at the release altitude. */
  readonly pos: readonly [number, number, number]
  /** Facing. The spawn quaternion for every start; xyzw, three space. */
  readonly quat: readonly [number, number, number, number]
  /**
   * `player` is the player's own pad, where the lift leaves the ship (a room's
   * start 0, DEV-477); `pad` is one of 2016's; `slot` is a preset slot, with
   * its index; `ghost` is where one of 2016's recordings began on a course that
   * authored no AI pad (DEV-442), with its index in `level.ghosts`. 2016 drew
   * no pad under one; the port does since DEV-457, as it does under a slot.
   */
  readonly from:
    | { readonly kind: 'player'; readonly index: 0 }
    | { readonly kind: 'pad'; readonly index: number }
    | { readonly kind: 'slot'; readonly index: number }
    | { readonly kind: 'ghost'; readonly index: number }
  /** A tuning key the slot asked for, or null to take the next one. */
  readonly tuning: string | null
}

interface StartGridPad {
  readonly role: string
  readonly pos: readonly number[]
  readonly size?: readonly number[]
}

// ── DEV-158: the grid HOVERS, it does not rest ───────────────────────────
//
// Matt, from a VR playthrough: *"instead of toggling it on, let's just start
// with it enabled. this way our player and ai jets don't start with their
// bellies on the pads."*
//
// The line above this used to put EVERY start at the player's release
// altitude, under a comment saying *"the pads carry their own deck height,
// which is 2 m under this"*. That is true of the player's pad and false of the
// AI pads, which 2016 re-authored per course at their own heights — the
// agreement lesson, exactly: checked where the two stories agree.
//
// Measured, on every HoverJet course that authors AI pads, one of the two
// racers had its hull **0.38 to 0.40 m INSIDE its own pad**:
//
//   course        release Y   ai pad tops        hull bottom   clearances
//   int_01         126.435    125.384 125.973      125.575     +0.191  -0.398
//   int_02         774.028    772.997 773.548      773.168     +0.171  -0.380
//   adv_01         210.037    209.581 208.981      209.177     -0.404  +0.196
//   adv_02         127.237    126.781 126.181      126.377     -0.404  +0.196
//   kauai_beg      308.137    307.681 307.081      307.277     -0.404  +0.196
//
// So this is a PORT BUG, not 2016. The proof is outside the port: 2016's own
// two recordings (`content/ghosts/*.json`, generated and hash-guarded) start
// their ships at y = 127.868 and 127.856 on int_01 — 1.42 m ABOVE the player's
// release altitude and 2.48 / 1.88 m above their own pads. 2016 never stood a
// ship at another ship's altitude.
//
// The stand-off is the hover engine's own answer — `hoverEquilibriumHeight`
// off the sheet's `hoverForce`, `hoverHeight`, mass, gravity and `dt`. On the
// HoverJet that is 1.3282 m of HULL clearance, and it puts the two int_01
// racers within 0.31 m of both 2016 recordings (127.572 against 127.868,
// 128.161 against 127.856) from one number that was not fitted to them.
//
// **Only the 2016 PADS are lifted.** A preset slot (DEV-125) stands on a pad
// this port draws itself at a height it chose, its hull already clears it, and
// its altitude was authored against the sightline to gate 0 — so lifting it
// would move a ship into the ring the player is aiming at, to fix nothing. See
// the ledger row for what is still open there.

/** Metres from the ship's origin down to the lowest point of its hull. */
const hullDepth = (): number => {
  let lowest = 0
  for (const s of hullFromColliders(
    HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  )) {
    if (s.y - s.radius < lowest) lowest = s.y - s.radius
  }
  return -lowest
}

/**
 * How far above a pad's TOP FACE a HoverJet's origin stands when its hover
 * engine is holding it there: the motor's equilibrium height plus the hull.
 *
 * Every number is the sheet's. A literal here would be a bug (hard rule 3).
 */
export const padStandoff = (): number =>
  hoverEquilibriumHeight(
    { hoverForce: HOVERJET.hoverMotor.hoverForce, hoverHeight: HOVERJET.hoverMotor.hoverHeight },
    HOVERJET.rigidbody.mass,
    GRAVITY.y,
    FIXED_DT,
  ) + hullDepth()

/**
 * DEV-554: how far the seat stands over its lift's dish's FOOT: the lift's own
 * dish, in the seat's frame, as `tools/extract/level.mjs` reads it per rig
 * (`spawn.launch.dish`; 2.2 m on all seven). Null on a course with no lift.
 *
 * Matt, 2026-09-30, on DEV-547's call that the racers on 2016's two pads stood
 * 1.14 m over their (lift-sized) floor where everyone else hovers 0.17-0.18:
 * *"lower the racers"*. In his fiction every pad is a lift's car and every
 * racer rode the same lift (DEV-461), so a ship stands over its pad's foot as
 * the player's stands over the lift's: this far.
 */
export const seatOverDishFoot = (level: Level): number | null => {
  const dish = (level.spawn.launch as { dish?: { pos?: readonly number[] } | null } | null)?.dish
  const y = dish?.pos?.[1]
  return typeof y === 'number' ? -y : null
}

/** The top face of a pad, or null for a pad the extractor gave no size. */
export const padTop = (pad: StartGridPad): number | null => {
  const y = pad.pos[1]
  const h = pad.size?.[1]
  return typeof y === 'number' && typeof h === 'number' ? y + h / 2 : null
}

/** The two horizontal unit vectors of the player's frame at the spawn. Three space. */
export const spawnFrame = (
  level: Level,
): { forward: [number, number, number]; right: [number, number, number] } => {
  const q = level.spawn.quat as number[]
  const rotation = quat(q[0] as number, q[1] as number, q[2] as number, q[3] as number)
  // three's camera and every mesh out of the converter look down −z, so the
  // spawn heading is −z rotated. `racers.ts` and `flight.ts` orient the body
  // with this same quaternion, so this is the direction the nose points.
  const f = rotateVec3(v3(), rotation, v3(0, 0, -1))
  // Flattened: a slot is laid out on the deck, not tilted with a nose-up spawn.
  const flat = Math.hypot(f.x, f.z)
  const forward: [number, number, number] = flat > 1e-9 ? [f.x / flat, 0, f.z / flat] : [0, 0, -1]
  // forward × up, in a right-handed frame looking down −z: (0,0,−1) × (0,1,0)
  // is (1,0,0), the player's right. `audio/spatial.ts` makes the same check.
  const right: [number, number, number] = [-forward[2], 0, forward[0]]
  return { forward, right }
}

// ── DEV-442: 2016 raced the rookie courses too ──────────────────────────
//
// Matt, 2026-09-27: *"the first time i was in, i was stuck on the classic mode -
// and there were no other racers in the map with me."* Classic's grid was the
// `ai` pads alone, and `rookie_01` / `rookie_02` author none, so Classic raced
// nobody on them — the green mark on two of Ring Attack's three places, and
// two of Quick Race's six courses. DEV-125 and `classic.json` both called that
// 2016. It was not: DEV-055's census has two GhostRacers flying their own
// course on EVERY HoverJet mission, the rookies included, and
// `PlayRandomAnimation.Start()` plays every one of them.
//
// 2016's opposition stood where its recordings begin, and the extractor now
// says where that is (`GhostRef.start`: the clip's first root key through the
// ghost's parent). On the four courses with pads it lands within 2.7 m of an
// `ai` pad, which is how the reading is known to be the ship and not the
// object; on both rookie courses it puts the two ships level with the player,
// 17 m off each shoulder and 0.4 to 1.3 m above the release, with no pad under
// them. So the pads stay where there are pads (DEV-158's stand-off), and a
// course without one starts its racers where 2016's did.
//
// ── DEV-457: and Anniversary's grid takes them too ──────────────────────
//
// This block was Classic's only, with Anniversary's rookie courses racing their
// three slots and nobody off the shoulders, until Matt answered the call
// DEV-442 left him: *"5 racers on rookie"*. So wherever a course authored no
// `ai` pad, 2016's two starts join the grid on BOTH presets — Anniversary's
// three slots after them, five in all, as the pad courses have — and every
// start that holds a ship at the release gets a pad under it
// (`render/start-grid.ts`, DEV-444's pad for a ship there).

/**
 * The full grid for one level under one preset: 2016's opposition first — its
 * `ai` pads, or on a course that authored none, where its recordings began
 * (DEV-442, both presets since DEV-457) — then the preset's slots.
 *
 * `enabled` false is 2016's grid: the slot list is not read, so Classic cannot
 * be changed by editing a number it never looks at.
 */
export const racerStarts = (level: Level, grid: EditionRacers): RacerStart[] => {
  const spawn = level.spawn.pos as number[]
  // The player's release. A SLOT still leaves from here (see the DEV-158 note
  // above); a 2016 pad stands its own hover stand-off above its own deck.
  const releaseY = (spawn[1] as number) + (level.spawn.launch?.rise ?? 0)
  const standoff = padStandoff()
  const overFoot = seatOverDishFoot(level)
  const facing = level.spawn.quat as number[]
  const q: [number, number, number, number] = [
    facing[0] as number,
    facing[1] as number,
    facing[2] as number,
    facing[3] as number,
  ]

  const out: RacerStart[] = []
  const usePads = !grid.enabled || grid.usePads
  if (usePads) {
    const pads = (
      (level.spawn as { startGrid?: { pads?: StartGridPad[] } }).startGrid?.pads ?? []
    ).filter((p) => p.role === 'ai')
    pads.forEach((pad, index) => {
      // The pad's OWN deck, not the player's. A pad the extractor gave no size
      // cannot say where its top is, and falling back to the release altitude
      // is what this file did for every pad until DEV-158 — no worse, and loud
      // in the one place it could happen.
      const top = padTop(pad)
      // DEV-554: where the course has a lift, its car's own height over the
      // pad's foot (the node's origin, which is the dish's foot); DEV-547 draws
      // every one of these pads at the lift's size, so the ship sits in it as
      // the player sits in the lift's. Where it has none, DEV-158's hover
      // stand-off over the pad's box.
      const y =
        overFoot !== null
          ? (pad.pos[1] as number) + overFoot
          : top === null
            ? releaseY
            : top + standoff
      out.push({
        pos: [pad.pos[0] as number, y, pad.pos[2] as number],
        quat: q,
        from: { kind: 'pad', index },
        tuning: null,
      })
    })
    // DEV-442: no pad, so 2016's own starts — the recordings' first keys. On
    // both presets since DEV-457 (Matt: *"5 racers on rookie"*).
    if (pads.length === 0) {
      for (const [index, ghost] of (level.ghosts ?? []).entries()) {
        const at = ghost.start
        if (!at) continue
        out.push({
          pos: [at[0] as number, at[1] as number, at[2] as number],
          quat: q,
          from: { kind: 'ghost', index },
          tuning: null,
        })
      }
    }
  }
  if (grid.enabled) {
    const { forward, right } = spawnFrame(level)
    grid.slots.forEach((slot: EditionRacerSlot, index) => {
      out.push({
        pos: [
          (spawn[0] as number) + forward[0] * slot.ahead + right[0] * slot.right,
          releaseY,
          (spawn[2] as number) + forward[2] * slot.ahead + right[2] * slot.right,
        ],
        quat: q,
        from: { kind: 'slot', index },
        tuning: slot.tuning ?? null,
      })
    })
  }
  return out
}

// ── DEV-477: a room's players stand on the racers' own starts ───────────
//
// Matt, 2026-09-27: *"plz verify that our multiplayer players aren't all
// spawned at the same location. 1 player per start-point (players instead of
// the ai racers)"* — and, of three options, **the racers' own starts**.
//
// So a room has ONE list of starts, and it is single player's: the player's
// own pad first (where the lift leaves the ship), then `racerStarts` in its
// order — 2016's two `ai` pads (or, on a rookie course, where 2016's two
// recordings began), then Anniversary's chevron. The room hands its humans the
// first ones, one each, and its bots the rest (`net/room-server.ts`); every
// client places every ship from this list, and the judge accepts a seat's lap
// from its own entry and no other (`net/room-lap.ts`, off the same list in
// `content/lap-courses.json`).
//
// **This is not a level start, and Matt was told so before he chose it:** a
// room's time runs from each player's OWN release, so a person on a chevron
// slot flies a shorter lap than one on the pad. DEV-389's human row existed to
// prevent exactly that (*"the chevron's slots ... are no place for a person"*),
// and this replaces it. The unfairness is measured rather than hidden:
// `racer-grid.test.ts` pins each start's distance to gate 0 on every Ring
// Attack course, and the ledger row carries the table. In short, against the
// pad: 2016's two stand 0.9 to 6.8 m FARTHER from gate 0 (the pad is the
// nearest of the three on all six courses), the chevron's first pair 9.5 to
// 12.0 m NEARER, and its apex 26.3 to 27.2 m nearer. So a room of three or
// fewer is level to under 7 m, and the fourth, fifth and sixth person start
// ahead. Which person gets which start is the room's shuffle, not the order
// they joined in (`net/room-server.ts`).

/**
 * DEV-477: a ROOM's starts, in the order it hands them out — the player's own
 * pad (the release point: the lift's top, at the release altitude), then
 * `racerStarts`. Index `k` is `RoomRace.starts[slot]` for a person and
 * `RoomBot.start` for a bot, so every client stands every ship on the same
 * start from one number. Its length is the room's seat cap
 * (`RoomSettings.seats`, `boot/app.ts`'s `roomSettingsFor`).
 */
export const roomStarts = (level: Level, grid: EditionRacers): RacerStart[] => {
  const spawn = level.spawn.pos as number[]
  const facing = level.spawn.quat as number[]
  const player: RacerStart = {
    pos: [
      spawn[0] as number,
      (spawn[1] as number) + (level.spawn.launch?.rise ?? 0),
      spawn[2] as number,
    ],
    quat: [facing[0] as number, facing[1] as number, facing[2] as number, facing[3] as number],
    from: { kind: 'player', index: 0 },
    tuning: null,
  }
  return [player, ...racerStarts(level, grid)]
}

/**
 * A slot's position expressed back in the player's frame: metres ahead and
 * right of the release point. The inverse of `racerStarts` for a slot, and the
 * measurement `racer-grid.test.ts` makes of a pad — so the test reads the
 * geometry rather than re-deriving the rotation.
 */
export const inSpawnFrame = (
  level: Level,
  pos: readonly number[],
): { ahead: number; right: number } => {
  const spawn = level.spawn.pos as number[]
  const { forward, right } = spawnFrame(level)
  const dx = (pos[0] as number) - (spawn[0] as number)
  const dz = (pos[2] as number) - (spawn[2] as number)
  return {
    ahead: dx * forward[0] + dz * forward[2],
    right: dx * right[0] + dz * right[2],
  }
}
