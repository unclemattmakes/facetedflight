// src/game/finish-feel.ts: GO and the finish, felt. DEV-644.
//
// CONSULTANT-REVIEW-2026-10-05 item H: "GO has sound and music but no picture."
// At GO the frame's edge flashes and (flat) the lens kicks; at the line the edge
// flashes in the MEDAL's own colour, over a phrase that is the medal's own (the
// per-tier cues in `audio/cues.ts`). The shake and the cockpit shove at GO are
// the feel layer's (`boot/feel.ts`, DEV-636). PURE: no three, no DOM. Presentation
// only: nothing here is read by the sim.

import type { MedalTier } from '@/game/best-medal'

/** What GO feels like. FF2's own. */
export const GO_FEEL = {
  /** Flat lens kick at GO, degrees, and how long it takes to fall back. */
  fovKickDegrees: 2.5,
  fovKickSeconds: 0.3,
  /** The edge flash at GO, as a multiple of a plain gate's pulse. */
  pulseScale: 1.2,
} as const

/** What the line feels like. */
export const FINISH_FEEL = {
  /** The edge flash in the medal's colour, as a multiple of a plain gate's pulse. */
  pulseScale: 1.5,
} as const

/**
 * The speed (m/s) an edge flash that is not a gate is fired at. The pulse's
 * strength is a curve of speed (`fx.gatePulse.gainBySpeed`); a flash at GO or at
 * the line is not a gate pass, so it takes the middle of the curve instead of the
 * ship's own speed (which is zero at GO and arbitrary at the line).
 */
export const EDGE_FLASH_SPEED = 200

const TIERS: readonly string[] = ['bronze', 'silver', 'gold', 'platinum']

/** The medal id the app holds, as a tier that has a colour, or null ('none', a future grade). */
export const medalTierOf = (medal: string): MedalTier | null =>
  TIERS.includes(medal) ? (medal as MedalTier) : null
