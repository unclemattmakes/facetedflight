# Third-party notices and credits

*Faceted Flight: 10th Anniversary Edition*: the people who made it, the third-party material it
uses with that material's license, and the commercial packs the live game uses that this
repository does not contain.

[NOTICE](NOTICE) explains how code, content and third-party material divide up. This file is the
itemized list for the third column. Where a license asks for credit to be kept with the copy,
this file is part of keeping it.

---

## 1. Third-party material that is in this repository, its install, or the content pack

| Item | Version | License | Where it comes from |
|---|---|---|---|
| **three.js**, © 2010-2026 three.js authors | `three` `0.185.1`, pinned exact | **MIT** | <https://threejs.org/>, installed by `pnpm install`, bundled into the game |
| **Bitter** (typeface), Bold 700, latin subset, © 2011 The Bitter Project Authors (<https://github.com/solmatas/BitterPro>) | `@fontsource/bitter` `5.2.10`, pinned exact, unmodified | **SIL Open Font License 1.1** (<https://openfontlicense.org>) | installed by `pnpm install`, bundled by Vite; drawn on the developer splash |
| **Roboto Condensed** (typeface), Medium 500 and Bold 700, latin subset, © 2011 Google Inc. | `@fontsource/roboto-condensed` `5.3.0`, pinned exact, unmodified | **SIL Open Font License 1.1** (<https://openfontlicense.org>) | installed by `pnpm install`. The UI no longer loads it as a font; its Bold outlines are baked into the share card's wordmark |
| **CRYSTAL** (typeface), © 2014 Felipe Munoz, Regular, version 1.000 | unmodified | **CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>) | `assets/fonts/crystal-regular.ttf` in the content pack, with `assets/fonts/crystal-regular-license.txt` beside it. The cockpit readout's face, and the UI's one label and number face |
| **HoliznaCC0**, six music tracks from the Retro Wave collections | Opus files, transcoded from the artist's own releases, not edited | **CC0 1.0** (<https://creativecommons.org/publicdomain/zero/1.0/>) | `assets/audio/music/*.opus` in the content pack |

**CRYSTAL** is the typeface the 2016 game drew its HUD in, and the file here is the one that game
shipped. The license asks for attribution kept with the copy (author, title, license, link, and a
note that it is unmodified), which is this row and the notice file beside the font in the pack.
Share-alike binds a modified copy of the font, not the game that draws with it. So the file must
stay unmodified: no subsetting, no re-hinting, no format conversion. If it ever changes, the
changed file is itself CC BY-SA 4.0.

**The tracks** are, in the order the game lists them: Mutant Club, Lost In The Jungle, 50 Over
The Speed Limit, Day Dreams, Retro Synths and Drama, by HoliznaCC0 (<https://freemusicarchive.org/music/holiznacc0/>,
<https://opengameart.org/content/retro-wave-collection>). CC0 is a public-domain dedication and
asks for nothing, so this credit is a courtesy, labeled as one. Each file also carries its title,
artist, album and license in its own tags.

**All sound effects are synthesized at runtime** from oscillators and noise
(`src/audio/`). There are no sampled sound files, so there is nothing to credit.

<details>
<summary>three.js MIT license text</summary>

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

---

## 2. People

**Faceted Flight (2016)**, as its credits roll in the game:

| Role | Who |
|---|---|
| Concept, development and art | Matt Scott |
| Executive producer | Joe Harkins |
| Additional engineering | Jean Simonet |
| Concept art | Alice Duke, Jordan Saia |
| Additional art | Jonah Lobe, Quantum Theory Entertainment |

The 2016 roll also has a long special-thanks page. The game's credits screen (Options, Credits)
carries it in full, along with this edition's version number.

**The 10th Anniversary Edition** is a rebuild by Uncle Matt Makes. All code, level data and
first-party content in this repository are © 2026 Uncle Matt Makes, under the split described
in [NOTICE](NOTICE).

*Faceted Flight* shipped on Steam in 2016 (app 355230) for the first generation of VR
headsets. This edition exists because that one did.

---

## 3. First-party

Everything else in this repository and in the content pack is by Uncle Matt Makes: the engine in
`src/`, the tools and tests, the 13 mission designs, the flight and camera tuning, the recorded
flights, the HoverJet, JumpSeat and glider models, the checkpoint ring and turn indicator, and
the terrain maps for the four islands (generated with World Machine). Licenses: code under MIT,
content under CC BY-NC 4.0 ([CONTENT-LICENSE.md](CONTENT-LICENSE.md)).

---

## 4. Commercial packs used in the live game only

The game at <https://facetedflight.net/> draws some of its scenery, its hangar and a few ship
parts from models bought from the Unity Asset Store and used under that store's license, which
allows use inside a finished game. **None of these models is in this repository or in the
content pack**, and the license does not allow handing them on as reusable assets. A clone of
this repository runs without them (see [docs/assets.md](docs/assets.md)).

They are credited here because the game uses them:

- **Polyworld** (Woodland and Ancient East) by Quantum Theory Entertainment: the rock spires,
  and the flooring the start deck is built from.
- **Geometric Landscape: Tropic Island**: palm trees, plants and the boats.
- **AxeyWorks Low Poly**: a palm tree and two bushes.
- **Tree Pack**: tree models for the forests.
- **The hangar room** and its painted shaft, the commander chair and table, and the HoverJet
  wing and JumpSeat cone parts come from commercial packs and from the author's own kitbashes
  of purchased geometry. They are treated exactly like the packs above.

If you are a publisher named here and would like the credit worded differently, open an issue.

---

## 5. Development tooling

Installed by `pnpm install`, never shipped to a player, each under its own license:
TypeScript, Vite, Vitest, Playwright, Biome, `@types/three`, `@types/node`,
`@vitejs/plugin-basic-ssl`, `@vitest/coverage-v8`, `lil-gui`.

---

## Keeping this file true

1. A new runtime dependency gets a row in section 1, with its license, before it merges.
2. A new asset in the content pack gets a row in the pack's `CONTENT-MANIFEST.json` and, if its
   license is not CC BY-NC 4.0, a row here.
3. New audio of any kind gets a row here.
