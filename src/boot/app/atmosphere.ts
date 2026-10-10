// src/boot/app/atmosphere.ts: the light and air every world is drawn through,
// out of `bootApp`. APP-SPLIT phase 4 (`docs/plan/APP-SPLIT.md` §1b, "Atmosphere").
//
// The sun's shadow (V3, DEV-086) and the cockpit's own (DEV-323), the clouds'
// shadows (DEV-585), the near and far terms (DEV-582, DEV-116), the islands in
// the sea (DEV-583), the sky's visibility (DEV-333), what the sun maps were
// baked from (DEV-476), and the three doors a material comes through
// (`applyAtmosphere`, `applyGroundAtmosphere`, `applyPropAtmosphere`). The
// mission FOG and its one door (`wiredMissionFog`, DEV-552) stay in the
// closure: `switchMission` replaces the fog. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns, and the returned object.

import type * as THREE from 'three'
import type { Air } from '@/game/air'
import type { EditionState } from '@/game/edition'
import type { Flight } from '@/game/flight'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import { createCloudShadow } from '@/render/cloud-shadow'
import { createCockpitSelfShadow } from '@/render/cockpit-self-shadow'
import { createFarShadow } from '@/render/far-shadow'
import type { Horizon } from '@/render/horizon'
import { createNearShadow } from '@/render/near-shadow'
import type { Renderer } from '@/render/renderer'
import type { SceneTint } from '@/render/scene-tint'
import { cockpitOf, createSeaReflection } from '@/render/sea-reflection'
import { createSunShadows, type SunShadows } from '@/render/shadows'
import type { Sky } from '@/render/sky'
import { createSkyVisibility } from '@/render/sky-visibility'
import type { UnityFog } from '@/render/unity-fog'
import type { Vignette } from '@/render/vignette'
import type { SunHalo } from '@/render/vr-halo'
import type { CanopyField } from '@/sim/props/canopy'
import type { createSun } from './lighting'

/** What `createAtmosphere` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface AtmosphereCtx {
  readonly air: Air
  readonly editionState: EditionState
  readonly flight: Flight | null
  readonly fog: UnityFog
  readonly horizon: Horizon
  readonly liveSky: Sky | null
  readonly pageSun: ReturnType<typeof createSun>
  readonly render: Renderer
  readonly sceneTint: SceneTint
  readonly sunHalo: SunHalo
  readonly vignette: Vignette
}

export const createAtmosphere = (ctx: AtmosphereCtx) => {
  // ── Anniversary systems: the sun's shadow ────────────────────────────────
  //
  // V3 / DEV-086, and here rather than in the boot block for the same reason the
  // haze is: the light is the LEVEL's and the level lands later. It takes
  // `pageSun` — the one directional light for the life of the page, which
  // `applyLighting` re-aims per level (DEV-363: it used to take the light the
  // BOOT world built, and every course switch built another) — and never
  // moves it: the box is an ASYMMETRIC orthographic frustum placed in the
  // light's own view, so the loop below can go on rewriting the sun's direction
  // between the title screen and the mission without two owners of one
  // transform. `render/shadows.ts` says why at length.
  //
  // Empty until `attach` below is handed the world. On Classic, and at quality
  // `low`, it never turns on and not one object in the scene is given a flag.
  const sunShadows: SunShadows = createSunShadows(
    ctx.render.renderer,
    ctx.pageSun,
    ctx.editionState,
  )
  // DEV-323: the cockpit's shadow on ITSELF, a second map over the ship alone.
  // Beside the sun's because it composes with it twice: it is off wherever the
  // sun's map is (`cockpitSelfShadowEnabled`), and it reads the sun's live fit
  // to skip the ship's own occluders on the shell. Nothing is built until a
  // preset asks — Classic constructs no target, no pass and no patch.
  const cockpitSelfShadow = createCockpitSelfShadow(
    ctx.render.renderer,
    // DEV-363: the page's sun, as `sunShadows` above is handed it. Both were
    // handed the BOOT world's light, which the first course switch removed.
    ctx.pageSun,
    ctx.editionState,
    () => sunShadows.fit,
  )
  // The far-field term (DEV-116): terrain shadow at every distance, from one
  // texture swept off the height field when the world attaches below. It
  // reaches every lit material through the same walks the fog takes, so
  // `applyAtmosphere` is the one door — a material the fog reaches and this
  // does not would be lit through a mountain at 800 m and shadowed at 600.
  const cloudShadow = createCloudShadow(ctx.editionState) // DEV-585: the clouds' shadows, inside the term below
  const nearShadow = createNearShadow(
    ctx.render.renderer,
    ctx.pageSun,
    ctx.editionState,
    () => sunShadows.fit,
  ) // DEV-582
  const farShadow = createFarShadow(ctx.editionState, cloudShadow.uniforms, nearShadow.uniforms)
  // DEV-583: the islands in the sea, flat ultra only; `excluded` is what it must never draw.
  const seaReflection = createSeaReflection({
    renderer: ctx.render.renderer,
    editionState: ctx.editionState,
    excluded: () => [
      ctx.render.rig,
      ctx.vignette.object,
      ctx.horizon.object,
      ctx.sceneTint.object,
      ctx.air.object,
      ctx.liveSky?.dome,
      ctx.sunHalo.object,
      ctx.flight && cockpitOf(ctx.flight.object),
    ],
    eyeMoved: (camera) => ctx.fog.update(camera),
  })
  // DEV-333: the terrain hiding the sky, and the lit terrain's bounce in its
  // place. The LAND only, through the ground door below; baked from the same
  // sun sweep when the world attaches, and only while the preset wants it.
  const skyVisibility = createSkyVisibility(ctx.editionState)
  // ── DEV-476: what the two sun maps were baked FROM, for a re-bake ───────
  // A player course's sun moves in the editor, and both maps are per sun
  // (`sim/terrain/sun-height.ts`). Everything else they read is the world's,
  // so the world build keeps it here (`buildWorld`, beside the bake) and the
  // editor's light block re-bakes against it. `land` keys it to its world.
  let sunBakeInputs: {
    readonly land: LoadedTerrain
    readonly jitterMetres: number
    readonly canopy: CanopyField | null
  } | null = null
  // ── end DEV-476 ─────────────────────────────────────────────────────────
  const applyAtmosphere = (m: THREE.Material): void => {
    ctx.fog.applyTo(m)
    farShadow.applyTo(m)
  }
  /**
   * The same door for the LAND's chunk material only (DEV-133): the far-field
   * term judges the ground by its texel's swept depth rather than by the
   * fragment's own height, because the drawn mesh is jittered and coarsened
   * in ways the field is not. The sea, the props, the racers and the ship all
   * have a height of their own to compare and go through `applyAtmosphere`.
   */
  const applyGroundAtmosphere = (m: THREE.Material): void => {
    ctx.fog.applyTo(m)
    farShadow.applyTo(m, 'ground')
    skyVisibility.applyTo(m)
  }
  /**
   * And the SCATTER's door (DEV-296): the same sun term every object takes,
   * plus the canopy's, ramped out as a prop's own fragments rise past the
   * ceiling over them.
   *
   * A third door rather than a flag on the second, for the reason the second
   * exists: the role is a DEFINE and three folds defines into the program
   * cache key, so the props compile their own program and the sea, the racers
   * and the ship keep theirs. A prop is the only thing in the frame that
   * stands IN the forest it is being shaded by.
   */
  const applyPropAtmosphere = (m: THREE.Material): void => {
    ctx.fog.applyTo(m)
    farShadow.applyTo(m, 'prop')
  }
  return {
    applyAtmosphere,
    farShadow,
    skyVisibility,
    sunShadows,
    applyGroundAtmosphere,
    applyPropAtmosphere,
    seaReflection,
    cloudShadow,
    cockpitSelfShadow,
    nearShadow,
    get sunBakeInputs() {
      return sunBakeInputs
    },
    set sunBakeInputs(v: {
      readonly land: LoadedTerrain
      readonly jitterMetres: number
      readonly canopy: CanopyField | null
    } | null) {
      sunBakeInputs = v
    },
  }
}
