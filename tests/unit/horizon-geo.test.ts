/**
 * tests/unit/horizon-geo.test.ts — the far shore is where and how it says.
 *
 * DEV-119. The orientation lesson: test the GEOMETRY, not the belief. Every
 * card must face the eye at the centre (its normal points inward — measured
 * from the vertices, not asserted from a winding I typed), stand at the
 * radius, rise from the base to no higher than the peak, and carry one colour
 * per card inside 0..1. The profile is deterministic and bounded; the flip
 * shows, hides and rebuilds.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/boot/settings'
import type { Edition, EditionHorizonGeo } from '../../src/content/edition-schema'
import { createEditionState } from '../../src/game/edition'
import {
  BASE_DROP,
  buildHorizonGeometry,
  CARDS_PER_BAND,
  createHorizonGeo,
  HORIZON_COLUMNS,
  type HorizonWorld,
  horizonProfile,
  INNER_RADIUS,
} from '../../src/render/horizon-geo'

const world = (over: Partial<HorizonWorld> = {}): HorizonWorld => ({
  referenceY: -46,
  sunDirection: [0.9623, -0.0698, 0.2631],
  sunColor: [0.83, 0.57, 0.39],
  horizonColor: (dx, _dz, out) => {
    // A sky that is warmer toward +x, like a sunset on one side.
    out.r = 0.5 + 0.2 * dx
    out.g = 0.32
    out.b = 0.25
  },
  seed: 0x5cf1,
  ...over,
})

const spec = (over: Partial<EditionHorizonGeo> = {}): EditionHorizonGeo => ({
  enabled: true,
  radius: 5200,
  peakMetres: 420,
  silhouette: 0.55,
  ...over,
})

describe('horizon profile', () => {
  it('is deterministic for a seed, different for another, and bounded 0..1', () => {
    const a = horizonProfile(HORIZON_COLUMNS, 7)
    const b = horizonProfile(HORIZON_COLUMNS, 7)
    const c = horizonProfile(HORIZON_COLUMNS, 8)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(a)).not.toEqual(Array.from(c))
    for (const h of a) {
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
  })

  it('has peaks AND saddles — a range, not a wall and not a flat line', () => {
    const p = horizonProfile(HORIZON_COLUMNS, 0x5cf1, CARDS_PER_BAND)
    const max = Math.max(...p)
    const zeros = Array.from(p).filter((h) => h === 0).length
    expect(max).toBeGreaterThan(0.5)
    expect(zeros, 'somewhere the sea shows through to the sky').toBeGreaterThan(0)
    expect(zeros, 'but not everywhere').toBeLessThan(HORIZON_COLUMNS * 0.9)
  })
})

describe('horizon geometry', () => {
  const g = buildHorizonGeometry(spec(), world())
  const pos = g.getAttribute('position') as THREE.BufferAttribute
  const col = g.getAttribute('color') as THREE.BufferAttribute

  it('is two bands of one quad per column, split vertices, no index', () => {
    expect(g.index).toBeNull()
    expect(pos.count).toBe(2 * HORIZON_COLUMNS * 6)
    expect(col.count).toBe(pos.count)
  })

  it('every card faces the eye at the centre — measured from its vertices', () => {
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const n = new THREE.Vector3()
    const inward = new THREE.Vector3()
    let facing = 0
    let degenerate = 0
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i)
      b.fromBufferAttribute(pos, i + 1)
      c.fromBufferAttribute(pos, i + 2)
      n.subVectors(b, a).cross(c.clone().sub(a))
      if (n.lengthSq() < 1e-6) {
        degenerate++
        continue
      }
      // Toward the axis from the triangle's centroid, in the ground plane.
      inward.set(-(a.x + b.x + c.x), 0, -(a.z + b.z + c.z))
      if (n.dot(inward) > 0) facing++
    }
    const tested = pos.count / 3 - degenerate
    expect(tested).toBeGreaterThan(0)
    expect(facing, 'inward-facing triangles').toBe(tested)
    // Degenerate triangles are the columns where the ridge is at the base on
    // both sides (a saddle at sea level): zero-area, drawn as nothing.
    expect(degenerate).toBeLessThan(pos.count / 3)
  })

  it('stands at the radius, outer and inner bands, and rises from the base to at most the peak', () => {
    const s = spec()
    const w = world()
    const baseY = w.referenceY - BASE_DROP
    const outerCount = HORIZON_COLUMNS * 6
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getZ(i))
      const expected = i < outerCount ? s.radius : s.radius * INNER_RADIUS
      expect(r).toBeCloseTo(expected, 3)
      expect(pos.getY(i)).toBeGreaterThanOrEqual(baseY - 1e-6)
      expect(pos.getY(i)).toBeLessThanOrEqual(w.referenceY + s.peakMetres + 1e-6)
    }
  })

  it('one colour per card, in 0..1, darker than the sky it is cut from', () => {
    for (let card = 0; card < pos.count / 6; card++) {
      const first = [col.getX(card * 6), col.getY(card * 6), col.getZ(card * 6)]
      for (let k = 1; k < 6; k++) {
        expect([col.getX(card * 6 + k), col.getY(card * 6 + k), col.getZ(card * 6 + k)]).toEqual(
          first,
        )
      }
      for (const v of first) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // The sky behind the card is at least 0.3 in red in this fake; a cut-out
      // at silhouette 0.55 with +-7 % jitter and a little sun warmth cannot
      // reach it.
      expect(first[0] as number).toBeLessThan(0.3 * 0.55 * 1.07 + 0.3)
    }
  })

  it('cards facing the sun are warmer than cards facing away from it', () => {
    // The sun travels along +x, so its light comes FROM -x: cards at -x face it.
    const w = world({
      sunDirection: [1, 0, 0],
      sunColor: [1, 0.5, 0],
      horizonColor: (_dx, _dz, out) => {
        out.r = 0.4
        out.g = 0.4
        out.b = 0.4
      },
    })
    const gg = buildHorizonGeometry(spec({ silhouette: 1 }), w)
    const cc = gg.getAttribute('color') as THREE.BufferAttribute
    const pp = gg.getAttribute('position') as THREE.BufferAttribute
    let toward = 0
    let towardN = 0
    let away = 0
    let awayN = 0
    for (let card = 0; card < HORIZON_COLUMNS; card++) {
      const x = pp.getX(card * 6)
      const rb = cc.getX(card * 6) - cc.getZ(card * 6) // red minus blue: warmth
      if (x < -0.9 * 5200) {
        toward += rb
        towardN++
      } else if (x > 0.9 * 5200) {
        away += rb
        awayN++
      }
    }
    expect(towardN).toBeGreaterThan(0)
    expect(awayN).toBeGreaterThan(0)
    expect(toward / towardN).toBeGreaterThan(away / awayN + 0.02)
  })

  it('a peak of zero is a ring entirely under the reference level — the Classic no-op', () => {
    const gg = buildHorizonGeometry(spec({ peakMetres: 0 }), world())
    const pp = gg.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pp.count; i++) expect(pp.getY(i)).toBeLessThanOrEqual(-46 + 1e-6)
  })
})

describe('the mesh and the flip', () => {
  const edition = (hg: Partial<EditionHorizonGeo>): Edition =>
    ({ render: { horizonGeo: spec(hg) } }) as unknown as Edition

  it('follows the eye in x and z only, never in y and never in orientation', () => {
    const state = createEditionState(edition({}), DEFAULT_SETTINGS)
    const hg = createHorizonGeo(state, world())
    hg.update(new THREE.Vector3(1234, 850, -777))
    expect(hg.object.position.toArray()).toEqual([1234, 0, -777])
    expect(hg.object.quaternion.equals(new THREE.Quaternion())).toBe(true)
    hg.dispose()
  })

  it('shows on Anniversary, hides on Classic, and rebuilds when a number moves', () => {
    const state = createEditionState(edition({}), DEFAULT_SETTINGS)
    const hg = createHorizonGeo(state, world())
    expect(hg.object.visible).toBe(true)
    const before = hg.object.geometry
    state.setLook(edition({ enabled: false }))
    expect(hg.object.visible).toBe(false)
    expect(hg.object.geometry, 'a flag alone rebuilds nothing').toBe(before)
    state.setLook(edition({ radius: 4000 }))
    expect(hg.object.geometry).not.toBe(before)
    const pp = hg.object.geometry.getAttribute('position') as THREE.BufferAttribute
    expect(Math.hypot(pp.getX(0), pp.getZ(0))).toBeCloseTo(4000, 3)
    hg.dispose()
  })

  it('is one mesh, unlit, vertex-coloured, front-side only, world-locked and never a caster', () => {
    const state = createEditionState(edition({}), DEFAULT_SETTINGS)
    const hg = createHorizonGeo(state, world())
    const m = hg.material as THREE.MeshBasicMaterial
    expect(m.isMeshBasicMaterial).toBe(true)
    expect(m.vertexColors).toBe(true)
    expect(m.side).toBe(THREE.FrontSide)
    expect(m.fog, "the mission fog patches it; three's own stays off").toBe(false)
    expect(hg.object.castShadow).toBe(false)
    expect(hg.object.frustumCulled).toBe(false)
    hg.dispose()
  })
})
