// tests/unit/helpers/tv-world.ts: one course's world as TV's camera sees it. DEV-481.
//
// NOT a `.test.ts`, so vitest does not collect it. `tv-vantage.test.ts` and
// `tv-camera.test.ts` both need "the ground" and "the props" for a shipped
// course, built the way `boot/app.ts`'s camera block builds them:
//
//   heightAt     the HIGHER of the RENDERED surface (`islandGround`, the
//                desk's own builder over the jittered vertex grid, land and
//                the sea's high-water mark) and the COLLISION surface
//                (`fieldFor` / `oceanFieldFor`). CLAUDE.md's trap: the two
//                differ by up to 21.8 m on steep desert, so a camera that is
//                clear of one can be inside the other.
//   obstructed   a sphere against Anniversary's forest and landmarks
//                (`forestFor`, the same colliders the game builds), SIM space
//                one z flip on the way in.
//
// `renderAt` and `collisionAt` are also handed out separately, so a test can
// check a camera against EACH surface rather than against the max it was
// built from. Every disk read happens inside these functions, never at module
// scope (`describe.skipIf` skips the tests, not the describe body).

import type { Level } from '@/content/level-schema'
import type { PropCollisionSpec } from '@/sim/props/collision'
import { propPenetrationAt } from '@/sim/props/collision'
import { type HeightField, outsideField, terrainHeightAt } from '@/sim/terrain/height-field'
import anniversary from '../../../content/editions/anniversary.json'
import { islandGround } from './editor-course'
import { forestFor } from './prop-forest'
import { fieldFor, oceanFieldFor } from './terrain-field'

const EDITION = anniversary as unknown as {
  gameplay: { propCollision: PropCollisionSpec }
  props: {
    scale: Record<string, unknown>
    unbakedPasses: { enabled: boolean }
    groundSnap: { enabled: boolean; sink: number }
    maxSlope: { enabled: boolean; sin: number }
  }
}

/** Anniversary's forest, as `crash-reset-clearance.test.ts` builds it. */
export const FOREST_OPTIONS = {
  spec: EDITION.gameplay.propCollision,
  scale: EDITION.props.scale,
  unbakedPasses: EDITION.props.unbakedPasses.enabled,
  groundSnapSink: EDITION.props.groundSnap.enabled ? EDITION.props.groundSnap.sink : null,
  maxSlope: EDITION.props.maxSlope.enabled ? EDITION.props.maxSlope.sin : null,
  landmarks: true,
}

export interface TvWorld {
  readonly heightAt: (x: number, z: number) => number
  readonly renderAt: (x: number, z: number) => number
  readonly collisionAt: (x: number, z: number) => number
  readonly obstructed: (x: number, y: number, z: number, r: number) => boolean
  /** How deep a sphere at (x, y, z) THREE world goes into a prop, metres (0: clear). */
  readonly propDepth: (x: number, y: number, z: number, r: number) => number
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

/** The world of `level` (THREE world in, THREE world out). */
export const tvWorldFor = (level: Level): TvWorld => {
  const ground = islandGround(level)
  const fields: HeightField[] = [fieldFor(level)]
  const sea = oceanFieldFor(level)
  if (sea) fields.push(sea)
  const props = forestFor(level.environment, fields[0] as HeightField, {
    ...FOREST_OPTIONS,
    missionProps: (level.props ?? null) as never,
  })
  const collisionAt = (x: number, z: number): number => {
    let top = Number.NEGATIVE_INFINITY
    for (const f of fields) {
      if (outsideField(f, x, -z)) continue
      const h = terrainHeightAt(f, x, -z)
      if (h > top) top = h
    }
    return top
  }
  const renderAt = (x: number, z: number): number => ground.surfaceAt(x, z)
  const propDepth = (x: number, y: number, z: number, r: number): number =>
    propPenetrationAt({ x, y, z: -z }, IDENTITY, [{ x: 0, y: 0, z: 0, radius: r }], props)
  return {
    heightAt: (x, z) => Math.max(renderAt(x, z), collisionAt(x, z)),
    renderAt,
    collisionAt,
    obstructed: (x, y, z, r) => propDepth(x, y, z, r) > 0,
    propDepth,
  }
}
