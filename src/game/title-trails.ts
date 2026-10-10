// src/game/title-trails.ts — the title's flypast jets wear the racers' trails.
// DEV-412.
//
// Matt, 2026-09-25: *"title screen jets should have wingtip trails and engine
// trails (as well as the same wing geo as the in-game jets)"*. The wing is
// `dressRacerHull`'s own (`boot/app.ts` passes it `wings: true` now). This is
// the trails, built by the racers' factories so the title cannot drift from
// the race: `createEngineTrail` per jet, and one `createCraftWingTrails` batch
// for all of them.
//
// A title jet has no sim body. It is placed on a curve by `Title.update`, so
// the wing trails' speed fade reads a speed taken from successive WORLD
// positions, the way the player's ghost does (DEV-408). A jump of more than
// `TITLE_TRAIL_TELEPORT_M` in one frame is a flypast wrapping back to its
// start rather than flight, and it clears that jet's ribbons instead of
// drawing one across the sky.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import { createEngineTrail, trailEmitterOffset } from '@/game/racers'
import { type CraftWingTrails, createCraftWingTrails } from '@/game/wing-trails'
import type { Srgb } from '@/render/racer-livery'
import type { WingTips } from '@/render/wing-trails'

/**
 * Metres in ONE frame past which a jet has been moved, not flown. The
 * flypast's jets travel metres per frame; 100 m in a frame is about
 * 6,000 m/s at 60 Hz, which only a wrap back to the curve's start produces.
 */
export const TITLE_TRAIL_TELEPORT_M = 100

export interface TitleJet {
  /** The jet's group, as `Title.update` places it. */
  readonly object: THREE.Object3D
  /** Its wing tips, measured off the hull before the wing was hung. */
  readonly tips: WingTips
  /** Its livery, or null for a hologram with no colour. */
  readonly colour: Srgb | null
}

export interface TitleTrails {
  /** World-space ribbons: add to the scene ROOT, never under a moved parent. */
  readonly group: THREE.Group
  /** Every trail material, for the caller's fog. */
  readonly materials: readonly THREE.Material[]
  /** After `Title.update` has placed the jets this frame. */
  update(eye: THREE.Vector3, dt: number): void
  dispose(): void
}

export const createTitleTrails = (
  jets: readonly TitleJet[],
  edition: EditionState,
): TitleTrails => {
  const group = new THREE.Group()
  group.name = 'title-trails'
  const wingsLook = () => edition.current.fx.wingTrails
  const engines = jets.map((j) => {
    const e = createEngineTrail(j.colour, wingsLook())
    group.add(e.trail.object)
    return e
  })
  const bodies = jets.map(() => ({
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    velocity: { x: 0, y: 0, z: 0 },
  }))
  const wingTrails: CraftWingTrails | null =
    jets.length > 0
      ? createCraftWingTrails(
          jets.map((j, i) => ({
            tips: j.tips,
            frame: j.object,
            body: bodies[i] as (typeof bodies)[number],
            livery: j.colour,
          })),
          'wing-trails:title',
        )
      : null
  if (wingTrails) group.add(wingTrails.trails.object)

  const trailLocal = trailEmitterOffset()
  const last = jets.map(() => new THREE.Vector3())
  const placed = jets.map(() => false)
  const at = new THREE.Vector3()
  const turn = new THREE.Quaternion()
  const emitter = new THREE.Vector3()

  return {
    group,
    materials: [
      ...engines.map((e) => e.material),
      ...(wingTrails ? [wingTrails.trails.material] : []),
    ],
    update(eye, dt) {
      for (let i = 0; i < jets.length; i++) {
        const jet = jets[i] as TitleJet
        const engine = engines[i] as (typeof engines)[number]
        const body = bodies[i] as (typeof bodies)[number]
        const prev = last[i] as THREE.Vector3
        jet.object.updateWorldMatrix(true, false)
        jet.object.getWorldPosition(at)
        const moved = placed[i] ? at.distanceTo(prev) : 0
        if (!jet.object.visible || moved > TITLE_TRAIL_TELEPORT_M) {
          engine.trail.reset()
          wingTrails?.clear(i)
          body.velocity.z = 0
        } else {
          body.velocity.z = placed[i] && dt > 0 ? moved / dt : 0
          jet.object.getWorldQuaternion(turn)
          emitter.copy(trailLocal).applyQuaternion(turn).add(at)
          engine.trail.update(emitter, eye, dt)
        }
        prev.copy(at)
        placed[i] = true
      }
      wingTrails?.update(eye, dt, wingsLook(), edition.speedFx, true)
    },
    dispose() {
      for (const e of engines) {
        e.trail.dispose()
        e.material.dispose()
        e.base.dispose()
      }
      wingTrails?.dispose()
      group.removeFromParent()
      group.clear()
    },
  }
}
