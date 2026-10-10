# Architecture

How the game is put together, and the few rules that keep it that way. About a ten-minute read.

## The shape in one picture

```
 input ──► sim (fixed step, pure) ──► game rules ──► render (three.js) ──► screen / headset
              ▲                           │
   content (JSON) ───────────────────────┘          net (lap server, rooms) on the side
```

Data flows one way. Input and content go in, the simulation steps, the game layer reads
the result and decides what it means (a ring was taken, a lap ended), and the renderer draws an
interpolated picture of it. Nothing the renderer does feeds back into the simulation.

## Source layout

| Folder | What lives there |
|---|---|
| `src/sim/` | The simulation: rigid-body integrator, the HoverJet, JumpSeat and glider flight models, ground contact, the AI racers and autopilots, gate and boundary logic, the terrain generator, ghost recording. Pure TypeScript with no three.js and no DOM. |
| `src/render/` | Everything three.js: renderer and XR session, terrain meshes, the cockpit and HUD, clouds, water, the hangar, menus drawn as in-world panels, post effects, quality scaling. |
| `src/input/` | Gamepad (standard mapping), keyboard, touch, and XR controllers, all reduced to the same set of actions. |
| `src/content/` | Schemas and loaders for level, environment, aircraft and edition JSON, plus asset URLs and the build channel. |
| `src/game/` | Game rules built on the simulation: missions and modes, scoring and medals, racers, the hangar flow, Flight School, rooms and TV clients, results, local storage. |
| `src/boot/` | Startup and the per-frame loop. `app.ts` is the composition root; `app/` holds one module per subsystem. |
| `src/net/` | The pure halves of the servers (validators, policies, wire formats) and the game's clients for them. |
| `src/audio/` | WebAudio: synthesized sound effects, the music player, spatial engine sounds. |
| `src/editor/` | The course editor. |
| `src/generated/` | Generated constants. Never edited by hand. |
| `content/` | Levels, environments, aircraft, editions, palettes, overrides, authored courses and recorded flights, all JSON. |
| `functions/`, `workers/rooms/`, `migrations/` | The servers. See [servers.md](servers.md). |
| `tools/` | Extractors, asset converters, build plugins, test runners. |
| `tests/unit/`, `tests/e2e/` | Vitest and Playwright. See [running-and-testing.md](running-and-testing.md). |
| `making-of/` | A small static site about how the game was made, built into the game. |

## The simulation and the renderer

### Fixed step

The simulation advances in steps of exactly **0.0121999998 seconds** (81.967 Hz). That is the
32-bit float the original game's time settings held; documents that say "0.0122" are rounding.
Anything in `src/sim/` that wanted a frame delta would not be a simulation function, and nothing
there ever receives one.

Each browser frame, the loop works out how much wall time passed and feeds it to `stepFixed`.
That runs zero or more whole steps and returns `alpha`, how far the clock sits between the last
two steps. The renderer keeps the previous and current state of every moving thing and places it
`alpha` of the way between them. A 60 Hz monitor, a 90 Hz headset and a 144 Hz monitor all see a
smooth picture of the same 81.967 Hz simulation.

### Purity

`src/sim/` may not import three.js or anything from `src/render/`, touch `document`, `window` or
`navigator`, or call `Math.random()`, `Date.now()` or `performance.now()`. The unit test
`tests/unit/sim-purity-guard.test.ts` parses every file and fails on any of them. Randomness is
seeded (`src/sim/math/rng.ts`) and long work is written as generators that yield progress, so the
caller decides when to stop (`src/sim/steps.ts`).

This one boundary buys four things:

- **Headless tests of whole flights.** The test suite flies all thirteen missions with the
  autopilot in node, with no browser and no GPU, and checks medals and finish times.
- **The same AI racers everywhere.** The racers in single player, in a room's empty seats and in
  Faceted Flight TV are one piece of simulation code.
- **A server that can judge a lap.** The lap server re-flies nothing; it rescores a submitted
  lap's recorded poses with the game's own scoring function, which works because scoring is in
  `sim` and `game` code that runs in a Worker.
- **Terrain generation in a Web Worker.** The generator is a pure function of its inputs.

### Why there is no physics engine

The HoverJet's signature feel is a per-step velocity edit applied between force accumulation and
integration: a few percent of the sideways and vertical velocity is removed every step, against
a forward drag. A general physics engine fights that. So the simulation is a small hand-written
integrator with one dynamic body and ground contact by sampling the terrain's height field.
Props collide through a separate, simple hull test.

### The renderer

`WebGLRenderer` with three's `renderer.xr`. It is WebGL, not WebGPU, on purpose: the WebXR
integration, the shader patches this project relies on, and the measured cost of changing them
all point the same way. Frames are driven with `renderer.setAnimationLoop`, never
`requestAnimationFrame`, because inside a headset session the headset drives the frames.

The world is built from flat-shaded facets: terrain vertex colors are the albedo, with vertices
fully split so creases stay hard, and there are no textures on terrain or props. The cockpit is
the one object modeled at true scale, and everything outside borrows its sense of size from it.

Quality is adaptive. `src/render/quality.ts` watches frame time and, when the budget runs out,
gives up resolution first. It never drops the frame rate or removes the comfort vignette. In a
headset session the only live lever is the framebuffer scale chosen when the session starts.

## Boot and the composition root

`src/main.ts` wires the page (build version, failure message, first-gesture hook) and calls
`bootApp` in `src/boot/app.ts`. `bootApp` is the composition root: it builds the owners of state
and the subsystems, and hands each a small context object of getters over what the closure still
owns. State has named owners, so no module reaches into another's variables:

- `world-handles` holds the objects of the world currently loaded.
- `run-state` holds the current run (mission, mode, racers, results).
- `screen-router` decides which screen is up (title, hangar, a mission, the editor, a room).
- `settings`, `pause-state` and `autopilot-state` own their namesakes.

The subsystems under `src/boot/app/` are each `createX(ctx)`: `frame.ts` (the loop), `world/`
(building and switching worlds), `title/`, `hangar/`, `room/`, `tv/`, `flight/`, `results.ts`,
`audio.ts`, `xr-lifecycle.ts` and so on.

### The frame loop

`frame.ts` runs a fixed order each frame, and tests pin it:

1. Swap screens if the router asked for it, and probe the XR session.
2. Poll input and dispatch confirmations.
3. Service rooms and TV.
4. Run the fixed steps (flight, racers, rules), getting `alpha`.
5. Interpolate and place everything at `alpha`; update the camera and cockpit.
6. Apply the Anniversary visual effects; render.
7. Record performance counters.

### Worlds and loading

Loading a mission means: read its level JSON, read its environment JSON, build the terrain from
the generator in a worker, place props from the environment's
baked placement lists, and warm shader programs so nothing compiles in the air. Long work is
sliced against a time budget (`src/boot/slice.ts`) so a headset frame is never held for seconds.

### Editions

Two data files, `content/editions/classic.json` and `anniversary.json`, switch the visual
presentation: tone mapping, haze, shadows, bloom, racer livery, and so on. Classic is 2016's
look in a mission. The menus always use the Anniversary look, and the rules are the Anniversary
rules in both (`?rules=classic` keeps the 2016 rules, mainly for tests).

### Build channels

The production site hides a few features that a local build shows. The list is `PREVIEW_ONLY` in
`src/content/build-channel.ts` (currently aircraft variants and the glider). A local or
self-hosted build is the *preview* channel unless you set `FF2_CHANNEL=release`.

## Inputs

Every device ends up producing the same action set (`src/input/actions.ts`). Gamepads are read
through one function that applies the standard mapping; keyboard, touch and XR controllers write
the same fields. A test asserts that VR and flat inputs agree axis for axis, but the control
scheme itself is checked against the generated constants sheet, not against another copy of the
code.

## Network code

Nothing under `src/net/` needs a browser. The lap validator, the room server class and the wire
formats are plain TypeScript, tested in node. `functions/` and `workers/rooms/` are thin shells
over them, so the logic that matters is exercised by unit tests without a deployment. Details are
in [servers.md](servers.md).

## Rules worth knowing before you change something

1. `src/sim/` stays pure. A test fails loudly if it is not.
2. Numbers come from the constants sheet. See [content-as-data.md](content-as-data.md).
3. Content is data. A new course, environment or aircraft variant should not touch `src/`.
4. Layers 1 and 2 of a three.js object are the left and right eyes in a WebXR session. Never put
   anything on them. `src/render/bloom.ts` uses layer 3 for UI.
5. Never assign `material.onBeforeCompile` directly. Use `chainShaderPatch`
   (`src/render/program-cache-key.ts`), which keeps three's program cache from sharing a program
   between materials that differ only in their patch. A test refuses a raw assignment.
6. Check what the harness does against what a player does. A test that makes the game take a
   different code path proves something about a build nobody plays.
