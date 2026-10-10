# Assets and the content pack

The game's code and data are in git. Its binary content (3D models, terrain maps, music, one
font) is not. This page explains where that content comes from when you clone the repository,
what the open content pack holds, and what the game does without the parts that cannot be shared.

## Why binaries are not in git

Two separate reasons, and either one would be enough:

1. **Binaries do not belong in git history.** They bloat every clone forever and cannot be
   removed afterwards.
2. **Some of the live game's models are not ours to hand out.** The original game was built on a
   number of commercial Unity Asset Store packs. Their licenses let a developer use the models
   inside a finished game, including a game on another engine, and do not let anyone pass the
   models on to someone else to reuse as assets. A public repository, or a public download, is
   exactly that. So purchased models, and models made by modifying them, may appear in the live
   game and nowhere else.

`.gitignore` ignores model, image, audio and archive extensions wholesale, and the hook
`.githooks/check-denylist.mjs` refuses them on commit (`node .githooks/check-denylist.mjs
--list-rules` prints the rules and the reason for each). The same check runs in CI over the whole
tree and its history.

A screenshot of the game is fine whatever is in frame; a model file is not.

## How the game finds its content

Every asset URL is built in one place, `src/content/asset-url.ts`, from the environment variable
`VITE_ASSET_BASE_URL`. Models, terrain maps, music and the cockpit font are fetched from that base
at runtime, as `<base>/assets/...`.

- The default in `.env.example` is `/`, which means "serve from Vite's `public/` folder". That is
  where `pnpm content:pull` unpacks the content pack, so a fresh clone works without editing
  anything.
- **Unset or blank is a fatal error at boot** that names the variable, rather than a silent
  fallback to a local folder that may not exist or may be stale.
- To host the content yourself (a static bucket, another domain), put the files there in the same
  layout and point the variable at it. The host should send permissive CORS headers
  (`Access-Control-Allow-Origin`) if it is on a different origin from the game.

## The open content pack

`pnpm content:pull` downloads the pack that matches the version in `package.json` from this
repository's Releases page, verifies every file's SHA-256 against the pack's
`CONTENT-MANIFEST.json`, and unpacks to `public/assets/`.

What is in it, and under what license:

| Contents | License |
|---|---|
| The HoverJet cockpit and exterior, the JumpSeat body, shell and strut, the checkpoint ring, turn indicator, energy orb, the title logo, two rock and cliff models, a small particle texture | CC BY-NC 4.0 (first-party) |
| Terrain height maps and color maps for the four islands and the water | CC BY-NC 4.0 (first-party) |
| Six music tracks by HoliznaCC0 (Opus) | CC0 1.0 |
| The CRYSTAL font, unmodified, with its license notice | CC BY-SA 4.0 |

`CONTENT-MANIFEST.json` records, for each file, its path, size, hash, SPDX license identifier,
author, title, a one-line source description, and whether it was modified. The pack also carries
the full license texts and a short `README.txt` with the attribution line. The Bitter and Roboto
Condensed fonts are not in the pack; `pnpm install` fetches them from npm under the SIL Open Font
License.

The pack is a positive list: a file is in it only if its row in
`tools/assets/required-assets.json` opts in with a license, and the pack builder
(`tools/assets/build-content-pack.mjs`) refuses any file marked as purchased or as a replacement
pending. The pack is attached to a release rather than committed, because the denylist blocks
archives in git, correctly.

## The asset manifest

`tools/assets/required-assets.json` is the machine-readable list of every asset the live game
loads: its path, kind, size, SHA-256, the license class, and a note on where it came from.
`tools/assets/check-assets-present.mjs` (`pnpm assets:check`) lints that file and then verifies
the **bytes** of whatever is on disk, not just that files exist. That distinction matters:
a file once replaced another of exactly the same size and different content, and a presence or
size check could not see it. The license class is also checked, and an asset classed as purchased
can never be marked as published to the open pack.

`pnpm assets:push` and the converters under `tools/assets/` (FBX to glTF, hangar and prop
converters, the placement baker) are for the maintainer who has the original sources and the
production bucket. You do not need them to run or modify the game.

## Running without the commercial packs

The live game's purchased models are all absent from a clone: most of the tree, palm, cactus
and spire scatter, several landmark rocks, the hangar room, the commander chair and
table, the start deck, two boats, and the wing parts on the HoverJet and
the cones on the JumpSeat.

The game does not have a special mode for this. A model that fails to load is a condition the
live game can meet anyway (a CDN outage, say), so the loaders treat a missing model as absent and
carry on:

- Scatter props and landmarks are skipped one at a time, and the remaining props still draw.
  A landmark that is not drawn does not collide either, because an invisible wall is worse than a
  missing rock.
- The ship flies without its wing parts.
- The hangar falls back to what the first-party assets can draw.
- Boats and similar decoration are left out.

Terrain, the sea, the sky, clouds, rings, gates, the HoverJet and JumpSeat, the cockpit, the HUD,
the menus, the music and every game rule are unaffected, so every mission is flyable and the
scoring is identical. What you see is a barer world than the live site's.

If you build your own replacement models, drop them in at the same paths and update the manifest.
Anything you make yourself is yours to license as you like.

## Build channels and assets

A local build is the *preview* channel unless `FF2_CHANNEL=release`, which shows a few extra
features (aircraft variants and the glider) that the live site hides. That only changes which
features are on; it does not change where assets come from.
