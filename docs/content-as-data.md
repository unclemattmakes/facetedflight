# Content as data

A mission, an environment, an aircraft variant and an edition are JSON files. Adding one should
not need a change under `src/`; if it does, treat that as a design problem. This page explains
the kinds of content, which of them are generated and why, and how to add a course.

## The content trees

| Folder | Kind | How it is made |
|---|---|---|
| `content/levels/` | The 13 shipped missions, one JSON each (including the Kauai course) | Generated from the original Unity scenes |
| `content/environments/` | Per-island prop passes: scatter placements, landmarks, spawn clearings. Also a menu environment | Generated in two stages (below) |
| `content/palettes/` | Small terrain-color thumbnails used by the hangar's holotables | Generated from the terrain color maps |
| `content/ghosts/` | The two recorded flights from 2016, as quantized integers | Generated |
| `content/aircraft/` | Aircraft variants (acrobat, standard, speed, and so on) as multipliers on named tuning values | Hand-authored |
| `content/editions/` | `classic.json` and `anniversary.json`: the render and gameplay presets | Hand-authored |
| `content/authored/` | Courses 2016 never had: Flight School lessons, free-flight areas, the glider course | Hand-authored |
| `content/overrides/` | Racing-line and other edits layered over a shipped level | Hand-authored (the editor writes them) |
| `content/lap-courses.json` | Every course the lap server will accept laps for | Generated from the courses (`node tools/net/write-lap-courses.mjs`) |
| `content/callsigns.json`, `no-prop-volumes.json` | Names for AI racers; volumes where props must not stand | Hand-authored |
| `src/generated/` | `constants.generated.{ts,json}`: the flight, camera, boundary and world tuning, with provenance | Generated |

## One level schema

Every course the game can fly is one schema (`src/content/level-schema.ts`, and
`content/levels/_schema.json`): extracted missions, hand-authored lessons, and courses a player
makes in the editor differ only in a few nullable fields. The main sections:

- **Identity and setup**: `id`, `title`, `vehicle` (`hoverjet`, `jumpseat` or `glider`),
  `environment`, `difficulty`, `mode`.
- **Where you start**: `spawn`, `respawn`, and the launch kind (the elevator ride out of the
  hangar shaft, a pad, or a direct start in the air).
- **The course**: `routes` (the rings, each with a position, rotation and trigger volume),
  `finish`, `route` (the racing line the AI follows), `orbs`, `pads`, `turnIndicators`, `clouds`.
- **Rules**: `timer`, `scoring`, `medals` (bronze to platinum thresholds), `boundary` (the
  play area and what happens past it).
- **Look**: `fog`, `lighting.sun`. The sun belongs to the mission, not to the environment: one
  of the missions is lit from four degrees above the horizon.
- **Modes**: `ringAttack` (race the clock through the rings), `targetPractice` (score for hits),
  `freeFlight` (explore), `energyRace` (Ring Attack with a tank that only rings refill) and
  `lesson` (the Flight School instructor's mode).

The loader (`load-level.ts`) validates a level on load and refuses one that breaks the rules the
schema cannot express, such as a lesson without a lesson block.

### Environments

`content/environments/<name>.json` holds what is placed on an island: the baked scatter lists
(trees, shrubs, rocks), the landmarks (the big named rocks and spires, with collision), and a
`spawnClearing` that keeps props off the start. The terrain itself is not data in git: it is
generated at load from a height map and a color map (both in the content pack) by the generator
in `src/sim/terrain/`, which reproduces the original's terrain, including its quirks.

### Aircraft variants

Each file in `content/aircraft/` lists variants for one vehicle. Every number in a variant is a
**multiplier** on a named value from the constants sheet (`"ship.rollRate": 1.8`), and
`standard` is empty, which makes it the original aircraft exactly. A test flies `standard`
against a recording made before the variant layer existed and requires a bit-for-bit match.
Variants show only in the preview channel (see [architecture.md](architecture.md)).

### Editions

`classic.json` and `anniversary.json` are complete render and gameplay presets: tone mapping,
haze, shadows, bloom, the racers' paint, whether the aircraft step exists in the hangar. Classic
turns everything off and uses the original numbers; it is what the port already was before the
presets existed, written down. A release build loads the preset with the preview-only blocks
switched off.

## The constants machine

The original game's tuning lived in Unity prefabs and scenes. Porting it by hand would mean
typing hundreds of numbers, any of which could be subtly wrong, and one particular trap makes it
worse: a Unity script's `public` field initializer is **not** the value the game shipped with.
The shipped value is whatever the scene's prefab says, with that scene's overrides on top.
Reading a number out of the C# source is a reliable way to get the wrong one.

So this project never hand-types a constant.

1. **Extractors** under `tools/extract/` read the Unity project (read-only) and write
   `src/generated/constants.generated.{ts,json}` and the generated content trees. Each entry
   carries its source file, the object's file ID, the line, and a **trust level**:
   `verified` (read from the shipped prefab or scene), `derived` (computed, with the formula
   written out), `code-default` (a private C# field with no serialized override), `fitted`,
   `invented` or `unverified`.
2. **A hash manifest** records the bytes. `pnpm extract:check` fails if the generated files
   differ from what was recorded, and it works on a machine with no Unity project.
   `content/_generated.sha256` covers `content/levels`, `environments`, `ghosts` and
   `palettes`.
3. **Consumers import the key** and assert against it. A constant that no code reads is
   documentation, not a guard.
4. **`src/sim/constants.ts` contains no numeric literals** of its own. A number added under
   `src/sim/` or `src/content/` needs a stated reason in review.

Environments are generated in two stages: `pnpm extract:props` writes the base, then
`pnpm bake:placements` adds the baked scatter and the spawn clearing. Neither stage alone is a
valid tree, and `pnpm extract` runs both. The bake needs three density maps that are not
distributed.

### Regenerating without the original project

You cannot, and you do not need to: the committed output is the result, and `pnpm extract:check`
verifies it. If you own a copy of the 2016 game's Unity project and want to re-run the
extractors, set `FF2_LEGACY` to its folder (see `.env.example`). The tools only read from it,
and without it they cannot run. They never write under that folder.

## How to add a course

### In the game: the editor

The easiest way. Open the course editor from the title (desktop), lay out rings over an island,
fly it, and share it as a link or a `.ffcourse` file. A player course is the same level schema,
expanded from a compact wire form (`src/content/player-course*.ts`), and the same validator runs
on it. It does not need the repository.

### In the repository: an authored course

1. Pick the closest existing level in `content/levels/` or `content/authored/` and copy it to
   `content/authored/<your_id>.json`. Give it a unique `id` and a `title`.
2. Edit the course: spawn, rings, finish, racing line, medals, timer. For a lesson, add a
   `lesson` block and set `mode` to `lesson` (see `content/authored/lesson_01_canyon.json` and
   `_lesson.schema.json`). Keep an `_authored` note saying what you copied and what you changed.
3. Set `"listed": true` to have the hangar offer it. Leave it false while you work: it can still
   be reached by id.
4. Run `pnpm test`. The content tests load every level, validate it, and fly the autopilot
   through the ones that have a race.
5. To rank laps on the leaderboard, regenerate `content/lap-courses.json` with
   `node tools/net/write-lap-courses.mjs`. A test regenerates it and compares.

The loader finds files with `import.meta.glob`, so adding a file adds a course and touches no
code. Do not edit anything in `content/levels/`, `environments/`, `ghosts/` or `palettes/` by
hand: those trees are generated and hash-checked, and a hand edit will be caught.

### Adding an environment or an aircraft variant

A variant is a block in `content/aircraft/<vehicle>.json`; the schema (`_schema.json`) refuses
unknown keys, and the loader checks that each key names a real value on the constants sheet. A
new island needs a height map and a color map served from your content location and a matching
environment file; read `src/content/load-environment.ts` and the four existing environments
first, because the placement lists are baked per island.
