// src/game/missing-asset.ts: one console warning per asset that would not load (DEV-898).
//
// A clone of the public repository has no bought Asset Store meshes (they ship from the content
// bucket, never from git), and the live game meets the same condition whenever the CDN is down
// or one file is missing. Either way a failed mesh must cost the game THAT mesh and nothing
// more. The loaders that fetch bought art catch `MeshLoadError` per asset, call this once, and
// carry on with what they have.
//
// "Once per asset" is per page session, across passes, environments and the title world, so a
// palette that lists one missing mesh seven times (desert's `bush-grassland-02` is 7 of 13
// entries) still says so a single time.

import { MeshLoadError } from '@/render/load-mesh'

const warned = new Set<string>()

/** True when `err` is a mesh that failed to fetch or parse, i.e. the one failure to degrade on. */
export const isMeshLoadError = (err: unknown): err is MeshLoadError => err instanceof MeshLoadError

/**
 * Warn that `asset` is missing, at most once per session. Returns true the first time, false
 * after, so a test can see which call spoke.
 *
 * `what` names what is now absent ("the scatter prop", "the landmark"), so the line tells a
 * player or a clone owner what they are not seeing rather than only which file.
 */
export const warnMissingAssetOnce = (asset: string, what: string, err: unknown): boolean => {
  if (warned.has(asset)) return false
  warned.add(asset)
  const why = err instanceof Error ? err.message : String(err)
  console.warn(
    `assets: ${what} '${asset}' is not available and is skipped; the rest of the world still loads. ` +
      `(${why}) \`pnpm assets:pull\` fetches the content.`,
  )
  return true
}

/** Test seam: forget which assets have been reported. */
export const resetMissingAssetWarnings = (): void => {
  warned.clear()
}
