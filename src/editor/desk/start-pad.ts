// src/editor/desk/start-pad.ts — the start pad, drawn where the course puts it.
// DEV-475 (docs/plan/EDITOR-PLAYTEST-2026-09-27.md, Matt's answer 1).
//
// Matt: *"a visible hover-pad marker dragged anywhere on the island and aimed;
// the ship starts on it and lifts off, the racers on slots beside it."*
//
// ── The game's own pads, by the game's own list ───────────────────────────
//
// No new art. The deck is `render/start-grid.ts`'s `createStartGrid`, dressed
// in 2016's `Projector04-Faceted` dish (`START_PAD_MESH`, DEV-444), and the
// pads on it are the list `boot/app.ts` builds for a mission —
// `deckPadsOf(grid, releasePadOf(...), racerStarts(...).filter(heldAtRelease))`
// — over the spawn the course EXPANDS to (`playerCourseSpawn`). So the player's
// pad, the sky's two `ai` pads beside it and the preset's slots stand here
// exactly where they will stand when the course is flown, because they are
// computed by the same functions from the same data.
//
// ── What the pad art cannot say, and the overlay that says it ─────────────
//
// A dish is round: it does not show which way the ship will face. So an arrow
// lies on the pad along the heading, and a handle marks it to be picked, both
// drawn through the ground at a constant size on screen like every desk
// overlay (`view.ts`'s header). The arrow is built pointing along local −z
// and turned by the spawn's own quaternion, the ship's convention, so it
// points where the NOSE will: `start-pad.spec.ts` checks that against the ship
// the game spawns, by geometry.
//
// Materials: the grid's are three's own `MeshStandardMaterial` (no patch);
// the overlay's are `MeshBasicMaterial`. Nothing here has an
// `onBeforeCompile`.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { type PlayerCourseStart, playerCourseSpawn, yawForward } from '@/content/player-course'
import { racerStarts } from '@/game/racer-grid'
import { loadMesh } from '@/render/load-mesh'
import {
  createStartGrid,
  deckPadsOf,
  heldAtRelease,
  releasePadOf,
  START_PAD_MESH,
  type StartGrid,
  type StartGridPad,
} from '@/render/start-grid'
import { DESK_POLICY } from './policy'

/** Feel, not physics. Pinned by value in `tests/unit/editor-desk.test.ts`. */
export const START_PAD_POLICY = {
  /** The heading arrow's length, in handle radii: long enough to read from the framing distance. */
  arrowHandles: 9,
  /** The pad's handle, in handle radii: a little bigger than a point's, as the start marker was. */
  handleHandles: 1.6,
} as const

/** Draw order: over the line (1000) and with the handles. */
const ORDER = 1002

const COLOUR = { pad: 0x33e07a, picked: 0xffc233 } as const

export interface DeskStartPad {
  readonly object: THREE.Group
  /** Stand the deck for `start` over `donor`, the racers on `racers`' grid. `picked` lights the handle. */
  set(start: PlayerCourseStart, donor: Level, racers: EditionRacers, picked: boolean): void
  /** Each frame: the handle and the arrow a constant size on screen. */
  update(camera: THREE.Camera): void
  /** The pads as drawn: role and foot, level frame. For the probe. */
  pads(): { role: string; foot: [number, number, number] }[]
  /** The drawn arrow's tail and tip, level frame, from its WORLD MATRIX; null when hidden. */
  arrow(): { tail: [number, number, number]; tip: [number, number, number] } | null
  /** Whether 2016's dish has dressed the pads (the art landed). */
  dressed(): boolean
  dispose(): void
}

/** A flat arrow in the XZ plane, one unit long, tail at the origin, pointing along −z. */
const arrowGeometry = (): THREE.BufferGeometry => {
  const shape = new THREE.Shape()
  const w = 0.07
  const head = 0.3
  const hw = 0.2
  shape.moveTo(-w, 0)
  shape.lineTo(-w, 1 - head)
  shape.lineTo(-hw, 1 - head)
  shape.lineTo(0, 1)
  shape.lineTo(hw, 1 - head)
  shape.lineTo(w, 1 - head)
  shape.lineTo(w, 0)
  shape.closePath()
  const g = new THREE.ShapeGeometry(shape)
  // The shape is drawn in XY along +y; lay it down on XZ along −z.
  g.rotateX(-Math.PI / 2)
  return g
}

export const createDeskStartPad = (): DeskStartPad => {
  const object = new THREE.Group()
  object.name = 'editor-start-pad'

  // ── the deck: the game's own ─────────────────────────────────────────
  let grid: StartGrid | null = null
  let gridPads: StartGridPad[] = []
  let art: THREE.Object3D | null = null
  let artDispose: (() => void) | null = null
  let isDressed = false
  const dropGrid = (): void => {
    if (!grid) return
    grid.object.removeFromParent()
    grid.dispose()
    grid = null
    isDressed = false
  }
  const dress = (): void => {
    if (!grid || !art || isDressed) return
    try {
      grid.dress(art)
      isDressed = true
    } catch (err) {
      console.warn("editor: 2016's pad would not stand; the octagons stay", err)
    }
  }
  void loadMesh(assetUrl(START_PAD_MESH)).then(
    (loaded) => {
      art = loaded.object
      artDispose = () => loaded.dispose()
      dress()
    },
    (err: unknown) => console.warn("editor: 2016's pad did not load; the octagons stay", err),
  )

  // ── the overlay: the heading, and a handle ────────────────────────────
  const overlay = (color: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
  const arrowMaterial = overlay(COLOUR.pad)
  const pickedMaterial = overlay(COLOUR.picked)
  const arrowGeo = arrowGeometry()
  const arrowMesh = new THREE.Mesh(arrowGeo, arrowMaterial)
  arrowMesh.name = 'editor-start-arrow'
  arrowMesh.renderOrder = ORDER
  arrowMesh.frustumCulled = false
  const ball = new THREE.OctahedronGeometry(1, 0)
  const handle = new THREE.Mesh(ball, arrowMaterial)
  handle.name = 'editor-start-handle'
  handle.renderOrder = ORDER + 1
  handle.frustumCulled = false
  const marker = new THREE.Group()
  marker.name = 'editor-start-marker'
  marker.add(arrowMesh, handle)
  object.add(marker)

  const _p = new THREE.Vector3()
  const _eye = new THREE.Vector3()

  return {
    object,
    set(start, donor, racers, picked) {
      const spawn = playerCourseSpawn(start, donor)
      if (!spawn) {
        dropGrid()
        marker.visible = false
        gridPads = []
        return
      }
      // `boot/app.ts`'s list, from the same functions (see the header).
      const level = { ...donor, spawn, ghosts: [] } as Level
      const release = releasePadOf(spawn.startGrid, spawn, spawn.launch)
      const slots = racerStarts(level, racers).filter(heldAtRelease)
      const next = deckPadsOf(spawn.startGrid, release, slots)
      if (!grid || next.length !== gridPads.length) {
        dropGrid()
        grid = createStartGrid({ slabs: [], lightBar: null, pads: next })
        object.add(grid.object)
        dress()
      } else {
        next.forEach((pad, i) => {
          const g = (grid as StartGrid).pads[i] as THREE.Object3D
          g.position.set(pad.pos[0] as number, pad.pos[1] as number, pad.pos[2] as number)
          g.quaternion.set(
            pad.quat[0] as number,
            pad.quat[1] as number,
            pad.quat[2] as number,
            pad.quat[3] as number,
          )
        })
      }
      gridPads = next
      // The marker on the pad's foot, turned as the ship is.
      marker.visible = true
      marker.position.set(start.pos[0], start.pos[1], start.pos[2])
      marker.quaternion.set(
        spawn.quat[0] as number,
        spawn.quat[1] as number,
        spawn.quat[2] as number,
        spawn.quat[3] as number,
      )
      arrowMesh.material = picked ? pickedMaterial : arrowMaterial
      handle.material = picked ? pickedMaterial : arrowMaterial
      // A check on the convention, cheap and loud: the arrow's −z, turned,
      // must be the heading `yawForward` gives (the nose's direction).
      const f = yawForward(start.yaw)
      _p.set(0, 0, -1).applyQuaternion(marker.quaternion)
      if (Math.abs(_p.x - f.x) + Math.abs(_p.z - f.z) > 1e-6) {
        console.warn('editor: the start arrow and the heading disagree')
      }
    },
    update(camera) {
      if (!marker.visible) return
      camera.getWorldPosition(_eye)
      const d = marker.getWorldPosition(_p).distanceTo(_eye)
      const unit = d * DESK_POLICY.handleScreenFraction
      handle.scale.setScalar(unit * START_PAD_POLICY.handleHandles)
      arrowMesh.scale.setScalar(unit * START_PAD_POLICY.arrowHandles)
    },
    pads: () =>
      gridPads.map((p) => ({
        role: p.role,
        foot: [p.pos[0] as number, p.pos[1] as number, p.pos[2] as number],
      })),
    arrow() {
      if (!marker.visible) return null
      arrowMesh.updateWorldMatrix(true, false)
      const tail = new THREE.Vector3(0, 0, 0).applyMatrix4(arrowMesh.matrixWorld)
      const tip = new THREE.Vector3(0, 0, -1).applyMatrix4(arrowMesh.matrixWorld)
      return { tail: tail.toArray(), tip: tip.toArray() }
    },
    dressed: () => isDressed,
    dispose() {
      dropGrid()
      object.removeFromParent()
      arrowGeo.dispose()
      ball.dispose()
      arrowMaterial.dispose()
      pickedMaterial.dispose()
      artDispose?.()
    },
  }
}
