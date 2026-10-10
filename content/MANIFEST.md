# Content manifest

Every asset the game loads at runtime, with where it stands. The machine-readable form is
[`tools/assets/required-assets.json`](../tools/assets/required-assets.json), which
`pnpm assets:check` reads; this page is the human summary. Where they disagree, the JSON is
authoritative for paths and the `share` field decides what goes in the open content pack.

None of these files is in git. How they reach a clone, and why, is in
[docs/assets.md](../docs/assets.md).

## Columns

- **class**: `first-party or open` (ours, CC0, or another open license), `purchased` (from a
  commercial asset pack, or derived from one; live game only), `being replaced` (not shipped
  yet, to be remade).
- **pack**: the license the file carries in the open content pack, or `no` if it is not in the
  pack. Everything marked `no` is absent from a clone, and the game runs without it.
- **state**: `ready` (published for the live game), `staged` (exists, not yet published),
  `planned` (does not exist yet).

Terrain is not stored as geometry: the game ships height and color maps, and the terrain
generator in `src/sim/terrain/` builds the facets at load. The 2016 recordings and every level
are data in git (`content/`), not assets. All sound effects are synthesized at runtime and are
not listed.

## Meshs

| path | bytes | class | pack | state |
|---|---:|---|---|---|
| `assets/ships/hoverjet-cockpit.glb` | 119,072 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/jumpseat-body.glb` | 43,140 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/jumpseat-shell.glb` | 9,592 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/jumpseat-strut.glb` | 2,292 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/projector04-faceted.glb` | 37,900 | purchased | no | ready |
| `assets/ships/hoverjet-exterior.glb` | 49,864 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/hoverjet-wings.glb` | 266,732 | purchased | no | ready |
| `assets/hangar/hangar-room.glb` | 828,512 | purchased | no | ready |
| `assets/hangar/commander-chair.glb` | 30,200 | purchased | no | ready |
| `assets/hangar/commander-table.glb` | 28,184 | purchased | no | ready |
| `assets/hangar/hangar-shaft-painted.glb` | 196,192 | purchased | no | ready |
| `assets/hangar/start-deck.glb` | 115,400 | purchased | no | staged |
| `assets/props/checkpoint-ring.glb` | 61,272 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/props/energy-orb.glb` | 7,664 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/props/turn-indicator.glb` | 3,092 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/props/cliff.glb` | 63,500 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/props/rock1.glb` | 35,012 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/ships/pilot.glb` |  | being replaced | no | planned |
| `assets/ships/seat.glb` |  | being replaced | no | planned |
| `assets/props/title-logo.glb` | 70,124 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/props/bush-grassland-02.glb` | 63,424 | purchased | no | ready |
| `assets/props/bush-large-02.glb` | 51,692 | purchased | no | ready |
| `assets/props/cactus-short-02.glb` | 133,184 | purchased | no | ready |
| `assets/props/cactus-tall-01.glb` | 221,092 | purchased | no | ready |
| `assets/props/cactus-tall-02.glb` | 220,432 | purchased | no | ready |
| `assets/props/cactus-tall-03.glb` | 349,412 | purchased | no | ready |
| `assets/props/gl-palmtree-01.glb` | 106,928 | purchased | no | ready |
| `assets/props/gl-palmtree-02.glb` | 31,764 | purchased | no | ready |
| `assets/props/gl-palmtree-03.glb` | 34,052 | purchased | no | ready |
| `assets/props/gl-palmtree-05.glb` | 137,156 | purchased | no | ready |
| `assets/props/gl-plant-01.glb` | 23,056 | purchased | no | ready |
| `assets/props/gl-plant-02.glb` | 27,568 | purchased | no | ready |
| `assets/props/rocagrandelow.glb` | 37,608 | purchased | no | ready |
| `assets/props/spire-b.glb` | 122,952 | purchased | no | ready |
| `assets/props/spire-c.glb` | 105,948 | purchased | no | ready |
| `assets/props/spire-d.glb` | 190,492 | purchased | no | ready |
| `assets/props/tree-palm-01.glb` | 41,044 | purchased | no | ready |
| `assets/props/tree1.glb` | 26,504 | purchased | no | ready |
| `assets/props/tree10.glb` | 92,456 | purchased | no | ready |
| `assets/props/tree2.glb` | 34,820 | purchased | no | ready |
| `assets/props/tree3.glb` | 47,300 | purchased | no | ready |
| `assets/props/tree4.glb` | 48,488 | purchased | no | ready |
| `assets/props/tree5.glb` | 41,152 | purchased | no | ready |
| `assets/props/tree6.glb` | 39,768 | purchased | no | ready |
| `assets/props/tree7.glb` | 43,536 | purchased | no | ready |
| `assets/props/tree8.glb` | 48,484 | purchased | no | ready |
| `assets/props/tree9.glb` | 65,312 | purchased | no | ready |
| `assets/props/tree01-lod0.glb` | 23,796 | purchased | no | ready |
| `assets/props/tree02-lod0.glb` | 13,904 | purchased | no | ready |
| `assets/props/tree03-lod0.glb` | 16,108 | purchased | no | ready |
| `assets/props/tree04-lod0.glb` | 16,152 | purchased | no | ready |
| `assets/props/tree05-lod0.glb` | 14,164 | purchased | no | ready |
| `assets/props/tree06-lod0.glb` | 13,172 | purchased | no | ready |
| `assets/props/tree07-lod0.glb` | 14,924 | purchased | no | ready |
| `assets/props/tree08-lod0.glb` | 16,328 | purchased | no | ready |
| `assets/props/tree09-lod0.glb` | 20,624 | purchased | no | ready |
| `assets/props/tree10-lod0.glb` | 31,656 | purchased | no | ready |
| `assets/life/boat-row.glb` | 68,740 | purchased | no | ready |
| `assets/life/boat-sail.glb` | 85,080 | purchased | no | ready |
| `assets/life/dolphin.glb` | 11,028 | first-party or open | CC-BY-NC-4.0 | ready |

## Textures

| path | bytes | class | pack | state |
|---|---:|---|---|---|
| `assets/hangar/hangar-sky.hdr` | 529,678 | purchased | no | ready |
| `assets/particles/tri-particle.png` | 835 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/simonet/islandgroup-height.png` | 195,537 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/simonet/islandgroup-color.png` | 818,109 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/simonet/water-height.png` | 25,882 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/simonet/water-color.png` | 1,502 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/sky/simonet-gradient.png` |  | first-party or open | no | planned |
| `assets/terrain/kauai/kauai-height.png` | 969,066 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/kauai/kauai-color.png` | 6,751,772 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/desert/canyon_04-height.png` | 540,877 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/desert/canyon_04-color.png` | 2,461,801 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/alpine/forest_02-height.png` | 590,267 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/terrain/alpine/forest_02-color.png` | 2,423,588 | first-party or open | CC-BY-NC-4.0 | ready |
| `assets/share/share-still.png` | 260,100 | first-party or open | no | staged |
| `assets/brand/uncle-matt-circle.webp` | 38,504 | first-party or open | no | ready |

## Fonts

| path | bytes | class | pack | state |
|---|---:|---|---|---|
| `assets/fonts/crystal-regular.ttf` | 13,252 | first-party or open | CC-BY-SA-4.0 | ready |

## Notices

| path | bytes | class | pack | state |
|---|---:|---|---|---|
| `assets/fonts/crystal-regular-license.txt` | 865 | first-party or open | CC-BY-SA-4.0 | ready |

## Audios

| path | bytes | class | pack | state |
|---|---:|---|---|---|
| `assets/audio/music/` |  | first-party or open | no | planned |
| `assets/audio/music/mutant-club.opus` | 2,393,566 | first-party or open | CC0-1.0 | ready |
| `assets/audio/music/lost-in-the-jungle.opus` | 2,705,992 | first-party or open | CC0-1.0 | ready |
| `assets/audio/music/50-over-the-speed-limit.opus` | 2,570,999 | first-party or open | CC0-1.0 | ready |
| `assets/audio/music/day-dreams.opus` | 3,557,265 | first-party or open | CC0-1.0 | ready |
| `assets/audio/music/retro-synths.opus` | 4,453,575 | first-party or open | CC0-1.0 | ready |
| `assets/audio/music/drama.opus` | 3,929,597 | first-party or open | CC0-1.0 | ready |

## Totals

Derive these rather than trusting a copy: count the rows with a `share` other than `none` in
`tools/assets/required-assets.json`.

At the time of writing, 31 files (33.3 MB) are in the open pack, and 47 files (4.5 MB) are purchased and live-game only.
