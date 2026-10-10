// src/net/lap-policy.ts — every threshold the lap server judges by, in one place.
//
// DEV-372. D30's bargain is *"best-effort and moderatable: we deter casual
// cheating and delete the rest"*, and PLAYER-GHOSTS §8 call 5 puts this code in
// a repository that goes public: these numbers are meant to be read. Each one
// says what it is OF and where it came from, because a derived number needs
// the same provenance as an extracted one (CLAUDE.md, DEV-027).
//
// SERVER-SAFE: no imports but the sim's fixed step.

import { FIXED_DT } from '@/sim/constants'

// ── Sizes ─────────────────────────────────────────────────────────────────

/**
 * Deflated lap bytes, at most. D30's 64 KB. The autopilot `int_01` lap is
 * 15,393 B unchained (DEV-370 §3) and 19,269 B with the speed chain (DEV-372
 * §4), and 2016's longest clip would be 18,925 B as a lap (PLAYER-GHOSTS §3.2),
 * so this is 3.4x the longest real lap measured.
 */
export const LAP_COMPRESSED_MAX = 64 * 1024

/**
 * The inflated wire, at most: a zip bomb stops here, whatever its ratio.
 *
 * A key is nine zigzag varints (tick, three mm, four int16). A tick delta fits
 * two bytes (a gap under 100 s), a millimetre delta three (a move under
 * 1,048 m) and an int16 delta three; the FIRST key's millimetres are absolute,
 * four. So an honest key is at most 23 bytes, 32 is a ceiling nothing honest
 * reaches, and a lap is at most
 * `lapKeyCap(180)`, 14,756 keys: 472 KB. Plus a 32 KB header (the events,
 * ~30 bytes each: 21 rings, a finish and a reset every half second of a 180 s
 * run is 382 of them, 11 KB) — and rounded up to a power of two.
 */
export const LAP_INFLATED_MAX = 512 * 1024

/**
 * A request body, at most: the lap as base64url (4 characters per 3 bytes) and
 * 4 KB for the rest of the envelope — a handle, an owner key and a claim.
 */
export const LAP_BODY_MAX = Math.ceil(LAP_COMPRESSED_MAX / 3) * 4 + 4096

/**
 * Keys a lap of this course may hold: one per fixed step from the release to
 * the time limit, inclusive. §5's `timeLimit / FIXED_DT`, plus tick 0.
 */
export const lapKeyCap = (timeLimit: number): number => Math.ceil(timeLimit / FIXED_DT) + 1

// ── Plausibility ──────────────────────────────────────────────────────────

/**
 * Fraction over the chain-aware terminal speed a lap may fly (§3.4).
 *
 * The ceiling is `terminalSpeed(maxSpeed + increment × ringsTakenSoFar)`, the
 * CONTINUOUS equilibrium, which is itself above what the discrete flight model
 * reaches (Unity's drag is applied per step, `(1 - drag × dt)`, 1.5 % lower).
 * On top of that, 5 %, for three things the ceiling does not model:
 *
 *   - DEV-364's contact: a racer can push the player, and a racer carrying
 *     more chain than the player can push it past the player's own terminal;
 *   - the decimator's 25 mm per axis over a `LAP_SPEED_WINDOW_S` window
 *     (0.04 m in 50 m: 0.1 %), and 2016's millisecond times (1 ms in 250 ms:
 *     0.4 %);
 *   - 2016's own laps predate the shipped prefab by 102 days (D11). The fast
 *     one reaches 0.9935 of this ceiling unmargined (`lap-validate.test.ts`
 *     pins it), so the 5 % is headroom, not a fit to it.
 *
 * What it buys a cheater: a lap at most 5 % faster than the physics allows,
 * everywhere at once, which is a lap somebody would notice. D30 accepts that.
 */
export const LAP_SPEED_MARGIN = 0.05

/**
 * Seconds a speed is averaged over before it is judged. One tick is 12.2 ms,
 * and 25 mm of decimation error at each end of one tick is 4 m/s; over a
 * quarter of a second it is 0.2 m/s. A burst shorter than this still moves the
 * average of every window that holds it, and the per-segment jump test below
 * does not wait for a window at all.
 */
export const LAP_SPEED_WINDOW_S = 0.25

/**
 * Metres a single segment may exceed "the fastest the ship can go, for as long
 * as the segment lasts" by before it is a JUMP. Two decimated keys, 25 mm per
 * axis each (0.087 m), and 2016's millisecond times at the full-chain terminal
 * (0.34 m): half a metre covers both. A jump worth anything is tens of metres.
 */
export const LAP_JUMP_SLACK_M = 0.5

/**
 * Metres a crash reset may land AHEAD of where the crash projects onto the
 * course line. The live reset lands `resetBackMetres` (120) BEHIND it, so any
 * forward reading is the line's own projection noise: two nearest-point
 * searches of a lifted pose against a 421-point line.
 */
export const LAP_RESET_ARC_SLACK_M = 10

/**
 * Metres a crash reset may sit off the course line beyond the edition's
 * `clearanceMetres`, which is the most the live reset lifts a pose off it
 * (`sim/crash.ts`'s `planResetAt`).
 */
export const LAP_RESET_LATERAL_SLACK_M = 10

/**
 * Metres the first key may sit from the release point, or a placement from the
 * respawn marker. The live run holds the ship EXACTLY there (`game/flight.ts`)
 * and a lap quantises to 0.5 mm, so this is only rounding; a metre of it is
 * worth 6 ms at the speed a lap leaves the lift.
 */
export const LAP_START_TOLERANCE_M = 1

/**
 * Ticks a claimed time may differ from the server's rescore. DEV-370 pins the
 * poses either side of the finish, so an honest lap rescores to the live
 * finish tick exactly; one tick is room for a rounding nobody has seen yet.
 */
export const LAP_CLAIM_TOLERANCE_TICKS = 1

// ── Retention and limits ──────────────────────────────────────────────────

/** Laps a board keeps (PLAYER-GHOSTS §8 call 6: "top 100"). */
export const LAP_BOARD_SIZE = 100

/** Days a lap that is not on a board stays raceable from its link (D30). */
export const LAP_SHARE_TTL_DAYS = 30

/**
 * Submits one address may make in an hour. A Ring Attack lap takes a minute
 * or more and sharing is an explicit action (call 9), so an hour of racing is
 * at most ~50 finishes and an honest player shares a handful of them.
 */
export const LAP_SUBMITS_PER_HOUR = 20

/**
 * D30's hard storage cap, as a daily cap on NEW laps. D1 holds 5 GB. Budget 4
 * of it for shared laps, and a shared lap lives `LAP_SHARE_TTL_DAYS`, so at the
 * worst-case size (`LAP_BODY_MAX` of text) the table can never outgrow the
 * budget if at most this many arrive a day. A board is `LAP_BOARD_SIZE` laps,
 * ~9 MB at that worst case, so the other gigabyte holds over a hundred boards.
 */
export const LAP_DAILY_CAP = Math.floor((4 * 1024 ** 3) / (LAP_SHARE_TTL_DAYS * LAP_BODY_MAX))

/** Characters in a lap id: base62, ~59.5 bits. It is the whole of a share link. */
export const LAP_ID_LENGTH = 10

// ── Moderation (DEV-374) ──────────────────────────────────────────────────

/**
 * Characters an `ADMIN_TOKEN` must have before the admin routes answer at all.
 * Below it they are OFF (503), not open: a short token is one somebody typed,
 * and one somebody typed can be guessed. 32 characters of base64 is 192 bits;
 * `openssl rand -base64 32` makes 44. Nothing rate-limits a guess, and at that
 * length nothing needs to.
 */
export const ADMIN_TOKEN_MIN_LENGTH = 32

/**
 * Days the moderation log keeps a row: what was removed, its handle and its
 * owner-key hash, and why. Long enough to answer "why did my lap go?" and to
 * block a device after the fact; short enough that the log is not a second
 * archive of the laps it removed. `/privacy` states it.
 */
export const ADMIN_LOG_DAYS = 90

/** Rows one audit returns at most, per list. A board is 100; this is five of them. */
export const ADMIN_AUDIT_MAX = 500

/** Characters of an admin's `reason`, at most: a sentence, not a document. */
export const ADMIN_REASON_MAX = 500
