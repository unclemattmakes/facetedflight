// src/render/hangar-light.ts — the level-select room, lit as 2016 lit it (DEV-437).
//
// Matt, 2026-09-26, on DEV-430's room: *"light to match 2016 if you can."* The
// room had come across with the PORT's light — a blue-white point lamp on the
// lift's axis and a strong blue ambient in the menu scene — so 2016's tan deck
// read grey-blue and the shaft overhead read white. `Environment_Hangar.prefab`
// carries its own three, and the generated sheet reads them (`PROPS.hangar`,
// `tools/extract/constants.mjs` §13f):
//
//   light_ship   a SPOT 13 m straight down over the jet, white, 1.75, range
//                14.8 m, 72-degree cone. The deck's light.
//   light_env    a DIRECTIONAL key, 57 degrees up, warm white (1, 0.98, 0.93),
//                0.63. Everything that faces up.
//   ibl_sky      a Skyshop sky: Simonet's nine SH coefficients at the same
//                139-degree yaw, at 2.01 x 0.14 = 0.2814 diffuse. The ambient —
//                every surface in the room is a Marmoset shader, and a Marmoset
//                shader takes its ambient from this and never from Unity's.
//
// Each goes through the port's own conversions: the sun's
// `marmosetSunIntensity` (Marmoset's direct term is `2 * N.L * albedo * light`,
// three's is that over pi) and `skyshop-ibl.ts`'s exact SH transform — and one
// the port had not needed before:
//
// ── Unity 5.4 linearises a light's colour AND intensity together ───────────
//
// In a Linear project before Unity 5.6, the colour a shader receives for a
// light is `GammaToLinearSpace(colour x intensity)`: the product in gamma
// space, linearised whole (`unityLightLinear`). The port had multiplied the
// linear colour by the intensity instead, which is the rule 5.6's
// `lightsUseLinearIntensity` switched TO — and 2016 is 5.4.1p4. For this room
// that is the key at 0.57 of what the port drew and the spot at 1.96 of it.
// Measured before it was believed (DEV-437's addendum): with the key taken out
// the floor falls from 156 to 66 on its green channel, the probe is worth 9 of
// it, and the key's share that lands f0030's floor and walls is 0.40–0.50 of
// the port's old one, against this rule's 0.57 and the old rule's 1.0. The
// room's floor and walls then read within 9 levels of f0030 on Anniversary,
// where they read 30–40 over. The MISSIONS' suns still multiply; the addendum
// says what that would move.
//
// ── The spot's falloff: Unity's, fitted, and the one number to argue with ─
//
// Unity 5's forward spot attenuation is not three's. Unity looks a lamp up in
// a texture indexed by (d / range)^2, `1 / (1 + 25 (d / r)^2)`, and multiplies
// by the spot cookie. three's is physical: `1 / d^decay`, times an optional
// window that reaches zero at `distance`. The title's logo key (`render/title.ts`)
// took `decay 0` and `distance = range`, which is three's window alone — about
// 4.8 x Unity's curve at the deck, where this light does its work. Here the
// curve is FITTED instead: for d much beyond r / 5 (2.97 m here; the deck is
// 12.4 m off) Unity's term is `(r^2 / 25) / d^2`, which is three's `decay 2`
// with the intensity scaled by `r^2 / 25`. `hangar-light.test.ts` measures the
// fit against Unity's own formula across everything the cone reaches, from the
// jet's canopy to the floor: within 9 %.
//
// The cone's EDGE is the other approximation. Unity draws a spot through its
// default cookie, a soft radial gradient (`RenderSettings.m_SpotCookie`, fileID
// 10001, Unity's own resource, which the project does not contain). three's
// nearest shape is `penumbra 1`, a smoothstep across the whole cone.
//
// ── What does NOT cross ──────────────────────────────────────────────────
//
//   - Marmoset's own PREFILTER. The reflected sky crosses (DEV-439, "The
//     reflective half" below) and three blurs it with its own PMREM, a GGX
//     lobe, where Skyshop baked a Phong one into the cube's mips. And light_env's
//     SHADOWS cross too (DEV-440, below) — HARD in 2016, not soft, as this line
//     said until DEV-440 read `m_Shadows.m_Type`.
//   - Unity's flat ambient (`RenderSettings`, mode 3): no Marmoset surface reads
//     it. The sheet records it, and nothing here uses it.
//   - light_env's culling mask, which drops layer 8 (`Vehicles`). No live
//     renderer in the room is on layer 8, so it excluded nothing, and three has
//     no per-light object mask to port it to anyway (a three light's `layers`
//     decide whether the CAMERA collects it — DEV-043 — which is not this).
//
// ── Present from the first frame, dark until the art lands ────────────────
//
// Every light here is BUILT with the room and parented to it at intensity 0.
// A light's COUNT is in every lit program's cache key (CLAUDE.md), so a light
// that arrived with the GLBs would recompile every lit material in the room
// mid-walk — `menu-light-compile.spec.ts`'s twin, and its gate. A light at
// zero costs nothing to add nothing, which is DEV-188's rule for the table
// lamps too. When the art lands `setOn(true)` turns 2016's three up; the caller
// turns the port's lamp and ambient down.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import { PROPS } from '@/generated/constants.generated'
import { fitSunShadow, type ShadowFit, shadowBiasFor, shadowsEnabled } from './shadows'
import { createSkyshopProbe, marmosetShLookup, marmosetSunIntensity } from './skyshop-ibl'
import { marmosetSpecularF0, shininessToRoughness, THREE_DIELECTRIC_F0 } from './terrain-mesh'
import { flipQuaternion } from './unity-space'

type V3 = readonly [number, number, number]
type Q4 = readonly [number, number, number, number]

/** The sheet's reading of 2016's room light: `PROPS.hangar`. */
export interface HangarLightSheet {
  readonly roomAnchor: V3
  readonly lights: {
    readonly ship: UnityLightRecord
    readonly env: UnityLightRecord
  }
  readonly ibl: {
    readonly sh: readonly number[]
    readonly rotationUnity: Q4
    readonly exposure: { readonly diffuse: number; readonly specular: number }
  }
  /** The room's two Marmoset SPECULAR materials (DEV-439, `tools/extract/constants.mjs` §13h). */
  readonly specular: {
    readonly deck: ReflectiveRecord
    readonly shaft: ReflectiveRecord
  }
}

/** One 2016 material of the Specular IBL family, as the sheet reads it. */
export interface ReflectiveRecord {
  readonly material: string
  readonly shader: string
  readonly shininess: number
  readonly specInt: number
  readonly fresnel: number
  readonly specColorSrgb: V3
}

export interface UnityLightRecord {
  readonly type: string
  readonly live: boolean
  readonly colorSrgb: V3
  readonly intensity: number
  readonly range: number
  readonly spotAngleDeg: number
  readonly positionUnity: V3
  readonly rotationUnity: Q4
  /** Unity's `m_Shadows`, scene overrides applied: `type` 0 none, 1 hard, 2 soft. */
  readonly shadows?: { readonly strength: number; readonly type: number }
}

/** The generated sheet's block, typed. */
export const HANGAR_LIGHT_SHEET = PROPS.hangar as unknown as HangarLightSheet

/**
 * The spot's cone edge, three's `penumbra`: 1 is a smoothstep across the whole
 * cone, the nearest three shape to Unity's default soft cookie. A shape, not a
 * measurement — see the header.
 */
export const HANGAR_SPOT_PENUMBRA = 1

/** Unity's attenuation texture: `1 / (1 + 25 x)` at `x = (d / range)^2`. */
export const unitySpotAttenuation = (distance: number, range: number): number =>
  1 / (1 + (25 * distance * distance) / (range * range))

/**
 * three's `SpotLight.intensity` for a Unity spot whose LINEAR light is
 * `intensity` (see `unityLightLinear`) and whose range is `range`, under
 * `decay 2` and no cutoff: Marmoset's direct scale times the far-field of
 * Unity's curve, `r^2 / 25`.
 */
export const hangarSpotIntensity = (intensity: number, range: number): number =>
  marmosetSunIntensity(intensity) * ((range * range) / 25)

/**
 * Unity's `GammaToLinearSpace`: the sRGB curve up to 1, and `x^2.2` above it,
 * where the sRGB curve is not defined. At 0.5 it is 0.214041, the number Unity
 * ships as a Linear project's `unity_ColorSpaceGrey`.
 */
export const unityGammaToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : v < 1 ? ((v + 0.055) / 1.055) ** 2.4 : v ** 2.2

/**
 * A 2016 light's LINEAR colour, as Unity 5.4 hands it to a shader in a Linear
 * project: colour times intensity taken in GAMMA space, then linearised as a
 * whole — `GammaToLinearSpace(colour x intensity)`. Unity 5.6 added
 * `GraphicsSettings.lightsUseLinearIntensity` to change exactly this, and left
 * it off by default for the projects that were built on it; 2016's is 5.4.1p4.
 * So an intensity under 1 is DIMMER than the product of the linear colour and
 * the intensity (the key's 0.63 lands at 0.57 of it) and one over 1 is
 * brighter (the spot's 1.75 at 1.96). DEV-437's first cut multiplied, and the
 * room read 30–40 levels over f0030; see its addendum.
 */
export const unityLightLinear = (colorSrgb: V3, intensity: number): V3 => [
  unityGammaToLinear(colorSrgb[0] * intensity),
  unityGammaToLinear(colorSrgb[1] * intensity),
  unityGammaToLinear(colorSrgb[2] * intensity),
]

/** Set a three light to a Unity light's linear colour: the hue on `color`, the peak returned. */
const setLinearColour = (light: THREE.Light, linear: V3): number => {
  const peak = Math.max(linear[0], linear[1], linear[2])
  light.color.setRGB(
    linear[0] / peak,
    linear[1] / peak,
    linear[2] / peak,
    THREE.LinearSRGBColorSpace,
  )
  return peak
}

/** A Unity world point, into the ROOM frame `hangar-room.glb` is written in. */
export const unityToRoom = (p: V3, anchor: V3): THREE.Vector3 =>
  new THREE.Vector3(p[0] - anchor[0], p[1] - anchor[1], -(p[2] - anchor[2]))

/** The way a Unity light shines — its rotation's +z — as a three-space unit vector. */
export const unityLightForward = (q: Q4): THREE.Vector3 => {
  // Unity's quaternion on a Unity vector is the same algebra as three's, so
  // three's rotate is the right tool; the mirror is the z negation after.
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]))
  return new THREE.Vector3(f.x, f.y, -f.z).normalize()
}

/**
 * The Skyshop probe's `rotationUnity` for a room frame turned by `world`.
 *
 * `skyshopCoefficients` maps a three direction into sky space as `R^T M`, with
 * M the z mirror, assuming three's world IS Unity's mirrored. Here it is that
 * turned again by the room frame's world rotation W, so the map is `R^T M W^T`,
 * which is `(M W M R)^T M` — and `M W M` is W's quaternion with x and y
 * negated, the same mirror rule every Unity rotation takes into three.
 */
export const probeRotationFor = (sky: Q4, world: THREE.Quaternion): Q4 => {
  const r = flipQuaternion(new THREE.Quaternion(), world).multiply(
    new THREE.Quaternion(sky[0], sky[1], sky[2], sky[3]),
  )
  return [r.x, r.y, r.z, r.w]
}

export interface HangarLight {
  /** In the ROOM frame: the spot, its target, the key and its target. The probe is scene-global. */
  readonly group: THREE.Group
  readonly spot: THREE.SpotLight
  readonly key: THREE.DirectionalLight
  readonly probe: THREE.LightProbe
  /** Turn 2016's light up (or back down). Reads the room frame's world rotation for the probe. */
  setOn(on: boolean): void
  dispose(): void
}

/**
 * The rig's three lights, BARE: one spot, one directional, one probe, all at 0.
 *
 * `render/hangar.ts` builds exactly these three by hand, synchronously with the
 * room, because its hook imports `hangar-art.ts` lazily (one block, no new
 * import) and a light that arrived with that import would arrive after the
 * first frame had compiled the room's programs. The TYPES are all a program
 * key sees; `createHangarLight` fills in the rest, and refuses a rig that is
 * not these three.
 */
export const bareHangarLightRig = (): THREE.Group => {
  const rig = new THREE.Group()
  rig.add(new THREE.SpotLight(0xffffff, 0))
  rig.add(new THREE.DirectionalLight(0xffffff, 0))
  rig.add(new THREE.LightProbe(undefined, 0))
  return rig
}

/**
 * Configure 2016's three lights, dark, in the room frame — on `rig` if the
 * caller built one at construction (`render/hangar.ts` does), or on a new one.
 * The caller puts `group` under the same matrix as the room art (`roomMatrix`),
 * which `createHangarArt` does when the art lands.
 */
export const createHangarLight = (
  rig: THREE.Group = bareHangarLightRig(),
  sheet: HangarLightSheet = HANGAR_LIGHT_SHEET,
): HangarLight => {
  const group = rig
  group.name = 'hangar-2016-light'
  const { ship, env } = sheet.lights
  if (ship.type !== 'spot' || env.type !== 'directional' || !ship.live || !env.live) {
    throw new Error(
      `hangar-light: the sheet's lights are not 2016's spot and key (${ship.type}, ${env.type})`,
    )
  }
  const only = <T extends THREE.Light>(test: (l: THREE.Object3D) => boolean, what: string): T => {
    const hits = group.children.filter(test)
    if (hits.length !== 1) {
      throw new Error(`hangar-light: the rig holds ${hits.length} ${what}, not one`)
    }
    return hits[0] as T
  }

  const spot = only<THREE.SpotLight>((l) => (l as THREE.SpotLight).isSpotLight === true, 'spots')
  spot.name = 'hangar-2016-spot'
  const spotPeak = setLinearColour(spot, unityLightLinear(ship.colorSrgb, ship.intensity))
  spot.angle = ((ship.spotAngleDeg / 2) * Math.PI) / 180
  spot.penumbra = HANGAR_SPOT_PENUMBRA
  spot.decay = 2
  spot.distance = 0
  spot.intensity = 0
  spot.position.copy(unityToRoom(ship.positionUnity, sheet.roomAnchor))
  spot.target.position
    .copy(spot.position)
    .addScaledVector(unityLightForward(ship.rotationUnity), ship.range)
  group.add(spot.target)

  const key = only<THREE.DirectionalLight>(
    (l) => (l as THREE.DirectionalLight).isDirectionalLight === true,
    'directional lights',
  )
  key.name = 'hangar-2016-key'
  const keyPeak = setLinearColour(key, unityLightLinear(env.colorSrgb, env.intensity))
  key.intensity = 0
  // A directional light is a direction: the target sits on the room's floor
  // centre and the light 20 m back up its beam.
  key.target.position.set(0, 0, 0)
  key.position.copy(unityLightForward(env.rotationUnity)).multiplyScalar(-20)
  group.add(key.target)

  // The probe gets its coefficients on `setOn`, when the room frame's world
  // rotation is known; until then an empty SH at intensity 0.
  const probe = only<THREE.LightProbe>(
    (l) => (l as THREE.LightProbe).isLightProbe === true,
    'light probes',
  )
  probe.name = 'hangar-2016-ibl'
  probe.intensity = 0

  // Unity 5.4's light, linearised whole (`unityLightLinear`); the probe is a
  // Skyshop uniform, not a Unity light, and takes its exposure as it stands.
  const on = {
    spot: hangarSpotIntensity(spotPeak, ship.range),
    key: marmosetSunIntensity(keyPeak),
    probe: sheet.ibl.exposure.diffuse,
  }

  return {
    group,
    spot,
    key,
    probe,
    setOn(lit: boolean) {
      if (lit) {
        group.updateWorldMatrix(true, false)
        const world = group.getWorldQuaternion(new THREE.Quaternion())
        const built = createSkyshopProbe({
          sh: sheet.ibl.sh,
          rotationUnity: probeRotationFor(sheet.ibl.rotationUnity, world),
          exposure: sheet.ibl.exposure,
        })
        probe.sh.copy(built.sh)
        built.dispose()
      }
      spot.intensity = lit ? on.spot : 0
      key.intensity = lit ? on.key : 0
      probe.intensity = lit ? on.probe : 0
    },
    dispose() {
      spot.dispose()
      key.dispose()
      probe.dispose()
    },
  }
}

// ══ The reflective half (DEV-439) ═══════════════════════════════════════════
//
// Matt, 2026-09-26: *"port the ambient."* A Skyshop sky lights a Marmoset
// surface twice: a DIFFUSE half, the nine SH coefficients the probe above
// carries, and a SPECULAR half, a prefiltered cubemap reflected by the two
// materials authored against the Specular IBL family — the lift's deck
// (`lambert1`) and the shaft (`ent_elevatorShaft_pwn_Mat`). Everything else in
// the room is Diffuse IBL and takes no reflection. The deck's tan in f0030 is
// that reflection: its albedo is neutral grey and the spot above it is white.
// Since DEV-561 only the deck (and the parked jet, DEV-531) wears it: the shaft
// is baked as the launch's is, on Matt's ask that the two shafts match, so
// `specular.shaft` is read by the sheet and drawn by nothing.
//
// ── The reflected sky: the nine coefficients, evaluated as radiance ─────
//
// 2016 reflected `castle_SPEC.cubemap`, Marmoset Skyshop's example sky from a
// bought package. DEV-899 (Matt, 2026-10-10: "Drop skyshop.") stopped shipping
// that picture: the game never requests it. The room reflects the probe's own
// nine coefficients instead, Skyshop's projection of that same sky, a
// measurement of it and ours to ship, evaluated as radiance in every direction
// (`marmosetShLookup`, the oracle `skyshop-ibl.ts` already holds). Nine
// coefficients hold the sky's colour by direction and none of its picture, and
// they sit at Skyshop's own scale for its SH, which is 1.43 x the cube's mean:
// the reflection reads brighter and softer than 2016's. It is written before
// the sky's specular exposure, which is the material's `envMapIntensity`, and
// three prefilters it itself (a `PMREM`, on first use). The before and after
// against f0030 are on the record in DEVIATIONS (DEV-899).
//
// ── Three's own lighting, the port's own conversions ─────────────────────
//
// The materials are `MeshPhysicalMaterial` with an `envMap`, and the numbers go
// through `render/terrain-mesh.ts`'s bridge — `marmosetSpecularF0` into
// `specularColor`, `shininessToRoughness` — exactly as the terrain's do. And
// `skyshop-ibl.ts`'s `useSkyshopLightingModel` has already zeroed three's
// env-map IRRADIANCE for every material in the app, so the env map adds the
// specular half and nothing else: the probe stays the only diffuse ambient,
// as Skyshop splits them.
//
// ── Built with the room, in the room's frame ─────────────────────────────
//
// `render/hangar.ts`'s block builds the texture EMPTY and the one material
// class with it, and draws that material from the room's first frame, so the
// program — `envMap` is in three's cache key, and so is the prefiltered map's
// size — compiles with the room's others and not when the art lands.
// `fillReflectiveSky` writes the sky into it in the
// ROOM frame, and the materials turn it to the room's world yaw through
// `envMapRotation`, a uniform.

/** Three's equirectangular direction for texel (i, j) of a w x h map — `equirectUv`, inverted. */
export const equirectDirection = (i: number, j: number, w: number, h: number): THREE.Vector3 => {
  const phi = ((i + 0.5) / w - 0.5) * 2 * Math.PI
  const theta = ((j + 0.5) / h - 0.5) * Math.PI
  return new THREE.Vector3(
    Math.cos(theta) * Math.cos(phi),
    Math.sin(theta),
    Math.cos(theta) * Math.sin(phi),
  )
}

/** A half-float RGBA texture's own image, checked. */
const halfImage = (texture: THREE.DataTexture) => {
  const { width, height, data } = texture.image as {
    width: number
    height: number
    data: Uint16Array
  }
  if (!(data instanceof Uint16Array) || data.length !== width * height * 4) {
    throw new Error('hangar-light: the reflective sky is not a half-float RGBA texture')
  }
  return { width, height, data }
}

const readyEquirect = (texture: THREE.DataTexture): void => {
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.LinearSRGBColorSpace
  texture.needsUpdate = true
}

/** `R^T`: a Unity-space direction in the room frame into the sky's own space. */
const skyLookup = (sheet: HangarLightSheet): THREE.Quaternion => {
  const [qx, qy, qz, qw] = probeRotationFor(sheet.ibl.rotationUnity, new THREE.Quaternion())
  return new THREE.Quaternion(qx, qy, qz, qw).invert()
}

/**
 * The FALLBACK sky's radiance toward `dir`, a direction in the ROOM frame:
 * 2016's nine coefficients, looked up the way the probe's are turned (`R^T M`,
 * the room frame unrotated). Before the specular exposure, which is the
 * material's `envMapIntensity`.
 */
export const reflectiveSkyRadiance = (
  dir: THREE.Vector3,
  sheet: HangarLightSheet = HANGAR_LIGHT_SHEET,
  toSky: THREE.Quaternion = skyLookup(sheet),
): [number, number, number] => {
  const sky = new THREE.Vector3(dir.x, dir.y, -dir.z).normalize().applyQuaternion(toSky)
  return marmosetShLookup(sheet.ibl.sh, [sky.x, sky.y, sky.z])
}

/**
 * Write the FALLBACK reflected sky into `texture` (a half-float RGBA equirect),
 * in the ROOM frame: the nine coefficients, which hold the sky's colour by
 * direction and none of its picture. What the room reflects.
 */
export const fillReflectiveSky = (
  texture: THREE.DataTexture,
  sheet: HangarLightSheet = HANGAR_LIGHT_SHEET,
): void => {
  const { width, height, data } = halfImage(texture)
  const toSky = skyLookup(sheet)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const [r, g, b] = reflectiveSkyRadiance(equirectDirection(i, j, width, height), sheet, toSky)
      const k = (j * width + i) * 4
      data[k] = THREE.DataUtils.toHalfFloat(r)
      data[k + 1] = THREE.DataUtils.toHalfFloat(g)
      data[k + 2] = THREE.DataUtils.toHalfFloat(b)
      data[k + 3] = THREE.DataUtils.toHalfFloat(1)
    }
  }
  readyEquirect(texture)
}

/**
 * Configure a reflective material for one of 2016's Specular IBL materials: F0
 * and roughness through the terrain's bridge, metalness 0, and F90 at 2016's
 * grazing reflectance (below). Uniforms only: the material's program is fixed
 * when it is built.
 */
export const configureReflective = (
  material: THREE.MeshPhysicalMaterial,
  record: ReflectiveRecord,
): THREE.MeshPhysicalMaterial => {
  const f0 = marmosetSpecularF0(record.specInt, record.fresnel, record.specColorSrgb)
  material.roughness = shininessToRoughness(record.shader, record.shininess)
  material.metalness = 0
  // BOTH ends of 2016's curve, which the terrain could not have. At metalness
  // 0 three's F90 IS `specularIntensity` and its F0 is `min(0.04 x colour, 1)
  // x intensity`; Marmoset's reflectance runs from the F0 above at face-on up
  // to `_SpecInt` at grazing. So the intensity is `_SpecInt` and the colour
  // carries the rest — which stays under three's clamp while `_SpecInt` is
  // under 1 (0.25 here). Left at F90 1, the deck's grazing reflection was four
  // times 2016's and the deck read white.
  const f90 = Math.max(record.specInt, 1e-4)
  material.specularIntensity = f90
  material.specularColor.setRGB(
    f0[0] / (THREE_DIELECTRIC_F0 * f90),
    f0[1] / (THREE_DIELECTRIC_F0 * f90),
    f0[2] / (THREE_DIELECTRIC_F0 * f90),
  )
  // The sky's SPECULAR exposure, `_ExposureIBL.y` (master x spec): the skies
  // above are written before it.
  material.envMapIntensity = HANGAR_LIGHT_SHEET.ibl.exposure.specular
  return material
}

/**
 * Turn the reflected sky to the room: the ROOM frame's world yaw, which is all
 * the turn the room has (it stands on the floor). three rotates the lookup by
 * the NEGATED Euler for a prefiltered map, so this is the yaw itself.
 */
export const turnReflectiveSky = (
  material: THREE.MeshPhysicalMaterial,
  roomWorld: THREE.Quaternion,
): void => {
  const e = new THREE.Euler().setFromQuaternion(roomWorld, 'YXZ')
  if (Math.abs(e.x) > 1e-6 || Math.abs(e.z) > 1e-6) {
    throw new Error('hangar-light: the room frame is tilted; the reflected sky only turns about y')
  }
  material.envMapRotation.set(0, e.y, 0)
}

// ══ The key light's shadows (DEV-440) ════════════════════════════════════════
//
// Matt, 2026-09-26: *"add key-light shadows."* `light_env` casts in 2016: HARD
// shadows (`m_Shadows.m_Type` 1) at strength 0.689, both set on the scene. A
// directional light 57 degrees up, casting, in a room with a ceiling, lights
// only what the bore and the openings let it reach — which is most of why
// f0030's floor and deck read darker than the port's room did without it.
//
// The game's own machinery, not a second one:
//
//   WHETHER    `shadowsEnabled`, the rule the mission sun's map obeys: the
//              preset's `render.shadows`, off at quality `low`, and whatever the
//              headset's `vr.disable` leaves of it (the SHADOWS row turns both
//              maps off together). So Classic, whose preset has no shadows, sees
//              none here either, exactly as in a mission.
//   HOW BIG    the preset's `mapSize`, and the renderer's `shadowMap.type`,
//              which `render/shadows.ts` owns and this never writes.
//   WHERE      `fitSunShadow`, the sun's own fit, round the room's lit meshes
//              rather than round the camera: the room does not move, so the box
//              is refitted only when what stands in it changes.
//   HOW HARD   2016's: `shadow.intensity` is the strength, and a HARD Unity
//              shadow is PCF radius 1.
//
// `castShadow` follows the flag from the room's FIRST frame (the key is built
// dark with the room): a light's shadow count is in every lit program's cache
// key, so the switch is set before anything compiles and moves only when the
// player moves the SHADOWS row. Until the room is fitted — until 2016's light
// stands in it — the map is not rendered at all (`autoUpdate` false).

/** 2016's key shadow: the sheet's `light_env.m_Shadows`. */
export const HANGAR_KEY_SHADOW = HANGAR_LIGHT_SHEET.lights.env.shadows ?? {
  strength: 1,
  type: 0,
}

/** Depth bias in shadow TEXELS of the room's fit (the preset's metres are for a 700 m box). */
const ROOM_SHADOW_BIAS_TEXELS = 1.5
/** Normal bias in the same texels. */
const ROOM_SHADOW_NORMAL_BIAS_TEXELS = 1

export interface RoomShadows {
  /** Once a frame while the room is up: flag its lit meshes and refit if what stands in it moved. */
  update(): void
  /** Whether the key casts right now. */
  readonly on: boolean
  /** The live fit, or null before the room's light stands in it. */
  readonly fit: ShadowFit | null
  dispose(): void
}

const isLit = (material: THREE.Material | THREE.Material[] | undefined): boolean => {
  const m = (Array.isArray(material) ? material[0] : material) as
    | (THREE.Material & {
        isMeshStandardMaterial?: boolean
        isMeshLambertMaterial?: boolean
        isMeshPhongMaterial?: boolean
      })
    | undefined
  return !!(m?.isMeshStandardMaterial || m?.isMeshLambertMaterial || m?.isMeshPhongMaterial)
}

/**
 * The level-select room's key light, casting as 2016's did (see above). `room`
 * is the room's group; `key` its `hangar-2016-key`, which `render/hangar.ts`
 * builds dark with the room.
 */
export const createRoomShadows = (
  room: THREE.Object3D,
  key: THREE.DirectionalLight,
  editionState: EditionState,
  shadowOf: { readonly strength: number; readonly type: number } = HANGAR_KEY_SHADOW,
): RoomShadows => {
  let on = false
  let fit: ShadowFit | null = null
  let sizedFor = 0
  let signature = ''
  const box = new THREE.Box3()
  const part = new THREE.Box3()
  const centre = new THREE.Vector3()
  const extent = new THREE.Vector3()
  const lightAt = new THREE.Vector3()
  const targetAt = new THREE.Vector3()

  const apply = (): void => {
    on = shadowsEnabled(editionState.current, editionState.settings)
    key.castShadow = on
    if (!on) return
    const size = editionState.current.render.shadows.mapSize
    if (sizedFor !== size) {
      key.shadow.map?.dispose()
      key.shadow.map = null
      key.shadow.mapSize.set(size, size)
      sizedFor = size
      signature = ''
    }
    key.shadow.intensity = shadowOf.strength
    key.shadow.radius = shadowOf.type === 2 ? editionState.current.render.shadows.radius : 1
    key.shadow.autoUpdate = fit !== null
  }

  const refit = (): void => {
    box.makeEmpty()
    let casters = 0
    // Last frame's world matrices, which the renderer has just composed: the
    // room stands still, and a mesh added since is one frame late at worst.
    room.traverseVisible((node) => {
      const mesh = node as THREE.Mesh
      // An unlit mesh that asks to cast does (`hangar-art.ts`: the shaft,
      // baked since DEV-561 and still the bore the key comes down).
      const unlitCaster = mesh.userData?.castShadow === true && !isLit(mesh.material)
      if (!mesh.isMesh || !(isLit(mesh.material) || unlitCaster)) return
      // A mesh 2016 told not to cast says so (`hangar-art.ts`: the shell).
      mesh.castShadow = mesh.userData.castShadow !== false
      mesh.receiveShadow = !unlitCaster
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      part.copy(mesh.geometry.boundingBox as THREE.Box3).applyMatrix4(mesh.matrixWorld)
      box.union(part)
      casters++
    })
    key.updateWorldMatrix(true, false)
    key.target.updateWorldMatrix(true, false)
    key.getWorldPosition(lightAt)
    key.target.getWorldPosition(targetAt)
    if (box.isEmpty()) return
    box.getCenter(centre)
    const half = box.getSize(extent).length() / 2
    const next = `${casters}|${centre.toArray().map((v) => v.toFixed(2))}|${half.toFixed(2)}|${lightAt.toArray().map((v) => v.toFixed(2))}`
    if (next === signature) return
    signature = next
    fit = fitSunShadow({
      centre: centre.toArray() as [number, number, number],
      lightPosition: lightAt.toArray() as [number, number, number],
      lightTarget: targetAt.toArray() as [number, number, number],
      boxHalfSize: half,
      mapSize: sizedFor,
      castDistance: half,
    })
    const cam = key.shadow.camera
    cam.left = fit.left
    cam.right = fit.right
    cam.bottom = fit.bottom
    cam.top = fit.top
    cam.near = fit.near
    cam.far = fit.far
    cam.updateProjectionMatrix()
    key.shadow.bias = shadowBiasFor(ROOM_SHADOW_BIAS_TEXELS * fit.texelSize, fit)
    key.shadow.normalBias = ROOM_SHADOW_NORMAL_BIAS_TEXELS * fit.texelSize
    key.shadow.autoUpdate = true
    key.shadow.needsUpdate = true
  }

  apply()
  const unsubscribe = editionState.subscribe(apply)
  return {
    update() {
      if (on && key.intensity > 0) refit()
    },
    get on() {
      return on
    },
    get fit() {
      return on ? fit : null
    },
    dispose() {
      unsubscribe()
    },
  }
}
