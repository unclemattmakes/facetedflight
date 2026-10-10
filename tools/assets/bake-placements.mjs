// tools/assets/bake-placements.mjs — run the scatter once, keep the answer.
//
// Writes a `placements` blob onto every `scatter[]` entry in
// `content/environments/*.json` and drops that entry's `placementMapAsset`, so
// the three World Machine density maps stop being something the browser has to
// fetch — and therefore stop being something that has to be PUBLISHED.
//
// Matt, 2026-09-13: *"the maps themselves are content used to generate other
// data — not read at runtime, right? ... they should definitely be stored
// somewhere (and have been) - but saved as content, not served as game assets"*.
// For the ten terrain height and colour maps that is not true — the terrain
// generates from them at runtime (D28). For these three it is, and the whole
// reason is that the scatter is seeded and pure.
//
// ── Why this needs no height map, and why it DOES need the terrain ────────
//
// `scatterProps` consumes the PRNG in exactly one place per texel — the
// acceptance test — and then three more times for yaw, palette and scale.
// `heightMap.sample()` does not touch it. So what is DRAWN for an accepted texel
// depends on the density map, `probabilityScale` and the seed, and on nothing
// else; the height map is still a stub here and still cannot affect a byte.
//
// **`terrainSize` used to be a stub too, and since DEV-100 it must not be.** The
// spawn clearings are circles in the terrain's own metres and an accepted texel
// is tested against them at `tx * terrainSize / width`, so a nominal extent would
// clear the wrong ground — silently, and only near the origin would it look
// nearly right. `terrainHeight` and `chunkSize` remain unread by anything this
// tool writes (`y` and `chunk` are derived at load), and they are passed as the
// real values anyway rather than left as stubs that would have to be argued about
// again the next time something moves.
//
// It follows that re-rolling a seed needs the PNGs, the terrain sheet and the
// thirteen level JSONs — but still not `$FF2_LEGACY`. After the maps are deleted
// it needs `extract-terrain-maps.mjs --all` first, which does. That is the
// accepted cost of not publishing them.
//
// ── The clearings, and why they are a UNION per environment ───────────────
//
// A clearing belongs to a MISSION (its spawn) and a blob belongs to an
// ENVIRONMENT, and four missions share alpine. The blob therefore carries the
// union of every clearing of every mission on that environment, which is a
// decision with two reasons:
//
//   * **One environment, one forest.** `loadEnvironmentProps` is keyed and cached
//     per environment and a course switch inside one does not re-roll it, so a
//     per-mission filter would either be stale after a switch or force a re-roll
//     on the pause plate. The union is a property of the environment and cannot
//     go stale.
//   * **It costs nothing.** Four circles of ~52 m on a 4,096 m map is 0.4 % of
//     alpine's trees and 0.08 % of Simonet's. Two of alpine's four spawns are
//     70.5 m apart and their circles overlap, which is why the union is smaller
//     than the sum of its parts.
//
// ── The seed is not a free choice ─────────────────────────────────────────
//
// `load-props.ts` uses `(seed ?? 1) + entry.index * 7919`, and the offset is
// load-bearing rather than decorative: alpine's two generators read the SAME
// density map, so an equal seed makes both passes accept identical texels and
// stack a 6..20 m tree inside every 1.4..5.5 m one. This tool reproduces that
// expression and records the result per entry, so the number is stated rather
// than implied.
//
// Usage:
//   node tools/assets/bake-placements.mjs            # bake and write
//   node tools/assets/bake-placements.mjs --check    # fail if a blob would change

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createSsrServer } from '../lib/ssr.mjs'
import { decodePng } from '../terrain/png.mjs'
import { densityPathFor } from './density-maps.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_DIR = path.join(REPO_ROOT, 'content', 'environments')
const LEVEL_DIR = path.join(REPO_ROOT, 'content', 'levels')

const check = process.argv.includes('--check')
const die = (msg) => {
  console.error(`bake-placements: ${msg}`)
  process.exit(1)
}

/** The runtime's own expression. Keep these two in step or the bake is fiction. */
const seedFor = (index) => 1 + index * 7919

/**
 * Environments with NO mission, and therefore no spawn to clear. DEV-155.
 *
 * Named one at a time with a reason, because the check this bypasses is a real
 * one: an environment with no missions is normally a level that lost its
 * `environment` field, and that would silently bake a forest over a launch pad.
 * The value is the reason and it is printed, so an entry cannot sit here
 * unexplained.
 */
const MISSIONLESS = {
  menu: 'the TITLE SCREEN valley — no mission spawns on it, so there is nothing to clear',
}

/**
 * A height map that reads mid-grey everywhere.
 *
 * Deliberately a constant: if this tool's output ever depended on it, that
 * would be the bug, and a constant makes the dependency impossible rather than
 * merely unlikely.
 */
const STUB_HEIGHT = {
  width: 2,
  height: 2,
  sample: (_u, _v, out) => {
    out.r = 0.5
    out.g = 0.5
    out.b = 0.5
  },
}

/** Every shipped mission, by environment. Read once; the clearings come from here. */
const levelsByEnvironment = () => {
  const out = new Map()
  const files = fs
    .readdirSync(LEVEL_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
  if (files.length === 0) die(`no level JSON under ${LEVEL_DIR}`)
  for (const f of files) {
    const lv = JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8'))
    if (!out.has(lv.environment)) out.set(lv.environment, [])
    out.get(lv.environment).push(lv)
  }
  return out
}

const server = await createSsrServer({ logLevel: 'error' })

try {
  const { scatterProps } = await server.ssrLoadModule('/src/sim/props/scatter.ts')
  const { encodePlacements, encodeBase64, PLACEMENT_STRIDE } = await server.ssrLoadModule(
    '/src/sim/props/placements.ts',
  )
  const { isPowerOfTwo, npotNearest } = await server.ssrLoadModule(
    '/src/sim/terrain/image-sampler.ts',
  )
  // DEV-100. `terrainOriginSim` rather than a second copy of
  // `worldOffset + local + envRoot`: that sum has been wrong twice (DEV-042,
  // DEV-047) and kauai is 2.2 km out under the naive reading.
  const { terrainOriginSim } = await server.ssrLoadModule('/src/game/mission-shape.ts')
  const { environmentTerrains, terrainParams } = await server.ssrLoadModule(
    '/src/game/terrain/load-terrain.ts',
  )
  const { gameClearingRadius } = await server.ssrLoadModule('/src/sim/props/clearing.ts')

  const byEnvironment = levelsByEnvironment()
  const allLevels = [...byEnvironment.values()].flat()

  // ── the radius, once, for the whole game ────────────────────────────────
  //
  // The widest launch-deck footprint any shipped mission materialises. See
  // `src/sim/props/clearing.ts` for why it is one number and why it is the max.
  //
  // DEV-109: only missions that LAUNCH FROM A DECK may size it. `footprintRadius`
  // measures the deck's corners about `spawn.pos`, so it answers two questions at
  // once — *how big is 2016's launch deck* and *where is the clearing centred* —
  // and those coincided only while every spawn sat on its own deck.
  // `int_01_jumpSeat` breaks that: its scene materialises the HOVERJET DECOY's
  // deck, and once its spawn moved 2.78 km to 2016's own jumpSeat marker the
  // reading became the distance to somebody else's rig. It sized the whole game's
  // clearing at 2,800 m and cleared 95 % of every prop in it.
  const launchesFromADeck = allLevels.filter((lv) => lv.spawn.launchKind === 'elevator')
  const clearingRadius = gameClearingRadius(launchesFromADeck.map((lv) => lv.spawn))
  if (!(clearingRadius > 0)) {
    die(
      'no shipped mission materialises a `spawn.startGrid`, so there is no launch\n' +
        '  footprint to size the clearing from. That is a level-extraction\n' +
        '  regression, not a reason to pick a number — see DEV-100.',
    )
  }
  const withDeck = launchesFromADeck.filter((lv) => (lv.spawn.startGrid?.slabs ?? []).length > 0)
  console.log(
    `  clearing radius ${clearingRadius.toFixed(3)} m ` +
      `(widest of ${withDeck.length} materialised launch decks)`,
  )

  const files = fs
    .readdirSync(ENV_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
  if (files.length === 0) die(`no environment JSON under ${ENV_DIR}`)

  let changed = 0
  let totalPlacements = 0
  let totalBytes = 0
  let mapBytes = 0
  const seenMaps = new Set()

  let totalCleared = 0

  for (const file of files) {
    const full = path.join(ENV_DIR, file)
    const env = JSON.parse(fs.readFileSync(full, 'utf8'))
    const before = JSON.stringify(env)

    // ── this environment's real extent, and its missions' clearings ────────
    //
    // The extent is no longer nominal (see the header). The clearings are every
    // mission of this environment, converted from the level JSON's THREE-space
    // spawn into the terrain's own mesh space, which is the frame `positions`
    // uses: sim z is `-three z`, and the terrain's origin is the composed
    // `worldOffset + local + envRoot`.
    const land = environmentTerrains(env.id).land
    const extent = terrainParams(land)
    const terrain = {
      terrainSize: extent.terrainSize,
      terrainHeight: extent.terrainHeight,
      chunkSize: extent.chunkSize,
    }
    const missions = byEnvironment.get(env.id) ?? []
    if (missions.length === 0 && !MISSIONLESS[env.id]) {
      die(
        `${file}: no level JSON names environment "${env.id}", so the scatter has ` +
          'no spawn to clear. Either a level lost its `environment` field or this ' +
          'environment is unused — say which before baking it.',
      )
    }
    const clearings = missions.map((lv) => {
      const origin = terrainOriginSim(land, lv.worldOffset).position
      return {
        mission: lv.id,
        x: lv.spawn.pos[0] - origin[0],
        z: -lv.spawn.pos[2] - origin[2],
        radius: clearingRadius,
      }
    })

    for (const entry of env.scatter ?? []) {
      // `placementMap` — the legacy source path — is both the key and the
      // receipt, and it STAYS in the JSON. What leaves is `placementMapAsset`,
      // the bucket path, because there is no longer a bucket copy to point at.
      const rel = entry.placementMap
      if (!rel) die(`${file}: scatter[${entry.index}] has no placementMap`)

      const png = densityPathFor(rel)
      if (!png) {
        die(`${file}: scatter[${entry.index}] names a map absent from DENSITY_MAPS:\n  ${rel}`)
      }
      if (!fs.existsSync(png)) {
        die(
          `${file}: scatter[${entry.index}] needs ${path.relative(REPO_ROOT, png)}, not on disk.\n` +
            '  Density maps are gitignored and deliberately unpublished (O13 / C-6).\n' +
            '  Regenerate: `node tools/assets/extract-terrain-maps.mjs --all` ($FF2_LEGACY).',
        )
      }

      if (!seenMaps.has(png)) {
        seenMaps.add(png)
        mapBytes += fs.statSync(png).size
      }

      const img = decodePng(png)

      // The texel indices are relative to the map AFTER Unity's nPOT rescale,
      // because that is the grid `scatterProps` walks. Record the post-rescale
      // size, not the file's — they differ on every one of these three.
      const mapWidth =
        isPowerOfTwo(img.width) && isPowerOfTwo(img.height) ? img.width : npotNearest(img.width)
      const mapHeight =
        isPowerOfTwo(img.width) && isPowerOfTwo(img.height) ? img.height : npotNearest(img.height)

      const seed = seedFor(entry.index)
      const params = {
        probabilityScale: entry.probabilityScale,
        heightOffset: entry.heightOffset,
        scaleMin: entry.scaleMin,
        scaleMax: entry.scaleMax,
        paletteSize: entry.palette.length,
        seed,
      }

      // Both are run so the COST of the clearing is measured rather than
      // asserted, and so `cleared` in the receipt is a count and not a claim.
      // The clearing is rejected after the four draws, so `kept` is a
      // subsequence of `all` and no surviving placement moved.
      const all = scatterProps(img, STUB_HEIGHT, terrain, params)
      const scattered = scatterProps(img, STUB_HEIGHT, terrain, params, clearings)
      const cleared = all.count - scattered.count
      totalCleared += cleared
      const bytes = encodePlacements(scattered, params)

      entry.placements = {
        count: scattered.count,
        clearedBySpawnClearing: cleared,
        mapWidth,
        mapHeight,
        seed,
        stride: PLACEMENT_STRIDE,
        data: encodeBase64(bytes),
      }
      delete entry.placementMapAsset
      // Written by an early revision of this tool and read by nothing. Deleted
      // here rather than by hand so the bake is self-healing: a stale field
      // that names a deleted bucket object is how someone loses an afternoon
      // deciding whether the deletion actually worked.
      delete entry._bakedFrom

      totalPlacements += scattered.count
      totalBytes += bytes.length
    }

    // ── the receipt ────────────────────────────────────────────────────────
    //
    // The radius and the centres in the JSON rather than only in this tool, so a
    // reviewer can see what was cleared without running anything, and so
    // `tests/unit/spawn-clearing.test.ts` can sweep the committed blobs against
    // a number it did not compute itself.
    const spawnClearing = {
      radius: clearingRadius,
      source:
        'The widest launch-deck footprint in the game: the largest horizontal ' +
        'distance from a mission spawn to any corner of any `spawn.startGrid` box. ' +
        "Those boxes are Unity built-in cubes inside 2016's own " +
        'PlayerStart_ElevatorShaft_Photon_02.prefab (see src/render/start-grid.ts), ' +
        'and the six scenes that materialise the deck agree to 13 cm.',
      note:
        'DEV-100. A DEVIATION, not a repair: 2016 cleared nothing here — its ' +
        'density maps read 1.0 at six of the thirteen spawns and its own baked ' +
        "draw put a tree 8.86 m from rookie_01_hoverJet's release. Applied in " +
        'src/sim/props/scatter.ts AFTER the four draws, so every surviving ' +
        'placement is bit-identical and the clearing only subtracts. Cylinders, ' +
        'unbounded in y, because a platform rises straight up and the thing being ' +
        'avoided is occlusion rather than collision.' +
        (MISSIONLESS[env.id] ? ` NOTHING WAS CLEARED HERE: ${MISSIONLESS[env.id]} (DEV-155).` : ''),
      missions: clearings.map((c) => ({
        id: c.mission,
        // Terrain-local mesh space, the frame the placements are in.
        x: c.x,
        z: c.z,
      })),
    }
    // Inserted BEFORE `scatter` rather than appended, because these files are
    // read by people and the clearing is a premise of the blob under it.
    delete env.spawnClearing
    const ordered = {}
    for (const [k, v] of Object.entries(env)) {
      if (k === 'scatter') ordered.spawnClearing = spawnClearing
      ordered[k] = v
    }
    if (!('spawnClearing' in ordered)) ordered.spawnClearing = spawnClearing

    const text = `${JSON.stringify(ordered, null, 2)}\n`
    if (before !== JSON.stringify(ordered)) {
      changed++
      if (!check) fs.writeFileSync(full, text)
    }
    const label = `${env.id}`.padEnd(8)
    const counts = (env.scatter ?? []).map((s) => s.placements.count).join(' + ')
    const cut = (env.scatter ?? []).reduce(
      (a, s) => a + (s.placements.clearedBySpawnClearing ?? 0),
      0,
    )
    console.log(
      `  ${label} ${(env.scatter ?? []).length} generator(s)  ${counts}` +
        `   -${cut} cleared at ${clearings.length} spawn(s)` +
        (MISSIONLESS[env.id] ? ` — ${MISSIONLESS[env.id]}` : ''),
    )
  }

  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`
  console.log(
    `\nbake-placements: ${totalPlacements.toLocaleString()} placements, ` +
      `${mb(totalBytes)} raw / ${mb(Math.ceil(totalBytes / 3) * 4)} base64, ` +
      `against ${mb(mapBytes)} of density map across ${seenMaps.size} file(s).`,
  )
  console.log(
    `bake-placements: ${totalCleared} placement(s) cleared at the spawns ` +
      `(DEV-100), ${((totalCleared / (totalPlacements + totalCleared)) * 100).toFixed(2)} % of the draw.`,
  )

  if (check && changed > 0) {
    die(`${changed} environment file(s) would change. Run without --check and commit the result.`)
  }
} finally {
  await server.close()
}
