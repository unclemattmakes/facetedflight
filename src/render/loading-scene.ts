// src/render/loading-scene.ts — somewhere calm to stand while a course loads.
//
// DEV-355. Matt: *"add a vr-comfy loading screen — the app currently freezes.
// in unity i'd do async level loads and tell the user the level was loading."*
//
// ── What it is ───────────────────────────────────────────────────────────
//
// A dim, faceted dome over a dark faceted ground, meeting at a horizon at eye
// height, and one plate a couple of metres ahead that names the course and how
// far along it is. Stood up ONCE, where the player's head is and the way it
// faces at the moment the room fades out, and then left alone: it is WORLD-
// locked, never head-locked. Turn your head and the plate stays where it was;
// turn the seat with the stick and the world turns under you, exactly as the
// room did.
//
// ── Why this shape and not the room it replaces ──────────────────────────
//
// The hangar already stayed lit through a load (DEV-107 L5), and it was not
// enough, because the frames stopped: a 3.4 s task is 3.4 s of the compositor
// reprojecting one stale picture. Slicing the work (`boot/slice.ts`) is what
// keeps frames coming; this scene is what those frames should show, and it is
// chosen for the moments a frame is still late.
//
//   * **Everything that matters is at infinity.** Rotational reprojection is
//     exact for a scene at infinity and wrong for a near one — a late frame of
//     the room smears its walls as you turn, a late frame of a horizon does
//     not. The dome is 250 m out and the ground runs to it.
//   * **A horizon.** The one visual reference the inner ear agrees with. The
//     sky is lightest just above it and the ground darkest just below, so it
//     reads as a line rather than a gradient.
//   * **Dim.** Nothing bright to flicker if a frame is repeated, and nothing
//     to pupil-adjust to on the way into the cockpit.
//   * **Faceted, one colour per face** (ART_DIRECTION pillar 2) — folded paper,
//     the same register as the world you are about to be dropped into. The
//     plate is a canvas, like every other readable plate in the game.
//
// It is drawn as part of the MENU stage — the room is hidden and this group
// shown in its place — so the frame loop, the fade, the rig, the XR pointer
// and the seat look all carry on exactly as they do in the hangar, and nothing
// in the frame had to learn a new screen.
//
// ── The spinner is the title's emblem (DEV-434) ──────────────────────────
//
// Matt, 2026-09-26: *"the loading spinner - let's center it and make it a lil
// version of the logo from the title screen. but where the text stays put and
// the logo spins."* The logo is three meshes (`logo_top`, `logo_bottom` and
// `title`, the FACETED FLIGHT wordmark over them), so the small one keeps all
// three: the emblem turns about its own vertical, the wordmark stays still
// facing you, and the plate's own words do not move either. It stands centred
// over the plate, clear of it, in the title's gold and silver.
//
// **It adds no program.** Every mesh of it is drawn with the GROUND's own
// material, and its geometry carries exactly the attributes the ground's does
// (a position and a three-channel colour, no normal: `vertexNormals` is in
// three's program key). So in every pass, on every preset, flat or in a
// session, the emblem's program IS the ground's, and it is compiled by the
// ground's first draw or not at all. The facets are shaded on the CPU instead,
// per face, against a light held in the plate's frame: 273 faces, one short
// loop and one small colour upload a frame while the plate is up.
//
// It turns every frame the gem did, at the gem's rate, because the turning is
// what says frames are flowing. Until the logo has loaded, or if it never does,
// the gem is still the mark, in the emblem's place.
//
// ── Or the plate alone, in the room (DEV-465) ────────────────────────────
//
// Matt, 2026-09-27: *"would it be possible to stay in the hangar, but show the
// loading indicator and spinning logo?"* So the same plate and the same emblem
// can stand in the ROOM, with the dome and the ground left down: `show(…,
// 'room')`. The room is lit and near, so the plate is held higher there
// (`LOADING_ROOM_PITCH_MIN`): above the tables' furniture rather than through
// the chosen table's island, which is where a head looking at it points.
//
// And a PRIMER (`primer`): zero-area triangles drawn with the plate's own
// materials, which the room draws on every frame it is up. A program is keyed on
// the pass that draws it (the room's lights in a headset, bloom's UI pass flat),
// so the only warm that cannot miss is the room's own frame, and it costs
// nothing to rasterise. Without it the plate's programs would link on the frame
// it appears, in plain view (DEV-434 counted four at the switch for the scene).

import * as THREE from 'three'
import { PROPS } from '@/generated/constants.generated'
import { acesFilmic } from '@/render/tone'
import { UI_ACCENT as ACCENT, uiFont as font } from '@/render/ui-tokens'
import { srgbToLinear } from '@/render/unity-space'
import { facetHash01 } from '@/sim/math/scalar'

/** Radius of the dome, metres. Far enough to read as infinity, inside the far plane. */
export const LOADING_DOME_RADIUS = 250
/** The ground sits this far below the eye: a seated player's floor. */
export const LOADING_FLOOR_DROP = 1.3
/** The plate: how far from the eye, and its size. */
export const LOADING_PLATE_DISTANCE = 2.4
/**
 * The band the plate's elevation is held in, radians: from 30° below the eye
 * line to 5° above it. Inside it the plate goes where the head was looking —
 * down at a holotable is down, which is where a reading plate is comfortable —
 * and a head tipped back to the ceiling or down at the floor gets the edge of
 * the band rather than a plate over the head or under the seat.
 */
export const LOADING_PLATE_PITCH_MIN = -0.52
export const LOADING_PLATE_PITCH_MAX = 0.09
export const LOADING_PLATE_WIDTH = 1.2
export const LOADING_PLATE_HEIGHT = 0.45
/**
 * The plate IN THE ROOM (DEV-465): 2.6 m out, and held from 1.2° under the eye
 * line to the scene's 5° over it. Two limits squeeze it, both measured off the
 * room's own meshes and the real emblem from the seat's eye
 * (`tests/unit/hangar-load.test.ts`):
 *
 *   * **Below, the tables.** The scene's band lets the plate go down to 30°
 *     under the eye, where a head looking at a holotable points; in the room
 *     that is through the pressed table's island, 1.55 m out, with the plate
 *     behind it. The tallest thing on the tables' arc is a place table's top
 *     difficulty mark (DEV-420), 8.9° under the eye; the test holds the plate's
 *     lower edge 2° over it. The step header, 3–7° under, would stand in front
 *     of the plate, so it goes down with the tables (`render/hangar.ts`'s
 *     `focus`).
 *   * **Above, a flat frame.** On a monitor the seat looks 22.8° down through
 *     a 70° lens, so the frame's top edge is 12.2° over the eye line, and the
 *     emblem stands over the plate: the test holds the emblem's top a degree
 *     inside it. At the scene's 2.4 m the plate, the gap and the emblem are 18°
 *     tall, and the window between the two limits was 18.1° — the first cut
 *     put the plate on the eye line and cut the emblem off at the top of the
 *     frame, photographed. At 2.6 m the stack is ~16.6°, and at 1.2° under the
 *     eye it sits with room at both ends.
 *
 * The words are 8 % smaller in the eye than in the scene; the plate is the
 * same plate.
 */
export const LOADING_ROOM_PLATE_DISTANCE = 2.6
export const LOADING_ROOM_PITCH_MIN = -0.021
export const LOADING_ROOM_PITCH_MAX = LOADING_PLATE_PITCH_MAX
/** Where the plate stands: the scene around it (DEV-355), or the room (DEV-465). */
export type LoadingPlace = 'scene' | 'room'
/**
 * How fast the mark turns, radians a second. The gem's rate, kept when the
 * mark became the emblem (DEV-434): about 52° a second, a turn in seven.
 */
export const LOADING_MARK_SPIN = 0.9
/**
 * The emblem's width on the plate, metres: the whole logo, wordmark included,
 * 17.97 m in the glTF. 8° across at the plate's 2.4 m, over a quarter of the
 * plate's width, and the wordmark's letters stand about as tall as the status
 * line's. The number to argue with (DEV-434).
 */
export const LOADING_EMBLEM_WIDTH = 0.34
/** Clear air between the plate's top edge and the emblem's lowest point, metres. */
export const LOADING_EMBLEM_GAP = 0.04

const PIXELS_PER_METRE = 900
const INK = '#e8eef3'
const DIM = '#93a6b5'
const PLATE = 'rgba(14, 22, 30, 0.86)'
const PLATE_EDGE = 'rgba(130, 170, 190, 0.45)'

/** The words on the plate. */
export interface LoadingText {
  /** "HoverJet · Ring Attack · Intermediate". */
  readonly kicker: string
  /** The course's own title, as the level select shows it. */
  readonly title: string
  /** What is happening now, in words — `boot/load-progress.ts`'s `plateText`. */
  readonly status: string
  /** 0..1, or null for work with no count (the bar shows full and the mark turns). */
  readonly fraction: number | null
}

/**
 * The yaw that faces along `direction`, in three's convention: a yaw of θ about
 * +y turns the default view (-z) to `(-sin θ, 0, -cos θ)`.
 *
 * Only the horizontal part, so the scene itself always stands level: the
 * horizon is a horizon however the head was tipped. Straight up or straight
 * down has no horizontal part at all, and then `fallback` is used rather than
 * a yaw read out of rounding noise.
 */
export const yawFacing = (direction: THREE.Vector3, fallback = 0): number => {
  const h = Math.hypot(direction.x, direction.z)
  if (h < 1e-6) return fallback
  return Math.atan2(-direction.x, -direction.z)
}

/**
 * The plate's elevation for a head looking along `direction`: its own, held in
 * the band of the place it stands in — the scene's, or the room's (DEV-465).
 */
export const plateElevation = (direction: THREE.Vector3, place: LoadingPlace = 'scene'): number => {
  const length = direction.length()
  const pitch = length > 0 ? Math.asin(Math.max(-1, Math.min(1, direction.y / length))) : 0
  const min = place === 'room' ? LOADING_ROOM_PITCH_MIN : LOADING_PLATE_PITCH_MIN
  const max = place === 'room' ? LOADING_ROOM_PITCH_MAX : LOADING_PLATE_PITCH_MAX
  return Math.max(min, Math.min(max, pitch))
}

/**
 * Where the plate goes, in WORLD space, for an eye at `eye` facing `yaw` and
 * looking `elevation` above the horizontal. Pure, so the placement is testable
 * as geometry: its distance from the eye, its bearing, and its height.
 */
export const loadingPlatePosition = (
  eye: THREE.Vector3,
  yaw: number,
  elevation: number,
  out: THREE.Vector3,
  /** DEV-465: the room's plate stands further out, `LOADING_ROOM_PLATE_DISTANCE`. */
  distance: number = LOADING_PLATE_DISTANCE,
): THREE.Vector3 => {
  const flat = Math.cos(elevation) * distance
  return out.set(
    eye.x - Math.sin(yaw) * flat,
    eye.y + Math.sin(elevation) * distance,
    eye.z - Math.cos(yaw) * flat,
  )
}

// ── The MENUS' tone curve, on the CPU (DEV-451) ──────────────────────────
//
// The loading scene is a menu, and every menu wears Anniversary. But since
// DEV-451 the MISSION's edition goes on at the black INTO this scene, so the
// world is built under the edition it is flown in, and a preset's tone curve
// is renderer state (`render/tone.ts`): on Classic the dome, the ground and
// the emblem were drawn under Classic's curve (none) and came out a lighter
// grey-blue than the same scene under Anniversary's ACES — photographed,
// side by side. The plate was not: it is `toneMapped: false` already.
//
// So the curve is applied HERE, once per face, to colours that are flat per
// face anyway, and the materials are `toneMapped: false`: the scene draws the
// same pixels under any renderer curve. Three's own `ACESFilmicToneMapping`,
// line for line, is `acesFilmic` (its constants are read back out of three's
// shader chunk in `tests/unit/loading-tone.test.ts`, not trusted). Absent a
// tone, the materials are tone-mapped by the renderer as before.

/** The curve the loading scene is drawn under, and its exposure: the menus' preset's. */
export interface LoadingTone {
  readonly curve: 'aces' | 'none'
  readonly exposure: number
}

/** three's ACES on the CPU: moved to `render/tone.ts` (DEV-568), which the launch rig shares. */
export { acesFilmic }

/** Every colour triple of `rgb`, through the tone's curve; nothing without a tone. */
const toneAll = (rgb: Float32Array, tone: LoadingTone | undefined): void => {
  if (tone?.curve !== 'aces') return
  for (let i = 0; i < rgb.length; i += 3) acesFilmic(rgb, i, tone.exposure)
}

const SKY_ZENITH = new THREE.Color('#0a0e15')
const SKY_HORIZON = new THREE.Color('#2a3a4e')
const SKY_BAND = new THREE.Color('#40546c')
const GROUND_NEAR = new THREE.Color('#1f2731')
const GROUND_FAR = new THREE.Color('#131a22')

/** The sky colour for a face whose centre sits `elevation` radians above the horizon. */
export const skyColourAt = (elevation: number, out: THREE.Color): THREE.Color => {
  if (elevation <= 0) return out.copy(SKY_HORIZON)
  // A band just above the horizon, then a long fall to the zenith.
  const band = Math.max(0, 1 - elevation / 0.12)
  const up = Math.min(1, elevation / (Math.PI / 2))
  return out
    .copy(SKY_HORIZON)
    .lerp(SKY_ZENITH, up ** 0.7)
    .lerp(SKY_BAND, band * 0.8)
}

const paintFaces = (
  geometry: THREE.BufferGeometry,
  colourOf: (centre: THREE.Vector3, face: number, out: THREE.Color) => THREE.Color,
  tone?: LoadingTone,
): void => {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const colours = new Float32Array(position.count * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const colour = new THREE.Color()
  for (let f = 0; f * 3 < position.count; f++) {
    a.fromBufferAttribute(position, f * 3)
    b.fromBufferAttribute(position, f * 3 + 1)
    c.fromBufferAttribute(position, f * 3 + 2)
    centre
      .copy(a)
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3)
    colourOf(centre, f, colour)
    // ±6 % per face: enough to read as folded paper, not enough to read as noise.
    colour.multiplyScalar(0.94 + 0.12 * facetHash01(f))
    for (let v = 0; v < 3; v++) {
      colours[(f * 3 + v) * 3] = colour.r
      colours[(f * 3 + v) * 3 + 1] = colour.g
      colours[(f * 3 + v) * 3 + 2] = colour.b
    }
  }
  toneAll(colours, tone)
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3))
}

/** The dome: a flat-faced icosphere, coloured by each face's elevation. */
const buildDome = (tone?: LoadingTone): THREE.Mesh => {
  const geometry = new THREE.IcosahedronGeometry(LOADING_DOME_RADIUS, 3)
  paintFaces(
    geometry,
    (centre, _f, out) =>
      skyColourAt(Math.asin(Math.max(-1, Math.min(1, centre.y / centre.length()))), out),
    tone,
  )
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      // DEV-451: the curve is in the colours, so the renderer's is not applied.
      toneMapped: tone === undefined,
    }),
  )
  mesh.name = 'loading-dome'
  mesh.renderOrder = -1
  mesh.frustumCulled = false
  return mesh
}

/** Rings of the ground, metres from the eye: finer near, coarser toward the horizon. */
const GROUND_RINGS = [0, 3, 8, 18, 40, 85, 160, LOADING_DOME_RADIUS * 0.98]
const GROUND_SEGMENTS = 20

/**
 * The ground: a polar grid of flat faces out to the dome, darkening outward.
 * Drawn with `paper`, the material the emblem shares (DEV-434).
 */
const buildGround = (paper: THREE.Material, tone?: LoadingTone): THREE.Mesh => {
  const positions: number[] = []
  const at = (r: number, s: number): [number, number] => {
    // Every other ring turned half a segment, so the faces are triangles of
    // varying shape rather than a spoked wheel.
    const ring = GROUND_RINGS.indexOf(r)
    const angle = ((s + (ring % 2) * 0.5) / GROUND_SEGMENTS) * Math.PI * 2
    return [Math.sin(angle) * r, Math.cos(angle) * r]
  }
  for (let k = 0; k + 1 < GROUND_RINGS.length; k++) {
    const r0 = GROUND_RINGS[k] as number
    const r1 = GROUND_RINGS[k + 1] as number
    for (let s = 0; s < GROUND_SEGMENTS; s++) {
      const [ax, az] = at(r0, s)
      const [bx, bz] = at(r0, s + 1)
      const [cx, cz] = at(r1, s)
      const [dx, dz] = at(r1, s + 1)
      // Two faces per cell, one at the centre where the inner ring is a point.
      // Drawn double-sided, so the winding does not decide what is seen.
      if (r0 > 0) positions.push(ax, 0, az, cx, 0, cz, bx, 0, bz)
      positions.push(bx, 0, bz, cx, 0, cz, dx, 0, dz)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const far = GROUND_RINGS[GROUND_RINGS.length - 1] as number
  paintFaces(
    geometry,
    (centre, _f, out) =>
      out.copy(GROUND_NEAR).lerp(GROUND_FAR, Math.min(1, Math.hypot(centre.x, centre.z) / far)),
    tone,
  )
  const mesh = new THREE.Mesh(geometry, paper)
  mesh.name = 'loading-ground'
  mesh.position.y = -LOADING_FLOOR_DROP
  mesh.frustumCulled = false
  return mesh
}

// ── the emblem (DEV-434) ─────────────────────────────────────────────────

/**
 * The title's gold: `Materials/logo_gold.mat` `_Color` (0.978, 0.809, 0.388),
 * which `render/title.ts` carries by hand as `LOGO_GOLD` for `logo_top` and the
 * wordmark. Carried by hand here too (that file is the title's, and does not
 * export it); `tests/unit/loading-emblem.test.ts` holds the two copies equal.
 */
export const EMBLEM_GOLD = 0xfacf63

/**
 * The title's silver, `logo_bottom`'s `medal_Silver.mat`, off the generated
 * sheet (DEV-113 extracts it for the medals). sRGB there, linear here.
 */
const emblemSilver = (): THREE.Color => {
  const c = PROPS.medals.colors.silver
  return new THREE.Color(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}

/**
 * The light the facets are shaded by, in the PLATE's frame (x right, y up, z
 * toward the eye): high, a little left, and in front, so the face turned
 * toward you is the lit one whichever side of the emblem it is. A face turned
 * from it keeps `EMBLEM_AMBIENT` of its colour; one facing it squarely gets
 * `EMBLEM_DIFFUSE` more. Both first guesses, chosen on a monitor.
 */
export const EMBLEM_LIGHT = new THREE.Vector3(-0.35, 0.55, 0.76).normalize()
export const EMBLEM_AMBIENT = 0.42
export const EMBLEM_DIFFUSE = 0.62

/**
 * The logo's readable side is its local −z, and a half turn about y puts it
 * at the plate's +z, toward the eye. Two sources agree, and neither is a
 * rotation chosen here:
 *
 *  - the title's composition: 2016's camera yaw (33.35°) and the logo's
 *    (−150°, `TITLE_2016`) put the title camera along the logo's own −z;
 *  - the wordmark itself: FACETED is the longer word, so from the front the
 *    space between the words is right of centre. The widest gap in the
 *    wordmark's x runs at x = −0.955, which is the viewer's right only from −z.
 *
 * `tests/unit/loading-emblem.test.ts` measures the second on the real mesh as
 * it stands on the plate, and the photographs read it.
 */
const FRONT_TO_EYE = new THREE.Matrix4().makeRotationY(Math.PI)

/** The emblem's parts as the plate draws them. */
export interface EmblemMeshes {
  /** `logo_top` and `logo_bottom` in one mesh: the part that turns. */
  readonly spin: THREE.Mesh
  /** The wordmark, which does not turn. Null if the logo has none. */
  readonly word: THREE.Mesh | null
  /** The whole logo's height as placed, metres. Its base is the origin. */
  readonly height: number
  /** Re-shade the turning part's facets for a yaw of `yaw` about the plate's up. */
  shade(yaw: number): void
  dispose(): void
}

/**
 * `node`'s transform in `root`'s frame, composed from the local transforms in
 * between. Composed rather than read off `matrixWorld`, so the logo is never
 * touched and wherever its root has been put does not matter.
 */
const inRootFrame = (node: THREE.Object3D, root: THREE.Object3D, out: THREE.Matrix4) => {
  out.identity()
  const step = new THREE.Matrix4()
  for (let n: THREE.Object3D | null = node; n && n !== root; n = n.parent) {
    out.premultiply(step.compose(n.position, n.quaternion, n.scale))
  }
  return out
}

/** A geometry's triangles, unindexed, through `matrix`. Position only. */
const trianglesOf = (geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): Float32Array => {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const count = index ? index.count : position.count
  const out = new Float32Array(count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  return out
}

/** One unit normal per triangle of an unindexed list. A degenerate face gets zero. */
const faceNormals = (positions: Float32Array): Float32Array => {
  const faces = Math.floor(positions.length / 9)
  const out = new Float32Array(faces * 3)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let f = 0; f < faces; f++) {
    a.fromArray(positions, f * 9)
    b.fromArray(positions, f * 9 + 3).sub(a)
    c.fromArray(positions, f * 9 + 6).sub(a)
    b.cross(c)
    const length = b.length()
    if (length > 0) b.multiplyScalar(1 / length)
    b.toArray(out, f * 3)
  }
  return out
}

/**
 * Shade faces: each face's base colour times `EMBLEM_AMBIENT` plus
 * `EMBLEM_DIFFUSE` of how squarely it faces `light` (a unit vector in the
 * faces' own frame), written to all three of its vertices. Pure, so the look
 * is testable without a renderer.
 */
export const shadeFaces = (
  normals: Float32Array,
  base: Float32Array,
  light: THREE.Vector3,
  out: Float32Array,
): void => {
  const faces = normals.length / 3
  for (let f = 0; f < faces; f++) {
    const facing =
      (normals[f * 3] as number) * light.x +
      (normals[f * 3 + 1] as number) * light.y +
      (normals[f * 3 + 2] as number) * light.z
    const s = EMBLEM_AMBIENT + EMBLEM_DIFFUSE * Math.max(0, facing)
    const r = (base[f * 3] as number) * s
    const g = (base[f * 3 + 1] as number) * s
    const b = (base[f * 3 + 2] as number) * s
    for (let v = 0; v < 3; v++) {
      out[(f * 3 + v) * 3] = r
      out[(f * 3 + v) * 3 + 1] = g
      out[(f * 3 + v) * 3 + 2] = b
    }
  }
}

const Y_AXIS = new THREE.Vector3(0, 1, 0)

/**
 * The title's logo, small, for the plate (DEV-434).
 *
 * `logo` is the glTF root of `assets/props/title-logo.glb`; it is read, never
 * changed, and never kept, so the caller may free it. Its three meshes are
 * matched BY NAME, as the title paints them: `title` is the wordmark and
 * stays still, `logo_bottom` is silver, the rest gold. Both parts are baked
 * into the plate's frame (the front toward the eye, `FRONT_TO_EYE`), scaled to
 * `LOADING_EMBLEM_WIDTH` across, with the turning part's axis at the origin
 * and the logo's lowest point on it.
 *
 * Every mesh is drawn with `material` — the scene passes the ground's — and
 * carries only a position and a three-channel colour, the ground's attributes
 * exactly, so the emblem can never need a program the ground does not. Null
 * when the logo has nothing to turn.
 */
export const buildEmblem = (
  logo: THREE.Object3D,
  material: THREE.Material,
  /** DEV-451: the scene's curve, applied to the shaded faces as the ground's is. */
  tone?: LoadingTone,
): EmblemMeshes | null => {
  const gold = new THREE.Color(EMBLEM_GOLD)
  const silver = emblemSilver()
  const turning: { positions: Float32Array; colour: THREE.Color }[] = []
  const words: Float32Array[] = []
  const matrix = new THREE.Matrix4()
  logo.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    inRootFrame(mesh, logo, matrix).premultiply(FRONT_TO_EYE)
    const positions = trianglesOf(mesh.geometry, matrix)
    if (/^title/i.test(mesh.name)) words.push(positions)
    else turning.push({ positions, colour: /bottom/i.test(mesh.name) ? silver : gold })
  })
  if (turning.length === 0) return null

  // The whole logo's box sets the scale and the floor; the turning part's own
  // centre is the axis, so it turns in place rather than about the wordmark.
  const whole = new THREE.Box3()
  const turn = new THREE.Box3()
  const v = new THREE.Vector3()
  for (const part of turning) {
    for (let i = 0; i < part.positions.length; i += 3) {
      v.fromArray(part.positions, i)
      whole.expandByPoint(v)
      turn.expandByPoint(v)
    }
  }
  for (const positions of words) {
    for (let i = 0; i < positions.length; i += 3) whole.expandByPoint(v.fromArray(positions, i))
  }
  const k = LOADING_EMBLEM_WIDTH / (whole.max.x - whole.min.x)
  const cx = (turn.min.x + turn.max.x) / 2
  const cz = (turn.min.z + turn.max.z) / 2
  const place = (positions: Float32Array): void => {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = ((positions[i] as number) - cx) * k
      positions[i + 1] = ((positions[i + 1] as number) - whole.min.y) * k
      positions[i + 2] = ((positions[i + 2] as number) - cz) * k
    }
  }

  // The turning part: one geometry, a base colour per face.
  const spinPositions = new Float32Array(turning.reduce((n, p) => n + p.positions.length, 0))
  const spinBase = new Float32Array(spinPositions.length / 3)
  let at = 0
  for (const part of turning) {
    place(part.positions)
    spinPositions.set(part.positions, at)
    for (let f = at / 9; f < (at + part.positions.length) / 9; f++) {
      spinBase[f * 3] = part.colour.r
      spinBase[f * 3 + 1] = part.colour.g
      spinBase[f * 3 + 2] = part.colour.b
    }
    at += part.positions.length
  }
  const spinNormals = faceNormals(spinPositions)
  const spinGeometry = new THREE.BufferGeometry()
  spinGeometry.setAttribute('position', new THREE.BufferAttribute(spinPositions, 3))
  const spinColours = new THREE.BufferAttribute(new Float32Array(spinPositions.length), 3)
  spinColours.setUsage(THREE.DynamicDrawUsage)
  spinGeometry.setAttribute('color', spinColours)
  const spin = new THREE.Mesh(spinGeometry, material)
  spin.name = 'loading-emblem'

  // The wordmark: gold, shaded once, because it never turns.
  let word: THREE.Mesh | null = null
  if (words.length > 0) {
    const wordPositions = new Float32Array(words.reduce((n, p) => n + p.length, 0))
    let w = 0
    for (const positions of words) {
      place(positions)
      wordPositions.set(positions, w)
      w += positions.length
    }
    const wordNormals = faceNormals(wordPositions)
    const wordBase = new Float32Array(wordNormals.length)
    for (let f = 0; f * 3 < wordBase.length; f++) gold.toArray(wordBase, f * 3)
    const wordColours = new Float32Array(wordPositions.length)
    shadeFaces(wordNormals, wordBase, EMBLEM_LIGHT, wordColours)
    toneAll(wordColours, tone)
    const wordGeometry = new THREE.BufferGeometry()
    wordGeometry.setAttribute('position', new THREE.BufferAttribute(wordPositions, 3))
    wordGeometry.setAttribute('color', new THREE.BufferAttribute(wordColours, 3))
    word = new THREE.Mesh(wordGeometry, material)
    word.name = 'loading-wordmark'
  }

  const light = new THREE.Vector3()
  return {
    spin,
    word,
    height: (whole.max.y - whole.min.y) * k,
    shade(yaw) {
      // The mesh turns by `yaw`; turning the light the other way instead and
      // shading in the mesh's own frame is the same dot product.
      light.copy(EMBLEM_LIGHT).applyAxisAngle(Y_AXIS, -yaw)
      shadeFaces(spinNormals, spinBase, light, spinColours.array as Float32Array)
      toneAll(spinColours.array as Float32Array, tone)
      spinColours.needsUpdate = true
    },
    dispose() {
      spinGeometry.dispose()
      word?.geometry.dispose()
    },
  }
}

export interface LoadingScene {
  /** Add this to the stage the menu draws. Hidden until `show`. */
  readonly object: THREE.Group
  /**
   * Stand the scene around an eye, facing `yaw`, with the plate `elevation`
   * above the horizontal (`plateElevation`) — world space, once. It does not
   * follow the head afterwards; that is the point.
   *
   * `place` 'room' (DEV-465) stands the plate and its emblem alone, the dome
   * and the ground left down, for a load the player waits for in the hangar.
   */
  show(
    eye: THREE.Vector3,
    yaw: number,
    elevation: number,
    text: LoadingText,
    place?: LoadingPlace,
  ): void
  /** Where the plate is standing, or null while it is down (DEV-465). */
  readonly place: LoadingPlace | null
  /**
   * DEV-465: zero-area triangles in the plate's own materials, for the ROOM to
   * hold and draw every frame (`boot/app.ts` adds it to the menu's scene). They
   * rasterise nothing and compile the plate's programs in the pass that will
   * draw it, so the plate appearing in the room links no program in view.
   */
  readonly primer: THREE.Object3D
  /** New words or a new fraction. The canvas is redrawn only when the WORDS change. */
  update(text: LoadingText): void
  /**
   * The title's logo arrives (DEV-434): the glTF root of
   * `assets/props/title-logo.glb`, copied and never kept, so the caller may
   * free it straight after. The mark becomes the emblem and the wordmark stands
   * over it. False, and the gem stays the mark, if the logo has nothing to turn.
   */
  emblem(logo: THREE.Object3D): boolean
  /** Per frame, while shown: the mark turns, so a live frame is visibly live. */
  tick(seconds: number): void
  hide(): void
  readonly shown: boolean
  /** What the plate says now. For a spec, which cannot read a canvas's words. */
  readonly text: LoadingText | null
  dispose(): void
}

export const createLoadingScene = (
  options: {
    /**
     * DEV-451: the menus' curve, drawn into the colours, so the scene looks the
     * same whichever edition's curve the renderer is on (see `LoadingTone`).
     * Absent: tone-mapped by the renderer, as before.
     */
    readonly tone?: LoadingTone | undefined
  } = {},
): LoadingScene => {
  const tone = options.tone
  const object = new THREE.Group()
  object.name = 'loading-scene'
  object.visible = false

  const dome = buildDome(tone)
  object.add(dome)
  // One material for the ground AND the emblem (DEV-434): whatever program the
  // ground is drawn with, the emblem is drawn with the same one.
  const paper = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: tone === undefined,
  })
  const ground = buildGround(paper, tone)
  object.add(ground)
  let standing: LoadingPlace | null = null

  // ── the plate ──────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(LOADING_PLATE_WIDTH * PIXELS_PER_METRE)
  canvas.height = Math.round(LOADING_PLATE_HEIGHT * PIXELS_PER_METRE)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('loading-scene: no 2d context')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  // `toneMapped: false` is what `render/bloom.ts`'s `classify()` moves onto
  // `UI_LAYER` (3): stereo, crisp, and exempt from the Anniversary tone curve,
  // like every other readable plate. Never layer 1 or 2 (DEV-141).
  const plateMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  })
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(LOADING_PLATE_WIDTH, LOADING_PLATE_HEIGHT),
    plateMaterial,
  )
  plate.name = 'loading-plate'
  plate.renderOrder = 10
  object.add(plate)

  // The bar and its track: meshes, not pixels, so a per-chunk progress tick is
  // a scale write rather than a canvas upload.
  const barWidth = LOADING_PLATE_WIDTH * 0.86
  const barY = -LOADING_PLATE_HEIGHT * 0.34
  const barGeometry = new THREE.PlaneGeometry(1, 0.012)
  barGeometry.translate(0.5, 0, 0)
  const track = new THREE.Mesh(
    barGeometry,
    new THREE.MeshBasicMaterial({ color: '#2c3a47', toneMapped: false, fog: false }),
  )
  track.name = 'loading-track'
  track.renderOrder = 11
  const bar = new THREE.Mesh(
    barGeometry,
    new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false, fog: false }),
  )
  bar.name = 'loading-bar'
  bar.renderOrder = 12
  for (const m of [track, bar]) {
    m.position.set(-barWidth / 2, barY, 0.002)
    m.scale.set(barWidth, 1, 1)
    plate.add(m)
  }
  bar.position.z = 0.003

  // The mark: the title's emblem, turning (DEV-434), and a small faceted gem
  // until the logo has loaded. If it is turning, frames are being drawn —
  // which is the thing this whole row is about.
  //
  // Centred OVER the plate and clear of it, not on it: flat on Anniversary the
  // plate's words are drawn in a pass of their own, in front of the world
  // (`render/bloom.ts`), and an emblem on the plate would be behind them. The
  // group's origin is the axis it turns about, at the emblem's lowest point.
  const mark = new THREE.Group()
  mark.name = 'loading-mark'
  mark.position.set(0, LOADING_PLATE_HEIGHT / 2 + LOADING_EMBLEM_GAP, 0)
  plate.add(mark)
  const GEM_RADIUS = 0.035
  let gem: THREE.Mesh | null = new THREE.Mesh(
    new THREE.OctahedronGeometry(GEM_RADIUS, 0),
    new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false, fog: false }),
  )
  gem.name = 'loading-gem'
  gem.renderOrder = 12
  gem.position.y = GEM_RADIUS
  gem.rotation.x = 0.35
  mark.add(gem)
  let emblem: EmblemMeshes | null = null

  // ── the primer (DEV-465) ───────────────────────────────────────────────
  //
  // One zero-area triangle per mesh whose material the plate draws with and
  // which outlives the gem: the plate's canvas, the track, the bar, and the
  // ground, whose paper the emblem and the wordmark share (DEV-434 holds their
  // attributes to the ground's). The gem is not primed: its material is freed
  // when the emblem arrives, and its program is the track's anyway (a plain
  // colour, not tone-mapped). Each triangle carries its mesh's attribute NAMES
  // and sizes, zero-filled, because two of them are in three's key
  // (`vertexNormals`, and `vertexAlphas` off the colour's size): copied rather
  // than listed, so a mesh that gains one cannot leave its primer behind.
  const primer = new THREE.Group()
  primer.name = 'loading-primer'
  for (const source of [plate, track, bar, ground]) {
    const geometry = new THREE.BufferGeometry()
    for (const [name, attribute] of Object.entries(source.geometry.attributes)) {
      const size = attribute.itemSize
      geometry.setAttribute(
        name,
        new THREE.Float32BufferAttribute(new Array(3 * size).fill(0), size),
      )
    }
    const mesh = new THREE.Mesh(geometry, source.material)
    mesh.name = `loading-primer-${source.name}`
    // Never culled: a zero-radius sphere outside the frustum would skip the draw
    // this exists to make.
    mesh.frustumCulled = false
    primer.add(mesh)
  }

  let current: LoadingText | null = null
  let drawn = ''

  const draw = (text: LoadingText): void => {
    const signature = `${text.kicker}\u0001${text.title}\u0001${text.status}`
    if (signature === drawn) return
    drawn = signature
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, h * 0.08)
    ctx.fillStyle = PLATE
    ctx.fill()
    ctx.lineWidth = Math.max(2, h * 0.012)
    ctx.strokeStyle = PLATE_EDGE
    ctx.stroke()
    const pad = w * 0.07
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = DIM
    ctx.font = font(Math.round(h * 0.085), 600)
    ctx.fillText(text.kicker.toUpperCase(), pad, h * 0.22, w - pad * 2)
    ctx.fillStyle = INK
    ctx.font = font(Math.round(h * 0.15))
    ctx.fillText(text.title, pad, h * 0.44, w - pad * 2)
    ctx.fillStyle = DIM
    ctx.font = font(Math.round(h * 0.09), 500)
    ctx.fillText(text.status, pad, h * 0.64, w - pad * 2)
    texture.needsUpdate = true
  }

  const place = (text: LoadingText): void => {
    current = text
    draw(text)
    const f = text.fraction === null ? 1 : Math.max(0, Math.min(1, text.fraction))
    bar.scale.x = Math.max(1e-4, barWidth * f)
  }

  return {
    object,
    primer,
    show(eye, yaw, elevation, text, where = 'scene') {
      // DEV-465: in the room the room is the world, so its own dome and ground
      // stay down and only the plate and the emblem over it stand.
      standing = where
      dome.visible = where === 'scene'
      ground.visible = where === 'scene'
      // The group stands AT the eye, turned to face along `yaw` and LEVEL: the
      // dome is centred on the head and the ground under it. The plate is
      // ahead at `elevation`, tipped to face the eye along that line.
      object.position.copy(eye)
      object.rotation.set(0, yaw, 0)
      const out = where === 'room' ? LOADING_ROOM_PLATE_DISTANCE : LOADING_PLATE_DISTANCE
      plate.position.set(0, Math.sin(elevation) * out, -Math.cos(elevation) * out)
      plate.rotation.set(elevation, 0, 0)
      place(text)
      object.visible = true
      object.updateMatrixWorld(true)
    },
    update(text) {
      place(text)
    },
    emblem(logo) {
      const built = buildEmblem(logo, paper, tone)
      if (!built) return false
      if (emblem) {
        emblem.spin.removeFromParent()
        emblem.word?.removeFromParent()
        emblem.dispose()
      }
      if (gem) {
        gem.removeFromParent()
        gem.geometry.dispose()
        ;(gem.material as THREE.Material).dispose()
        gem = null
      }
      mark.add(built.spin)
      // The wordmark hangs from the PLATE at the mark's origin, not from the
      // mark: it is the text that stays put.
      if (built.word) {
        built.word.position.copy(mark.position)
        plate.add(built.word)
      }
      built.shade(mark.rotation.y)
      emblem = built
      object.updateMatrixWorld(true)
      return true
    },
    tick(seconds) {
      if (!object.visible) return
      mark.rotation.y = (mark.rotation.y + LOADING_MARK_SPIN * seconds) % (Math.PI * 2)
      emblem?.shade(mark.rotation.y)
    },
    hide() {
      object.visible = false
      standing = null
    },
    get shown() {
      return object.visible
    },
    get place() {
      return object.visible ? standing : null
    },
    get text() {
      return current
    },
    dispose() {
      // Sets, because the ground and the emblem share one material and the bar
      // and its track one geometry.
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      // The primer's triangles are its own and its materials the plate's.
      for (const root of [object, primer]) {
        root.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          geometries.add(mesh.geometry)
          materials.add(mesh.material as THREE.Material)
        })
      }
      primer.removeFromParent()
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      texture.dispose()
    },
  }
}
