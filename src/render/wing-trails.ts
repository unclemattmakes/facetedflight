// src/render/wing-trails.ts — two thin ribbons off each HoverJet's wing tips,
// every craft in ONE draw. DEV-358.
//
// Matt, 2026-09-24, on third person: *"particle trails on the wing-tips once
// we're at a decent speed (show them on the ai racers as well)."* How strongly
// they draw is `game/wing-trail-fade.ts`; this is where they come from and how
// they are drawn.
//
// ── Where the tips ARE: measured off the hull, never typed ───────────────
//
// `measureWingTips` reads the loaded exterior hull. The planform (x across, z
// fore and aft, ship frame) is a swept wing whose outermost vertex begins a
// short TIP CHORD running aft to the tip's trailing corner:
//
//     outermost vertex    port (-2.898, -0.288, 0.980)   starboard (2.886, -0.288, 0.840)
//     trailing corner     port (-2.719, -0.222, 2.048)   starboard (2.707, -0.222, 2.048)
//
// The trail leaves from the TRAILING CORNER, the aft end of the chord, for two
// reasons that agree. It is where the air leaves the wing, so a ribbon from
// there streams off the back of the tip instead of lying along its edge for a
// metre, depth-fighting the wing it came from. And it is the SYMMETRIC point:
// the two outermost vertices are 0.14 m apart fore and aft (the 2016 mesh is
// not quite mirror-symmetric there), while the two trailing corners sit at
// one height and one station, and their midpoint is x = -0.006 — which is
// `ART_POSITION.x`, the art's own offset from the ship's centreline, reached
// by a different road. `tests/unit/hover-glow.test.ts` measures the shipped
// GLB and holds all of it.
//
// The rule, so it cannot be "the vertex that happened to look right": take the
// CONVEX OUTLINE of the planform; each side's tip is its outermost outline
// vertex, and the trailing corner is the next outline vertex AFT of it. No
// tolerance, no band, no slab width. The wing's own colliders are no witness —
// the prefab's wing boxes stop about 0.9 m short of the art — so the mesh is
// the whole source.
//
// ── What a ribbon is ─────────────────────────────────────────────────────
//
// `render/trail.ts`'s legacy `TrailRenderer`, the same four rules: the head is
// pinned to the emitter; a point commits once the emitter has moved
// `minVertexDistance` from the last one; a point dies when its age passes
// `seconds`; the width runs `startWidth` -> `endWidth` with age. Camera-facing,
// world-space, identity transform. Three differences, the first two because
// this is VAPOUR and not an engine's glow:
//
//  * it WIDENS and FADES as it ages — alpha from `alpha` x the strength the
//    point was born with, to nothing at `seconds` — where the engine trail is
//    an opaque ribbon that tapers to a point;
//  * each point keeps the STRENGTH it was born at, so slowing through the
//    fade stops making vapour at the tips and lets what is already in the air
//    thin out behind, instead of switching the whole trail down at once;
//  * it fades out NEAR THE EYE (`nearFade`), so a ribbon passing through the
//    eye is not a line across the face. DEV-358 set this at 10 m to clear two
//    wide rails from the chase view's corners; the follow-up caps the WIDTH at
//    an angle instead (below), because at 10 m the fade also took the whole of
//    the player's own trail, which is all within ~7 m of the chase camera.
//
// ── It GLOWS, twice over: a hot core the bloom catches, and a halo that is
//    geometry, so a headset gets it too (DEV-358 follow-up) ──────────────
//
// Matt, after the first version: *"trails - lightly tinted each racer's own
// color it'd be great if they glowed."*
//
// Each point is FIVE vertices across, not two: the outer edge, the core's edge,
// the centre, and the other two. Their colours make the cross-section a glow:
//
//     alpha    0 ─── a ──────── a ──────── a ─── 0
//     colour       halo ──── core ──── halo
//     offset  -1    -core      0      +core    +1   (x half the width)
//
// The centre is `glow` times the tint — an HDR colour, above 1 — and the core's
// edge is `halo` of that. So:
//
//  * **On a monitor** the composer's target is half-float and keeps it above
//    1, and the bloom pass (threshold 1.0, `render.bloom`) catches the centre
//    line and spreads it. That is real glow, and it is the pass the ring studs
//    and the speed streaks already glow through.
//  * **In a headset** bloom never composites (`render/bloom.ts`, DEV-336), and
//    the HALO is what stays: a soft falloff built into the ribbon itself, with
//    no pass behind it, the same idea as DEV-336's stud halos done in the
//    ribbon's own triangles. The centre is tone-mapped per material there, so
//    `glow` 4 lands as near-white rather than clipping, over a halo that still
//    carries the tint.
//
// NORMAL blending, not additive, and on purpose. Inside the composer an HDR
// colour at alpha `a` lands as `a × glow + (1 - a) × background`, which clears
// the bloom threshold exactly as an additive one would. What additive would get
// WRONG is the fog: the fog's door mixes a colour toward the sky, and an
// additive ribbon mixed toward the sky ADDS the sky's colour at distance — a far
// racer's trail would become a pale line of fog, glowing through it. Blended
// normally, the fog swallows the trail exactly as it swallows the ship.
//
// ── Never wider than an angle at the eye ─────────────────────────────────
//
// `maxWidthDeg`: each vertex's width is capped at what subtends that angle
// from the eye. It is what makes the PLAYER's trails readable in third person.
// From the chase seat the tips are ~7 m ahead and the ribbon streams BACK past
// the camera, so its near end is 3-4 m from the eye: at the preset's world
// width that is a band 20-40 px wide from the frame's corners (DEV-358's first
// burst). DEV-358 answered with the near fade, which cleared the corners and
// also faded the whole of the player's trail, because all of it is within
// ~7 m of the eye — two faint lines nobody could see. The cap keeps the near
// end a thin, bright line instead, and the near fade shrinks to what it is for:
// a ribbon passing through the eye itself.
//
// ── One draw for every craft ─────────────────────────────────────────────
//
// Every ribbon a batch holds is written into ONE geometry, compacted, each
// frame, and drawn by one `MeshBasicMaterial`: the racers are one batch and one
// draw however many there are, and the player's ship is another. A batch with
// nothing to show is `visible = false`, which is no draw at all rather than a
// draw of zero triangles. `stats` says what it drew, for the tests.
//
// The material is unlit on purpose: a camera-facing strip has no normal worth
// lighting. Each craft's TINT is in its vertex colours (`setTint`), the glow is
// the material's colour, and it is tone-mapped as a thing in the world and
// taken through the fog's door by the caller. It glows because Matt asked it
// to: ART_DIRECTION's "a second exception costs a row", and DEV-358's
// follow-up is the row.

import * as THREE from 'three'

/** The look, off the preset (`fx.wingTrails`). Read every frame, so a flip lands at once. */
export interface WingTrailLook {
  /** Seconds a committed point lives. The ribbon is this long times the speed. */
  readonly seconds: number
  /** Metres across the whole glow at the tip. */
  readonly startWidth: number
  /** Metres across the whole glow at the tail. */
  readonly endWidth: number
  /** 0-1, the opacity at the tip at whole strength. */
  readonly alpha: number
  /** Metres the tip travels before a point commits. */
  readonly minVertexDistance: number
  /**
   * Metres from the eye inside which the ribbon fades out: nothing AT the eye,
   * whole at this distance, a smoothstep between. 0 is no fade.
   */
  readonly nearFade: number
  /** The centre line's brightness, linear, times the tint. Above 1 is what the bloom catches. */
  readonly glow: number
  /** 0-1, the core's half-width as a fraction of the glow's. */
  readonly core: number
  /** 0-1, the brightness at the core's edge as a fraction of the centre's. */
  readonly halo: number
  /** Degrees: the widest the ribbon may subtend at the eye. 0 is no cap. */
  readonly maxWidthDeg: number
}

/** Vertices across one point of a ribbon: edge, core edge, centre, core edge, edge. */
export const WING_TRAIL_ACROSS = 5

/** The two tips, in the frame of whatever the hull's art object hangs from. */
export interface WingTips {
  readonly port: THREE.Vector3
  readonly starboard: THREE.Vector3
}

/** A point on the planform: x across, z fore and aft, and the 3-D vertex it came from. */
interface PlanPoint {
  readonly x: number
  readonly z: number
  readonly at: THREE.Vector3
}

const cross = (o: PlanPoint, a: PlanPoint, b: PlanPoint): number =>
  (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)

/** Andrew's monotone chain. Collinear points are dropped, so every outline vertex is a corner. */
const convexOutline = (points: PlanPoint[]): PlanPoint[] => {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  if (sorted.length < 3) return sorted
  const lower: PlanPoint[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2) as PlanPoint, lower.at(-1) as PlanPoint, p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: PlanPoint[] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as PlanPoint
    while (upper.length >= 2 && cross(upper.at(-2) as PlanPoint, upper.at(-1) as PlanPoint, p) <= 0)
      upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/**
 * The tip on one side: the outermost outline vertex, then the next outline
 * vertex AFT of it (+z in three space, where the ship's nose is -z).
 */
const trailingCorner = (outline: readonly PlanPoint[], side: -1 | 1): THREE.Vector3 => {
  let tip = 0
  for (let i = 1; i < outline.length; i++) {
    if ((outline[i] as PlanPoint).x * side > (outline[tip] as PlanPoint).x * side) tip = i
  }
  const n = outline.length
  const at = outline[tip] as PlanPoint
  const before = outline[(tip - 1 + n) % n] as PlanPoint
  const after = outline[(tip + 1) % n] as PlanPoint
  const aft = before.z > after.z ? before : after
  // A tip that is itself the aft-most corner (a raked tip) has no chord behind
  // it: the trail leaves from the tip.
  return (aft.z > at.z ? aft : at).at.clone()
}

/**
 * Measure the wing tips off a loaded exterior hull.
 *
 * `art` is the hull's art object WITH its own transform set (the three
 * `ART_*` lines every consumer applies), and the answer is in the frame that
 * transform maps into — the ship's, or the art pivot's for the player. Call it
 * before anything else is hung on `art` (the anti-grav wing sits inside the
 * hull's outline, but the measurement is of the hull). Throws on a mesh with
 * no vertices, because a trail at the origin would be a guess.
 */
export const measureWingTips = (art: THREE.Object3D): WingTips => {
  art.updateMatrix()
  art.updateWorldMatrix(true, true)
  const toArt = new THREE.Matrix4().copy(art.matrixWorld).invert()
  const toParent = new THREE.Matrix4()
  const points: PlanPoint[] = []
  art.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    // mesh -> art, then the art's own local transform: the frame `art` hangs in.
    toParent.multiplyMatrices(
      art.matrix,
      new THREE.Matrix4().multiplyMatrices(toArt, mesh.matrixWorld),
    )
    for (let i = 0; i < position.count; i++) {
      const at = new THREE.Vector3(
        position.getX(i),
        position.getY(i),
        position.getZ(i),
      ).applyMatrix4(toParent)
      points.push({ x: at.x, z: at.z, at })
    }
  })
  if (points.length < 3)
    throw new Error('wing-trails: the hull has no vertices to find its tips on')
  const outline = convexOutline(points)
  return { port: trailingCorner(outline, -1), starboard: trailingCorner(outline, 1) }
}

/**
 * Above this the emitter was MOVED rather than flown: `render/trail.ts`'s
 * backstop, for the same reason. A respawn, a crash reset or a restart moves
 * hundreds of metres in a frame; nothing flying reaches 1 km/s.
 */
const TELEPORT_SPEED = 1000

/** Per point: x, y, z, age (s), the strength it was born at. */
const STRIDE = 5

/** Ring capacity per ribbon. At 90 Hz and 0.35 s a ribbon holds about 32; this is a backstop. */
const MAX_POINTS = 64

interface Ribbon {
  readonly pts: Float32Array
  count: number
  readonly anchor: THREE.Vector3
}

export interface WingTrailStats {
  /** Ribbons with at least one segment this frame. */
  readonly ribbons: number
  /** Triangles in the one draw. 0 when the batch is hidden. */
  readonly triangles: number
  /** The strongest alpha any vertex was given this frame. */
  readonly peakAlpha: number
}

export interface WingTrails {
  /** Add to the scene ROOT: its vertices are world positions. */
  readonly object: THREE.Mesh
  /** For the fog's door, which the caller holds. */
  readonly material: THREE.MeshBasicMaterial
  /**
   * Advance craft `craft`'s two ribbons: the tips in WORLD space this frame,
   * and the strength its trails are born at now (`wingTrailStrength`). `dt` is
   * a FRAME delta — this is decoration, sampled per frame as 2016 sampled its
   * `TrailRenderer`, never the fixed step.
   *
   * A frame with NO time in it (`dt` 0: the sim paused, or held at a `?snap=`
   * mark) HOLDS the vapour exactly as it is, the way Unity's scaled
   * `deltaTime` of 0 holds a trail. So a frozen frame photographs the trails
   * it froze, and the same-tick A/B harness can see them.
   */
  emit(
    craft: number,
    port: THREE.Vector3,
    starboard: THREE.Vector3,
    strength: number,
    dt: number,
    look: WingTrailLook,
  ): void
  /** Forget craft `craft`'s ribbons, or every craft's. A hidden ship leaves no vapour. */
  clear(craft?: number): void
  /** Craft `craft`'s tint, LINEAR RGB 0..1. White until set. */
  setTint(craft: number, r: number, g: number, b: number): void
  /** Write every ribbon into the one geometry, facing `eye`. Call once a frame, after the emits. */
  draw(eye: THREE.Vector3, look: WingTrailLook): void
  readonly stats: WingTrailStats
  dispose(): void
}

/**
 * Mark `[0, count)` of `attribute` for upload and nothing past it (DEV-919).
 * Cleared first: three clears ranges only when it uploads, so a frame the
 * mesh was culled would otherwise leave them to pile up.
 */
const sendPrefix = (attribute: THREE.BufferAttribute, count: number): void => {
  attribute.clearUpdateRanges()
  attribute.addUpdateRange(0, count)
  attribute.needsUpdate = true
}

/** A batch of `craft` ships' wing trails, two ribbons each, one draw. */
export const createWingTrails = (craft: number, name = 'wing-trails'): WingTrails => {
  const count = Math.max(1, Math.floor(craft))
  const ribbons: Ribbon[] = Array.from({ length: count * 2 }, () => ({
    pts: new Float32Array(MAX_POINTS * STRIDE),
    count: 0,
    anchor: new THREE.Vector3(),
  }))

  /** Linear RGB per CRAFT, three floats each. White until `setTint`. */
  const tints = new Float32Array(count * 3).fill(1)

  const across = WING_TRAIL_ACROSS
  const vertices = ribbons.length * MAX_POINTS * across
  const positions = new Float32Array(vertices * 3)
  const colours = new Float32Array(vertices * 4)
  // Four quads a segment, the columns between the five vertices across.
  const indices = new Uint16Array(ribbons.length * (MAX_POINTS - 1) * (across - 1) * 6)
  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
  // FOUR components, which is what makes three read the alpha (`vertexAlphas`).
  const colourAttribute = new THREE.BufferAttribute(colours, 4).setUsage(THREE.DynamicDrawUsage)
  const indexAttribute = new THREE.BufferAttribute(indices, 1).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('color', colourAttribute)
  geometry.setIndex(indexAttribute)
  geometry.setDrawRange(0, 0)

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // ONE pass. three draws a transparent double-sided material twice, back
    // faces then front, so its halves sort; a camera-facing strip has no back
    // to sort, and the second pass doubled every batch's draw (measured: 4
    // calls and 2 x its triangles for two batches, `wing-trails.spec.ts`).
    forceSinglePass: true,
  })
  material.name = 'wing-trails'

  const object = new THREE.Mesh(geometry, material)
  object.name = name
  // World-space vertices: no transform of its own, and bounds that change every
  // frame, so three's cached sphere would cull it wrongly.
  object.matrixAutoUpdate = false
  object.frustumCulled = false
  object.visible = false

  let stats: WingTrailStats = { ribbons: 0, triangles: 0, peakAlpha: 0 }

  // Volatile scratch, valid only inside one synchronous call (trap 19).
  const dir = new THREE.Vector3()
  const view = new THREE.Vector3()
  const side = new THREE.Vector3()
  const lastSide = new THREE.Vector3(1, 0, 0)

  const restart = (r: Ribbon, at: THREE.Vector3, strength: number): void => {
    r.pts[0] = at.x
    r.pts[1] = at.y
    r.pts[2] = at.z
    r.pts[3] = 0
    r.pts[4] = strength
    r.anchor.copy(at)
    r.count = 1
  }

  const advance = (
    r: Ribbon,
    at: THREE.Vector3,
    strength: number,
    dt: number,
    look: WingTrailLook,
  ): void => {
    const p = r.pts
    if (r.count === 0) {
      restart(r, at, strength)
      return
    }
    const jump = TELEPORT_SPEED * Math.max(dt, 1e-6)
    const hx = at.x - (p[0] as number)
    const hy = at.y - (p[1] as number)
    const hz = at.z - (p[2] as number)
    if (hx * hx + hy * hy + hz * hz > jump * jump) {
      restart(r, at, strength)
      return
    }
    // Age, and drop the tail.
    for (let i = 1; i < r.count; i++) p[i * STRIDE + 3] = (p[i * STRIDE + 3] as number) + dt
    while (r.count > 1 && (p[(r.count - 1) * STRIDE + 3] as number) > look.seconds) r.count--
    // Commit, once the tip has moved far enough from the LAST COMMIT (not the
    // head, which is rewritten every frame — `render/trail.ts` says why).
    const min = Math.max(1e-3, look.minVertexDistance)
    if (r.anchor.distanceToSquared(at) >= min * min) {
      if (r.count < MAX_POINTS) r.count++
      p.copyWithin(STRIDE * 2, STRIDE, (r.count - 1) * STRIDE)
      p[STRIDE] = at.x
      p[STRIDE + 1] = at.y
      p[STRIDE + 2] = at.z
      p[STRIDE + 3] = 0
      p[STRIDE + 4] = strength
      r.anchor.copy(at)
    }
    p[0] = at.x
    p[1] = at.y
    p[2] = at.z
    p[3] = 0
    p[4] = strength
  }

  /** Offset of the nearest point to `i` along `step` at a different position. */
  const distinctFrom = (r: Ribbon, i: number, step: number): number => {
    const p = r.pts
    const b = i * STRIDE
    for (let j = i + step; j >= 0 && j < r.count; j += step) {
      const o = j * STRIDE
      const dx = (p[o] as number) - (p[b] as number)
      const dy = (p[o + 1] as number) - (p[b + 1] as number)
      const dz = (p[o + 2] as number) - (p[b + 2] as number)
      if (dx * dx + dy * dy + dz * dz > 1e-12) return o
    }
    return b
  }

  return {
    object,
    material,

    emit(craftIndex, port, starboard, strength, dt, look) {
      const k = Math.floor(craftIndex)
      if (k < 0 || k >= count) return
      // No time, no change: see the interface.
      if (!(dt > 0)) return
      const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0
      advance(ribbons[k * 2] as Ribbon, port, s, dt, look)
      advance(ribbons[k * 2 + 1] as Ribbon, starboard, s, dt, look)
    },

    clear(craftIndex) {
      if (craftIndex === undefined) {
        for (const r of ribbons) r.count = 0
        return
      }
      const k = Math.floor(craftIndex)
      if (k < 0 || k >= count) return
      ;(ribbons[k * 2] as Ribbon).count = 0
      ;(ribbons[k * 2 + 1] as Ribbon).count = 0
    },

    setTint(craftIndex, r, g, b) {
      const k = Math.floor(craftIndex)
      if (k < 0 || k >= count) return
      const clamp = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 1)
      tints[k * 3] = clamp(r)
      tints[k * 3 + 1] = clamp(g)
      tints[k * 3 + 2] = clamp(b)
    },

    draw(eye, look) {
      // The glow is the material's colour, the same scalar on every craft: an
      // HDR white the tint multiplies. See the header for why above 1.
      const glow = Number.isFinite(look.glow) ? Math.max(0, look.glow) : 1
      material.color.setScalar(glow)
      const seconds = Math.max(look.seconds, 1e-6)
      const peak = Math.min(1, Math.max(0, look.alpha))
      const near = Number.isFinite(look.nearFade) ? Math.max(0, look.nearFade) : 0
      const coreFrac = Number.isFinite(look.core) ? Math.min(1, Math.max(0, look.core)) : 0.3
      const haloLevel = Number.isFinite(look.halo) ? Math.min(1, Math.max(0, look.halo)) : 0.35
      // tan of HALF the cap, so `distance * capTan` is a half-width.
      const capTan =
        Number.isFinite(look.maxWidthDeg) && look.maxWidthDeg > 0
          ? Math.tan((look.maxWidthDeg * Math.PI) / 360)
          : Number.POSITIVE_INFINITY
      // Offsets across, as fractions of the half-width, and each vertex's level.
      const offsets = [-1, -coreFrac, 0, coreFrac, 1] as const
      const levels = [haloLevel, haloLevel, 1, haloLevel, haloLevel] as const
      const edge = [true, false, false, false, true] as const
      let v = 0
      let n = 0
      let drawn = 0
      let peakAlpha = 0
      for (let ri = 0; ri < ribbons.length; ri++) {
        const r = ribbons[ri] as Ribbon
        if (r.count < 2) continue
        const craftIndex = ri >> 1
        const tr = tints[craftIndex * 3] as number
        const tg = tints[craftIndex * 3 + 1] as number
        const tb = tints[craftIndex * 3 + 2] as number
        // A ribbon every point of which was born at nothing draws nothing.
        let any = false
        for (let i = 0; i < r.count && !any; i++) any = (r.pts[i * STRIDE + 4] as number) > 0
        if (!any || peak <= 0) continue
        const first = v
        const p = r.pts
        for (let i = 0; i < r.count; i++) {
          const b = i * STRIDE
          const px = p[b] as number
          const py = p[b + 1] as number
          const pz = p[b + 2] as number
          const prev = distinctFrom(r, i, -1)
          const next = distinctFrom(r, i, 1)
          dir.set(
            (p[prev] as number) - (p[next] as number),
            (p[prev + 1] as number) - (p[next + 1] as number),
            (p[prev + 2] as number) - (p[next + 2] as number),
          )
          const dirLen = dir.length()
          if (dirLen > 1e-9) dir.multiplyScalar(1 / dirLen)
          else dir.set(0, 0, 1)
          view.set(px - eye.x, py - eye.y, pz - eye.z)
          const viewLen = view.length()
          if (viewLen > 1e-9) view.multiplyScalar(1 / viewLen)
          else view.set(0, 0, 1)
          side.crossVectors(dir, view)
          const sin = side.length()
          if (sin > 1e-6) side.multiplyScalar(1 / sin)
          else {
            // Looking straight down the ribbon: carry the last axis, made
            // perpendicular again (`render/trail.ts`'s fallback).
            side.copy(lastSide).addScaledVector(dir, -lastSide.dot(dir))
            if (side.lengthSq() > 1e-12) side.normalize()
            else side.set(-dir.y, dir.x, 0).normalize()
          }
          lastSide.copy(side)

          const t = Math.min(1, (p[b + 3] as number) / seconds)
          // The world width, capped at the angle the preset allows at the eye.
          const world = (look.startWidth + (look.endWidth - look.startWidth) * t) * 0.5
          const half = Math.min(world, viewLen * capTan)
          // The NEAR fade: a ribbon passing THROUGH the eye is nobody's view of
          // it (and, in a headset, a line across the face). Zero at the eye.
          const u = near > 0 ? Math.min(1, viewLen / near) : 1
          const alpha = peak * (p[b + 4] as number) * (1 - t) * u * u * (3 - 2 * u)
          if (alpha > peakAlpha) peakAlpha = alpha
          for (let k = 0; k < across; k++) {
            const off = (offsets[k] as number) * half
            const o = (v + k) * 3
            positions[o] = px + side.x * off
            positions[o + 1] = py + side.y * off
            positions[o + 2] = pz + side.z * off
            const level = levels[k] as number
            const q = (v + k) * 4
            colours[q] = tr * level
            colours[q + 1] = tg * level
            colours[q + 2] = tb * level
            colours[q + 3] = edge[k] ? 0 : alpha
          }
          v += across
        }
        for (let i = 0; i < r.count - 1; i++) {
          const a = first + i * across
          for (let k = 0; k < across - 1; k++) {
            const s0 = a + k
            const s1 = s0 + 1
            const t0 = s0 + across
            const t1 = t0 + 1
            indices[n] = s0
            indices[n + 1] = s1
            indices[n + 2] = t0
            indices[n + 3] = t0
            indices[n + 4] = s1
            indices[n + 5] = t1
            n += 6
          }
        }
        drawn++
      }
      object.visible = n > 0
      geometry.setDrawRange(0, n)
      if (n > 0) {
        // DEV-919: the written prefix only, as `particles.ts` does. Without a
        // range three re-sends every buffer at MAX_POINTS for every ribbon.
        sendPrefix(positionAttribute, v * 3)
        sendPrefix(colourAttribute, v * 4)
        sendPrefix(indexAttribute, n)
      }
      stats = { ribbons: drawn, triangles: n / 3, peakAlpha }
    },

    get stats() {
      return stats
    },

    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
