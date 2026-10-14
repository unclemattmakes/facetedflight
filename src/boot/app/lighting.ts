// src/boot/app/lighting.ts — a level's light and air: the page's one sun,
// the level's lighting and sky, and the fog FF2 flies each mission under.
//
// Moved verbatim out of `boot/app.ts` (APP-SPLIT phase 1,
// `docs/plan/APP-SPLIT.md`), with `export` added and nothing else. Every
// function here takes what it touches as an argument, which is why it could
// leave the closure first.

import * as THREE from 'three'
import type { Level } from '@/content/level-schema'
import { TERRAIN } from '@/generated/constants.generated'
import { createSky, type Sky } from '@/render/sky'
import {
  createSkyshopProbe,
  marmosetSunIntensity,
  probeFromSkyRadiance,
} from '@/render/skyshop-ibl'
import { createUnityFog, ff2Fog, type UnityFog } from '@/render/unity-fog'
// DEV-509: no `./pins` here. The URL's switches arrive as ARGUMENTS, read by
// the callers, so the making-of site's world toys can light a scene with the
// game's own recipe without importing the boot (pins pulls in the loaders).
// `tests/unit/making-of-imports.test.ts` would fail a toy that reached pins.

/** Where the ambient comes from: `?ambient=sky` (DEV-022), read in `pins.ts`. */
export type AmbientSource = 'sky' | 'shipped'

/** The two fog switches `missionFog` obeys, read in `pins.ts`. */
export interface FogSwitches {
  /** `?fog=off` is false. */
  readonly fogEnabled: boolean
  /** `?fogsky=off` is false: 2016's single flat fog colour. */
  readonly fogTakesSkyColour: boolean
}

/**
 * The page's ONE sun, and its target, in the scene. DEV-363.
 *
 * Called once, before `shellChildren` is captured, so `teardownWorld` never
 * removes it and every world is lit — and shadowed — by the same light object.
 * `applyLighting` aims it per level; the frame loop swaps its direction between
 * the title and the mission. `tests/e2e/sun-switch.spec.ts` asks the frame
 * that there is exactly one directional light after a course switch (DEV-363).
 */
export const createSun = (scene: THREE.Scene): THREE.DirectionalLight => {
  const light = new THREE.DirectionalLight(0xffffff, 0)
  light.name = 'sun'
  scene.add(light)
  scene.add(light.target)
  return light
}

/**
 * Apply a mission's lighting to the scene.
 *
 * Every number here comes from the level JSON, which comes from the mission
 * scene — no invented sun any more. What that bought, on `int_01_hoverJet`:
 * the sun is **4 degrees above the horizon**, warm orange, and the fog is
 * exponential dusty rose. The placeholder was a white sun at 35 degrees. The
 * mission is lit like a sunset and was being rendered like noon.
 *
 * Two details that are easy to get wrong:
 *
 *  * **Unity light colour is already LINEAR.** It is not an sRGB byte triple,
 *    so it must not go through a second conversion. `setRGB(..., LinearSRGBColorSpace)`
 *    says that explicitly rather than relying on the default.
 *  * **A `DirectionalLight` shines from its position toward its target**, so
 *    the position is the NEGATED travel direction, pushed far enough out to sit
 *    beyond the world. Only the direction matters for a directional light.
 *
 * **It AIMS the sun; it does not build one** (DEV-363). There is one
 * `DirectionalLight` for the life of the page, made by `createSun` before the
 * shell is captured, so a course switch re-aims the light the shadow systems
 * already hold. It used to build a new light per call, and the shadow map and
 * the cockpit's near map were handed the boot one: after the first switch they
 * cast from a light no longer in the scene and the mission's own sun cast
 * nothing — every mission a player reached, since DEV-281 made the title the
 * boot world. A level with no sun HIDES the one light rather than removing it.
 */
export const applyLighting = (
  scene: THREE.Scene,
  level: Level,
  light: THREE.DirectionalLight,
  ambientSource: AmbientSource,
): THREE.DirectionalLight | null => {
  const lighting = level.lighting
  const sun = lighting.sun
  let sunLight: THREE.DirectionalLight | null = null
  light.visible = sun !== null && sun !== undefined
  if (sun) {
    // 2 pi, not 1. Marmoset's direct diffuse is `2.0 * dotNL * albedo *
    // lightColor` and three's is that over pi — see `marmosetSunIntensity`.
    // Without it the sun runs 6.3x too weak, which on a mission lit from 4
    // degrees means the mountains have no shading at all.
    // DEV-454: `colorLinear × intensity` is 2016's own product now, from the
    // extractor, so this is the plain multiply it always was.
    light.intensity = marmosetSunIntensity(sun.intensity)
    light.color.setRGB(
      sun.colorLinear[0],
      sun.colorLinear[1],
      sun.colorLinear[2],
      THREE.LinearSRGBColorSpace,
    )
    const [dx, dy, dz] = sun.direction
    light.position.set(-dx, -dy, -dz).multiplyScalar(10_000)
    light.target.position.set(0, 0, 0)
    sunLight = light
  }

  // ── The ambient ─────────────────────────────────────────────────────────
  //
  // NOT Unity's. `m_AmbientMode: 0` means Unity computed ambient from the
  // skybox, so `m_AmbientSkyColor` / `Equator` / `Ground` were inert — and it
  // would not have mattered anyway, because every lit surface in this game uses
  // a Marmoset Skyshop shader that reads NO Unity ambient at all. Its ambient
  // is nine spherical-harmonic coefficients baked onto `ibl_sky` and pushed as
  // shader globals, and those coefficients survived in the prefab.
  //
  // So this is not an approximation of 2016's ambient. It is 2016's ambient.
  //
  // ── `?ambient=sky` re-bakes it from the VISIBLE sky ────────────────────
  //
  // `ibl_sky` names `castle_BLUR.cubemap`; that file was overwritten in April
  // 2016 with Matt's own orange sunset; and the 27 baked floats match NEITHER,
  // being less warm than the file by a non-uniform 0.51/0.61/0.66. They were
  // baked from an earlier sky and never re-baked. So the shipped game is lit by
  // a near-neutral grey ambient under a warm sunset sky.
  //
  // The default reproduces that, because it is what ran. `?ambient=sky` lights
  // from the nine coefficients projected off the mission's actual skybox
  // instead — a deviation, offered so the two can be put side by side rather
  // than argued about. See docs/DEVIATIONS.md.
  const ibl = TERRAIN[level.environment as keyof typeof TERRAIN]?.ibl
  const skySh = level.lighting.sky?.available ? level.lighting.sky.sh : null
  if (ambientSource === 'sky' && skySh) {
    // Intensity from the SAME exposure the shipped ambient uses, so the switch
    // changes the sky's COLOUR and not how bright the world is.
    scene.add(probeFromSkyRadiance(skySh, ibl?.exposure.diffuse ?? 1))
    console.info('ambient: re-baked from the visible skybox (DEV-022)')
  } else if (ibl) {
    scene.add(createSkyshopProbe(ibl))
  }

  return sunLight
}

/**
 * Sky colour, and the fog it has to agree with.
 *
 * `fog.color` is extracted — `RenderSettings.m_FogColor`. The SKY is not: the
 * 2016 skybox is a third-party Marmoset cubemap that cannot ship (D26), so
 * there is nothing to extract until FF2 authors its own. Painting the
 * background with the fog colour is the one choice that cannot look wrong at
 * the horizon, because distant terrain fades to exactly the colour behind it.
 *
 * `scene.fog` stays null on purpose. three's two fogs cannot express what the
 * game runs — see `render/unity-fog.ts`.
 */
export const applySky = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  level: Level,
  smooth: boolean,
): Sky => {
  const sun = level.lighting.sun
  const sky = createSky(
    renderer,
    {
      // Straight down if a mission somehow has no light; the sky still renders.
      sunDirection: sun ? sun.direction : [0, -1, 0],
      sunColor: sun ? sun.colorLinear : [1, 1, 1],
      // The FALLBACK gradient's horizon, used only when the mission's skybox
      // could not be decoded. It is the fog colour so that gradient at least
      // meets the fog without a seam.
      horizonColor: [
        level.fog.color[0] as number,
        level.fog.color[1] as number,
        level.fog.color[2] as number,
      ],
      // The real thing: nine SH coefficients of the shipped skybox.
      skySh: level.lighting.sky?.available ? level.lighting.sky.sh : null,
    },
    // DEV-320: baked at the flag's value, so a smooth sky is not baked faceted first.
    { smooth },
  )
  if (!sky.usedExtractedSky) {
    console.info(
      `sky: no decoded skybox for ${level.id} (${level.lighting.sky?.reason ?? 'no sky data'}) — ` +
        'using the fog-derived gradient',
    )
  }
  // The background is GEOMETRY now, not a texture. A PMREM's sharpest mip is
  // 256 px a face, which blurs five thousand facets straight back into the
  // gradient they replaced; the dome is drawn first with depth testing off, so
  // it costs one call and occludes nothing. `scene.background` stays null.
  //
  // The prefiltered texture still does the LIGHTING job, where blurring is the
  // entire point of a prefilter rather than a loss.
  scene.add(sky.dome)
  scene.environment = sky.environment
  return sky
}

/**
 * Re-bake `sky` if `render.smoothSky` has moved since it was last baked.
 * DEV-320, wishlist #22a.
 *
 * `tuning.smooth` is the state, so on every frame the flag agrees this is one
 * comparison. A flip re-bakes the dome and re-prefilters its environment — a
 * few milliseconds, once. `retune` disposes the old texture, so if this dome
 * was the one lighting the scene the new one goes on in the same call.
 */
export const syncSmoothSky = (sky: Sky, smooth: boolean, scene: THREE.Scene): void => {
  if (sky.tuning.smooth === smooth) return
  const lit = scene.environment === sky.environment
  const environment = sky.retune({ smooth })
  if (lit) scene.environment = environment
}

export const missionFog = (fog: Level['fog'], level: Level, switches: FogSwitches): UnityFog => {
  // DEV-018 / DEV-031 / DEV-098: the fog FF2 runs, on every mission. Each keeps
  // its own MODE, START DISTANCE and COLOUR — only the amount, the plane and
  // which half of it is dense are ours. Applied HERE rather than in the
  // extractor, so `content/levels/*.json` keeps 2016's numbers and the deviation
  // is visible at the point it happens. See `ff2Fog` for the measurement that
  // chose the replacement, and for why it no longer asks which mission it is.
  const f = ff2Fog(fog)
  return createUnityFog({
    mode: f.mode,
    density: f.density,
    linearStart: f.linearStart,
    linearEnd: f.linearEnd,
    color: [f.color[0], f.color[1], f.color[2]],
    distanceFog: f.distanceFog && f.sceneFogEnabled,
    heightFog: f.heightFog,
    useRadialDistance: f.radial,
    height: f.height,
    heightDensity: f.heightDensity,
    startDistance: f.startDistance,
    // DEV-031, and now on every mission (DEV-098). It used to reach only the
    // three `ff2Fog` replaced, "because their fog was never the one Matt was
    // flying through" — which was true right up until the level select could
    // reach the other three worlds, and then alpine and desert were the ones he
    // was flying through, still murkiest at exactly the altitude of the course.
    heightFogInverted: (f as { inverted?: boolean }).inverted === true,
    // The sky the fog fades toward. Only when the mission has a decoded one —
    // the ten that do not keep the flat colour, which is 2016's answer and the
    // only one available without a sky to sample.
    skySh:
      switches.fogTakesSkyColour && level.lighting.sky?.available ? level.lighting.sky.sh : null,
    sunDirection: level.lighting.sun ? level.lighting.sun.direction : [0, -1, 0],
    sunColor: level.lighting.sun ? level.lighting.sun.colorLinear : [1, 1, 1],
    // `?fog=off`: see FOG_ENABLED in pins.ts. Last, so it wins; and BOTH flags, because
    // either one alone leaves the other half of Unity's global fog running.
    ...(switches.fogEnabled ? {} : { distanceFog: false, heightFog: false }),
  })
}
