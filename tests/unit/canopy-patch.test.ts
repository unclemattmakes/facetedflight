// tests/unit/canopy-patch.test.ts — the canopy multiply lands where it must.
//
// DEV-295, wishlist #13. `sim/props/canopy.ts` computes the field and
// `tests/unit/canopy.test.ts` pins its shape; this is the render half — the
// splice into three's own AO slot, and the two properties that make the term
// free and independent.
//
// **Every claim about three is read out of three's build**, the way
// `xr-eye-layers.test.ts` does. `aomap_fragment` running after
// `lights_fragment_end` is what puts a fully accumulated `reflectedLight` in
// front of this patch; that is three's ordering, not ours, `three` is pinned
// exact only until somebody accepts a bump, and a comment asserting it would
// be a belief written twice.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  AOMAP_INCLUDE,
  canopyPatchFragment,
  SUN_HEIGHT_GLSL,
  SUN_HEIGHT_INCLUDE,
  sunHeightPatchFragment,
} from '@/render/far-shadow'

/**
 * A shader as the CALL SITE hands it over: sun-patched first, canopy second.
 *
 * Composing the two is not tidiness. The first version of this file passed the
 * RAW shader, `canopyPatchFragment` guarded on `SUN_HEIGHT_INCLUDE`, and
 * `sunHeightPatchFragment` REPLACES that include — so the guard was false at
 * the only call site that matters, the patch returned the shader untouched,
 * and the whole feature shipped dead under nineteen green tests. A test that
 * feeds a function an input its caller never produces has not tested the
 * caller.
 */
const asShipped = (body: string): string =>
  sunHeightPatchFragment(`void main() {
${SUN_HEIGHT_INCLUDE}
${body}
}`)

describe("the canopy patch's anchor, in three's own build", () => {
  for (const name of ['physical', 'lambert'] as const) {
    it(`${name} carries the AO slot, after every light has been accumulated`, () => {
      const fragment = THREE.ShaderLib[name].fragmentShader
      expect(fragment).toContain(AOMAP_INCLUDE)
      expect(fragment).toContain(SUN_HEIGHT_INCLUDE)
      // AFTER the lights. If three ever moved it before `lights_fragment_end`,
      // this patch would scale an empty accumulator and the feature would
      // vanish in silence — which is precisely the outcome its own throw
      // exists to prevent, arriving by a route the throw cannot see.
      expect(fragment.indexOf(AOMAP_INCLUDE)).toBeGreaterThan(
        fragment.indexOf('#include <lights_fragment_end>'),
      )
    })
  }

  it('scales all four accumulators, and three still has all four to scale', () => {
    const patched = canopyPatchFragment(asShipped(AOMAP_INCLUDE))
    for (const field of [
      'directDiffuse',
      'indirectDiffuse',
      'directSpecular',
      'indirectSpecular',
    ] as const) {
      // The DIRECT pair takes the weighted term and the INDIRECT pair takes the
      // raw one — DEV-304, and the asymmetry is the whole of it. Asserted by
      // naming the expected multiplier per field rather than by a blanket
      // `toContain('ff2Canopy')`, which was true of the bug too.
      const by = field.startsWith('direct') ? 'ff2CanopyDirect' : 'ff2Canopy'
      expect(patched, `reflectedLight.${field} is not scaled by ${by}`).toContain(
        `reflectedLight.${field} *= ${by};`,
      )
      // The name exists on three's own struct. A rename upstream would be a
      // compile error in a headset and nothing here, which is the wrong place
      // to find out.
      expect(THREE.ShaderChunk.common, `three dropped ${field}`).toContain(field)
    }
  })

  // ── DEV-304: the double count that hides behind `props.scatterShadows` ──
  //
  // `render.props.scatterShadows` is TRUE on Anniversary in flat since
  // DEV-304, so the scatter draws into the shadow map, so the ground under a
  // tree is already darkened once. DEV-295 multiplied all four accumulators
  // and was right to while nothing else was doing it; unweighted now it
  // darkens the forest floor TWICE, and the symptom is not "a double count" —
  // it is "the 2D shadows are too dark", which sends the next session to the
  // bias and the sun elevation.
  //
  // The weight is a uniform rather than a define so a live flip costs no
  // recompile, which means the SHADER always carries both halves and what a
  // text test can prove is that the direct pair is gated and the indirect pair
  // is not. What the gate RESOLVES TO for a preset is `canopy-direct.test.ts`.
  describe('the DIRECT half hands over to the shadow map (DEV-304)', () => {
    const patched = (): string => canopyPatchFragment(asShipped(AOMAP_INCLUDE))

    it('multiplies no direct accumulator by the unweighted term', () => {
      // THE assertion this describe exists for, and the one that goes red on
      // the bug: `reflectedLight.direct<anything> *= ff2Canopy;` is the exact
      // text DEV-295 shipped and DEV-304 removed. A `toContain` of the new
      // name would pass with the old line still beside it.
      expect(patched()).not.toMatch(/reflectedLight\.direct\w+\s*\*=\s*ff2Canopy\s*;/)
    })

    it('gates it on uSunTopD.z, and on nothing the canopy term already consumed', () => {
      const body = patched()
      // The weight is applied as a LERP toward 1, so weight 0 is exactly the
      // old light and weight 1 is exactly DEV-295. A plain multiply by the
      // weight would black the frame out at 0, which is the obvious wrong
      // shape for this line and the one a hurried fix would write.
      // DEV-453 made the weight SPATIAL: uSunTopD.z is what the bake owns where
      // the map is, and ff2MapCover (0 past the box) says where that is. The
      // inner lerp is toward 1 for the same reason: no map is the bake's.
      expect(body).toContain(
        'float ff2CanopyDirect = mix( 1.0, ff2Canopy, mix( 1.0, uSunTopD.z, ff2MapCover ) );',
      )
      // Not `.x` (DEV-296's fade metres) and not `.y` (DEV-297's silhouette
      // fraction): those are ART, live in `far-shadow.ts` as exported
      // constants, and reusing one here would couple a look number to a
      // correctness one.
      expect(body).not.toContain('uSunTopD.x )')
      expect(body).not.toContain('uSunTopD.y )')
    })

    it('leaves the INDIRECT pair unweighted, because a shadow map never touches it', () => {
      // The bug in the other direction, and it is just as invisible: a weight
      // on ambient would delete the forest floor's shading in a headset, where
      // `vr.disable` turns the caster set off and the bake is all there is.
      const body = patched()
      expect(body).toContain('reflectedLight.indirectDiffuse *= ff2Canopy;')
      expect(body).toContain('reflectedLight.indirectSpecular *= ff2Canopy;')
      expect(body).not.toMatch(/reflectedLight\.indirect\w+\s*\*=\s*ff2CanopyDirect\s*;/)
    })
  })

  it('throws rather than silently dropping the term when the anchor is gone', () => {
    // `sunHeightChunk`'s rule, for the same reason: a build that boots having
    // lost the feature is the worst outcome, because nothing reports it.
    expect(() => canopyPatchFragment(asShipped('gl_FragColor = vec4( 1.0 );'))).toThrow(
      /aomap_fragment/,
    )
  })

  it('leaves a shader the SUN patch never reached completely alone', () => {
    // The same contract `sunHeightPatchFragment` has: a material this never
    // reached is not a material to throw about. `render/illustrative.ts` is
    // the file that depends on it.
    //
    // And the precondition is the DEFINE the sun patch leaves behind, not the
    // include it consumes — so a shader carrying the AO slot and nothing else
    // is still untouched, which is the case a custom material presents.
    for (const untouched of [
      'void main() { gl_FragColor = vec4( 1.0 ); }',
      `void main() {
${AOMAP_INCLUDE}
}`,
    ]) {
      expect(canopyPatchFragment(untouched)).toBe(untouched)
    }
  })

  it('survives the sun patch having eaten its own include — the dead-build bug', () => {
    // Stated as its own test because it is the one property the composition
    // above exists to preserve, and a later refactor could quietly re-break it
    // while every other test here still passed.
    const shipped = asShipped(AOMAP_INCLUDE)
    expect(shipped, 'the sun patch no longer consumes its include').not.toContain(
      SUN_HEIGHT_INCLUDE,
    )
    // The MULTIPLY, not the name. `toContain('ff2Canopy')` was the first
    // version and it passed with the bug reintroduced, because
    // `SUN_HEIGHT_GLSL` defines `ff2CanopyTerm` and is prepended either way —
    // so the substring was there whether or not a single pixel was scaled.
    // A test named after a bug that does not fail on that bug is worse than no
    // test: it is a green tick with the defect's name on it.
    //
    // The INDIRECT line, since DEV-304: the direct pair is weighted and could
    // in principle resolve to a no-op, so it is the wrong half to ask here.
    // This one is unconditional on every preset.
    expect(canopyPatchFragment(shipped)).toContain('reflectedLight.indirectDiffuse *= ff2Canopy;')
  })
})

describe('the canopy term itself', () => {
  const code = SUN_HEIGHT_GLSL.replace(/\/\/[^\n]*/g, '')

  /** The function's body, comments already stripped. */
  const termBody = (): string => {
    const start = code.indexOf('float ff2CanopyTerm()')
    expect(start, 'ff2CanopyTerm is gone').toBeGreaterThan(0)
    return code.slice(start)
  }

  it('costs nothing on a material that is neither ground nor prop', () => {
    // A runtime `if` would still cost the fetch on the sea, the racers, the
    // clouds and the cockpit. The early return is a preprocessor conditional,
    // resolved before the code generator runs, so on those it compiles away
    // entirely — and it names BOTH roles, so adding the prop path (DEV-296)
    // did not quietly switch the fetch on for everything.
    const body = termBody()
    expect(body).toContain('#if !defined( FF2_SUN_GROUND ) && !defined( FF2_CANOPY_OBJECT )')
    expect(
      body.indexOf('#if !defined( FF2_SUN_GROUND )'),
      'the guard must come before the fetch, or it saves nothing',
    ).toBeLessThan(body.indexOf('texture2D'))
  })

  it('has a PROP path that fades out above the canopy ceiling (DEV-296)', () => {
    // Without the ramp a prop is darkened uniformly by its OWN canopy, crown
    // and all, and a lone tree on an open hillside just gets darker. The ramp
    // is anchored on the ceiling (.a) and runs downward, so the claim is that
    // the prop branch reads BOTH channels and the ground branch does not.
    const body = termBody()
    const propStart = body.indexOf('#ifdef FF2_CANOPY_OBJECT')
    expect(propStart, 'no prop path').toBeGreaterThan(0)
    const prop = body.slice(propStart, body.indexOf('#else', propStart))
    const ground = body.slice(body.indexOf('#else', propStart))
    expect(body, 'the term does not read the ceiling channel').toContain('.ba')
    expect(prop, 'the prop path does not use the fragment height').toContain('vFf2SunWorld.y')
    expect(prop, 'the prop path does not ramp').toContain('smoothstep')
    // The GROUND is at the bottom of whatever is over it, always — so its
    // branch must not consult a height at all. A ramp there would make the
    // land's own shading depend on its altitude, which is not a thing.
    expect(ground, 'the ground path must not ramp by height').not.toContain('smoothstep')
    expect(ground).not.toContain('vFf2SunWorld.y')
  })

  it('rides the sun term s own texel: same sampler, same uv helper', () => {
    // The whole reason this feature is free. Two fetches at identical
    // coordinates on one sampler is a common subexpression any compiler folds;
    // two DIFFERENT uv expressions would not be, and would also be a second
    // copy of the z negation that `far-shadow.test.ts` counts.
    const body = termBody()
    expect(body).toContain('ff2SunMesh()')
    expect(body).toContain('texture2D( uSunTopMap,')
    // ONE fetch for both channels, so the prop path costs nothing over the
    // ground path beyond a smoothstep.
    expect(body.split('texture2D(').length - 1, 'more than one fetch').toBe(1)
  })

  it('has its own switch, which is not the sun term s', () => {
    // They share a texture and a fetch. Sharing those is a PERFORMANCE
    // decision and must not become a semantic one: a row on the Advanced page
    // that turned off a feature it does not name is DEV-269's "a control that
    // appears to work and does not", one level up.
    const sun = code.slice(
      code.indexOf('float ff2SunHeightTerm()'),
      code.indexOf('float ff2Canopy'),
    )
    const canopy = code.slice(code.indexOf('float ff2CanopyTerm()'))
    expect(sun).toContain('uSunTopC.x < 0.5')
    expect(sun).not.toContain('uSunTopC.w')
    expect(canopy).toContain('uSunTopC.w < 0.5')
    expect(canopy).not.toContain('uSunTopC.x')
  })

  it('returns exactly 1 on open ground, so an empty field is the old image', () => {
    // The sweep writes exact zeroes where there are no props, and both paths
    // are `1.0 - occlusion * something` — so a mission with no scatter, or a
    // preset at strength 0, multiplies by exactly one rather than by something
    // very close to it. Asserted on both branches, because the prop path
    // multiplies the occlusion by a ramp and a ramp that had been written as
    // an addition would break this without breaking anything else.
    const body = termBody()
    expect(body).toContain('return 1.0 - canopy.x;')
    // The prop path multiplies the occlusion by the ramp AND by DEV-297's
    // silhouette fraction. Matched loosely on purpose — the factors are art
    // and may gain another — but it must stay a `1 - occlusion * ...` product,
    // because an ADDITION anywhere in that chain breaks the exact-1 guarantee
    // without breaking anything else in this file.
    expect(body).toMatch(/return 1\.0 - canopy\.x \* under \* [A-Za-z0-9_.]+;/)
  })
})
