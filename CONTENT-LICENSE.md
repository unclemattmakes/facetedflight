# Content license

*A one-page summary of how code, content and third-party material divide up is in
[NOTICE](NOTICE).*

The **code** in this repository is MIT-licensed ([LICENSE](LICENSE)). This file covers
everything else that is ours: the **game content**. The two are deliberately different:
permissive for the code, reserved for the game.

## Scope

"Game content" means the first-party creative material of *Faceted Flight: 10th Anniversary
Edition*, wherever it lives:

- **Level designs**: `content/levels/*.json` and `content/authored/*.json`. Ring positions and
  rotations, trigger volumes, spawn and respawn transforms, medal thresholds, mode
  configuration, and racing lines.
- **Environments, aircraft and editions**: `content/environments/`, `content/aircraft/`,
  `content/editions/`, `content/palettes/`, `content/overrides/`.
- **Flight tuning**: `src/generated/constants.generated.{ts,json}`, the physics and camera
  numbers the game was built around.
- **Recorded flights**: `content/ghosts/`, the author's own recorded runs.
- **The open content pack**: the first-party models, terrain maps and textures listed in the
  pack's `CONTENT-MANIFEST.json`, each with its license beside it.

## The license: CC BY-NC 4.0

First-party game content is licensed under
[Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/).
In plain terms: remix it, learn from it, build mods and non-commercial forks with it, with
credit, and not for commercial use.

Credit looks like this: "Faceted Flight by Uncle Matt Makes, facetedflight.net, CC BY-NC 4.0",
plus a link to the license, and a note of what you changed.

For a commercial-use grant, open an issue and ask.

**Why level data is content and not code.** A mission's ring layout is design work, not a
program. Under a permissive code license anyone could ship those missions commercially with a
different renderer bolted on. The split is deliberate.

## What this license does not cover

1. **Third-party material.** Some things in this project belong to other people and keep their
   own terms, which may be more permissive or more restrictive than CC BY-NC 4.0:
   three.js (MIT), the Bitter and Roboto Condensed typefaces (SIL OFL 1.1), the CRYSTAL typeface
   (CC BY-SA 4.0), and the six HoliznaCC0 tracks (CC0 1.0, a public-domain dedication). They
   are itemized in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Where the open content pack includes one of them,
   the pack's manifest names its own license on that file's row, and that row governs.

2. **Commercial asset packs.** The live game at facetedflight.net draws some scenery and
   hangar models from commercial asset packs. Their licenses permit use inside a finished game
   and forbid passing the models on as reusable assets. They are not in this repository, they
   are not in the content pack, and nothing here grants any right to them. The author cannot
   sub-license them and this file does not try to. [docs/assets.md](docs/assets.md) explains
   what a clone does without them.

3. **Machine-generated material.** Where any raw machine-generated output is used, it has no
   human author, so no copyright is claimed in it and no license is granted or needed.

4. **The name and identity.** "Faceted Flight", "Uncle Matt Makes", "The Department of Silly
   Stuff", and the game's logo and branding identify this project and its author and are not
   licensed for reuse. Forks and derived games must ship under their own name and branding.
   The title logo mesh in the content pack is covered by CC BY-NC 4.0 like the other models,
   for use unmodified in this game and in non-commercial credit of it; it does not carry the
   name with it.

## If you cannot tell which bucket something is in

Ask. Open an issue. The data in git and the content pack's manifest are the record of what is
licensed how; when they and a casual reading disagree, the manifest wins.
