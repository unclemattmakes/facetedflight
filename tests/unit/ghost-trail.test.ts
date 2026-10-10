// tests/unit/ghost-trail.test.ts — the AI jets' engine trail.
//
// Two halves, and they fail for different reasons:
//
//   * The CONSTANTS half guards the extraction. A TrailRenderer's colour stops
//     are packed `Color32` uint32s and the byte order is not self-evident; read
//     backwards, every stop is still a plausible colour and nothing errors.
//   * The GEOMETRY half guards `render/trail.ts`, which reimplements a Unity
//     component three has no equivalent of.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { trailEmitterOffset } from '@/game/racers'
import { PROPS } from '@/generated/constants.generated'
import { GLOW_ENVELOPE_2016, HULL_EXTENTS } from '@/render/hover-glow'
import { createTrail, type TrailSpec } from '@/render/trail'

const TRAIL = PROPS.ghostTrail

describe('the ghost trail, as extracted', () => {
  it('is live: enabled, active, and under an active branch', () => {
    // `m_Enabled: 1` alone is not evidence — see the ring count, which comes
    // out at 77 instead of 21 without the same walk.
    expect(TRAIL.live).toBe(true)
    expect(TRAIL.ancestors.every((a) => a.active)).toBe(true)
  })

  it('decodes Color32 with red in the LOW byte', () => {
    // The head stop is 4294966768 = 0xFFFFFDF0. Little-endian that is
    // (240, 253, 255, 255) — a near-white with the faintest cyan lean. Read the
    // other way round it would be (255, 255, 253, 240): a near-white with the
    // faintest WARM lean, which is exactly why this needs asserting rather than
    // eyeballing. The discriminator is which end of the stop is short of 255.
    const head = TRAIL.colors[0] as readonly number[]
    expect(head.map((c) => Math.round(c * 255))).toEqual([240, 253, 255, 255])
    expect((head[0] as number) < (head[2] as number)).toBe(true)
    expect(TRAIL.colors.length).toBe(5)
  })

  it('is opaque, so none of those stops ever blended', () => {
    // `glowyMaterial.mat` carries no `_ALPHABLEND_ON`, and its shader's
    // SubShader is `"Queue"="Geometry" "RenderType"="Opaque"`. The alphas below
    // are real data and inert output; a port that fades the tail is inventing
    // a fade.
    expect(TRAIL.blends).toBe(false)
    expect((TRAIL.color as readonly number[])[3]).toBeCloseTo(0.891, 3)
    const alphas = TRAIL.colors.map((c) => Math.round((c[3] as number) * 255))
    expect(alphas).toEqual([255, 122, 192, 69, 14])
  })

  it('wears the same material as the checkpoint studs', () => {
    // Not a coincidence and worth pinning: it is why the trail reads as the
    // same cyan-white as the gates, and it means the stud treatment in
    // `game/rings.ts` is the right one to copy.
    expect(TRAIL.material).toBe('Assets/Faceted Flight/Materials/glowyMaterial.mat')
    expect(TRAIL.color).toEqual(PROPS.checkpointRing.studColor)
    expect(TRAIL.glowStrength).toBe(PROPS.checkpointRing.studGlowStrength)
  })

  it('composes to the ship centreline, 5.65 m back, with no rotation', () => {
    // The two yaws in the chain are exact inverses. Composing them wrongly
    // leaves the trail 2.83 m off to one side, which on a 3 m-wide ship reads
    // as "the trail comes out of the wing" rather than as an error.
    const m = new THREE.Matrix4()
    const pose = (p: readonly number[], r: readonly number[], s: readonly number[]) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(p[0], p[1], p[2]),
        new THREE.Quaternion(r[0], r[1], r[2], r[3]),
        new THREE.Vector3(s[0], s[1], s[2]),
      )
    for (const pivot of TRAIL.pivots) m.multiply(pose(pivot.position, pivot.rotation, pivot.scale))
    m.multiply(pose(TRAIL.local.position, TRAIL.local.rotation, TRAIL.local.scale))

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    m.decompose(position, quaternion, scale)

    expect(position.x).toBeCloseTo(0, 2)
    expect(position.y).toBeCloseTo(0.5725, 3)
    // UNITY space: +z is forward, so a trail is at NEGATIVE z.
    expect(position.z).toBeCloseTo(-5.6501, 3)
    // Identity to within float noise: the two yaws really do cancel.
    expect(quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-3)
  })
})

describe('where the trail comes out of the ship (DEV-311)', () => {
  // Wishlist #31: *"gap between the engines and the trail FX"*. It was real and
  // it was 1.215 m. The cause was two prefab ROOTS: `trailEmitterOffset` used
  // to compose `TRAIL.pivots x TRAIL.local`, the emitter measured from
  // `GhostRacer`'s root, while the art is placed at `ART_POSITION`, which is
  // `PlayerShip_SR14_Photon`'s root-to-art offset. `game/racers.ts` has the
  // whole of it.
  //
  // These assert RELATIONSHIPS between the emitter, the hull and 2016's own
  // wing part, not the value of a composition re-derived the way the code
  // derives it — which would be a test of nothing (trap 24).

  it('puts the emitter INSIDE the hull, not in the air behind it', () => {
    const emitter = trailEmitterOffset()
    // THREE's -z is forward, so the tail is at the hull box's MAX z.
    expect(emitter.z, 'forward of the tail, not past it').toBeLessThan(HULL_EXTENTS.max[2])
    expect(emitter.z, 'and still at the back end of the ship').toBeGreaterThan(
      HULL_EXTENTS.max[2] - 1,
    )
    expect(emitter.y, 'within the hull vertically').toBeGreaterThan(HULL_EXTENTS.min[1])
    expect(emitter.y, 'within the hull vertically').toBeLessThan(HULL_EXTENTS.max[1])
    expect(Math.abs(emitter.x), 'on the centreline, as the single 2016 emitter is').toBeLessThan(
      0.05,
    )
  })

  it('agrees with 2016’s anti-grav wing part, which was composed separately', () => {
    // The independent check, and the reason this is a FINDING rather than a
    // plausible fix: `GLOW_ENVELOPE_2016` is `Mesh2-Combined`'s own
    // `m_LocalAABB` pushed through its own transform, and the emitter is a
    // different node's position. Two objects, two compositions, one answer —
    // the trail leaves at the aft edge of the glowing wing.
    const emitter = trailEmitterOffset()
    expect(emitter.z, 'at the wing part’s aft edge').toBeGreaterThan(
      GLOW_ENVELOPE_2016.max[2] - 0.5,
    )
    expect(emitter.z, 'and not past it by more than float noise').toBeLessThan(
      GLOW_ENVELOPE_2016.max[2] + 0.1,
    )
  })

  it('pins the size of the bug it fixed, so a regression is a number', () => {
    // The old composition, spelled out here and NOWHERE in `src/` — this is the
    // only place the root-relative chain still exists. If someone restores it,
    // this says what it costs.
    const root = new THREE.Matrix4()
    const pose = (p: readonly number[], r: readonly number[], sc: readonly number[]) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(p[0] as number, p[1] as number, -(p[2] as number)),
        new THREE.Quaternion(-(r[0] as number), -(r[1] as number), r[2] as number, r[3] as number),
        new THREE.Vector3(sc[0] as number, sc[1] as number, sc[2] as number),
      )
    for (const pivot of TRAIL.pivots)
      root.multiply(pose(pivot.position, pivot.rotation, pivot.scale))
    root.multiply(pose(TRAIL.local.position, TRAIL.local.rotation, TRAIL.local.scale))
    const old = new THREE.Vector3().setFromMatrixPosition(root)
    expect(old.z - HULL_EXTENTS.max[2], 'metres of air behind the tail, before').toBeCloseTo(
      1.215,
      2,
    )
    expect(old.distanceTo(trailEmitterOffset()), 'how far the emitter moved').toBeCloseTo(1.549, 2)
  })
})

const spec: TrailSpec = {
  seconds: 0.14,
  startWidth: 0.43,
  endWidth: 0.01,
  minVertexDistance: 0.25,
  maxPoints: 16,
}

const EYE = new THREE.Vector3(0, 0, -100)

/**
 * Fly straight along +x at `speed` for `seconds`, in `dt` steps.
 *
 * Parameterised by DURATION, not step count, so two frame rates cover the same
 * ground — the first version took a step count and the 180 Hz run flew 5 m
 * further than the 30 Hz one, which failed the frame-rate test for a reason
 * that had nothing to do with the trail.
 */
const fly = (trail: ReturnType<typeof createTrail>, seconds: number, dt: number, speed: number) => {
  const p = new THREE.Vector3()
  const steps = Math.round(seconds / dt)
  // Loud, because this helper has now produced two false failures by flying
  // slightly different distances at different rates. A duration that is not a
  // whole number of frames is a broken test, not a finding about the trail.
  if (Math.abs(steps - seconds / dt) > 1e-9) {
    throw new Error(`fly(): ${seconds}s is not a whole number of ${dt}s frames`)
  }
  for (let i = 0; i <= steps; i++) {
    p.set(i * dt * speed, 0, 0)
    trail.update(p, EYE, dt)
  }
  return p
}

describe('the trail ribbon', () => {
  const material = new THREE.MeshBasicMaterial()

  it('draws nothing until the emitter has moved', () => {
    const trail = createTrail(spec, material)
    const at = new THREE.Vector3(0, 0, 0)
    for (let i = 0; i < 10; i++) trail.update(at, EYE, 1 / 90)
    // A ghost parked on its pad must not smear a ribbon across the grid.
    expect(trail.object.geometry.drawRange.count).toBe(0)
  })

  it('commits a point only once the emitter has moved minVertexDistance', () => {
    const trail = createTrail(spec, material)
    const p = new THREE.Vector3()
    // Ten steps of 0.1 m — a metre of travel, four commits' worth.
    for (let i = 0; i < 11; i++) {
      p.set(i * 0.1, 0, 0)
      trail.update(p, EYE, 1 / 900)
    }
    // Commits are measured from the last COMMIT, so walking 0.1 m at a time
    // they land at 0.3, 0.6 and 0.9 — three of them, not four, because 0.25 is
    // crossed on the third step each time. Three commits plus the live head is
    // four points, which is three quads.
    expect(trail.object.geometry.drawRange.count).toBe(3 * 6)
  })

  it('commits the CURRENT position, not the previous frame', () => {
    // Unity adds `transform.position` to the list at the moment the threshold
    // is crossed, so the newest committed point and the head coincide on that
    // frame. Committing the previous frame's position instead is invisible in
    // every other assertion here — the spacing still averages out — but it
    // leaves the whole history displaced by one frame of travel.
    const trail = createTrail(spec, material)
    const p = new THREE.Vector3()
    // Steps of exactly minVertexDistance, so EVERY frame commits.
    for (let i = 0; i <= 8; i++) {
      p.set(i * spec.minVertexDistance, 0, 0)
      trail.update(p, EYE, 1 / 90)
    }
    const pos = trail.object.geometry.getAttribute('position')
    const head = new THREE.Vector3((pos.getX(0) + pos.getX(1)) / 2, 0, 0)
    const newest = new THREE.Vector3((pos.getX(2) + pos.getX(3)) / 2, 0, 0)
    expect(newest.x).toBeCloseTo(head.x, 6)
  })

  it('drops points once they are older than `seconds`', () => {
    const trail = createTrail(spec, material)
    // 180 m/s at 90 Hz is 2 m a frame, so every frame commits. After more than
    // `seconds` of flight the ribbon must stop growing.
    fly(trail, 0.6, 1 / 90, 180)
    const held = trail.object.geometry.drawRange.count / 6 + 1
    // 0.14 s of 90 Hz frames is 12.6, so 12 or 13 points survive.
    expect(held).toBeGreaterThanOrEqual(12)
    expect(held).toBeLessThanOrEqual(14)
  })

  it('pins the head to the emitter rather than letting it lag', () => {
    const trail = createTrail(spec, material)
    const last = fly(trail, 0.4, 1 / 90, 180)
    const pos = trail.object.geometry.getAttribute('position')
    // Vertices 0 and 1 are the head's two sides; their midpoint is the emitter.
    const mid = new THREE.Vector3(
      (pos.getX(0) + pos.getX(1)) / 2,
      (pos.getY(0) + pos.getY(1)) / 2,
      (pos.getZ(0) + pos.getZ(1)) / 2,
    )
    expect(mid.distanceTo(last)).toBeLessThan(1e-4)
  })

  it('tapers from startWidth at the head to endWidth at the tail', () => {
    const trail = createTrail(spec, material)
    fly(trail, 0.6, 1 / 90, 180)
    const pos = trail.object.geometry.getAttribute('position')
    const widthAt = (i: number) =>
      new THREE.Vector3(pos.getX(i * 2), pos.getY(i * 2), pos.getZ(i * 2)).distanceTo(
        new THREE.Vector3(pos.getX(i * 2 + 1), pos.getY(i * 2 + 1), pos.getZ(i * 2 + 1)),
      )
    const points = trail.object.geometry.drawRange.count / 6 + 1
    expect(widthAt(0)).toBeCloseTo(spec.startWidth, 5)
    // The oldest surviving point is close to `seconds` old but not past it, so
    // it is near endWidth without being exactly it.
    expect(widthAt(points - 1)).toBeLessThan(spec.startWidth * 0.2)
    expect(widthAt(points - 1)).toBeGreaterThanOrEqual(spec.endWidth)
    // Monotonic the whole way: a bug in the age array shows up as a bulge.
    for (let i = 1; i < points; i++) expect(widthAt(i)).toBeLessThanOrEqual(widthAt(i - 1) + 1e-6)
  })

  it('faces the camera: the ribbon is perpendicular to the line of sight', () => {
    const trail = createTrail(spec, material)
    fly(trail, 0.4, 1 / 90, 180)
    const pos = trail.object.geometry.getAttribute('position')
    const a = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0))
    const b = new THREE.Vector3(pos.getX(1), pos.getY(1), pos.getZ(1))
    const across = a.clone().sub(b).normalize()
    const mid = a.clone().add(b).multiplyScalar(0.5)
    const toEye = EYE.clone().sub(mid).normalize()
    // Width axis perpendicular to the view ray is what "camera-facing" means.
    expect(Math.abs(across.dot(toEye))).toBeLessThan(1e-3)
  })

  // ── the chase camera, which is where the flicker lived ────────────────
  //
  // Matt: *"i'm seeing our ghosts jitter and flicker in the chase cam."*
  //
  // The cause was the TANGENT, not the camera. A commit writes its point AT the
  // emitter, so on that frame the head and the newest committed point coincide
  // and the naive `points[i-1] - points[i+1]` is the zero vector. At 0.15 m per
  // frame against a 0.25 m threshold, commits land on alternate frames — so the
  // head's tangent alternated between the real one and a fallback, and the head
  // quad flipped orientation with it, every other frame.
  //
  // What this scenario adds is a camera swinging from side-on to directly
  // behind, which is where a ribbon is most sensitive to a bad tangent: near
  // end-on it is a couple of pixels wide and any axis error is the whole
  // silhouette.
  //
  // Two other suspects were built, measured and REMOVED, because neither moved
  // this number: aligning each point's axis against the previous one (to stop
  // `cross` changing sign as the view crosses the trail's plane), and fading
  // toward the carried axis near end-on. Reversing a single point's axis turns
  // out to be harmless — the quad is the same two vertices, swapped, on a
  // DoubleSide material — and on a banking 180 m/s trajectory with the camera
  // at 30 m the worst neighbour disagreement is 0.9999 either way.
  it('keeps a continuous width axis as a chase camera swings in behind', () => {
    const trail = createTrail(spec, material)
    const p = new THREE.Vector3()
    const eye = new THREE.Vector3()
    const sideOf = () => {
      const pos = trail.object.geometry.getAttribute('position')
      return new THREE.Vector3(
        pos.getX(0) - pos.getX(1),
        pos.getY(0) - pos.getY(1),
        pos.getZ(0) - pos.getZ(1),
      ).normalize()
    }

    const dt = 1 / 90
    // 0.15 m per frame against a 0.25 m threshold: commits on alternate frames.
    const speed = 0.15 / dt
    const frames = 90
    const seen: THREE.Vector3[] = []
    for (let i = 0; i <= frames; i++) {
      const x = i * dt * speed
      p.set(x, 0, 0)
      // Swing from 90 degrees off the tangent round to 2 degrees PAST it, so
      // the lateral offset passes through zero rather than stopping at it.
      const theta = ((90 - i * (92 / frames)) * Math.PI) / 180
      eye.set(x - Math.cos(theta) * 30, 3, Math.sin(theta) * 30)
      trail.update(p, eye, dt)
      // Skip the first few frames, where the ribbon is still one point long.
      if (i > 6) seen.push(sideOf())
    }

    let worst = 1
    let worstAt = -1
    for (let i = 1; i < seen.length; i++) {
      const d = (seen[i] as THREE.Vector3).dot(seen[i - 1] as THREE.Vector3)
      if (d < worst) {
        worst = d
        worstAt = i
      }
    }
    // A 180-degree flip reads as -1; an axis spinning a few degrees a frame
    // reads just under 1. Both are visible as flicker on a 0.43 m ribbon.
    expect(worst, `worst frame-to-frame axis change at frame ${worstAt}`).toBeGreaterThan(0.98)
  })

  it('never twists into a bowtie along its own length', () => {
    // Each point's width axis comes from `cross(tangent, view)`, and `view` is
    // different for every point. If two neighbours disagree about which way
    // their axis points, the quad between them is a bowtie rather than a
    // ribbon — a real failure mode, and the one thing a per-frame measurement
    // cannot see, which is why this looks ALONG the ribbon instead.
    //
    // It has never fired in anger: measured on this path and on a banking one,
    // the worst neighbour disagreement is 0.9999 with or without explicit
    // alignment, so no alignment code exists. It is here as the guard for a
    // geometry that would need it, not as evidence that today's does.
    const trail = createTrail(spec, material)
    const p = new THREE.Vector3()
    const eye = new THREE.Vector3()
    const dt = 1 / 90
    const speed = 0.15 / dt
    const frames = 90
    let worst = 1
    let worstAt = -1
    for (let i = 0; i <= frames; i++) {
      const x = i * dt * speed
      p.set(x, 0, 0)
      const theta = ((90 - i * (92 / frames)) * Math.PI) / 180
      eye.set(x - Math.cos(theta) * 30, 3, Math.sin(theta) * 30)
      trail.update(p, eye, dt)
      if (i <= 6) continue
      const pos = trail.object.geometry.getAttribute('position')
      const points = trail.object.geometry.drawRange.count / 6 + 1
      const axis = (k: number) =>
        new THREE.Vector3(
          pos.getX(k * 2) - pos.getX(k * 2 + 1),
          pos.getY(k * 2) - pos.getY(k * 2 + 1),
          pos.getZ(k * 2) - pos.getZ(k * 2 + 1),
        ).normalize()
      for (let k = 1; k < points; k++) {
        const d = axis(k).dot(axis(k - 1))
        if (d < worst) {
          worst = d
          worstAt = i
        }
      }
    }
    expect(worst, `worst neighbour disagreement on frame ${worstAt}`).toBeGreaterThan(0)
  })

  it('throws the history away on a teleport instead of drawing across it', () => {
    const trail = createTrail(spec, material)
    fly(trail, 0.4, 1 / 90, 180)
    expect(trail.object.geometry.drawRange.count).toBeGreaterThan(0)
    // A race restart: hundreds of metres in one frame.
    trail.update(new THREE.Vector3(-5000, 300, 2000), EYE, 1 / 90)
    expect(trail.object.geometry.drawRange.count).toBe(0)
  })

  it('keeps its shape when the frame rate changes', () => {
    // The whole point of `minVertexDistance`: the point COUNT is frame-rate
    // dependent, the geometry is not. Same flight, 90 Hz vs 30 Hz, same ribbon.
    const fast = createTrail(spec, material)
    const slow = createTrail(spec, material)
    fly(fast, 0.6, 1 / 180, 180)
    fly(slow, 0.6, 1 / 30, 180)
    const head = (t: ReturnType<typeof createTrail>) => {
      const pos = t.object.geometry.getAttribute('position')
      return new THREE.Vector3(
        (pos.getX(0) + pos.getX(1)) / 2,
        (pos.getY(0) + pos.getY(1)) / 2,
        (pos.getZ(0) + pos.getZ(1)) / 2,
      )
    }
    // Both flew 0.6 s at 180 m/s — 108 frames and 18 frames, same 108 m.
    expect(head(fast).distanceTo(head(slow))).toBeLessThan(0.01)
  })

  it('survives more travel than the ring can hold', () => {
    // 16 points at 0.25 m is 3.75 m of history; this flies 720 m. A ring that
    // wraps badly shows up as a ribbon that jumps back to the start.
    const trail = createTrail(spec, material)
    fly(trail, 4.4, 1 / 90, 180)
    const pos = trail.object.geometry.getAttribute('position')
    const points = trail.object.geometry.drawRange.count / 6 + 1
    expect(points).toBeLessThanOrEqual(16)
    let maxGap = 0
    for (let i = 1; i < points; i++) {
      const a = new THREE.Vector3(pos.getX(i * 2), pos.getY(i * 2), pos.getZ(i * 2))
      const b = new THREE.Vector3(
        pos.getX((i - 1) * 2),
        pos.getY((i - 1) * 2),
        pos.getZ((i - 1) * 2),
      )
      maxGap = Math.max(maxGap, a.distanceTo(b))
    }
    // Consecutive points are one frame of travel apart (2 m), never the whole
    // ribbon's length.
    expect(maxGap).toBeLessThan(5)
  })
})
