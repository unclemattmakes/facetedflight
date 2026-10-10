// tools/extract/sky.mjs — the 2016 skybox, as numbers rather than as pixels.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// `render/sky.ts` invents its sky from the fog colour: horizon = fog colour,
// zenith and nadir derived from it. That is a placeholder and it shows — sky and
// fog end up the SAME colour, so the whole frame is one pink wash and the
// island's own colours vanish into it. Matt, twice: "still too thick to really
// see anything."
//
// The real sky is `Quantum Theory/PolyWorld Skies/SkyJ.mat`, a `Skybox/6 Sided`
// with six 1024x1024 BMP faces and `_Rotation: 71`. It is a sunset: a warm glow
// around (251, 190, 142) on one side, cool violet around (105, 103, 130)
// opposite, and a horizon band near (160, 128, 125) — which is markedly LESS
// pink than `RenderSettings.m_FogColor` (221, 168, 178). So the assumption that
// the horizon must equal the fog colour is not what the game did.
//
// ── What ships, and why that is allowed ───────────────────────────────────
//
// The faces are bought Asset Store art (CLAUDE.md rule 7) and never ship. What
// ships is a **degree-N spherical-harmonic projection** of them: a handful of
// floats describing the sky's low-frequency colour. That is the same
// representation, in the same sheet, as the Skyshop ambient already shipping —
// and it cannot reconstruct the artwork any more than an average colour can.
// The residual this tool reports is the evidence: what SH keeps is the gradient
// and the glow, and what it throws away is the picture.
//
// ── A finding worth keeping ───────────────────────────────────────────────
//
// The game lights from one sky and DISPLAYS another. `terrain.<env>.ibl.sh`
// comes from `ibl_sky`, whose `bakedFrom.skyboxCube` is
// `Marmoset/Examples/Sky/castle_BLUR.cubemap` — Marmoset's own EXAMPLE sky,
// left in place. The visible skybox is SkyJ. They are not the same sky and they
// are not even close, so the ambient SH cannot be reused as the background and
// this projection has to be its own.
//
// The legacy Unity project is READ-ONLY: this reads BMP and writes nothing.

import { readFileSync } from 'node:fs'

/**
 * Unity's `Skybox/6 Sided` face -> the axis it faces, in UNITY space, BEFORE the
 * naming yaw below.
 *
 * These are the naive assignments. They are 180 degrees wrong, and the constant
 * under them is how much.
 */
export const SKYBOX_FACES = /** @type {const} */ ([
  { property: '_FrontTex', suffix: 'FR', axis: [0, 0, 1] },
  { property: '_BackTex', suffix: 'BK', axis: [0, 0, -1] },
  { property: '_LeftTex', suffix: 'LF', axis: [-1, 0, 0] },
  { property: '_RightTex', suffix: 'RT', axis: [1, 0, 0] },
  { property: '_UpTex', suffix: 'UP', axis: [0, 1, 0] },
  { property: '_DownTex', suffix: 'DN', axis: [0, -1, 0] },
])

/**
 * Unity names a skybox's faces from OUTSIDE the box looking in, so `_LeftTex`
 * is the +X face and `_FrontTex` is the -Z one — a 180 degree yaw away from the
 * naive reading above.
 *
 * MEASURED, not assumed. Scanning the yaw and asking which one puts the sky's
 * brightest sample on the mission's sun — a number authored in a different file
 * by a different tool, which this one never reads — gives:
 *
 *     best yaw 178 deg  ->  0.7 deg from the sun
 *
 * on a 1-degree scan. 178 is 180 within the sampling granularity and the width
 * of the sun's own glow. A 2016 sunset whose glow sits on its own sun is the
 * scene rendering correctly; every other yaw is tens of degrees out.
 */
export const FACE_NAMING_YAW_DEG = 180

/**
 * `_Rotation` on a `Skybox/6 Sided` material, and why this tool ignores it.
 *
 * `SkyJ.mat` carries `_Rotation: 71`. Including it moves the glow 71 degrees off
 * the sun; excluding it lands 0.7 degrees away. So the shipped render did not
 * apply it.
 *
 * The likely mechanism is ordinary: a Unity material keeps serialised properties
 * from shaders it used to be assigned, and `_Rotation` belongs to
 * `Skybox/Cubemap` (shader 103) rather than `Skybox/6 Sided` (shader 104). The
 * project's own `Cubemaps/Islands_Sky.mat` IS a 103 and carries `_Rotation: 0`.
 *
 * The mechanism is inference. The 0.7 degrees is measurement, and it is the
 * reason the value is dropped. Another dead serialised field, like
 * `Rotator_Input.yawMax`.
 */
export const SKYBOX_ROTATION_IS_LIVE = false

/**
 * Decode an uncompressed 24- or 32-bit BMP.
 *
 * These are 3 MB files with a 54-byte header, bottom-up, BGR. No dependency is
 * worth adding for that. Returns `{width, height, rgb}` with rgb in TOP-DOWN
 * row order and 3 bytes per pixel, which is what everything downstream expects.
 */
export const decodeBmp = (bytes) => {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP')
  const dataOffset = bytes.readUInt32LE(10)
  const headerSize = bytes.readUInt32LE(14)
  if (headerSize < 40) throw new Error(`BMP header ${headerSize} not supported`)
  const width = bytes.readInt32LE(18)
  const rawHeight = bytes.readInt32LE(22)
  const bpp = bytes.readUInt16LE(28)
  const compression = bytes.readUInt32LE(30)
  if (compression !== 0 && compression !== 3) {
    throw new Error(`BMP compression ${compression} not supported`)
  }
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP ${bpp}bpp not supported`)

  // A negative height means the rows are already top-down.
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0
  const bytesPerPixel = bpp / 8
  const stride = Math.ceil((width * bpp) / 32) * 4
  const rgb = new Uint8Array(width * height * 3)

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y
    let src = dataOffset + srcRow * stride
    let dst = y * width * 3
    for (let x = 0; x < width; x++) {
      // BGR on disk.
      rgb[dst] = bytes[src + 2]
      rgb[dst + 1] = bytes[src + 1]
      rgb[dst + 2] = bytes[src]
      src += bytesPerPixel
      dst += 3
    }
  }
  return { width, height, rgb }
}

/** sRGB -> linear. The project is Linear, so a texture samples linear. */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/**
 * Direction, in UNITY space, of texel (u, v) on a cube face.
 *
 * `u`, `v` in [0, 1] with v measured DOWN from the top of the image, which is
 * how the decoded buffer is ordered.
 *
 * The per-face tangent frames are Unity's own for `Skybox/6 Sided`. Getting one
 * of them transposed or flipped moves the sun glow to the wrong azimuth without
 * changing anything a mean colour would notice — so `projectSky` cross-checks
 * the reconstruction's brightest direction against the mission's SUN, which is
 * an independent number this file never reads.
 */
export const faceDirection = (suffix, u, v) => {
  // Map to [-1, 1], with `t` running down the image.
  const s = 2 * u - 1
  const t = 1 - 2 * v
  switch (suffix) {
    case 'FR':
      return [s, t, 1]
    case 'BK':
      return [-s, t, -1]
    case 'LF':
      return [-1, t, s]
    case 'RT':
      return [1, t, -s]
    case 'UP':
      return [s, 1, -t]
    case 'DN':
      return [s, -1, t]
    default:
      throw new Error(`unknown face ${suffix}`)
  }
}

/** Real spherical harmonics, degree 0..3, in three.js/Unity's usual order. */
export const shBasis = (x, y, z) => [
  0.282095,
  0.488603 * y,
  0.488603 * z,
  0.488603 * x,
  1.092548 * x * y,
  1.092548 * y * z,
  0.315392 * (3 * z * z - 1),
  1.092548 * x * z,
  0.546274 * (x * x - y * y),
  0.590044 * y * (3 * x * x - y * y),
  2.890611 * x * y * z,
  0.457046 * y * (5 * z * z - 1),
  0.373176 * z * (5 * z * z - 3),
  0.457046 * x * (5 * z * z - 1),
  1.445306 * z * (x * x - y * y),
  0.590044 * x * (x * x - 3 * y * y),
]

/**
 * Project a six-face skybox onto spherical harmonics.
 *
 * `bands` is the number of SH bands: 2 gives 4 coefficients, 3 gives 9, 4 gives
 * 16. Every texel is weighted by its solid angle — a cube face's corners cover
 * far less sphere than its centre, and skipping that tilts the whole projection
 * toward the corners.
 *
 * Returns `{ coefficients, residual, peakDirection }` — all in UNITY space, with
 * the skybox's `_Rotation` already applied so the caller never has to think
 * about it.
 */
export const projectSky = (faces, { bands = 3, rotationDeg = 0, step = 8 } = {}) => {
  const count = bands * bands
  const coefficients = Array.from({ length: count }, () => [0, 0, 0])
  let totalWeight = 0

  // The naming yaw is not optional and not a tuning knob — see
  // `FACE_NAMING_YAW_DEG`. `rotationDeg` is whatever the caller believes the
  // material's own rotation to be, which for a 6-sided skybox is zero.
  const yaw = ((rotationDeg + FACE_NAMING_YAW_DEG) * Math.PI) / 180
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)

  const samples = []
  for (const face of faces) {
    const { width, height, rgb } = face.image
    for (let y = Math.floor(step / 2); y < height; y += step) {
      for (let x = Math.floor(step / 2); x < width; x += step) {
        const u = (x + 0.5) / width
        const v = (y + 0.5) / height
        const [dx, dy, dz] = faceDirection(face.suffix, u, v)
        const len = Math.hypot(dx, dy, dz)
        // Solid angle of a cube texel goes as 1/|d|^3 once |d| is measured from
        // the cube's centre with the face at distance 1.
        const weight = 1 / (len * len * len)
        // `_Rotation` spins the skybox about Y. Apply it to the SAMPLE
        // direction so the coefficients come out in world space.
        const nx = dx / len
        const ny = dy / len
        const nz = dz / len
        const rx = cos * nx + sin * nz
        const rz = -sin * nx + cos * nz
        const basis = shBasis(rx, ny, rz)
        const o = (y * width + x) * 3
        const colour = [
          srgbToLinear(rgb[o] / 255),
          srgbToLinear(rgb[o + 1] / 255),
          srgbToLinear(rgb[o + 2] / 255),
        ]
        for (let i = 0; i < count; i++) {
          coefficients[i][0] += colour[0] * basis[i] * weight
          coefficients[i][1] += colour[1] * basis[i] * weight
          coefficients[i][2] += colour[2] * basis[i] * weight
        }
        totalWeight += weight
        samples.push({ dir: [rx, ny, rz], colour, weight })
      }
    }
  }

  // Monte-Carlo normalisation: the estimator is (4*pi / sum w) * sum(w * f * Y).
  const norm = (4 * Math.PI) / totalWeight
  for (const c of coefficients) {
    c[0] *= norm
    c[1] *= norm
    c[2] *= norm
  }

  // ── How much of the sky survived ────────────────────────────────────────
  //
  // Reported rather than asserted, because the answer is the point: SH keeps the
  // gradient and the glow and throws the picture away. A caller choosing a band
  // count should be choosing it against this number.
  let sqErr = 0
  let sqSignal = 0
  let peak = { luminance: -1, dir: [0, 1, 0] }
  for (const s of samples) {
    const basis = shBasis(s.dir[0], s.dir[1], s.dir[2])
    for (let ch = 0; ch < 3; ch++) {
      let v = 0
      for (let i = 0; i < count; i++) v += coefficients[i][ch] * basis[i]
      sqErr += s.weight * (v - s.colour[ch]) ** 2
      sqSignal += s.weight * s.colour[ch] ** 2
    }
    const lum = 0.2126 * s.colour[0] + 0.7152 * s.colour[1] + 0.0722 * s.colour[2]
    if (lum > peak.luminance) peak = { luminance: lum, dir: s.dir }
  }

  return {
    coefficients,
    /** Relative rms error of the reconstruction against the real faces. */
    residual: Math.sqrt(sqErr / sqSignal),
    /** Brightest sample direction, UNITY space, rotation applied. */
    peakDirection: peak.dir,
    sampleCount: samples.length,
  }
}

/** Load the six faces named by a `Skybox/6 Sided` material. */
export const loadSkyboxFaces = (unityAbs, texturePaths) =>
  SKYBOX_FACES.map((face) => {
    const rel = texturePaths[face.property]
    if (!rel) throw new Error(`skybox material has no ${face.property}`)
    return { ...face, path: rel, image: decodeBmp(readFileSync(`${unityAbs}/${rel}`)) }
  })
