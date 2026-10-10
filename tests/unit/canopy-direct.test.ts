// tests/unit/canopy-direct.test.ts — the bake and the shadow map never darken
// the same ground twice. DEV-304, wishlist #33.
//
// ── The bug this file is the guard for ───────────────────────────────────
//
// DEV-295 darkens the ground under the scatter by multiplying all four
// `reflectedLight` accumulators, and it was allowed to touch the two DIRECT
// ones for exactly one stated reason: `render.props.scatterShadows` was false
// on both presets, so a tree cast nothing on the ground it stands on and there
// was no live shadow to double. `far-shadow.ts` carried that as a CLAUSE —
// *"if it ever goes true, this multiply has to lose its two `direct` lines"* —
// and DEV-304 turned it true on Anniversary in flat.
//
// **The failure mode is why this file exists.** A double count does not look
// like a double count. It looks like *"the 2D shadows are too dark"*, and that
// sentence sends the next session to `render.shadows.bias`, to the sun
// elevation and to `canopyShade.strength`, none of which is the cause.
//
// ── Two halves, and they fail differently ────────────────────────────────
//
// `canopy-patch.test.ts` owns the SHADER half: the direct pair is multiplied
// by a weighted term and the indirect pair by the raw one. That is a text
// assertion on the emitted GLSL and it is true of every preset at once,
// because the weight is a uniform (a define would move three's program cache
// key and rebuild every lit material on a live flip — DEV-186's fifteen
// programs, for a boolean).
//
// This file owns the WIRING half: what that uniform RESOLVES TO. The failure
// this catches is a `far-shadow.ts` that asked
// `edition.props.scatterShadows.enabled` directly, which is right on a monitor
// at quality `high` and wrong in the two places nobody would think to look —
// quality `low`, where `shadowsEnabled` refuses the map entirely so there is
// no shadow to hand over to, and inside a headset, where `vr.disable` has
// already turned the flag off. Both of those produce a forest floor that has
// lost its direct shading with nothing darkening it instead, which is the
// pre-DEV-295 picture arriving by a route nobody wrote down.
//
// ── The invariant, stated so it is not a re-derivation ───────────────────
//
// Trap 24: a test that re-derives its expectation the way the code does has
// not tested the code. `expect(canopyDirectWeight(e, s)).toBe(shadowCastersFor
// (e, s).scatter ? 0 : 1)` is exactly the implementation written twice. The
// claim asserted here instead is the RELATIONSHIP the picture depends on:
//
//   **never both.** For every preset and every quality tier, the ground under
//   a tree is darkened in DIRECT light by the shadow map or by the bake, and
//   not by both.
//
// It may be darkened by NEITHER — Classic, and Anniversary with
// `canopyShade` off — which is a real state and not a hole: that is the image
// before DEV-295 landed, and it is what `canopyShade.strength: 0` ships.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { ComfortSettings, QualitySetting } from '@/boot/settings'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { applyVrOverrides, editionFeatures } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { createFarShadow } from '@/render/far-shadow'
import { canopyDirectWeight, shadowCastersFor } from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

const QUALITIES: readonly QualitySetting[] = ['low', 'medium', 'high']

const at = (quality: QualitySetting): ComfortSettings => ({ ...DEFAULT_SETTINGS, quality })

/** The same preset with `props.scatterShadows` moved, and nothing else moved. */
const withScatterShadows = (e: Edition, enabled: boolean): Edition =>
  ({
    ...e,
    props: { ...e.props, scatterShadows: { ...e.props.scatterShadows, enabled } },
  }) as Edition

describe('never both: the map and the bake do not darken one patch of ground twice', () => {
  for (const [name, edition] of [
    ['anniversary', anniversary],
    ['classic', classic],
    ['anniversary, scatterShadows forced on', withScatterShadows(anniversary, true)],
    ['anniversary, scatterShadows forced off', withScatterShadows(anniversary, false)],
    ['anniversary in VR', applyVrOverrides(anniversary)],
  ] as const) {
    for (const quality of QUALITIES) {
      it(`${name} @ quality ${quality}`, () => {
        const casts = shadowCastersFor(edition, at(quality)).scatter
        const bakes = canopyDirectWeight(edition, at(quality)) > 0
        expect(casts && bakes, 'the forest floor is darkened twice').toBe(false)
        // And the other way: something has to own the direct term whenever the
        // preset says the ground under a tree should be darker than open
        // ground at all. `canopyShade.enabled` is the preset's statement that
        // it should be; without this, a weight stuck at 0 would pass the line
        // above for ever while shipping the pre-DEV-295 picture.
        if (edition.render.canopyShade.enabled && edition.render.canopyShade.strength > 0) {
          expect(casts || bakes, 'nothing darkens the ground under a tree').toBe(true)
        }
      })
    }
  }
})

describe('the shipped presets, read off the JSON rather than restated', () => {
  it('Anniversary casts the scatter in FLAT and not in VR (DEV-304 / DEV-263)', () => {
    // The assertion that fails if somebody flips the row back without saying
    // so, and the one that says which way it ships. Both halves, because "on
    // in flat, off in VR" is two facts and the second is the expensive one:
    // 2.70 ms through a real SteamVR compositor (DEV-224).
    expect(anniversary.props.scatterShadows.enabled).toBe(true)
    expect(applyVrOverrides(anniversary).props.scatterShadows.enabled).toBe(false)
    // Classic is the ledger. A flag Classic reads is a bug in the flag.
    expect(classic.props.scatterShadows.enabled).toBe(false)
  })

  it('and the VR layer reaches it through the registry, not through a special case', () => {
    // `vr.disable` entries are validated against `editionFeatures()` at load,
    // so a typo cannot quietly disable nothing — this asserts the path really
    // is in that registry rather than trusting the validator to have run.
    expect(new Map(editionFeatures(anniversary)).has('props.scatterShadows')).toBe(true)
    expect(anniversary.vr?.disable).toContain('props.scatterShadows')
  })

  it('so the bake keeps its direct half in a headset and hands it over in flat', () => {
    // The two states a player actually gets, named. This is the pair that
    // would silently swap if `canopyDirectWeight` were inverted, and neither
    // the "never both" matrix above nor the shader text can see an inversion.
    expect(canopyDirectWeight(anniversary, DEFAULT_SETTINGS)).toBe(0)
    expect(canopyDirectWeight(applyVrOverrides(anniversary), DEFAULT_SETTINGS)).toBe(1)
  })
})

describe('the uniform follows the live preset, with no rebuild', () => {
  /** A `FarShadow` over a live `EditionState`, and the state to move. */
  const rig = (edition: Edition, settings = DEFAULT_SETTINGS) => {
    const state = createEditionState(edition, settings)
    return { state, farShadow: createFarShadow(state) }
  }

  it('reads 0 while the scatter casts and 1 while it does not', () => {
    const { farShadow } = rig(anniversary)
    expect(farShadow.canopyDirect).toBe(0)
    farShadow.dispose()
    const off = rig(withScatterShadows(anniversary, false))
    expect(off.farShadow.canopyDirect).toBe(1)
    off.farShadow.dispose()
  })

  it('takes the direct half BACK at quality low, where there is no map to hand it to', () => {
    // The wiring bug this file exists for, in its cheapest form. A
    // `far-shadow.ts` reading `props.scatterShadows.enabled` directly answers
    // 0 here — the forest floor loses its direct shading and nothing replaces
    // it, because `shadowsEnabled` refused the map at this tier.
    const { state, farShadow } = rig(anniversary)
    expect(farShadow.canopyDirect).toBe(0)
    state.setSettings(at('low'))
    expect(farShadow.canopyDirect).toBe(1)
    farShadow.dispose()
  })

  it('takes it back the moment a headset starts presenting, on the notify', () => {
    // `setImmersive` is what `boot/app.ts` calls on `sessionstart`. Nothing
    // here re-attaches a world or rebuilds a material: the weight is a
    // uniform, so the seam is the edition notify and nothing else.
    const { state, farShadow } = rig(anniversary)
    expect(farShadow.canopyDirect).toBe(0)
    state.setImmersive(true)
    expect(farShadow.canopyDirect).toBe(1)
    state.setImmersive(false)
    expect(farShadow.canopyDirect).toBe(0)
    farShadow.dispose()
  })

  it('follows the Advanced page and the ?feature= pin, live', () => {
    // The same seam from the third direction. DEV-269's page writes
    // `featureOverrides`, which composes AFTER the VR layer — so a row pressed
    // in a headset to look at the shadows also moves the weight, in the same
    // frame, which is what makes the A/B arms comparable at all.
    const { state, farShadow } = rig(anniversary)
    state.setFeatureOverrides({ 'props.scatterShadows': false })
    expect(farShadow.canopyDirect).toBe(1)
    state.setFeatureOverrides({ 'props.scatterShadows': true })
    expect(farShadow.canopyDirect).toBe(0)
    farShadow.dispose()
  })

  it('reaches the SHADER as uSunTopD.z, on a material the patch really touched', () => {
    // The two halves joined: `canopy-patch.test.ts` proves the emitted GLSL
    // multiplies by `uSunTopD.z`, this proves the uniform object carrying that
    // name is the one `apply` writes. Without this the two could drift — a
    // weight written to a uniform nothing samples is a feature that is dead
    // in a build whose unit tests are green, which is exactly how DEV-295's
    // own patch shipped dead for a session.
    const { state, farShadow } = rig(anniversary)
    const material = new THREE.MeshStandardMaterial()
    farShadow.applyTo(material, 'ground')
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as unknown as THREE.WebGLRenderer,
    )
    expect(shader.fragmentShader).toContain('uSunTopD.z')
    const d = shader.uniforms.uSunTopD?.value as THREE.Vector4 | undefined
    expect(d, 'uSunTopD never reached the shader').toBeInstanceOf(THREE.Vector4)
    expect((d as THREE.Vector4).z).toBe(0)
    state.setImmersive(true)
    // The SAME Vector4, mutated in place — which is what makes a live flip
    // free. A copy here would mean the shader kept the boot-time value.
    expect((d as THREE.Vector4).z).toBe(1)
    farShadow.dispose()
  })
})
