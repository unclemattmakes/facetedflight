// src/editor/desk/camera.ts — the desk's eye: an orbit camera over the island,
// and a top-down view for laying a course out. DEV-469.
//
// Its OWN camera, not the game's. The game's camera hangs under the XR rig and
// is written by half a dozen branches of the frame loop (the seat, the
// cockpit, the chase arm); an orbit control on it would be one more writer.
// This one belongs to the desk alone, so it is exactly where it was left when
// a playtest comes back — nothing else ever moved it. It copies the game
// camera's LAYERS, so it draws what the game draws (and never an eye layer:
// layers 1 and 2 are the WebXR eyes, DEV-141).
//
// `OrbitControls` from the package (`three` is pinned; never copied).
//
// DEV-472: MAYA'S HANDS, and a depth range for a map.
//
//  · the buttons: left-drag orbits (Alt+left too, Maya's own), Shift+left,
//    middle and right pan, the wheel and Alt+right zoom. `OrbitControls` reads
//    `mouseButtons` at the moment of the press, so Alt+right is set per press
//    by a capture-phase listener that runs before the controls' own. Shift+left
//    was ALREADY a pan in stock `OrbitControls` (its ROTATE case pans under
//    Ctrl, Meta or Shift); the panel's help never said so;
//  · `focus` is F: the selected point, framed;
//  · the near plane follows the orbit's distance (`deskNear`, policy.ts says
//    why): the game's 0.08 m near plane is a cockpit's, and from a map's height
//    it cost the shoreline its depth resolution.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { PlayerCourseArea } from '@/content/player-course'
import {
  anglesOf,
  type FlyAngles,
  type FlyKeys,
  flyLook,
  flyQuaternion,
  flyReleaseTarget,
  flySpeed,
  flyStep,
  flyWheel,
  viewOf,
} from './fly'
import { DESK_CAMERA_POLICY, DESK_POLICY, deskNear } from './policy'

/** A sphere that holds the play area: what the camera frames. */
export const areaSphere = (area: PlayerCourseArea): { centre: THREE.Vector3; radius: number } => {
  if (area.kind === 'sphere') {
    return { centre: new THREE.Vector3(...area.centre), radius: area.radius }
  }
  const min = new THREE.Vector3(...area.min)
  const max = new THREE.Vector3(...area.max)
  // Frame the ground, not the sky above it: the box's floor to a little over
  // its middle is where a course goes.
  const centre = min.clone().add(max).multiplyScalar(0.5)
  centre.y = min.y
  const half = max.clone().sub(min).multiplyScalar(0.5)
  return { centre, radius: Math.hypot(half.x, half.z) }
}

/**
 * The distance from `centre` at which a camera of vertical field `fovDeg` and
 * `aspect` sees a sphere of `radius` whole, times the frame margin.
 */
export const frameDistance = (radius: number, fovDeg: number, aspect: number): number => {
  const vHalf = THREE.MathUtils.degToRad(fovDeg) / 2
  const hHalf = Math.atan(Math.tan(vHalf) * aspect)
  const half = Math.min(vHalf, hHalf)
  return (radius * DESK_POLICY.frameMargin) / Math.sin(half)
}

export interface DeskCamera {
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly topDown: boolean
  /** Look at the whole play area, from the south and above (or straight down, top-down). */
  frame(area: PlayerCourseArea): void
  /** Straight down over the orbit's target, north up; or back to the orbit. */
  setTopDown(on: boolean): void
  /** DEV-472, F: look at `point` from where the view shows `focusSpanMetres` of ground round it. */
  focus(point: THREE.Vector3): void
  /** DEV-472 follow-up: the right button is held and the eye is flying (Unreal's viewport). */
  readonly flying: boolean
  /** The fly's speed scale, as the wheel has set it (1 = the policy's speed for the height). */
  readonly flyScale: number
  /** Each frame: aspect, the controls' damping (or the fly), then near and far. `seconds` is the frame's. */
  update(seconds?: number): void
  dispose(): void
}

/** What the desk tells its camera: the ground under the eye, and when a tool holds the mouse. */
export interface DeskCameraOptions {
  /** The RENDER surface's height at (x, z), or -Infinity where there is none (yet). */
  readonly surfaceAt?: (x: number, z: number) => number
  /** True while a tool (the gizmo) holds a drag: no camera gesture may start. */
  readonly blocked?: () => boolean
  /**
   * DEV-498: metres from `eye` the far plane must reach to take in everything
   * the desk draws past the play area (the far sea), or 0. Orbit and fly both.
   */
  readonly farReach?: (eye: THREE.Vector3) => number
}

/** The keys the fly reads, by `KeyboardEvent.code`: the key's PLACE, so AZERTY flies the same. */
const FLY_CODES = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'up',
  KeyQ: 'down',
} as const satisfies Record<string, keyof FlyKeys>

export const createDeskCamera = (
  template: THREE.PerspectiveCamera,
  dom: HTMLElement,
  options: DeskCameraOptions = {},
): DeskCamera => {
  const camera = new THREE.PerspectiveCamera(DESK_POLICY.fovDegrees, 1, template.near, template.far)
  camera.layers.mask = template.layers.mask
  camera.name = 'editor-camera'
  const policyMaxPolar = THREE.MathUtils.degToRad(DESK_POLICY.maxPolarDegrees)

  // ── DEV-472 follow-up: the fly ───────────────────────────────────────
  //
  // Right button down (no Alt) on the canvas: the orbit stands down and the
  // mouse turns the eye where it stands. The listeners run in the CAPTURE
  // phase on the canvas, before `OrbitControls`' own, so the controls never
  // see the press. Keys and the wheel act only while the button is held.
  let flying = false
  let flyAngles: FlyAngles = { yaw: 0, pitch: 0 }
  let flyScale = 1
  let flyPointer = -1
  let flyLast = { x: 0, y: 0 }
  /** The orbit's distance when the fly began: where the target goes when it ends. */
  let flyOrbitDistance = 0
  const held: Record<keyof FlyKeys, boolean> = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
  }
  const releaseKeys = (): void => {
    for (const k of Object.keys(held) as (keyof FlyKeys)[]) held[k] = false
  }

  const beginFly = (e: PointerEvent): void => {
    flying = true
    flyPointer = e.pointerId
    flyLast = { x: e.clientX, y: e.clientY }
    flyOrbitDistance = camera.position.distanceTo(controls.target)
    flyAngles = anglesOf(viewOf(camera.quaternion))
    camera.quaternion.copy(flyQuaternion(flyAngles))
    controls.enabled = false
    // The fly looks from the eye: the top-down lock is over (the panel follows).
    if (topDown) {
      topDown = false
      controls.enableRotate = true
    }
    try {
      dom.setPointerCapture(e.pointerId)
    } catch {
      // A synthetic pointer: nothing to capture.
    }
  }

  const endFly = (): void => {
    if (!flying) return
    flying = false
    releaseKeys()
    try {
      if (flyPointer >= 0) dom.releasePointerCapture(flyPointer)
    } catch {
      // Already released.
    }
    flyPointer = -1
    // Hand back to the orbit with no jump: the target straight ahead at the
    // distance the orbit had, the eye where it is, the view as it is. The
    // orbit's floor is widened to wherever the fly left it (never narrowed),
    // or looking up at release would snap the eye to the policy's limit.
    controls.target.copy(flyReleaseTarget(camera.position, flyAngles, flyOrbitDistance))
    const offset = camera.position.clone().sub(controls.target)
    const polar = Math.acos(THREE.MathUtils.clamp(offset.y / (offset.length() || 1), -1, 1))
    controls.maxPolarAngle = Math.max(policyMaxPolar, polar + 1e-6)
    // The orbit's own damping was frozen mid-way when the fly began; what it
    // still owed would swing the new view. Three keeps it on private fields.
    const owed = controls as unknown as {
      _sphericalDelta?: THREE.Spherical
      _panOffset?: THREE.Vector3
      _scale?: number
    }
    owed._sphericalDelta?.set(0, 0, 0)
    owed._panOffset?.set(0, 0, 0)
    if (owed._scale !== undefined) owed._scale = 1
    controls.enabled = true
    camera.lookAt(controls.target)
    controls.update()
  }

  // DEV-472: capture phase, so it runs before the controls' own listener on
  // the canvas. Alt+right is Maya's zoom; the right button alone flies (the
  // follow-up). A middle press is taken from the browser's autoscroll.
  const onPress = (e: PointerEvent): void => {
    if (e.button === 2) {
      controls.mouseButtons.RIGHT = THREE.MOUSE.DOLLY
      if (!e.altKey && !flying && controls.enabled && !options.blocked?.()) beginFly(e)
    }
    if (e.button === 1) e.preventDefault()
  }
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault()
  }
  const onMove = (e: PointerEvent): void => {
    if (!flying || e.pointerId !== flyPointer) return
    const dx = e.clientX - flyLast.x
    const dy = e.clientY - flyLast.y
    flyLast = { x: e.clientX, y: e.clientY }
    flyAngles = flyLook(flyAngles, dx, dy)
    camera.quaternion.copy(flyQuaternion(flyAngles))
  }
  const onRelease = (e: PointerEvent): void => {
    if (flying && e.button === 2) endFly()
  }
  // The browser's context menu never opens over the canvas: the right button
  // is the fly's. (`OrbitControls` stops it only while it is enabled, and the
  // fly disables it: its release would open the menu otherwise.)
  const onContextMenu = (e: Event): void => e.preventDefault()
  const onWheel = (e: WheelEvent): void => {
    if (!flying) return
    e.preventDefault()
    flyScale = flyWheel(flyScale, e.deltaY)
  }
  const flyKey = (e: KeyboardEvent, down: boolean): void => {
    if (!flying) return
    const k = FLY_CODES[e.code as keyof typeof FLY_CODES]
    if (!k) return
    held[k] = down
    e.preventDefault()
  }
  const onKeyDown = (e: KeyboardEvent): void => flyKey(e, true)
  const onKeyUp = (e: KeyboardEvent): void => flyKey(e, false)
  const onBlur = (): void => endFly()

  dom.addEventListener('pointerdown', onPress, { capture: true })
  dom.addEventListener('mousedown', onMouseDown, { capture: true })
  dom.addEventListener('pointermove', onMove, { capture: true })
  dom.addEventListener('pointerup', onRelease, { capture: true })
  dom.addEventListener('contextmenu', onContextMenu)
  dom.addEventListener('wheel', onWheel, { capture: true, passive: false })
  globalThis.addEventListener('keydown', onKeyDown, { capture: true })
  globalThis.addEventListener('keyup', onKeyUp, { capture: true })
  globalThis.addEventListener('blur', onBlur)
  const controls = new OrbitControls(camera, dom)
  controls.enableDamping = true
  controls.screenSpacePanning = false
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.DOLLY,
  }
  // Never under the ground plane of the orbit: a course is laid from above.
  controls.maxPolarAngle = policyMaxPolar
  let topDown = false
  let lastRadius = 1000
  const lastCentre = new THREE.Vector3()

  /** The eye's height above the render surface (or above the play area's floor, with no ground yet). */
  const heightNow = (): number => {
    const g = options.surfaceAt?.(camera.position.x, camera.position.z) ?? Number.NEGATIVE_INFINITY
    const floor = Number.isFinite(g) ? g : lastCentre.y
    return Math.max(camera.position.y - floor, 0)
  }

  const aspectNow = (): number => {
    const w = dom.clientWidth || 1
    const h = dom.clientHeight || 1
    return w / h
  }

  const place = (target: THREE.Vector3, distance: number, down: boolean): void => {
    endFly()
    // A placed view is the orbit's own again: the policy's floor, not the fly's.
    controls.maxPolarAngle = policyMaxPolar
    controls.target.copy(target)
    if (down) {
      // A hair off the pole: exactly on it, the orbit's up vector is undefined.
      camera.position.set(target.x, target.y + distance, target.z + distance * 1e-4)
    } else {
      const elevation = THREE.MathUtils.degToRad(DESK_POLICY.frameElevationDegrees)
      camera.position.set(
        target.x,
        target.y + distance * Math.sin(elevation),
        target.z + distance * Math.cos(elevation),
      )
    }
    camera.lookAt(target)
    controls.update()
  }

  return {
    camera,
    controls,
    get topDown() {
      return topDown
    },
    get flying() {
      return flying
    },
    get flyScale() {
      return flyScale
    },
    frame(area) {
      const { centre, radius } = areaSphere(area)
      lastRadius = radius
      lastCentre.copy(centre)
      camera.aspect = aspectNow()
      const distance = frameDistance(radius, camera.fov, camera.aspect)
      camera.near = deskNear(distance, template.near)
      camera.far = Math.max(template.far, distance + DESK_CAMERA_POLICY.farRadii * radius)
      camera.updateProjectionMatrix()
      // Room to zoom out, not to lose the island in the distance.
      controls.maxDistance = 2 * distance
      place(centre, distance, topDown)
    },
    setTopDown(on) {
      if (on === topDown) return
      topDown = on
      controls.enableRotate = !on
      const distance = Math.max(camera.position.distanceTo(controls.target), lastRadius * 0.25)
      place(controls.target.clone(), distance, on)
    },
    focus(point) {
      camera.aspect = aspectNow()
      const distance = frameDistance(
        DESK_CAMERA_POLICY.focusSpanMetres / 2,
        camera.fov,
        camera.aspect,
      )
      if (topDown) {
        place(point.clone(), distance, true)
        return
      }
      // The same direction of view, from the new distance: F brings the eye
      // to the point, it does not swing it round.
      endFly()
      controls.maxPolarAngle = policyMaxPolar
      const back = camera.position.clone().sub(controls.target)
      if (back.lengthSq() < 1e-9) back.set(0, 1, 1)
      back.setLength(distance)
      controls.target.copy(point)
      camera.position.copy(point).add(back)
      camera.lookAt(point)
      controls.update()
    },
    update(seconds = 0) {
      const aspect = aspectNow()
      let far: number
      let near: number
      if (flying) {
        // The fly moves the eye; the orbit does not run (its `update` would
        // put the eye back on its sphere round the old target).
        const dt = Math.min(Math.max(seconds, 0), 0.1)
        const speed = flySpeed(heightNow(), flyScale)
        camera.position.add(flyStep(flyAngles, held, speed, dt))
        camera.quaternion.copy(flyQuaternion(flyAngles))
        // Mid-fly the old target means nothing, so the depth range follows
        // the eye itself: near from its height above the render surface (the
        // nearest ground there is, looking down), far past the play area from
        // where the eye now is.
        near = deskNear(heightNow(), template.near)
        far = Math.max(
          template.far,
          camera.position.distanceTo(lastCentre) + DESK_CAMERA_POLICY.farRadii * lastRadius,
        )
      } else {
        controls.update()
        const distance = camera.position.distanceTo(controls.target)
        // The far plane reaches past the whole play area from wherever the eye
        // is. The game's own (`CAMERA_FAR`, 6 km) is a pilot's, and the island
        // framed whole is further away than that: without this the map is
        // clipped to nothing exactly when it is framed.
        far = Math.max(template.far, distance + DESK_CAMERA_POLICY.farRadii * lastRadius)
        // DEV-472: and the near plane follows the distance (policy.ts says why).
        near = deskNear(distance, template.near)
      }
      // ── DEV-498: and out to the far sea, from wherever the eye is ─────────
      // The play area's rule above stops 14-22 km out, which is where the sea
      // the game builds for its own 6 km far plane used to end. The desk draws
      // the rest of the plate while it is up, and the far plane takes it in.
      // Depth precision is the near plane's (DEV-472's fraction): a far plane
      // well past the near one costs nothing measurable at the island.
      far = Math.max(far, options.farReach?.(camera.position) ?? 0)
      // ── end DEV-498 ─────────────────────────────────────────────────────
      if (
        Math.abs(aspect - camera.aspect) > 1e-6 ||
        Math.abs(far - camera.far) > 1 ||
        Math.abs(near - camera.near) > camera.near * 0.01
      ) {
        camera.aspect = aspect
        camera.far = far
        camera.near = near
        camera.updateProjectionMatrix()
      }
    },
    dispose() {
      endFly()
      dom.removeEventListener('pointerdown', onPress, { capture: true })
      dom.removeEventListener('mousedown', onMouseDown, { capture: true })
      dom.removeEventListener('pointermove', onMove, { capture: true })
      dom.removeEventListener('pointerup', onRelease, { capture: true })
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('wheel', onWheel, { capture: true })
      globalThis.removeEventListener('keydown', onKeyDown, { capture: true })
      globalThis.removeEventListener('keyup', onKeyUp, { capture: true })
      globalThis.removeEventListener('blur', onBlur)
      controls.dispose()
    },
  }
}
