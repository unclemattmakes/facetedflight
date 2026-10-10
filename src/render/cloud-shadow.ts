// src/render/cloud-shadow.ts: the clouds' shadows on everything lit. DEV-585.
//
// Matt, 2026-10-03: *"We should have clouds and their shadows in vr / Classic
// no."* `docs/plan/ULTRA.md` has the row; this header has the mechanism and the
// one decision in it that departs from the plan.
//
// ── What the plan said, and why it is not a layer height ──────────────────
//
// The plan's step 2 marches each fragment along the sun to ONE cloud layer
// height and samples a top-down coverage map there, and its step 3 warns that
// the layer height is the hard part at a 4-degree sun: an error of h metres
// moves the shadow h / tan(4 deg), fourteen times h, sideways. Measured before
// building it, as the plan asks: `int_01_hoverJet`'s nineteen clouds sit at
// **539 to 1,382 m** (789 to 1,632 m with Anniversary's 250 m lift), so any
// single layer is up to ~420 m wrong for some cloud, which at 4 degrees is
// **~6 km** of misplaced shadow. No refinement step rescues that with one
// extra fetch, because the error is not small.
//
// So the map is not top-down. It is the clouds projected ALONG THE SUN onto
// the plane y = 0: every hull vertex p goes to `p - L * (p.y / L.y)`, with L
// the unit vector toward the sun. A sun ray is a line parallel to L, and a line
// hits a cloud exactly when its projection along L lands inside the cloud's
// projection along L, whatever plane both are projected onto. The fragment
// side is the same projection of its own position, one multiply-add. There is
// no layer height to be wrong, at any sun angle and for any spread of cloud
// heights. The only approximation left is the raster: a texel, and bilinear
// filtering of it.
//
// ── The second channel: is the cloud AHEAD of the fragment? ──────────────
//
// A projection forgets which side of the fragment the cloud is on: a ship
// flying ABOVE a cloud projects onto the same texel as the sea below it. So the
// map's .g is the highest point of any cloud on that sun ray (the farthest
// point toward the sun, since y only increases along a ray toward a sun above
// the horizon), and a fragment is shaded only while it sits below that. Max,
// not min: any intersection above the fragment blocks the sun.
//
// ── Built once per mission, on the CPU, from the LIVE placements ─────────
//
// `game/clouds.ts` exposes the placements, each blob's triangle soup, the
// scale and lift in force and the wind's offset. The raster runs here in plain
// arithmetic (no render target, no GL state, testable in node against a ray
// march through the same hulls), and rebuilds when the placement settings move
// (an edition flip: Classic's 1.0x at 2016's heights against Anniversary's
// 1.35x lifted 250 m). The wind is a uniform offset: drift moves every cloud
// by the same vector, so it moves the projection by that vector's projection
// and the top channel by its y, and the map is never redrawn for it.
//
// ── Hard edges, and the fade toward the horizon ──────────────────────────
//
// Threshold, not blur (pillar: paper cut): coverage is 1 inside a cloud's
// projection and 0 outside, bilinearly filtered, and the edge is wherever the
// filtered value crosses 0.5, anti-aliased by its own screen derivative. And
// `render.cloudShadow.minSunElevation` fades the term out below it (a
// smoothstep from that elevation to twice it), so `int_02_hoverJet`'s
// 0.08-degree sun gets nothing rather than shadows stretched across the map.
//
// ── Where it reaches the shader ───────────────────────────────────────────
//
// Inside `render/far-shadow.ts`'s `ff2SunHeightTerm`, which every lit material
// that file patches already calls: the directional loop's min, the no-map
// multiply, the baked-light rung's shadow (`baked-light.ts`) and the sea's own
// glint (`water.ts`). One function, so nothing that takes the terrain's shadow
// of the sun can miss the clouds' shadow of it. The GLSL below is constant
// text and every branch in it is on a uniform, so the far-shadow patch's one
// cache-key token still names its only variant and Classic compiles the same
// program (the DEV-092 pattern: identity at 0).
//
// The clouds themselves opt out with `FF2_NO_CLOUD_SHADOW`, a define on their
// own material (which is already its own program, `cloud-look`), set before it
// first compiles. A cloud's sun-facing surface IS the top of its own chord, so
// it would sit on the threshold of its own shadow along every rim, and the rim
// light is the Anniversary cloud look. Cloud on cloud is the number to argue
// with, not a thing this file pretends to do.
//
// ── Space ─────────────────────────────────────────────────────────────────
//
// Three space, world, read from far-shadow's `vFf2SunWorld`. That varying is
// in the far-field's frame, which is the WORLD for every mission (DEV-298 shows
// the composition is the identity there); only the title valley differs, and
// it has no clouds and never calls `setClouds`.

import * as THREE from 'three'
import type { Edition, EditionCloudShadow } from '@/content/edition-schema'
import type { CloudPlacement, SunLight } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import type { CloudPlacementSettings } from './cloud-look'
import { forEachMeshMaterial } from './scene-walk'

/** The define a receiver sets to take no cloud shadow. The clouds set it. */
export const NO_CLOUD_SHADOW_DEFINE = 'FF2_NO_CLOUD_SHADOW'

/**
 * Texels per axis, at most. RG16F, so 1024 x 1024 is 4 MB.
 *
 * The axes are sized independently (see `rasterCloudShadow`), so this is a cap
 * on each. On `int_01` at 4 degrees the projected sky is ~25 km along the sun
 * and ~7 km across it: ~24 m texels along, which is ~1.7 m of cloud height
 * because the projection stretches 14:1, and ~7 m across, against clouds 245
 * to 1,206 m wide. Pinned in `tests/unit/cloud-shadow.test.ts`.
 */
export const CLOUD_SHADOW_MAP_MAX = 1024

/** The finest texel the raster will use, metres. A cloud is hundreds of metres across. */
export const CLOUD_SHADOW_MIN_TEXEL = 2

/** Empty texels around the projected sky, so a clamped lookup reads empty. */
export const CLOUD_SHADOW_MARGIN = 2

/** `.g` where no cloud stands on the ray: far below anything that draws. */
export const CLOUD_TOP_NONE = -1e4

/**
 * METRES below a cloud's top a fragment must be before the cloud shades it.
 *
 * The top channel is filtered bilinearly across texels whose tops differ, and
 * the receivers this matters for (the ship and the cockpit, flying past a
 * cloud's flank) are metres across, so a few metres of slack is invisible on
 * them and keeps a fragment level with a cloud's crown from flickering.
 * Not a preset number: it decides where a threshold sits, not how anything
 * looks.
 */
export const CLOUD_TOP_BIAS = 4

/** METRES over which a fragment rising past a cloud's top comes out of its shadow. */
export const CLOUD_TOP_SOFT = 6

/**
 * Whether the term runs, from the live preset (`vr.disable` already folded in).
 * Every quality tier: one fetch per lit fragment, and Matt asked for it in the
 * headset by name.
 */
export const cloudShadowEnabled = (edition: Edition): boolean =>
  edition.render.cloudShadow.enabled && edition.render.cloudShadow.strength > 0

/**
 * The unit vector toward the sun, three space, from a level's light.
 * `SunLight.direction` is where light TRAVELS. Null for no sun or a sun at or
 * below the horizon, where there is nothing to project along.
 */
export const towardSunOf = (
  sun: Pick<SunLight, 'direction'> | null,
): [number, number, number] | null => {
  if (!sun) return null
  const [x, y, z] = sun.direction
  const len = Math.hypot(x, y, z)
  if (!(len > 0)) return null
  const t: [number, number, number] = [-x / len, -y / len, -z / len]
  return t[1] > 0 ? t : null
}

/**
 * How much of the term survives at this sun, 0..1: 0 at or below
 * `minElevationDeg`, 1 from twice it up, a smoothstep between. A minimum of
 * zero or less means no fade above the horizon.
 */
export const cloudShadowFade = (towardSunY: number, minElevationDeg: number): number => {
  if (!(towardSunY > 0)) return 0
  const elevation = (Math.asin(Math.min(towardSunY, 1)) * 180) / Math.PI
  if (!(minElevationDeg > 0)) return 1
  const t = Math.min(Math.max((elevation - minElevationDeg) / minElevationDeg, 0), 1)
  return t * t * (3 - 2 * t)
}

/** One cloud as the raster needs it: where 2016 put it, and its unit blob. */
export interface CloudShadowHull {
  readonly placement: Pick<CloudPlacement, 'pos' | 'quat' | 'scale'>
  /** The generator's triangle soup, 9 floats a triangle, in the blob's own frame. */
  readonly positions: Float32Array
}

/** The projected, rasterised sky. Everything the shader and the JS mirror read. */
export interface CloudShadowRaster {
  /** Texels along the sun (u) and across it (v). */
  readonly width: number
  readonly height: number
  /** Interleaved (coverage 0 or 1, top metres), `2 * width * height` floats, row-major in v. */
  readonly data: Float32Array
  /** Horizontal toward-sun over toward-sun y: the projection is `xz - y * k`. */
  readonly k: readonly [number, number]
  /** Unit, horizontal: the way the sun's light travels (u) and its left-hand perpendicular (v). */
  readonly dirU: readonly [number, number]
  readonly dirV: readonly [number, number]
  /** The u and v of the map's corner, metres in the projected plane. */
  readonly u0: number
  readonly v0: number
  /** Metres per texel along each axis. */
  readonly texelU: number
  readonly texelV: number
  /** Triangles drawn, for the report. */
  readonly triangles: number
}

/** Rotate v by a unit quaternion (x, y, z, w). Written out so the raster allocates nothing per vertex. */
const rotate = (
  q: readonly number[],
  vx: number,
  vy: number,
  vz: number,
  out: Float64Array,
): void => {
  const qx = q[0] as number
  const qy = q[1] as number
  const qz = q[2] as number
  const qw = q[3] as number
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  out[0] = vx + qw * tx + (qy * tz - qz * ty)
  out[1] = vy + qw * ty + (qz * tx - qx * tz)
  out[2] = vz + qw * tz + (qx * ty - qy * tx)
}

/**
 * Every hull vertex in WORLD space, under the placement settings in force,
 * with no wind (the wind is the shader's offset). 3 floats a vertex, in the
 * soups' own triangle order.
 */
export const cloudWorldVertices = (
  hulls: readonly CloudShadowHull[],
  settings: CloudPlacementSettings,
): Float64Array[] => {
  const m = settings.scaleMultiplier
  const r = new Float64Array(3)
  return hulls.map(({ placement, positions }) => {
    const out = new Float64Array(positions.length)
    const sx = (placement.scale[0] as number) * m
    const sy = (placement.scale[1] as number) * m
    const sz = (placement.scale[2] as number) * m
    const px = placement.pos[0] as number
    const py = (placement.pos[1] as number) + settings.altitudeLift
    const pz = placement.pos[2] as number
    for (let i = 0; i + 2 < positions.length; i += 3) {
      rotate(
        placement.quat,
        (positions[i] as number) * sx,
        (positions[i + 1] as number) * sy,
        (positions[i + 2] as number) * sz,
        r,
      )
      out[i] = px + (r[0] as number)
      out[i + 1] = py + (r[1] as number)
      out[i + 2] = pz + (r[2] as number)
    }
    return out
  })
}

/**
 * Project the clouds along the sun onto y = 0 and rasterise them. Null when
 * there is nothing to project (no clouds, or no sun above the horizon).
 *
 * The map's axes are the sun's own, u along its horizontal travel and v across
 * it, because at a low sun the projected sky is many times longer than it is
 * wide and a world-aligned square would spend its texels on the wrong axis.
 * Each axis is sized to the projected extent on its own, capped at `maxTexels`
 * and floored at `CLOUD_SHADOW_MIN_TEXEL` metres a texel.
 *
 * A texel is covered when its centre is inside any projected triangle, and its
 * top is the highest point of any such triangle there (the triangle's own
 * heights interpolated at the centre). Then empty texels next to covered ones
 * take their neighbours' top, twice over, so the bilinear filter at an edge
 * mixes two real heights rather than a height and `CLOUD_TOP_NONE`.
 */
export const rasterCloudShadow = (
  hulls: readonly CloudShadowHull[],
  settings: CloudPlacementSettings,
  towardSun: readonly [number, number, number],
  maxTexels: number = CLOUD_SHADOW_MAP_MAX,
): CloudShadowRaster | null => {
  const ly = towardSun[1]
  if (!(ly > 0) || hulls.length === 0) return null
  const k: [number, number] = [towardSun[0] / ly, towardSun[2] / ly]
  const hl = Math.hypot(towardSun[0], towardSun[2])
  // The light travels AWAY from the sun; overhead, any axis will do.
  const dirU: [number, number] = hl > 1e-9 ? [-towardSun[0] / hl, -towardSun[2] / hl] : [1, 0]
  const dirV: [number, number] = [-dirU[1], dirU[0]]

  const world = cloudWorldVertices(hulls, settings)
  // Projected (u, v) and height per vertex, and the extent.
  let uMin = Number.POSITIVE_INFINITY
  let uMax = Number.NEGATIVE_INFINITY
  let vMin = Number.POSITIVE_INFINITY
  let vMax = Number.NEGATIVE_INFINITY
  const projected = world.map((w) => {
    const out = new Float64Array(w.length)
    for (let i = 0; i + 2 < w.length; i += 3) {
      const y = w[i + 1] as number
      const qx = (w[i] as number) - y * k[0]
      const qz = (w[i + 2] as number) - y * k[1]
      const u = qx * dirU[0] + qz * dirU[1]
      const v = qx * dirV[0] + qz * dirV[1]
      out[i] = u
      out[i + 1] = v
      out[i + 2] = y
      if (u < uMin) uMin = u
      if (u > uMax) uMax = u
      if (v < vMin) vMin = v
      if (v > vMax) vMax = v
    }
    return out
  })
  if (!Number.isFinite(uMin) || !Number.isFinite(vMin)) return null

  const margin = CLOUD_SHADOW_MARGIN
  const cap = Math.max(maxTexels, 2 * margin + 2)
  const size = (extent: number): { texel: number; n: number } => {
    const texel = Math.max(CLOUD_SHADOW_MIN_TEXEL, extent / (cap - 2 * margin))
    return { texel, n: Math.min(cap, Math.ceil(extent / texel) + 2 * margin) }
  }
  const su = size(uMax - uMin)
  const sv = size(vMax - vMin)
  const width = su.n
  const height = sv.n
  const u0 = uMin - margin * su.texel
  const v0 = vMin - margin * sv.texel
  const cov = new Uint8Array(width * height)
  const top = new Float32Array(width * height).fill(Number.NEGATIVE_INFINITY)

  let triangles = 0
  for (const p of projected) {
    for (let t = 0; t + 8 < p.length; t += 9) {
      // Texel space: texel (i, j)'s centre is at (i, j).
      const ax = ((p[t] as number) - u0) / su.texel - 0.5
      const ay = ((p[t + 1] as number) - v0) / sv.texel - 0.5
      const bx = ((p[t + 3] as number) - u0) / su.texel - 0.5
      const by = ((p[t + 4] as number) - v0) / sv.texel - 0.5
      const cx = ((p[t + 6] as number) - u0) / su.texel - 0.5
      const cy = ((p[t + 7] as number) - v0) / sv.texel - 0.5
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
      // Edge-on to the sun: no area in the projection, nothing to cover.
      if (Math.abs(area) < 1e-12) continue
      triangles++
      const ha = p[t + 2] as number
      const hb = p[t + 5] as number
      const hc = p[t + 8] as number
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)))
      const i1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)))
      const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy)))
      const j1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy)))
      const inv = 1 / area
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          // Barycentrics; sign-normalised by the area so winding does not matter.
          const wa = ((bx - i) * (cy - j) - (by - j) * (cx - i)) * inv
          const wb = ((cx - i) * (ay - j) - (cy - j) * (ax - i)) * inv
          const wc = 1 - wa - wb
          if (wa < 0 || wb < 0 || wc < 0) continue
          const idx = j * width + i
          cov[idx] = 1
          const h = wa * ha + wb * hb + wc * hc
          if (h > (top[idx] as number)) top[idx] = h
        }
      }
    }
  }

  // Dilate the tops into the empty ring, twice.
  for (let pass = 0; pass < 2; pass++) {
    const next = top.slice()
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i
        if (Number.isFinite(top[idx] as number)) continue
        let best = Number.NEGATIVE_INFINITY
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= height) continue
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            if (ii < 0 || ii >= width) continue
            const h = top[jj * width + ii] as number
            if (h > best) best = h
          }
        }
        next[idx] = best
      }
    }
    top.set(next)
  }

  const data = new Float32Array(2 * width * height)
  for (let idx = 0; idx < width * height; idx++) {
    data[2 * idx] = cov[idx] as number
    const h = top[idx] as number
    data[2 * idx + 1] = Number.isFinite(h) ? h : CLOUD_TOP_NONE
  }
  return {
    width,
    height,
    data,
    k,
    dirU,
    dirV,
    u0,
    v0,
    texelU: su.texel,
    texelV: sv.texel,
    triangles,
  }
}

/**
 * Where a WORLD point looks up in the map, as uv, under a wind of `drift`.
 * The shader's arithmetic in JS, for the tests and the report: `uv = M q + o`
 * with `q = xz - y k - (drift.xz - drift.y k)`.
 */
export const cloudShadowUv = (
  r: CloudShadowRaster,
  p: readonly [number, number, number],
  drift: readonly [number, number, number] = [0, 0, 0],
): [number, number] => {
  const qx = p[0] - p[1] * r.k[0] - (drift[0] - drift[1] * r.k[0])
  const qz = p[2] - p[1] * r.k[1] - (drift[2] - drift[1] * r.k[1])
  const u = qx * r.dirU[0] + qz * r.dirU[1]
  const v = qx * r.dirV[0] + qz * r.dirV[1]
  return [(u - r.u0) / (r.width * r.texelU), (v - r.v0) / (r.height * r.texelV)]
}

/** Bilinear, clamp-to-edge, the way the GPU reads an RG16F map with LinearFilter. */
const sample = (r: CloudShadowRaster, uv: readonly [number, number]): [number, number] => {
  const x = Math.min(Math.max(uv[0] * r.width - 0.5, 0), r.width - 1)
  const y = Math.min(Math.max(uv[1] * r.height - 0.5, 0), r.height - 1)
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const i1 = Math.min(i0 + 1, r.width - 1)
  const j1 = Math.min(j0 + 1, r.height - 1)
  const fx = x - i0
  const fy = y - j0
  const at = (i: number, j: number, c: number) => r.data[2 * (j * r.width + i) + c] as number
  const mix = (c: number) =>
    (at(i0, j0, c) * (1 - fx) + at(i1, j0, c) * fx) * (1 - fy) +
    (at(i0, j1, c) * (1 - fx) + at(i1, j1, c) * fx) * fy
  return [mix(0), mix(1)]
}

/**
 * Is a WORLD point in a cloud's shadow? The shader's verdict without its
 * anti-aliasing: covered past the threshold AND below the cloud's top by the
 * bias. For the tests, which hold it against a ray march through the hulls.
 */
export const inCloudShadow = (
  r: CloudShadowRaster,
  p: readonly [number, number, number],
  drift: readonly [number, number, number] = [0, 0, 0],
): boolean => {
  const [c, t] = sample(r, cloudShadowUv(r, p, drift))
  return c > 0.5 && t + drift[1] - p[1] - CLOUD_TOP_BIAS > 0
}

// ── the shader ───────────────────────────────────────────────────────────

/**
 * Spliced into `render/far-shadow.ts`'s prelude after `vFf2SunWorld` is
 * declared and before `ff2SunHeightTerm`, which calls it. Line comments only
 * and no backticks: far-shadow's test strips line comments before sweeping its
 * GLSL for reserved words, and this text lives inside a template literal.
 */
export const CLOUD_SHADOW_GLSL = `
// DEV-585. The clouds projected along the sun onto y = 0: .r coverage, .g the
// highest cloud on that sun ray (render/cloud-shadow.ts has the mechanism).
uniform sampler2D uFf2CloudMap;
// (k.x, k.z, wind.x, wind.z): the projection is xz - y k, less the wind's own
// projection, which is what moves the shadow without redrawing the map.
uniform vec4 uFf2CloudA;
// The map's axes over its extent: (u axis / u extent, v axis / v extent).
uniform vec4 uFf2CloudB;
// (u origin, v origin, strength times the sun fade or 0 for off, wind y).
uniform vec4 uFf2CloudC;
// (top bias metres, top soft metres, 0, 0).
uniform vec4 uFf2CloudD;
float ff2CloudShadowTerm() {
  #ifdef FF2_NO_CLOUD_SHADOW
    return 1.0;
  #endif
  vec2 ff2CloudQ = vFf2SunWorld.xz - vFf2SunWorld.y * uFf2CloudA.xy - uFf2CloudA.zw;
  vec2 ff2CloudUv = vec2( dot( ff2CloudQ, uFf2CloudB.xy ), dot( ff2CloudQ, uFf2CloudB.zw ) ) + uFf2CloudC.xy;
  vec2 ff2CloudCt = texture2D( uFf2CloudMap, ff2CloudUv ).rg;
  // The fetch and both derivatives BEFORE the switch, as far-shadow's term does:
  // a derivative after a branch is the shape a compiler may refuse.
  float ff2CloudW = max( fwidth( ff2CloudCt.r ), 1e-3 );
  float ff2CloudD = ff2CloudCt.g + uFf2CloudC.w - vFf2SunWorld.y - uFf2CloudD.x;
  float ff2CloudWd = max( uFf2CloudD.y, fwidth( ff2CloudD ) );
  if ( uFf2CloudC.z <= 0.0 ) return 1.0;
  // Hard edged: the filtered coverage thresholded at one half, anti-aliased by
  // its own screen derivative, never blurred.
  float ff2CloudEdge = smoothstep( 0.5 - ff2CloudW, 0.5 + ff2CloudW, ff2CloudCt.r );
  float ff2CloudAhead = smoothstep( 0.0, ff2CloudWd, ff2CloudD );
  return 1.0 - uFf2CloudC.z * ff2CloudEdge * ff2CloudAhead;
}
`

/** The uniform block `CLOUD_SHADOW_GLSL` reads. One object, so one write reaches every program. */
export interface CloudShadowUniforms {
  readonly uFf2CloudMap: { value: THREE.Texture }
  readonly uFf2CloudA: { value: THREE.Vector4 }
  readonly uFf2CloudB: { value: THREE.Vector4 }
  readonly uFf2CloudC: { value: THREE.Vector4 }
  readonly uFf2CloudD: { value: THREE.Vector4 }
}

const emptyMap = (): THREE.DataTexture => {
  const t = new THREE.DataTexture(
    new Uint16Array([0, THREE.DataUtils.toHalfFloat(CLOUD_TOP_NONE)]),
    1,
    1,
    THREE.RGFormat,
    THREE.HalfFloatType,
  )
  t.needsUpdate = true
  return t
}

/**
 * A block built OFF (`uFf2CloudC.z` 0), with a one-texel empty map, so a
 * program compiled before any mission has its sampler bound and reads lit.
 */
export const createCloudShadowUniforms = (): CloudShadowUniforms => ({
  uFf2CloudMap: { value: emptyMap() },
  uFf2CloudA: { value: new THREE.Vector4(0, 0, 0, 0) },
  uFf2CloudB: { value: new THREE.Vector4(0, 0, 0, 0) },
  uFf2CloudC: { value: new THREE.Vector4(0, 0, 0, 0) },
  uFf2CloudD: { value: new THREE.Vector4(CLOUD_TOP_BIAS, CLOUD_TOP_SOFT, 0, 0) },
})

/** Write a raster's geometry into the block. The map and the switch are the caller's. */
export const writeCloudShadowFrame = (u: CloudShadowUniforms, r: CloudShadowRaster): void => {
  const eu = r.width * r.texelU
  const ev = r.height * r.texelV
  u.uFf2CloudB.value.set(r.dirU[0] / eu, r.dirU[1] / eu, r.dirV[0] / ev, r.dirV[1] / ev)
  u.uFf2CloudC.value.x = -r.u0 / eu
  u.uFf2CloudC.value.y = -r.v0 / ev
  u.uFf2CloudA.value.x = r.k[0]
  u.uFf2CloudA.value.y = r.k[1]
}

/** Write the wind: the offset of the projection, and of the tops. */
export const writeCloudShadowDrift = (
  u: CloudShadowUniforms,
  r: Pick<CloudShadowRaster, 'k'>,
  drift: readonly [number, number, number],
): void => {
  u.uFf2CloudA.value.z = drift[0] - drift[1] * r.k[0]
  u.uFf2CloudA.value.w = drift[2] - drift[1] * r.k[1]
  u.uFf2CloudC.value.w = drift[1]
}

/** Half-float encode a raster's (coverage, top) pairs, one RG16F texel each. */
export const encodeCloudShadow = (r: CloudShadowRaster): Uint16Array => {
  const out = new Uint16Array(r.data.length)
  for (let i = 0; i < r.data.length; i++) out[i] = THREE.DataUtils.toHalfFloat(r.data[i] as number)
  return out
}

// ── the live system ──────────────────────────────────────────────────────

/** What the term reads off a loaded cloud field. `LoadedClouds` satisfies it. */
export interface CloudShadowSource {
  readonly group: THREE.Object3D
  readonly hulls: readonly CloudShadowHull[]
  /** The scale and lift in force right now. Compared every frame; a change rebuilds the map. */
  readonly placementInForce: CloudPlacementSettings
  /** Where the wind has got to, metres, three space. */
  readonly driftInForce: readonly [number, number, number]
}

/** For the console, the tests and the DEVIATIONS row. */
export interface CloudShadowReport {
  readonly on: boolean
  readonly clouds: number
  readonly sunElevationDeg: number | null
  /** `strength x fade`: what multiplies the occlusion right now. */
  readonly weight: number
  readonly texels: readonly [number, number] | null
  readonly texelMetres: readonly [number, number] | null
  readonly triangles: number
  readonly rasterMs: number
}

export interface CloudShadow {
  /** Hand to `createFarShadow`, which splices `CLOUD_SHADOW_GLSL` and binds these. */
  readonly uniforms: CloudShadowUniforms
  /**
   * A mission's clouds and its sun, or `null` when the world goes. Marks the
   * clouds' own material as a non-receiver and builds the map now if the
   * preset wants it.
   */
  setClouds(clouds: CloudShadowSource | null, sun: Pick<SunLight, 'direction'> | null): void
  /** Once a frame, after the clouds' own `update`: the wind, and a rebuild if the placement moved. */
  update(): void
  readonly report: CloudShadowReport
  dispose(): void
}

/** `strength x fade` for the live preset and sun, 0 when off. */
export const cloudShadowWeight = (
  shadow: Pick<EditionCloudShadow, 'enabled' | 'strength' | 'minSunElevation'>,
  towardSun: readonly [number, number, number] | null,
): number => {
  if (!shadow.enabled || !towardSun) return 0
  const s = Math.min(Math.max(shadow.strength, 0), 1)
  return s * cloudShadowFade(towardSun[1], shadow.minSunElevation)
}

const placementKey = (s: CloudPlacementSettings): string => `${s.scaleMultiplier}|${s.altitudeLift}`

const nowMs = (): number => (typeof performance === 'undefined' ? 0 : performance.now())

export const createCloudShadow = (editionState: EditionState): CloudShadow => {
  const uniforms = createCloudShadowUniforms()
  const placeholder = uniforms.uFf2CloudMap.value
  let source: CloudShadowSource | null = null
  let towardSun: [number, number, number] | null = null
  let raster: CloudShadowRaster | null = null
  let texture: THREE.DataTexture | null = null
  let builtFor: string | null = null
  let weight = 0
  let rasterMs = 0

  const dropMap = (): void => {
    texture?.dispose()
    texture = null
    raster = null
    builtFor = null
    uniforms.uFf2CloudMap.value = placeholder
  }

  const build = (): void => {
    if (!source || !towardSun) return
    const key = placementKey(source.placementInForce)
    if (builtFor === key && raster) return
    dropMap()
    const t0 = nowMs()
    raster = rasterCloudShadow(source.hulls, source.placementInForce, towardSun)
    rasterMs = nowMs() - t0
    builtFor = key
    if (!raster) return
    texture = new THREE.DataTexture(
      encodeCloudShadow(raster),
      raster.width,
      raster.height,
      THREE.RGFormat,
      THREE.HalfFloatType,
    )
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.generateMipmaps = false
    texture.needsUpdate = true
    uniforms.uFf2CloudMap.value = texture
    writeCloudShadowFrame(uniforms, raster)
    writeCloudShadowDrift(uniforms, raster, source.driftInForce)
  }

  /** The switch: built lazily the first time the preset wants it, so Classic never rasterises. */
  const apply = (): void => {
    weight = source ? cloudShadowWeight(editionState.current.render.cloudShadow, towardSun) : 0
    // Built here only the first time; a placement that moved under a built map
    // is `update`'s, which runs after the clouds' own subscriber has moved it.
    if (weight > 0 && !raster) build()
    const live = weight > 0 && raster !== null && source?.group.visible !== false
    uniforms.uFf2CloudC.value.z = live ? weight : 0
  }

  const unsubscribe = editionState.subscribe(apply)

  const self: CloudShadow = {
    uniforms,
    setClouds(clouds, sun) {
      dropMap()
      source = clouds
      towardSun = clouds ? towardSunOf(sun) : null
      if (clouds) {
        // The clouds never receive their own shadow; see the header. A define on
        // their one shared material, ADDED once and never removed (DEV-194), and
        // set before the material's first compile, so it costs no program.
        forEachMeshMaterial(clouds.group, (m) => {
          if (!m.defines) m.defines = {}
          const defines = m.defines as Record<string, unknown>
          if (!Object.hasOwn(defines, NO_CLOUD_SHADOW_DEFINE)) {
            defines[NO_CLOUD_SHADOW_DEFINE] = ''
            m.needsUpdate = true
          }
        })
      }
      apply()
      if (clouds && raster) {
        const r = self.report
        console.info(
          `cloud shadow: ${r.clouds} clouds, ${r.texels?.[0]}x${r.texels?.[1]} texels at ` +
            `${r.texelMetres?.[0].toFixed(1)} x ${r.texelMetres?.[1].toFixed(1)} m, ` +
            `${r.triangles} triangles in ${r.rasterMs.toFixed(0)} ms, sun ` +
            `${r.sunElevationDeg?.toFixed(2)} deg, weight ${r.weight.toFixed(2)}`,
        )
      }
    },
    update() {
      if (!source) return
      if (weight > 0 && builtFor !== placementKey(source.placementInForce)) {
        build()
      }
      const live = weight > 0 && raster !== null && source.group.visible !== false
      uniforms.uFf2CloudC.value.z = live ? weight : 0
      if (live && raster) writeCloudShadowDrift(uniforms, raster, source.driftInForce)
    },
    get report(): CloudShadowReport {
      return {
        on: uniforms.uFf2CloudC.value.z > 0,
        clouds: source?.hulls.length ?? 0,
        sunElevationDeg: towardSun ? (Math.asin(towardSun[1]) * 180) / Math.PI : null,
        weight,
        texels: raster ? ([raster.width, raster.height] as const) : null,
        texelMetres: raster ? ([raster.texelU, raster.texelV] as const) : null,
        triangles: raster?.triangles ?? 0,
        rasterMs,
      }
    },
    dispose() {
      unsubscribe()
      dropMap()
      placeholder.dispose()
    },
  }
  return self
}
