# Faceted Flight: 10th Anniversary Edition

Arcade stunt flight, in a headset and in a browser.

*[Faceted Flight](https://store.steampowered.com/app/355230/)* shipped on Steam in 2016, built in
Unity for the first generation of VR headsets. This is the whole game rebuilt for the open web on
three.js and WebXR, ten years on, plus more: the same flight model, the same courses, the same
terrain generator, running in a browser tab. **Play it at [facetedflight.net](https://facetedflight.net/).**

This repository is its source: the engine, the tests, the tools that produced its data, the
servers behind its leaderboard and multiplayer rooms, and documentation of how it all works.

## What is in the game

- **All thirteen missions from 2016**, in the modes they shipped in, across four environments:
  the Simonet Islands, an alpine valley, a desert canyon and Kauai.
- **Both vehicles**: the HoverJet and the JumpSeat, which is a different machine rather than a
  variant of the first.
- **All three modes**: Ring Attack, Target Practice and Free Flight, reached through the hangar's
  holotables.
- **AI opponents** that fly the same racing line you do, in place of 2016's recorded ghosts
  (the recordings are still in the repository and still play behind `?opponents=ghosts`).
- **Flight School**, **Quick Race**, and a hangar where you pick your aircraft and course.
- **Multiplayer rooms**: host a race, share its link or its short code, race your friends live,
  and let anyone watch.
- **A course editor**: lay out a ring course over an island on a desktop, fly it, and share it as
  a link or a `.ffcourse` file.
- **Faceted Flight TV**: watch live races, or an exhibition race when none is running.
- **Two looks**: Classic is 2016's in-mission look; Anniversary is the updated one. The menus and
  the rules are the Anniversary edition's either way.
- **Comfort options** for headset play: a vignette, a world-locked horizon, quality presets.
- **Input** from a gamepad, keyboard and mouse, a touch screen, or VR controllers.

Sound effects are synthesized in the browser, and the soundtrack is six CC0 synthwave tracks.

## Run it

You need Node 22 or newer, and [pnpm](https://pnpm.io/) 10.

```sh
git clone https://github.com/unclemattmakes/facetedflight.git
cd facetedflight
pnpm install
pnpm content:pull     # fetch the open content pack (see below)
pnpm dev
```

`pnpm dev` serves HTTPS on all interfaces, because WebXR needs a secure context. Vite prints a
`Network:` URL. To use a headset on your network, open that URL in the headset's browser and
accept the self-signed certificate once. On a desktop, open the `Local:` URL.

Copy `.env.example` to `.env` if you want to change anything. The default content location works
with the content pack out of the box.

### The content pack

The game loads its models, terrain maps, music and cockpit font at runtime, and none of those
binary files are stored in git. `pnpm content:pull` downloads the **open content pack** from this
repository's Releases page, checks every file against the pack's manifest, and unpacks it into
`public/assets/`. It holds everything that is first-party, public domain or under an open license.
[docs/assets.md](docs/assets.md) has the details.

### What is not included

The live game also uses 3D models from commercial asset packs (much of the scenery, and the
hangar room). Their licenses allow using them inside a finished game and do not allow giving
them to anyone else, so they are **not in this repository and not in the content pack**, and the
live site is the only place they appear. A clone runs without them: the game handles the missing
models and carries on, so some trees, rocks and hangar furniture are absent and everything else
works. The packs are credited in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Build and test

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server, HTTPS, all interfaces |
| `pnpm build` / `pnpm preview` | Type-check and produce a production build; serve it |
| `pnpm check` | `typecheck` + `lint` + unit tests. Run before sending a change |
| `pnpm test:smoke` | A few wide unit tests first, in seconds; narrows only when one fails |
| `pnpm e2e` | Playwright behavior specs (real browser, real GPU) |
| `pnpm e2e:shaders` | Asks the GPU whether every shader program links. Run after any shader change |
| `pnpm extract:check` | Verifies the generated data is byte-for-byte what was recorded |
| `pnpm lint` / `pnpm format` | Biome |

[docs/running-and-testing.md](docs/running-and-testing.md) explains the test tiers.

## How it works, briefly

The simulation (`src/sim/`) is a hand-written fixed-step integrator at 81.967 Hz, the exact step
the 2016 game used. It imports no three.js, touches no DOM and uses no clock or random numbers,
which a test enforces. The renderer (`src/render/`) reads simulation state and interpolates it
onto three.js objects; data never flows back. That split is what makes headless tests of whole
flights, AI racers and terrain generation in a worker possible. Courses, environments,
aircraft and editions are JSON, so adding one does not need a code change.

Two small servers, both on Cloudflare and neither with accounts, sit behind the leaderboard and
rooms. See [docs/servers.md](docs/servers.md).

## Documentation

- [docs/architecture.md](docs/architecture.md): the layers, the frame loop, the boot sequence.
- [docs/content-as-data.md](docs/content-as-data.md): levels, environments, aircraft, authored
  courses, generated data, and how to add a course.
- [docs/running-and-testing.md](docs/running-and-testing.md): commands, test tiers, the shader check.
- [docs/assets.md](docs/assets.md): the content pack and running without the commercial packs.
- [docs/servers.md](docs/servers.md): the lap server and the rooms Worker; self-hosting and privacy.
- [docs/porting-notes.md](docs/porting-notes.md): traps worth knowing if you are porting a Unity
  game to three.js.
- [docs/differences-from-2016.md](docs/differences-from-2016.md): what changed from the original,
  and what was kept on purpose.
- [docs/lap-server.md](docs/lap-server.md), [docs/rooms.md](docs/rooms.md) and
  [docs/stats.md](docs/stats.md): the full server references.

Some comments in the source cite `DEV-` numbers or planning documents. Those point at the
author's development notes, which are not published; the comments stand on their own.

## Licenses

| | |
|---|---|
| [LICENSE](LICENSE) | the **code** is MIT |
| [CONTENT-LICENSE.md](CONTENT-LICENSE.md) | the **game content** (levels, tuning, recorded flights, first-party models and maps) is CC BY-NC 4.0 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | third-party items with their own licenses, and the people behind the game |
| [NOTICE](NOTICE) | a one-page summary of how these divide up |

"Faceted Flight", "Uncle Matt Makes" and the game's logo and branding are not licensed by any of
the above. Forks ship under their own name.

See [CONTRIBUTING.md](CONTRIBUTING.md) if you would like to help.
