// tests/unit/water-fog-flag.test.ts — two cache-key fields that cannot change a
// pixel, and the freezes they bought (DEV-194).
//
// Of thirteen missions flown for ninety seconds each, eleven never compile a
// program after their first frame. The two that do own the two worst frames in
// the game — `adv_02_hoverJet` at 318.4 ms and `int_01_hoverJet` at 178.6 ms —
// and BOTH are the sea compiling a program whose GLSL it already had.
//
//   the fog flag     `material.fog` is `parameters.useFog`, and three emits
//                    `USE_FOG` only for `useFog && fog`. `parameters.fog` is
//                    the SCENE's fog, which this renderer never sets. So a
//                    band that disagrees with its base about `fog` compiles
//                    **textually identical GLSL** into a second program.
//   the define ORDER `getProgramCacheKey` walks the defines with `for…in`, so
//                    `{A,B}` and `{B,A}` are two keys for one shader.
//
// ── Why a unit test and not only the e2e gate ────────────────────────────
//
// `tests/e2e/inflight-compile.spec.ts` is the gate that FOUND this, and it
// needs a GPU, hydrated assets and a ninety-second flight per mission.
// `pnpm e2e` never runs in CI, and this month a census defect survived for
// exactly that reason — its only guard lived in a spec nothing runs unattended
// (CLAUDE.md, "A red gate argues for itself"). Everything below runs in
// `pnpm test`, on a plain Node, in milliseconds.
//
// ── The oracle is three's own build, not our belief about it ─────────────
//
// Same reasoning as `tests/unit/xr-eye-layers.test.ts`, and the same danger:
// the bit positions are three's PRIVATE ordering, not API, and `three` is
// pinned exact here only because `three-mesh-bvh`'s ceiling is a live
// constraint. The pin will move. When it does, §1 fails and somebody re-reads
// the code instead of shipping a row whose central claim has gone quietly
// false. §2 and §3 then apply the rule to our own materials.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import { fogFlag, setFogFlag } from '@/render/program-cache-key'
import { applyWaterWaves, FACET_METRES_DEFAULT, type WaterDisplace } from '@/render/water'
import { REPO as ROOT } from './helpers/repo-root'

/** The material the ocean's plate is cut from, near enough for the clone question. */
const oceanLike = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0, side: THREE.FrontSide })

/**
 * Simonet's real ocean wave, out of the generated sheet.
 *
 * Nothing here depends on the numbers — but a hand-typed set of them under
 * `tests/` is the same smell as one under `src/sim/`, and the sheet is one
 * import away (`ocean-density.test.ts` takes it the same way).
 */
const waves = TERRAIN.simonet.terrains.ocean.displace as unknown as WaterDisplace

/** Band sizes that are not the base's, so every one of them is a real clone. */
const BANDS = [FACET_METRES_DEFAULT * 2, FACET_METRES_DEFAULT * 4, FACET_METRES_DEFAULT * 8]

describe('§1 three still keys on these two things the way we think it does', () => {
  // Inside the `it`s, not above them: a `describe` body runs during COLLECTION,
  // and disk work there cannot be skipped or reported (CLAUDE.md).
  const build = (): string =>
    fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

  it('puts material.fog in the cache key as bit 1 of the second _programLayers mask', () => {
    const src = build()
    // `useFog` is `material.fog`, and nothing else.
    expect(src).toContain('useFog: material.fog === true,')
    // The second mask's first two bits, in order. `parameters.fog` (bit 0) is
    // the SCENE's; `parameters.useFog` (bit 1) is the material's.
    expect(src).toContain(
      ['\t\tif ( parameters.fog )', '\t\t\t_programLayers.enable( 0 );'].join('\n'),
    )
    expect(src).toContain(
      ['\t\tif ( parameters.useFog )', '\t\t\t_programLayers.enable( 1 );'].join('\n'),
    )
  })

  it('emits USE_FOG only for useFog AND fog — so with no scene fog it cannot reach the shader', () => {
    const src = build()
    // Both prefixes, vertex and fragment. This conjunction is the whole reason
    // the two programs are textually identical: with `parameters.fog` false,
    // `useFog` changes no character of either shader.
    const gate = "parameters.useFog && parameters.fog ? '#define USE_FOG' : '',"
    expect(src.split(gate).length - 1, 'both the vertex and fragment prefix').toBe(2)
    expect(src).toContain("parameters.useFog && parameters.fogExp2 ? '#define FOG_EXP2' : '',")
  })

  it('keys on the defines by INSERTION ORDER, because it walks them with for…in', () => {
    // `for…in` over string keys is insertion order, so two materials with the
    // same define SET in a different order are two programs. This is the half
    // that cost `int_01_hoverJet` 178.6 ms at 77.2 s.
    expect(build()).toContain('for ( const name in parameters.defines ) {')
  })

  it('is a claim about ORDER that JavaScript actually keeps', () => {
    // The control: assert the language behaviour the line above relies on,
    // rather than assuming it. Delete-then-re-add moves a key to the end;
    // assigning one that is already there does not move it.
    const d: Record<string, string> = { STANDARD: '', A: '', B: '' }
    expect(Object.keys(d)).toEqual(['STANDARD', 'A', 'B'])
    d.A = 'still'
    expect(Object.keys(d)).toEqual(['STANDARD', 'A', 'B'])
    delete d.A
    d.A = ''
    expect(Object.keys(d)).toEqual(['STANDARD', 'B', 'A'])
  })
})

describe('§2 the sea never disagrees with itself about the fog flag — DEV-194', () => {
  it('turns three fog OFF before a band can be cut, whatever boot/app.ts does later', () => {
    const base = oceanLike()
    expect(fogFlag(base), 'three ships this true').toBe(true)
    applyWaterWaves(base, waves)
    // The pin. `unity-fog.ts`'s `applyTo` sets this too, but only once
    // `loadTerrain` has resolved — and the bands are cut while the chunks are
    // being built, i.e. before that. Whichever runs first, the value is one.
    expect(fogFlag(base)).toBe(false)
  })

  it('cuts every band in agreement with its base — the relationship, not the value', () => {
    // Asserted as a relationship on purpose (CLAUDE.md, the orientation
    // lesson): it stays true if the mechanism above is ever replaced by a
    // re-sync, and it is false for the bug either way.
    const base = oceanLike()
    const water = applyWaterWaves(base, waves)
    const bands = BANDS.map((f) => water.materialFor(f))
    for (const band of bands) {
      expect(band, 'a real clone, not the base back again').not.toBe(base)
      expect(fogFlag(band), band.name).toBe(fogFlag(base))
    }
  })

  it('still agrees after the fog patch runs on the base, which is the shape of the bug', () => {
    // The exact sequence `boot/app.ts` takes: bands are cut during
    // `loadTerrain`, and only then does `applyAtmosphere` reach the BASE — and
    // deliberately not the clones, because handing a clone to `applyTo` splices
    // the fog prologue twice and the sea does not compile (DEV-183).
    //
    // Before the fix this test failed on the FIRST band: `Material.copy`
    // carried `true` into a clone cut at load, the base then went `false`, and
    // the sea had two materials for one picture for the life of the mission.
    const base = oceanLike()
    const water = applyWaterWaves(base, waves)
    const early = water.materialFor(BANDS[0] as number)
    // …loadTerrain resolves, and unity-fog patches the base…
    setFogFlag(base, false)
    const late = water.materialFor(BANDS[1] as number)
    expect(fogFlag(early), 'a band cut BEFORE the patch').toBe(fogFlag(base))
    expect(fogFlag(late), 'a band cut AFTER the patch').toBe(fogFlag(base))
  })
})

describe('§3 the sea never disagrees with itself about the define ORDER — DEV-194', () => {
  /** The defines three would hash, in the order it would walk them. */
  const order = (m: THREE.Material): string[] => Object.keys(m.defines ?? {})

  it('builds one order for one state, however the flight arrived at it', () => {
    // The bug: `applyVariant` used to assign-or-delete, so leaving the water
    // and coming back re-added `FF2_WATER_TWO_SIDED` AFTER `FF2_WATER_SHAFT`.
    // `clearShaftBore` was never called by `boot/app.ts` then, so the bore was
    // live for the whole mission and every mission crosses the surface — which
    // is why this was reachable on two missions and not on some exotic path.
    // (DEV-460 clears it once the lift plugs the shaft; the order stays the
    // state's, which is what this pins.)
    const base = oceanLike()
    const water = applyWaterWaves(base, waves)
    water.setShaftBore(0, 0, 50, 100)

    // The state the warm-up compiles: eye under the surface, bore live.
    water.setEyeHeight(0, 500)
    const warmed = order(base)
    expect(warmed).toContain('FF2_WATER_TWO_SIDED')
    expect(warmed).toContain('FF2_WATER_SHAFT')

    // Out of the water — `FF2_WATER_TWO_SIDED` leaves — and back down again,
    // which is the route that used to produce the second key.
    water.setEyeHeight(5000, 0)
    expect(order(base)).not.toContain('FF2_WATER_TWO_SIDED')
    water.setEyeHeight(0, 500)
    expect(order(base), 'same state, same key').toEqual(warmed)
  })

  // This one passes even with the bug, and says so out loud: `materialFor`
  // hands each band the base's `defines` OBJECT by reference, so the order is
  // shared and cannot drift. It is here for the change `water.ts` predicts in
  // its own comment — *"if `materialFor` is ever changed to hand out a COPY of
  // the defines, which is the tidier-looking thing to do"* — at which point it
  // becomes the only thing holding this half of the invariant.
  it('keeps every band on the base ORDER, not just the base SET', () => {
    const base = oceanLike()
    const water = applyWaterWaves(base, waves)
    water.setShaftBore(0, 0, 50, 100)
    water.setEyeHeight(0, 500)
    const band = water.materialFor(BANDS[1] as number)
    water.setEyeHeight(5000, 0)
    water.setEyeHeight(0, 500)
    // `toEqual` on the key ARRAY, not on a set: a band whose defines carry the
    // same names in another order is a second program, and a set comparison
    // would have called that a pass.
    expect(order(band)).toEqual(order(base))
  })
})
