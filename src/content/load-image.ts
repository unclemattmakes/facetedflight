// src/content/load-image.ts — fetch an image and hand back raw 8-bit samples.
//
// The counterpart to `tools/terrain/png.mjs` on the browser side. Both produce
// the same `ImageData8` struct, and both hand it to the SAME sampler in
// `src/sim/terrain/image-sampler.ts`, so the terrain the game renders is the
// terrain the oracle test verified against the 2016 bake.
//
// ── Two ways a browser will quietly change your pixels ────────────────────
//
// A heightmap is data, not a picture, and the platform does not know that.
//
//  1. **Colour management.** `createImageBitmap` will honour an embedded ICC
//     profile and convert the samples. World Machine's output carries one. A
//     converted heightmap is wrong terrain — subtly, plausibly, everywhere. So:
//     `colorSpaceConversion: 'none'`, which says "give me the bytes".
//  2. **Premultiplied alpha.** The default is `'default'`, i.e. up to the
//     implementation. These maps are opaque so it would not bite today, but the
//     next map might have an alpha channel, so pin it: `'none'`.
//
// `willReadFrequently` is set because the very next thing that happens is one
// big `getImageData` — it asks for a software-backed canvas and avoids a
// GPU readback that some drivers make slow.
//
// ── Why not just upload the PNG as a texture ──────────────────────────────
//
// Because the terrain generator runs in the SIM layer, which has no WebGL, no
// DOM, and no three.js (rule 4). It needs numbers in an array. Uploading the
// map to the GPU would also mean sampling it in a shader, and then the visual
// mesh and the collision heightfield could disagree — which is precisely what
// the deterministic generator exists to prevent.

import type { ImageData8 } from '@/sim/terrain/image-sampler'

export class ImageLoadError extends Error {
  constructor(url: string, cause: string) {
    super(`Failed to load image ${url}: ${cause}`)
    this.name = 'ImageLoadError'
  }
}

/**
 * `OffscreenCanvas` where available, a detached `<canvas>` otherwise.
 *
 * Workers only have the former, and terrain generation is headed for a Worker.
 * Safari shipped `OffscreenCanvas` in 16.4; older iOS falls back here rather
 * than failing, since the flat build should still boot on a phone.
 */
const makeCanvas = (width: number, height: number): OffscreenCanvas | HTMLCanvasElement => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Decode an already-fetched blob to raw samples. Always 4 channels (RGBA). */
export const decodeImageBlob = async (blob: Blob, label: string): Promise<ImageData8> => {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
  } catch (err) {
    throw new ImageLoadError(label, `decode failed (${(err as Error).message})`)
  }

  try {
    const canvas = makeCanvas(bitmap.width, bitmap.height)
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true,
      colorSpace: 'srgb',
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) throw new ImageLoadError(label, 'no 2d context')

    ctx.drawImage(bitmap as CanvasImageSource, 0, 0)
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' })

    return {
      width: pixels.width,
      height: pixels.height,
      // getImageData is always RGBA, whatever the source colour type was. The
      // sampler handles any channel count, so nothing needs converting.
      channels: 4,
      data: pixels.data,
    }
  } finally {
    bitmap.close()
  }
}

/**
 * Fetch and decode one image to raw samples.
 *
 * `url` is already resolved — call `assetUrl()` first. Keeping this function
 * ignorant of the bucket means the same code path serves a local `public/`
 * tree, the R2 custom domain, and a test fixture.
 */
export const loadImageData = async (url: string, signal?: AbortSignal): Promise<ImageData8> => {
  // `exactOptionalPropertyTypes` is on, so an explicit `signal: undefined` is
  // not the same as omitting it. Build the init object conditionally.
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) {
    throw new ImageLoadError(url, `HTTP ${response.status} ${response.statusText}`)
  }
  return decodeImageBlob(await response.blob(), url)
}
