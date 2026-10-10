// src/game/wing-trails.ts — which ships leave wing-tip trails, and when. DEV-358.
//
// The ribbons are `render/wing-trails.ts`; the strength is
// `game/wing-trail-fade.ts`. This joins them to ships: each craft is its two
// measured tips, the node whose world matrix carries them, and the sim body
// whose forward speed decides how much vapour it makes.
//
// Two owners, one draw each. `game/racers.ts` makes ONE batch for every racer,
// and `game/flight.ts` makes one for the player's ship, because the player's
// trails answer a question the racers' do not: whether the player is looking
// at their own ship (third person) or sitting in it (see `shown` below).
//
// ── Off is OFF ───────────────────────────────────────────────────────────
//
// When the preset or the comfort slider says nothing (`wingTrailScale` 0), or
// the craft is not shown, its history is DROPPED rather than aged: no vapour
// is made, nothing is drawn, and a trail switched back on starts at the tips
// instead of drawing the streak it would have left while it was off. On
// Classic that is the whole of the per-frame work: one flag read and a clear.

import * as THREE from 'three'
import type { EditionWingTrails } from '@/content/edition-schema'
import {
  bodyForwardSpeed,
  type ForwardSpeedBody,
  hoverJetWingTrailFade,
  type TintSrgb,
  trailTint,
  wingTrailScale,
  wingTrailStrength,
} from '@/game/wing-trail-fade'
import { srgbToLinear } from '@/render/unity-space'
import { createWingTrails, type WingTips, type WingTrails } from '@/render/wing-trails'

/** One ship that leaves trails. */
export interface WingTrailCraft {
  /** The two tips, in the frame `frame`'s world matrix maps FROM. */
  readonly tips: WingTips
  /** The node that carries the tips: the racer's ship node, or the player's art pivot. */
  readonly frame: THREE.Object3D
  /** The sim body whose FORWARD speed decides the strength. */
  readonly body: ForwardSpeedBody
  /**
   * The ship's livery colour, sRGB 0..1, which its trails are tinted toward
   * (`fx.wingTrails.tint`): a racer's palette colour (DEV-350), the player's
   * orange panel. Null is white. DEV-358 follow-up.
   */
  readonly livery: TintSrgb | null
}

export interface CraftWingTrails {
  /** The one draw. Add `trails.object` to the scene ROOT (or a group at identity). */
  readonly trails: WingTrails
  /**
   * Advance every craft and draw, facing `eye` (the HEAD's world position).
   * `dt` is a frame delta. `shown(i)` false drops craft `i`'s vapour.
   */
  update(
    eye: THREE.Vector3,
    dt: number,
    look: EditionWingTrails,
    speedFx: number,
    shown: boolean | ((craft: number) => boolean),
    /**
     * 0..1, how much of the half-width inset to apply (DEV-864). The player's
     * SEAT view passes 0: from the cockpit the only part of the ribbon the sill
     * leaves visible is its head at the tip, and an inboard head is hidden.
     */
    inset?: number,
  ): void
  /** Forget one craft's vapour — a restart or a crash reset — or every craft's. */
  clear(craft?: number): void
  dispose(): void
}

/**
 * Pull both tips toward each other, along the line between them, by `inset`
 * metres each. DEV-864 (Matt, 2026-10-08): the ribbon is centred on the tip, so
 * half its width hung off the wing; the inset is half the glow's width, which
 * puts the outer edge on the tip. Done in WORLD space on the two measured
 * points, so it needs no knowledge of the frame's axes or scale. A pair closer
 * than twice the inset collapses to its midpoint rather than crossing over.
 */
export const insetWingTips = (
  port: THREE.Vector3,
  starboard: THREE.Vector3,
  inset: number,
): void => {
  const span = port.distanceTo(starboard)
  if (!(inset > 0) || span < 1e-9) return
  const t = Math.min(inset, span * 0.5) / span
  const dx = (starboard.x - port.x) * t
  const dy = (starboard.y - port.y) * t
  const dz = (starboard.z - port.z) * t
  port.x += dx
  port.y += dy
  port.z += dz
  starboard.x -= dx
  starboard.y -= dy
  starboard.z -= dz
}

export const createCraftWingTrails = (
  craft: readonly WingTrailCraft[],
  name: string,
): CraftWingTrails => {
  const trails = createWingTrails(craft.length, name)
  // Off the sheet once: the terminal speeds are generated and never change.
  const fade = hoverJetWingTrailFade()
  // Volatile, valid only inside one `update` (trap 19). Two, so port and
  // starboard never share one.
  const port = new THREE.Vector3()
  const starboard = new THREE.Vector3()
  return {
    trails,
    update(eye, dt, look, speedFx, shown, inset = 1) {
      if (wingTrailScale(look, speedFx) === 0) {
        trails.clear()
      } else {
        for (let i = 0; i < craft.length; i++) {
          const c = craft[i] as WingTrailCraft
          if (!(typeof shown === 'boolean' ? shown : shown(i))) {
            trails.clear(i)
            continue
          }
          // The pose was just written (interpolated) and three has not composed
          // it yet; the matrix is stale until it is asked for (CLAUDE.md's
          // `grip.matrixWorld` trap, same shape).
          c.frame.updateWorldMatrix(true, false)
          port.copy(c.tips.port).applyMatrix4(c.frame.matrixWorld)
          starboard.copy(c.tips.starboard).applyMatrix4(c.frame.matrixWorld)
          insetWingTips(port, starboard, Math.max(0, look.startWidth) * 0.5 * inset)
          const strength = wingTrailStrength(bodyForwardSpeed(c.body), fade, look, speedFx)
          trails.emit(i, port, starboard, strength, dt, look)
          // The tint, read every frame like the rest of the look: sRGB off the
          // livery, linear into the vertex colours the renderer mixes in.
          const [r, g, b] = trailTint(c.livery, look.tint)
          trails.setTint(i, srgbToLinear(r), srgbToLinear(g), srgbToLinear(b))
        }
      }
      trails.draw(eye, look)
    },
    clear(i) {
      trails.clear(i)
    },
    dispose() {
      trails.dispose()
    },
  }
}
