// src/boot/app/world/terrain-bake-step.ts: the world build's two terrain bakes, with a baked answer in front.
// DEV-955. This is the stretch of `build.ts` that used to be two `slicer.drain(...)` calls.
//
// For a shipped mission both fields are already on disk (`tools/terrain/bake-terrain.mjs`), so the
// build finds them, hands them to the same `setWorldSteps` that would have marched, and runs ZERO
// rows of either march. For anything else (a custom course, the editor, a sun that moved, a file
// not on R2 yet, a hash that does not match) it runs the march exactly as before, a slice at a
// time, and keeps the result in IndexedDB for the next visit. Either way the textures are built
// by `far-shadow.ts` and `sky-visibility.ts` from a field, so nothing downstream can tell.

import type * as THREE from 'three'
import type { Slicer } from '@/boot/slice'
import type { FarShadow } from '@/render/far-shadow'
import { towardSunSim } from '@/render/far-shadow'
import { albedoGrid, type SkyVisibility, skyTextureData } from '@/render/sky-visibility'
import {
  countRows,
  digestHex,
  encodeSkyBake,
  encodeSunBake,
  skyBakeKey,
  sunBakeKey,
} from '@/render/terrain-bake'
import type { BakeSource, TerrainBakeSource } from '@/render/terrain-bake-client'
import type { CanopyField } from '@/sim/props/canopy'
import type { HeightField } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'
import type { SkyVisibilityField } from '@/sim/terrain/sky-visibility'
import type { SunHeightField } from '@/sim/terrain/sun-height'

export interface BakePhaseReceipt {
  /** Where the field came from. */
  readonly from: BakeSource
  /** Rows of the march this load ran. Zero for a baked field. */
  readonly rows: number
  /** Turns handed back to the frame loop while it ran. */
  readonly slices: number
  /** Wall time, the key and the lookup included. */
  readonly ms: number
}

export interface TerrainBakeReceipt {
  readonly level: string
  /** The inputs' hashes, i.e. the shipped files' names; null where no key was taken. */
  readonly sunKey: string | null
  readonly skyKey: string | null
  readonly sun: BakePhaseReceipt | null
  readonly sky: BakePhaseReceipt | null
}

export interface TerrainBakeInputs {
  readonly levelId: string
  readonly source: TerrainBakeSource
  readonly slicer: Slicer
  readonly farShadow: FarShadow
  readonly skyVisibility: SkyVisibility
  readonly land: HeightField
  readonly colorMap: MapSampler
  /** `lighting.sun.direction` (where light travels, three space), or null. */
  readonly sunTravel: readonly number[] | null
  readonly jitterMetres: number
  readonly canopy: CanopyField | null
  readonly sunColour: THREE.Color | null
  readonly softMetres: number
  /** Does the live preset bake the sky term? */
  readonly skyWanted: boolean
}

export interface TerrainBakeResult {
  readonly sweep: SunHeightField | null
  readonly skyBake: SkyVisibilityField | null
  readonly receipt: TerrainBakeReceipt
}

export const runTerrainBakes = async (i: TerrainBakeInputs): Promise<TerrainBakeResult> => {
  // ── the far-shadow march ────────────────────────────────────────────────
  let t = performance.now()
  let yields = i.slicer.yields
  let sunKey: string | null = null
  let foundSun: { field: SunHeightField; from: BakeSource } | null = null
  if (i.sunTravel && !i.land.analytic) {
    try {
      sunKey = await sunBakeKey(i.land, towardSunSim(i.sunTravel))
      foundSun = await i.source.findSun(sunKey, i.land)
    } catch {
      sunKey = null // no digest here: the march runs, nothing is kept
    }
  }
  const sunRows = { rows: 0 }
  const sweep = await i.slicer.drain(
    countRows(
      i.farShadow.setWorldSteps(
        i.land,
        i.sunTravel as readonly number[] | null,
        i.jitterMetres,
        i.canopy,
        null,
        foundSun?.field ?? null,
      ),
      sunRows,
    ),
  )
  if (sweep && sunKey && !foundSun) void i.source.rememberSun(sunKey, sweep)
  const sun: BakePhaseReceipt | null = i.sunTravel
    ? {
        from: foundSun?.from ?? 'runtime',
        rows: sunRows.rows,
        slices: i.slicer.yields - yields,
        ms: performance.now() - t,
      }
    : null

  // ── the sky-visibility bake ─────────────────────────────────────────────
  t = performance.now()
  yields = i.slicer.yields
  let albedo: Float32Array | undefined
  let skyKey: string | null = null
  let foundSky: { field: SkyVisibilityField; from: BakeSource } | null = null
  if (i.skyWanted && sweep && sunKey && i.sunColour && !i.land.analytic) {
    try {
      albedo = albedoGrid(i.land, i.colorMap)
      skyKey = await skyBakeKey(sunKey, albedo, i.softMetres)
      foundSky = await i.source.findSky(skyKey, i.land)
    } catch {
      skyKey = null
    }
  }
  const skyRows = { rows: 0 }
  const skyBake = await i.slicer.drain(
    countRows(
      i.skyVisibility.setWorldSteps(i.land, i.colorMap, sweep, i.sunColour, {
        albedo,
        baked: foundSky?.field ?? null,
      }),
      skyRows,
    ),
  )
  if (skyBake && skyKey && !foundSky) void i.source.rememberSky(skyKey, skyBake)
  const sky: BakePhaseReceipt | null =
    i.skyWanted && skyBake
      ? {
          from: foundSky?.from ?? 'runtime',
          rows: skyRows.rows,
          slices: i.slicer.yields - yields,
          ms: performance.now() - t,
        }
      : null
  return { sweep, skyBake, receipt: { level: i.levelId, sunKey, skyKey, sun, sky } }
}

/**
 * SHA-256 of each field as the shipped file would hold it. Equal to the manifest's
 * `sha256` exactly when this load's fields are byte-identical to the baked ones:
 * how the e2e compares a runtime bake in the browser with the file from the tool.
 */
export const terrainBakeDigest = async (
  receipt: TerrainBakeReceipt,
  fields: { readonly sun: SunHeightField | null; readonly sky: SkyVisibilityField | null },
): Promise<{ sun: string | null; sky: string | null; skyTexture: string | null }> => ({
  sun:
    fields.sun && receipt.sunKey
      ? await digestHex(encodeSunBake(receipt.sunKey, fields.sun))
      : null,
  sky:
    fields.sky && receipt.skyKey
      ? await digestHex(encodeSkyBake(receipt.skyKey, fields.sky))
      : null,
  skyTexture: fields.sky?.bounce
    ? await digestHex(new Uint8Array(skyTextureData(fields.sky).buffer))
    : null,
})
