// tests/unit/ship-shadow.test.ts — the ship's own shadow, and the flag that
// had never reached a mesh. DEV-305 / DEV-306, wishlist #29 and #30.
//
// ── What was actually wrong, which is not what the wishlist row says ─────
//
// #29 is *"player ship casts shadows — use the 3rd-person model as the
// caster"*, and `render/shadows.ts`'s header agreed with the half of it that
// was visible: `flight.ts` hides the hull in first person, and an invisible
// object casts nothing. **The other half is that the hull cast nothing
// anywhere.** `boot/app.ts` handed the shadow map
// `getObjectByName('ship_third_person')`, which is the glTF SCENE ROOT — a
// `Group` — and three tests `castShadow` on the object it is about to DRAW.
// `hoverjet-exterior.glb` is one node under that root. So the flag was written
// on a node three never draws, and the one node it draws kept three's default.
//
// Nothing caught it because everything that looked was looking at the right
// thing: `shadowFlagsFor('ship-exterior') === {cast: true}` is the TABLE and
// the table was never wrong. DEV-069's lesson in a new place — a value nothing
// downstream consults is documentation, not a guard.
//
// ── Every claim about three is read out of three's build ─────────────────
//
// Four of them, and all four are premises rather than outcomes (CLAUDE.md:
// *"it cannot reach this, here is the line"* stays true until somebody edits
// that line; *"I ran it and it was green"* does not):
//
//  1. `castShadow` is tested inside the `isMesh` branch — so a Group's flag
//     reaches nothing, which is the whole bug.
//  2. `object.visible === false` returns early — the first refusal.
//  3. `material.visible` is checked too — the THIRD refusal, and the one
//     neither the wishlist nor `shadows.ts`'s header had found. With it,
//     `colorWrite`/`depthWrite` is the only route left.
//  4. `getDepthMaterial` copies neither `colorWrite` nor `depthWrite` — which
//     is what makes route 4 work at all.
//
// A `three` bump that changed any of these turns this red, which is the
// measured result a dependency upgrade is supposed to land with.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { applyVrOverrides, editionFeatures } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import {
  applyShadowFlags,
  createSunShadows,
  RECEIVERS_2016,
  type ShadowFlags,
  type ShadowRenderer,
  type ShadowRole,
  setColourlessDraw,
  shadowFlagsFor,
  shadowMeshesOf,
  shadowReceiversFor,
} from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

const ROOT = process.cwd()
const THREE_BUILD = path.join(ROOT, 'node_modules/three/build/three.module.js')

/**
 * The body of a nested function in three's bundle, by brace matching.
 *
 * `program-key.test.ts` matches on the closing indentation, which works for a
 * top-level function and not for one inside `WebGLShadowMap`. Counting braces
 * is indifferent to how three is formatted, which is the property worth having
 * in a file whose whole job is to keep reading three correctly.
 */
const functionBody = (build: string, signature: string): string => {
  const start = build.indexOf(signature)
  expect(start, `three no longer has \`${signature}\` — read the new code`).toBeGreaterThan(0)
  let depth = 0
  for (let i = build.indexOf('{', start); i < build.length; i++) {
    if (build[i] === '{') depth++
    else if (build[i] === '}' && --depth === 0) return build.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

const shadowMapSource = (): { renderObject: string; getDepthMaterial: string } => {
  const build = fs.readFileSync(THREE_BUILD, 'utf8')
  return {
    renderObject: functionBody(
      build,
      'function renderObject( object, camera, shadowCamera, light, type )',
    ),
    getDepthMaterial: functionBody(
      build,
      'function getDepthMaterial( object, material, light, type )',
    ),
  }
}

describe("§1 three's shadow pass, read rather than remembered", () => {
  it('tests castShadow INSIDE the isMesh branch, so a Group flag reaches nothing', () => {
    // The bug, stated as three's own rule. `renderObject` recurses through the
    // whole tree, but the `castShadow` test sits under a guard that only a
    // Mesh, Line or Points can pass — so a flag on a glTF scene root is read
    // by nobody and the mesh under it keeps three's default of false.
    const { renderObject } = shadowMapSource()
    const guard = renderObject.indexOf('object.isMesh')
    const test = renderObject.indexOf('object.castShadow')
    expect(guard, 'three no longer guards on isMesh').toBeGreaterThan(0)
    expect(test, 'three no longer tests castShadow').toBeGreaterThan(0)
    expect(test, 'castShadow is no longer inside the isMesh guard').toBeGreaterThan(guard)
  })

  it('refuses a hidden object THREE ways, which is why colorWrite is the fix', () => {
    // `shadows.ts` names two of these and DEV-305 found the third. Each is a
    // different line and each is a flat refusal, so there is no cheap way to
    // keep a caster out of the frame and in the depth pass.
    const { renderObject } = shadowMapSource()
    expect(renderObject, 'object.visible').toContain('if ( object.visible === false ) return;')
    expect(renderObject, 'the layer test is against the VIEW camera').toContain(
      'object.layers.test( camera.layers )',
    )
    expect(renderObject, 'material.visible').toContain('material.visible')
  })

  it('and builds its own depth material, copying neither colorWrite nor depthWrite', () => {
    // THE premise `setColourlessDraw` rests on. If a three bump started
    // copying either, the hull would stop casting the moment it was made
    // colourless and the feature would be dead in a build whose other tests
    // were green — the same failure DEV-295's patch shipped with.
    const { getDepthMaterial } = shadowMapSource()
    expect(getDepthMaterial, 'three copies colorWrite now').not.toContain('result.colorWrite')
    expect(getDepthMaterial, 'three copies depthWrite now').not.toContain('result.depthWrite')
    // And it really is copying SOMETHING, so the two assertions above are not
    // vacuous against a function that has been renamed out from under them.
    expect(getDepthMaterial).toContain('result.side =')
    expect(getDepthMaterial).toContain('result.visible = material.visible;')
  })
})

describe('§2 shadowMeshesOf: the flag lands on the Mesh (DEV-305)', () => {
  /** `hoverjet-exterior.glb` as GLTFLoader builds it: a Group, one Mesh. */
  const gltfLike = (): THREE.Object3D => {
    const root = new THREE.Group()
    root.name = 'ship_third_person'
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    mesh.name = 'ship_ext_orange'
    root.add(mesh)
    return root
  }

  it('returns the Mesh and not the root', () => {
    const root = gltfLike()
    const meshes = shadowMeshesOf(root)
    expect(meshes).toHaveLength(1)
    expect(meshes[0]).toBe(root.children[0])
    expect(meshes).not.toContain(root)
  })

  it('walks nested groups and returns an empty list for nothing', () => {
    const root = new THREE.Group()
    const inner = new THREE.Group()
    const a = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    const b = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    inner.add(b)
    root.add(a, inner)
    expect(shadowMeshesOf(root)).toHaveLength(2)
    expect(shadowMeshesOf(new THREE.Group())).toEqual([])
    expect(shadowMeshesOf(null)).toEqual([])
    // The JumpSeat's answer: `getObjectByName` returns undefined and that must
    // be an empty list rather than a throw, because it is the honest answer
    // and six of thirteen missions take this path.
    expect(shadowMeshesOf(undefined)).toEqual([])
  })

  it('and the ROOT alone is what the bug was — nothing is written to the mesh', () => {
    // The defect, demonstrated rather than described. `applyShadowFlags` does
    // exactly what it is told, and what it was told was a Group.
    const root = gltfLike()
    const mesh = root.children[0] as THREE.Mesh
    applyShadowFlags([{ role: 'ship-exterior', target: root }], true)
    expect(root.castShadow, 'the Group got the flag').toBe(true)
    expect(mesh.castShadow, 'and three reads it off the MESH, which still has false').toBe(false)
    // Through `shadowMeshesOf` it lands where three looks.
    const fresh = gltfLike()
    const freshMesh = fresh.children[0] as THREE.Mesh
    applyShadowFlags(
      shadowMeshesOf(fresh).map((target) => ({ role: 'ship-exterior' as ShadowRole, target })),
      true,
    )
    expect(freshMesh.castShadow).toBe(true)
    expect(fresh.castShadow, 'and the root is left alone').toBe(false)
  })
})

describe('§3 setColourlessDraw: drawn, and contributing nothing (DEV-305)', () => {
  const meshWith = (): { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial } => {
    const material = new THREE.MeshStandardMaterial()
    return { mesh: new THREE.Mesh(new THREE.BufferGeometry(), material), material }
  }

  it('clears BOTH colorWrite and depthWrite, and puts both back', () => {
    // `depthWrite` is not tidiness. With colour masked and depth still written
    // the hull punches a silhouette-shaped hole a metre in front of the eye
    // and the entire world behind it fails the depth test — the obvious half
    // of this fix renders the game as a ship-shaped window onto the clear
    // colour.
    const { mesh, material } = meshWith()
    setColourlessDraw(mesh, true)
    expect(material.colorWrite).toBe(false)
    expect(material.depthWrite).toBe(false)
    setColourlessDraw(mesh, false)
    expect(material.colorWrite).toBe(true)
    expect(material.depthWrite).toBe(true)
  })

  it('counts what MOVED, so "nothing was written" is a claim a test can make', () => {
    const { mesh } = meshWith()
    expect(setColourlessDraw(mesh, true)).toBe(2)
    expect(setColourlessDraw(mesh, true), 'a second call must move nothing').toBe(0)
    expect(setColourlessDraw(mesh, false)).toBe(2)
    expect(setColourlessDraw(null, true)).toBe(0)
  })

  it('reaches every material in a subtree, arrays included', () => {
    const root = new THREE.Group()
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    const multi = new THREE.Mesh(new THREE.BufferGeometry(), [a, b])
    const inner = new THREE.Group()
    inner.add(multi)
    root.add(inner)
    expect(setColourlessDraw(root, true)).toBe(4)
    expect(a.colorWrite).toBe(false)
    expect(b.depthWrite).toBe(false)
  })
})

describe('§4 the cockpit RECEIVES, and can never be made to cast (DEV-306)', () => {
  it('is 2016 by default and a preset may move only the receive half', () => {
    // `RECEIVERS_2016` is the default for `ALL_CASTERS`'s reason: a caller
    // that has not heard of DEV-306 gets the FAITHFUL answer.
    expect(shadowFlagsFor('ship-cockpit', true)).toEqual({ cast: false, receive: false })
    expect(shadowFlagsFor('ship-cockpit', true, 0, undefined, RECEIVERS_2016)).toEqual({
      cast: false,
      receive: false,
    })
    expect(shadowFlagsFor('ship-cockpit', true, 0, undefined, { cockpit: true })).toEqual({
      cast: false,
      receive: true,
    })
  })

  it('and CASTING stays off however the receivers move', () => {
    // The row hard-codes it, and that is the point of the row: the header's
    // argument against the cockpit — the canopy's own shadow across the
    // dashboard at a 0.88 m texel and an 0.08 m near plane — is about casting
    // and is not a preset's to argue with.
    for (const cockpit of [true, false]) {
      expect(shadowFlagsFor('ship-cockpit', true, 0, undefined, { cockpit }).cast).toBe(false)
    }
  })

  it('moves the cockpit row and nothing else in the table', () => {
    // The same shape as DEV-224's assertion for the caster set: an EQUALITY
    // between the two answers rather than a transcribed pair, so it stays true
    // when a row that is not the cockpit's moves.
    const ROLES: readonly ShadowRole[] = [
      'terrain-chunk',
      'ocean-chunk',
      'prop-scatter',
      'prop-landmark',
      'ship-exterior',
      'cloud',
      'ring',
      'effect',
    ]
    for (const role of ROLES) {
      for (const lod of [-1, 0, 1, 2]) {
        expect(
          shadowFlagsFor(role, true, lod, undefined, { cockpit: true }),
          `${role} @ LOD ${lod}`,
        ).toEqual(shadowFlagsFor(role, true, lod, undefined, RECEIVERS_2016))
      }
    }
  })

  it('composes the quality tier, so low cannot report a receiver of a map it has not got', () => {
    expect(shadowReceiversFor(anniversary, DEFAULT_SETTINGS).cockpit).toBe(true)
    expect(shadowReceiversFor(anniversary, { ...DEFAULT_SETTINGS, quality: 'low' }).cockpit).toBe(
      false,
    )
    expect(shadowReceiversFor(classic, DEFAULT_SETTINGS).cockpit).toBe(false)
  })
})

describe('§5 the live system, through the seam `boot/app.ts` uses', () => {
  const stubRenderer = (): ShadowRenderer => ({
    shadowMap: { enabled: false, type: THREE.BasicShadowMap },
  })
  const stubSun = (): THREE.DirectionalLight => {
    const sun = new THREE.DirectionalLight()
    sun.position.set(-9622.53, 697.57, -2630.62)
    sun.updateMatrixWorld(true)
    sun.target.updateMatrixWorld(true)
    return sun
  }
  const flags = (): ShadowFlags => ({ castShadow: false, receiveShadow: false })

  it('flags the hull as a caster and the cockpit as a receiver on Anniversary', () => {
    const hull = flags()
    const cockpit = flags()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(stubRenderer(), stubSun(), state)
    shadows.attach({ shipExterior: [hull], shipCockpit: [cockpit] })
    expect(hull).toEqual({ castShadow: true, receiveShadow: false })
    expect(cockpit).toEqual({ castShadow: false, receiveShadow: true })
    shadows.dispose()
  })

  it('and Classic writes NOTHING to either — the count, not the values', () => {
    // A stronger claim than "the flags are false": it says nothing was
    // written at all, so a future Classic cannot arrive at false by setting
    // true and clearing it.
    const hull = flags()
    const cockpit = flags()
    expect(
      applyShadowFlags(
        [
          { role: 'ship-exterior', target: hull },
          { role: 'ship-cockpit', target: cockpit },
        ],
        false,
        undefined,
        shadowReceiversFor(classic, DEFAULT_SETTINGS),
      ),
    ).toBe(0)
  })

  it('takes the cockpit back out at quality low, on the live notify', () => {
    const cockpit = flags()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createSunShadows(stubRenderer(), stubSun(), state)
    shadows.attach({ shipCockpit: [cockpit] })
    expect(cockpit.receiveShadow).toBe(true)
    state.setSettings({ ...DEFAULT_SETTINGS, quality: 'low' })
    expect(cockpit.receiveShadow).toBe(false)
    shadows.dispose()
  })
})

describe('§6 the shipped presets, and the one place the hull goes back in', () => {
  it('Anniversary turns both on and Classic turns neither on', () => {
    expect(anniversary.render.shipShadow.enabled).toBe(true)
    expect(anniversary.render.cockpitShadow.enabled).toBe(true)
    expect(classic.render.shipShadow.enabled).toBe(false)
    expect(classic.render.cockpitShadow.enabled).toBe(false)
  })

  it('both are `?feature=` switchable, which is how the pair gets photographed', () => {
    // They INTERACT: the hull surrounds the cockpit, so a hull that casts and
    // a cockpit that receives put the airframe's own shadow across the
    // dashboard. Judging either alone is judging the wrong picture, and a
    // bisect needs two switches rather than one.
    const registry = new Map(editionFeatures(anniversary))
    expect(registry.has('render.shipShadow')).toBe(true)
    expect(registry.has('render.cockpitShadow')).toBe(true)
  })

  it('and neither is in `vr.disable`, which is a claim and not an omission', () => {
    // DEV-305 costs one draw call and the hull's vertex work; DEV-306 costs a
    // per-fragment shadow sample on the cockpit shell. Both are small beside
    // the 2.70 ms `props.scatterShadows` costs, which IS in the list. If a
    // worn capture disagrees, this is the line to change and this assertion is
    // what makes that a deliberate edit rather than a drift.
    const vr = applyVrOverrides(anniversary)
    expect(vr.render.shipShadow.enabled).toBe(true)
    expect(vr.render.cockpitShadow.enabled).toBe(true)
  })

  it('`flight.ts` keeps the hull in the scene when, and only when, it must cast', () => {
    // A source read, the way `cockpit-interior.test.ts` reads `setView`: the
    // predicate is two lines in a closure over a Flight that cannot be built
    // without a GLB over the network. The claim is the INVARIANT and not the
    // formatting — the hull is visible in third person OR while it is being
    // drawn for the shadow, and `setColourlessDraw` is driven by the same
    // expression rather than by a second one that could drift out of step.
    const source = fs.readFileSync(path.join(ROOT, 'src/game/flight.ts'), 'utf8')
    expect(source).toContain("const drawnForShadow = shipView === 'first' && shipShadow")
    expect(source).toContain("exterior.object.visible = shipView === 'third' || drawnForShadow")
    expect(source).toContain('setColourlessDraw(exterior.object, drawnForShadow)')
    // And `setView` must go through it rather than writing `visible` itself,
    // which is the line that was there before and the one a revert would
    // restore.
    expect(source, 'setView writes the hull visibility directly again').not.toContain(
      "exterior.object.visible = view === 'third'",
    )
  })
})
