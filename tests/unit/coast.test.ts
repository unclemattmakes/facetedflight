// tests/unit/coast.test.ts — the shoreline (DEV-087).
//
// Four things can go wrong here and only one of them would ever be visible:
//
//  1. **The ramp.** Easy to check, and the only half a monitor would catch.
//  2. **The coordinate mapping.** A shallows band on the wrong side of the
//     island, or two metres off the beach, looks exactly like an art choice —
//     which is the orientation lesson's whole point. So the mapping is asserted
//     against the LAND GENERATOR's own output, at a real vertex of a real chunk:
//     the same world point, the same height, reached two different ways. Not
//     against a second copy of the formula (trap 24).
//  3. **The texture.** `importUnityTexture` rescales 1025 to 1024 and addresses
//     texels as `u * width` (DEV-007); the readback has to land on the texel
//     centres that addressing implies, or the whole map softens by half a texel.
//  4. **Classic.** Both strengths at zero has to be an IDENTITY, not nearly one,
//     and the water has to compile ONE program for both presets or the sea and
//     the land start sharing a shader again (`render/program-cache-key.ts`).
//
// The maps live in `public/assets`, which is gitignored and hydrated from R2,
// so the two specs that need a real island skip themselves on CI — and the disk
// work happens INSIDE the `it`, because `describe.skipIf` skips the tests and
// not the describe body (CLAUDE.md, and it has cost this repo five red pushes).

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { validateEdition } from '@/content/edition-schema'
import { terrainOriginSim } from '@/game/mission-shape'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import {
  COAST_GLSL,
  COAST_NO_LAND,
  COAST_OFF,
  type CoastMap,
  type CoastSettings,
  coastColor,
  coastDepth,
  coastHeightSamples,
  coastLandY,
  coastMapFrom,
  coastPack,
  coastSettings,
  coastUv,
  foamAmount,
  insideCoastMap,
  shallowAmount,
} from '@/render/coast'
import { applyWaterWaves, COAST_CHOP_GLSL, coastChop, waterDisplacement } from '@/render/water'
import { buildVertexGrid, generateChunk, grayscale } from '@/sim/terrain/faceted'
import {
  createMapSampler,
  type ImageData8,
  importUnityTexture,
  type MapSampler,
  type Rgb,
} from '@/sim/terrain/image-sampler'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'

const SIMONET_HEIGHT = 'public/assets/terrain/simonet/islandgroup-height.png'
const haveMap = fs.existsSync(SIMONET_HEIGHT)

/** A settings block with everything on, so the ramp has something to do. */
const LIVE: CoastSettings = {
  shallowDepth: 50,
  shallowStrength: 0.55,
  shallowColor: [0.1, 0.5, 0.48],
  foamDepth: 16,
  foamStrength: 0.35,
  foamColor: [0.83, 0.91, 0.93],
  foamBreakup: 0.6,
}

const BLUE: readonly [number, number, number] = [0.025, 0.22, 0.93]

describe('the depth ramp', () => {
  it('is the identity in deep water', () => {
    // Past shallowDepth there is no shallows and no foam, so the sea is the sea.
    for (const depth of [50, 51, 120, 4000, COAST_NO_LAND]) {
      expect(coastColor(BLUE, depth, 1, LIVE)).toEqual([...BLUE])
    }
  })

  it('reaches the shallow colour EXACTLY at zero depth when the strength is 1', () => {
    // `mix(x, y, 1)` is `y`, not "close to y" — the same property the haze's
    // identity at a = 0 rests on. Foam off, so this is the shallows alone.
    const full: CoastSettings = { ...LIVE, shallowStrength: 1, foamStrength: 0 }
    expect(coastColor(BLUE, 0, 1, full)).toEqual([...full.shallowColor])
  })

  it('is monotone in depth, per channel, with the foam off', () => {
    // The shallows term alone: one lerp, so each channel moves one way. (With
    // foam on the composed term is two nested lerps toward two different
    // colours and a channel may legitimately turn around — the same caveat
    // `render/haze.ts` records about desaturate x tint.)
    const noFoam: CoastSettings = { ...LIVE, foamStrength: 0 }
    for (let c = 0; c < 3; c++) {
      const toward = (noFoam.shallowColor[c] as number) > (BLUE[c] as number) ? 1 : -1
      let previous = (coastColor(BLUE, 0, 1, noFoam)[c] as number) * toward
      for (let depth = 0.5; depth <= 80; depth += 0.5) {
        const here = (coastColor(BLUE, depth, 1, noFoam)[c] as number) * toward
        expect(here, `channel ${c} at ${depth} m`).toBeLessThanOrEqual(previous + 1e-9)
        previous = here
      }
    }
  })

  it('puts foam ONLY inside (0, foamDepth)', () => {
    for (const depth of [-40, -1, 0, 16, 16.001, 50, 400]) {
      expect(foamAmount(depth, LIVE), `${depth} m`).toBe(0)
    }
    for (const depth of [0.001, 4, 8, 15.999]) {
      expect(foamAmount(depth, LIVE), `${depth} m`).toBeGreaterThan(0)
    }
  })

  it('keeps the shallows on under the land, where the foam stops', () => {
    // Depth below zero is water drawn where the land is already above it —
    // visible only at a grazing angle past a headland. The shallowest colour is
    // the honest one there; a foam line that carries on under the beach is a
    // drawn outline, which is the one thing §6's king-tide warning forbids.
    expect(shallowAmount(-30, LIVE)).toBe(1)
    expect(foamAmount(-30, LIVE)).toBe(0)
  })

  it('is the identity everywhere when both strengths are zero', () => {
    // CLASSIC. Not "close to" the identity: `toEqual` on the same three floats.
    for (const depth of [-100, -1, 0, 0.5, 8, 16, 50, 1e6]) {
      for (const chop of [0, 0.5, 1]) {
        expect(coastColor(BLUE, depth, chop, COAST_OFF), `${depth} m`).toEqual([...BLUE])
      }
    }
  })

  it('is the identity for Classic as the FILE ships it, not as a test invents it', () => {
    // The preset read off disk and through the loader's own validator, so a
    // future edit to classic.json that turns a strength up fails here.
    const classic = validateEdition(
      JSON.parse(fs.readFileSync('content/editions/classic.json', 'utf8')),
    )
    const settings = coastSettings(classic.render.coast.enabled ? classic.render.coast : null)
    expect(classic.render.coast.enabled).toBe(false)
    for (const depth of [-10, 0, 3, 20, 120]) {
      expect(coastColor(BLUE, depth, 0.5, settings)).toEqual([...BLUE])
    }
  })

  it('takes foam away with the chop, and only in proportion to foamBreakup', () => {
    const at = (chop: number, breakup: number) =>
      coastColor(BLUE, 4, chop, { ...LIVE, foamBreakup: breakup })[1] as number
    // Breakup 0: the chop is ignored entirely, so the band is unbroken.
    expect(at(0, 0)).toBeCloseTo(at(1, 0), 12)
    // Breakup 1: the chop is the whole modulator, so a trough has no foam at all
    // and the colour falls back to the shallows term.
    expect(at(0, 1)).toBeCloseTo(
      coastColor(BLUE, 4, 1, { ...LIVE, foamStrength: 0 })[1] as number,
      12,
    )
    // And in between, more chop is more foam.
    expect(at(1, 0.6)).toBeGreaterThan(at(0, 0.6))
  })

  it('packs the two depths as reciprocals, and refuses to divide by zero', () => {
    expect(coastPack(LIVE)[0]).toBeCloseTo(1 / 50, 12)
    expect(coastPack(LIVE)[1]).toBeCloseTo(1 / 16, 12)
    expect(coastPack({ ...LIVE, shallowDepth: 0, foamDepth: 0 }).slice(0, 2)).toEqual([0, 0])
  })
})

// ── the coordinate mapping ────────────────────────────────────────────────

/** A synthetic 4x4 map whose grayscale is a known function of the texel. */
const rampImage = (w: number, h: number): ImageData8 => {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = (x * 16 + y * 3) % 256
  }
  return { width: w, height: h, channels: 1, data }
}

describe('world (x, z) to the height map', () => {
  const map: CoastMap = {
    originX: -2157.92,
    originY: -81.69,
    originZ: 1867.14,
    sizeX: 4096,
    sizeZ: 4096,
    heightScale: 1536,
    width: 1024,
    height: 1024,
  }

  it('runs u with +x and v with MINUS z', () => {
    // The z mirror. `chunkGeometry` flips the generator's z into three space, so
    // the map runs toward SMALLER world z — get the sign wrong and the shallows
    // land on the far side of the island from the beach, which on a scattered
    // archipelago looks entirely plausible.
    expect(coastUv(map, map.originX, map.originZ)).toEqual([0, 0])
    const far = coastUv(map, map.originX + 4096, map.originZ - 4096)
    expect(far[0]).toBeCloseTo(1, 12)
    expect(far[1]).toBeCloseTo(1, 12)
    // And the other corner is OUTSIDE, which is the assertion a sign error fails.
    expect(insideCoastMap(coastUv(map, map.originX, map.originZ + 4096))).toBe(false)
  })

  it('says "no land" outside the footprint rather than clamping', () => {
    // `MapSampler.sample` clamps uv, which would smear the island's edge texel
    // across 260 km of ocean and put a shallow band on the horizon.
    const sampler = createMapSampler(rampImage(4, 4))
    expect(coastLandY(map, sampler, map.originX - 1, map.originZ)).toBeNull()
    expect(coastDepth(map, sampler, map.originX - 1, map.originZ, 116.6)).toBe(COAST_NO_LAND)
  })

  it('subtracts the land from the surface, in that order', () => {
    // A sign error here is a sea that is deepest at the beach.
    const flat: MapSampler = {
      width: 4,
      height: 4,
      sample: (_u: number, _v: number, out: Rgb) => {
        out.r = 0.1
        out.g = 0.1
        out.b = 0.1
      },
    }
    const landY = -81.69 + 0.1 * 1536
    expect(coastLandY(map, flat, 0, 0)).toBeCloseTo(landY, 9)
    expect(coastDepth(map, flat, 0, 0, 116.6)).toBeCloseTo(116.6 - landY, 9)
  })

  it('reads `coastMapFrom` off the group rather than recomputing the placement', () => {
    // `worldOffset + local + envRoot` has been wrong twice (DEV-042). What is
    // asserted is the RELATIONSHIP — the map's origin IS the group's position —
    // because that is true on every environment and false for any re-derivation
    // that drifts.
    const group = new THREE.Group()
    group.position.set(-2157.92, -81.69, 1867.14)
    group.scale.set(1, 1, 1)
    const built = coastMapFrom({
      position: group.position,
      scale: group.scale,
      terrainSize: 4096,
      terrainHeight: 1536,
      mapWidth: 1024,
      mapHeight: 1024,
    })
    expect([built.originX, built.originY, built.originZ]).toEqual([
      group.position.x,
      group.position.y,
      group.position.z,
    ])
    expect(built.sizeX).toBe(4096)
    expect(built.heightScale).toBe(1536)
  })

  it('scales with the terrain transform, which the ocean plate proves is not always 1', () => {
    const scaled = coastMapFrom({
      position: { x: 0, y: 0, z: 0 },
      scale: { x: 8, y: 2, z: 8 },
      terrainSize: 32768,
      terrainHeight: 512,
      mapWidth: 512,
      mapHeight: 512,
    })
    expect(scaled.sizeX).toBe(32768 * 8)
    expect(scaled.heightScale).toBe(512 * 2)
  })
})

describe('the same point, two ways', () => {
  it('agrees with the LAND GENERATOR at a real vertex of a real chunk', () => {
    // The one assertion that would catch a mirrored island, a half-texel drift
    // or a transposed uv, because neither side of it is this file's arithmetic:
    // one side is `generateChunk` -> the three-space flip, and the other is
    // `coastLandY`. If they disagree the shallows are not on the coastline.
    if (!haveMap) {
      expect(haveMap, 'maps absent — run `pnpm assets:pull`').toBe(false)
      return
    }
    const img = decodePngBuffer(fs.readFileSync(SIMONET_HEIGHT), 'simonet') as ImageData8
    const sampler = importUnityTexture(img)
    const key = environmentTerrains('simonet').land
    const params = terrainParams(key)
    const grid = buildVertexGrid(sampler, params)

    // int_01's placement, out of `terrainOriginSim` — the shared rule
    // `terrain-env-root.test.ts` already proves against world positions measured
    // through the scene flattener. Not retyped here: the sum has been wrong
    // twice, and a copy of it in a test is a copy that can agree with a bug.
    // SIM space mirrors z, so three's z is minus sim's.
    const level = JSON.parse(fs.readFileSync('content/levels/int_01_hoverJet.json', 'utf8')) as {
      worldOffset: number[]
    }
    const origin = terrainOriginSim(key, level.worldOffset)
    const map: CoastMap = {
      originX: origin.position[0],
      originY: origin.position[1],
      originZ: -origin.position[2],
      sizeX: params.terrainSize * (origin.scale[0] as number),
      sizeZ: params.terrainSize * (origin.scale[2] as number),
      heightScale: params.terrainHeight * (origin.scale[1] as number),
      width: sampler.width,
      height: sampler.height,
    }

    // A chunk well away from the origin and off the grid diagonal: (0,0) is open
    // sea at u,v ~ 0.03 and was blind to both of DEV-007's bugs, which is the
    // standing example of why a corner spot-check is not a verification.
    const chunk = generateChunk(grid, sampler, sampler, params, 9, 5, 0)
    const errors: number[] = []
    let skirt = 0
    for (let i = 0; i < chunk.positions.length; i += 3) {
      // The generator emits UNITY space and `chunkGeometry` flips z; do the same
      // flip here, then add the group's world position the same way `loadTerrain`
      // does — `(wo.x + tp.x, wo.y + tp.y, wo.z - tp.z)`.
      const meshY = chunk.positions[i + 1] as number
      // THE SKIRT IS NOT THE SURFACE. `generateChunk` runs its quad loop one ring
      // wider than the chunk and pins the outer corners to mesh y = 0 — a
      // zero-width wall dropping to sea level that hides the crack a coarser
      // neighbour would show. Those vertices are 375 m from the map on this
      // chunk and they are SUPPOSED to be. A real vertex is
      // `grayscale * terrainHeight + jitter.y`, which is exactly zero only if
      // both terms are, so this identifies them without a tolerance.
      if (meshY === 0) {
        skirt++
        continue
      }
      const worldX = map.originX + (chunk.positions[i] as number)
      const worldY = map.originY + meshY
      const worldZ = map.originZ - (chunk.positions[i + 2] as number)
      const read = coastLandY(map, sampler, worldX, worldZ)
      if (read === null) continue
      errors.push(Math.abs(read - worldY))
    }
    // The skirt filter has to be doing something real and not everything: one
    // ring around a 32-quad chunk is a few per cent of the vertices.
    expect(skirt).toBeGreaterThan(0)
    expect(skirt / (chunk.positions.length / 3)).toBeLessThan(0.2)
    expect(errors.length).toBeGreaterThan(5000)

    // The generator JITTERS every vertex by `randomOffset` (1.3 m on Simonet) in
    // all three axes, so the mesh and the map cannot agree exactly — and the
    // jitter in x and z moves the SAMPLE too, over ground that climbs to 1,004 m.
    // What is asserted is that the two are the same SURFACE: the median sits
    // inside the jitter's own radius, and the tail inside a few metres of it. A
    // mirrored or half-mapped island misses by hundreds.
    errors.sort((a, b) => a - b)
    const at = (f: number) =>
      errors[Math.min(errors.length - 1, Math.floor(f * errors.length))] as number
    expect(at(0.5), 'median metres between the vertex and the map at its own (x, z)').toBeLessThan(
      params.randomOffset,
    )
    expect(at(0.99), 'p99 metres').toBeLessThan(6)
  })

  it('is nowhere near that close if the map is read MIRRORED', () => {
    // The guard on the guard: the test above only means something if the wrong
    // convention FAILS it. `v -> 1 - v` reads the island north-to-south, which is
    // the bug `image-sampler.ts` says of this very axis "looks entirely
    // plausible" — and it stays inside [0, 1], so it cannot be caught by a
    // bounds check the way a sign flip would be.
    if (!haveMap) {
      expect(haveMap, 'maps absent — run `pnpm assets:pull`').toBe(false)
      return
    }
    const img = decodePngBuffer(fs.readFileSync(SIMONET_HEIGHT), 'simonet') as ImageData8
    const sampler = importUnityTexture(img)
    const params = terrainParams(environmentTerrains('simonet').land)
    const grid = buildVertexGrid(sampler, params)
    const originY = -81.69
    const chunk = generateChunk(grid, sampler, sampler, params, 9, 5, 0)
    const rgb: Rgb = { r: 0, g: 0, b: 0 }
    const medianError = (mirrored: boolean): number => {
      const errors: number[] = []
      for (let i = 0; i < chunk.positions.length; i += 3) {
        const meshY = chunk.positions[i + 1] as number
        if (meshY === 0) continue // the skirt; see the test above
        const u = (chunk.positions[i] as number) / params.terrainSize
        const v = (chunk.positions[i + 2] as number) / params.terrainSize
        sampler.sample(u, mirrored ? 1 - v : v, rgb)
        errors.push(Math.abs(grayscale(rgb.r, rgb.g, rgb.b) * params.terrainHeight - meshY))
      }
      errors.sort((a, b) => a - b)
      return errors[Math.floor(errors.length / 2)] as number
    }
    // The RELATIONSHIP, not a threshold: a flipped map is two orders of
    // magnitude further from the mesh than the right one, on any chunk and on
    // any platform. An absolute figure would be a number about chunk (9, 5).
    expect(medianError(true) / medianError(false)).toBeGreaterThan(20)
    expect(originY).toBe(-81.69)
  })
})

// ── the texture ───────────────────────────────────────────────────────────

describe('the height texture', () => {
  it('reads back the sampler EXACTLY, at the texel centres Unity addresses', () => {
    // `createMapSampler` computes `fx = u * width` and `fy = (h - 1) - v * h`, so
    // a stored texel comes back exactly at `u = x / width` and `v = j / height`.
    // Sampling at `(x + 0.5) / width` — the reading that looks right — blends two
    // columns and softens the whole map by half a texel.
    const img = rampImage(4, 4)
    const samples = coastHeightSamples(createMapSampler(img))
    expect(samples.length).toBe(16)
    for (let j = 0; j < 4; j++) {
      for (let x = 0; x < 4; x++) {
        // Bottom-origin row j is PNG row (height - 1 - j).
        const byte = img.data[(4 - 1 - j) * 4 + x] as number
        expect(samples[j * 4 + x], `texel ${x},${j}`).toBeCloseTo(byte / 255, 6)
      }
    }
  })

  it('emits BOTTOM-ORIGIN rows, because that is what a DataTexture wants', () => {
    // A flip here mirrors the island north-to-south, which `image-sampler.ts`
    // says of the same axis "looks entirely plausible" on an archipelago.
    const data = new Uint8Array(4)
    data[0] = 255 // PNG row 0 (the TOP), column 0
    const samples = coastHeightSamples(createMapSampler({ width: 2, height: 2, channels: 1, data }))
    // The top row must come back LAST.
    expect(samples[0]).toBe(0)
    expect(samples[2]).toBeCloseTo(1, 6)
  })

  it("takes Unity's luminance, not the red channel", () => {
    // `buildVertexGrid` and `buildHeightField` both turn `grayscale(r, g, b)`
    // into metres. Reading `.r` would agree with them on a greyscale PNG and
    // disagree on any other, which is the shape of bug that ships.
    const data = new Uint8Array([255, 0, 0])
    const samples = coastHeightSamples(createMapSampler({ width: 1, height: 1, channels: 3, data }))
    expect(samples[0]).toBeCloseTo(0.299, 5)
  })

  it('goes through importUnityTexture, so 1025 becomes 1024', () => {
    // DEV-007: both Simonet maps are 1025x1025 with `nPOTScale: 1`, and the
    // generator sampled the RESCALED texture. The texture the water reads has to
    // be the same one, or the sea and the land disagree about where the shore is.
    if (!haveMap) {
      expect(haveMap, 'maps absent — run `pnpm assets:pull`').toBe(false)
      return
    }
    const img = decodePngBuffer(fs.readFileSync(SIMONET_HEIGHT), 'simonet') as ImageData8
    expect(img.width).toBe(1025)
    expect(importUnityTexture(img).width).toBe(1024)
  })

  it('survives half float at the shoreline to well under a land facet', () => {
    // 8 bits would be 1536 / 255 = 6.0 m per code across a 50 m ramp: eight
    // steps, which would read as contour lines drawn on the sea. Half float at
    // the shoreline's own value is two orders of magnitude finer.
    const shoreNormalised = (116.6 + 81.69) / 1536
    const round = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(shoreNormalised))
    expect(Math.abs(round - shoreNormalised) * 1536).toBeLessThan(0.25)
  })
})

// ── the GLSL twins ────────────────────────────────────────────────────────

const stripComments = (src: string): string =>
  src
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('//')
      return at === -1 ? line : line.slice(0, at)
    })
    .join(' ')

describe('the GLSL twin of the ramp', () => {
  const code = stripComments(COAST_GLSL)

  it('returns before the texture fetch when both strengths are zero', () => {
    // This is what makes Classic free as well as identical: a branch on a
    // UNIFORM, so the whole draw takes the same side of it and no water fragment
    // ever samples the island.
    //
    // Scoped to `ff2Coast`'s own body, because the fetch lives in the helper
    // ABOVE it and a whole-file `indexOf` would compare two unrelated positions
    // and pass or fail on the order the functions happen to be declared in.
    const body = code.slice(code.indexOf('vec3 ff2Coast('))
    expect(body).toMatch(
      /if\s*\(\s*uCoastRamp\.z\s*<=\s*0\.0\s*&&\s*uCoastRamp\.w\s*<=\s*0\.0\s*\)\s*return color;/,
    )
    // The only way out before that line would be another return above it.
    expect(body.indexOf('return')).toBe(body.indexOf('return color;'))
    // And the fetch is reached only through the call the early return guards.
    expect(body).not.toContain('texture2D')
    expect(body).toContain('ff2CoastDepth(world)')
  })

  it('subtracts z for v and adds the half texel for the fetch', () => {
    expect(code).toMatch(/uCoastPlane\.y\s*-\s*world\.z/)
    expect(code).toMatch(/texture2D\(\s*uCoastMap,\s*uv\s*\+\s*uCoastLand\.zw\s*\)/)
  })

  it('refuses a uv outside the footprint instead of clamping it', () => {
    expect(code).toMatch(/any\(lessThan\(uv, vec2\(0\.0\)\)\)/)
    expect(code).toMatch(/any\(greaterThan\(uv, vec2\(1\.0\)\)\)/)
    expect(code).toContain(String(COAST_NO_LAND))
  })

  it('gates the foam on depth > 0, as the oracle does', () => {
    expect(code).toMatch(/depth\s*>\s*0\.0\s*\?/)
  })

  it('interpolates COAST_NO_LAND rather than retyping it', () => {
    // The oracle and the shader cannot disagree about where the island stops.
    expect(COAST_GLSL).toContain(`return ${COAST_NO_LAND}.0;`)
  })
})

describe('the fragment-side chop', () => {
  const code = stripComments(COAST_CHOP_GLSL)
  const wave = { live: true, direction: 322, speed: 2, amplitude: 4, frequency: 0.4, noise: -1 }

  it('is the WAVE, normalised — one arithmetic implementation, not two', () => {
    for (const [x, z, t] of [
      [0, 0, 0],
      [1234.5, -987.25, 3.1],
      [-14949, -13692, 12.75],
    ] as const) {
      const expected = 0.5 + (0.5 * waterDisplacement(wave, x, z, t)) / wave.amplitude
      expect(coastChop(wave, x, z, t)).toBeCloseTo(Math.min(1, Math.max(0, expected)), 12)
    }
  })

  it('stays in 0..1 over a period, and actually moves', () => {
    const seen: number[] = []
    for (let t = 0; t < 3.2; t += 0.05) seen.push(coastChop(wave, 431.5, -1617.25, t))
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...seen)).toBeLessThanOrEqual(1)
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.2)
  })

  it('keeps the four traps `WAVE_GLSL` keeps, because it is the same wave', () => {
    // Both rotated components in the phase (`dot(float2, scalar)` promotes).
    expect(code).toMatch(/\(\s*dir\.x\s*\+\s*dir\.y\s*\)\s*\*/)
    // `.xzz`: z twice, unfolded.
    expect(code).toMatch(/uz\s*\*\s*78\.233/)
    expect(code).toMatch(/uz\s*\*\s*63\.9137/)
    expect(code).not.toMatch(/142\.1467/)
    // `(n + 1)`, so the noise can subtract.
    expect(code).toMatch(/uWave\.z\s*\*\s*\(\s*n\s*\+\s*1\.0\s*\)/)
    // UNITY space.
    expect(code).toMatch(/float\s+uz\s*=\s*-\s*world\.z/)
  })

  it('does not displace anything — it only reads', () => {
    // The 23x undersample is a FINDING (DEV-023's companion), not a bug to fix.
    // This is a second READER of the wave; if it ever writes `transformed` or
    // `vWaterWorld` it has become a second author of the sea.
    expect(code).not.toMatch(/transformed/)
    expect(code).not.toMatch(/vWaterWorld\s*=/)
  })
})

// ── Classic ───────────────────────────────────────────────────────────────

/** Run the real patch and hand back what it injected and what it bound. */
const compileWater = () => {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true })
  const water = applyWaterWaves(
    material,
    { live: true, direction: 322, speed: 2, amplitude: 4, frequency: 0.4, noise: -1 },
    null,
  )
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <begin_vertex>',
    fragmentShader:
      '#include <color_fragment>\n#include <normal_fragment_begin>\n#include <opaque_fragment>',
  }
  // `onBeforeCompile` is three's, so its renderer argument is never read here.
  ;(material.onBeforeCompile as unknown as (s: typeof shader) => void)(shader)
  return { material, water, shader }
}

describe('Classic is identical, and shares one program with Anniversary', () => {
  it('leaves every coast uniform at its zero until a coast is attached', () => {
    const { shader } = compileWater()
    const ramp = shader.uniforms.uCoastRamp?.value as THREE.Vector4
    expect([ramp.z, ramp.w]).toEqual([0, 0])
    expect(shader.uniforms.uCoastBreakup?.value).toBe(0)
    // The sampler is bound to a real 1x1 texture, not left null: an unbound
    // sampler is undefined behaviour on some drivers and a warning on the rest.
    expect(shader.uniforms.uCoastMap?.value).toBeInstanceOf(THREE.DataTexture)
  })

  it('REFUSES an Anniversary preset that arrives before the island does', () => {
    // Both orders happen every run: the preset is live at construction and the
    // terrains land seconds later. A depth read against one black texel would
    // paint the whole sea the shallow colour out to the horizon.
    const { water, shader } = compileWater()
    water.setCoast(LIVE)
    const ramp = shader.uniforms.uCoastRamp?.value as THREE.Vector4
    expect([ramp.z, ramp.w]).toEqual([0, 0])
  })

  it('takes the preset once the source is there, and gives it back on Classic', () => {
    const { water, shader } = compileWater()
    const map: CoastMap = {
      originX: -2157.92,
      originY: -81.69,
      originZ: 1867.14,
      sizeX: 4096,
      sizeZ: 4096,
      heightScale: 1536,
      width: 1024,
      height: 1024,
    }
    water.setCoastSource(map, new THREE.DataTexture())
    water.setCoast(LIVE)
    const ramp = shader.uniforms.uCoastRamp?.value as THREE.Vector4
    expect(ramp.z).toBeCloseTo(LIVE.shallowStrength, 12)
    expect(ramp.w).toBeCloseTo(LIVE.foamStrength, 12)
    const plane = shader.uniforms.uCoastPlane?.value as THREE.Vector4
    expect([plane.x, plane.y]).toEqual([map.originX, map.originZ])
    expect(plane.z).toBeCloseTo(1 / 4096, 12)
    const land = shader.uniforms.uCoastLand?.value as THREE.Vector4
    expect([land.x, land.y]).toEqual([map.originY, map.heightScale])
    // The half texel, which is 2 m of Simonet shoreline.
    expect(land.z).toBeCloseTo(0.5 / 1024, 12)
    // A flip back to Classic zeroes it again.
    water.setCoast(COAST_OFF)
    expect([ramp.z, ramp.w]).toEqual([0, 0])
  })

  it('compiles ONE program for both presets — the key does not move with the coast', () => {
    // A `#define` would give Classic a byte-identical shader at the cost of two
    // programs per water material and a second entry in the key. The thing
    // Classic has to be identical in is its OUTPUT, and the uniform path is what
    // `render/haze.ts` already chose.
    //
    // What is asserted is therefore not "the key says nothing about the coast" —
    // three's DEFAULT `customProgramCacheKey` is `onBeforeCompile.toString()`,
    // so the injected GLSL is in the key whatever we do — but the invariant that
    // matters: **flipping the preset does not change the key**. The day the
    // coast becomes a real variant, this fails and `tagProgramCacheKey` is the
    // fix, or the sea and the land start sharing a shader again (DEV-051's bug
    // wearing a new hat).
    const a = compileWater()
    const b = compileWater()
    a.water.setCoastSource(
      {
        originX: 0,
        originY: 0,
        originZ: 0,
        sizeX: 1,
        sizeZ: 1,
        heightScale: 1,
        width: 4,
        height: 4,
      },
      new THREE.DataTexture(),
    )
    a.water.setCoast(LIVE)
    b.water.setCoast(COAST_OFF)
    expect(a.material.customProgramCacheKey()).toBe(b.material.customProgramCacheKey())
    expect(a.material.customProgramCacheKey()).toContain('water:')
  })

  it('changes the ALBEDO and nothing about the geometry', () => {
    // The coast is a colour, so it lands at `<color_fragment>` — before the
    // lighting, the specular, the sky reflection, the haze and the fog, every
    // one of which then runs on top exactly as it did. Nothing it does can move
    // a vertex: `?ocean=<n>` and the generator own the mesh and this owns a mix.
    const { shader } = compileWater()
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = ff2Coast(')
    expect(shader.vertexShader).not.toContain('ff2Coast')
    expect(shader.vertexShader).not.toContain('uCoast')
    // And the coast's own source writes exactly one thing.
    expect(COAST_GLSL).not.toMatch(/gl_Position|transformed/)
  })
})

describe('the shipped presets', () => {
  const read = (id: string) =>
    validateEdition(JSON.parse(fs.readFileSync(`content/editions/${id}.json`, 'utf8')))

  it('give Anniversary depths that are band WIDTHS on a measured shore', () => {
    // Simonet's coastline is 25.06 km and its shore runs at about 1:1, so the
    // mean horizontal width of the 0..D band (area over perimeter, 4 m grid,
    // 116.6 m waterline) is 1.5 m at D = 4 and 8.5 m at D = 16. A foamDepth
    // under about 10 is a band narrower than one 8 m land facet — a drawn line
    // rather than water, and invisible at any distance.
    const coast = read('anniversary').render.coast
    expect(coast.enabled).toBe(true)
    expect(coast.foamDepth).toBeGreaterThanOrEqual(10)
    // And the shallows have to be wider than the foam, or the band they are
    // supposed to sit inside is on top of them.
    expect(coast.shallowDepth).toBeGreaterThan(coast.foamDepth)
    // Start faint: §6 records king-tide's overlays being authored at demo
    // strength and reading as allover noise on a lap.
    expect(coast.foamStrength).toBeLessThanOrEqual(0.5)
  })

  it('converts the preset colours out of sRGB, like every other picked colour', () => {
    // `fog.color` and `haze.tint` are both sRGB in content and linear in the
    // shader, because the framebuffer is linear. Getting that wrong for the fog
    // cost a session and left a milky sheet in front of the world.
    const coast = read('anniversary').render.coast
    const resolved = coastSettings(coast)
    for (let i = 0; i < 3; i++) {
      const srgb = coast.shallowColor[i] as number
      if (srgb > 0.05 && srgb < 0.95) {
        expect(resolved.shallowColor[i], `channel ${i}`).toBeLessThan(srgb)
      }
    }
  })
})
