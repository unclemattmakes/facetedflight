// src/game/ship-wings.ts — fetch the HoverJet's anti-grav wings and hang them
// on a hull. DEV-322.
//
// `render/hover-glow.ts` has the part, its frame and its materials; this is
// the one place its GLB is named and fetched, so its consumers (the chase
// view, the AI racers, the ghosts, and since DEV-546 the level select's parked
// jet) cannot drift apart about it.
//
// ── A failed fetch is a missing PART, not a failed MISSION ───────────────
//
// `hoverjet-wings.glb` is new, and it reaches players only after somebody runs
// `pnpm assets:push` (hard rule 7: it is bought geometry and never enters git).
// A deploy of this code that lands before the push must still fly, so a fetch
// that fails is warned about — loudly, once per load, naming the file — and the
// hull flies without its wing. Every other mesh the ship needs still throws: a
// hull that did not load IS a broken mission, and this does not change that.

import type * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { attachHoverGlow, type HoverGlow, type HoverGlowOptions } from '@/render/hover-glow'
import { loadMesh } from '@/render/load-mesh'

/** The wing GLB, converted from 2016's prefab by `tools/assets/convert-wings.mjs`. */
export const SHIP_MESH_WINGS = 'assets/ships/hoverjet-wings.glb'

/**
 * Fetch the wing and hang it on `art`, a loaded `SHIP_MESH_EXTERIOR` object.
 *
 * `art`'s own transform does not matter here — the wing is in the hull GLB's
 * frame and is added at identity — so, unlike DEV-310's version, this may be
 * called before or after the three `ART_*` lines.
 */
export const attachShipWings = async (
  art: THREE.Object3D,
  options: HoverGlowOptions = {},
): Promise<HoverGlow> => {
  const wings = await loadMesh(assetUrl(SHIP_MESH_WINGS)).catch((err: unknown) => {
    console.warn(
      `[ship-wings] ${SHIP_MESH_WINGS} did not load, so this hull flies without its anti-grav wing (DEV-322): ${(err as Error)?.message ?? String(err)}`,
    )
    return null
  })
  return attachHoverGlow(art, wings?.object ?? null, options)
}
