/**
 * The stretched billboard lies along its motion ON THE SCREEN — DEV-138.
 *
 * Matt, 2026-09-16: *"there are some stretched 'streak' particles that look
 * odd. instead of being aligned like wind streaks, they're usually vertical to
 * the screen."* The three boost tubes are authored 100 m ahead of the ship and
 * fly straight back at the eye (`HOVERJET.particles`), so in view space their
 * velocity is almost pure z. The first shader stretched along
 * `normalize(vView.xy)` — the velocity's 2D shadow — and fell back to view-up
 * when the shadow was short, which for a streak aimed at the camera is
 * always. Every streak near the tube's far end stood upright, unforeshortened,
 * whatever the bank.
 *
 * Unity's `Stretch` mode (`m_RenderMode: 1` on the prefab, `m_Pivot` centred,
 * `m_RenderAlignment: 0`) builds the quad in 3D along the velocity and lets the
 * projection do the rest. `stretchedCorner` in `render/particles.ts` is that
 * construction in TypeScript, line for line with the GLSL, and this file
 * projects it — because a GLSL program cannot run in node, and because the
 * claim is about what lands on the SCREEN, not about a quaternion (the
 * orientation lesson: test the geometry, not the belief).
 *
 * Camera poses are the two the game has: a flat camera at the origin, and a
 * camera inside an XR rig that has been yawed and translated — the case where
 * "view space" and "world space" disagree, so a shader that stretched in the
 * wrong space would fail here and pass on the flat one.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { HOVERJET } from '@/generated/constants.generated'
import { PARTICLE_VERTEX_SHADER, stretchedCorner } from '@/render/particles'

/** A camera with the cockpit's own optics, posed by the caller. */
const cameraAt = (
  position: THREE.Vector3,
  yawDeg: number,
  pitchDeg = 0,
): THREE.PerspectiveCamera => {
  const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.08, 20_000)
  cam.position.copy(position)
  cam.rotation.set((pitchDeg * Math.PI) / 180, (yawDeg * Math.PI) / 180, 0, 'YXZ')
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

/** A world point to NDC, the way `projectionMatrix * modelViewMatrix` does it. */
const toNdc = (cam: THREE.PerspectiveCamera, world: THREE.Vector3): THREE.Vector2 => {
  const p = world.clone().project(cam)
  return new THREE.Vector2(p.x, p.y)
}

/** A world point and direction into VIEW space, as the shader sees them. */
const toView = (cam: THREE.PerspectiveCamera, worldPos: THREE.Vector3, worldVel: THREE.Vector3) => {
  const mv = cam.matrixWorldInverse
  return {
    centre: worldPos.clone().applyMatrix4(mv),
    velocity: worldVel.clone().transformDirection(mv).multiplyScalar(worldVel.length()),
  }
}

/** The quad's two ENDS on screen, from the two corners on its long axis. */
const streakEndsNdc = (
  cam: THREE.PerspectiveCamera,
  worldPos: THREE.Vector3,
  worldVel: THREE.Vector3,
  size: number,
  stretch: number,
): [THREE.Vector2, THREE.Vector2] => {
  const { centre, velocity } = toView(cam, worldPos, worldVel)
  const viewToWorld = cam.matrixWorld
  const end = (y: number) =>
    toNdc(
      cam,
      stretchedCorner(centre, velocity, { x: 0, y }, size, stretch).applyMatrix4(viewToWorld),
    )
  return [end(-0.5), end(0.5)]
}

/** Where the particle's velocity points ON SCREEN: project p and p + εv. */
const motionNdc = (
  cam: THREE.PerspectiveCamera,
  worldPos: THREE.Vector3,
  worldVel: THREE.Vector3,
) => {
  const a = toNdc(cam, worldPos)
  const b = toNdc(cam, worldPos.clone().addScaledVector(worldVel, 1e-3))
  return b.sub(a)
}

/** |sin| of the angle between two screen directions. 0 is parallel. */
const sinBetween = (a: THREE.Vector2, b: THREE.Vector2): number =>
  Math.abs(a.x * b.y - a.y * b.x) / (a.length() * b.length())

/** The authored streak: 8 cm wide, and the boost tube's length at 250 m/s. */
const SIZE = 0.08
const boost = HOVERJET.particles.find((p) => p.name === 'boost_particles')
const STRETCH =
  SIZE * (boost?.renderer?.lengthScale ?? 0.5) + 250 * (boost?.renderer?.velocityScale ?? 0.05)

const FLAT = cameraAt(new THREE.Vector3(0, 0, 0), 0)
/** Inside a rig: 400 m up, turned 130° and looking 10° down — nothing lines up with an axis. */
const RIG = cameraAt(new THREE.Vector3(1200, 400, -800), 130, -10)

describe('the streak lies along its motion on the screen (DEV-138)', () => {
  const cases: [string, THREE.PerspectiveCamera][] = [
    ['flat camera', FLAT],
    ['yawed, pitched XR rig', RIG],
  ]

  for (const [name, cam] of cases) {
    it(`${name}: the quad's long axis in NDC is parallel to the projected velocity`, () => {
      // Streaks scattered around the view, moving every which way. The
      // vanishing-point case (velocity along the sight line) is excluded here
      // because its screen direction is undefined; the next test owns it.
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld)
      const right = new THREE.Vector3(1, 0, 0).transformDirection(cam.matrixWorld)
      const up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorld)
      for (let i = 0; i < 40; i++) {
        const t = i / 40
        const pos = cam.position
          .clone()
          .addScaledVector(forward, 30 + 150 * t)
          .addScaledVector(right, Math.sin(i * 1.7) * 20)
          .addScaledVector(up, Math.cos(i * 2.3) * 12)
        const vel = new THREE.Vector3(Math.sin(i * 0.9), Math.cos(i * 1.3), Math.sin(i * 0.4))
          .normalize()
          .multiplyScalar(180)
        const motion = motionNdc(cam, pos, vel)
        // Skip the ones the projection makes degenerate on purpose.
        if (motion.length() < 1e-4) continue
        const [a, b] = streakEndsNdc(cam, pos, vel, SIZE, STRETCH)
        const axis = b.clone().sub(a)
        expect(axis.length(), `streak ${i} has length on screen`).toBeGreaterThan(1e-4)
        expect(sinBetween(axis, motion), `streak ${i} lies along its motion`).toBeLessThan(0.02)
      }
    })

    it(`${name}: a streak flying straight at the eye is a POINT, not a vertical line`, () => {
      // The reported case. A boost streak 100 m down the sight line, coming at
      // the camera: its two ends are on one ray from the eye, so they project
      // to one screen point. The old shader drew this as a full-length line
      // pointing at view-up.
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld)
      const pos = cam.position.clone().addScaledVector(forward, 100)
      const vel = forward.clone().multiplyScalar(-250)
      const [a, b] = streakEndsNdc(cam, pos, vel, SIZE, STRETCH)
      expect(a.distanceTo(b)).toBeLessThan(1e-6)
    })

    it(`${name}: a streak passing the canopy converges on the vanishing point`, () => {
      // The wind-streak look is perspective: a streak 5 m off the axis, moving
      // along it, points at the axis's vanishing point on screen. That is the
      // radial pattern Matt asked for, and the flat 2D stretch could not draw
      // it because it had no depth to converge with.
      const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld)
      const right = new THREE.Vector3(1, 0, 0).transformDirection(cam.matrixWorld)
      const up = new THREE.Vector3(0, 1, 0).transformDirection(cam.matrixWorld)
      const vanishing = toNdc(cam, cam.position.clone().addScaledVector(forward, 10_000))
      for (const [dx, dy] of [
        [5, 0],
        [-4, 3],
        [0, -5],
        [3, 4],
      ] as const) {
        const pos = cam.position
          .clone()
          .addScaledVector(forward, 20)
          .addScaledVector(right, dx)
          .addScaledVector(up, dy)
        const vel = forward.clone().multiplyScalar(-250)
        const [a, b] = streakEndsNdc(cam, pos, vel, SIZE, STRETCH)
        const axis = b.clone().sub(a)
        const toVanishing = vanishing.clone().sub(toNdc(cam, pos))
        expect(axis.length()).toBeGreaterThan(0.01)
        expect(
          sinBetween(axis, toVanishing),
          `(${dx}, ${dy}) points at the vanishing point`,
        ).toBeLessThan(0.02)
      }
    })
  }

  it('the WIDTH faces the eye: the side axis is perpendicular to the line of sight', () => {
    const centre = new THREE.Vector3(3, -2, -40)
    const velocity = new THREE.Vector3(0.3, 0.2, 1).multiplyScalar(200)
    const left = stretchedCorner(centre, velocity, { x: -0.5, y: 0 }, SIZE, STRETCH)
    const rightC = stretchedCorner(centre, velocity, { x: 0.5, y: 0 }, SIZE, STRETCH)
    const side = rightC.clone().sub(left)
    expect(side.length()).toBeCloseTo(SIZE, 6)
    expect(Math.abs(side.dot(centre.clone().normalize()))).toBeLessThan(1e-9)
    expect(Math.abs(side.dot(velocity.clone().normalize()))).toBeLessThan(1e-9)
  })

  it('the LENGTH is the stretch, along the velocity, centred on the particle', () => {
    const centre = new THREE.Vector3(-6, 1, -75)
    const velocity = new THREE.Vector3(-0.2, 0.1, 1).multiplyScalar(120)
    const a = stretchedCorner(centre, velocity, { x: 0, y: -0.5 }, SIZE, STRETCH)
    const b = stretchedCorner(centre, velocity, { x: 0, y: 0.5 }, SIZE, STRETCH)
    expect(a.distanceTo(b)).toBeCloseTo(STRETCH, 6)
    expect(a.clone().add(b).multiplyScalar(0.5).distanceTo(centre)).toBeLessThan(1e-9)
    expect(sinBetween3(b.clone().sub(a), velocity)).toBeLessThan(1e-9)
  })

  it('the shader is the 3D construction, not the 2D shadow', () => {
    // The mirror above proves the arithmetic; this holds the GLSL to the same
    // shape. A `cross` against the line of sight is what the 2D version could
    // not have, and `vec2(0.0, 1.0)` was the fallback that drew the bug.
    expect(PARTICLE_VERTEX_SHADER).toContain('cross(along, centre.xyz)')
    expect(PARTICLE_VERTEX_SHADER).toContain(
      'side * (corner.x * size) + along * (corner.y * stretch)',
    )
    expect(PARTICLE_VERTEX_SHADER).not.toContain('normalize(vView.xy)')
    expect(PARTICLE_VERTEX_SHADER).not.toContain('vec2(0.0, 1.0)')
  })

  it('is aimed at the systems that have the problem: the three boost tubes fly at the eye', () => {
    // Off the sheet: the tubes are authored at (0, -5.6, 100) under Effects,
    // turned about y by ~176°, so they emit back toward the ship. A velocity
    // along the ship's axis is a velocity along the sight line from the seat,
    // which is the case the old shader could not draw.
    for (const name of ['boost_particles', 'fasterBoost', 'ludacrisSpeed']) {
      const p = HOVERJET.particles.find((q) => q.name === name)
      expect(p, name).toBeDefined()
      if (!p) continue
      expect(p.renderer?.mode, name).toBe('stretch')
      expect(p.position[2], `${name} is 100 m ahead`).toBe(100)
      const [qx, qy, qz, qw] = p.rotation as [number, number, number, number]
      // A quaternion (0, ~1, small, 0) is a half-turn about y: the cone faces -z.
      expect(Math.abs(qy), name).toBeGreaterThan(0.99)
      expect(Math.abs(qx) + Math.abs(qz) + Math.abs(qw), name).toBeLessThan(0.05)
    }
  })
})

/** |sin| between two 3D directions. */
const sinBetween3 = (a: THREE.Vector3, b: THREE.Vector3): number =>
  new THREE.Vector3().crossVectors(a, b).length() / (a.length() * b.length())
