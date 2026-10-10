// src/game/air.ts — the preset half of the near-field air. DEV-080, S1.
//
// `render/motes.ts` is the field: geometry, a shader, and a pool that respawns
// ahead of you. This is the twenty lines that read the Anniversary preset and
// the player's comfort slider and turn them into the numbers that field takes —
// the same split `game/particle-fx.ts` keeps from `render/particles.ts`, and
// for the same reason: the renderer should not know what an edition is.
//
// ── The slider is not a volume control on a nice effect ──────────────────
//
// ANNIVERSARY.md §2.6. Everything that creates a sense of speed does it by
// increasing optic flow, and optic flow IS vection — the thing the comfort
// block exists to limit. Squadrons found near-field dust HELPED, by giving the
// eye a frame of reference; a dense field of fast streaks across the whole
// visual field is also the textbook way to make someone ill. So `speedFx`
// multiplies the two terms that decide how much of the visual field is moving —
// how many motes there are, and how strongly they are drawn — and at `off` this
// draws nothing at all. It is not styling. It is the reason the feature is
// allowed to exist.
//
// Classic draws nothing either, by the same arithmetic and a different route:
// the flag is off, so there is no spec, so there is no pool.

import type * as THREE from 'three'
import type { Edition } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { createMoteField, type MoteField, type MoteSpec, type Vec3Like } from '@/render/motes'

/**
 * The preset and the slider, resolved to what to draw.
 *
 * `null` is "draw nothing", and it has three causes that are all the same
 * answer: Classic, the feature switched off in the preset, or a player who has
 * put the speed effects slider at `off`.
 */
export const moteSpecFor = (edition: Edition, speedFx: number): MoteSpec | null => {
  const m = edition.fx.motes
  const k = Math.min(1, Math.max(0, speedFx))
  if (!m.enabled || k <= 0) return null
  const count = Math.floor(m.count * k)
  if (count <= 0 || !(m.alpha > 0)) return null
  return {
    count,
    innerRadius: m.innerRadius,
    outerRadius: m.outerRadius,
    size: m.size,
    stretchSeconds: m.stretchSeconds,
    // Both terms, not one: half the motes at half the alpha is a quarter of the
    // moving pixels, which is what `light` has to mean to be worth having.
    alpha: m.alpha * k,
    minSpeed: m.minSpeed,
    fullSpeed: m.fullSpeed,
    aheadBias: m.aheadBias,
    colorLight: m.colorLight,
    colorDark: m.colorDark,
  }
}

export interface Air {
  readonly object: THREE.Object3D
  /** Motes drawn on the last frame. Zero on Classic, forever. */
  readonly active: number
  /** One frame. `velocity` null — hangar, title, pause — draws nothing. */
  update(camera: THREE.Camera, velocity: Vec3Like | null): void
  dispose(): void
}

/**
 * Build the field and keep it on the live preset.
 *
 * Subscribes rather than reading `current` every frame because the pool is
 * allocated to a size: a flip is a re-spec, not a re-read. The unsubscribe goes
 * with `dispose`, so a field that is thrown away stops listening.
 */
export const createAir = (edition: EditionState, seed?: number): Air => {
  const field: MoteField = createMoteField(
    moteSpecFor(edition.current, edition.speedFx),
    seed === undefined ? {} : { seed },
  )
  const unsubscribe = edition.subscribe(() =>
    field.setSpec(moteSpecFor(edition.current, edition.speedFx)),
  )
  return {
    object: field.object,
    get active() {
      return field.active
    },
    update(camera, velocity) {
      field.update(camera, velocity)
    },
    dispose() {
      unsubscribe()
      field.dispose()
    },
  }
}
