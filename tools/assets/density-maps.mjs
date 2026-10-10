// tools/assets/density-maps.mjs — where the World Machine density maps live,
// declared once.
//
// Two tools need this and they must not disagree: `extract-terrain-maps.mjs`
// WRITES these files and `bake-placements.mjs` READS them. A mapping copied
// into both is a mapping that drifts, and this repo has paid for that pattern
// more than once — `$FF2_LEGACY` was in 66 files before it was in one.
//
// ── Why they are not under `public/` ──────────────────────────────────────
//
// `pnpm assets:push` is `rclone copy public/assets → bucket`. Anything in that
// tree is one routine command away from being published, with no intent
// required and nothing reporting it afterwards — `rclone copy` never deletes,
// so a mistake is permanent until someone removes the object by hand.
//
// These three maps carry open question **O13 / C-6** (which World Machine
// edition produced them; the free tier is non-commercial), and since the
// scatter was baked on 2026-09-13 nothing fetches them at runtime. So they sit
// outside the publishable tree, which makes publishing them structurally
// impossible rather than a thing to remember. Same convention as
// `tools/terrain/.oracle`: local, gitignored, real.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Local-only, gitignored, and deliberately not inside `public/`. */
export const DENSITY_ROOT = path.join(HERE, '.density')

/**
 * Legacy source path → the local filename it is written to.
 *
 * Keyed by SOURCE rather than by environment, because kauai and simonet share
 * one map: both scatter `island_group_02/islands_02_trees.png` with identical
 * parameters, so one file serves both rather than being written twice.
 */
export const DENSITY_MAPS = {
  'Assets/Faceted Flight/World Machine Content/forest_02/forest_02_trees.tga':
    'alpine/forest_02-trees.png',
  'Assets/Faceted Flight/World Machine Content/canyon_04/canyon_04_trees.tga':
    'desert/canyon_04-trees.png',
  'Assets/Faceted Flight/World Machine Content/island_group_02/islands_02_trees.png':
    'simonet/islands_02-trees.png',
}

/** Absolute path to the density map a `scatter[]` entry's `placementMap` names. */
export const densityPathFor = (placementMap) => {
  const rel = DENSITY_MAPS[placementMap]
  return rel ? path.join(DENSITY_ROOT, rel) : null
}
