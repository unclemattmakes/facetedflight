// tests/unit/terrain-bake.test.ts: the terrain bake cache, DEV-955.
//
// What this holds: a field that went through the file format and back is the
// field the runtime bake made (every array byte, every scalar), the key moves
// with every input the bake reads, a bad file is refused rather than believed,
// and a world build handed a baked field runs ZERO rows of either march and
// uploads the same textures. The shipped files themselves are held to the
// tree in terrain-bake-shipped.test.ts.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { runTerrainBakes } from '@/boot/app/world/terrain-bake-step'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { createSlicer } from '@/boot/slice'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { createFarShadow, towardSunSim } from '@/render/far-shadow'
import { albedoGrid, createSkyVisibility, skyFieldSteps } from '@/render/sky-visibility'
import {
  BAKE_SCALAR_KEYS,
  bakeTerrain,
  decodeSkyBake,
  decodeSunBake,
  digestHex,
  encodeSkyBake,
  encodeSunBake,
  skyBakeKey,
  sunBakeKey,
} from '@/render/terrain-bake'
import {
  type BakeManifest,
  type BakeStore,
  createTerrainBakeSource,
} from '@/render/terrain-bake-client'
import { runSteps } from '@/sim/steps'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import { createGreySampler, createMapSampler } from '@/sim/terrain/image-sampler'
import { sunHeightSteps } from '@/sim/terrain/sun-height'
import anniversaryJson from '../../content/editions/anniversary.json'

const anniversary = validateEdition(anniversaryJson as unknown as Edition)
const stateOf = () => createEditionState(anniversary, DEFAULT_SETTINGS)

const N = 65
const land = (seed = 0): HeightField => {
  const data = new Float32Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / (N - 1)
      const v = y / (N - 1)
      data[y * N + x] = 0.1 + 0.5 * u * u + 0.2 * v + 0.15 * Math.sin(9 * u + 2.3 * v + seed)
    }
  return buildHeightField(
    createGreySampler({ width: N, height: N, data }),
    {
      terrainSize: 512,
      terrainHeight: 200,
      chunkSize: 128,
      baseResolution: 8,
      randomOffset: 0,
      seed: 1,
    },
    { position: [-256, 0, -256], scale: [1, 1, 1] },
  )
}
const colour = () => {
  const px = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < 256; i++) {
    px[i * 4] = (i * 7) % 256
    px[i * 4 + 1] = (i * 13) % 256
    px[i * 4 + 2] = (i * 29) % 256
    px[i * 4 + 3] = 255
  }
  return createMapSampler({ width: 16, height: 16, channels: 4, data: px })
}
// where light TRAVELS (three space), 20 degrees up from a heading off every axis
const TRAVEL = [0.62, -0.34, -0.7] as const

describe('the file format', () => {
  it('round-trips a sun field and a sky field exactly, every array byte and every scalar', async () => {
    const l = land()
    const b = await bakeTerrain(l, colour(), towardSunSim(TRAVEL), 0)
    const sun = decodeSunBake(encodeSunBake(b.sunKey, b.sun), b.sunKey, l)
    const sky = decodeSkyBake(encodeSkyBake(b.skyKey, b.sky), b.skyKey, l)
    expect(sun).not.toBeNull()
    expect(sky).not.toBeNull()
    const same = (x: Float32Array, y: Float32Array) =>
      Buffer.from(x.buffer, x.byteOffset, x.byteLength).equals(
        Buffer.from(y.buffer, y.byteOffset, y.byteLength),
      )
    expect(same((sun as typeof b.sun).tops, b.sun.tops)).toBe(true)
    expect(same((sun as typeof b.sun).depths, b.sun.depths)).toBe(true)
    expect(sun).toEqual(b.sun)
    expect(sky).toEqual(b.sky)
  })

  it('names every non-array field of both types (a new field must not be silently dropped)', async () => {
    const b = await bakeTerrain(land(), colour(), towardSunSim(TRAVEL), 0)
    const nonArray = (o: object) =>
      Object.entries(o)
        .filter(([, v]) => !(v instanceof Float32Array) && v !== null)
        .map(([k]) => k)
        .sort()
    expect(nonArray(b.sun)).toEqual(
      [...BAKE_SCALAR_KEYS.sun, 'towardSun', 'marchedSun', 'degenerate'].sort(),
    )
    expect(nonArray(b.sky)).toEqual([...BAKE_SCALAR_KEYS.sky].sort())
  })

  it('refuses a file that is not exactly the one written for this key and land', async () => {
    const l = land()
    const b = await bakeTerrain(l, colour(), towardSunSim(TRAVEL), 0)
    const good = encodeSunBake(b.sunKey, b.sun)
    expect(decodeSunBake(good, b.sunKey, l)).not.toBeNull()
    expect(decodeSunBake(good, b.skyKey, l)).toBeNull() // another key
    expect(decodeSunBake(good.slice(0, good.length - 4), b.sunKey, l)).toBeNull() // truncated
    expect(
      decodeSunBake(new TextEncoder().encode('<!doctype html><html></html>'), b.sunKey, l),
    ).toBeNull()
    expect(decodeSunBake(encodeSkyBake(b.skyKey, b.sky), b.skyKey, l)).toBeNull() // wrong kind
    const bent = good.slice()
    bent[0] = (bent[0] as number) ^ 1
    expect(decodeSunBake(bent, b.sunKey, l)).toBeNull() // magic
  })

  it('reads a file whose bytes sit at an unaligned offset in a larger buffer', async () => {
    const l = land()
    const b = await bakeTerrain(l, colour(), towardSunSim(TRAVEL), 0)
    const file = encodeSunBake(b.sunKey, b.sun)
    const big = new Uint8Array(file.length + 3)
    big.set(file, 3)
    expect(decodeSunBake(big.subarray(3), b.sunKey, l)).toEqual(b.sun)
  })
})

describe('the key', () => {
  it('moves with every input the bake reads, and with nothing else', async () => {
    const l = land()
    const sun = towardSunSim(TRAVEL)
    const base = await sunBakeKey(l, sun)
    expect(await sunBakeKey(land(), sun)).toBe(base) // same inputs, same key
    expect(await sunBakeKey(land(0.001), sun)).not.toBe(base) // one height moved
    expect(await sunBakeKey(l, towardSunSim([0.62, -0.34, -0.7000001]))).not.toBe(base)
    expect(await sunBakeKey({ ...l, originY: 1 }, sun)).not.toBe(base)
    expect(await sunBakeKey({ ...l, scaleY: 2 }, sun)).not.toBe(base)
    expect(await sunBakeKey({ ...l, terrainHeight: 201 }, sun)).not.toBe(base)

    const albedo = albedoGrid(l, colour())
    const sky = await skyBakeKey(base, albedo, 0)
    expect(await skyBakeKey(base, albedo, 0)).toBe(sky)
    expect(await skyBakeKey(base, albedo, 1)).not.toBe(sky) // softMetres
    expect(await skyBakeKey(await sunBakeKey(land(0.001), sun), albedo, 0)).not.toBe(sky)
    const other = albedo.slice()
    other[10] = (other[10] as number) + 1e-3
    expect(await skyBakeKey(base, other, 0)).not.toBe(sky) // one texel of colour
  })

  it('is the same digest from crypto.subtle and from the pure copy', async () => {
    const bytes = new TextEncoder().encode('terrain bake')
    const { sha256Hex } = await import('@/content/sha256')
    expect(await digestHex(bytes)).toBe(sha256Hex(bytes))
  })
})

describe('the world build with a baked answer', () => {
  const rig = () => {
    const state = stateOf()
    return {
      state,
      farShadow: createFarShadow(state),
      skyVisibility: createSkyVisibility(state),
    }
  }
  const memoryStore = (): BakeStore & { map: Map<string, Uint8Array> } => {
    const map = new Map<string, Uint8Array>()
    return {
      map,
      get: async (n) => map.get(n) ?? null,
      put: async (n, b) => {
        map.set(n, b.slice())
      },
    }
  }
  const emptyManifest: BakeManifest = { files: {} }
  const sunColour = new THREE.Color(0.9, 0.6, 0.4)
  const run = async (
    r: ReturnType<typeof rig>,
    source: ReturnType<typeof createTerrainBakeSource>,
  ) =>
    runTerrainBakes({
      levelId: 'unit',
      source,
      slicer: createSlicer({ budgetMs: 0 }),
      farShadow: r.farShadow,
      skyVisibility: r.skyVisibility,
      land: land(),
      colorMap: colour(),
      sunTravel: TRAVEL,
      jitterMetres: 1.3,
      canopy: null,
      sunColour,
      softMetres: r.state.current.render.sunHeight.softMetres,
      skyWanted: true,
    })

  it('runs the marches once, remembers them, and the next load runs none', async () => {
    const store = memoryStore()
    const source = createTerrainBakeSource({ manifest: emptyManifest, store })
    const a = rig()
    const first = await run(a, source)
    expect(first.receipt.sun?.from).toBe('runtime')
    expect(first.receipt.sun?.rows).toBeGreaterThan(0)
    expect(first.receipt.sky?.from).toBe('runtime')
    expect(first.receipt.sky?.rows).toBeGreaterThan(0)
    await Promise.resolve()
    expect([...store.map.keys()].map((k) => k.slice(0, 3)).sort()).toEqual(['sky', 'sun'])

    const b = rig()
    const second = await run(b, source)
    expect(second.receipt.sun).toMatchObject({ from: 'idb', rows: 0, slices: 0 })
    expect(second.receipt.sky).toMatchObject({ from: 'idb', rows: 0, slices: 0 })
    // The same fields, and the textures built from them are the same bytes.
    expect(second.sweep).toEqual(first.sweep)
    expect(second.skyBake).toEqual(first.skyBake)
    const tex = (s: { farShadow: ReturnType<typeof createFarShadow> }) =>
      (s.farShadow as unknown as { field: unknown }).field
    expect(tex(b)).toEqual(tex(a))
  })

  it('a baked field and a marched field upload identical textures', async () => {
    const l = land()
    const marched = runSteps(sunHeightSteps(l, towardSunSim(TRAVEL)))
    const a = rig()
    const b = rig()
    runSteps(a.farShadow.setWorldSteps(l, TRAVEL, 1.3, null))
    runSteps(b.farShadow.setWorldSteps(l, TRAVEL, 1.3, null, null, marched))
    expect(b.farShadow.field).toEqual(a.farShadow.field)
    expect(b.farShadow.liftMetres).toBe(a.farShadow.liftMetres)

    const albedo = albedoGrid(l, colour())
    const field = runSteps(skyFieldSteps(l, albedo, marched, 0))
    runSteps(a.skyVisibility.setWorldSteps(l, colour(), marched, sunColour))
    runSteps(
      b.skyVisibility.setWorldSteps(l, colour(), marched, sunColour, { albedo, baked: field }),
    )
    expect(b.skyVisibility.field).toEqual(a.skyVisibility.field)
    expect(b.skyVisibility.field).toEqual(field)
  })
})

describe('where a mission finds its bake', () => {
  it('fetches only a listed key, checks the hash, and falls back on anything wrong', async () => {
    const l = land()
    const b = await bakeTerrain(l, colour(), towardSunSim(TRAVEL), 0)
    const bytes = encodeSunBake(b.sunKey, b.sun)
    const sha = await digestHex(bytes)
    const asked: string[] = []
    const serve = (body: Uint8Array | null) => async (path: string) => {
      asked.push(path)
      return body
    }
    const manifest: BakeManifest = {
      files: { [`sun-${b.sunKey}`]: { sha256: sha, users: ['unit'] } },
    }

    // listed, right bytes
    const ok = createTerrainBakeSource({ manifest, store: null, fetchBytes: serve(bytes) })
    expect((await ok.findSun(b.sunKey, l))?.from).toBe('file')
    expect(asked).toEqual([`assets/terrain-bake/sun-${b.sunKey}.bin`])

    // not listed: no request at all (a custom course, the editor)
    asked.length = 0
    const other = await sunBakeKey(land(0.5), towardSunSim(TRAVEL))
    expect(await ok.findSun(other, l)).toBeNull()
    expect(asked).toEqual([])

    // listed, but the host answered 404 / its HTML shell / a truncated body
    for (const body of [null, new TextEncoder().encode('<!doctype html>'), bytes.slice(0, 100)]) {
      const bad = createTerrainBakeSource({ manifest, store: null, fetchBytes: serve(body) })
      expect(await bad.findSun(b.sunKey, l)).toBeNull()
    }
  })

  it('starts the manifest files for a level before their keys are known', async () => {
    const asked: string[] = []
    const manifest: BakeManifest = {
      files: {
        'sun-aa': { sha256: 'x', users: ['int_01_hoverJet', 'adv_02_hoverJet'] },
        'sky-bb': { sha256: 'x', users: ['int_01_hoverJet@anniversary'] },
        'sun-cc': { sha256: 'x', users: ['rookie_01_hoverJet'] },
      },
    }
    const s = createTerrainBakeSource({
      manifest,
      store: null,
      fetchBytes: async (p) => {
        asked.push(p)
        return null
      },
    })
    s.prefetch('int_01_hoverJet', 'anniversary')
    await Promise.resolve()
    expect(asked.sort()).toEqual([
      'assets/terrain-bake/sky-bb.bin',
      'assets/terrain-bake/sun-aa.bin',
    ])
  })
})
