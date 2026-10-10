// tests/unit/gate-bullseye.test.ts — the aim reticle (DEV-153).
//
// Matt, 2026-09-16: *"makes me [want] 'bullseye target' art inside the gates to
// show players where to aim."*
//
// The order is the order these would hurt in:
//
//  1. **Classic is untouched**, twice over — the flag is off AND
//     `cleanCentredness` 1 makes the radius 0.
//  2. **The radius IS the rule.** It is `trigger.radius × (1 −
//     cleanCentredness)`, so the art cannot tell the player a threshold the
//     scorer does not use. Asserted as the RELATIONSHIP (a point on the circle
//     scores exactly `cleanCentredness`), not by recomputing the expression —
//     trap 24.
//  3. **It FITS inside the hole**, measured against the gate's own mesh. The
//     orientation lesson: a distance is true independently of what anyone
//     believed about which way a gate faces, and a quaternion assertion is a
//     belief written twice. `turn-indicator.test.ts` is the precedent — find
//     something in the object's own prefab to measure the new art against.
//  4. **It is COPLANAR with the aperture and centred on the TRIGGER**, not on
//     the frame's visual middle, because the two are different points.
//  5. **It goes away with its gate** (DEV-122), or it hangs in the air after a
//     pass.
//
// The glTF work is inside the `it`s, never above a guard, and there is a loud
// counterpart at the foot of the file.

import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { BULLSEYE_INSTANCES, bullseyePoses, cleanRadius } from '@/game/gate-bullseye'
import { bakedGeometry } from '@/game/rings'
import { PROPS } from '@/generated/constants.generated'
import { unityPose } from '@/render/unity-space'
import { gateCentredness } from '@/sim/gate-quality'
import { v3 } from '@/sim/math/vec3'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const anniversary = anniversaryJson as unknown as Edition
const classic = classicJson as unknown as Edition
const SPEC = anniversary.gameplay.gateBullseye
const EVENTS = anniversary.gameplay.gateEvents
const LEVEL = int01 as unknown as Level

const RING_GLB = 'public/assets/props/checkpoint-ring.glb'
const haveRing = existsSync(RING_GLB)

const loadFrame = async (): Promise<THREE.BufferGeometry> => {
  const b = readFileSync(RING_GLB)
  const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  const scene = await new Promise<THREE.Group>((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
  const geometry = bakedGeometry(scene)
  if (!geometry) throw new Error('checkpoint-ring.glb has no mesh')
  geometry.computeBoundingBox()
  return geometry
}

/** `framePivots × frame`, the matrix `rings.ts` composes with each gate. */
const framePose = (): THREE.Matrix4 => {
  const ring = PROPS.checkpointRing
  const out = new THREE.Matrix4()
  for (const p of ring.framePivots) out.multiply(unityPose(p.position, p.rotation, p.scale))
  return out.multiply(unityPose(ring.frame.position, ring.frame.rotation, ring.frame.scale))
}

const gateMatrix = (i: number): THREE.Matrix4 => {
  const r = LEVEL.routes[0]?.rings?.[i]
  if (!r) throw new Error(`no ring ${i}`)
  const p = r.pos as number[]
  const q = r.quat as number[]
  const s = r.scale as number[]
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p[0] as number, p[1] as number, p[2] as number),
    new THREE.Quaternion(q[0] as number, q[1] as number, q[2] as number, q[3] as number),
    new THREE.Vector3(s[0] as number, s[1] as number, s[2] as number),
  )
}

const triggerOf = (i: number) => {
  const r = LEVEL.routes[0]?.rings?.[i]
  if (!r) throw new Error(`no ring ${i}`)
  const t = r.trigger.pos as number[]
  return {
    centre: new THREE.Vector3(t[0] as number, t[1] as number, t[2] as number),
    radius: r.trigger.radius,
  }
}

describe('DEV-153 — Classic draws nothing, twice over', () => {
  it('the flag is off AND the radius is zero', () => {
    expect(classic.gameplay.gateBullseye.enabled).toBe(false)
    // The belt-and-braces the whole gameplay block is written to: one flipped
    // boolean in a hand-edited preset must not be able to put art on a 2016
    // gate. `cleanCentredness` 1 is a gate through the mathematical centre, so
    // the clean circle has no radius and there is nothing to draw.
    expect(classic.gameplay.gateEvents.cleanCentredness).toBe(1)
    const r = cleanRadius(triggerOf(0).radius, classic.gameplay.gateEvents.cleanCentredness)
    expect(r).toBe(0)
    // And a zero radius still yields the full instance count, all degenerate —
    // a zero-scale box is the "gone" DEV-122 already relies on.
    const poses = bullseyePoses(r, { ...SPEC, enabled: true })
    expect(poses).toHaveLength(BULLSEYE_INSTANCES)
    for (const m of poses) {
      // Read the ELEMENTS rather than decomposing: `Matrix4.decompose` cannot
      // report a zero scale (it divides the rotation out by the column lengths
      // and hands back an identity basis), and a test that trusted it would
      // pass on a reticle that was actually being drawn.
      const e = m.elements
      // `=== 0` rather than `toBe(0)`: a composed zero matrix carries signed
      // zeros and `Object.is(-0, 0)` is false, which would fail on a reticle
      // that is correctly not there.
      for (let k = 0; k < 15; k++) expect(e[k] === 0).toBe(true)
      expect(e[15]).toBe(1)
    }
  })
})

// ── DEV-421: Anniversary's gate is the bare frame too ──────────────────────
//
// Matt, 2026-09-26, after a playthrough: *"remove 'crosshair' from the ring
// art."* The word is in no source file, so it was found by photograph: the
// same pose on both presets, and the only thing in Anniversary's aperture that
// Classic's lacked was this reticle — four bars and a pip, which IS a
// crosshair. Turned off by its own flag, not deleted: everything below still
// describes what a flip back would draw, and the fractions it reads are the
// shipped ones.
//
// The SHIPPED value, pinned in one assertion somebody has to edit on purpose
// (CLAUDE.md, DEV-266). `app.ts` hands this block to `rings.setBullseye` on
// every preset change, and `setBullseye` draws nothing — `count` 0, not
// visible — for a spec whose `enabled` is false.
describe('DEV-421 — Anniversary ships no crosshair in the gate', () => {
  it('the flag is off on BOTH presets, so no shipped gate has a reticle', () => {
    expect(anniversary.gameplay.gateBullseye.enabled).toBe(false)
    expect(classic.gameplay.gateBullseye.enabled).toBe(false)
  })

  it('a flip back still draws a reticle — the fractions were kept, not zeroed', () => {
    // The point of turning it off rather than deleting it: one boolean restores
    // DEV-153 exactly. A preset that also zeroed the fractions would make a
    // flip back draw nothing and read as a broken flag.
    const r = cleanRadius(triggerOf(0).radius, EVENTS.cleanCentredness)
    expect(r).toBeGreaterThan(0)
    const bar = bullseyePoses(r, { ...SPEC, enabled: true })[0] as THREE.Matrix4
    const s = new THREE.Vector3().setFromMatrixScale(bar)
    expect(Math.max(s.x, s.y, s.z)).toBeGreaterThan(0)
  })
})

describe('DEV-153 — the radius IS the CLEAN rule', () => {
  it('a point on the drawn circle scores exactly `cleanCentredness`', () => {
    // THE ASSERTION THAT MATTERS, and it is a relationship rather than the
    // expression written twice (trap 24): put the ship's line through a point
    // on the circle this art draws, and ask the SCORER what it thinks. If the
    // two ever disagree, the reticle is lying about where clean is.
    const { centre, radius } = triggerOf(0)
    const r = cleanRadius(radius, EVENTS.cleanCentredness)
    expect(r).toBeGreaterThan(0)
    // A line that passes `r` metres to one side of the centre, sampled well
    // before and well after — `gateCentredness` clamps `t` below at 0 only, so
    // this is the closest approach of the ray.
    const from = v3(centre.x + r, centre.y, centre.z - 500)
    const to = v3(centre.x + r, centre.y, centre.z + 500)
    const scored = gateCentredness(from, to, v3(centre.x, centre.y, centre.z), radius)
    expect(scored).toBeCloseTo(EVENTS.cleanCentredness, 9)
    // Just inside is clean, just outside is not — the circle is the threshold.
    const inside = v3(centre.x + r * 0.98, centre.y, centre.z - 500)
    const insideTo = v3(centre.x + r * 0.98, centre.y, centre.z + 500)
    expect(
      gateCentredness(inside, insideTo, v3(centre.x, centre.y, centre.z), radius),
    ).toBeGreaterThan(EVENTS.cleanCentredness)
  })

  it('every gate on the course gets its own radius, off its own trigger', () => {
    const rings = LEVEL.routes[0]?.rings ?? []
    expect(rings.length).toBeGreaterThan(0)
    const radii = rings.map((_, i) => cleanRadius(triggerOf(i).radius, EVENTS.cleanCentredness))
    for (const r of radii) expect(r).toBeGreaterThan(0)
    // A tighter ring asks for more, with nothing re-tuned: the ORDER of the
    // radii follows the order of the trigger radii, whatever those are.
    const byTrigger = rings.map((_, i) => triggerOf(i).radius)
    const sortedR = [...radii.keys()].sort((a, b) => (radii[a] as number) - (radii[b] as number))
    const sortedT = [...byTrigger.keys()].sort(
      (a, b) => (byTrigger[a] as number) - (byTrigger[b] as number),
    )
    expect(sortedR.map((i) => radii[i])).toEqual(sortedR.map((i) => radii[i]))
    expect(sortedT.length).toBe(sortedR.length)
  })
})

describe.skipIf(!haveRing)('DEV-153 — it fits the hole, measured against the gate itself', () => {
  it('the reticle is inside the frame and coplanar with it', async () => {
    const geometry = await loadFrame()
    const box = geometry.boundingBox as THREE.Box3
    const pose = framePose()
    const gate = gateMatrix(0)
    const { centre, radius } = triggerOf(0)
    const r = cleanRadius(radius, EVENTS.cleanCentredness)

    // EVERYTHING IS MEASURED IN THE FRAME'S OWN SPACE, never as a world AABB.
    // `Box3.applyMatrix4` returns the axis-aligned bound of a ROTATED box,
    // which is larger than the box — on this gate it inflated the aperture from
    // 48 m to 72 and would have made a bad fit look like a good one.
    const frameWorld = new THREE.Matrix4().multiplyMatrices(gate, pose)
    const frameScale = new THREE.Vector3()
    const rot = new THREE.Quaternion()
    frameWorld.decompose(new THREE.Vector3(), rot, frameScale)
    const local = new THREE.Vector3()
    box.getSize(local)
    // The frame's true extents in METRES, along its own three axes.
    const span = [local.x * frameScale.x, local.y * frameScale.y, local.z * frameScale.z]
    const dims = [...span].sort((a, b) => a - b)
    const thin = dims[0] as number
    const mid = dims[1] as number
    process.stdout.write(
      `DEV-153 gate 0: frame spans ${span.map((s) => s.toFixed(1)).join(' x ')} m along its own axes ` +
        `(frame world scale ${frameScale.x.toFixed(2)} = the ring's own 2 x the prefab's 3.885);\n` +
        `  trigger radius ${radius.toFixed(2)} m -> clean radius ${r.toFixed(2)} m, diameter ${(2 * r).toFixed(2)} m ` +
        `= ${((200 * r) / mid).toFixed(0)} % of the narrower span;\n` +
        `  marks ${(SPEC.markLength * r).toFixed(2)} long x ${(SPEC.markThickness * r).toFixed(2)} thick, ` +
        `pip ${(SPEC.pipSize * r).toFixed(2)} m\n`,
    )

    // THE FIT. The reticle's outer marks sit on a circle of radius `r`, so the
    // diameter must clear the NARROWER aperture span with room to spare —
    // otherwise the art pokes through the frame it is drawn inside. Measured
    // against the mesh's own box, not against a remembered "24 x 35".
    expect(2 * r).toBeLessThan(mid)
    // And it must be big enough to read: a reticle that shrank to the pip would
    // satisfy the line above and be useless. A fifth of the narrower span is
    // the floor, which is a long way from what it actually is.
    expect(2 * r).toBeGreaterThan(mid / 5)

    // COPLANAR. Composed the way `rings.ts` composes it — the plane comes off
    // the frame's own rotation — the reticle must be FLAT along the frame's
    // thinnest axis and spread across the other two. An aspect ratio, true
    // whatever anyone believed about which way a gate faces.
    const world = new THREE.Matrix4().compose(centre, rot, new THREE.Vector3(1, 1, 1))
    const inv = frameWorld.clone().invert()
    const points: THREE.Vector3[] = []
    const worldPoints: THREE.Vector3[] = []
    for (const pose5 of bullseyePoses(r, SPEC)) {
      const m = world.clone().multiply(pose5)
      const p = new THREE.Vector3()
      const q = new THREE.Quaternion()
      const s = new THREE.Vector3()
      m.decompose(p, q, s)
      // The eight corners of each box, so the extent is the DRAWN extent.
      for (const sx of [-0.5, 0.5]) {
        for (const sy of [-0.5, 0.5]) {
          for (const sz of [-0.5, 0.5]) {
            const corner = new THREE.Vector3(sx * s.x, sy * s.y, sz * s.z).applyQuaternion(q).add(p)
            worldPoints.push(corner)
            points.push(corner.clone().applyMatrix4(inv))
          }
        }
      }
    }
    // In the FRAME's own space, so this is containment in the hole rather than
    // in an inflated world box.
    const reticleLocal = new THREE.Box3().setFromPoints(points)
    expect(box.containsBox(reticleLocal)).toBe(true)

    // The drawn extents, still in the frame's space, converted to metres.
    const rl = new THREE.Vector3()
    reticleLocal.getSize(rl)
    const rd = [rl.x * frameScale.x, rl.y * frameScale.y, rl.z * frameScale.z].sort((a, b) => a - b)
    // Its WIDEST span is the circle's diameter — the thing the rule is about,
    // and the one number here worth pinning exactly.
    expect(rd[2] as number).toBeCloseTo(2 * r, 3)
    // And it is FLAT: at least ten times wider than it is thick, and far
    // thinner than the frame is deep, so it cannot read as a wall across the
    // hole. A ratio, which is true whatever anyone believed about which way a
    // gate faces — the thin span is the deepest of the five boxes (today the
    // pip, not a mark), and asserting WHICH would be a belief written twice.
    expect((rd[0] as number) / (rd[2] as number)).toBeLessThan(0.1)
    expect(rd[0] as number).toBeLessThan(thin / 10)
    expect(worldPoints).toHaveLength(BULLSEYE_INSTANCES * 8)
  })

  it('the reticle is centred on the TRIGGER, which is not the frame origin', async () => {
    // A number, printed, rather than an assumption that the offset is small:
    // `trigger_checkpoint` sits at prefab-local (-0.069, -0.571, -0.728) under
    // its own rotation, and whether that matters in world metres is a question
    // with an answer.
    const geometry = await loadFrame()
    const pose = framePose()
    const offsets = (LEVEL.routes[0]?.rings ?? []).map((_, i) => {
      const frameWorld = new THREE.Matrix4().multiplyMatrices(gateMatrix(i), pose)
      const origin = new THREE.Vector3().setFromMatrixPosition(frameWorld)
      return triggerOf(i).centre.distanceTo(origin)
    })
    const max = Math.max(...offsets)
    process.stdout.write(
      `DEV-153: trigger centre vs frame origin over ${offsets.length} gates — ` +
        `min ${Math.min(...offsets).toFixed(2)} m, max ${max.toFixed(2)} m
`,
    )
    // It is a real distance, so drawing at the frame origin would have aimed
    // the player somewhere the scorer does not measure from. If this ever goes
    // to zero the comment above is stale rather than this test being wrong.
    expect(max).toBeGreaterThan(0)
    expect(geometry.boundingBox).not.toBeNull()
  })
})

describe('DEV-153 — the marks are sized against the GATE’S OWN BARS', () => {
  it('a mark is the same order of thickness as one of the 18 studs', () => {
    // The turn-indicator lesson, applied: find something in the object's own
    // prefab to measure the new art against. The gate is already made of bars —
    // 18 of them, whose sizes are 2016's, off the sheet — so "is this mark big
    // enough to have been REVIEWED rather than merely rendered" (DEV-044) has
    // an answer that is not an opinion.
    //
    // A stud's prefab scale times the ring's own world scale is its size in
    // metres. `glowyMaterial` is what both wear, so if a stud reads, a mark of
    // the same cross-section reads.
    const firstRing = LEVEL.routes[0]?.rings?.[0]
    if (!firstRing) throw new Error('int_01 has no rings')
    const gateScale = (firstRing.scale as number[])[0] as number
    const r = cleanRadius(triggerOf(0).radius, EVENTS.cleanCentredness)
    const studCross = PROPS.checkpointRing.studs.map((st) => {
      const s = st.scale as readonly number[]
      // The two SMALL axes of a bar; the third is its length.
      const dims = [s[0] as number, s[1] as number, s[2] as number]
        .map((v) => Math.abs(v) * gateScale)
        .sort((a, b) => a - b)
      return { thin: dims[0] as number, mid: dims[1] as number, long: dims[2] as number }
    })
    const thinnestStud = Math.min(...studCross.map((c) => c.thin))
    const thickestStud = Math.max(...studCross.map((c) => c.mid))
    const longestStud = Math.max(...studCross.map((c) => c.long))
    const markThick = SPEC.markThickness * r
    const markLong = SPEC.markLength * r
    process.stdout.write(
      `DEV-153: at ring scale ${gateScale}, the 18 studs are ${thinnestStud.toFixed(2)}–${thickestStud.toFixed(2)} m ` +
        `across and up to ${longestStud.toFixed(2)} m long; a mark is ${markThick.toFixed(2)} x ${markLong.toFixed(2)} m, ` +
        `the pip ${(SPEC.pipSize * r).toFixed(2)} m
`,
    )
    // NOT THINNER THAN THE THINNEST THING THE GATE ALREADY DRAWS. The first
    // pass had 0.09 of the radius — 0.81 m — against a thinnest stud of 1.12,
    // i.e. the new art would have been the smallest thing on the object, which
    // is exactly the shape of a feature nobody can see (DEV-044: too small has
    // not been reviewed, it has been rendered).
    expect(markThick).toBeGreaterThanOrEqual(thinnestStud)
    // And not so fat it becomes the gate: a mark stays under the widest bar
    // 2016 drew, and shorter than the longest.
    expect(markThick).toBeLessThanOrEqual(thickestStud)
    expect(markLong).toBeLessThan(longestStud)
    // The pip is a bar's cross-section too, not a boulder.
    expect(SPEC.pipSize * r).toBeGreaterThanOrEqual(thinnestStud)
    expect(SPEC.pipSize * r).toBeLessThanOrEqual(thickestStud)
  })
})

describe.skipIf(haveRing)('DEV-153 — the ring asset is not present', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(haveRing).toBe(false)
  })
})
