// src/sim/constants.ts — the sim's ONLY door to the constants sheet.
//
// ── Read this before you add anything to it. ──────────────────────────────
// PORT_PLAN §4.1 / DECISIONS D10: **FF2 never hand-types a constant.**
// `tools/extract/constants.mjs` reads the read-only Unity project and emits
// `src/generated/constants.generated.{json,ts,sha256}`, every entry carrying
// its prefab, fileID, line and trust level. This module re-exports the few
// values the sim needs under sim-facing names and adds nothing of its own.
//
// **A numeric literal in this file is a bug.** Four independent research
// passes have published wrong constants — including `_CORRECTIONS.md` itself —
// every time by copying a C# field initialiser instead of resolving
// scene → prefab → `m_Modifications`. See CLAUDE.md, hard rule 2.

import { WORLD } from '@/generated/constants.generated'

export type { ConstantEntry, Trust } from '@/generated/constants.generated'
export { PROVENANCE } from '@/generated/constants.generated'

/**
 * Fixed simulation timestep, seconds — Unity's project-wide physics tick, not
 * a vehicle property and not a design choice. Every per-tick constant in the
 * game (the 4.5 % / 6.5 % anisotropic velocity bleed above all) is meaningless
 * without it. DECISIONS D4.
 *
 * Note the value: **0.0121999998**, the float32 actually serialised in
 * `TimeManager.asset`. Everything written about this game says "0.0122", and
 * for prose that is fine — but the sim uses the number the game ran on.
 */
export const FIXED_DT: number = WORLD.fixedDeltaTime

/** Ticks per second, derived. Convenience only — never a second source of truth. */
export const TICK_RATE: number = 1 / FIXED_DT

/**
 * World gravity. (0, −32, 0), not −9.81. Every mass, drag and thrust value in
 * the 2016 game was tuned against it; swapping in Earth gravity silently
 * rescales the entire JumpSeat.
 */
export const GRAVITY = WORLD.gravity
