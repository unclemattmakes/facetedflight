// tests/unit/pad-art.test.ts — the pad and orb meshes measure what they draw.
//
// ── Why the art gets a geometry test ──────────────────────────────────────
//
// Because "the orientation lesson" says six bugs in six subsystems have been the
// same class: a mesh placed by a transform nobody measured, hiding on symmetric
// geometry, caught by Matt from a screenshot with 600 tests green. A jump pad is
// radially symmetric with a square bullseye and an orb is a ball — between them
// they are the most bug-friendly shapes in the game.
//
// So nothing below asserts a rotation. Each test pulls the instance matrix back
// apart and asks a question with a unit on it: how wide is the box that got
// drawn, how far apart are two of them, is the plate as thin as its collider.
// The answers are true whatever anyone believed about handedness.
//
// These run in vitest's `environment: 'node'`. three's scene-graph and geometry
// classes need no DOM and no GPU; only `WebGLRenderer` does, and nothing here
// touches one.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { loadOrbs, ORB_MESH_NODE } from '@/game/orb-art'
import { liveOrbs, ORB_COLLECT_RADIUS, orbPos } from '@/game/orbs'
import { loadPads, PAD_PALETTE } from '@/game/pad-art'
import { livePads, padZones } from '@/game/targets'
import { levelJson as level } from './helpers/content'

/**
 * How big the instance was actually drawn, measured off the matrix columns.
 *
 * **Not `Matrix4.decompose`**, which is the obvious call and is wrong for this:
 * three reports scale `(1, 1, 1)` for an all-zero matrix rather than `(0, 0, 0)`
 * — it cannot divide by a zero column to recover a rotation, so it hands back
 * the identity. A hidden instance would look full size. The length of each basis
 * column IS the scale along that axis and is right in both cases.
 *
 * The numbers come back in float32: `InstancedMesh.instanceMatrix` is a
 * `Float32BufferAttribute`, so a 14.5 m box at x = 1300 round-trips to about
 * seven significant figures and every tolerance below is set for that.
 */
const drawnSize = (mesh: THREE.InstancedMesh, i: number): THREE.Vector3 => {
  const m = new THREE.Matrix4()
  mesh.getMatrixAt(i, m)
  const e = m.elements as unknown as number[]
  return new THREE.Vector3(
    Math.hypot(e[0] as number, e[1] as number, e[2] as number),
    Math.hypot(e[4] as number, e[5] as number, e[6] as number),
    Math.hypot(e[8] as number, e[9] as number, e[10] as number),
  )
}

const positionOf = (mesh: THREE.InstancedMesh, i: number): THREE.Vector3 => {
  const m = new THREE.Matrix4()
  mesh.getMatrixAt(i, m)
  return new THREE.Vector3().setFromMatrixPosition(m)
}

const instanced = (root: THREE.Object3D, name: string): THREE.InstancedMesh => {
  const found = root.getObjectByName(name)
  if (!found) throw new Error(`no instanced mesh called ${name}`)
  return found as THREE.InstancedMesh
}

describe('the pad mesh is the pad you land on (DEV-120 / DEV-121)', () => {
  const L = level('int_01_jumpSeat')
  const padMesh = (root: THREE.Object3D, i: number): THREE.Mesh => {
    const found = root.getObjectByName(`pad-${i}`)
    if (!found) throw new Error(`no mesh called pad-${i}`)
    return found as THREE.Mesh
  }
  /** Vertices of a mesh with their local radius, height and colour. */
  const vertices = (mesh: THREE.Mesh) => {
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const out: { r: number; y: number; c: THREE.Color }[] = []
    for (let i = 0; i < pos.count; i++) {
      out.push({
        r: Math.hypot(pos.getX(i), pos.getZ(i)),
        y: pos.getY(i),
        c: new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)),
      })
    }
    return out
  }
  const srgb = (rgb: readonly [number, number, number]) =>
    new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
  const same = (a: THREE.Color, b: THREE.Color) =>
    Math.abs(a.r - b.r) < 1e-4 && Math.abs(a.g - b.g) < 1e-4 && Math.abs(a.b - b.b) < 1e-4

  it('draws one mesh per live pad — six on int_01 — and no plates', () => {
    const art = loadPads(L)
    expect(art.count).toBe(livePads(L).length)
    expect(art.count).toBe(6)
    const meshes = art.object.children.filter((o) => (o as THREE.Mesh).isMesh)
    expect(meshes.length).toBe(6)
    expect(art.object.getObjectByName('pad-zones')).toBeUndefined()
    art.dispose()
  })

  it('has its three floors at the collider s tier heights: -1.78, -0.35, +0.97 m from the pad root', () => {
    // Geometry against the SIM's own reading of the same profile — a mesh drawn
    // off a different scale or a flipped axis would put a floor somewhere the
    // seat does not land.
    const art = loadPads(L)
    const pad = livePads(L)[0]
    if (!pad?.solid) throw new Error('expected a pad with a solid')
    const mesh = padMesh(art.object, pad.i)
    const vs = vertices(mesh)
    // Each tier floor ends at a lip that starts a few millimetres further out
    // and a little higher, so the FLOOR at a tier's outer radius is the LOWEST
    // vertex there (nothing is under a floor but the underside, 20 m away).
    const floorAt = (r: number) => {
      const near = vs.filter((v) => Math.abs(v.r - r) < 0.3)
      expect(near.length, `vertices near r=${r}`).toBeGreaterThan(0)
      return Math.min(...near.map((v) => v.y)) + pad.solid!.pos[1] - pad.pos[1]
    }
    expect(floorAt(7.058)).toBeCloseTo(-1.784, 1)
    expect(floorAt(12.78)).toBeCloseTo(-0.35, 1)
    expect(floorAt(19.78)).toBeCloseTo(0.97, 1)
    // Each tier is a full octagon: eight vertices on the rim, all at one radius.
    const rim = vs.filter((v) => Math.abs(v.r - pad.solid!.outer) < 1e-3)
    expect(rim.length).toBeGreaterThanOrEqual(8)
    art.dispose()
  })

  it('is 40.6 m across — the collider s outer radius, not the 28 m landing ball or the root scale', () => {
    const art = loadPads(L)
    const pad = livePads(L)[0]
    if (!pad?.solid) throw new Error('expected a pad with a solid')
    const mesh = padMesh(art.object, pad.i)
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox as THREE.Box3
    expect(box.max.x - box.min.x).toBeCloseTo(pad.solid.outer * 2, 1)
    expect(box.max.x - box.min.x).toBeCloseTo(40.6, 0)
    // Height: rim top to underside, 3.47 + 0.71 m.
    expect(box.max.y - box.min.y).toBeCloseTo(pad.solid.top - pad.solid.bottom, 2)
    art.dispose()
  })

  it('paints the tiers red / cream / red and the risers grey — 2016 s own materials', () => {
    const art = loadPads(L)
    const pad = livePads(L)[0]
    if (!pad?.solid) throw new Error('expected a pad with a solid')
    const vs = vertices(padMesh(art.object, pad.i))
    const top = pad.solid.top
    // The colours present on the vertices at a tier floor's outer edge, where
    // the floor meets its lip: the tier colour AND riser grey, nothing else.
    const coloursAt = (r: number, yFromRoot: number) => {
      const y = yFromRoot + pad.pos[1] - pad.solid!.pos[1]
      const near = vs.filter((v) => Math.abs(v.r - r) < 0.3 && Math.abs(v.y - y) < 0.02)
      expect(near.length, `vertices at r=${r}, y=${yFromRoot}`).toBeGreaterThan(0)
      return near.map((v) => v.c)
    }
    const only = (cs: THREE.Color[], allowed: THREE.Color[]) =>
      cs.every((c) => allowed.some((a) => same(a, c)))
    const has = (cs: THREE.Color[], want: THREE.Color) => cs.some((c) => same(c, want))
    const grey = srgb(PAD_PALETTE.riser)
    for (const [r, y, tier] of [
      [7.058, -1.784, PAD_PALETTE.bullseye],
      [12.78, -0.35, PAD_PALETTE.mid],
      [19.78, 0.97, PAD_PALETTE.outer],
    ] as const) {
      const cs = coloursAt(r, y)
      expect(has(cs, srgb(tier)), `tier colour at r=${r}`).toBe(true)
      expect(only(cs, [srgb(tier), grey]), `only tier + riser at r=${r}`).toBe(true)
    }
    // The underside is riser grey: the centre vertex at the LOWEST height (the
    // bullseye floor's centre is 1.4 m above it and red).
    const bottom = vs.find((v) => v.r < 1e-6 && Math.abs(v.y - pad.solid!.bottom) < 1e-3)
    if (!bottom) throw new Error('no underside centre vertex')
    expect(bottom.y).toBeLessThan(top - 1)
    expect(same(bottom.c, grey)).toBe(true)
    art.dispose()
  })

  it('stands where the pad is, at the collider node, not at the origin', () => {
    const art = loadPads(L)
    const pad = livePads(L)[0]
    if (!pad?.solid) throw new Error('expected a pad with a solid')
    const mesh = padMesh(art.object, pad.i)
    expect(art.object.position.length()).toBe(0)
    expect(mesh.position.distanceTo(new THREE.Vector3(...pad.solid.pos))).toBeLessThan(1e-6)
    // The node sits 2.5 m under the pad root, as the prefab has it.
    expect(pad.pos[1] - mesh.position.y).toBeCloseTo(2.4956, 3)
    art.dispose()
  })

  it('turns the 50-ring Activated green on a hit — any plate, that pad only — and leaves the rest', () => {
    const art = loadPads(L)
    const pads = livePads(L)
    const first = pads[0]
    const second = pads[1]
    if (!first?.solid || !second?.solid) throw new Error('expected two pads')
    // The mid floor's vertices sit at its two radii, 8.17 and 12.78 m, shared
    // with the grey riser and lip that meet it there — so count colours.
    const midOf = (mesh: THREE.Mesh) => vertices(mesh).filter((v) => v.r > 8.1 && v.r < 12.8)
    const count = (vs: ReturnType<typeof vertices>, c: THREE.Color) =>
      vs.filter((v) => same(v.c, c)).length
    const green = srgb(PAD_PALETTE.activated)
    const cream = srgb(PAD_PALETTE.mid)
    expect(count(midOf(padMesh(art.object, first.i)), cream)).toBeGreaterThan(0)
    // Take the OUTER plate of pad 0: in 2016 `jumpPad_renderer` is target_mid on
    // every plate, so the cream ring goes green whichever ring was hit.
    const zones = padZones(L)
    const outerOfPad0 = zones.findIndex((z) => z.pad === 0 && z.points === 25)
    expect(outerOfPad0).toBeGreaterThanOrEqual(0)
    art.takeZone(outerOfPad0)
    const hit = midOf(padMesh(art.object, first.i))
    expect(count(hit, green)).toBeGreaterThan(0)
    expect(count(hit, cream)).toBe(0)
    const other = midOf(padMesh(art.object, second.i))
    expect(count(other, cream)).toBeGreaterThan(0)
    expect(count(other, green)).toBe(0)
    // The bullseye floor of the hit pad is still red.
    const eye = vertices(padMesh(art.object, first.i)).filter((v) => v.r < 6)
    expect(
      eye.every((v) => same(v.c, srgb(PAD_PALETTE.bullseye)) || same(v.c, srgb(PAD_PALETTE.riser))),
    ).toBe(true)
    art.dispose()
  })
})

describe('the orb mesh is 2016’s ball, inside the volume it is collected at (DEV-327)', () => {
  const L = level('hoverJet_kauai_beg')

  /** The drawn ball's reach: the furthest vertex of the instanced geometry from its centre. */
  const reach = (mesh: THREE.InstancedMesh): number => {
    const p = mesh.geometry.getAttribute('position')
    let r = 0
    for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getY(i), p.getZ(i)))
    return r
  }

  it('draws nothing until its art is on, then one ball for each live orb', () => {
    // The mesh is fetched while the orbs are built, so there is nothing to draw
    // until `setArt` — and then exactly one instance per live orb.
    const art = loadOrbs(L)
    expect(art.count).toBe(liveOrbs(L).length)
    expect(art.count).toBe(11)
    expect(art.object.getObjectByName(ORB_MESH_NODE)).toBeUndefined()
    art.setArt(null)
    expect(instanced(art.object, ORB_MESH_NODE).count).toBe(11)
    art.dispose()
  })

  it('draws a ZERO-orb mission as nothing — not one orb at the world origin', () => {
    // `int_02_jumpSeat` is forced into Free Flight with all twelve orbs dead
    // (`game/orbs.ts`). three needs a buffer of one; an instance count left at
    // that capacity draws its identity matrix, which is an orb at (0, 0, 0).
    const empty = level('int_02_jumpSeat')
    expect(liveOrbs(empty)).toHaveLength(0)
    const art = loadOrbs(empty)
    art.setArt(null)
    const mesh = instanced(art.object, ORB_MESH_NODE)
    expect(mesh.count).toBe(0)
    expect(mesh.visible).toBe(false)
    art.dispose()
  })

  it('draws the ball 2016 drew — 1.628 m — a third of the way out to where it is collected', () => {
    // `EnergyOrb.prefab`: a 1 m mesh at scale 1.6284 inside a `m_Radius 3`
    // trigger at the same scale. The port used to draw a shell AT the 4.885 m
    // collection radius, because it had no mesh and that was the size it knew.
    const art = loadOrbs(L)
    art.setArt(null)
    const ball = reach(instanced(art.object, ORB_MESH_NODE))
    expect(ball).toBeCloseTo(1.6284, 4)
    expect(ORB_COLLECT_RADIUS).toBeCloseTo(4.885, 3)
    expect(ORB_COLLECT_RADIUS / ball).toBeCloseTo(3, 5)
    art.dispose()
  })

  it('stands each orb where the SIM will collect it, and keeps them apart', () => {
    const art = loadOrbs(L)
    art.setArt(null)
    const mesh = instanced(art.object, ORB_MESH_NODE)
    const orbs = liveOrbs(L)
    orbs.forEach((orb, i) => {
      // `orbPos`, not `orb.pos`: DEV-067 raises five of this mission's eleven out
      // of the mountain, and the ball has to be drawn where `sim/orbs.ts` will
      // actually collect it. Asserting against `orb.pos` here would be asserting
      // that the art and the hit test are allowed to disagree.
      // 1 mm, which is float32's resolution 1.6 km from the origin.
      expect(positionOf(mesh, i).distanceTo(new THREE.Vector3(...orbPos(orb)))).toBeLessThan(1e-3)
    })
    // No two orbs overlap, which is what makes "nearest wins" meaningful.
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        const d = positionOf(mesh, i).distanceTo(positionOf(mesh, j))
        expect(d, `orbs ${i} and ${j}`).toBeGreaterThan(2 * ORB_COLLECT_RADIUS)
      }
    }
    art.dispose()
  })

  it('makes a collected orb vanish and leaves the others alone — through a change of art', () => {
    const art = loadOrbs(L)
    art.setArt(null)
    art.collect(3)
    art.update(0)
    // The art can land AFTER a pickup (a slow fetch); the new mesh must not
    // bring a collected orb back.
    art.setArt(null)
    const mesh = instanced(art.object, ORB_MESH_NODE)
    expect(drawnSize(mesh, 3).length()).toBe(0)
    expect(drawnSize(mesh, 4).length()).toBeGreaterThan(1)
    art.dispose()
  })

  it('spins in place — an orb does not orbit the world origin', () => {
    // Rotating the GROUP rather than each instance would make eleven orbs circle
    // the map. Assert the position is unchanged across a spin, which is the
    // observable difference between the two.
    const art = loadOrbs(L)
    art.setArt(null)
    const mesh = instanced(art.object, ORB_MESH_NODE)
    const before = positionOf(mesh, 5).clone()
    art.update(7.5)
    expect(positionOf(mesh, 5).distanceTo(before)).toBeLessThan(1e-9)
    expect(art.object.quaternion.w).toBe(1)
    art.dispose()
  })
})
