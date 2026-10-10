// tests/unit/cockpit-interior.test.ts — the material bug, and Classic.
//
// DEV-088. Two things are under test and they are different kinds of thing.
//
// **The bug.** `hoverjet-cockpit.glb` and `hoverjet-exterior.glb` declare a
// material called `lambert1` with `baseColorFactor = [0.5, 0.5, 0.5, 1]`. That
// is MAYA's `lambert1` — the default shader an FBX is born with — carried
// through by the Blender exporter. The material the game renders with is
// Unity's `lowPolyArt/Materials/lambert1.mat`, whose `_Color` is
// (0.82233995, 0.83045423, 0.8602941). The port was rendering the whole ship
// 1.28-1.42x too dark. DEV-043 found and fixed exactly this on the title logo
// and wrote the rule down — *the glTF does not carry the material* — and the
// ship was never done.
//
// The assertion is the ROUND TRIP back to the serialised sRGB triple, not a
// comparison against a linear number this repo computed. That is trap 24: a
// test that re-derives its expectation the way the code does has not tested the
// code. The oracle is the `.mat` file.
//
// **Classic.** Every Anniversary feature owes Classic a test that says it
// changes nothing, and this one owes a stronger one than most because it is the
// only Phase 1 feature that writes to a MATERIAL and the only one that adds
// LIGHTS. So: no lights, no meshes, and the emissive put back to what the
// loader made it — including after a flip to Anniversary and back, which is the
// path nobody runs and the one that leaves state behind.

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { EditionCockpit } from '@/content/edition-schema'
import { BOOST_GLOW, createCockpitInterior } from '@/render/cockpit-interior'
import { applyLambert1, LAMBERT1_COLOR_SRGB } from '@/render/lambert1'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const CLASSIC = classicJson.cockpit as unknown as EditionCockpit
const ANNIVERSARY = anniversaryJson.cockpit as unknown as EditionCockpit

/**
 * Anniversary's cockpit with the lamps FORCED ON. DEV-263.
 *
 * `anniversary.json` ships `cockpit.lighting.enabled: false` since 2026-09-21
 * — Matt: *"we don't need the cockpit point lights."* The tests below are
 * about the WIRING: that two lamps get built, that every number comes off the
 * file, that they leave the scene with the cabin. Deleting them because the
 * shipped flag moved would delete the GUARD rather than the feature — the code
 * is still there, still reachable by one boolean, and a regression in it would
 * be invisible until somebody turned it back on.
 *
 * So the wiring is asserted against the file's own numbers with the flag
 * forced, and the shipped-off state is asserted separately in
 * `edition-content.test.ts` (*"the cockpit point lights are off in BOTH
 * presets"*). Two claims, two tests, neither standing in for the other.
 *
 * The e2e half of this same problem is `view-toggle-compile.spec.ts`, which
 * went red on its own premise line and is re-pointed with `?feature=`.
 */
const ANNIVERSARY_LIT = {
  ...ANNIVERSARY,
  lighting: { ...ANNIVERSARY.lighting, enabled: true },
} as EditionCockpit

/**
 * What the GLB actually arrives as: one mesh, one `MeshStandardMaterial` with
 * Maya's grey, vertex colours on, double sided. Built here rather than loaded
 * because `public/assets/` is gitignored and a test that reads it is a test
 * that is red in CI and only in CI (the `describe.skipIf` trap).
 */
const asLoaded = (): { root: THREE.Object3D; material: THREE.MeshStandardMaterial } => {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.5, 0.5, 0.5),
    metalness: 0,
    roughness: 0.5527864098548889,
    vertexColors: true,
    side: THREE.DoubleSide,
  })
  material.name = 'lambert1'
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  mesh.name = 'polySurface25'
  root.add(mesh)
  return { root, material }
}

describe('the ship wears Unity lambert1, not Maya lambert1 — DEV-088', () => {
  it('round-trips to the `_Color` serialised in lowPolyArt/Materials/lambert1.mat', () => {
    const { root, material } = asLoaded()
    applyLambert1(root)
    const srgb = material.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace)
    expect(srgb.r).toBeCloseTo(0.82233995, 5)
    expect(srgb.g).toBeCloseTo(0.83045423, 5)
    expect(srgb.b).toBeCloseTo(0.8602941, 5)
  })

  it('is no longer Maya grey, and is BRIGHTER and COOLER than it was', () => {
    // The guard on the guard: what needs asserting is that the fix CHANGED
    // something, in the direction the diagnosis says. Maya's grey is neutral;
    // Unity's `_Color` is a near-white with blue above red. If a future
    // converter starts carrying the real material, both of these still hold.
    const { root, material } = asLoaded()
    applyLambert1(root)
    expect(material.color.r).toBeGreaterThan(0.5)
    expect(material.color.b).toBeGreaterThan(material.color.r)
    // ...and by roughly the amount the row claims: 1.28x on red, 1.42x on blue.
    expect(material.color.r / 0.5).toBeCloseTo(1.285, 2)
    expect(material.color.b / 0.5).toBeCloseTo(1.422, 2)
  })

  it('leaves everything else on the material alone', () => {
    const { root, material } = asLoaded()
    applyLambert1(root)
    expect(material.vertexColors).toBe(true)
    expect(material.side).toBe(THREE.DoubleSide)
    expect(material.roughness).toBeCloseTo(0.5527864098548889, 9)
    expect(material.emissive.getHex()).toBe(0x000000)
  })

  it('is idempotent, so a second call cannot compound it', () => {
    const { root, material } = asLoaded()
    applyLambert1(root)
    const once = material.color.clone()
    applyLambert1(root)
    expect(material.color.r).toBeCloseTo(once.r, 12)
  })

  it('names the sRGB triple in its own units, so it can be diffed against the file', () => {
    expect(LAMBERT1_COLOR_SRGB).toEqual([0.82233995, 0.83045423, 0.8602941])
  })
})

describe('Classic adds nothing to the cockpit', () => {
  const classic = CLASSIC
  // DEV-263: the LIT fixture, because the two tests below that use it are about
  // cleaning up what Anniversary ADDS — an emissive, two lamps, the body mesh.
  // Against the shipped preset Anniversary now adds no lamps, so "it was put
  // back" would pass by there having been nothing to put back.
  const anniversary = ANNIVERSARY_LIT

  it('adds no lights and no objects', () => {
    const { root } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(classic)
    let lights = 0
    let objects = 0
    interior.object.traverse((n) => {
      if (n === interior.object) return
      objects++
      if ((n as THREE.Light).isLight) lights++
    })
    expect(lights).toBe(0)
    expect(objects).toBe(0)
  })

  it('does not touch the ship material', () => {
    const { root, material } = asLoaded()
    applyLambert1(root)
    const colour = material.color.clone()
    const interior = createCockpitInterior(root)
    interior.set(classic)
    expect(material.emissive.getHex()).toBe(0x000000)
    expect(material.color.getHex()).toBe(colour.getHex())
  })

  it('puts the material back after a flip to Anniversary and home again', () => {
    // The path nobody runs. A feature that only cleans up on `dispose` leaves
    // an Anniversary emissive on a Classic ship for the rest of the session,
    // and the pause menu's EDITION page makes that one press away.
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(anniversary)
    expect(material.emissive.getHex()).not.toBe(0x000000)
    expect(interior.object.getObjectByName('cockpit_fill')).toBeDefined()
    expect(interior.object.getObjectByName('cockpit_body')).toBeDefined()

    interior.set(classic)
    expect(material.emissive.getHex()).toBe(0x000000)
    expect(interior.object.getObjectByName('cockpit_fill')).toBeUndefined()
    expect(interior.object.getObjectByName('cockpit_dash')).toBeUndefined()
    expect(interior.object.getObjectByName('cockpit_body')).toBeUndefined()
  })

  it('restores whatever the loader made, not a hard-coded black', () => {
    // Black today. "The emissive is black" is the kind of thing that is true
    // until somebody adds a glowing decal to the console, and a feature that
    // assumed it would silently delete that.
    const { root, material } = asLoaded()
    material.emissive.setRGB(0.2, 0.1, 0.05, THREE.LinearSRGBColorSpace)
    const before = material.emissive.clone()
    const interior = createCockpitInterior(root)
    interior.set(anniversary)
    interior.set(classic)
    expect(material.emissive.r).toBeCloseTo(before.r, 6)
    expect(material.emissive.g).toBeCloseTo(before.g, 6)
  })

  it('disposing puts it back too', () => {
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(anniversary)
    interior.dispose()
    expect(material.emissive.getHex()).toBe(0x000000)
    expect(interior.object.children.length).toBe(0)
  })
})

describe('Anniversary lights the cabin from the preset and nowhere else', () => {
  // DEV-263: the lamps no longer SHIP, but the wiring they exercise is still
  // here and still one boolean away. See ANNIVERSARY_LIT.
  const anniversary = ANNIVERSARY_LIT

  it('builds exactly two point lights, and reads every number off the file', () => {
    const { root } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(anniversary)
    const lights: THREE.PointLight[] = []
    interior.object.traverse((n) => {
      if ((n as THREE.PointLight).isPointLight) lights.push(n as THREE.PointLight)
    })
    expect(lights.length).toBe(2)
    const fill = interior.object.getObjectByName('cockpit_fill') as THREE.PointLight
    const spec = anniversary.lighting.fill
    expect(fill.intensity).toBe(spec.intensity)
    expect(fill.distance).toBe(spec.distance)
    expect(fill.decay).toBe(spec.decay)
    expect(fill.position.toArray()).toEqual(spec.offset)
    // LINEAR rgb, straight through — a light's colour is radiance. If this ever
    // goes through an sRGB decode the cabin gets darker and more saturated than
    // the file reads, which is a bug nobody can find from the JSON.
    const linear = fill.color.getRGB(new THREE.Color(), THREE.LinearSRGBColorSpace)
    expect(linear.r).toBeCloseTo(spec.color[0] as number, 5)
    expect(linear.b).toBeCloseTo(spec.color[2] as number, 5)
  })

  it('takes its lamps OUT of the scene when the cockpit is not worn', () => {
    // The hazard: in the hangar the ship is PARKED IN FRONT OF YOU and
    // `setView('third')` swaps the cockpit for the exterior hull. Two cabin
    // lamps left burning inside a parked ship would light the hangar room, and
    // nobody would attribute that to this feature.
    //
    // `flight.ts` answers it by hiding `interior.object`, and that works
    // because three's `projectObject` opens with `if ( object.visible === false )
    // return` (`three.module.js:17827`) — BEFORE the `isLight` branch that
    // gathers the light — so an invisible ancestor removes the whole subtree,
    // lamps included. `traverseVisible` applies the same predicate, so this
    // asserts the CONTRACT the feature leans on rather than restating the line
    // of code that leans on it.
    const { root } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(anniversary)
    const gathered = (): number => {
      let n = 0
      interior.object.traverseVisible((o) => {
        if ((o as THREE.Light).isLight) n++
      })
      return n
    }
    expect(gathered()).toBe(2)
    interior.object.visible = false
    expect(gathered()).toBe(0)
  })

  it('is wired to that switch in `flight.ts`, on the same line as the mesh swap', () => {
    // The source half, in the shape `cockpit-shake.test.ts` established: the
    // contract above is only worth anything if `setView` actually flips it, and
    // the module that does needs a loaded GLB to construct, which no unit test
    // has. So read the shipped source and assert the wiring is there.
    const source = readFileSync('src/game/flight.ts', 'utf8')
    const setView = source.slice(source.indexOf('setView(view)'))
    const body = setView.slice(0, setView.indexOf('dispose()'))
    expect(body).toMatch(/interior\.setShown\(\s*view === 'first'\s*\)/)
    // ...and NOT the flag it used to write. DEV-186: hiding the whole node
    // takes the two lamps out of the scene's light list, `numPointLights` goes
    // 2 -> 0, and that recompiles every lit material in the frame — measured
    // at fifteen programs on one press of V
    // (`tests/e2e/view-toggle-compile.spec.ts`).
    expect(body).not.toContain('interior.object.visible')
  })

  it('keeps both lamps clear of the cockpit skin, which is why they can be 1/r^2', () => {
    // The cabin is 0.37 m from the eye to the canopy. A `decay: 2` lamp 84 mm
    // off a strut blows it to white — measured, on the 534 canopy-frame
    // vertices, at the first placement this feature tried. These offsets were
    // CHOSEN for clearance (0.176 m and 0.244 m to the nearest cockpit vertex),
    // and the property that matters is that neither sits at the eye (a headlamp
    // flattens the frame it is meant to model) nor further than the cabin.
    for (const spec of [anniversary.lighting.fill, anniversary.lighting.dash]) {
      const at = new THREE.Vector3(spec.offset[0], spec.offset[1], spec.offset[2])
      expect(at.length(), 'not a headlamp at the eye').toBeGreaterThan(0.15)
      expect(at.length(), 'inside the cabin').toBeLessThan(0.9)
      expect(spec.decay).toBe(2)
      expect(spec.distance).toBeGreaterThan(at.length())
    }
  })

  it('keeps the emissive floor far below what the lamps do', () => {
    // It is UNIFORM over the mesh, so it flattens. Past a certain size it
    // undoes the two lights it is meant to support, and the symptom is "the
    // cockpit looks like a cardboard cutout" rather than anything nameable.
    const e = anniversary.lighting.emissive
    expect(e.intensity).toBeGreaterThan(0)
    expect(e.intensity).toBeLessThan(0.02)
  })
})

describe('the boost glow (DEV-640)', () => {
  it('warms the shell by the glow, and a glow of 0 is EXACTLY what the preset wrote', () => {
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(ANNIVERSARY_LIT)
    const base = material.emissive.clone()
    interior.setBoostGlow(1)
    expect(material.emissive.r).toBeGreaterThan(base.r)
    expect(material.emissive.r - base.r).toBeCloseTo(
      (BOOST_GLOW.color[0] ?? 0) * BOOST_GLOW.emissiveGain,
      6,
    )
    // Amber: red over green over blue.
    expect(material.emissive.r - base.r).toBeGreaterThan(material.emissive.g - base.g)
    expect(material.emissive.g - base.g).toBeGreaterThan(material.emissive.b - base.b)
    interior.setBoostGlow(0)
    expect(material.emissive.r).toBe(base.r)
    expect(material.emissive.g).toBe(base.g)
    expect(material.emissive.b).toBe(base.b)
  })

  it('warms and brightens the lamps without adding or removing one', () => {
    const { root } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(ANNIVERSARY_LIT)
    const dash = interior.object.getObjectByName('cockpit_dash') as THREE.PointLight
    const count = (): number => {
      let n = 0
      interior.object.traverse((o) => {
        if ((o as THREE.Light).isLight) n++
      })
      return n
    }
    const lights = count()
    const rest = { intensity: dash.intensity, g: dash.color.g, r: dash.color.r }
    interior.setBoostGlow(1)
    expect(dash.intensity).toBeGreaterThan(rest.intensity)
    // Toward amber: green falls relative to red.
    expect(dash.color.g / dash.color.r).toBeLessThan(rest.g / rest.r)
    expect(count()).toBe(lights)
    interior.setBoostGlow(0)
    expect(dash.intensity).toBeCloseTo(rest.intensity, 12)
    expect(dash.color.g).toBeCloseTo(rest.g, 12)
  })

  it('survives a preset flip and the cabin being hidden (the lamps stay at zero when hidden)', () => {
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(ANNIVERSARY_LIT)
    interior.setBoostGlow(1)
    interior.set(ANNIVERSARY_LIT)
    const glowing = material.emissive.r
    const fresh = createCockpitInterior(asLoaded().root)
    fresh.set(ANNIVERSARY_LIT)
    expect(glowing).toBeGreaterThan(asLoaded().material.emissive.r)
    interior.setShown(false)
    const dash = interior.object.getObjectByName('cockpit_dash') as THREE.PointLight
    expect(dash.intensity).toBe(0)
    interior.setShown(true)
    expect(dash.intensity).toBeGreaterThan(0)
  })

  it('is a no-op with no lamps, and Classic puts the material back after a glow', () => {
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(CLASSIC)
    interior.setBoostGlow(0.5)
    interior.setBoostGlow(0)
    expect(material.emissive.getHex()).toBe(0x000000)
    interior.setBoostGlow(1)
    interior.dispose()
    expect(material.emissive.getHex()).toBe(0x000000)
  })

  it('clamps the level to 0..1, and a non-finite level is no glow', () => {
    const { root, material } = asLoaded()
    const interior = createCockpitInterior(root)
    interior.set(CLASSIC)
    interior.setBoostGlow(7)
    const full = material.emissive.r
    interior.setBoostGlow(1)
    expect(material.emissive.r).toBe(full)
    interior.setBoostGlow(Number.NaN)
    expect(material.emissive.r).toBe(0)
  })
})
