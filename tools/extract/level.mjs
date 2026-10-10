#!/usr/bin/env node
/**
 * tools/extract/level.mjs -- turn a 2016 Faceted Flight mission scene into FF2 level JSON.
 *
 * PORT_PLAN.md section 5.4 ("Level JSON -- one schema, with the liveness rule") is the
 * specification. This tool is its implementation. Nothing here is hand-typed from prose:
 * every emitted number is read out of the shipped Unity YAML and carries provenance in the
 * sidecar `_meta` block (source scene path + fileID + which document it came from).
 *
 * USAGE
 *   node tools/extract/level.mjs int_01_hoverJet     # one mission
 *   node tools/extract/level.mjs --all               # all 13 shipped missions (pnpm extract:levels)
 *   node tools/extract/level.mjs --all --summary     # + the summary table on stdout
 *   node tools/extract/level.mjs --all --check       # exit 1 if the EXTRACTOR is broken
 *   node tools/extract/level.mjs --list              # list mission ids and their scenes
 *
 * OPTIONS
 *   --out <dir>       output directory (default: <repo>/content/levels)
 *   --src <dir>       legacy Unity project root (default: the 2016 backup)
 *   --guid-index <f>  guid<TAB>Assets/path TSV (default: docs/research/_guid_index.tsv)
 *   --compact         write compact JSON (default is pretty, these files are read by humans)
 *   --stdout          print the JSON instead of writing it
 *   --no-write        parse and report, write nothing
 *
 * OUTPUT (all under content/levels/)
 *   <mission>.json                 one level per shipped mission, validated by _schema.json
 *   _structural-assertions.json    PORT_PLAN 4.7: the structural claims, for CI to diff
 *   _summary.md                    the summary table
 *
 * --check FAILS ONLY ON EXTRACTOR BUGS, never on 2016's own bugs. rookie_01's unreachable
 * platinum and int_02's twelve deactivated orbs are *findings*: they are reported on stdout
 * and recorded in each level's `_meta.checks`, and they must not turn CI red, or the first
 * response will be to "fix" the data until the tool goes quiet. A missing spawn marker or an
 * unresolvable Curvy coordinate space is a tool bug and does exit 1.
 *
 * SAFETY. This tool NEVER writes into the Unity project. Every fs write goes through
 * writeOut(), which refuses any path under the legacy source root. Proven by running
 *   find "<src>" -newer <marker> -type f | wc -l   ->   0
 * after a full 13-mission run.
 *
 * ---------------------------------------------------------------------------------------
 * THE LIVENESS RULE (PORT_PLAN 5.4, from _verify-v-modes.md E2/E4/E5)
 *
 *   A ring counts only if its TriggerCheckpoint has m_Enabled: 1, addScore != 0, and its
 *   entire m_Father parent chain is m_IsActive: 1.
 *
 * with one refinement this tool had to make and the plan did not state:
 *
 *   The two GAME-MODE PARENTS are toggled at runtime, not authored live. Level.cs enables
 *   `ringAttackParent` and disables `freeFlightParent` (or vice versa) in DelayedStart().
 *   So the active-in-hierarchy walk must treat those two nodes as ACTIVE regardless of
 *   their authored m_IsActive, or every energy orb in every Ring Attack scene reads as dead
 *   (int_01's 11 orbs sit under `freeFlight_objects`, m_IsActive: 0 in the shipped scene).
 *   Ring liveness is unaffected -- `RingAttack_objects` is authored active in every scene --
 *   so the corrected ring counts still reproduce exactly. See MODE_PARENT_KEYS below.
 *
 * ---------------------------------------------------------------------------------------
 * COORDINATE CONVENTION -- and what was actually validated
 *
 * Unity 5.4 is left-handed, Y-up, +Z forward. three.js/glTF is right-handed, Y-up,
 * -Z forward. The rule applied here, identical to unity_scene_to_json.js and
 * unity_mesh_to_obj.js --three, is the NEGATE-Z mirror:
 *
 *     position   (x, y, z)    -> ( x,  y, -z)
 *     quaternion (x, y, z, w) -> (-x, -y,  z, w)
 *     scale      (x, y, z)    -> ( x,  y,  z)      [unchanged]
 *     euler XYZ  (x, y, z)deg -> (-x, -y,  z)deg
 *     triangle winding        -> REVERSED          [meshes; paired, see below]
 *     UV                      -> V flipped         [meshes; paired]
 *
 * WHAT WAS VALIDATED, not asserted. tools/prototype/axis_test.js compares a mesh exported
 * from Unity YAML in raw Unity coordinates against the same source FBX exported to glTF by
 * Blender, and scores eight candidate axis mappings by vertex-set overlap. Run:
 *
 *     node tools/prototype/axis_test.js out/rock1.obj out/rock1.glb
 *
 * and the report in content/levels/_axis-validation.md records the result. The mapping is a
 * MIRROR (determinant -1), which is why it must be applied as a pair: convert the geometry
 * AND reverse the winding, or the world turns inside out. This tool only emits transforms,
 * so it applies the position/quaternion half; the mesh half belongs to the terrain and prop
 * pipelines.
 *
 * Both spaces are emitted. `pos`/`quat` on every element are THREE-SPACE (what the runtime
 * loads). `_meta.raw` carries the untouched Unity values so a disagreement is diagnosable
 * without re-running the extractor.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideLegacy, legacyRoot, portableText } from '../legacy-root.mjs'
import { shippedMissions as sharedShippedMissions } from '../unity/build-settings.mjs'
import { componentOwners, flatIsLive } from '../unity/graph.mjs'
import { loadGuidIndex } from '../unity/guid-index.mjs'
import { modificationsOf, prefabInstances } from '../unity/modifications.mjs'
import { prototypeTool, readUnityText, unityYaml } from '../unity/yaml.mjs'
import { ELEVATOR_CLIP, readClipStopTime, readElevatorCurve } from './elevator.mjs'
import { fbxMeshBounds } from './fbx-bounds.mjs'
import { fbxRadialProfile } from './pad-solid.mjs'
import { loadSkyboxFaces, projectSky, SKYBOX_FACES } from './sky.mjs'
import { readPrefabTexts, selectBriefing, selectUiStrings } from './ui-text.mjs'
import { unity54LightLinear } from './unity-light.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..', '..')

// The prototype extractors in tools/prototype/ are CommonJS under a "type": "module" package;
// tools/unity/yaml.mjs compiles them in a CommonJS sandbox (TL-1: the one loader, which was
// this file's recipe). `require.main === module` inside them is false, so their CLI blocks
// stay dormant.
const { parseDocuments } = unityYaml()
const sceneTool = prototypeTool('unity_scene_to_json.js')
const { extract } = sceneTool

/* =========================================================================== constants == */

const DEFAULT_GUID_INDEX = path.join(REPO, 'docs/research/_guid_index.tsv')
const DEFAULT_OUT = path.join(REPO, 'content/levels')

/** GameModeEnum in Level.cs. */
const GAME_MODE = ['freeFlight', 'ringAttack', 'multiplayer', 'recording']

/** Ship prefab guid -> FF2 vehicle id. Resolved from Level.ShipPrefab, never assumed. */
const VEHICLE_BY_GUID = {
  '159a650edd630ef40bb44d10d1c6d216': 'hoverjet', // Resources/PlayerShip_SR14_Photon.prefab
  '64d1f5fbe80e75d47bbae0c403ade860': 'jumpseat', // Resources/JumpSeat_Photon.prefab
  // NOT a shipped mission prefab. PlayerShip_SR14_unet.prefab has identical physics but the
  // OPPOSITE glider_lockRollAndYaw. If this ever appears, the tool errors rather than guess.
  '': null,
}

/** LoadLevelArt.levelName -> FF2 environment id. */
const ENV_ID = {
  LevelArt_SimonetIslands: 'simonet',
  LevelArt_AlpineForest: 'alpine',
  LevelArt_Desert: 'desert',
  LevelArt_Kauai: 'kauai',
}

/**
 * Runtime-toggled mode parents. Level.cs sets these active/inactive in DelayedStart()
 * according to PlayerPrefs "GameMode"; their authored m_IsActive is a level-editor
 * convenience, not shipped behaviour. Values are Level MonoBehaviour field names.
 */
const MODE_PARENT_FIELDS = ['ringAttackParent', 'freeFlightParent']

/** Scoring constants that live in code, not in YAML (verified private/non-serialised). */
const CODE_CONSTANTS = {
  // Scoreboard.cs:14 -- `private double timeBonusMultiplier = 11.5`
  timeBonusMultiplier: 11.5,
  // TriggerCheckpoint.cs -- `private float energyBoostAmount = 12f`
  energyBoostAmount: 12,
}

/**
 * DEV-004, Matt 2026-09-09: the time bonus counts in the SCORE. 2016 computed
 * it for its leaderboard and never let it near a medal.
 *
 * The name over-states it since the DEV-393 follow-up: the bonus still orders
 * clean runs (the score, a personal best, a board), but with platinum at every
 * ring no medal moves on it. See `medalsFf2` below.
 */
const DEV_004_TIME_AFFECTS_MEDAL = true

/*
 * `medalsFf2`: what FF2 awards a ring medal against. The DEV-393 follow-up.
 *
 * Matt, 2026-09-25: *"gold medal = 90, plat = 100"*. Gold stays at 2016's
 * authored ~90 % of the rings, and PLATINUM IS EVERY RING: the ring ceiling,
 * on both editions, in every Ring Attack course.
 *
 * Why that is exactly "platinum <=> every ring". Since DEV-393 a missed ring
 * forfeits the time bonus (`src/game/mission.ts`, `timeBonus`), so:
 *
 *   incomplete run  ->  rings x 100, at most (n-1) x 100, below the ceiling
 *   complete run    ->  n x 100 + bonus >= n x 100, the ceiling
 *
 * Bronze, silver and gold are 2016's own, untouched. They sit at 0.43, 0.67 and
 * 0.90 of the ring ceiling across the shipped HoverJet missions, and gate on the
 * ring count alone because an incomplete run scores rings alone.
 *
 * What this replaced: DEV-004 put platinum ABOVE the ceiling, at
 * `ringCeiling + 11.5 x (par - courseLength / (0.5 x maxSpeed))` — "collect
 * everything, quickly". It read `ship.maxSpeed` (437.5) as metres a second; the
 * constants sheet says it is a force (`derived.hoverjet.thrustNewtons`), and no
 * recorded flight on any course, human or autopilot, reached that pace
 * (DEV-393 §5). The pace, the course length it was measured over and the
 * vehicle speed table went with it.
 *
 * It keeps DEV-003's fix: `rookie_01_hoverJet` ships a 2016 platinum of 1700
 * against 16 rings x 100, and the ceiling is 1600. And the same fix reaches
 * `rookie_02_jumpSeat` (29 rings against 3000), whose Target Practice runs its
 * own curve but whose rings score under `?mode=ringAttack`.
 */

/* -- DEV-061: the one mission whose forcing FF2 drops ----------------------------- */
//
// Matt, 2026-09-13: *"int_02_jumpseat - option 2"*.
//
// `int_02_jumpSeat`'s scene sets `Level.ForceGameMode = 1` with
// `ForcedGameMode = 1`, so 2016 locks it into Free Flight. That is extracted and
// stays extracted -- `forcedMode` below is untouched. What FF2 does with it is a
// separate field, for the same reason `medalsFf2` sits beside `medals` (DEV-004)
// and `posFf2` beside `pos` (DEV-067): the ledger keeps a faithful record and the
// game keeps working content.
//
// ── Why this one mission ─────────────────────────────────────────────────────
//
// The forcing and the scene's own content contradict each other, and it is the
// only mission of thirteen where they do:
//
//   · all TWELVE of its `EnergyOrb`s ship `m_IsActive: 0` -- the only mission
//     with zero live orbs in a mode that scores orbs;
//   · NINE of its eleven jump pads are live, and so is the finish slab inside
//     `target_jumppad (9)`;
//   · Free Flight scores orbs, not pads (`MODES.freeFlight.scores`), has no
//     clock and `endsOn: 'never'`.
//
// So the mode it is locked into has nothing to score and the content it does
// have belongs to a mode it cannot enter. `hoverJet_kauai_beg`, the other forced
// mission, has all ELEVEN of its orbs live -- that one's forcing is coherent, and
// it keeps it. Both facts point one way: the scene is authored as Target
// Practice and only `ForceGameMode` disagrees with it.
//
// ── What this changes, and what it does not ──────────────────────────────────
//
// `forcedMode` and its provenance row are exactly what they were. `forcedModeFf2`
// is a SEPARATE nullable field: null on the other twelve ("2016 got this right"),
// and `{ mode: null }` here ("FF2 forces nothing"). `game/modes.ts`'s
// `runningMode` is the one door that reads it.
//
// It is an object rather than a bare `GameMode | null` on purpose. The value FF2
// wants IS null, which would be indistinguishable from "no deviation" under this
// repo's `xFf2 ?? x` idiom -- and an object makes the wrong `??` a TYPE ERROR in
// `src/` instead of a silent fall-through to 2016's forcing.
//
// Reverting is deleting the entry below and re-running `pnpm extract:levels`.
const DEV_061_UNFORCED = {
  int_02_jumpSeat: {
    /** What 2016 forces. Asserted before the drop, so a scene edit cannot go quiet. */
    mode2016: 'freeFlight',
    note:
      'all 12 EnergyOrbs are m_IsActive 0 and 9 of 11 jump pads are live, so the forced ' +
      'mode scores nothing and the live content belongs to the JumpSeat default. Matt, ' +
      '2026-09-13, DEV-061 option 2.',
  },
}

/**
 * `forcedModeFf2` for a mission: null, or the forcing FF2 applies instead.
 *
 * Throws if the table names a mission whose 2016 forcing has moved -- a stale
 * entry would otherwise silently un-force a scene nobody re-read.
 */
function dev061ForcedMode(missionId, forcedMode2016) {
  const row = DEV_061_UNFORCED[missionId]
  if (!row) return null
  if (forcedMode2016 !== row.mode2016) {
    throw new Error(
      `DEV-061: ${missionId} was recorded as forced to ${row.mode2016}, but the scene now ` +
        `reads ${forcedMode2016}. Re-read the deviation before dropping a forcing that moved.`,
    )
  }
  return {
    /** null means FF2 forces NOTHING here; the level's own `mode` then stands. */
    mode: null,
    _meta: { deviation: 'DEV-061', mode2016: row.mode2016, note: row.note },
  }
}

// ── DEV-146: ambient traffic ────────────────────────────────────────────────
//
// Matt's triage, 2026-09-16: *"Interleaved modes: see HoverJets fly while on a
// JumpSeat course."* Other missions' ships flying their own course over the
// island you are on, scoring nothing, while you fly yours.
//
// ── Why an AUTHORED table inside the extractor ──────────────────────────────
//
// It is not in 2016. Nothing in a mission scene says "and put three HoverJets
// over there" — a 2016 scene loads its own course and nothing else, and the
// only other craft in a 2016 run are the two `GhostRacer` recordings on the AI
// pads, which are opponents in YOUR race. So this is FF2's, and it goes where
// every other FF2-authored per-mission decision goes: a table here, emitted
// into the generated level JSON, exactly as `DEV_061_UNFORCED` -> `forcedModeFf2`
// and `DEV_067_ORB_FLOOR` -> `orbs[].posFf2` do.
//
// That is what makes it survive `pnpm extract:check`. `content/levels/*.json` is
// generated and hash-guarded against `content/_generated.sha256`; a field
// hand-edited into the JSON would be erased by the next `pnpm extract:levels`
// and would fail the manifest before that. A field EMITTED here is simply what
// the extractor produces. Turning traffic on for another mission is a row
// below, then `pnpm extract:levels && pnpm extract:manifest`.
//
// ── Why THIS pairing ────────────────────────────────────────────────────────
//
// Measured, in metres, from every anchor of the JumpSeat course (spawn, pads,
// orbs, rings, finish) to the nearest point of the donor HoverJet's authored
// route polyline. All six JumpSeat missions share an environment with the
// HoverJet mission of the same name, so all six are candidates:
//
//     rookie_01_jumpSeat  alpine    min  80  median 170  max  343
//     rookie_02_jumpSeat  desert    min  40  median 853  max 2919
//     int_01_jumpSeat     simonet   min  82  median 452  max  760
//     int_02_jumpSeat     alpine    min  14  median 249  max 1006
//     adv_01_jumpSeat     desert    min   4  median 429  max 1157
//     adv_02_jumpSeat     simonet   min  48  median 367  max  896
//
// (Distance to a route POINT, not to the line; the polyline's spacing is ~27 m,
// so each figure is an upper bound on distance-to-the-line by at most ~13.5 m.
// DEV-027 is why that sentence is here.)
//
// `int_01_jumpSeat` takes the first one: Simonet, the release island; the donor
// is `int_01_hoverJet`, the release course, whose 421-point `CurvyClonePath` is
// the line the AI racers fly best; and a median of 452 m reads as jets across
// the bay rather than as near-misses. `rookie_02_jumpSeat` is the counter-case
// at a median of 853 m — far enough that DEV-044's "four pixels across" applies
// and it would be a feature nobody could see.
//
// ONE ROW, deliberately. Which missions get traffic is Matt's call and the
// numbers above are the brief for it; shipping six guesses would be six things
// to unpick in a headset instead of one thing to judge.
const DEV_146_AMBIENT_TRAFFIC = {
  int_01_jumpSeat: {
    /** The donor: whose course the traffic flies. */
    mission: 'int_01_hoverJet',
    /** Both missions' environment. Asserted, so a re-extraction that moved one is loud. */
    environment: 'simonet',
    count: 3,
    note:
      'int_01_jumpSeat targets sit a median of 452 m (min 82, max 760) from int_01_hoverJet ' +
      'route points, so the ring course crosses the bay this mission is flown over. Three ' +
      'ships on an 11.3 km circuit is roughly a jet every 30 s near the player; the count is ' +
      'a first guess only a headset settles. Matt, 2026-09-16, DEV-146.',
  },
}

/**
 * `ambientTraffic` for a mission: null, or the course its sky borrows.
 *
 * Throws if the table names a mission whose environment has moved -- the whole
 * feature rests on the two courses being over the SAME island, and a stale row
 * would put three ships over a different one where nobody would ever see them
 * and nothing would say so. The donor's own environment is cross-checked
 * against the built set in `main`, because that one needs both levels.
 */
function dev146AmbientTraffic(missionId, environment) {
  const row = DEV_146_AMBIENT_TRAFFIC[missionId]
  if (!row) return null
  if (environment !== row.environment) {
    throw new Error(
      `DEV-146: ${missionId} was recorded in environment "${row.environment}", but it now ` +
        `extracts as "${environment}". Ambient traffic needs both courses over ONE island; ` +
        're-read the deviation before emitting it.',
    )
  }
  return {
    mission: row.mission,
    count: row.count,
    _meta: { deviation: 'DEV-146', note: row.note },
  }
}

/**
 * The generated constants sheet, for the numbers a level takes from it rather
 * than typing. (It also fed DEV-004's per-vehicle top speed, retired with the
 * time-based platinum in the DEV-393 follow-up.)
 */
const SHEET = (() => {
  const sheetPath = path.join(REPO, 'src', 'generated', 'constants.generated.json')
  if (!fs.existsSync(sheetPath)) return null
  return JSON.parse(fs.readFileSync(sheetPath, 'utf8'))
})()

/**
 * How long the screen stays black after an out-of-bounds death, from the sheet.
 *
 * It was a hand-typed `2.5` here with its provenance in a comment — which is
 * hard rule 3's smell exactly, and the kind of number that gets quoted, built on
 * and never re-derived (DEV-027). `constants.mjs` now reads it out of
 * `Trigger_Kill.DelayedReload()` and this takes it from there, so the two
 * generated trees cannot drift apart.
 *
 * A missing sheet is a HARD failure rather than a fallback: `pnpm extract` runs
 * the constants first and a silent default would put an invented number into
 * thirteen level files that CI diffs byte for byte.
 */
const RESPAWN_HOLD_SECONDS = (() => {
  const v = SHEET?.fade?.respawnHoldSeconds
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(
      'fade.respawnHoldSeconds is not in src/generated/constants.generated.json — run `pnpm extract:constants` first',
    )
  }
  return v
})()

/* ============================================================================== helpers == */

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)
const opt = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const SRC = (opt('--src', null) ?? legacyRoot()).replace(/\\/g, '/')

const OUT_DIR = opt('--out', DEFAULT_OUT)
const GUID_INDEX_PATH = opt('--guid-index', DEFAULT_GUID_INDEX)

function num(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
function bool(v) {
  const n = num(v)
  return n === undefined ? undefined : n !== 0
}
function r6(n) {
  return Math.round(n * 1e6) / 1e6
}
/** Short content hash, for structural assertions that must not print the content. */
function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** Unity world position -> three.js. See COORDINATE CONVENTION above. */
function toThreePos(p) {
  return [r6(p.x), r6(p.y), r6(-p.z)]
}
/** Unity world quaternion -> three.js. */
function toThreeQuat(q) {
  return [r6(-q.x), r6(-q.y), r6(q.z), r6(q.w)]
}
function rawPos(p) {
  return [r6(p.x), r6(p.y), r6(p.z)]
}
function rawQuat(q) {
  return [r6(q.x), r6(q.y), r6(q.z), r6(q.w)]
}

/** three.js yaw (rotation about +Y) in degrees, from a three-space quaternion [x,y,z,w]. */
function yawDeg(q) {
  const [x, y, z, w] = q
  const siny = 2 * (w * y + z * x)
  const cosy = 1 - 2 * (x * x + y * y)
  return r6((Math.atan2(siny, cosy) * 180) / Math.PI)
}

/** Never write into the read-only legacy project. */
function writeOut(file, text) {
  const abs = assertOutsideLegacy(file, SRC)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, portableText(text, SRC))
  return abs
}

/* ==================================================================== the shipped list == */

/**
 * The 13 shipped missions, read from ProjectSettings/EditorBuildSettings.asset rather
 * than transcribed. `enabled: 1` + under Scenes/missions/ = shipped mission.
 * Multiplayer scenes are excluded by folder (§6.1 cuts multiplayer; and
 * multi_hoverJet_simonetIslands.unity does not exist in the backup).
 */
function shippedMissions() {
  return sharedShippedMissions(SRC)
}

/* ================================================================== scene introspection == */

let GUID_INDEX = null
function guidIndex() {
  if (!GUID_INDEX) GUID_INDEX = loadGuidIndex(GUID_INDEX_PATH).guidToPath
  return GUID_INDEX
}

const sceneCache = new Map()
function loadScene(absPath) {
  const key = absPath.replace(/\\/g, '/')
  if (sceneCache.has(key)) return sceneCache.get(key)
  const flat = extract(absPath, {
    project: SRC,
    guidIndex: guidIndex(),
    resolvePrefabs: true,
    expandPrefabs: false,
  })
  // Raw documents too: we need GameObject.fileID -> Transform.fileID so that MonoBehaviour
  // fields holding GameObject references (Level.ringAttackParent etc.) can be resolved to
  // a node in the flattened tree.
  const text = readUnityText(absPath)
  const docs = parseDocuments(text)
  const goToTransform = new Map()
  const componentOwner = componentOwners(docs) // component fileID -> GameObject fileID
  for (const d of docs) {
    if (d.classId !== 4 && d.classId !== 224) continue
    const go = d.data.m_GameObject?.fileID
    if (go) goToTransform.set(String(go), String(d.fileId))
  }
  // Raw prefab-instance modification lists, so a value whose target component the flattener
  // does not describe (e.g. the legacy Animation state's m_Time) is still reachable.
  const instanceMods = new Map()
  for (const d of prefabInstances(docs)) instanceMods.set(String(d.fileId), modificationsOf(d))
  const byKey = new Map(flat.objects.map((o) => [o.key, o]))
  const scene = { absPath: key, flat, docs, byKey, goToTransform, componentOwner, instanceMods }
  sceneCache.set(key, scene)
  return scene
}

/** Find every object carrying a MonoBehaviour with this script name. */
function withScript(scene, name) {
  return scene.flat.objects.filter((o) => o.scripts.some((s) => s.name === name))
}
/** The single object carrying `name`, preferring an authored-active one. Errors on ambiguity. */
function oneWithScript(scene, name, { allowMissing = false, preferActive = true } = {}) {
  let hits = withScript(scene, name)
  if (preferActive && hits.length > 1) {
    const live = hits.filter((o) => o.activeInHierarchy)
    if (live.length) hits = live
  }
  if (!hits.length) {
    if (allowMissing) return null
    throw new Error(`no ${name} in ${scene.absPath}`)
  }
  return hits[0]
}
function scriptOn(obj, name) {
  return obj ? obj.scripts.find((s) => s.name === name) || null : null
}

/**
 * Resolve a serialised field that may be overridden by a prefab instance.
 * unity_scene_to_json.js puts base values in `fields` and overrides in `instanceOverrides`.
 */
function fieldOf(script, key) {
  if (!script) return undefined
  if (script.instanceOverrides && Object.hasOwn(script.instanceOverrides, key)) {
    return script.instanceOverrides[key]
  }
  return script.fields ? script.fields[key] : undefined
}
/**
 * Where a value came from -- the whole point of the provenance block.
 *
 * `owner` is the node the component sits on. The distinction matters: for a component on a
 * prefab instance, an un-overridden field is the PREFAB's value, not something the scene
 * author chose. int_01's bronze/silver/gold `*Exp` thresholds are finale_logic.prefab's
 * 3/5/9 with only platMinExp overridden to 12, and labelling those "sceneSerialized" would
 * assert a scene decision that was never made -- the same class of mistake as reading a C#
 * initialiser as shipped behaviour.
 */
function fieldSrc(script, key, owner) {
  if (!script) return 'missing'
  if (script.instanceOverrides && Object.hasOwn(script.instanceOverrides, key)) {
    return 'prefabInstanceOverride'
  }
  if (script.fields && script.fields[key] !== undefined) {
    return owner?.prefab ? 'prefabBase (not overridden by this scene)' : 'sceneSerialized'
  }
  return 'codeDefault'
}

/** Resolve a GameObject-typed MonoBehaviour field to a node in the flattened tree. */
function nodeForGameObjectRef(scene, ref) {
  if (!ref) return null
  const id = typeof ref === 'object' ? ref.fileID : ref
  if (!id || String(id) === '0') return null
  const tid = scene.goToTransform.get(String(id))
  return tid ? scene.byKey.get(tid) || null : null
}
/** Resolve a Component-typed field (Transform, MonoBehaviour, ...) to its owning node. */
function nodeForComponentRef(scene, ref) {
  if (!ref) return null
  const id = typeof ref === 'object' ? ref.fileID : ref
  if (!id || String(id) === '0') return null
  // Component fileIDs of Transforms are themselves node keys.
  if (scene.byKey.has(String(id))) return scene.byKey.get(String(id))
  const go = scene.componentOwner.get(String(id))
  if (!go) return null
  const tid = scene.goToTransform.get(String(go))
  return tid ? scene.byKey.get(tid) || null : null
}

/* =============================================================== the liveness machinery == */

/**
 * activeInHierarchy, with the two runtime-toggled game-mode parents forced active.
 * `modeParentKeys` are node keys (Transform fileIDs).
 */
function liveInHierarchy(scene, obj, modeParentKeys) {
  // A mode parent's own flag is skipped (Level.cs decides its state at runtime) but its ancestors
  // still count. The walk is tools/unity/graph.mjs's, shared with convert-hangar-art (TL-4).
  return flatIsLive(obj, (o) => (o.parent ? scene.byKey.get(o.parent) : null), {
    forced: (o) => modeParentKeys.has(o.key),
  })
}

/**
 * True when `o` is the ROOT of a prefab instance whose asset path matches `re`.
 *
 * The naive test -- "name or prefab path matches" -- over-counts badly, because every node
 * inside a prefab instance carries the same `prefab.path`. `target_jumppad`'s own children
 * (`jumpPad_fx`, `finale_jumpSeat`) matched it and inflated the pad count. The instance root
 * is the node whose parent belongs to a different prefab instance (or to none).
 */
/**
 * Every PLACEMENT of a prefab in this scene: exactly one node per prefab instance.
 *
 * This is fiddlier than it looks and two wrong versions were measured before this one.
 * unity_scene_to_json.js emits several node kinds for prefab content:
 *
 *   'scene'          -- a plain scene GameObject (no prefab link at all)
 *   'stripped'       -- the scene's stripped Transform for an instance: real name, real
 *                       world transform, one per instance
 *   'prefabAncestor' -- an interior node of the prefab asset on the path to an override
 *   'prefabRoot'     -- an interior node of the prefab asset; frequently NAMELESS, with a
 *                       path ending "/?", when its GameObject could not be resolved
 *
 * Two traps:
 *   1. Taking every node whose `prefab.path` matches counts a pad's own children (`art`,
 *      `jumpPad_fx`, `finale_jumpSeat`) as pads -- 11 authored jump pads in
 *      rookie_02_jumpSeat became 20.
 *   2. Taking only kind === 'stripped' looks right on int_01 and silently drops content
 *      elsewhere: the SAME EnergyOrb.prefab instance ids appear as 'stripped' in
 *      int_01_hoverJet and as 'prefabRoot' in int_02_hoverJet and rookie_02_hoverJet. That
 *      version reported 0 orbs for four scenes that have 12 and 26.
 *
 * So: match on prefab path OR object name, keep only nodes whose NAME looks like the thing
 * (which excludes interior children and the nameless artefacts), group by prefab instance
 * id, and elect one representative per group -- preferring the stripped/scene node, then a
 * named one, then the shallowest path.
 */
function placementsOf(scene, pathRe, nameRe) {
  const matched = scene.flat.objects.filter((o) => {
    const p = o.prefab?.path
    if (p && !pathRe.test(p)) return false
    if (!p && !nameRe.test(o.name || '')) return false
    // interior children of a matching instance carry the instance's prefab path but not its
    // name; the name test is what separates a pad from the pad's beacon
    return nameRe.test(o.name || '')
  })
  const groups = new Map()
  for (const o of matched) {
    const id = o.prefab ? `i:${o.prefab.instanceId}` : `k:${o.key}`
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(o)
  }
  const rank = (o) =>
    (o.kind === 'stripped' || o.kind === 'scene' ? 100 : 0) +
    (o.name || '' ? 10 : 0) -
    String(o.path || '').split('/').length
  const out = []
  for (const list of groups.values()) {
    list.sort((a, b) => rank(b) - rank(a) || (a.path < b.path ? -1 : 1))
    out.push(list[0])
  }
  return out
}

/* ====================================================================== element readers == */

/**
 * Ordered live rings.
 *
 * A ring in the shipped scenes is a `NNNNCheckpoint_Ring(Clone)` GameObject (tag
 * `Checkpoint`) whose subtree carries the scoring TriggerCheckpoint on
 * `<clone>/offset/trigger_checkpoint`. There is a second TriggerCheckpoint on `<clone>/offset`
 * in some scenes; only the one with addScore != 0 scores.
 *
 * Ordering is by the four-digit `NNNN` prefix the SplinePathCloneBuilder wrote, per route
 * group (the clone's parent). Multiple live sibling groups = alternate routes (adv_01).
 */
/**
 * The FINISH GATE — what actually ends a run, and what nothing had ever seen.
 *
 * ── Why this needs its own scene read ─────────────────────────────────────
 *
 * `loadScene` uses `expandPrefabs: false`, so the flattener stops at a prefab
 * instance's boundary. The finish gate lives ENTIRELY inside
 * `Prefabs/FinishLine.prefab` and is placed as a Unity 5 STRIPPED INSTANCE:
 * there is no GameObject named `FinishLine` anywhere in the scene text, so a
 * name search over the scene returns nothing and a collider sweep over the
 * scene's 156 materialised colliders returns nothing. Both of those negatives
 * are real, and both are wrong.
 *
 * That is why this does its own `extract()` with `expandPrefabs: true` rather
 * than flipping the flag on `loadScene`: expanding prefabs everywhere would
 * change the node set every other reader in this file walks, and the blast
 * radius of "regenerate all thirteen levels differently" is not worth one
 * field. The expanded read is cached the same way.
 *
 * ── What it is, measured ──────────────────────────────────────────────────
 *
 * `levelOffset/RingAttack_objects/FinishLine/Checkpoint_Ring/trigger_checkpoint`,
 * carrying `Trigger_FinishLine` — whose `OnTriggerEnter` on tag "Player" calls
 * `finaleLogic.StartEnd()` -> `LevelEnd` StopShip + CalcScore + NextLevel.
 *
 * It is **three SphereColliders**, not a plane: r 0.92 at the origin and two
 * r 0.43 offset, against a world scale of (65.661, 74.554, 4.182). Unity sizes
 * a SphereCollider by `radius * max|lossyScale|`, so that is a **68.59 m** ball
 * plus two 32.06 m ones — identical on all seven HoverJet missions, with only
 * the position differing. The 65.7 x 74.6 x 4.2 figure that looks like a thin
 * gate is the TRANSFORM'S SCALE, and reading it as a collider extent would give
 * a flat plane you could fly around.
 *
 * It does not score: `TriggerCheckpoint` appears zero times in the prefab, its
 * tag is Untagged so `Trigger_Race`'s tag sweep misses it, and it is not one of
 * the 21 rings (those hang off `CurvyClonePath`; this hangs off
 * `RingAttack_objects` directly). So it must NEVER enter `ringsPassed`.
 *
 * Null for a mission that has none — the JumpSeat levels have no such instance.
 */
const expandedCache = new Map()
function loadSceneExpanded(absPath) {
  const key = absPath.replace(/\\/g, '/')
  if (expandedCache.has(key)) return expandedCache.get(key)
  const flat = extract(absPath, {
    project: SRC,
    guidIndex: guidIndex(),
    resolvePrefabs: true,
    expandPrefabs: true,
  })
  expandedCache.set(key, flat)
  return flat
}

function readFinish(absPath) {
  const ringAttack = readFinishSphereUnion(absPath)
  const jumpSeat = readFinishConvexMesh(absPath)
  if (ringAttack && jumpSeat) {
    throw new Error(
      `extract:levels: ${absPath} has BOTH a Trigger_FinishLine gate and a ` +
        'Trigger_Finish_JumpSeat gate live. Two things that end the run is ambiguous.',
    )
  }
  return ringAttack ?? jumpSeat
}

function readFinishSphereUnion(absPath) {
  const flat = loadSceneExpanded(absPath)
  // Under the RING-ATTACK parent specifically. The dead `RaceObjects/Trigger_FinishLine`
  // decoy sits elsewhere and is `activeInHierarchy: false` anyway; so are the two extra
  // `trigger_finishLine` boxes inside the prefab itself. The liveness filter is what
  // separates the one live gate from the three dead ones.
  const live = flat.objects.filter(
    (o) =>
      o.activeInHierarchy &&
      /RingAttack_objects\/FinishLine\//.test(o.path || '') &&
      (o.scripts || []).some((sc) => sc.name === 'Trigger_FinishLine') &&
      (o.components || []).some((c) => c.type === 'SphereCollider' && c.isTrigger),
  )
  if (!live.length) return null
  if (live.length > 1) {
    throw new Error(
      `extract:levels: ${live.length} live finish gates in ${absPath}. ` +
        'Exactly one is expected; a second would make "the run ended" ambiguous.',
    )
  }
  const t = live[0]
  const sc = t.world.scale
  const maxScale = Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z))
  const spheres = (t.components || []).filter((c) => c.type === 'SphereCollider' && c.isTrigger)
  return {
    shape: 'sphereUnion',
    pos: toThreePos(t.world.position),
    quat: toThreeQuat(t.world.rotation),
    // The BIGGEST sphere is the one that ends the run in practice; the other two
    // are inside it. Kept as a scalar for the common test, with the full union
    // below for anyone who wants exactness.
    radius: r6(Math.max(...spheres.map((c) => Number(c.radius) || 0)) * maxScale),
    spheres: spheres.map((c) => ({
      radius: r6((Number(c.radius) || 0) * maxScale),
      center: [
        r6(Number(c.center.x) || 0),
        r6(Number(c.center.y) || 0),
        r6(-(Number(c.center.z) || 0)),
      ],
    })),
    art: readFinishArt(flat, t),
    _meta: {
      fileID: t.key,
      path: t.path,
      scripts: (t.scripts || []).map((x) => x.name),
      worldScale: [r6(sc.x), r6(sc.y), r6(sc.z)],
      raw: { pos: rawPos(t.world.position), quat: rawQuat(t.world.rotation) },
      note:
        'Ends the run via Trigger_FinishLine.OnTriggerEnter -> finaleLogic.StartEnd(). ' +
        'Non-scoring: never counted in ringsPassed/ringsTotal.',
    },
  }
}

/**
 * What the finish gate LOOKS like — the part of `FinishLine.prefab` that draws.
 *
 * DEV-123. For the whole life of the port the finish was a 68.59 m trigger
 * sphere and nothing else: `game/rings.ts` draws `routes[0].rings` and the
 * finish is not one of them, so the player flew through ring 21 and the run
 * ended 234.6 m later at an invisible ball. Matt's note — *"end gate doesn't
 * look unique"* — was about the last RING, because there was nothing else to
 * see.
 *
 * 2016 drew one, and it is not a ring dressed up. Under the same
 * `Checkpoint_Ring` node that carries the trigger:
 *
 *   jumpGate_diamond     the SAME mesh a ring wears, at world scale **23.56**
 *                        (a ring's is 7.77 — three times the gate), wearing
 *                        `checkpoint_finish.mat`: ORANGE (1, 0.62, 0.15) at
 *                        0.709 alpha with a warm (1, 0.93, 0.64) glow, where a
 *                        ring is green. Its Animator has no controller — dead.
 *   highlightCubes (1)   **40** live built-in cubes on `glowyMaterial`, not a
 *                        ring's 18: a 24-cube cage plus four groups of four
 *                        84-102 m bars fanned out from the corners.
 *   TriangularJumpgate2Green_pwm   a second, bought frame — `m_IsActive: 0`,
 *                        and a Materialized Mesh besides, so it could not ship
 *                        even if it were on.
 *
 * Emitted as WORLD poses in three space, one per renderer, rather than as a
 * prefab-local chain like `props.checkpointRing`: the studs sit under four
 * intermediate `GameObject (n)` pivots with their own rotations, and the
 * expanded scene has already composed every one of them — including any
 * `m_Modifications` the stripped instance carries. Composing them again in the
 * game would be a second copy of the same arithmetic (the orientation lesson,
 * §5). The material paths are recorded so the game can assert it is drawing
 * the finish in the finish's colour rather than a ring's.
 */
function readFinishArt(flat, trigger) {
  // The ring root is the trigger's parent: `.../FinishLine/Checkpoint_Ring`.
  const root = String(trigger.path || '').replace(/\/[^/]+$/, '')
  const under = flat.objects.filter(
    (o) => o.activeInHierarchy && String(o.path || '').startsWith(`${root}/`),
  )
  const renderers = under.filter((o) =>
    (o.components || []).some((c) => c.type === 'MeshRenderer' && c.enabled !== 0),
  )
  const pose = (o) => ({
    pos: toThreePos(o.world.position),
    quat: toThreeQuat(o.world.rotation),
    scale: [r6(o.world.scale.x), r6(o.world.scale.y), r6(o.world.scale.z)],
  })
  const materialOf = (o) => {
    const mr = (o.components || []).find((c) => c.type === 'MeshRenderer')
    return String(mr?.materials?.[0]?.path ?? '')
  }
  const meshOf = (o) => (o.components || []).find((c) => c.type === 'MeshFilter')?.mesh

  const frames = renderers.filter((o) => o.name === 'jumpGate_diamond')
  if (frames.length !== 1) {
    throw new Error(
      `extract:levels: ${frames.length} live "jumpGate_diamond" under ${root}. ` +
        'The finish gate has exactly one frame, or it is not the finish gate.',
    )
  }
  const frame = frames[0]
  const frameMaterial = materialOf(frame)
  if (!/checkpoint_finish\.mat$/.test(frameMaterial)) {
    throw new Error(
      `extract:levels: the finish frame under ${root} wears "${frameMaterial}", not ` +
        "checkpoint_finish.mat. A finish in a ring's colour is new information, not a default.",
    )
  }
  // Built-in cube: fileID 10202 with no guid. A Cube that is NOT the built-in
  // mesh is something else wearing the name.
  const studs = renderers.filter(
    (o) => /^Cube( \(\d+\))?$/.test(o.name || '') && String(meshOf(o)?.fileID) === '10202',
  )
  if (studs.length === 0) {
    throw new Error(`extract:levels: no live studs under ${root} — the finish cage is missing`)
  }
  const studMaterials = new Set(studs.map(materialOf))
  if (studMaterials.size !== 1) {
    throw new Error(
      `extract:levels: the finish studs under ${root} wear ${studMaterials.size} materials ` +
        `(${[...studMaterials].join(', ')}); one is expected`,
    )
  }
  // Stable order: by path, which is unique per stud and does not depend on the
  // order the YAML happened to serialise the prefab.
  studs.sort((a, b) => (String(a.path) < String(b.path) ? -1 : 1))
  return {
    frame: {
      mesh: String(meshOf(frame)?.path ?? ''),
      material: frameMaterial,
      ...pose(frame),
    },
    studMaterial: [...studMaterials][0],
    studs: studs.map(pose),
    _meta: {
      root,
      frameFileID: frame.key,
      // What was under the root and did NOT draw — so a future reader knows
      // the bought triangular frame was seen and left out, not missed.
      inactiveRenderers: flat.objects
        .filter(
          (o) =>
            !o.activeInHierarchy &&
            String(o.path || '').startsWith(`${root}/`) &&
            (o.components || []).some((c) => c.type === 'MeshRenderer'),
        )
        .map((o) => o.name),
    },
  }
}

/**
 * The JumpSeat's finish gate -- and the stripped-prefab trap for the third time.
 *
 * ── Why `finish` was null on six missions ─────────────────────────────────
 *
 * It is not a scene object. `Trigger_Finish_JumpSeat` lives INSIDE
 * `target_jumppad.prefab`, on `finale_jumpSeat (1)/trigger_finishLevel`, which
 * the prefab authors **inactive**; exactly one pad instance per mission carries
 * an `m_IsActive` override switching it on. So a name search over the scene
 * finds nothing, a sweep of the scene's materialised colliders finds nothing,
 * and `loadScene`'s `expandPrefabs: false` cannot see into it at all. All three
 * negatives are real and all three are wrong -- the same shape as DEV-045.
 *
 * The counts say how well hidden it was: `adv_02_jumpSeat` serialises 26
 * `Trigger_Finish_JumpSeat` components and ONE of them is live.
 *
 * ── It is a CONVEX MESH, not a sphere union and not a box ─────────────────
 *
 * The collider is a convex `MeshCollider` over
 * `Assets/Faceted Flight/Meshes/hexTile.fbx`, `isTrigger: 1`, on a transform
 * scaled (15.953, 11.305, 15.953) in every one of the six. A MeshCollider
 * carries no size, so the extent only exists in the FBX -- which is why
 * `fbx-bounds.mjs` exists. Measured: the file's own AABB is 19.021 x 5.000 x
 * 18.090 at an import scale of 0.1 (`globalScale: 10` x a centimetre file), so
 * the gate is a **30.345 x 5.653 x 28.860 m** slab whose centre sits 2.860 m
 * above and 1.523 m in front of the trigger's origin. The mesh AABB is NOT
 * centred on its origin, so that offset is load-bearing.
 *
 * `hull` carries the ten vertices because the collider is CONVEX: `half` is the
 * bounding box of a hull, an over-approximation, and a runtime that wants the
 * true shape has the points. `radius` is the bounding sphere -- a broad phase,
 * and deliberately NOT the gate.
 */
function readFinishConvexMesh(absPath) {
  const flat = loadSceneExpanded(absPath)
  const live = flat.objects.filter(
    (o) =>
      o.activeInHierarchy &&
      (o.scripts || []).some((sc) => sc.name === 'Trigger_Finish_JumpSeat') &&
      (o.components || []).some((c) => c.type === 'MeshCollider' && c.isTrigger),
  )
  if (!live.length) return null
  if (live.length > 1) {
    throw new Error(
      `extract:levels: ${live.length} live Trigger_Finish_JumpSeat gates in ${absPath}. ` +
        'Exactly one pad per mission carries the m_IsActive override that switches it on.',
    )
  }
  const t = live[0]
  const col = (t.components || []).find((c) => c.type === 'MeshCollider' && c.isTrigger)
  const meshRel = col.mesh?.path
  if (!meshRel) {
    throw new Error(`extract:levels: the finish MeshCollider in ${absPath} names no mesh asset`)
  }
  const bounds = fbxMeshBounds(path.join(SRC, meshRel))
  const s = t.world.scale
  const half = [
    r6((bounds.size[0] / 2) * Math.abs(s.x)),
    r6((bounds.size[1] / 2) * Math.abs(s.y)),
    r6((bounds.size[2] / 2) * Math.abs(s.z)),
  ]
  // The mesh's own centre, scaled and rotated into the world -- Unity space in,
  // three space out, so the z flip happens exactly once.
  const offsetUnity = qRotate(t.world.rotation, {
    x: bounds.center[0] * s.x,
    y: bounds.center[1] * s.y,
    z: bounds.center[2] * s.z,
  })
  const centreUnity = {
    x: t.world.position.x + offsetUnity.x,
    y: t.world.position.y + offsetUnity.y,
    z: t.world.position.z + offsetUnity.z,
  }
  return {
    shape: 'convexMesh',
    // The COLLIDER's centre, not the GameObject's origin. The two are 3.2 m
    // apart, which on a 5.7 m-thick slab is most of its thickness.
    pos: toThreePos(centreUnity),
    quat: toThreeQuat(t.world.rotation),
    // BROAD PHASE. See the type in `src/content/level-schema.ts`.
    radius: r6(Math.hypot(half[0], half[1], half[2])),
    mesh: meshRel,
    convex: true,
    half,
    // LOCAL to the gate, like `spheres[].center` on the other variant: scaled,
    // relative to `pos`, and NOT rotated — `quat` is what rotates them. Emitting
    // them in world space instead makes `half` and `hull` two different frames,
    // and their AABBs then disagree on any mission whose pad has a yaw
    // (`adv_01_jumpSeat` by 11 cm, which is small enough to read as rounding).
    hull: bounds.vertices.map((v) =>
      toThreePos({
        x: (v[0] - bounds.center[0]) * s.x,
        y: (v[1] - bounds.center[1]) * s.y,
        z: (v[2] - bounds.center[2]) * s.z,
      }),
    ),
    _meta: {
      fileID: t.key,
      path: t.path,
      scripts: (t.scripts || []).map((x) => x.name),
      worldScale: [r6(s.x), r6(s.y), r6(s.z)],
      /** The GameObject's origin, for comparison with `pos` (the collider centre). */
      originPos: toThreePos(t.world.position),
      meshLocalSize: bounds.size.map((n) => r6(n)),
      meshLocalCenter: bounds.center.map((n) => r6(n)),
      meshImportScale: bounds.importScale,
      meshVertexCount: bounds.vertexCount,
      raw: { pos: rawPos(centreUnity), quat: rawQuat(t.world.rotation) },
      note:
        'Ends the run via Trigger_Finish_JumpSeat.OnTriggerEnter (tag Player) -> ' +
        'TriggerLevelEnd(). Lives inside target_jumppad.prefab, authored INACTIVE, and ' +
        'switched on by an m_IsActive override on exactly one pad instance per mission.',
    },
  }
}

function readRings(scene, modeParentKeys) {
  const triggers = withScript(scene, 'TriggerCheckpoint')
  const live = []
  for (const o of triggers) {
    const s = scriptOn(o, 'TriggerCheckpoint')
    if (num(fieldOf(s, 'm_Enabled') ?? s.enabled) === 0) continue
    if (num(fieldOf(s, 'addScore')) === 0 || fieldOf(s, 'addScore') === undefined) continue
    if (!liveInHierarchy(scene, o, modeParentKeys)) continue
    live.push({ obj: o, script: s })
  }

  // Walk up to the clone root: the ancestor whose name matches NNNN<something>(Clone),
  // falling back to the ancestor tagged Checkpoint.
  const rings = []
  for (const { obj, script } of live) {
    let root = obj
    let guard = 0
    while (root && guard++ < 8) {
      if (/^\d{4}/.test(root.name || '')) break
      const p = root.parent ? scene.byKey.get(root.parent) : null
      if (!p) break
      root = p
    }
    if (!/^\d{4}/.test(root.name || '')) {
      // no numbered ancestor: use the tagged one, else the trigger itself
      let t = obj
      let g = 0
      while (t && g++ < 8 && t.tag !== 'Checkpoint') t = t.parent ? scene.byKey.get(t.parent) : null
      root = t || obj
    }
    const idx = /^(\d{4})/.exec(root.name || '')
    const routeKey = root.parent || 'root'
    const routeNode = scene.byKey.get(routeKey)
    rings.push({
      order: idx ? Number(idx[1]) : rings.length,
      routeId: routeNode ? routeNode.name : 'route',
      routeKey,
      root,
      trigger: obj,
      script,
    })
  }

  // group into routes, order within each
  const byRoute = new Map()
  for (const r of rings) {
    if (!byRoute.has(r.routeKey)) byRoute.set(r.routeKey, [])
    byRoute.get(r.routeKey).push(r)
  }
  const routes = []
  for (const [key, list] of byRoute) {
    list.sort((a, b) => a.order - b.order || (a.root.path < b.root.path ? -1 : 1))
    const node = scene.byKey.get(key)
    routes.push({
      id: node ? node.name : key,
      _key: key,
      _path: node ? node.path : null,
      rings: list.map((r, i) => ringJson(r, i)),
    })
  }
  // stable, and the biggest route first. This ORDERS the groups; it does not choose
  // the course -- `selectCourse` does, because on adv_01 the two groups are the same
  // length and this tiebreak is alphabetical (DEV-210).
  routes.sort((a, b) => b.rings.length - a.rings.length || (a.id < b.id ? -1 : 1))
  return routes
}

/**
 * THE COURSE, when a scene holds more than one LIVE ring group (DEV-210).
 *
 * ── The bug this exists to stop ───────────────────────────────────────────
 *
 * `adv_01_hoverJet.unity` has three `NNNNCheckpoint_Ring(Clone)` groups under
 * `levelOffset/RingAttack_objects`:
 *
 *   CurvyClonePath  m_IsActive: 1   22 rings   <- the course
 *   route_adv_01    m_IsActive: 1   22 rings   <- authoring debris, left ACTIVE
 *   CurvyClonePath  m_IsActive: 0   28 rings   <- adv_02's course, deactivated
 *
 * The liveness walk above is RIGHT about all three: `route_adv_01` genuinely is
 * `m_Enabled: 1`, `addScore: 1`, whole `m_Father` chain active. 2016 really did
 * ship 44 live scoring triggers in this scene. So this is not a liveness bug and
 * no amount of more liveness walking finds it — the third group proves the author
 * deactivated debris when they remembered to, and `route_adv_01` is the one they
 * forgot.
 *
 * What was wrong was the INTERPRETATION: this file used to call live sibling
 * groups "alternate routes". There is no such mechanic — `triggerNextRoute` is
 * false on all 44 rings and no 2016 script picks between groups.
 *
 * ── Why the spline, and not the name or the size ──────────────────────────
 *
 * The clones were BUILT along a Curvy spline by `SplinePathCloneBuilder`, so
 * "sits on the live spline" is the one property the course has by construction
 * and a leftover cannot acquire. Every other criterion available here fails:
 *
 *  - **Size** ties, 22 v 22.
 *  - **Name** points the WRONG WAY. `CurvyClonePath` is the builder's own output
 *    name and is the live course group in all eight other ring courses;
 *    `route_adv_01` is the hand-typed one and is the debris. The sort above then
 *    lands on the right group by an alphabetical accident
 *    (`'CurvyClonePath' < 'route_adv_01'`) — rename the group in Unity and the
 *    renderer would draw the phantom.
 *
 * Measured on adv_01, mean distance from each ring to the nearest spline point:
 * **8.3 m** for `CurvyClonePath` against **2,014.9 m** for `route_adv_01`. The
 * other seven HoverJet courses fit their spline at 3.6-8.7 m, so the threshold
 * has two orders of magnitude of daylight either side.
 *
 * Five further anchors, each authored separately in 2016, agree — see the
 * DEV-210 row in `docs/DEVIATIONS.md`, including two RECORDED 2016 flights of
 * this mission that pass through every `CurvyClonePath` gate and never come
 * within 2 km of a `route_adv_01` one.
 *
 * ── It refuses rather than guesses ────────────────────────────────────────
 *
 * A scene with no live spline, or one where the spline does not SEPARATE the
 * groups, throws. Picking the first group would be the same class of silent
 * wrong answer this function was written to remove, and CLAUDE.md's rule is that
 * when a candidate set fails to separate, the evidence is refused. Only the
 * multi-group case is judged at all: a single group is the course whether or not
 * this scene has a spline (`rookie_02_jumpSeat`'s spline is 1,429 m from its
 * rings and is not a ring path at all).
 */
const COURSE_FIT_MAX_M = 50 // the worst shipped course fits its spline at 8.7 m
const COURSE_REJECT_MIN_M = 250 // the debris sits 2,015 m off it
function selectCourse(routes, route, missionId) {
  const dropped = []
  if (routes.length <= 1) return { routes, dropped, fits: null }

  const pts = route?.points ?? []
  if (!pts.length) {
    throw new Error(
      `${missionId}: ${routes.length} live ring groups ` +
        `(${routes.map((r) => `${r.id}/${r.rings.length}`).join(', ')}) and no live Curvy ` +
        'spline to choose between them. Refusing to guess which is the course (DEV-210).',
    )
  }

  // Mean distance from each ring to the nearest point of the spline polyline. Point-to-POINT,
  // not point-to-segment: the polyline is ~20 points per control point, so its spacing is
  // metres where the numbers that matter here are hundreds of metres. (DEV-027's lesson is
  // about quoting such a number as a distance to the LINE; this one is only ever compared
  // against another of its own kind, and the separation is 240x the threshold.)
  const fitOf = (r) =>
    r.rings.reduce((sum, ring) => {
      let best = Infinity
      for (const p of pts) {
        const dx = ring.pos[0] - p[0]
        const dy = ring.pos[1] - p[1]
        const dz = ring.pos[2] - p[2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < best) best = d2
      }
      return sum + Math.sqrt(best)
    }, 0) / Math.max(r.rings.length, 1)

  const fits = routes.map((r) => ({ id: r.id, rings: r.rings.length, fit: fitOf(r) }))
  const ranked = [...fits].sort((a, b) => a.fit - b.fit)
  const [best, ...rest] = ranked
  const decisive = best.fit <= COURSE_FIT_MAX_M && rest.every((o) => o.fit >= COURSE_REJECT_MIN_M)
  if (!decisive) {
    throw new Error(
      `${missionId}: the live Curvy spline does not separate ${routes.length} live ring ` +
        `groups — ${fits.map((o) => `${o.id} ${o.fit.toFixed(1)}m`).join(', ')} ` +
        `(need best <= ${COURSE_FIT_MAX_M} m and every other >= ${COURSE_REJECT_MIN_M} m). ` +
        'Refusing to guess which is the course (DEV-210).',
    )
  }

  const course = routes.find((r) => r.id === best.id)
  for (const o of rest) {
    const r = routes.find((x) => x.id === o.id)
    dropped.push({
      id: r.id,
      path: r._path,
      rings: r.rings.length,
      splineFitM: Number(o.fit.toFixed(3)),
      why:
        'live in the scene (m_Enabled 1, addScore 1, parent chain active) but NOT on the ' +
        'Curvy spline the ring clones were built along — 2016 authoring debris left active. ' +
        'See DEV-210.',
    })
  }
  return {
    routes: [course],
    dropped,
    fits: fits.map((o) => ({ ...o, fit: Number(o.fit.toFixed(3)) })),
  }
}

function ringJson(r, i) {
  const trig = r.trigger
  const root = r.root
  // The gate's trigger volume: the largest SphereCollider on the trigger object, scaled by
  // the trigger's world scale (Unity scales a SphereCollider by max|scale| component).
  const spheres = (trig.components || []).filter((c) => c.type === 'SphereCollider')
  const s = trig.world.scale
  const maxScale = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))
  const radius = spheres.length
    ? r6(Math.max(...spheres.map((c) => Number(c.radius) || 0)) * maxScale)
    : null
  return {
    i,
    order: r.order,
    name: root.name,
    pos: toThreePos(root.world.position),
    quat: toThreeQuat(root.world.rotation),
    scale: [r6(root.world.scale.x), r6(root.world.scale.y), r6(root.world.scale.z)],
    trigger: {
      pos: toThreePos(trig.world.position),
      quat: toThreeQuat(trig.world.rotation),
      radius,
      spheres: spheres.map((c) => ({
        radius: r6((Number(c.radius) || 0) * maxScale),
        center: [
          r6(Number(c.center.x) || 0),
          r6(Number(c.center.y) || 0),
          r6(-(Number(c.center.z) || 0)),
        ],
      })),
    },
    scoring: {
      addScore: num(fieldOf(r.script, 'addScore')) ?? 0,
      energyBoost: bool(fieldOf(r.script, 'energyBoost')) ?? false,
      energyBoostAmount: CODE_CONSTANTS.energyBoostAmount,
      triggerOnce: bool(fieldOf(r.script, 'triggerOnce')) ?? true,
      silent: bool(fieldOf(r.script, 'silent')) ?? false,
      triggerNextRoute: bool(fieldOf(r.script, 'triggerNextRoute')) ?? false,
    },
    _meta: {
      ringFileID: root.key,
      triggerFileID: trig.key,
      triggerCheckpointFileID: r.script.fileID || null,
      path: root.path,
      raw: { pos: rawPos(root.world.position), quat: rawQuat(root.world.rotation) },
    },
  }
}

/* -- DEV-067: the five kauai orbs that are inside the mountain --------------------- */
//
// Matt, 2026-09-13: *"fix kauai's buried orbs."*
//
// `hoverJet_kauai_beg` is `forceGameMode` Free Flight, and 2016 built it by
// copying `int_01_hoverJet` onto a second island. The eleven-orb
// `freeFlight_objects` scatter came across BYTE-IDENTICAL -- every `_meta.raw.pos`
// matches int_01's -- but simonet is mostly open water (the height field under
// eight of the eleven reads -21.5 .. +2.6, i.e. sea floor) and kauai is one
// mountain (+68 .. +702 under the same eleven). So five of them finish INSIDE the
// island: -619.0, -556.4, -227.6, -183.3, -62.1 m of clearance.
//
// That is 2016's own bug, not a port artifact -- DEV-062 confirmed it against
// `terrain_kauai_FacetedChunks.asset` with UnityPy (orbs worst -619.6 in 2016's
// own bake against our -619.0) and confirmed the island itself is placed right.
// What makes it matter here rather than there is that Free Flight SCORES orbs
// and `src/sim/terrain-collision.ts` depenetrates the hull out of the ground, so
// five of the eleven things the HUD counts cannot be reached at all.
//
// ── What moves, and what does NOT ────────────────────────────────────────────
//
// `pos` below stays exactly what 2016 authored, and so does `_meta.raw.pos`.
// `posFf2` is a SEPARATE field carrying the position FF2 actually flies at --
// the same deal `medalsFf2` makes with `medals` (DEV-004), for the same reason:
// the ledger keeps a faithful record and the game keeps working content.
//
// Only orbs the mission's RUNNING MODE can collect are corrected. That is why
// `int_01_hoverJet` keeps its own two buried orbs (-144.2, -115.0) untouched:
// it is Ring Attack, `MODES.ringAttack.live` has no `orb`, so `boot/app.ts`
// neither draws nor collects them. They are 2016 data at rest, not broken
// content. Exactly one shipped mission is touched by this table.
//
// ── The number, and what it is the measure OF (DEV-027) ──────────────────────
//
// `floorM` is the SMALLEST clearance, over this mission's own eleven live orbs,
// between an orb centre and the height field directly beneath it, counting only
// the six that are above it. In words: the closest 2016 itself lets one of this
// mission's orbs come to kauai's ground. It is orb `EnergyOrb` (i=0).
//
// Min, not median or mean, and the reason is a theorem rather than a taste:
// because `floorM` IS the minimum of the above-ground clearances, the clamp
// `y <- max(y, ground + floorM)` moves exactly the buried orbs and provably
// nothing else -- every orb 2016 placed above the ground already clears by at
// least `floorM`, so the clamp is a no-op on it. A larger floor would move orbs
// 2016 got right; a smaller one would leave the rescued ones closer to kauai
// than 2016 ever put one. Minimal and sufficient, and only one value is both.
// (The median of those six is 917 m -- these orbs are a 3 km-tall scatter, not a
// ground-hugging one, so an average is meaningless here.)
//
// Corroboration, two ways: the same statistic on the SAME eleven orbs over
// simonet is 40.63 m, within 15% of this; and over every live orb in the shipped
// game (122 of them) the tightest any orb sits above ground is 13.06 m, so 35.35
// sits inside the population rather than at its edge.
//
// ── Why the numbers are carried here instead of computed here ────────────────
//
// `groundM` is the height field under each buried orb, and this file cannot
// measure it: the surface is `src/sim/terrain/height-field.ts` fed by a 969 KB
// PNG that lives on R2, and the extractor must stay runnable from the Unity
// project alone (CI has neither). Reimplementing `buildHeightField` in .mjs
// would be a SECOND copy of the terrain rule, which is the drift hazard
// `src/game/mission-shape.ts` was written to warn about.
//
// So the measurements are carried, and `tests/unit/orb-floor.test.ts` RE-DERIVES
// both `floorM` and every `groundM` against the real height field on every run
// and fails if this table has drifted by more than a centimetre. A derived
// number in a comment needs a test (DEV-027); this one has one.
const DEV_067_ORB_FLOOR = {
  hoverJet_kauai_beg: {
    /** The closest 2016 lets one of this mission's own live orbs come to kauai's ground. */
    floorM: 35.346729,
    /**
     * `_meta.fileID` -> the height field directly under that orb, metres.
     *
     * Keyed by 2016's own object id rather than by the emitted `i`, which is an
     * index into a name sort and would shuffle if the sort ever changed.
     */
    groundM: {
      1197013962: 68, // EnergyOrb 11  (i=3)  clearance -227.6
      1001774166: 400.863613, // EnergyOrb 2   (i=4)  clearance -183.3
      10143542: 638.150578, // EnergyOrb 3   (i=5)  clearance -619.0
      1978276330: 702.46122, // EnergyOrb 4   (i=6)  clearance  -62.1
      1045150226: 432.008901, // EnergyOrb 7   (i=9)  clearance -556.4
    },
  },
}

/**
 * Energy orbs -- EnergyOrb.prefab instances, normally under Level.freeFlightParent.
 *
 * Emits BOTH the placed set and the live set. The audit's per-scene orb counts are RAW
 * placements (it applied its liveness rule only to rings), and two shipped scenes disagree
 * with themselves: int_02_hoverJet and adv_01_hoverJet place 12 orbs each under an ACTIVE
 * `freeFlight_objects` and then set `m_IsActive: 0` on every one of them. `live` is the
 * number a player can actually collect; `placed` is what the audit counted. Reporting one
 * and hiding the other is how a 12-vs-0 disagreement becomes a silent content bug.
 *
 * `posFf2` is DEV-067 and is null on every orb of every other mission -- see the block
 * above this function.
 */
function readOrbs(scene, modeParentKeys, levelId) {
  const out = []
  const fix = DEV_067_ORB_FLOOR[levelId] ?? null
  const used = new Set()
  const cands = placementsOf(scene, /EnergyOrb\.prefab$/i, /^EnergyOrb\b/i)
  for (const o of cands) {
    const s = scriptOn(o, 'Trigger_Magnet')
    const live = o.active !== false && liveInHierarchy(scene, o, modeParentKeys)
    const pos = toThreePos(o.world.position)
    // A dead orb is never drawn and never collected, so it is never corrected.
    const ground = fix && live ? fix.groundM[o.key] : undefined
    if (ground !== undefined) used.add(String(o.key))
    out.push({
      name: o.name,
      live,
      pos,
      /** DEV-067. Null means "2016 got this one right"; `pos` is then the flown position. */
      posFf2: ground === undefined ? null : [pos[0], r6(ground + fix.floorM), pos[2]],
      speed: num(fieldOf(s, 'speed')) ?? 0.25,
      _meta: {
        fileID: o.key,
        path: o.path,
        selfActive: o.active,
        magnetComponentEnabled: s ? num(fieldOf(s, 'm_Enabled') ?? s.enabled) !== 0 : null,
        raw: { pos: rawPos(o.world.position) },
        ff2:
          ground === undefined
            ? null
            : {
                deviation: 'DEV-067',
                groundM: ground,
                floorM: fix.floorM,
                liftM: r6(ground + fix.floorM - pos[1]),
                note:
                  'raised straight up -- x and z are 2016 and do not move. `groundM` is the ' +
                  'height field under this orb; `floorM` is the least clearance 2016 gives a ' +
                  'live orb on this island. Re-derived by tests/unit/orb-floor.test.ts.',
              },
      },
    })
  }
  // A table entry that matched nothing is a stale correction pointing at an orb that
  // has been renumbered, deactivated or removed -- silence there would ship five
  // buried orbs again with every test still green.
  if (fix) {
    const missed = Object.keys(fix.groundM).filter((k) => !used.has(k))
    if (missed.length) {
      throw new Error(
        `DEV-067: ${levelId} has no LIVE orb with fileID ${missed.join(', ')}; the correction table is stale`,
      )
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out.map((o, i) => ({ i, ...o }))
}

/**
 * The environment's clouds -- `GL-Cloud-*` under `clouds` in the level-art prefab.
 *
 * Placements only. The MESHES are `Assets/Geometric-Landscape-Tropic-Island`,
 * a bought pack, so they are `licence: REPLACE` and can never ship (D26, the
 * same bucket as the pilot and the seat). What is portable is where the clouds
 * are, how big, and which of the three source meshes each one wore -- and that
 * is what makes a first-party generator a re-skin rather than an invention.
 *
 * ── TWO shapes of environment scene, and only one was ever handled ────────
 *
 * The four shipped environments are authored two different ways, and until
 * DEV-048 this reader only knew one of them:
 *
 *   INSTANTIATED  simonet, desert -- the scene is 6 and 4 nodes, and the art is
 *                 a placed `Prefabs/Levels/LevelArt_<env>.prefab`. The clouds
 *                 live in the PREFAB and must be composed through the instance's
 *                 own world pose, which is (-2048, 0, -2048) in BOTH cases (for
 *                 different reasons -- see DEV-042: simonet hangs under a
 *                 `levelOffset` node and desert has none and is placed there
 *                 directly).
 *
 *   BAKED         alpine, kauai -- the scene IS the art, 18,650 and 8,314 nodes
 *                 of it, instantiating no level-art prefab at all. The clouds
 *                 are plain scene GameObjects under
 *                 `levelOffset/LevelArt_<env>/art/clouds`, and their `world`
 *                 pose is already world space: composing anything through them
 *                 would move them 2 km.
 *
 * The old reader started at `find(prefab instance)` and returned `[]` when there
 * was none. `constants.mjs:crossCheckEnvironment` had already recorded the
 * Alpine surprise, and the comment here said an environment that stopped
 * instantiating the prefab "would simply stop reporting clouds" -- which was a
 * description of the bug, written as if it were a property. Alpine reported 0
 * against 8 live and Kauai 0 against 19, for the whole life of the port. This is
 * the same shape as the stripped-prefab trap in CLAUDE.md: **a reader that
 * returns nothing is indistinguishable from a scene that contains nothing**, and
 * the honest-sounding sentence in the old comment is what made it survive.
 *
 * Simonet's 19 and desert's 3 are unchanged by the fix, which is the point of
 * printing all four: desert's 3 is not a half-firing bug, it is 6 authored
 * clouds with `GL-Cloud-01`, `-03` and `-06` switched off in the prefab.
 *
 * ── Three meshes, no animation ───────────────────────────────────────────
 *
 * The names run `GL-Cloud-01` .. `GL-Cloud-06 (2)` but only three distinct
 * meshes are used across the four environments. The variety is all in the
 * non-uniform scale -- 182 m to 981 m across, with y typically 20-50% of x, so
 * they are flattened slabs rather than balls. None of them carries an Animator
 * or an Animation, so the clouds do not drift; `slow_rotate_clouds.anim` exists
 * in the project and is used somewhere else.
 */
/**
 * Props the MISSION scene places itself -- DEV-218, and DEV-219 for the palms.
 *
 * ── Why nothing had ever seen these ──────────────────────────────────────
 *
 * Three of the thirteen place scenery in their own scene, as Unity 5 STRIPPED
 * PREFAB INSTANCES: a `!u!1001` block plus a stripped Transform, with the
 * GameObject names and the colliders living in the `.prefab`. `loadScene` runs
 * `expandPrefabs: false`, so the flattener stops at the instance boundary and
 * this reader cannot use it -- the same shape as DEV-045's finish gate and the
 * JumpSeat gate, for the third and fourth time. Hence `loadSceneExpanded`.
 *
 * **A raw guid count is not an instance count.** `adv_01_jumpSeat` names the
 * `Spire_B_w_Collision` guid twenty times and places ONE spire; the other
 * nineteen are `m_Modifications` targets. `rookie_02_jumpSeat` names
 * `DesertSpires.prefab` ninety-six times, once.
 *
 * ── The double-emission trap ─────────────────────────────────────────────
 *
 * With `expandPrefabs: true` a prefab instance ROOT arrives TWICE: once as
 * `kind: 'stripped'` (the scene's own stripped Transform) and once as
 * `kind: 'prefabAncestor'` or `'prefabChild'` (the prefab's root, expanded).
 * Same path, same world transform, same mesh, different `key`. Counting
 * naively doubles every instance root, which is why the dedup below is on
 * (path, world position) and not on `key`.
 *
 * ── The frame, verified rather than reasoned ─────────────────────────────
 *
 * `o.world` is mission-scene world space. `levelOffset` sits at Unity
 * (-2048, 0, -2048) -- this mission's own `worldOffset` -- and that is also
 * where the environment's LevelArt root sits, so subtracting it lands a mission
 * prop in exactly the frame `content/environments/*.json` landmarks use and
 * `load-props.ts` already consumes.
 *
 * That is a claim about two frames agreeing, so it is MEASURED, not argued:
 * rookie_02's `DesertSpires/Spire_B_w_Collision` lands at (1270, -3, 3020) with
 * scale (8.381, 9.293, 7.451), and desert.json's landmark of that name is at
 * (1270, -3, 3020) scale (8.381242, 9.293119, 7.450506) -- **0.000 m**, with
 * four more exact. A wrong offset misses by ~2048 m, so the two candidate
 * explanations disagree by three orders of magnitude and agreement is evidence.
 * DEV-042 is the row that cost a day by testing a frame only where two stories
 * agreed. `tests/unit/mission-props.test.ts` holds it.
 *
 * ── Which objects are props: the environment's own prop VOCABULARY ───────
 *
 * A mission scene is mostly gameplay -- pads, orbs, rings, ghosts, the elevator
 * shaft, the ship. The rule that separates scenery from it is: **the mesh is one
 * the environment layer already knows as a prop**, i.e. it is named by an
 * environment's landmark or by a scatter palette entry. Those carry `meshAsset`,
 * `kind`, `origin` and `licence` already, so a mission prop needs no second
 * classification and no per-mission code (rule 6).
 *
 * The obvious cheaper rule was tried and is WRONG IN BOTH DIRECTIONS: "the mesh
 * appears anywhere in the environment's art tree" admits `Projector04-Faceted`
 * and the ghost racer's `Mesh1-Combined` on five missions, and misses
 * `int_01_jumpSeat`'s eleven palms entirely, because `GL-Palmtree-03` is in
 * Simonet's scatter PALETTE (a prefab list on a generator component) and never
 * materialises in its art. Provenance does not separate them either:
 * `MM_RocaGrandeLOW` (scenery) and `MM_Corner_Short_01` (the launch platform)
 * are both `LICENSED` Materialized-Mesh bakes under `Assets/Faceted Flight/`.
 *
 * The negative control is the part that makes it believable: across all
 * thirteen the rule selects 1 / 11 / 12 on three missions and **zero on the
 * other ten**. A rule that finds something everywhere it looks has not been
 * tested.
 *
 * ── This is the one place a generated tree reads another ─────────────────
 *
 * The vocabulary comes from `content/environments/*.json`, which
 * `extract:props` writes, so `pnpm extract` runs props BEFORE levels. It is a
 * real dependency and it is declared rather than hidden: a missing environment
 * file throws here instead of silently emitting `props: []`, which is the
 * failure mode this whole row exists to stop.
 */
const propVocabCache = new Map()
function propVocabulary(envId) {
  if (propVocabCache.has(envId)) return propVocabCache.get(envId)
  const abs = path.join(REPO, 'content/environments', `${envId}.json`)
  if (!fs.existsSync(abs)) {
    throw new Error(
      `extract:levels: no content/environments/${envId}.json, so the prop vocabulary for ` +
        `mission props cannot be built. Run \`pnpm extract:props\` first — ` +
        '`pnpm extract` orders props before levels for exactly this reason.',
    )
  }
  const env = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const vocab = new Map()
  for (const l of env.landmarks ?? []) {
    if (l.mesh && !vocab.has(l.mesh)) {
      vocab.set(l.mesh, {
        meshAsset: l.meshAsset ?? null,
        kind: l.kind ?? null,
        origin: l.origin ?? 'unknown',
        licence: l.licence ?? 'CONFIRM',
        from: 'landmark',
      })
    }
  }
  for (const s of env.scatter ?? []) {
    for (const p of s.palette ?? []) {
      if (p.mesh && !vocab.has(p.mesh)) {
        vocab.set(p.mesh, {
          meshAsset: p.meshAsset ?? null,
          kind: p.kind ?? null,
          origin: p.origin ?? 'unknown',
          licence: p.licence ?? 'CONFIRM',
          from: 'palette',
        })
      }
    }
  }
  propVocabCache.set(envId, vocab)
  return vocab
}

/**
 * One mission's own props, in the environment-landmark frame and schema.
 *
 * `live` is the full liveness walk the ring-count rule uses -- the flattener's
 * `activeInHierarchy`, which is `m_IsActive` on the object AND on every
 * ancestor. A dead instance is not content: `rookie_02_jumpSeat` carries four
 * dead `Spire_B_w_Collision` and `int_01_jumpSeat` one dead palm.
 *
 * LOD children are dropped. `int_01_jumpSeat`'s palms each carry an LODGroup
 * (class 205) with `GL-Palmtree-03-LOD2` and `-LOD3` children at the SAME
 * transform; those are variants Unity picks between by distance, not extra
 * geometry, and drawing all three would triple-draw every palm. The root's own
 * MeshFilter is LOD0.
 */
function readMissionProps(absPath, envId, worldOffsetRaw) {
  if (!envId) return []
  const vocab = propVocabulary(envId)
  const flat = loadSceneExpanded(absPath)
  const seen = new Set()
  const rows = []
  for (const o of flat.objects) {
    const mf = (o.components || []).find((c) => c.type === 'MeshFilter' && c.mesh?.path)
    if (!mf) continue
    const entry = vocab.get(mf.mesh.path)
    if (!entry) continue
    // An LOD variant of a parent that is itself a prop: same transform, not
    // extra geometry. Unity picks one by distance; we draw LOD0.
    if (/-LOD\d+$/i.test(o.name ?? '')) continue
    const w = o.world.position
    const k = `${o.path}|${r6(w.x)},${r6(w.y)},${r6(w.z)}`
    if (seen.has(k)) continue
    seen.add(k)
    const solid = (o.components || []).some(
      (c) => /Collider$/.test(c.type) && c.enabled !== false && !c.isTrigger,
    )
    rows.push({
      name: o.name,
      mesh: mf.mesh.path,
      meshAsset: entry.meshAsset,
      kind: entry.kind,
      origin: entry.origin,
      licence: entry.licence,
      live: o.activeInHierarchy === true,
      /** Whether 2016 gave it a non-trigger collider. The palms and most spires did. */
      solid,
      path: o.path,
      position: [
        r6(o.world.position.x - worldOffsetRaw.x),
        r6(o.world.position.y - worldOffsetRaw.y),
        r6(o.world.position.z - worldOffsetRaw.z),
      ],
      rotation: rawQuat(o.world.rotation),
      scale: rawPos(o.world.scale),
    })
  }
  // Stable order: by path, so a regenerated tree is byte-identical.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

function readClouds(envScene) {
  if (!envScene) return []

  const instance = levelArtInstanceRoot(envScene)

  // ── BAKED: the scene carries the art itself ─────────────────────────────
  //
  // No composition, because `o.world` in the scene is already world space --
  // `levelOffset` is one of the ancestors the flattener walked to produce it.
  if (!instance) {
    return cloudRows(envScene, envScene.flat.objects, null, (o) => o.world, null)
  }

  // ── INSTANTIATED: the art is a prefab, placed ───────────────────────────
  const abs = path.join(SRC, instance.prefab.path)
  if (!fs.existsSync(abs)) return []
  let prefabDoc = null
  try {
    prefabDoc = loadScene(abs)
  } catch (_e) {
    return []
  }
  // The instance's own world pose, composed rather than assumed: an environment
  // placed anywhere else would otherwise silently put its clouds at the origin.
  const root = {
    p: instance.world.position,
    q: instance.world.rotation,
    s: instance.world.scale,
  }
  return cloudRows(
    prefabDoc,
    prefabDoc.flat.objects,
    instance.prefab.path,
    (o) => {
      const w = composeWorld(root, o.world)
      return { position: w.p, rotation: w.q, scale: w.s }
    },
    root,
  )
}

/**
 * The ROOT node of the environment's level-art prefab instance, or null.
 *
 * `find()` over "any node whose prefab path matches" was not safe: the flattener
 * materialises an interior node for every prefab-instance override, so desert
 * yields FOUR matching nodes (`LevelArt_Desert`, `/terrain`, `/terrain/Chunk
 * 4,3`, `/terrain/Chunk 4,3/LOD0`) and the answer depended on array order. The
 * root is the shallowest path, and more than one distinct instance id is a
 * scene this reader has not been taught -- so it says so instead of picking.
 */
function levelArtInstanceRoot(envScene) {
  const hits = envScene.flat.objects.filter((o) =>
    /Prefabs\/Levels\/LevelArt_.*\.prefab$/i.test(o.prefab?.path ?? ''),
  )
  if (!hits.length) return null
  const ids = new Set(hits.map((o) => o.prefab.instanceId))
  if (ids.size > 1) {
    throw new Error(
      `extract:levels: ${ids.size} level-art prefab instances in ${envScene.absPath}. ` +
        'One is expected; which one carries the clouds would be a guess.',
    )
  }
  return hits.reduce((best, o) =>
    String(o.path || '').split('/').length < String(best.path || '').split('/').length ? o : best,
  )
}

/** Shared body of both cloud paths — same liveness rule, same row shape. */
function cloudRows(doc, objects, prefabPath, worldOf, root) {
  const out = []
  for (const o of objects) {
    if (!/^GL-Cloud\b/i.test(o.name || '')) continue
    // A MeshFilter is what separates a cloud from a group that holds clouds.
    const filter = (o.components || []).find((c) => c.type === 'MeshFilter')
    if (!filter) continue
    // Liveness: the object and every ancestor. In the BAKED case that walk
    // reaches the scene root; in the INSTANTIATED case it stops at the prefab
    // root, and neither shipped scene overrides a cloud's `m_IsActive`.
    if (o.active === false) continue
    if (!liveInHierarchy(doc, o, new Set())) continue

    const w = worldOf(o)
    out.push({
      name: o.name,
      pos: toThreePos(w.position),
      quat: toThreeQuat(w.rotation),
      scale: [r6(w.scale.x), r6(w.scale.y), r6(w.scale.z)],
      /** Which of the three source silhouettes. A SHAPE HINT, not an asset. */
      shape: cloudShapeOf(filter),
      _meta: {
        fileID: o.key,
        path: o.path,
        /** Null when the clouds are baked into the scene — see `readClouds`. */
        prefab: prefabPath,
        source: prefabPath ? 'levelArtPrefabInstance' : 'bakedIntoEnvironmentScene',
        ...(root ? { instanceOrigin: rawPos(root.p) } : {}),
        raw: { pos: rawPos(w.position) },
      },
    })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out.map((o, i) => ({ i, ...o }))
}

/**
 * Everything the mission says in words, read out of its own ship prefab.
 *
 * ── Why it hangs off the LEVEL and not off a shared table ─────────────────
 *
 * Because that is how 2016 gets it. A mission's UI is not a global: it is the
 * HUD on the prefab that `Level.ShipPrefab` names, instantiated at runtime by
 * `Level.InstantiatePlayerShip()`. The seven HoverJet missions all resolve to
 * `Resources/PlayerShip_SR14_Photon.prefab` and therefore say the same things,
 * and the six JumpSeat ones resolve to `Resources/JumpSeat_Photon.prefab` and
 * say slightly different ones (a fuel gauge, no gate counter). Emitting it per
 * level means a mission that ever shipped its own wording is a JSON difference
 * and not a code change -- CLAUDE.md rule 6. The briefing above all: it is
 * mission content, and `docs/NEXT.md` says that is where it belongs.
 *
 * The duplication across thirteen files is the same duplication `fog`,
 * `timer` and `scoring` already carry, and for the same reason: a level is a
 * complete description of a level. `_structural-assertions.json` records the
 * per-vehicle string set so that a mission drifting away from its siblings is
 * visible in a diff instead of being invisible in thirteen copies.
 *
 * ── What is NOT here ──────────────────────────────────────────────────────
 *
 * Nothing FF2 invented. `AUTO`, `LOOK AT AN OPTION`, `NEW BEST`, `DNF`, the
 * title screen's `PRESS A TO START` and the hangar's copy have no 2016 original
 * -- the 2016 level select was a different room with a different flow. Putting
 * an invented string in a block called "what 2016 said" is how a deviation
 * stops being one.
 */
function readUiStrings(vehicle, shipPrefabRel) {
  if (!shipPrefabRel) return null
  const abs = path.join(SRC, shipPrefabRel)
  if (!fs.existsSync(abs)) {
    throw new Error(`extract:levels: Level.ShipPrefab resolves to a missing file: ${abs}`)
  }
  const rows = readPrefabTexts(abs, loadScene(abs).flat)
  const { strings, meta, problems } = selectUiStrings(rows, vehicle, { prefabRel: shipPrefabRel })
  if (problems.length) {
    // A selector that matches nothing is a tool bug, not a finding: it would
    // otherwise ship a level whose HUD has an undefined label.
    throw new Error(`extract:levels: ${problems.join('; ')}`)
  }
  const briefing = selectBriefing(rows, { prefabRel: shipPrefabRel })
  if (briefing.text === null) {
    throw new Error(`extract:levels: no mission briefing in ${shipPrefabRel}`)
  }
  return {
    /** The mission briefing. CONTENT -- see the header above. */
    briefing: briefing.text,
    /** Chrome, byte-exact including 2016's capitalisation. */
    strings,
    _meta: {
      prefab: shipPrefabRel,
      vehicle,
      textComponents: rows.length,
      note:
        'UnityEngine.UI.Text is m_Script fileID 708705254 in the UnityEngine.UI assembly ' +
        '(guid f5f67c52d1564df4a8936ccd202a3bd8). Strings are read from the raw bytes by ' +
        'tools/extract/ui-text.mjs, which folds multi-line YAML scalars properly; the shared ' +
        'unity_yaml.js parser returns only the first line of one.',
      briefing: briefing.meta,
      strings: meta,
    },
  }
}

/* ================================================== who can actually launch == */

/**
 * Which of 2016's MonoBehaviours can start the launch elevator, SCANNED.
 *
 * The bug this replaces: `launchKind` was `elevator` whenever the scene
 * contained a `LaunchElevator` anywhere. That is a property of the SCENE, and
 * riding the elevator is a property of the SHIP — `LaunchElevator.StartLaunch()`
 * has exactly three call sites, all inside `Input_Ship*.cs`, and a ship prefab
 * that carries none of those components can never call it however many
 * elevators are standing around. The JumpSeat carries `DragHack`, `HoverMotor`,
 * `Input_Manager`, `Rotator_Input` and `Thruster`, and no `Input_Ship`.
 *
 * It is scanned rather than listed because a list is a belief. `if (vehicle ===
 * 'jumpseat')` would be the same bug one level up: right today, and silent the
 * day a third vehicle arrives or a fourth `Input_Ship` variant is added.
 *
 * It also fixes the wrong-shaft problem without needing a distance heuristic.
 * `int_01_jumpSeat` places the HOVERJET's `PlayerStart_ElevatorShaft_Photon` 1 m
 * from the JumpSeat's spawn and its own `playerstart_jumpSeat` 2.8 km away, so
 * "the nearest elevator" would have picked exactly the wrong one with total
 * confidence. The right question is not which elevator is closest; it is whether
 * this ship can start one at all.
 */
let LAUNCH_STARTERS = null
function launchStarterScripts() {
  if (LAUNCH_STARTERS) return LAUNCH_STARTERS
  const found = new Set()
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!e.name.endsWith('.cs')) continue
      const text = readUnityText(full)
      // A CALL, not the declaration: `LaunchElevator.cs` itself declares
      // `public void StartLaunch()` and must not be counted as a caller.
      if (/\w\.StartLaunch\s*\(/.test(text)) found.add(e.name.replace(/\.cs$/, ''))
    }
  }
  walk(path.join(SRC, 'Assets'))
  if (!found.size) {
    throw new Error(
      'extract:levels: nothing in the 2016 project calls LaunchElevator.StartLaunch(). ' +
        'The scan is broken — refusing to conclude that no mission has an elevator.',
    )
  }
  LAUNCH_STARTERS = found
  return found
}

/**
 * The component `Trigger_EnableShip.EnableShip()` requires on the player ship.
 *
 * `if (ship.GetComponent<Ship_HoverShip>() != null)` — everything inside that
 * block is a no-op for a ship without it, which is every JumpSeat. So
 * `enableShipDelay` and `enableGravityOnLaunch`, both read off that component,
 * describe something that cannot happen on those six missions. Read from the
 * C# so the guard and the extractor cannot drift apart.
 */
let ENABLE_SHIP_GUARD = null
function enableShipGuardComponent() {
  if (ENABLE_SHIP_GUARD) return ENABLE_SHIP_GUARD
  const rel = 'Assets/Faceted Flight/FF_WorldTour/scripts/Trigger_EnableShip.cs'
  const text = readUnityText(path.join(SRC, rel))
  const m =
    /void\s+EnableShip\s*\([^)]*\)\s*\{[\s\S]*?GetComponent<(\w+)>\s*\(\s*\)\s*!=\s*null/.exec(text)
  if (!m) {
    throw new Error(
      `extract:levels: could not find EnableShip()'s GetComponent<> guard in ${rel}. ` +
        'Refusing to assume it has none.',
    )
  }
  ENABLE_SHIP_GUARD = m[1]
  return ENABLE_SHIP_GUARD
}

/** How many beats `Trigger_EnableJumpShip` counts down. A C# literal, scanned not typed. */
function jumpSeatCountdownSteps() {
  const rel = 'Assets/Faceted Flight/Scripts/Trigger_EnableJumpShip.cs'
  const text = readUnityText(path.join(SRC, rel))
  const m = /StartCoroutine\s*\(\s*Countdown_JumpSeat\s*\(\s*(\d+)\s*\)/.exec(text)
  if (!m) throw new Error(`extract:levels: no Countdown_JumpSeat(n) call in ${rel}`)
  return Number(m[1])
}

/** Every MonoBehaviour script name on a ship prefab, anywhere in its hierarchy. */
function shipScriptNames(shipPrefabRel) {
  const abs = path.join(SRC, shipPrefabRel)
  const names = new Set()
  for (const o of loadScene(abs).flat.objects) {
    for (const s of o.scripts || []) if (s.name) names.add(s.name)
  }
  return names
}

/**
 * How this mission's ship gets going, traced rather than assumed.
 *
 * Returns the evidence as well as the verdict, because "the JumpSeat does not
 * ride the elevator" is exactly the kind of structural claim that needs to carry
 * its own receipt (§4.7).
 */
function launchCapability(shipPrefabRel) {
  const ship = shipScriptNames(shipPrefabRel)
  const starters = [...launchStarterScripts()].sort()
  const onShip = starters.filter((s) => ship.has(s))
  const guard = enableShipGuardComponent()
  return {
    canStartElevator: onShip.length > 0,
    starterScriptsInProject: starters,
    starterScriptsOnShip: onShip,
    enableShipGuardComponent: guard,
    enableShipApplies: ship.has(guard),
  }
}

/**
 * THE ELEVATOR SEAT — where the ship actually stands before the ride.
 *
 * ── Why this exists, and why `Level.SinglePlayerSpawnPosition` cannot be it ──
 *
 * The port treats `spawn.pos` as the platform's RESTING place: `app.ts` puts the
 * `launch-anchor` at `spawn.pos`, `createElevator` expresses every offset inside
 * it relative to that, and `flight.ts` starts the body at `spawn.pos.y + rise`.
 * So `spawn.pos` has to be the seat, not the top of the shaft.
 *
 * 2016's own code says where the seat is, in one statement.
 * `LaunchElevator.StartLaunch()` (FF_GearVR/Scripts/LaunchElevator.cs:33-45):
 *
 *     ship.transform.parent        = PlayerShipRoot.transform;
 *     ship.transform.localPosition = Vector3.zero;
 *     ship.transform.localRotation = Quaternion.identity;
 *
 * The ship's pre-ride pose IS `PlayerShipRoot`'s world pose. Nothing else is a
 * candidate.
 *
 * `Level.SinglePlayerSpawnPosition` USUALLY points at that same node, and this
 * block used to read it instead — which was six rigs right and one wrong.
 * `rookie_02_hoverJet.unity` points BOTH `SinglePlayerSpawnPosition` (line 85493)
 * and `SinglePlayerRespawnPosition` (line 85494) at `&1097228478`,
 * `levelOffset/Position_adjustment/respawn_position`, 109 m up the shaft. 2016
 * cannot see it: `Level.respawning` is serialised 1 in all thirteen scenes and
 * `Level.cs:287-294` then takes the RESPAWN marker, so the spawn field is dead
 * YAML there. The port read it and built the rig, the room and the run 107.010 m
 * too high — the whole of DEV-101.
 *
 * ── How it is resolved, and why not by the field ────────────────────────────
 *
 * By NAME, inside the subtree of the node carrying `LaunchElevator`, with the
 * field as the cross-check rather than the source. `LaunchElevator.PlayerShipRoot`
 * is a GameObject reference and it resolves in the scene on only five of the
 * seven rigs: where the rig is a genuine prefab instance (`rookie_01_hoverJet`,
 * and `rookie_02_jumpSeat`'s dead one) the un-overridden field carries the
 * PREFAB's internal fileID — 119948 — which is not a scene object at all, the
 * stripped-instance trap one field over. The name walk works on all seven; the
 * field agrees exactly wherever it resolves, and `seatRefAgrees` records that.
 */
function elevatorSeat(scene, elevatorNode) {
  if (!elevatorNode) return null
  const named = scene.flat.objects.filter(
    (o) => o.name === 'PlayerShipRoot' && o.parent === elevatorNode.key,
  )
  if (named.length !== 1) {
    throw new Error(
      `expected exactly one PlayerShipRoot under ${elevatorNode.path} in ${scene.absPath}, ` +
        `found ${named.length}`,
    )
  }
  const seat = named[0]
  // The cross-check: 2016's own reference, where the scene holds it.
  const ref = fieldOf(scriptOn(elevatorNode, 'LaunchElevator'), 'PlayerShipRoot')
  const byRef = nodeForGameObjectRef(scene, ref)
  return {
    node: seat,
    seatRef: ref && typeof ref === 'object' ? String(ref.fileID) : (ref ?? null),
    /** null where the reference is prefab-internal — nothing to compare against. */
    seatRefAgrees: byRef ? byRef.key === seat.key : null,
  }
}

/**
 * The JumpSeat's start sequence -- what happens instead of the elevator ride.
 *
 * `Trigger_EnableJumpShip` sits on `playerstart_jumpSeat/Position_adjustment/
 * trigger_enableShip`, inside a stripped prefab instance, so it is invisible to
 * the unexpanded read the rest of the spawn block uses -- which is why nothing
 * had ever seen it and six missions were credited with an elevator instead.
 * All six carry one.
 *
 * `OnTriggerEnter` on tag Player disables its own collider, waits
 * `triggerDelay`, then counts `steps` beats of one second each and calls
 * `Enable_JumpSeat()`, which switches on `Input_Manager`, `HoverMotor` and
 * `Thruster`. So the ship is inert for `triggerDelay + steps` seconds from the
 * moment the player enters the trigger.
 *
 * `triggerDelay` is read off the PREFAB, not the `public float triggerDelay =
 * 3.5f` initialiser -- the cardinal rule, even though here the two agree, which
 * is worth saying out loud because an agreement is not a licence to stop
 * checking. `steps` is a bare literal in `StartCoroutine(Countdown_JumpSeat(4))`
 * with nothing serialised, so it is `trust: code-literal` and scanned out of the
 * source rather than typed here.
 */
function readJumpSeatStart(missionAbs) {
  const flat = loadSceneExpanded(missionAbs)
  const live = flat.objects.filter(
    (o) =>
      o.activeInHierarchy && (o.scripts || []).some((s) => s.name === 'Trigger_EnableJumpShip'),
  )
  if (!live.length) return null
  if (live.length > 1) {
    throw new Error(
      `extract:levels: ${live.length} live Trigger_EnableJumpShip in ${missionAbs}; one expected.`,
    )
  }
  const o = live[0]
  const s = o.scripts.find((x) => x.name === 'Trigger_EnableJumpShip')
  const triggerDelay = num(fieldOf(s, 'triggerDelay'))
  if (triggerDelay === undefined) {
    throw new Error(
      `extract:levels: Trigger_EnableJumpShip in ${missionAbs} serialises no triggerDelay`,
    )
  }
  const steps = jumpSeatCountdownSteps()
  return {
    pos: toThreePos(o.world.position),
    triggerDelay,
    countdownSteps: steps,
    /** Seconds from entering the trigger to the controls waking up. */
    seconds: r6(triggerDelay + steps),
    _meta: {
      fileID: o.key,
      path: o.path,
      prefab: o.prefab ? o.prefab.path : null,
      triggerDelaySource: 'shipped prefab instance (NOT the C# initialiser, which agrees)',
      countdownStepsSource:
        'Trigger_EnableJumpShip.cs StartCoroutine(Countdown_JumpSeat(n)) — a code literal, nothing serialised',
      enables: ['Input_Manager', 'HoverMotor', 'Thruster'],
      raw: { pos: rawPos(o.world.position) },
    },
  }
}

/**
 * The live `Trigger_EnableShip` that actually starts this mission's countdown.
 *
 * Deliberately NOT the same lookup as the one behind `spawn.enableShipDelay`.
 * That one is gated on the ship having `Ship_HoverShip`, because
 * `EnableShip()` is; but `StartCountdown()` is called EARLIER in the same
 * coroutine and outside that guard, so a countdown can happen on a mission
 * whose `EnableShip()` body would do nothing. `int_01_jumpSeat` is exactly that
 * case: it places the HoverJet's `PlayerStart_ElevatorShaft_Photon`, trigger and
 * all, around a ship that has no `Ship_HoverShip`.
 *
 * The `countdown` field must resolve to the LIVE `Timer_Race`, not merely be
 * non-null: `rookie_02_hoverJet`, `int_02_hoverJet` and `adv_01_hoverJet` each
 * carry a second, inactive `Timer_Race`, and a trigger pointing at a dead one
 * would start nothing.
 */
function countdownStartTrigger(scene, modeParentKeys, timerRaceScript) {
  if (!timerRaceScript) return null
  const hits = []
  for (const obj of withScript(scene, 'Trigger_EnableShip')) {
    const s = scriptOn(obj, 'Trigger_EnableShip')
    if (num(fieldOf(s, 'm_Enabled') ?? s.enabled) === 0) continue
    if (obj.active === false || !liveInHierarchy(scene, obj, modeParentKeys)) continue
    const ref = fieldOf(s, 'countdown')
    const refId = ref && typeof ref === 'object' ? String(ref.fileID ?? '0') : String(ref ?? '0')
    if (refId === '0' || refId !== String(timerRaceScript.fileID)) continue
    hits.push({
      path: obj.path,
      fileID: s.fileID,
      timerFileID: refId,
      delay: num(fieldOf(s, 'delay')) ?? null,
    })
  }
  if (hits.length > 1) {
    throw new Error(
      `extract:levels: ${hits.length} live Trigger_EnableShip components wired to the same ` +
        'Timer_Race. Which one starts the countdown would be a guess.',
    )
  }
  return hits[0] ?? null
}

/** Rotate a vector by a quaternion. Unity space in, Unity space out. */
function qRotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

/** Hamilton product, a then b. */
function qMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/**
 * Put a pose expressed inside a prefab into the world the prefab is placed in.
 *
 * Only correct for a root with no SHEAR, which a prefab instance's transform
 * cannot have. Scale composes component-wise, which is Unity's own (wrong, and
 * therefore right) answer for a rotated non-uniform parent.
 */
function composeWorld(root, local) {
  const scaled = {
    x: local.position.x * root.s.x,
    y: local.position.y * root.s.y,
    z: local.position.z * root.s.z,
  }
  const rotated = qRotate(root.q, scaled)
  return {
    p: { x: root.p.x + rotated.x, y: root.p.y + rotated.y, z: root.p.z + rotated.z },
    q: qMul(root.q, local.rotation),
    s: { x: root.s.x * local.scale.x, y: root.s.y * local.scale.y, z: root.s.z * local.scale.z },
  }
}

/**
 * `GL-Cloud-02.fbx` -> `"02"`, or null.
 *
 * The mesh reference is a guid into a bought pack; the BASENAME is not the
 * asset, it is which of three silhouettes the artist reached for. A generator
 * that ignores it makes nineteen identical clouds.
 */
function cloudShapeOf(filter) {
  const guid = filter?.data?.m_Mesh?.guid ?? filter?.mesh?.guid ?? null
  const rel = guid ? guidIndex().get(guid) : null
  const m = rel ? /GL-Cloud-(\d+)\.fbx$/i.exec(rel) : null
  return m ? m[1] : null
}

/**
 * JumpSeat landing pads -- `target_jumppad.prefab` instance roots, WITH the
 * volumes that make them hittable.
 *
 * ── The transform is not the target ───────────────────────────────────────
 *
 * A pad's `scale` runs to (263, 0.14, 263) on `int_02_jumpSeat`. That is not an
 * extent of anything: it is the instance's scale, and the pad's actual trigger
 * volumes are colliders on child objects with their own scales on top. The same
 * trap `FinishGate` documents, one layer deeper -- and a pad whose geometry is
 * read off the root transform is a 263 m disc 14 cm thick, which is neither the
 * 28 m landing ball nor the 17 scoring boxes.
 *
 * ── Why this needs the EXPANDED scene ─────────────────────────────────────
 *
 * Same reason as `readFinish`: `loadScene` runs `expandPrefabs: false`, so the
 * pad's interior does not exist in the flattened tree. What interior nodes DO
 * appear there are the ones the scene overrode, and their `world` transforms are
 * not composed -- `int_02_jumpSeat`'s materialised `trigger_jumpPad` reads a
 * world scale of 554, which is the pad's own 263 multiplied in twice. Reading
 * geometry off those would be worse than reading none.
 *
 * Composing from the prefab instead would be wrong too, and measurably: the six
 * JumpSeat scenes carry **11 `m_IsActive`, 1 `m_IsTrigger`, 43/40/43 `m_LocalScale`
 * and 58/63/58 `m_LocalPosition`** modifications against pad instances -- more
 * than one per instance, so some of them are reaching INSIDE. One scene
 * (`rookie_01_jumpSeat`) flips a collider's `m_IsTrigger`. A prototype composed
 * from the prefab would be right for most pads and silently wrong for those.
 *
 * `loadSceneExpanded` is already computed for every mission by `readFinish`, so
 * this is a cache hit, not a second parse.
 *
 * ── Liveness, and the four dead pads nobody had noticed ───────────────────
 *
 * `rookie_02_jumpSeat` places 11 pads and four of them hang under a GameObject
 * literally called `GameObject` with `m_IsActive: 0` -- so 7 are live. That was
 * already right on the placement rows (`live`) and is applied to the volumes
 * too: a volume under an inactive ancestor is emitted with `live: false` rather
 * than dropped, for the same reason the dead pads are kept.
 */
function readPads(scene, modeParentKeys, missionAbs) {
  const out = []
  const cands = placementsOf(scene, /target_jumppad\.prefab$/i, /^target_jumppad\b/i)
  const groups = padVolumes(missionAbs)
  for (const o of cands) {
    const live = o.active !== false && liveInHierarchy(scene, o, modeParentKeys)
    const group = matchPadVolumes(groups, o)
    const vols = group ? group.vols : null
    const solids = group ? group.solids : []
    if (solids.length > 1) {
      throw new Error(
        `extract:levels: pad "${o.path}" has ${solids.length} live solid mesh colliders ` +
          `(${solids.map((x) => x.path).join(', ')}); one landing surface is expected`,
      )
    }
    out.push({
      name: o.name,
      live,
      pos: toThreePos(o.world.position),
      quat: toThreeQuat(o.world.rotation),
      scale: [r6(o.world.scale.x), r6(o.world.scale.y), r6(o.world.scale.z)],
      landing: vols ? (vols.find((v) => v.role === 'landing') ?? null) : null,
      refuel: vols ? (vols.find((v) => v.role === 'refuel') ?? null) : null,
      zones: vols ? vols.filter((v) => v.role === 'score') : [],
      // The surface the seat lands on (DEV-120). Null is a reader failure, and
      // `pads-have-solid` turns it into a `--check` exit 1.
      solid: solids[0] ?? null,
      _meta: {
        fileID: o.key,
        path: o.path,
        prefab: o.prefab ? o.prefab.path : null,
        selfActive: o.active,
        // Null means the expanded read found no interior for this path, which is
        // a tool bug rather than a pad without triggers -- `--check` fails on it.
        volumesFound: vols ? vols.length : null,
        raw: { pos: rawPos(o.world.position) },
      },
    })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out.map((p, i) => ({ i, ...p }))
}

/**
 * Which gameplay role a collider inside a pad plays, from the script on it.
 *
 * The SCRIPT, not the name: `trigger_bullseye (1)` and eight objects all called
 * `collider_ground (N)` are the same component doing the same job, and the names
 * only say which ring of the target they belong to. What a hit on each one is
 * WORTH is `Trigger_JumpTarget`'s own fields and the JumpSeat mode spec — not
 * this file's business. This is geometry and placement.
 *
 * `Trigger_RemoveTrees` (a 24 m sphere that deletes scenery at author time) and
 * the `finale_jumpSeat` mesh triggers are deliberately NOT roles: the first is
 * an editor utility, the second belongs to the level-finale prefab that happens
 * to be parented under the pad.
 */
const PAD_TRIGGER_ROLE = {
  Trigger_JumpPad: 'landing',
  Trigger_Refuel: 'refuel',
  Trigger_JumpTarget: 'score',
}

/**
 * Every pad's trigger volumes, in world space, one group per pad INSTANCE.
 *
 * ── Why the key is a position and not a path ──────────────────────────────
 *
 * Because a path is not unique. `int_02_jumpSeat` places two pads called
 * `target_jumppad (6)` under the same parent, two called `(7)` and two called
 * `(8)` -- Unity allows duplicate sibling names and the level author used it.
 * Keying by path merged each pair, and both halves came back with 34 volumes
 * instead of 17: a number large enough to look deliberate. The parent chain
 * settles which root a trigger belongs to exactly; the root's world position
 * then settles which of two identically-named roots that is.
 *
 * The expanded read also emits TWO nodes per pad root -- the scene's stripped
 * Transform (usually no children) and the expanded prefab root (the eleven real
 * ones). Walking UP from each trigger lands on whichever one actually holds it,
 * so neither has to be identified.
 */
function padVolumes(missionAbs) {
  const flat = loadSceneExpanded(missionAbs)
  const byKey = new Map(flat.objects.map((o) => [o.key, o]))
  const isRoot = (o) => /(^|\/)target_jumppad( \(\d+\))?$/.test(o.path || '')
  const groups = new Map()
  // Nearest ancestor that is a pad root, or null.
  const rootOf = (o) => {
    let root = o.parent ? byKey.get(o.parent) : null
    let guard = 0
    while (root && guard++ < 16 && !isRoot(root)) root = root.parent ? byKey.get(root.parent) : null
    return root && isRoot(root) ? root : null
  }
  const groupFor = (root) => {
    const key = padKey(root.path, root.world.position)
    if (!groups.has(key)) {
      groups.set(key, { path: root.path, pos: root.world.position, vols: [], solids: [] })
    }
    return groups.get(key)
  }
  for (const o of flat.objects) {
    // ── The SOLID surface (DEV-120) ──────────────────────────────────────
    //
    // Non-trigger MeshColliders under the pad root with a mesh to read. On the
    // shipped prefab that is exactly one node, `jumpPad_04_collider`; the root's
    // own MeshCollider names no mesh (`m_Mesh: {fileID: 0}`) and does nothing,
    // and the finale rig's hexTile towers are switched off on their OWN
    // GameObjects. So the filter is self-activity, not hierarchy liveness: a
    // node inactive on itself is a surface nowhere, while a live node under a
    // dead ancestor is a dead PAD's surface and is emitted with `live: false`,
    // like its volumes, so the four dead pads on `rookie_02_jumpSeat` keep their
    // geometry. Read as a radial profile; `pad-solid.mjs` says why.
    const solidCols = (o.components || []).filter(
      (c) => c.type === 'MeshCollider' && !c.isTrigger && c.mesh?.path,
    )
    if (solidCols.length && o.active !== false) {
      const root = rootOf(o)
      if (root) for (const c of solidCols) groupFor(root).solids.push(padSolid(o, c, root.path))
    }

    // ── The trigger volumes ─────────────────────────────────────────────
    const script = (o.scripts || []).find((s) => PAD_TRIGGER_ROLE[s.name])
    if (!script) continue
    const cols = (o.components || []).filter((c) => COLLIDER_KIND[c.type] && c.isTrigger)
    if (!cols.length) continue
    const root = rootOf(o)
    if (!root) continue
    const group = groupFor(root)
    for (const c of cols) group.vols.push(padVolume(o, c, script, root.path))
  }
  for (const g of groups.values()) {
    g.vols.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    g.solids.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
  return groups
}

/**
 * The pad's landing surface: one live, non-trigger `MeshCollider` under the pad
 * root, as a RADIAL PROFILE in world metres (DEV-120).
 *
 * `pos`/`quat` are the collider NODE's world transform (three space) -- the
 * profile's heights are relative to `pos.y` and its radii are measured in the
 * node's local xz plane, so a yawed pad rotates its octagon with it. The
 * profile is the mesh's own, scaled by the node's world scale: radii by |x| and
 * heights by y. A pad whose x and z scales disagree would need an ellipse, and
 * the extractor refuses it rather than picking one.
 *
 * Every other number a consumer might want -- the top, the bottom, the outer
 * radius -- is derivable from `profile` and is emitted only so a reader can
 * check the JSON against the ledger without arithmetic.
 */
function padSolid(node, c, rootPath) {
  const s = node.world.scale
  const sx = Math.abs(s.x)
  const sz = Math.abs(s.z)
  if (Math.abs(sx - sz) > 1e-4 * Math.max(sx, sz)) {
    throw new Error(
      `extract:levels: pad solid "${node.path}" has unequal x/z world scale ` +
        `(${sx} vs ${sz}); a radial profile cannot describe it`,
    )
  }
  const meshRel = c.mesh.path
  const radial = fbxRadialProfile(path.join(SRC, meshRel))
  const profile = radial.profile.map(([r, y]) => [r6(r * sx), r6(y * s.y)])
  return {
    kind: 'radialProfile',
    name: node.name,
    path: (node.path || '').slice(rootPath.length + 1),
    live: node.activeInHierarchy !== false,
    mesh: meshRel,
    pos: toThreePos(node.world.position),
    quat: toThreeQuat(node.world.rotation),
    /** Rotational symmetry of the mesh: 8 -- an octagon with a vertex on local +x. */
    symmetry: radial.symmetry,
    /** `[radius, height]` pairs, metres. Radius in the n-gon norm, height above `pos.y`. */
    profile,
    /** The last radius with any surface under it, metres. */
    outer: r6(radial.outer * sx),
    top: r6(radial.top * s.y),
    bottom: r6(radial.bottom * s.y),
    _meta: {
      worldScale: [r6(s.x), r6(s.y), r6(s.z)],
      meshLocalSize: radial.meshLocalSize.map((n) => r6(n)),
      meshImportScale: radial.importScale,
      meshVertexCount: radial.vertexCount,
      meshTriangleCount: radial.triangleCount,
      /** Worst disagreement between the polyline and the dense scan of the mesh, metres. */
      profileError: r6(radial.resampleError * s.y),
      /** Worst height disagreement between a vertex ray and an edge ray, metres. */
      symmetryError: r6(radial.symmetryError * s.y),
      note:
        'The one live solid collider on target_jumppad.prefab (layer 0, non-trigger, ' +
        'non-convex). The HoverMotor ray hits it and the four Player-tagged leg capsules ' +
        'stand on it. Vertical walls survive as two profile points at one radius.',
    },
  }
}

/** Pad identity: its path plus its world position, both rounded the same way. */
function padKey(p, pos) {
  return `${p}|${r6(pos.x)},${r6(pos.y)},${r6(pos.z)}`
}

/**
 * The volume group belonging to one placement, or null.
 *
 * Null is a reader failure and `pads-have-triggers` turns it into a `--check`
 * exit 1. It is not "this pad has no triggers": every shipped pad has 19.
 */
function matchPadVolumes(groups, placement) {
  return groups.get(padKey(placement.path, placement.world.position)) ?? null
}

/** Unity collider class -> the shape word the schema uses. MeshColliders are skipped. */
const COLLIDER_KIND = {
  BoxCollider: 'box',
  SphereCollider: 'sphere',
  CapsuleCollider: 'capsule',
}

/** Capsule `m_Direction`: the local axis the capsule runs along. */
const CAPSULE_AXIS = ['x', 'y', 'z']

/**
 * One trigger volume, sized the way Unity sizes it -- which is never "the
 * transform's scale".
 *
 *   Box      half extent   = size/2 * |scale|, component-wise
 *   Sphere   radius        = radius * MAX |scale| component
 *   Capsule  radius        = radius * max of the two PERPENDICULAR components
 *            height        = height * the component it runs along, and Unity
 *                            then clamps it to at least 2*radius -- below that a
 *                            capsule IS a sphere. Every pad's landing volume is
 *                            in that regime: r 0.951 x 29.83 = 28.4 m against
 *                            h 0.5 x 21.1 = 10.6 m, so the "capsule" the player
 *                            actually hits is a 28.4 m ball.
 *
 * `center` is in the collider's own local space and has to be scaled AND rotated
 * before it means anything in the world, which is why it is composed here rather
 * than handed to the runtime to compose again.
 */
function padVolume(node, c, script, rootPath) {
  const s = node.world.scale
  const ax = Math.abs(s.x)
  const ay = Math.abs(s.y)
  const az = Math.abs(s.z)
  const kind = COLLIDER_KIND[c.type]
  const centre = c.center ?? { x: 0, y: 0, z: 0 }
  const offset = qRotate(node.world.rotation, {
    x: (Number(centre.x) || 0) * s.x,
    y: (Number(centre.y) || 0) * s.y,
    z: (Number(centre.z) || 0) * s.z,
  })
  const world = {
    x: node.world.position.x + offset.x,
    y: node.world.position.y + offset.y,
    z: node.world.position.z + offset.z,
  }
  const role = PAD_TRIGGER_ROLE[script.name]
  const f = script.fields || {}
  const vol = {
    role,
    kind,
    name: node.name,
    path: (node.path || '').slice(rootPath.length + 1),
    live: node.activeInHierarchy !== false,
    pos: toThreePos(world),
    quat: toThreeQuat(node.world.rotation),
  }
  // What the trigger's SCRIPT carries, off the expanded instance so a scene
  // override would show (DEV-121 — none does, on any of the 57 shipped pads).
  //
  //   refuel  `Trigger_Refuel.refuelRate`         10 units/s on every pad
  //   score   `Trigger_JumpTarget.val_score`      100 / 50 / 25
  //           `.refuelMultiplier`                 3 / 1.5 / 1 — AUTHORED, and
  //           `.giveRefuelBonus`                  0 everywhere, so never applied:
  //           `Trigger_JumpTarget.cs:60-63` multiplies the pad's refuelRate by
  //           the plate's multiplier only when the flag is set. The tiered
  //           refuel was tuned and switched off.
  //           `.trigger_once`                     1 everywhere
  if (role === 'refuel') {
    vol.rate = num(f.refuelRate)
  } else if (role === 'score') {
    vol.points = num(f.val_score)
    vol.refuelMultiplier = num(f.refuelMultiplier)
    vol.giveRefuelBonus = num(f.giveRefuelBonus) === 1
    vol.triggerOnce = num(f.trigger_once) === 1
  }
  if (kind === 'box') {
    const size = c.size ?? { x: 1, y: 1, z: 1 }
    vol.half = [
      r6(((Number(size.x) || 0) / 2) * ax),
      r6(((Number(size.y) || 0) / 2) * ay),
      r6(((Number(size.z) || 0) / 2) * az),
    ]
  } else if (kind === 'sphere') {
    vol.radius = r6((Number(c.radius) || 0) * Math.max(ax, ay, az))
  } else {
    const dir = Number(c.direction) || 0
    const along = [ax, ay, az][dir] ?? ay
    const perp = dir === 0 ? Math.max(ay, az) : dir === 1 ? Math.max(ax, az) : Math.max(ax, ay)
    const radius = (Number(c.radius) || 0) * perp
    const height = (Number(c.height) || 0) * along
    vol.axis = CAPSULE_AXIS[dir] ?? 'y'
    vol.radius = r6(radius)
    vol.height = r6(Math.max(height, radius * 2))
    // TRUE whenever Unity's clamp has swallowed the cylinder entirely. Every
    // shipped pad is in this state, so a port that draws a tall capsule draws
    // something the physics never had.
    vol.degenerateToSphere = height <= radius * 2
  }
  return vol
}

/**
 * Turn indicators -- `turnIndicator.prefab` instance roots.
 *
 * The cyan chevrons that tell you where the course turns, and the thing Matt's
 * 2016 screenshots have that the port did not. Every hoverJet mission carries
 * them: 9 here, 27 in `int_02`.
 *
 * They are placed in TRIOS. `int_01`'s nine sit in three tight clusters -- one
 * per turn -- so a turn reads as a run of arrows sweeping round rather than as
 * a single sign. That is why they are ordered here by their authored
 * `m_RootOrder` rather than by distance along the route: the trio order IS the
 * reading order, and it is the one the level designer set.
 *
 * Every instance overrides position AND rotation, so unlike the orbs these are
 * genuinely nine different poses -- an extractor that took the prefab's own
 * transform would point all nine the same way.
 *
 * ── The instance can also re-aim the ARROW INSIDE the prefab (DEV-198) ─────
 *
 * The root's world pose is not the whole story. Two of the thirteen shipped
 * scenes -- both of them Mesa Canyon -- carry `m_Modifications` on
 * `turnIndicator_art (2)`, the arrow CHILD, yawing it ~86-90 deg about its own
 * Y (and, on nine of them, rolling it 90 deg about X as well). `rookie_02` does
 * it on all 21 instances and `adv_01` on 6 of 21; nowhere else does it at all.
 *
 * A port that reads the arrow's pose off the PREFAB and the root's pose off the
 * SCENE gets 87 of 114 right and leaves 27 chevrons pointing across the course
 * instead of along it. That is hard rule 2 in its purest form -- the prefab's
 * value is a hypothesis until the scene's `m_Modifications` have been read --
 * and it is why this emits the arrow node's own local TRS whenever the scene
 * touches it.
 *
 * The flattener materialises that child as a node ONLY when the scene overrides
 * something on it, and fills the untouched channels from the prefab, so "the
 * child is present" is exactly "the scene re-aimed the arrow". Its `position`
 * and `scale` come back as the prefab's own; `turn-indicator.test.ts` asserts
 * that against the constants sheet rather than trusting it, so a future scene
 * that moves or resizes the arrow fails a test instead of drifting.
 */
function readTurnIndicators(scene, modeParentKeys) {
  const out = []
  const cands = placementsOf(scene, /turnIndicator\.prefab$/i, /^turnIndicator\b/i)
  for (const o of cands) {
    const live = o.active !== false && liveInHierarchy(scene, o, modeParentKeys)
    // The arrow child, if this scene re-aimed it. Same prefab instance AND a
    // path under this root: either test alone would be enough, both together
    // cannot pick up a sibling instance's child.
    const kids = scene.flat.objects.filter(
      (n) =>
        n !== o &&
        o.prefab &&
        n.prefab &&
        n.prefab.instanceId === o.prefab.instanceId &&
        String(n.path || '').startsWith(`${o.path}/`),
    )
    if (kids.length > 1) {
      throw new Error(
        `${scene.absPath}: ${o.path} materialises ${kids.length} prefab children ` +
          `(${kids.map((k) => k.name).join(', ')}); the arrow node is meant to be the only one`,
      )
    }
    const art = kids[0]
      ? {
          // UNITY space, PREFAB-LOCAL -- the same quantity, and the same space,
          // as `props.turnIndicator.arrow` in the constants sheet, which this
          // replaces for this one instance. NOT the three-space world pose that
          // `pos`/`quat` above are.
          name: kids[0].name,
          position: rawPos(kids[0].local.position),
          rotation: rawQuat(kids[0].local.rotation),
          scale: [r6(kids[0].local.scale.x), r6(kids[0].local.scale.y), r6(kids[0].local.scale.z)],
        }
      : null
    out.push({
      name: o.name,
      live,
      pos: toThreePos(o.world.position),
      quat: toThreeQuat(o.world.rotation),
      scale: [r6(o.world.scale.x), r6(o.world.scale.y), r6(o.world.scale.z)],
      art,
      _meta: {
        fileID: o.key,
        path: o.path,
        prefab: o.prefab ? o.prefab.path : null,
        selfActive: o.active,
        raw: { pos: rawPos(o.world.position), rot: rawQuat(o.world.rotation) },
      },
    })
  }
  // `\b` after "turnIndicator" is load-bearing: it keeps `turnIndicator_art`
  // out, because `_` is a word character and there is no boundary before it.
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out.map((t, i) => ({ i, ...t }))
}

/**
 * Route polyline from Curvy. Each CurvySplineSegment serialises `Approximation`, a
 * Granularity+1 = 21-point polyline. PORT_PLAN 5.5 claims those points are WORLD space; this
 * tool does not take that on trust -- it measures the offset between Approximation[0] and the
 * control point's own world position and records the verdict in `route._meta.space`.
 * If they match in world space we emit them straight; if they match the spline-root's local
 * space we transform them by the spline root's world matrix.
 */
function readRoute(scene, modeParentKeys) {
  const segs = withScript(scene, 'CurvySplineSegment').filter((o) =>
    liveInHierarchy(scene, o, modeParentKeys),
  )
  if (!segs.length) return null

  // group by spline root (parent), pick the group with the most segments
  const groups = new Map()
  for (const o of segs) {
    const k = o.parent || 'root'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(o)
  }
  let best = null
  for (const [k, list] of groups) if (!best || list.length > best[1].length) best = [k, list]
  const [rootKey, list] = best
  const rootNode = scene.byKey.get(rootKey) || null
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  // decide the space empirically on the FIRST control point
  const first = list[0]
  const f = scriptOn(first, 'CurvySplineSegment')
  const ap0 = (fieldOf(f, 'Approximation') || [])[0]
  let space = 'unknown'
  let toWorld = (p) => p
  if (ap0) {
    const w = first.world.position
    const dWorld = Math.hypot(Number(ap0.x) - w.x, Number(ap0.y) - w.y, Number(ap0.z) - w.z)
    const rw = rootNode ? rootNode.world.position : { x: 0, y: 0, z: 0 }
    const dLocal = Math.hypot(
      Number(ap0.x) + rw.x - w.x,
      Number(ap0.y) + rw.y - w.y,
      Number(ap0.z) + rw.z - w.z,
    )
    if (dWorld <= 0.01 && dWorld <= dLocal) {
      space = 'world'
    } else if (dLocal <= 0.01) {
      space = 'splineRootLocal'
      toWorld = (p) => ({ x: p.x + rw.x, y: p.y + rw.y, z: p.z + rw.z })
    } else {
      space = `unresolved(dWorld=${r6(dWorld)},dLocalTranslate=${r6(dLocal)})`
    }
  }

  const pts = []
  for (const seg of list) {
    const sc = scriptOn(seg, 'CurvySplineSegment')
    const ap = fieldOf(sc, 'Approximation')
    if (!Array.isArray(ap)) continue
    for (const p of ap) {
      const q = toWorld({ x: Number(p.x), y: Number(p.y), z: Number(p.z) })
      if (!Number.isFinite(q.x)) continue
      const last = pts[pts.length - 1]
      if (
        last &&
        Math.abs(last[0] - q.x) < 1e-4 &&
        Math.abs(last[1] - q.y) < 1e-4 &&
        Math.abs(last[2] + q.z) < 1e-4
      )
        continue
      pts.push(toThreePos(q))
    }
  }
  const splineScript = rootNode ? scriptOn(rootNode, 'CurvySpline') : null
  return {
    points: pts,
    _meta: {
      space,
      splineRoot: rootNode ? rootNode.path : null,
      splineRootFileID: rootKey,
      controlPoints: list.length,
      granularity: num(fieldOf(splineScript, 'Granularity')) ?? null,
      interpolation: num(fieldOf(splineScript, 'Interpolation')) ?? null,
      closed: bool(fieldOf(splineScript, 'Closed')) ?? null,
      note: 'Approximation arrays concatenated in control-point name order; duplicate seam points dropped.',
    },
  }
}

/**
 * Ghosts. `Level.SinglePlayerGhosts` is [] in all 13 shipped scenes and only read in the
 * Multiplayer branch, so 2016 ran EVERY GhostRacer in the environment scene in EVERY mission
 * that used it (_verify-v-modes E14). FF2 filters per mission -- a logged deviation.
 * Ghosts also exist in five mission scenes directly; both sources are collected and the
 * clip name decides which mission a ghost belongs to.
 */
function readGhosts(missionId, vehicle, missionScene, envScene) {
  const found = []
  const collect = (scene, origin) => {
    if (!scene) return
    const cands = placementsOf(scene, /GhostRacer\.prefab$/i, /^GhostRacer/i)
    for (const o of cands) {
      const anim = (o.components || []).find((c) => c.type === 'Animation')
      const pra = scriptOn(o, 'PlayRandomAnimation')
      // PlayRandomAnimation.animationClips is the pool the driver picks from. Resolve the
      // prefab base array, then apply the instance's Array.size and Array.data[i] overrides
      // -- an unresolved union of base + overrides invents clips that never played.
      const clips = resolveClipArray(pra, 'animationClips')
      const registry = anim ? resolveClipArray(anim, 'm_Animations') : []
      let timeOv = anim?.instanceOverrides ? anim.instanceOverrides.m_Time : undefined
      if (timeOv === undefined && o.prefab && scene.instanceMods.has(String(o.prefab.instanceId))) {
        const hit = scene.instanceMods
          .get(String(o.prefab.instanceId))
          .find((x) => x && x.propertyPath === 'm_Time')
        if (hit) timeOv = hit.value
      }
      const playAuto =
        anim && anim.instanceOverrides && anim.instanceOverrides.m_PlayAutomatically !== undefined
          ? num(anim.instanceOverrides.m_PlayAutomatically) !== 0
          : null
      const enabledOv =
        anim && anim.instanceOverrides && anim.instanceOverrides.m_Enabled !== undefined
          ? num(anim.instanceOverrides.m_Enabled) !== 0
          : anim
            ? num(anim.enabled) !== 0
            : null
      found.push({
        name: o.name,
        origin,
        enabled: enabledOv,
        playAutomatically: playAuto,
        startTime: num(timeOv) ?? null,
        clips,
        registry,
        pos: toThreePos(o.world.position),
        quat: toThreeQuat(o.world.rotation),
        // DEV-442: the frame the clip's root keys are written in. Not emitted.
        parent: parentOf(scene, o),
        _meta: {
          fileID: o.key,
          path: o.path,
          scene: scene.absPath,
          raw: { pos: rawPos(o.world.position) },
        },
      })
    }
  }
  collect(missionScene, 'mission')
  collect(envScene, 'environment')

  // Per-mission attribution.
  //   * A ghost placed in the MISSION scene belongs to that mission: someone put it there
  //     on purpose (rookie_02/adv_01 hoverJet, rookie_02/adv_01/adv_02 jumpSeat).
  //   * A ghost in the ENVIRONMENT scene is shared by every mission using that environment,
  //     so it is claimed only when its clip name carries this mission's stem -- AND only for
  //     HoverJet missions, because every recorded clip is a HoverJet flight. Without the
  //     vehicle guard, int_01_jumpSeat inherits int_01_hoverJet's two ghosts and a JumpSeat
  //     player watches two jets fly a HoverJet course.
  const stem = missionId.replace(/_hoverJet$|_jumpSeat$/i, '')
  const claims = (g) => {
    if (g.origin === 'mission') return g.clips[0] || null
    if (vehicle !== 'hoverjet') return null
    return g.clips.find((c) => c.startsWith(`${stem}_`)) || null
  }
  const mine = []
  for (const g of found) {
    const clip = claims(g)
    if (!clip) continue
    const from = ghostStart(clip, g.parent)
    mine.push({
      clip,
      spawn: g.pos,
      quat: g.quat,
      startTime: g.startTime,
      animationEnabled: g.enabled,
      playAutomatically: g.playAutomatically,
      start: from.start,
      _meta: {
        ...g._meta,
        ghostName: g.name,
        origin: g.origin,
        effectiveClipPool: g.clips,
        randomiserIsNoOp: new Set(g.clips).size <= 1,
        start: from.meta,
      },
    })
  }
  return {
    ghosts: mine,
    _meta: {
      candidatesInspected: found.length,
      ranInThisMissionIn2016: found.length,
      note:
        'Level.SinglePlayerGhosts is [] in all 13 scenes and is only read in the ' +
        'Multiplayer branch, so 2016 ran EVERY GhostRacer in the environment scene in EVERY ' +
        'mission that used it. FF2 filters on clip-name prefix -- a logged deviation. ' +
        'PlayRandomAnimation picks uniformly from the resolved animationClips pool; in every ' +
        'shipped ghost that pool collapses to one clip, so the randomiser is a no-op.',
      attribution:
        'mission-scene ghosts always claimed; environment-scene ghosts claimed only ' +
        'on a clip-stem match AND vehicle === hoverjet (all clips are HoverJet recordings).',
      rejected: found
        .filter((g) => !claims(g))
        .map((g) => ({
          name: g.name,
          clips: g.clips,
          origin: g.origin,
          why:
            g.origin === 'environment' && vehicle !== 'hoverjet'
              ? 'environment ghost, non-HoverJet mission'
              : 'clip stem does not match this mission',
        })),
    },
  }
}

/**
 * DEV-442: where a ghost's recording BEGINS, in THREE world space.
 *
 * `spawn` is the GhostRacer's own transform, and it is not where the ship was: a legacy
 * `Animation` writes the clip's root position keys into the object's LOCAL position, so the
 * ship sits wherever the clip's first key puts it, in the PARENT's frame. On most courses the
 * author left the object at its clip's start and the two agree to a few decimetres. On
 * `rookie_02_hoverJet` they do not: both of its mission-scene ghosts still stand where the
 * prefab was copied from (the alpine scene's numbers), 440 m from their own course, and
 * their clips begin 17 m off each of the player's shoulders.
 *
 * So: the clip's first root key, through the parent's world transform. The racers read it
 * on a course that authored no AI pad (`game/racer-grid.ts`). Null, with the reason in
 * `_meta`, when the clip cannot be found or read -- never a guess.
 */
function ghostStart(clip, parent) {
  const rel = ghostClipPath(clip)
  if (!rel) return { start: null, meta: { why: `no unique .anim named ${clip}` } }
  const key = readClipFirstRootKey(path.join(SRC, rel))
  if (!key) return { start: null, meta: { clip: rel, why: 'no root position curve' } }
  const p = parent?.world ?? {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  }
  const scaled = { x: key.x * p.scale.x, y: key.y * p.scale.y, z: key.z * p.scale.z }
  const r = rotateByQuat(p.rotation, scaled)
  const world = { x: p.position.x + r.x, y: p.position.y + r.y, z: p.position.z + r.z }
  return {
    start: toThreePos(world),
    meta: {
      clip: rel,
      firstKeyRaw: rawPos(key),
      parent: parent?.path ?? null,
      note: 'The clip first root key, through the parent world transform (a legacy Animation writes root keys into localPosition).',
    },
  }
}

/** The object's parent in the same scene, or null at the root. */
function parentOf(scene, o) {
  if (!o.parent) return null
  if (!scene._byKey) scene._byKey = new Map(scene.flat.objects.map((x) => [x.key, x]))
  return scene._byKey.get(o.parent) ?? null
}

/** Unity quaternion (x, y, z, w) applied to a vector: q v q*. */
function rotateByQuat(q, v) {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y
  const iy = q.w * v.y + q.z * v.x - q.x * v.z
  const iz = q.w * v.z + q.x * v.y - q.y * v.x
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  }
}

/** A clip's project-relative path by its basename, through the guid index; null unless unique. */
let CLIP_PATHS = null
function ghostClipPath(name) {
  if (!CLIP_PATHS) {
    CLIP_PATHS = new Map()
    const idx = guidIndex()
    const paths = typeof idx.values === 'function' ? [...idx.values()] : Object.values(idx)
    for (const p of paths) {
      const s = String(p)
      if (!s.endsWith('.anim')) continue
      const base = path.basename(s, '.anim')
      CLIP_PATHS.set(base, [...(CLIP_PATHS.get(base) ?? []), s])
    }
  }
  const hits = CLIP_PATHS.get(name) ?? []
  return hits.length === 1 ? hits[0] : null
}

/**
 * The first key of a `.anim`'s ROOT position curve (the one whose `path:` is empty), raw
 * Unity space. A line scan for the reason `elevator.mjs` gives: the keys are inline flow
 * mappings and Unity writes these files in one fixed shape.
 */
function readClipFirstRootKey(abs) {
  if (!fs.existsSync(abs)) return null
  const lines = readUnityText(abs).split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === 'm_PositionCurves:')
  if (start < 0) return null
  const numRe = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)'
  const valueRe = new RegExp(`value:\\s*\\{x:\\s*${numRe},\\s*y:\\s*${numRe},\\s*z:\\s*${numRe}\\}`)
  let first = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s{2}m_[A-Za-z]/.test(line)) break
    if (/^\s*- curve:/.test(line)) first = null
    const m = first === null ? valueRe.exec(line) : null
    if (m) first = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }
    if (/^\s*path:\s*$/.test(line) && first) return first
  }
  return null
}

/**
 * Resolve a serialised array of AnimationClip references on a prefab instance:
 * base array from the prefab asset, then `<field>.Array.size` and `<field>.Array.data[i]`
 * instance overrides. Returns clip names (basename of the .anim asset the guid resolves to).
 */
function resolveClipArray(comp, field) {
  if (!comp) return []
  const idx = guidIndex()
  const nameOf = (ref) => {
    if (!ref || typeof ref !== 'object') return null
    const g = ref.guid
    if (!g) return null
    const p = idx && typeof idx.get === 'function' ? idx.get(g) : idx ? idx[g] : null
    return p ? path.basename(String(p), '.anim') : `guid:${g}`
  }
  const base = comp.fields && Array.isArray(comp.fields[field]) ? comp.fields[field].slice() : []
  const arr = base.map(nameOf)
  const ov = comp.instanceOverrides || {}
  for (const [k, v] of Object.entries(ov)) {
    const m = new RegExp(`^${field}\\.Array\\.data\\[(\\d+)\\]$`).exec(k)
    if (!m) continue
    arr[Number(m[1])] = nameOf(v)
  }
  const sizeKey = `${field}.Array.size`
  if (ov[sizeKey] !== undefined) {
    const n = num(ov[sizeKey])
    if (n !== undefined) arr.length = n
  }
  return arr.filter((x) => x !== null && x !== undefined)
}

/* =============================================================== the level JSON builder == */

/**
 * The launch elevator, read from the animation clip that actually drives it.
 *
 * Cached because every mission with an elevator plays the same clip — it lives
 * in `FF_WorldTour/animation/experimental/`, which is its own small surprise:
 * the shipped launch sequence is an experimental asset from a different mode's
 * folder, never moved.
 *
 * `holdSeconds` is real and is not padding. The clip's first two keys are both
 * zero, so the platform sits still for the first 0.6 s after you press — the
 * beat before the ride starts. And the last two keys are both 106.647, so it
 * arrives at 13.97 s and holds for another 1.5 s before the clip ends. Whether
 * 2016 released you at 13.97 or 15.47 is not recoverable from the assets (see
 * `releaseAtSeconds`), so both numbers travel.
 */
let elevatorCache = null
/**
 * The mission's visible SKY, as spherical harmonics.
 *
 * ── Why the sky needs extracting at all ────────────────────────────────────
 *
 * `render/sky.ts` invents one from the fog colour, which makes sky and fog the
 * same colour and the whole frame a single pink wash. The real horizon is
 * (0.52, 0.32, 0.23) linear where the fog colour is (0.71, 0.39, 0.44) — half
 * again as bright and nearly twice as blue. That difference is the wash.
 *
 * ── What comes out ─────────────────────────────────────────────────────────
 *
 * Nine SH coefficients per channel, in three.js's `SphericalHarmonics3` order,
 * projected from the six skybox faces with solid-angle weighting. NOT the art:
 * the faces are a bought pack and never ship, and a 9-coefficient projection
 * throws the picture away and keeps the gradient. `residual` records exactly how
 * much it threw away, so the choice of band count is auditable.
 *
 * ── What can and cannot be read ────────────────────────────────────────────
 *
 * Only `Skybox/6 Sided` materials, whose faces are ordinary image files. The
 * other shipped skies are `Skybox/Cubemap` pointing at Unity `.cubemap` binaries
 * (`Faceted Flight/Cubemaps/*`), which this tool cannot decode — those missions
 * get `null` and `render/sky.ts` keeps its invented gradient for them. That is
 * honest rather than convenient: M1 ships `int_01_hoverJet`, which is a 6-sided
 * SkyJ, and the rest can be done when they matter.
 *
 * ── The receipt worth reading ──────────────────────────────────────────────
 *
 * `sunAngleDeg` is the angle between the sky's own brightest direction and the
 * mission's sun — two numbers from different files that this projection never
 * mixes. On `int_01_hoverJet` it is **1.5 degrees**. That is the whole
 * validation of the face mapping: get a face transposed and it lands tens of
 * degrees out.
 */
const skyCache = new Map()
function missionSky(projectRoot, materialRel, sunTowardUnity) {
  if (!materialRel) return null
  const key = `${materialRel}|${sunTowardUnity.map((v) => v.toFixed(4)).join(',')}`
  if (skyCache.has(key)) return skyCache.get(key)

  let out = null
  try {
    const abs = path.join(projectRoot, materialRel)
    const text = readUnityText(abs)
    // Shader 104 is `Skybox/6 Sided`. Anything else we cannot read yet.
    const sixSided = /m_Shader: \{fileID: 104,/.test(text)
    if (!sixSided) {
      out = { available: false, reason: 'not a Skybox/6 Sided material', material: materialRel }
    } else {
      const paths = {}
      for (const face of SKYBOX_FACES) {
        // `String.raw`, not a plain template literal: a template literal
        // resolves `\s` to `s` and the pattern silently matches nothing.
        const m = text.match(
          new RegExp(
            String.raw`name: ${face.property}[\s\S]{0,200}?m_Texture: \{fileID: \d+, guid: (\w+)`,
          ),
        )
        if (m) paths[face.property] = guidIndex().get(m[1]) ?? null
      }
      const missing = SKYBOX_FACES.filter((f) => !paths[f.property]).map((f) => f.property)
      if (missing.length) {
        out = {
          available: false,
          reason: `unresolved faces: ${missing.join(', ')}`,
          material: materialRel,
        }
      } else {
        const faces = loadSkyboxFaces(projectRoot, paths)
        // `_Rotation` is deliberately not passed. See `SKYBOX_ROTATION_IS_LIVE`.
        const r = projectSky(faces, { bands: 3, rotationDeg: 0, step: 8 })
        const dot = r.peakDirection.reduce((a, v, i) => a + v * sunTowardUnity[i], 0)
        out = {
          available: true,
          material: materialRel,
          faces: Object.fromEntries(SKYBOX_FACES.map((f) => [f.property, paths[f.property]])),
          /** UNITY space, three.js SphericalHarmonics3 order, linear rgb. */
          sh: r.coefficients.map((c) => c.map((v) => r6(v))),
          bands: 3,
          residual: r6(r.residual),
          sampleCount: r.sampleCount,
          peakDirectionUnity: r.peakDirection.map((v) => r6(v)),
          sunAngleDeg: r6((Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI),
        }
      }
    }
  } catch (err) {
    out = { available: false, reason: String(err?.message ?? err), material: materialRel }
  }
  skyCache.set(key, out)
  return out
}

function elevatorLaunch(projectRoot) {
  if (elevatorCache) return elevatorCache
  const keys = readElevatorCurve(projectRoot)
  const stopTime = readClipStopTime(projectRoot)
  const rise = keys[keys.length - 1].value
  // The first key at full height. Everything after it is the clip holding.
  const settled = keys.find((k) => Math.abs(k.value - rise) < 1e-3)
  elevatorCache = {
    clip: ELEVATOR_CLIP,
    /** Hermite keys, seconds -> metres of local Y. Evaluate, do not lerp. */
    keys: keys.map((k) => ({
      time: r6(k.time),
      value: r6(k.value),
      inSlope: r6(k.inSlope),
      outSlope: r6(k.outSlope),
    })),
    /** Total metres risen. The ship is released this far above the spawn marker. */
    rise: r6(rise),
    /** `m_StopTime` — the clip's authored length. */
    duration: r6(stopTime ?? keys[keys.length - 1].time),
    /** When the platform stops moving, as opposed to when the clip ends. */
    settledAtSeconds: r6(settled ? settled.time : keys[keys.length - 1].time),
    /**
     * When the ship is let go.
     *
     * INFERRED, and flagged as such. `LaunchElevator.FinishLaunch()` is the
     * method that would say, and it has NO live caller in the 2016 project —
     * the clip carries `m_Events: []`, the controller has no
     * `StateMachineBehaviours`, and the only call site anywhere is inside a
     * commented-out block in `Trigger_EnableShip.cs`. So the shipped release
     * moment cannot be read off the assets; it is taken as the end of the clip.
     */
    releaseAtSeconds: r6(stopTime ?? keys[keys.length - 1].time),
    releaseInferred: true,
    // -- what you are standing on, and what you ride past ---------------------
    //
    // MEASUREMENTS, not art. The meshes themselves are licence-blocked:
    // `Projector04-Faceted.asset` lives in `Converted_Faceted_Meshes/`, the same
    // folder `content/MANIFEST.md` already marks CONFIRM, and the shaft pieces
    // are `_pwn` conversions under `FF_WorldTour/meshes/converted/`. So the paths
    // travel as evidence and the SIZES travel as numbers; FF2 draws its own.
    //
    // The shaft is the surprise. Eight segments are authored, spaced 12 m apart
    // from y=12 to y=96 -- and **seven of them are `m_IsActive: 0`**. Only
    // `ent_elevatorShaft_08` at y=96 ships. The ride is 106 m of open air with a
    // collar of structure near the top, not a climb up a lit shaft.
    platform: {
      mesh: 'Assets/Faceted Flight/Meshes/Converted_Faceted_Meshes/Projector04-Faceted.asset',
      meshShippable: false,
      // `m_LocalAABB` x scale. 5.54 x 1.04 x 5.50 m of mesh at 1.688.
      size: [9.35, 1.75, 9.28],
      // `Elevator_animator/Projector04-Faceted` localPosition, Unity space.
      offset: [0, -1.53, 0],
      scale: 1.688,
      // `LaunchElevator.PlayerShipRoot` -- where the ship is parented, relative
      // to the animated node. The ship floats ~0.45 m clear of the deck.
      shipOffset: [0, 0.67, 1.3],
    },
    shaft: {
      meshes: [
        'Assets/Faceted Flight/FF_WorldTour/meshes/converted/walls_and_pillars_pwn.asset',
        'Assets/Faceted Flight/FF_WorldTour/meshes/converted/pipes_LOD3_pwn.asset',
        'Assets/Faceted Flight/FF_WorldTour/meshes/converted/elev_shaft_013_pwn.asset',
      ],
      meshShippable: false,
      segmentsAuthored: 8,
      segmentSpacing: 12,
      // The ONLY live one. Unity Y on `Position_adjustment`, which sits at -100.
      liveSegmentLocalY: [96],
      deadSegmentLocalY: [12, 24, 36, 48, 60, 72, 84],
    },
  }
  return elevatorCache
}

/**
 * The RACE START PLATFORM — the deck, the light bar and the three launch pads.
 *
 * Matt: *"i'm talking about the race start platform with the ai launch positions
 * and whatnot."* It is a real structure in `int_01_hoverJet.unity` and the port
 * drew none of it: 21 objects under `PlayerStart_ElevatorShaft_Photon`, sitting
 * at y ~ 124 with the sea at 116.6, and FF2 rendered a 9 m deck under the ship
 * and open water everywhere else.
 *
 * ── What is shippable, and what is not ────────────────────────────────────
 *
 * The visible art is all licence-blocked: the pads are
 * `Converted_Faceted_Meshes/Projector04-Faceted.asset`, the ten deck tiles are
 * `Quantum Theory/Polyworld/Woodland/Meshes/Flooring/Floor_{A,B,C,D}.fbx`, and
 * the trim is `Materialized Mesh/MM_moulding/...`. CLAUDE.md rule 7 forbids all
 * three.
 *
 * But the DECK and the LIGHT BAR are Unity **built-in cubes** — mesh fileID
 * 10202, no guid, nothing bought. `startingPlatform_collision` is three of them,
 * and it is the better source anyway: it is what the player can actually stand
 * on, its top face lands at **y = 124.83**, and the light bar sits at 124.80.
 * The collider IS the walking surface, to three centimetres.
 *
 * So the deck travels as exact geometry and the pads travel as measurements,
 * which is the same bargain the elevator platform already makes.
 *
 * ── The pads, which is what Matt asked about ──────────────────────────────
 *
 *   player   Projector04-Faceted (1)   scale 1.688   the elevator arrives here
 *   ai       Projector04-Faceted 2     scale 1.867   15.5 m off one shoulder
 *   ai       Projector04-Faceted 3     scale 1.867   16.6 m off the other
 *
 * Two AI pads, and `int_01` races exactly two 2016 ghosts. They are not
 * decoration: they are where the opposition stood.
 */
/**
 * Metres from the ship's seat within which a pad is the one the lift brings
 * the player to: half the lift dish's own footprint. `(1)` sits 0.96 to 2.53 m
 * off the seat on the five decks that have one, the AI pads 15.8 to 18.4 m
 * (measured off this extractor's own output, 2026-09-27).
 */
const SEAT_PAD_REACH = 4.7

/**
 * `Projector04-Faceted`'s own `m_LocalAABB`, 5.54 x 1.04 x 5.50 m (the same
 * measurement `platform.size` is built from): a pad's or the lift dish's world
 * size is this times its node's scale.
 */
const PAD_AABB = Object.freeze([5.54, 1.04, 5.5])

/**
 * DEV-548: the lift's own dish — `Elevator_animator/Projector04-Faceted`, the
 * seat's sibling — as a pose in the SEAT's frame, three space: where the car
 * the player rides stands relative to the ship it carries, and its size (the
 * AABB times its node's scale, (1.688, 1.606, 1.688) on every rig).
 *
 * `platform.offset` and `shipOffset` above are rig constants and carry only the
 * dish's height under the seat; its place across (0.46 m off the animator on
 * `int_01`) and its turn are here, per mission, so the grid can stand the
 * player's pad exactly where the lift's dish docks — on `adv_02` and `int_02`
 * 1.6 m from where 2016 authored that pad. It is the same pose on all seven
 * rigs (0.93 m behind the seat, 0.27 m aside, turned 53.7 degrees); read per
 * mission all the same, so a rig that differs says so. `active` is the
 * expanded read's liveness walk, recorded: the port draws the lift on every rig
 * whatever 2016 switched off (`int_02`'s, DEV-438's census).
 */
function liftDishOf(scene, seat) {
  if (!seat) return null
  // Read EXPANDED, by path: on `rookie_01_hoverJet` the rig is a genuine prefab
  // instance, and the unexpanded read materialises the seat (a node the scene
  // references) but not its sibling — CLAUDE.md's stripped-instance trap.
  const flat = loadSceneExpanded(scene.absPath)
  const dishPath = seat.node.path.replace(/\/PlayerShipRoot$/, '/Projector04-Faceted')
  const at = (p) => flat.objects.filter((o) => o.path === p)
  const dish = at(dishPath)
  if (dish.length !== 1) {
    throw new Error(`expected one ${dishPath} in ${scene.absPath}, found ${dish.length}`)
  }
  const d = dish[0]
  // The seat as the rest of the spawn block reads it. The expanded read must
  // agree about where it is (it lists the seat twice on the prefab rig: the
  // node the scene references and the prefab's own), or the two reads are not
  // of one rig.
  const seatNode = seat.node
  for (const twin of at(seat.node.path)) {
    const a = twin.world.position
    const b = seatNode.world.position
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1e-4)
      throw new Error(`${seat.node.path}: the expanded read puts the seat elsewhere`)
  }
  // Both poses to three space, then the dish's in the seat's frame.
  const sp = toThreePos(seatNode.world.position)
  const sq = toThreeQuat(seatNode.world.rotation)
  const dp = toThreePos(d.world.position)
  const dq = toThreeQuat(d.world.rotation)
  const inv = { x: -sq[0], y: -sq[1], z: -sq[2], w: sq[3] }
  const local = rotateByQuat(inv, { x: dp[0] - sp[0], y: dp[1] - sp[1], z: dp[2] - sp[2] })
  // inv * dq, Hamilton product.
  const [bx, by, bz, bw] = dq
  const q = [
    inv.w * bx + inv.x * bw + inv.y * bz - inv.z * by,
    inv.w * by - inv.x * bz + inv.y * bw + inv.z * bx,
    inv.w * bz + inv.x * by - inv.y * bx + inv.z * bw,
    inv.w * bw - inv.x * bx - inv.y * by - inv.z * bz,
  ]
  const s = d.world.scale
  // One sign for one turn: w non-negative, so the rigs that agree read alike.
  const sign = q[3] < 0 ? -1 : 1
  return {
    node: d.path,
    pos: [r6(local.x), r6(local.y), r6(local.z)],
    quat: q.map((c) => r6(sign * c) + 0),
    size: [
      r6(PAD_AABB[0] * Math.abs(s.x)),
      r6(PAD_AABB[1] * Math.abs(s.y)),
      r6(PAD_AABB[2] * Math.abs(s.z)),
    ],
    active: !!d.activeInHierarchy,
  }
}

function startGridSpec(scene, seat = null) {
  const under = (o) => o.path.includes('/PlayerStart_ElevatorShaft_Photon/')
  const live = scene.flat.objects.filter((o) => under(o) && o.activeInHierarchy)
  const box = (o) => {
    const w = o.world
    return {
      pos: toThreePos(w.position),
      quat: toThreeQuat(w.rotation),
      size: [r6(Math.abs(w.scale.x)), r6(Math.abs(w.scale.y)), r6(Math.abs(w.scale.z))],
    }
  }
  // The deck. Built-in cubes, so `scale` IS the size in metres — a Unity Cube is
  // 1 m on a side. Verified rather than assumed: a MeshFilter with a fileID and
  // NO guid is a built-in, and 10202 is the Cube.
  const BUILTIN_CUBE = '10202'
  const isBuiltinCube = (o) =>
    (o.components || []).some(
      (c) =>
        c.type === 'MeshFilter' && c.mesh && !c.mesh.guid && String(c.mesh.fileID) === BUILTIN_CUBE,
    )
  const slabs = live
    .filter((o) => o.path.includes('/startingPlatform_collision/') && isBuiltinCube(o))
    .map(box)
  const lightBarNode = live.find((o) => o.name === 'lightBar')
  if (lightBarNode && !isBuiltinCube(lightBarNode)) {
    throw new Error('lightBar is no longer a built-in cube — its size cannot be read off scale')
  }

  // The pads. `Projector04-Faceted`'s own `m_LocalAABB` is 5.54 x 1.04 x 5.50 m
  // (the same measurement `platform.size` is built from), so the world size is
  // that times the node's scale (`PAD_AABB`).
  const padOf = (o, role) => {
    const b = box(o)
    return {
      role,
      pos: b.pos,
      quat: b.quat,
      size: [r6(PAD_AABB[0] * b.size[0]), r6(PAD_AABB[1] * b.size[1]), r6(PAD_AABB[2] * b.size[2])],
    }
  }
  // DEV-461: `int_02_hoverJet`'s deck carries a THIRD, `Projector04-Faceted 2
  // (1)` — Unity's name for a duplicate of `2` — and it is not an AI pad: it
  // stands 1.8 m off the ship's seat, on the lift, where every other deck has
  // its `(1)`. `int_02`'s own lift deck is dark in 2016 (DEV-438's census), so
  // this is the pad the player's ship rose to — the player's, AI-sized. 2016's
  // two recordings start on `2` and `3` (their first keys 1.4 and 2.2 m off the
  // centres), as on every other deck. A duplicate anywhere else would be a pad
  // nobody started from: `spare`, drawn and never a racer's start
  // (`game/racer-grid.ts` starts only from `ai`). Until DEV-461 the match was
  // `[23]` exactly, and this pad was dropped.
  const onSeat = (o) =>
    seat !== null &&
    Math.hypot(o.world.position.x - seat.x, o.world.position.z - seat.z) < SEAT_PAD_REACH
  const pads = []
  for (const o of live) {
    if (o.name === 'Projector04-Faceted (1)') pads.push(padOf(o, 'player'))
    else if (/^Projector04-Faceted [23]$/.test(o.name)) pads.push(padOf(o, 'ai'))
    else if (/^Projector04-Faceted [23] \(\d+\)$/.test(o.name))
      pads.push(padOf(o, onSeat(o) ? 'player' : 'spare'))
  }
  // Stable order: the player first, then the AI pads by position.
  pads.sort(
    (a, b) =>
      (a.role === 'player' ? 0 : 1) - (b.role === 'player' ? 0 : 1) ||
      a.pos[0] - b.pos[0] ||
      a.pos[2] - b.pos[2],
  )

  // DEV-549: 2016's deck ART — the PolyWorld floor tiles and the `MM_moulding`
  // kitbash under them — as a list of placements, one per live renderer, which
  // `render/start-deck.ts` stands `start-deck.glb`'s parts at
  // (`tools/assets/convert-start-deck.mjs`). Rule 7 has let bought geometry ship
  // from R2 since 2026-09-23; until this row the tiles travelled as a count.
  // `scale` is signed and unrounded past r6: a placement is a transform, not a
  // size. A piece standing INSIDE the lift's shaft (within half a dish of the
  // seat: every deck's `Floor_B 2 (1)`, down at the sea, 2.0 to 2.7 m off the
  // seat, where the lift rises through it) is recorded and not drawn — the
  // lift's column is where the ride goes (DEV-460), and the deck's own tiles
  // stand 13 m and more off the seat.
  const deckPartOf = (o) => {
    const mf = (o.components || []).find((c) => c.type === 'MeshFilter')
    const p = mf?.mesh?.path ?? ''
    return DECK_ART_PARTS[p.split('/').pop()] ?? null
  }
  const rendered = (o) =>
    (o.components || []).some((c) => c.type === 'MeshRenderer' && Number(c.enabled) === 1)
  const art = []
  const artInShaft = []
  for (const o of live) {
    const part = deckPartOf(o)
    if (!part || !rendered(o)) continue
    const w = o.world
    const row = {
      part,
      pos: toThreePos(w.position),
      quat: toThreeQuat(w.rotation),
      scale: [r6(w.scale.x), r6(w.scale.y), r6(w.scale.z)],
    }
    if (onSeat(o)) artInShaft.push({ ...row, node: o.name })
    else art.push(row)
  }
  art.sort((a, b) => a.part.localeCompare(b.part) || a.pos[0] - b.pos[0] || a.pos[2] - b.pos[2])

  return {
    /** Unity built-in cubes: exact geometry, and the surface you stand on. */
    slabs,
    /** Also a built-in cube. 74.9 m long — the start line. */
    lightBar: lightBarNode ? box(lightBarNode) : null,
    /** Where the three ships stand. `role` is 'player', 'ai' or 'spare'. */
    pads,
    /** DEV-549: 2016's deck art, a placement per live renderer (`start-deck.glb`'s parts). */
    art,
    /** DEV-549: deck art 2016 stood inside the lift's shaft. Evidence; not drawn. */
    artInShaft,
  }
}

/**
 * DEV-549: the mesh files 2016's start deck is drawn with, by file name, and the
 * part of `start-deck.glb` each becomes (`tools/assets/convert-start-deck.mjs`
 * reads the same files). Four PolyWorld Woodland floor tiles and one
 * Materialized-Mesh kitbash; nothing else under the deck renders but the pads,
 * the light bar and `jumpPad_03`'s cylinder inside the shaft.
 */
const DECK_ART_PARTS = Object.freeze({
  'Floor_A.fbx': 'floor-a',
  'Floor_B.fbx': 'floor-b',
  'Floor_C.fbx': 'floor-c',
  'Floor_D.fbx': 'floor-d',
  'MM_Corner_Short_01.asset': 'moulding',
})

function buildLevel(mission, envSceneIndex) {
  const scene = loadScene(mission.abs)
  const P = [] // provenance rows

  const prov = (field, value, source, detail) => {
    P.push({ field, value, source, ...(detail ? { detail } : {}) })
    return value
  }

  /* -- Level ------------------------------------------------------------------------- */
  const levelObj = oneWithScript(scene, 'Level')
  const level = scriptOn(levelObj, 'Level')

  const shipRef = fieldOf(level, 'ShipPrefab') || {}
  const shipGuid = shipRef.guid || null
  const vehicle = VEHICLE_BY_GUID[shipGuid]
  if (!vehicle) {
    throw new Error(
      `${mission.id}: unrecognised Level.ShipPrefab guid ${shipGuid} ` +
        `(${shipRef.path || 'unresolved'}). Refusing to guess a vehicle.`,
    )
  }
  prov('vehicle', vehicle, `${mission.rel}#${level.fileID} Level.ShipPrefab`, shipRef.path)

  // 2016's own presentation order, and the last step's table order (DEV-105).
  const chainIndex = campaignChain().get(mission.id) ?? null
  prov(
    'chainIndex',
    chainIndex,
    `${CHAIN_SOURCE_REL} Button_Next.SetNextLevel()`,
    chainIndex === null
      ? 'not in 2016\u2019s campaign chain; it shipped after this backup'
      : `position ${chainIndex} of ${campaignChain().size}`,
  )

  // The middle step of the level select (DEV-105). Two sources, cross-checked.
  const difficulty = difficultyFor(mission.id)
  prov(
    'difficulty',
    difficulty.difficulty,
    difficulty.source === 'menu' ? MENU_SCENE_REL : `the mission id (${mission.id})`,
    difficulty.detail,
  )

  const forceGameMode = bool(fieldOf(level, 'ForceGameMode')) ?? false
  const forcedIdx = num(fieldOf(level, 'ForcedGameMode'))
  const forcedMode = forceGameMode ? (GAME_MODE[forcedIdx] ?? null) : null
  prov(
    'forcedMode',
    forcedMode,
    `${mission.rel}#${level.fileID} Level.ForceGameMode/ForcedGameMode`,
    `ForceGameMode=${forceGameMode ? 1 : 0} ForcedGameMode=${forcedIdx}` +
      (!forceGameMode && forcedIdx ? ' (serialised but INERT)' : ''),
  )

  // DEV-061: the forcing FF2 actually applies, beside the one 2016 recorded.
  const forcedModeFf2 = dev061ForcedMode(mission.id, forcedMode)
  const forcedEffective = forcedModeFf2 ? forcedModeFf2.mode : forcedMode
  prov(
    'forcedModeFf2',
    forcedModeFf2 ? forcedModeFf2.mode : null,
    forcedModeFf2 ? 'DEVIATION DEV-061 (Matt, 2026-09-13)' : 'no deviation; `forcedMode` stands',
    forcedModeFf2
      ? `2016 forces ${forcedMode}; FF2 does not force this mission, so it runs the ` +
          `${vehicle} default. See the DEV_061_UNFORCED block.`
      : undefined,
  )

  // default mode: HoverJet missions are Ring Attack, JumpSeat missions are Target Practice,
  // unless the scene forces one. The 2016 build read PlayerPrefs "GameMode" from the menu.
  //
  // Keyed on the EFFECTIVE forcing, not on 2016's. `mode` is the mode a run boots
  // in when nothing asks for one, and `runningMode` falls through to it — so a
  // `mode` still derived from a forcing FF2 has dropped would leave the drop with
  // nothing to do. `forcedMode` above is where the 2016 record lives.
  const defaultMode = vehicle === 'hoverjet' ? 'ringAttack' : 'targetPractice'
  const mode = forcedEffective === 'freeFlight' ? 'freeFlight' : defaultMode

  const modeParentKeys = new Set()
  for (const f of MODE_PARENT_FIELDS) {
    const n = nodeForGameObjectRef(scene, fieldOf(level, f))
    if (n) modeParentKeys.add(n.key)
  }

  /* -- environment ------------------------------------------------------------------- */
  const lla = oneWithScript(scene, 'LoadLevelArt', { allowMissing: true })
  const llaS = scriptOn(lla, 'LoadLevelArt')
  const envScene = llaS ? String(fieldOf(llaS, 'levelName')) : null
  const environment = envScene ? (ENV_ID[envScene] ?? envScene) : null
  prov(
    'environment',
    environment,
    `${mission.rel}#${llaS ? llaS.fileID : '?'} LoadLevelArt.levelName`,
    envScene,
  )

  /* -- world offset ------------------------------------------------------------------ */
  const levelOffsetNode =
    scene.flat.objects.find((o) => o.name === 'levelOffset' && !o.parent) ||
    scene.flat.objects.find((o) => o.name === 'levelOffset')
  const worldOffsetRaw = levelOffsetNode ? levelOffsetNode.world.position : { x: 0, y: 0, z: 0 }
  prov(
    'worldOffset',
    toThreePos(worldOffsetRaw),
    `${mission.rel}#${levelOffsetNode ? levelOffsetNode.key : '?'} levelOffset Transform`,
    `raw Unity ${JSON.stringify(rawPos(worldOffsetRaw))}`,
  )

  /* -- props this MISSION places itself (DEV-218 / DEV-219) -------------------------- */
  const props = readMissionProps(path.join(SRC, mission.rel), environment, worldOffsetRaw)
  prov(
    'props',
    props.filter((p) => p.live).length,
    `${mission.rel} stripped prefab instances, expandPrefabs:true`,
    `${props.length} authored, ${props.filter((p) => p.live).length} live`,
  )

  /* -- spawn / respawn --------------------------------------------------------------- */
  const spawnNode = nodeForComponentRef(scene, fieldOf(level, 'SinglePlayerSpawnPosition'))
  const respawnNode = nodeForComponentRef(scene, fieldOf(level, 'SinglePlayerRespawnPosition'))
  // ── can THIS ship start an elevator at all? ─────────────────────────────
  //
  // Traced from the 2016 code, not branched on the vehicle id — see
  // `launchCapability`. A scene may contain a `LaunchElevator` (five of the six
  // JumpSeat scenes do, and `playerstart_jumpSeat.prefab` carries one of its
  // own) without any of them being reachable, because the only thing that calls
  // `StartLaunch()` is a component the JumpSeat does not have.
  const launchCap = launchCapability(shipRef.path || '')
  const elevator = launchCap.canStartElevator
    ? oneWithScript(scene, 'LaunchElevator', { allowMissing: true })
    : null
  // Same test for the other half: `Trigger_EnableShip.EnableShip()` does nothing
  // at all without `Ship_HoverShip` on the player, so its `delay` and
  // `enableGravity` are not this mission's behaviour when the ship has none.
  const enableShip = launchCap.enableShipApplies
    ? oneWithScript(scene, 'Trigger_EnableShip', { allowMissing: true })
    : null
  const enableShipS = scriptOn(enableShip, 'Trigger_EnableShip')
  const jumpStart = launchCap.canStartElevator ? null : readJumpSeatStart(mission.abs)

  // Level.InstantiatePlayerShip() (Level.cs:287-294) picks SinglePlayerRespawnPosition when
  // `respawning` is true and SinglePlayerSpawnPosition otherwise. `respawning` is SERIALISED 1
  // in all 13 shipped scenes (the C# initialiser says false -- the cardinal rule applies), and
  // Level.cs:135-138 can only ever set it true again, never false. Both markers are emitted;
  // `markerUsedAtLoad` records which one the shipped code path actually reads.
  const respawningFlag = bool(fieldOf(level, 'respawning')) ?? false
  const markerUsed = respawningFlag ? 'respawn' : 'spawn'
  // Four JumpSeat scenes leave SinglePlayerSpawnPosition null; there the respawn marker is
  // the only marker, which is consistent with respawning === true.
  //
  // DEV-101. Where there is a rideable elevator, the pre-launch pose comes from the
  // ELEVATOR's own seat and not from `Level.SinglePlayerSpawnPosition` — see
  // `elevatorSeat`. The two agree on six of the seven rigs; on `rookie_02_hoverJet`
  // the spawn field is wired to the respawn marker 107.010 m up the shaft, and 2016
  // never reads it. Scoped to `elevator`, so the six JumpSeats — whose ship cannot
  // call `StartLaunch()` however many `LaunchElevator`s stand around them — keep the
  // marker they have always used.
  const seat = elevator ? elevatorSeat(scene, elevator) : null
  // ── DEV-109: read the marker the SHIPPED CODE reads ────────────────────
  //
  // `markerUsedAtLoad` below already records which of the two fields
  // `Level.InstantiatePlayerShip()` consults, and until 2026-09-14 the line
  // that picked the node did not consult it — it took `spawnNode` whenever
  // there was one. That is DEV-069's trap in its purest form: a generated
  // receipt saying exactly what the game does, sitting beside code doing
  // something else, both of them right-looking.
  //
  // `Level.respawning` is serialised **1** in all thirteen shipped scenes (the
  // C# initialiser says false — the cardinal rule), so `Level.cs:287-294` reads
  // `SinglePlayerRespawnPosition` every time and `SinglePlayerSpawnPosition` is
  // dead YAML in every mission in the game. In eleven of the thirteen the two
  // fields name the same node and nothing could tell. In the two that are left
  // they do not:
  //
  //   int_01_jumpSeat     spawn field -> the HOVERJET DECOY's seat
  //                       (`PlayerStart_ElevatorShaft_Photon`, the node
  //                       CLAUDE.md warns about), 2.7 km from 2016's own
  //                       `levelOffset/playerstart_jumpSeat`
  //   rookie_02_jumpSeat  spawn field -> its own rig's seat, 109.42 m BELOW
  //                       where 2016 starts it, at the bottom of a shaft a
  //                       JumpSeat cannot ride
  //
  // Both were DEV-101's finding, filed and not fixed because the move is large
  // and touches DEV-074's boundary geometry. Matt settled it 2026-09-14.
  //
  // The ELEVATOR SEAT still wins where there is one, and that is not a third
  // rule: `LaunchElevator.StartLaunch()` reparents the ship to `PlayerShipRoot`
  // before either marker is read, so on a rigged mission the seat IS the
  // pre-launch pose. Scoped to `elevator` exactly as DEV-101 scoped it — the
  // six JumpSeats have `LaunchElevator`s standing around them that their ship
  // can never call.
  const markerNode = respawningFlag ? respawnNode || spawnNode : spawnNode || respawnNode
  const effSpawnNode = seat ? seat.node : markerNode
  const spawn = effSpawnNode
    ? {
        pos: toThreePos(effSpawnNode.world.position),
        quat: toThreeQuat(effSpawnNode.world.rotation),
        yaw: yawDeg(toThreeQuat(effSpawnNode.world.rotation)),
        launchKind: elevator ? 'elevator' : 'direct',
        // ── The launch elevator's real motion ──────────────────────────────
        //
        // This block used to read `Mover_Lift.amplitude` and call it the release
        // height. That component is DEAD: its `move` flag is 0 and nothing in the
        // 2016 codebase ever sets it, so `LiftMove()` never ran. What runs is an
        // `Animator` that starts `m_Enabled: 0` and is switched on by
        // `LaunchElevator.StartLaunch()` (LaunchElevator.cs:47), playing
        // `elevator_up.anim`.
        //
        // Why it matters that this is the right source: the spawn marker is at
        // the BOTTOM of the shaft — 19.79 m on `int_01`, roughly 95 m UNDER the
        // ocean surface and deep inside the 164 m fog plane. A port that spawns
        // there and skips the lift starts the player underwater in total fog,
        // which reads as "the fog is broken". It did, twice.
        //
        // Two independent sources agree on where the ride ends:
        //
        //   transform chain to the platform   19.790 m  (= spawn.pos[1])
        //   + elevator_up.anim final key     106.647 m
        //   = release                        126.437 m
        //   2016 ghost recordings start at   126.286 m   <- 15 cm
        //
        // `Mover_Lift`'s 108.5 would have said 128.29 — nearly two metres out.
        // DEV-548: and the lift's own dish, in the seat's frame, per mission.
        launch: elevator ? { ...elevatorLaunch(SRC), dish: liftDishOf(scene, seat) } : null,
        // The race start platform: the deck you stand on, the start line, and
        // the three launch pads. See `startGridSpec`.
        startGrid: startGridSpec(scene, effSpawnNode.world.position),
        // KEPT, and no longer used for the release height. `Mover_Lift.amplitude`
        // is 108.5 on a component whose `move` flag is 0 and which NOTHING in the
        // 2016 codebase ever sets, so it never moved anything. It stays in the
        // sheet as evidence — two metres away from the number that is real.
        deadMoverLiftAmplitude: (() => {
          const lift = elevator ? scriptOn(elevator, 'Mover_Lift') : null
          return num(fieldOf(lift, 'amplitude')) ?? null
        })(),
        enableShipDelay: num(fieldOf(enableShipS, 'delay')) ?? null,
        enableGravityOnLaunch: bool(fieldOf(enableShipS, 'enableGravity')) ?? null,
        /**
         * How a JumpSeat mission actually starts, and null where an elevator
         * does the job instead. See `readJumpSeatStart`.
         */
        jumpStart,
        /** The receipt for `launchKind`. A structural claim needs one (§4.7). */
        launchTrace: launchCap,
        marker: seat
          ? 'LaunchElevator.PlayerShipRoot (the elevator seat)'
          : effSpawnNode === respawnNode
            ? respawningFlag
              ? 'SinglePlayerRespawnPosition (Level.respawning is 1 — the marker the shipped code reads)'
              : 'SinglePlayerRespawnPosition (fallback: spawn marker is null in this scene)'
            : 'SinglePlayerSpawnPosition',
        /**
         * DEV-101's receipt. `Level.SinglePlayerSpawnPosition` is no longer the
         * source for a rigged mission, so what it says is recorded instead: on
         * six rigs it names the same node as the seat, on `rookie_02_hoverJet`
         * it names the respawn marker one rise higher.
         */
        seatTrace: seat
          ? {
              node: seat.node.path,
              seatRef: seat.seatRef,
              seatRefAgrees: seat.seatRefAgrees,
              spawnFieldNode: spawnNode ? spawnNode.path : null,
              spawnFieldAgrees: spawnNode ? spawnNode.key === seat.node.key : null,
              spawnFieldAboveSeat: spawnNode
                ? r6(spawnNode.world.position.y - seat.node.world.position.y)
                : null,
            }
          : null,
      }
    : null
  const respawn = respawnNode
    ? {
        pos: toThreePos(respawnNode.world.position),
        quat: toThreeQuat(respawnNode.world.rotation),
        yaw: yawDeg(toThreeQuat(respawnNode.world.rotation)),
        // Against the pose `spawn` actually carries, so the number stays the ride
        // it is read as. It was `spawnNode` and therefore 0 on `rookie_02_hoverJet`,
        // where the two markers are one node — the tell nobody was reading (DEV-101).
        aboveSpawn: effSpawnNode
          ? r6(respawnNode.world.position.y - effSpawnNode.world.position.y)
          : 0,
        marker: 'SinglePlayerRespawnPosition',
      }
    : null
  // Simply the flag now. It used to read `spawnNode ? markerUsed : 'respawn'`,
  // which is the same answer for twelve missions and the WRONG one for a scene
  // that has a spawn field the code never reads — the receipt was hedging in
  // the direction of the bug it existed to expose.
  const markerUsedAtLoad = markerUsed
  prov(
    'spawn.pos',
    spawn?.pos,
    `${mission.rel}#${effSpawnNode ? effSpawnNode.key : '?'} ${
      seat
        ? 'LaunchElevator.PlayerShipRoot'
        : `Level.SinglePlayer${markerUsedAtLoad === 'respawn' ? 'Respawn' : 'Spawn'}Position`
    }`,
    effSpawnNode ? effSpawnNode.path : null,
  )
  prov(
    'respawn.pos',
    respawn?.pos,
    `${mission.rel}#${respawnNode ? respawnNode.key : '?'} Level.SinglePlayerRespawnPosition`,
    respawnNode ? respawnNode.path : null,
  )
  prov(
    'markerUsedAtLoad',
    markerUsedAtLoad,
    `${mission.rel}#${level.fileID} Level.respawning`,
    `serialised respawning=${respawningFlag ? 1 : 0}; Level.cs:287-294 selects the ` +
      `${markerUsedAtLoad} marker. The C# initialiser says false; the scene says 1.`,
  )

  /* -- rings / orbs / pads / route --------------------------------------------------- */
  const ringGroups = readRings(scene, modeParentKeys)
  const finish = readFinish(mission.abs)
  const orbs = readOrbs(scene, modeParentKeys, mission.id)
  const pads = readPads(scene, modeParentKeys, mission.abs)
  const ui = readUiStrings(vehicle, shipRef.path || null)
  prov(
    'ui.briefing',
    ui ? JSON.stringify(ui.briefing) : null,
    `${ui?._meta.prefab}#${ui?._meta.briefing.fileID} UnityEngine.UI.Text.m_Text`,
    ui ? `${ui._meta.prefab}:${ui._meta.briefing.line} (${ui._meta.briefing.path})` : null,
  )
  const turnIndicators = readTurnIndicators(scene, modeParentKeys)
  const route = readRoute(scene, modeParentKeys)
  // The course, not merely the live groups: DEV-210. `readRings` is faithful to the scene
  // and adv_01 has a live group that is not the course, so the spline decides.
  const course = selectCourse(ringGroups, route, mission.id)
  const routes = course.routes
  const liveRings = routes.reduce((n, r) => n + r.rings.length, 0)
  prov(
    'routes',
    `${routes.length} route(s), ${liveRings} live rings`,
    `${mission.rel} TriggerCheckpoint liveness walk`,
    'm_Enabled==1 && addScore!=0 && parent chain m_IsActive==1 (mode parents excepted)' +
      (course.dropped.length
        ? `; then DEV-210 dropped ${course.dropped.length} live group(s) off the Curvy ` +
          `spline (${course.dropped.map((d) => `${d.id} @ ${d.splineFitM}m`).join(', ')})`
        : ''),
  )
  prov(
    'orbs.posFf2',
    orbs.filter((o) => o.posFf2).length || null,
    'DEVIATION DEV-067 (Matt, 2026-09-13)',
    orbs.some((o) => o.posFf2)
      ? `${orbs.filter((o) => o.posFf2).length} of ${orbs.length} live orbs raised to ` +
          `ground + ${DEV_067_ORB_FLOOR[mission.id]?.floorM} m, the least clearance 2016 gives a ` +
          "live orb on this island; x and z unchanged. `pos` remains 2016's."
      : 'no orb of this mission is inside its own terrain, or its mode does not collect orbs',
  )

  /* -- medals (LevelEnd on the finale_logic prefab instance) -------------------------- */
  const levelEndObj = oneWithScript(scene, 'LevelEnd', { allowMissing: true })
  const le = scriptOn(levelEndObj, 'LevelEnd')
  const medalKeys = {
    bronze: 'bronzeMin',
    silver: 'silverMin',
    gold: 'goldMin',
    platinum: 'platinumMin',
  }
  const expKeys = {
    bronze: 'bronzeMinExp',
    silver: 'silverMinExp',
    gold: 'goldMinExp',
    platinum: 'platMinExp',
  }
  const medals = {}
  const medalsExp = {}
  for (const [k, f] of Object.entries(medalKeys)) {
    medals[k] = num(fieldOf(le, f)) ?? null
    prov(
      `medals.${k}`,
      medals[k],
      `${mission.rel}#${le ? le.fileID : '?'} LevelEnd.${f}`,
      fieldSrc(le, f, levelEndObj),
    )
  }
  for (const [k, f] of Object.entries(expKeys)) {
    medalsExp[k] = num(fieldOf(le, f)) ?? null
    prov(
      `medalsExp.${k}`,
      medalsExp[k],
      `${mission.rel}#${le ? le.fileID : '?'} LevelEnd.${f}`,
      fieldSrc(le, f, levelEndObj),
    )
  }

  /* -- timers ------------------------------------------------------------------------ */
  const timerRaceObj = oneWithScript(scene, 'Timer_Race', { allowMissing: true })
  const tr = scriptOn(timerRaceObj, 'Timer_Race')
  const raceTimerObj = oneWithScript(scene, 'RaceTimer', { allowMissing: true })
  const rt = scriptOn(raceTimerObj, 'RaceTimer')
  const maxRaceTime = num(fieldOf(tr, 'maxRaceTime')) ?? null
  const timeAttackMax = num(fieldOf(rt, 'timeAttack_maxTime')) ?? null
  const timer = {
    // Timer_Race.RaceTimer() coroutine ends the level when maxRaceTime - currentRaceTime <= 0
    // (Timer_Race.cs:96-99). This is the enforced limit.
    timeLimit: maxRaceTime,
    // LevelEnd.cs:298 SetInt(level+"_parTime", (int)timer.maxRaceTime) runs AFTER
    // RaceTimer.cs:53 SetFloat(...timeAttack_maxTime), so the int write wins and the
    // leaderboard bonus uses maxRaceTime. (_verify-v-modes E13.)
    bonusParTime: maxRaceTime,
    // The value 2016 wrote first and then overwrote. Kept so the 20% rookie_01 swing is
    // visible in the data rather than only in a document.
    shadowedParTime: timeAttackMax,
    // -- the race countdown (DEV-048) ---------------------------------------------
    //
    // `Timer_Race.Countdown()` waits `delayBetweenCountdown`, and either steps the
    // number down or, at zero, starts the race. So the wall time is
    // `(countdownTime + 1) * delayBetweenCountdown` -- four beats for a 3-2-1-GO, not
    // three -- and the last beat is GO itself.
    //
    // ── `shipped` used to be a single flag, and it was WRONG ──────────────────
    //
    // It read `Timer_Race.useCountdown` and stopped there, which is 0 on all
    // thirteen, so the port recorded "2016 never ran the countdown" and DEV-015
    // turned it on as a deviation. But `useCountdown` gates exactly ONE caller --
    // `Timer_Race.OnEnable` (Timer_Race.cs:22-27). `StartCountdown()` is public,
    // and `Trigger_EnableShip.DelayedEnable()` calls it with no reference to the
    // flag at all, after waiting its own `delay`. Six of the seven HoverJet
    // missions wire a live `Trigger_EnableShip` to the live `Timer_Race`, so the
    // countdown really does play in the shipped game -- and so does the race
    // clock, because `useRaceTimer = true` is set at the END of that same
    // coroutine.
    //
    // So the two facts are emitted SEPARATELY and `shipped` is derived. The
    // interesting thing here is precisely that the flag and the behaviour
    // disagree, and one boolean throws that away. `rookie_01_hoverJet` is the
    // HoverJet mission with no `Trigger_EnableShip` at all, which is the case a
    // single flag could never have told apart from the other six.
    //
    // The TIMING is not invented. `countdownTime` and `delayBetweenCountdown` are the
    // values sitting on the shipped component -- note `delayBetweenCountdown` is 1, not
    // the C# initialiser's 0.5, so the cardinal rule earns its keep even on a feature
    // whose own flag was switched off.
    countdown: (() => {
      const useCountdownFlag = bool(fieldOf(tr, 'useCountdown')) ?? false
      const trig = countdownStartTrigger(scene, modeParentKeys, tr)
      const steps = num(fieldOf(tr, 'countdownTime')) ?? null
      const stepSeconds = num(fieldOf(tr, 'delayBetweenCountdown')) ?? null
      return {
        /** DERIVED: does a countdown happen in this mission, by either route. */
        shipped: useCountdownFlag || !!trig,
        /** `Timer_Race.useCountdown`. 0 in all thirteen — it gates only `OnEnable`. */
        useCountdownFlag,
        /** A live `Trigger_EnableShip` wired to the live `Timer_Race`. The real route. */
        startedByTrigger: !!trig,
        /** `Trigger_EnableShip.delay` — the wait BEFORE the countdown starts. */
        triggerDelay: trig ? trig.delay : null,
        steps,
        stepSeconds,
        seconds: steps === null || stepSeconds === null ? null : r6((steps + 1) * stepSeconds),
        _meta: trig
          ? {
              triggerPath: trig.path,
              triggerFileID: trig.fileID,
              timerRaceFileID: trig.timerFileID,
              note:
                'Trigger_EnableShip.DelayedEnable() waits `delay`, calls ' +
                'Timer_Race.StartCountdown() with no useCountdown check, and the countdown ' +
                'coroutine then sets useRaceTimer = true — so this is also when the race ' +
                'clock starts.',
            }
          : {
              note:
                'No live Trigger_EnableShip wired to the live Timer_Race, and useCountdown ' +
                'is 0, so nothing in this mission calls StartCountdown().',
            },
      }
    })(),
  }
  prov(
    'timer.timeLimit',
    timer.timeLimit,
    `${mission.rel}#${tr ? tr.fileID : '?'} Timer_Race.maxRaceTime`,
    fieldSrc(tr, 'maxRaceTime', timerRaceObj),
  )
  prov(
    'timer.shadowedParTime',
    timer.shadowedParTime,
    `${mission.rel}#${rt ? rt.fileID : '?'} RaceTimer.timeAttack_maxTime`,
    'overwritten by LevelEnd.cs:298 SetInt -- see _verify-v-modes E13',
  )

  /* -- scoring ----------------------------------------------------------------------- */
  const scoring = {
    gateMultiplier: num(fieldOf(le, 'gateMultiplier')) ?? 100,
    levelDelay: num(fieldOf(le, 'levelDelay')) ?? null,
    timePenalty: num(fieldOf(le, 'timePenalty')) ?? null,
    timeBonusMultiplier: CODE_CONSTANTS.timeBonusMultiplier,
    // LevelEnd.cs:300 SetFloat vs Scoreboard.cs:77 GetInt -- the HoverJet fuel penalty
    // always reads 0 in the shipped build.
    fuelPenaltyEnabled: false,
    timeAffectsMedal: DEV_004_TIME_AFFECTS_MEDAL,
  }
  prov(
    'scoring.gateMultiplier',
    scoring.gateMultiplier,
    `${mission.rel}#${le ? le.fileID : '?'} LevelEnd.gateMultiplier`,
    fieldSrc(le, 'gateMultiplier', levelEndObj),
  )
  prov(
    'scoring.levelDelay',
    scoring.levelDelay,
    `${mission.rel}#${le ? le.fileID : '?'} LevelEnd.levelDelay`,
    fieldSrc(le, 'levelDelay', levelEndObj),
  )
  prov(
    'scoring.timeBonusMultiplier',
    scoring.timeBonusMultiplier,
    'Scoreboard.cs:14',
    'private double = 11.5, not serialised: code default IS shipped behaviour',
  )
  prov(
    'scoring.timeAffectsMedal',
    scoring.timeAffectsMedal,
    'DEVIATION DEV-004 (Matt, 2026-09-09)',
    '2016 ignored time for medals; FF2 pays the time bonus into the score, and only on a ' +
      'run that took every ring (DEV-393). With platinum at every ring it orders clean runs ' +
      'and moves no medal (DEV-393 follow-up).',
  )

  /* -- boundary ---------------------------------------------------------------------- */
  //
  // The LIVENESS WALK, not just the component flag. CLAUDE.md's ring rule is
  // `m_Enabled: 1` **and** the whole `m_Father` chain `m_IsActive: 1`, and a
  // trigger is no different: Unity fires nothing at all on a deactivated
  // GameObject, whatever its component says.
  //
  // `rookie_01_jumpSeat` is the one this catches. Its `trigger_playArea` carries
  // `PlayerBoundary` with `m_Enabled: 1` on a GameObject whose
  // `activeInHierarchy` is FALSE — so the port recorded a live boundary for a
  // mission that shipped without one, which is the same class of mistake as the
  // 77-rings-instead-of-21 count the ring walk exists to prevent.
  //
  // It was latent: nothing had ever flown far enough out on that mission to
  // trip it. `tests/e2e/completion.spec.ts` flying all thirteen is what put the
  // boundary under a light at all.
  const pbObj = withScript(scene, 'PlayerBoundary')[0] || null
  const pb = scriptOn(pbObj, 'PlayerBoundary')
  const pbLive = !!pbObj && pbObj.activeInHierarchy !== false
  const boundary = {
    enabled: pb ? pbLive && num(fieldOf(pb, 'm_Enabled') ?? pb.enabled) !== 0 : false,
    resetDelay: pb ? (num(fieldOf(pb, 'resetDelay')) ?? null) : null,
    present: !!pb,
    // -- the volume you have to stay inside --------------------------------------
    //
    // `PlayerBoundary` is a TRIGGER, and the countdown starts on
    // `OnTriggerExit` -- so this is a region you are inside, not an obstacle you
    // hit. On `int_01` it is a SphereCollider of radius 0.5 on a transform scaled
    // 5837.42, which is Unity's `radius * max(|scale|)` = **2918.7 m**.
    //
    // A sphere is not a guess or a simplification: it is the actual collider.
    // Five of the thirteen missions disable the component entirely and have no
    // boundary at all.
    volume: (() => {
      if (!pbObj) return null
      const collider = (pbObj.components || []).find((c) => c.classId === 135 || c.classId === 65)
      if (!collider) {
        console.warn(
          `  ! ${mission.id}: PlayerBoundary on "${pbObj.name}" has no sphere or box collider`,
        )
        return null
      }
      const w = pbObj.world
      const sx = Math.abs(num(w.scale?.x, 1))
      const sy = Math.abs(num(w.scale?.y, 1))
      const sz = Math.abs(num(w.scale?.z, 1))
      const centreLocal = collider.center ?? { x: 0, y: 0, z: 0 }
      // The collider's own centre offset, scaled and added in world axes. Every
      // shipped boundary is unrotated, so this does not need the quaternion --
      // and if one ever is, the assertion below will say so.
      const centre = {
        x: num(w.position?.x) + num(centreLocal.x) * sx,
        y: num(w.position?.y) + num(centreLocal.y) * sy,
        z: num(w.position?.z) + num(centreLocal.z) * sz,
      }
      const rot = w.rotation ?? { x: 0, y: 0, z: 0, w: 1 }
      const rotated = Math.abs(num(rot.x)) + Math.abs(num(rot.y)) + Math.abs(num(rot.z)) > 1e-4
      const offset =
        Math.abs(num(centreLocal.x)) + Math.abs(num(centreLocal.y)) + Math.abs(num(centreLocal.z))
      // Rotation only matters if the collider is OFF-CENTRE on its own transform.
      // A centred sphere does not care which way its object is facing, and most
      // of these `trigger_playArea` objects are rotated for no reason at all.
      if (rotated && offset > 1e-6) {
        console.warn(
          `  ! ${mission.id}: PlayerBoundary "${pbObj.name}" is ROTATED; its centre offset is approximated`,
        )
      }
      if (collider.classId === 65) {
        const size = collider.size ?? { x: 1, y: 1, z: 1 }
        return {
          shape: 'box',
          centre: toThreePos(centre),
          half: [
            r6((num(size.x) * sx) / 2),
            r6((num(size.y) * sy) / 2),
            r6((num(size.z) * sz) / 2),
          ],
          isTrigger: num(collider.isTrigger) === 1,
          gameObject: pbObj.name,
        }
      }
      return {
        shape: 'sphere',
        centre: toThreePos(centre),
        // Unity scales a SphereCollider by the LARGEST axis, not per-axis.
        radius: r6(num(collider.radius, 0.5) * Math.max(sx, sy, sz)),
        isTrigger: num(collider.isTrigger) === 1,
        gameObject: pbObj.name,
      }
    })(),
    // `Trigger_Kill.RestartLevel()`: snap to black over `fade.killSeconds`,
    // "explode2", then this long before the scene reloads. The pause is the
    // death, and cutting it would make a boundary reset feel like a bug rather
    // than a consequence. Off the sheet, not typed — see `RESPAWN_HOLD_SECONDS`.
    resetFadeSeconds: RESPAWN_HOLD_SECONDS,
  }
  prov(
    'boundary.enabled',
    boundary.enabled,
    `${mission.rel}#${pb ? pb.fileID : '(absent)'} PlayerBoundary.m_Enabled + GameObject.m_IsActive`,
    pb
      ? `component enabled flag = ${fieldOf(pb, 'm_Enabled') ?? pb.enabled}, ` +
          `GameObject "${pbObj.name}" activeInHierarchy = ${pbObj.activeInHierarchy}` +
          (pbLive ? '' : ' -- DEACTIVATED, so the trigger fires nothing')
      : 'no PlayerBoundary in scene',
  )
  prov(
    'boundary.resetDelay',
    boundary.resetDelay,
    `${mission.rel}#${pb ? pb.fileID : '(absent)'} PlayerBoundary.resetDelay`,
    'the C# initialiser says 10; the shipped scenes say 13. The scene wins.',
  )

  /* -- medalsFf2: platinum is every ring (DEV-393 follow-up) ---------------------------- */
  //
  // See the `medalsFf2` note under DEV_004_TIME_AFFECTS_MEDAL. `medals` above stays exactly as
  // 2016 shipped it; this is the separate set FF2 actually awards against, so the
  // ledger keeps a faithful record and the game keeps a working curve.
  //
  // The MAX over routes, not the sum (DEV-210): a run flies one route.
  const ringCeiling = routes.reduce(
    (best, r) =>
      Math.max(
        best,
        r.rings.reduce((n, ring) => n + ring.scoring.addScore, 0) * scoring.gateMultiplier,
      ),
    0,
  )

  const medalsFf2 =
    ringCeiling > 0 && medals.platinum !== null
      ? {
          // 2016's, untouched: they gate on rings, and an incomplete run earns
          // no time bonus (DEV-393), so it scores rings alone.
          bronze: medals.bronze,
          silver: medals.silver,
          gold: medals.gold,
          // Every ring. A clean run scores at least this; any other scores less.
          platinum: ringCeiling,
          _meta: {
            deviation: 'DEV-393 follow-up',
            ringCeiling,
            note:
              'Matt, 2026-09-25: "gold medal = 90, plat = 100". bronze/silver/gold are the ' +
              '2016 values; platinum is every ring. A missed ring forfeits the time bonus ' +
              '(DEV-393), so a run reaches platinum exactly when it takes every ring. ' +
              "DEV-004's time-based platinum is retired.",
          },
        }
      : medals.platinum === null
        ? null
        : {
            ...medals,
            _meta: {
              deviation: 'DEV-393 follow-up',
              note: 'no live scoring rings, so no ring ceiling: the 2016 medals stand unchanged',
            },
          }

  prov(
    'medalsFf2.platinum',
    medalsFf2?.platinum ?? null,
    'DEVIATION DEV-393 follow-up (Matt, 2026-09-25)',
    ringCeiling > 0
      ? `ringCeiling ${ringCeiling}: every live ring x ${scoring.gateMultiplier}, on the route with the most`
      : 'no live scoring rings',
  )

  /* -- fog --------------------------------------------------------------------------- */
  const fogObj = oneWithScript(scene, 'LevelEffects_GlobalFog', { allowMissing: true })
  const fg = scriptOn(fogObj, 'LevelEffects_GlobalFog')
  const rs = scene.flat.renderSettings || {}
  const fogColor = rs.m_FogColor || null
  const fog = fg
    ? {
        height: num(fieldOf(fg, 'height')) ?? null,
        heightDensity: num(fieldOf(fg, 'heightDensity')) ?? null,
        startDistance: num(fieldOf(fg, 'startDistance')) ?? null,
        distanceFog: bool(fieldOf(fg, 'distanceFog')) ?? null,
        heightFog: bool(fieldOf(fg, 'heightFog')) ?? null,
        radial: bool(fieldOf(fg, 'useRadialDistance')) ?? null,
        excludeFarPixels: bool(fieldOf(fg, 'excludeFarPixels')) ?? null,
        color: fogColor ? [r6(fogColor.r), r6(fogColor.g), r6(fogColor.b), r6(fogColor.a)] : null,
        density: num(rs.m_FogDensity) ?? null,
        mode: num(rs.m_FogMode) ?? null,
        // Only read when mode is 1 (linear). No shipped mission uses linear —
        // they are all 2 (exponential) or 3 (exponential squared) — but the
        // renderer implements all three, and a field that exists in the source
        // and not in the JSON is a hole someone fills with a guess.
        linearStart: num(rs.m_LinearFogStart) ?? null,
        linearEnd: num(rs.m_LinearFogEnd) ?? null,
        sceneFogEnabled: bool(rs.m_Fog) ?? null,
      }
    : null
  prov(
    'fog.height',
    fog?.height,
    `${mission.rel}#${fg ? fg.fileID : '?'} LevelEffects_GlobalFog.height`,
    fieldSrc(fg, 'height', fogObj),
  )
  prov(
    'fog.heightDensity',
    fog?.heightDensity,
    `${mission.rel}#${fg ? fg.fileID : '?'} LevelEffects_GlobalFog.heightDensity`,
    fieldSrc(fg, 'heightDensity', fogObj),
  )
  prov(
    'fog.color',
    fog?.color,
    `${mission.rel} RenderSettings.m_FogColor`,
    'scene RenderSettings document',
  )

  /* -- ghosts ------------------------------------------------------------------------ */
  let envSceneObj = null
  if (envScene && envSceneIndex.has(envScene)) {
    try {
      envSceneObj = loadScene(envSceneIndex.get(envScene))
    } catch (_e) {
      envSceneObj = null
    }
  }
  const ghostBundle = readGhosts(mission.id, vehicle, scene, envSceneObj)

  /* -- the environment's clouds ------------------------------------------------------- */
  //
  // Read from the flattened ENVIRONMENT SCENE, never from the level-art prefab
  // file: `constants.mjs:crossCheckEnvironment` documents an environment whose
  // scene carries its own copy of the art and instantiates no prefab at all, so
  // the prefab is not evidence that anything loads. Simonet does instantiate
  // it, at identity, with no cloud touched by a modification.
  const clouds = readClouds(envSceneObj)

  /* -- lighting ---------------------------------------------------------------------- */
  //
  // The sun is a PER-MISSION constant, not a per-environment one, and finding
  // that out took a seventh provenance trap.
  //
  // `Prefabs/Levels/LevelArt_SimonetIslands.prefab` carries a GameObject called
  // "Directional light" — the obvious place for an environment's sun, and it is
  // `m_IsActive: 0`. Disabled. What actually lights the world is a DISCONNECTED
  // COPY of it sitting in each mission scene, named "Directional light (1)",
  // pointing somewhere else entirely.
  //
  // And they genuinely differ mission to mission: across the 13 shipped levels
  // the sun runs from 0.1 deg of elevation (int_02_hoverJet, effectively sunset)
  // to 56.8 deg (rookie_01_jumpSeat, near midday), with intensities from 0.5 to
  // 1.3 and colours from warm orange to near-white. Lighting is part of each
  // mission's identity, so it belongs here in the level JSON rather than beside
  // the terrain parameters.
  const lightObjs = scene.flat.objects.filter((o) =>
    (o.components || []).some((c) => c.classId === 108 && num(c.enabled) === 1),
  )
  const liveLights = lightObjs.filter((o) => o.activeInHierarchy)

  const lightRow = (o) => {
    const c = (o.components || []).find((x) => x.classId === 108)
    // A Unity light shines along its transform's +Z. Convert the world
    // quaternion to three space first, THEN take forward — converting the
    // direction afterwards would flip the wrong axis.
    const q = toThreeQuat(o.world.rotation)
    const [x, y, z, w] = q
    // three's forward is -Z, and Unity's light points +Z, so the travel
    // direction in three space is the rotated -Z axis.
    const dir = [
      r6(-(2 * (x * z + w * y))),
      r6(-(2 * (y * z - w * x))),
      r6(-(1 - 2 * (x * x + y * y))),
    ]
    const KIND = { 0: 'spot', 1: 'directional', 2: 'point', 4: 'area' }
    const intensity = num(c.intensity) ?? null
    return {
      name: o.name,
      kind: KIND[num(c.lightType)] ?? `unknown(${c.lightType})`,
      // DEV-454. The colour as a shader received it in 2016, per unit of
      // intensity: `colorLinear x intensity` is Unity 5.4's
      // `GammaToLinearSpace(m_Color x m_Intensity)`, which is what a Linear
      // project on 5.4 hands a shader (DEV-437's addendum measured it on the
      // hangar; 5.6's `lightsUseLinearIntensity` is the switch that changed
      // it, and 2016 is 5.4.1p4). This line used to say *"Unity serialises
      // light colour in LINEAR space already"* and emitted the raw `m_Color`
      // here — so every mission's sun was drawn paler than 2016's, with the
      // wrong level (DEV-446 has the table). `m_Color` is a GAMMA value, as the
      // inspector's picker shows it, and it is kept below as `colorGamma`.
      colorLinear: c.color && intensity > 0 ? unity54LightLinear(c.color, intensity) : null,
      /** The raw `m_Color`, gamma, as serialised. What `?sunlight=port` draws as if linear. */
      colorGamma: c.color ? [r6(c.color.r), r6(c.color.g), r6(c.color.b)] : null,
      intensity,
      shadows: num(c.shadows) ?? null,
      /** Unit vector the light TRAVELS along, three-space. */
      direction: dir,
      /** Degrees above the horizon. 0 is sunset; 90 is directly overhead. */
      elevationDeg: r6((Math.asin(Math.max(-1, Math.min(1, -dir[1]))) * 180) / Math.PI),
      _meta: {
        fileID: o.key,
        path: o.path,
        rotationThree: q,
        rotationRaw: rawQuat(o.world.rotation),
        positionThree: toThreePos(o.world.position),
      },
    }
  }

  // A mission with two suns would render at double intensity and look nothing
  // like 2016 — and the additively-loaded environment scene is exactly where a
  // second one would come from. Count them rather than assume.
  let envLiveLights = 0
  if (envSceneObj) {
    envLiveLights = envSceneObj.flat.objects.filter(
      (o) =>
        o.activeInHierarchy &&
        (o.components || []).some((c) => c.classId === 108 && num(c.enabled) === 1),
    ).length
  }

  const AMBIENT_MODE = { 0: 'skybox', 1: 'gradient', 3: 'flat' }
  const ambMode = num(rs.m_AmbientMode)
  const col3 = (c) => (c ? [r6(c.r), r6(c.g), r6(c.b)] : null)

  // Hoisted so the SKY projection can be cross-checked against it — see
  // `missionSky`. Its `sunAngleDeg` receipt is the whole validation of the
  // skybox face mapping.
  const sun = liveLights.length ? lightRow(liveLights[0]) : null

  const lighting = {
    sun,
    ambient: {
      mode: ambMode ?? null,
      modeName: AMBIENT_MODE[ambMode] ?? null,
      intensity: num(rs.m_AmbientIntensity) ?? null,
      skyColor: col3(rs.m_AmbientSkyColor),
      equatorColor: col3(rs.m_AmbientEquatorColor),
      groundColor: col3(rs.m_AmbientGroundColor),
    },
    skyboxMaterial: rs.m_SkyboxMaterial?.guid
      ? guidIndex().get(String(rs.m_SkyboxMaterial.guid)) || null
      : null,
    // The skybox's own colour, projected to SH. Null for the .cubemap skies we
    // cannot decode yet — `render/sky.ts` falls back for those.
    sky: missionSky(
      SRC,
      rs.m_SkyboxMaterial?.guid ? guidIndex().get(String(rs.m_SkyboxMaterial.guid)) || null : null,
      // Toward the sun, UNITY space. `sun.direction` is where the light TRAVELS,
      // in three space, so this negates it and flips z back.
      sun ? [-sun.direction[0], -sun.direction[1], sun.direction[2]] : [0, 1, 0],
    ),
    // Everything below is a liveness receipt, not a value to render with.
    liveLightCount: liveLights.length,
    environmentSceneLiveLights: envLiveLights,
    disabledLightCount: lightObjs.length - liveLights.length,
  }

  prov(
    'lighting.sun',
    lighting.sun ? `${lighting.sun.kind} I=${lighting.sun.intensity}` : null,
    `${mission.rel}#${lighting.sun ? lighting.sun._meta.fileID : '(none)'} Light`,
    'the ONLY light with m_Enabled=1 and an active parent chain. The LevelArt prefab’s own ' +
      '"Directional light" is m_IsActive: 0 — disabled — so the mission scene’s copy is what ships.',
  )
  prov(
    'lighting.ambient.mode',
    lighting.ambient.mode,
    `${mission.rel} RenderSettings.m_AmbientMode`,
    '0 = from skybox, 1 = gradient, 3 = flat colour',
  )

  prov(
    'ghosts',
    ghostBundle.ghosts.map((g) => g.clip),
    envSceneObj ? envSceneObj.absPath : mission.rel,
    ghostBundle._meta.note,
  )

  /* -- structural assertions (PORT_PLAN 4.7) ----------------------------------------- */
  const structural = {
    shipPrefab: shipRef.path || null,
    shipPrefabGuid: shipGuid,
    forceGameMode: forceGameMode ? 1 : 0,
    forcedGameMode: forcedIdx ?? null,
    /** Rings on THE COURSE -- after liveness AND after DEV-210's course selection. */
    liveRingCount: liveRings,
    // Every ring clone serialised in the scene, live or dead. The gap is deactivated old
    // route versions (CurvyClonePath[OFF], original[OFF], FinishStuff[OFF]) that a naive
    // exporter counts: 77 for int_02 instead of 21, 68 for adv_02 instead of 28.
    ringClonesPlaced: scene.flat.objects.filter((o) =>
      /^\d{4}.*Checkpoint_Ring/i.test(o.name || ''),
    ).length,
    /**
     * DEV-210. Rings that pass the liveness walk but are NOT on the course: 2016 authoring
     * debris the author left active. 22 on adv_01_hoverJet, 0 everywhere else. A change
     * here means a scene's live-but-off-course set moved, which is never a silent event.
     */
    ringsLiveOffCourse: course.dropped.reduce((n, d) => n + d.rings, 0),
    routeCount: routes.length,
    orbCountLive: orbs.filter((o) => o.live).length,
    orbCountPlaced: orbs.length,
    padCountLive: pads.filter((p) => p.live).length,
    padCountPlaced: pads.length,
    /** Trigger volumes per pad -- 19 on every shipped pad (1 landing, 1 refuel, 17 score). */
    padTriggerVolumes: pads.reduce((n, p) => n + (p._meta.volumesFound ?? 0), 0),
    /**
     * Live background clouds.
     *
     * The counts are the four environments' own, and they were 0/0 for two of
     * them until DEV-048: simonet 19, alpine 8 (of 11 authored), desert 3 (of 6),
     * kauai 19. A number here that goes back to zero is the bug returning.
     */
    cloudCountLive: clouds.length,
    cloudSource: clouds.length ? clouds[0]._meta.source : null,
    /**
     * The mission's UI strings, hashed rather than listed: thirteen copies of
     * twenty strings would drown the assertions file, but a mission whose HUD
     * wording drifts away from its siblings' still has to show up in a diff.
     */
    uiStringCount: ui ? Object.keys(ui.strings).length : 0,
    uiStringDigest: ui ? digestOf(JSON.stringify([ui.briefing, ui.strings])) : null,
    /**
     * What ends the run, and what starts it. Both were wrong on the six
     * JumpSeat missions until this session: `finishShape` was null (the gate is
     * inside a pad prefab, authored inactive) and `launchKind` was `elevator`
     * on two of them (the scene has a `LaunchElevator`; the ship cannot call it).
     */
    /**
     * DEV-048. `countdownUseFlag` is 0 on all thirteen and `countdownShipped`
     * is true on seven — the disagreement IS the finding, so both are pinned.
     */
    countdownShipped: timer.countdown.shipped,
    countdownUseFlag: timer.countdown.useCountdownFlag,
    countdownStartedByTrigger: timer.countdown.startedByTrigger,
    finishShape: finish ? finish.shape : null,
    launchKind: spawn ? spawn.launchKind : null,
    launchStarterScriptsOnShip: spawn ? spawn.launchTrace.starterScriptsOnShip : null,
    /**
     * DEV-101. Which node the pre-launch pose came from, and whether
     * `Level.SinglePlayerSpawnPosition` agrees with it. `false` on
     * `rookie_02_hoverJet` and nowhere else; the metres say by how much.
     */
    launchSeatMarker: spawn ? spawn.marker : null,
    spawnFieldAgreesWithSeat: spawn?.seatTrace ? spawn.seatTrace.spawnFieldAgrees : null,
    spawnFieldAboveSeat: spawn?.seatTrace ? spawn.seatTrace.spawnFieldAboveSeat : null,
    jumpStartSeconds: spawn?.jumpStart ? spawn.jumpStart.seconds : null,
    playerBoundaryEnabled: boundary.enabled,
    playerBoundaryResetDelay: boundary.resetDelay,
    fogHeight: fog?.height,
    fogHeightDensity: fog?.heightDensity,
    levelComponentEnabled: num(fieldOf(level, 'm_Enabled') ?? level.enabled) !== 0,
    respawningFlag: bool(fieldOf(level, 'respawning')) ?? null,
    sceneDocumentCount: scene.flat.meta.documentCount,
    gameObjectCount: scene.flat.meta.gameObjectCount,
  }

  /* -- coherence checks --------------------------------------------------------------- */
  const checks = []
  const push = (id, ok, msg) => checks.push({ id, ok, msg })
  const platRings = medals.platinum !== null ? medals.platinum / scoring.gateMultiplier : null
  // DEV-210 narrowed this from `routes.length !== 1` to `routes.length === 0`. The old form
  // excused BOTH the five ring-less JumpSeat missions (whose platinum is a pad score, so a
  // ring count says nothing about it -- still excused) AND the multi-group case, which was
  // the only mission that had the bug: adv_01 scored 44 rings against a platinum of 2200.
  // The check would have failed loudly on the day it was written had it been allowed to run.
  push(
    'platinum-reachable',
    platRings === null || routes.length === 0 || liveRings >= platRings,
    `platinum ${medals.platinum} needs ${platRings} rings x ${scoring.gateMultiplier}; ` +
      `${liveRings} live ring(s) in ${routes.length} route(s) -> max ` +
      `${liveRings * scoring.gateMultiplier}`,
  )
  push(
    'boundary-present',
    boundary.present || !boundary.enabled,
    boundary.present
      ? `PlayerBoundary enabled=${boundary.enabled} resetDelay=${boundary.resetDelay}`
      : 'no PlayerBoundary component in scene',
  )
  push(
    'spawn-present',
    !!spawn,
    spawn
      ? `spawn marker resolved (${spawn.marker}); code path uses the ${markerUsedAtLoad} marker`
      : 'MISSING spawn -- both Level spawn markers are null',
  )
  push(
    'orbs-all-live',
    orbs.length === 0 || orbs.every((o) => o.live),
    `${orbs.filter((o) => o.live).length} live of ${orbs.length} placed orb(s)`,
  )
  push(
    'pads-all-live',
    pads.length === 0 || pads.every((p) => p.live),
    `${pads.filter((p) => p.live).length} live of ${pads.length} placed pad(s)`,
  )
  push(
    'respawn-present',
    !!respawn,
    respawn ? 'Level.SinglePlayerRespawnPosition resolved' : 'MISSING respawn',
  )
  // DEV-101. HARD, and it is a RELATIONSHIP rather than an altitude: on a mission
  // with a rideable elevator, 2016's two markers BRACKET the ride — the seat at the
  // bottom, `respawn_position` (the node `Level.respawning: 1` actually spawns you
  // at) at the top, one clip's worth of rise apart. Every rig in the game satisfies
  // it; `rookie_02_hoverJet` read 0.000 while the spawn field pointed at the respawn
  // marker, which is the shape of the bug rather than a number to remember.
  // 2 m of slack because the marker is hand-placed per scene: against a 106.647 m
  // ride the seven measure 107.010, 107.370, 107.540, 107.670, 107.910, 107.910
  // and 108.074.
  const rideRise = spawn?.launch ? spawn.launch.rise : null
  push(
    'seat-brackets-the-ride',
    !spawn?.seatTrace || !respawn || Math.abs((respawn.aboveSpawn ?? 0) - rideRise) < 2,
    spawn?.seatTrace
      ? `respawn marker ${respawn ? respawn.aboveSpawn : '?'} m above the seat, ` +
          `against a ${rideRise} m ride; Level.SinglePlayerSpawnPosition ` +
          `${
            spawn.seatTrace.spawnFieldAgrees
              ? 'names the seat'
              : `names ${spawn.seatTrace.spawnFieldNode}, ${spawn.seatTrace.spawnFieldAboveSeat} m above it`
          }`
      : 'no elevator seat on this mission',
  )
  push(
    'route-space-resolved',
    !route || /^(world|splineRootLocal)$/.test(route._meta.space),
    route ? `Curvy Approximation space = ${route._meta.space}` : 'no spline in scene',
  )
  // HARD. A pad the game cannot detect a hit on is not content, and a pad whose
  // interior the expanded read did not find looks exactly like a pad with no
  // triggers -- the same "absence reads as absence" trap as the stripped
  // prefab. Every shipped pad has 19 trigger volumes; zero is a tool failure.
  push(
    'pads-have-triggers',
    pads.every((p) => (p._meta.volumesFound ?? 0) > 0),
    pads.length
      ? `${pads.filter((p) => (p._meta.volumesFound ?? 0) > 0).length}/${pads.length} pad(s) ` +
          `with trigger volumes (${[...new Set(pads.map((p) => p._meta.volumesFound))].join(',')} each)`
      : 'no pads in this mission',
  )
  // HARD (DEV-120). A pad with no landing surface is a pad the seat falls
  // through, which was every pad on six missions until the solid collider was
  // read. Exactly one live `MeshCollider` per pad, with a profile that walks in
  // from the centre to the rim: a two-point profile would be a flat disc, and
  // the shipped mesh is a three-tier bowl.
  push(
    'pads-have-solid',
    pads.every((p) => p.solid && p.solid.profile.length >= 6 && p.solid.outer > 0),
    pads.length
      ? `${pads.filter((p) => p.solid).length}/${pads.length} pad(s) with a landing surface ` +
          `(${[...new Set(pads.map((p) => (p.solid ? p.solid.profile.length : 0)))].join(',')} profile points; ` +
          `outer ${[...new Set(pads.map((p) => (p.solid ? p.solid.outer : 0)))].join(',')} m)`
      : 'no pads in this mission',
  )
  // HARD. Every shipped environment has clouds; a zero means `readClouds` has
  // stopped following one of the two authoring shapes again (DEV-048).
  push(
    'clouds-present',
    !environment || clouds.length > 0,
    `${clouds.length} live cloud(s) from ${clouds.length ? clouds[0]._meta.source : 'no source'}`,
  )
  // HARD. Every shipped mission ends somewhere. Null used to be the answer for
  // six of them and it was the extractor not looking (DEV-045's trap, again).
  push(
    'finish-present',
    !!finish,
    finish
      ? `finish gate: ${finish.shape} at ${JSON.stringify(finish.pos)}`
      : 'NO finish gate — nothing ends this run',
  )
  // HARD. A mission must START somewhere too: either the ship can ride an
  // elevator, or there is a `Trigger_EnableJumpShip` that wakes the controls.
  // Neither would mean a ship that never becomes controllable.
  push(
    'start-sequence-present',
    !spawn || spawn.launchKind === 'elevator' || !!spawn.jumpStart,
    spawn
      ? spawn.launchKind === 'elevator'
        ? `elevator launch, starter ${JSON.stringify(spawn.launchTrace.starterScriptsOnShip)}`
        : spawn.jumpStart
          ? `direct start, ${spawn.jumpStart.seconds}s from Trigger_EnableJumpShip`
          : 'direct start with NO Trigger_EnableJumpShip — nothing enables the controls'
      : 'no spawn',
  )
  // HARD. An empty label is what a broken selector ships.
  push(
    'ui-strings-read',
    !!ui && ui.briefing.length > 0 && Object.values(ui.strings).every((s) => s.length > 0),
    ui
      ? `${Object.keys(ui.strings).length} string(s) + briefing from ${ui._meta.prefab}`
      : 'no ui block -- Level.ShipPrefab did not resolve',
  )

  /* -- assemble ---------------------------------------------------------------------- */
  const level_json = {
    $schema: './_schema.json',
    id: mission.id,
    title: titleFor(mission.id),
    vehicle,
    environment,
    environmentScene: envScene,
    /**
     * `beginner` | `intermediate` | `professional` -- 2016's own three ranks,
     * and the MIDDLE step of the level select (DEV-105). See `difficultyFor`.
     */
    difficulty: difficulty.difficulty,
    /** `menu` (read off a `missionSel_*` page) or `id`. Three are `id`; see the row. */
    difficultySource: difficulty.source,
    mode,
    forcedMode,
    /** DEV-061. Null means "2016 got this right"; `forcedMode` is then the forcing. */
    forcedModeFf2,
    /**
     * Where this course sits in 2016's campaign chain, or null for one that is
     * not in it. `hoverJet_kauai_beg` is the only null. See `campaignChain`.
     */
    chainIndex,
    /** Derived, not asserted: `chainIndex !== null`. Was a hardcoded `true`. */
    inChain: chainIndex !== null,
    worldOffset: toThreePos(worldOffsetRaw),
    spawn,
    respawn,
    markerUsedAtLoad,
    routes: routes.map((r) => ({
      id: r.id,
      rings: r.rings,
      _meta: { fileID: r._key, path: r._path },
    })),
    // What ENDS the run. Non-scoring, and never part of `routes` — see `readFinish`.
    finish,
    route: route ? route.points : null,
    orbs,
    pads,
    turnIndicators,
    clouds,
    /**
     * Scenery THIS MISSION places, which `content/environments/*.json` does not
     * and cannot carry -- it is per-mission (DEV-218, DEV-219). Same schema and
     * same frame as an environment landmark, so `load-props.ts` concatenates
     * the two and nothing per-mission exists in `src/`.
     */
    props,
    /** 2016's own words, read from this mission's own ship prefab. */
    ui,
    timer,
    medals,
    medalsFf2,
    medalsExp,
    scoring,
    boundary,
    fog,
    lighting,
    ghosts: ghostBundle.ghosts,
    /**
     * DEV-146. Null on every mission the table above does not name. The course
     * whose ships fly over this one's island, and how many.
     */
    ambientTraffic: dev146AmbientTraffic(mission.id, environment),
    generated: null,
    _meta: {
      generatedBy: 'tools/extract/level.mjs',
      // Deterministic by design: the mtime of the SOURCE scene, not the wall clock.
      // A wall-clock stamp makes every run differ, which defeats the CI drift hash
      // (PORT_PLAN 4.7) — same inputs must produce byte-identical output.
      sourceSceneModified: fs.statSync(mission.abs).mtime.toISOString(),
      sourceScene: mission.rel,
      sourceSceneAbs: mission.abs.replace(/\\/g, '/'),
      environmentSceneAbs: envSceneObj ? envSceneObj.absPath : null,
      legacyProjectRoot: '$FF2_LEGACY',
      coordinateConvention: {
        rule: 'Unity(x,y,z) -> three(x,y,-z); quat(x,y,z,w) -> (-x,-y,z,w); scale unchanged',
        handedness: 'Unity left-handed +Z forward -> three.js right-handed -Z forward',
        determinant: -1,
        pairedWith: 'triangle winding reversed and UV V-flipped on meshes (not emitted here)',
        validatedBy: 'tools/prototype/axis_test.js -- see content/levels/_axis-validation.md',
        rawAlsoEmitted: 'every element carries _meta.raw in untouched Unity coordinates',
      },
      livenessRule:
        'TriggerCheckpoint.m_Enabled==1 && addScore!=0 && every ancestor m_IsActive==1, ' +
        'EXCEPT Level.ringAttackParent / Level.freeFlightParent which Level.cs toggles at runtime.',
      /**
       * DEV-210. Liveness says which rings EXIST; this says which of them are the COURSE.
       * Null unless the scene held more than one live ring group (only adv_01_hoverJet does).
       * `dropped` is live-in-2016 authoring debris, kept here so the deletion is auditable
       * and never has to be re-derived from the scene.
       */
      courseSelection: course.fits
        ? { by: 'curvy-spline-fit', fits: course.fits, dropped: course.dropped }
        : null,
      structural,
      route: route ? route._meta : null,
      ghosts: ghostBundle._meta,
      checks,
      provenance: P,
      sceneStats: {
        documents: scene.flat.meta.documentCount,
        gameObjects: scene.flat.meta.gameObjectCount,
        prefabInstances: scene.flat.meta.prefabInstanceCount,
      },
    },
  }
  return level_json
}

/* ================================================================ the campaign chain == */

/**
 * 2016's ONE sequencer, read out of the only file that holds it.
 *
 * `Scripts/Button_Next.cs` is a pair of switch statements on
 * `PlayerPrefs["prevLevel"]` -- twelve cases, one chain, ending in `credits`
 * (`_ui-flow.md` §3). It is code and not a serialised field, so hard rule 2's
 * `trust: "code-default"` category: nothing about it can be overridden by a
 * prefab or a scene, because there is no prefab and no scene.
 *
 * ── What it is FOR here ──────────────────────────────────────────────────
 *
 * The level select's last step deals the courses of one (vehicle, rank) cell
 * onto the arc, and they need an order. Sorting by id looks fine and is not:
 * `hoverJet_kauai_beg` sorts before `rookie_01_hoverJet`, so the HoverJet
 * beginner page would open on the bonus free-flight course and push the two
 * courses the game actually starts you on to the right of it. 2016 has the
 * answer and this is it -- and Kauai's absence from the chain is the answer
 * too: it shipped after this backup, it is not part of the campaign, and it
 * belongs at the end.
 *
 * ── And it makes `inChain` honest ────────────────────────────────────────
 *
 * That field has read a hardcoded `true` on all thirteen since the extractor
 * was written, including on the one mission that is demonstrably not in the
 * chain, and nothing has ever read it. DEV-069's lesson: *a generated constant
 * that no code path reads is documentation, not a guard.* It is derived from
 * `chainIndex` now, and `mission-index.ts` consults the index.
 */
const CHAIN_SOURCE_REL = 'Assets/Faceted Flight/Scripts/Button_Next.cs'

let CAMPAIGN_CHAIN = null

/**
 * mission id -> 0-based position in 2016's campaign chain.
 *
 * Built by walking the `case "<prev>": lookButton.levelName = "<next>";` pairs
 * into a successor map and then following it from whichever id is a `prev` and
 * never a `next` -- rather than by reading the cases in file order. The file
 * order and the chain order agree today; a source that reads the pairs cannot
 * be fooled by a reordered switch, and an edit that breaks the chain into two
 * pieces is caught below instead of silently renumbering everything.
 */
function campaignChain() {
  if (CAMPAIGN_CHAIN) return CAMPAIGN_CHAIN
  CAMPAIGN_CHAIN = new Map()
  const abs = path.join(SRC, CHAIN_SOURCE_REL)
  if (!fs.existsSync(abs)) return CAMPAIGN_CHAIN
  const src = readUnityText(abs)
  const pairs = []
  const re = /case\s+"([^"]+)"\s*:\s*lookButton\.levelName\s*=\s*"([^"]+)"\s*;/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) pairs.push([m[1], m[2]])
  if (pairs.length === 0) {
    throw new Error(
      `${CHAIN_SOURCE_REL}: no 'case "x": lookButton.levelName = "y";' pairs. ` +
        'The one sequencer in the game has changed shape; re-read it before trusting this.',
    )
  }
  const next = new Map(pairs)
  const isNext = new Set(pairs.map(([, to]) => to))
  const heads = [...next.keys()].filter((from) => !isNext.has(from))
  if (heads.length !== 1) {
    throw new Error(
      `${CHAIN_SOURCE_REL}: expected exactly one chain head, found ${heads.length} ` +
        `(${heads.join(', ')}). Refusing to guess where the campaign starts.`,
    )
  }
  let at = heads[0]
  for (let i = 0; at && i < next.size + 2; i++) {
    if (CAMPAIGN_CHAIN.has(at)) {
      throw new Error(`${CHAIN_SOURCE_REL}: the chain loops back to ${at}.`)
    }
    CAMPAIGN_CHAIN.set(at, i)
    at = next.get(at)
  }
  return CAMPAIGN_CHAIN
}

/* ============================================================ the difficulty (rank) == */

/**
 * Which RANK page a mission's holotable stands on in 2016's level select.
 *
 * -- Why this is a scene read and not a regex on the id ------------------
 *
 * Matt, 2026-09-14: *"let's revise the menu flow so it's: vehicle ·
 * difficulty · location."* That is 2016's own order --
 * `Scripts/MenuManager.cs` pages **ship -> mode -> rank -> challenge**, and
 * `GoBack()` unwinds `missionSel* -> rank -> mode -> ship`. So the port needs
 * a rank per mission, and `docs/research/03-game-modes-and-levels.md:1118`
 * proposed `"difficulty": "rookie | intermediate | advanced"` three research
 * passes ago and nothing ever emitted it.
 *
 * The obvious source is the id: `rookie_`/`int_`/`adv_`. `mission-index.ts`
 * said so and refused it -- *"a rule that parses ids is a rule a fourteenth
 * mission called anything else falls out of"* -- and it was right that a
 * PARSED id is not data. But 2016 has the real thing: the scene groups the
 * mission buttons under six pages named `missionSel_<ship>_<rank>`, and
 * `Button_Look_Simple.missionRank` on the rank buttons spells the three keys
 * out as `beginner` / `intermediate` / `professional` (plus an `m_IsActive: 0`
 * `training`, which never shipped).
 *
 * So: read the pages, and CHECK them against the id prefix. The check is the
 * point. §4.7 -- *a structural claim with one source is a hypothesis* -- and
 * trap 24 -- *a test that re-derives its expectation the way the code does has
 * not tested the code*. Two independent sources agreeing on ten missions is
 * evidence; either one alone is a guess that happens to be right.
 *
 * -- The three the scene cannot answer, and why that is not a surprise ---
 *
 * `_ui-flow.md` §5's *blocking uncertainty*: this 2016-12-30 backup is
 * mid-refactor, 22 of its 37 holotables are `m_IsActive: 0`, and **no reading
 * of it explains how a player reached a mission from that screen.** Measured
 * here: ten of the thirteen resolve to a `missionSel_<ship>_<rank>` page.
 * The two HoverJet beginner courses are wired on `page_envSelection_jumpSeat`
 * instead -- a page whose name already disagrees with its contents -- and
 * `hoverJet_kauai_beg` is not in the scene at all, because it shipped after
 * this backup and never got a table.
 *
 * Those three fall back to the id, tagged `"id"` in `difficultySource`, and
 * the extractor SAYS so rather than presenting a guess as a reading. Each one
 * is also the least surprising possible answer: `rookie_01`, `rookie_02` and
 * `..._beg`.
 */
const RANK_BY_SUFFIX = { beg: 'beginner', int: 'intermediate', pro: 'professional' }

/** The id prefix's own claim. The SECOND source, and only ever a cross-check. */
const RANK_BY_ID_PREFIX = { rookie: 'beginner', int: 'intermediate', adv: 'professional' }

const MENU_SCENE_REL = 'Assets/Faceted Flight/Scenes/setGameplayOptions.unity'

let MISSION_RANKS = null

/**
 * mission id -> the rank page it stands on, read once from the 61 MB menu scene.
 *
 * Raw documents rather than `loadScene`: this is a hierarchy walk over names,
 * the scene is not a mission, and flattening it would resolve prefabs it has
 * thousands of. 1.6 s, once, cached.
 *
 * **Only SHIPPED mission ids count.** A rank page's holotable contains a whole
 * dummy ship, and a dummy ship carries its own `Ship_HUD` prefab, and that
 * prefab carries `panel_pause/button_exit` with `levelName: main_menu`. Twelve
 * of those, spread over six pages -- so an unfiltered read finds `main_menu`
 * on two different ranks and, quite correctly, refuses to choose. The same
 * filter drops `Dev_LevelHack`'s `rookie_03_hoverJet` / `int_03` / `int_04`,
 * which are three courses this backup names and does not contain.
 */
function missionRanksFromMenu() {
  if (MISSION_RANKS) return MISSION_RANKS
  MISSION_RANKS = new Map()
  const abs = path.join(SRC, MENU_SCENE_REL)
  if (!fs.existsSync(abs)) return MISSION_RANKS
  const shipped = new Set(shippedMissions().map((m) => m.id))
  const docs = parseDocuments(readUnityText(abs))

  const componentOwner = componentOwners(docs) // component fileID -> GameObject fileID
  const goName = new Map()
  for (const d of docs) {
    if (d.classId !== 1) continue
    goName.set(String(d.fileId), String(d.data.m_Name))
  }
  const transformOfGo = new Map()
  const transforms = new Map()
  for (const d of docs) {
    if (d.classId !== 4 && d.classId !== 224) continue
    const go = d.data.m_GameObject?.fileID
    transforms.set(String(d.fileId), {
      go: String(go),
      father: String(d.data.m_Father?.fileID ?? 0),
    })
    if (go) transformOfGo.set(String(go), String(d.fileId))
  }
  /** The first ancestor named `missionSel_<ship>_<rank>`, or null. */
  const rankPageOf = (goId) => {
    let t = transformOfGo.get(String(goId))
    for (let depth = 0; t && t !== '0' && depth < 64; depth++) {
      const node = transforms.get(t)
      if (!node) break
      const name = goName.get(node.go) ?? ''
      const m = /^missionSel_(hoverJet|jumpSeat)_(beg|int|pro)$/.exec(name)
      if (m) return { page: name, ship: m[1], rank: RANK_BY_SUFFIX[m[2]] }
      t = node.father
    }
    return null
  }
  for (const d of docs) {
    if (d.classId !== 114) continue
    const levelName = d.data.levelName
    if (levelName === undefined || String(levelName).trim() === '') continue
    const owner = componentOwner.get(String(d.fileId))
    if (!owner) continue
    const page = rankPageOf(owner)
    if (!page) continue
    const id = String(levelName)
    if (!shipped.has(id)) continue
    const seen = MISSION_RANKS.get(id)
    if (seen && seen.rank !== page.rank) {
      throw new Error(
        `${MENU_SCENE_REL}: ${id} appears on two rank pages (${seen.page} and ` +
          `${page.page}). Refusing to pick one.`,
      )
    }
    MISSION_RANKS.set(id, page)
  }
  return MISSION_RANKS
}

/**
 * `beginner` | `intermediate` | `professional`, and where it came from.
 *
 * Throws if the two sources disagree -- the relationship, not the value, is
 * what is asserted (trap 24). A fourteenth mission filed under the wrong rank
 * page stops the extractor rather than shipping a menu that disagrees with
 * itself.
 */
function difficultyFor(missionId) {
  const fromMenu = missionRanksFromMenu().get(missionId) ?? null
  const prefix = /^([a-z]+)_/.exec(missionId)?.[1]
  const suffix = /_([a-z]+)$/.exec(missionId)?.[1]
  const fromId = RANK_BY_ID_PREFIX[prefix] ?? RANK_BY_SUFFIX[suffix] ?? null
  if (fromMenu && fromId && fromMenu.rank !== fromId) {
    throw new Error(
      `${missionId}: 2016's menu files it under ${fromMenu.rank} (${fromMenu.page}) but its ` +
        `id says ${fromId}. One of them is wrong; refusing to guess which.`,
    )
  }
  if (fromMenu) {
    return {
      difficulty: fromMenu.rank,
      source: 'menu',
      detail: `${MENU_SCENE_REL} ${fromMenu.page}${fromId ? ' (the id agrees)' : ''}`,
    }
  }
  if (fromId) {
    return {
      difficulty: fromId,
      source: 'id',
      detail:
        `no holotable under a missionSel_* page in ${MENU_SCENE_REL} ` +
        `(_ui-flow.md §5's blocking uncertainty); taken from the mission id`,
    }
  }
  throw new Error(
    `${missionId}: no rank page in 2016's menu and no rank in the id. ` +
      `Add it to RANK_BY_ID_PREFIX or give it a holotable.`,
  )
}

function titleFor(id) {
  const m = /^(rookie|int|adv)_(\d+)_(hoverJet|jumpSeat)$/.exec(id)
  if (m) {
    const tier = { rookie: 'Rookie', int: 'Intermediate', adv: 'Advanced' }[m[1]]
    const veh = m[3] === 'hoverJet' ? 'HoverJet' : 'JumpSeat'
    return `${tier} ${Number(m[2])} - ${veh}`
  }
  if (id === 'hoverJet_kauai_beg') return 'Kauai - Free Flight'
  return id
}

/* ======================================================================= environments == */

function environmentSceneIndex() {
  const dir = path.join(SRC, 'Assets/Faceted Flight/Scenes/environments')
  const map = new Map()
  if (!fs.existsSync(dir)) return map
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.unity')) continue
    map.set(path.basename(f, '.unity'), path.join(dir, f))
  }
  return map
}

/* ================================================================================ CLI == */

function summaryRow(L) {
  const s = L._meta.structural
  const plat = L.medals.platinum
  const maxScore = s.liveRingCount * L.scoring.gateMultiplier
  return {
    id: L.id,
    vehicle: L.vehicle,
    env: L.environment,
    // The mode a run BOOTS in, plus what 2016's forcing did about it. DEV-061
    // drops one scene's forcing, and a column that only ever said "(forced)"
    // would print the same word for "2016 forced this and we obey" and "2016
    // forced this and we do not".
    mode:
      L.mode +
      (L.forcedModeFf2
        ? ` (2016 forced ${L.forcedMode}, DEV-061)`
        : L.forcedMode
          ? ' (forced)'
          : ''),
    rings: s.liveRingCount,
    routes: s.routeCount,
    orbs:
      s.orbCountLive === s.orbCountPlaced
        ? String(s.orbCountLive)
        : `${s.orbCountLive}/${s.orbCountPlaced}`,
    pads:
      s.padCountLive === s.padCountPlaced
        ? String(s.padCountLive)
        : `${s.padCountLive}/${s.padCountPlaced}`,
    medals: `${L.medals.bronze}/${L.medals.silver}/${L.medals.gold}/${plat}`,
    platReach:
      plat === null
        ? '-'
        : s.routeCount === 1
          ? maxScore >= plat
            ? 'yes'
            : `NO (max ${maxScore})`
          : `${s.routeCount} routes`,
    timeLimit: L.timer.timeLimit,
    oob: s.playerBoundaryEnabled ? `on/${s.playerBoundaryResetDelay}s` : 'OFF',
    fog: L.fog ? `${L.fog.height}/${L.fog.heightDensity}` : '-',
    ghosts: L.ghosts.length,
    routePts: L.route ? L.route.length : 0,
  }
}

function printTable(rows) {
  const cols = Object.keys(rows[0])
  const w = {}
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  const line = (cells) => `| ${cols.map((c, i) => String(cells[i]).padEnd(w[c])).join(' | ')} |`
  console.log(line(cols))
  console.log(`|${cols.map((c) => '-'.repeat(w[c] + 2)).join('|')}|`)
  for (const r of rows) console.log(line(cols.map((c) => r[c])))
}

function main() {
  const missions = shippedMissions()
  if (flag('--list')) {
    for (const m of missions) console.log(`${m.id}\t${m.rel}`)
    return
  }
  const positional = argv.filter(
    (a, i) =>
      !a.startsWith('--') && !(i > 0 && ['--out', '--src', '--guid-index'].includes(argv[i - 1])),
  )
  let targets
  if (flag('--all') || positional.length === 0) targets = missions
  else {
    targets = positional.map((id) => {
      const m = missions.find((x) => x.id === id)
      if (!m)
        throw new Error(`unknown mission "${id}". Known: ${missions.map((x) => x.id).join(', ')}`)
      return m
    })
  }

  const envIdx = environmentSceneIndex()
  const rows = []
  const problems = []
  const built = []
  for (const m of targets) {
    const t0 = Date.now()
    const L = buildLevel(m, envIdx)
    const ms = Date.now() - t0
    built.push(L)
    rows.push(summaryRow(L))
    for (const c of L._meta.checks) if (!c.ok) problems.push(`${L.id}: ${c.id} -- ${c.msg}`)
    if (flag('--stdout')) {
      console.log(JSON.stringify(L, null, 2))
    } else if (!flag('--no-write')) {
      const file = path.join(OUT_DIR, `${L.id}.json`)
      const written = writeOut(file, `${JSON.stringify(L, null, flag('--compact') ? 0 : 2)}\n`)
      console.error(
        `wrote ${written} (${(fs.statSync(written).size / 1024).toFixed(1)} KB, ${ms} ms)`,
      )
    }
  }

  // A DEV-061 entry that matched no mission is a stale deviation pointing at a
  // scene that has been renamed or dropped -- silence there would leave a forcing
  // in place with every test still green. Same guard DEV-067's orb table carries,
  // and only over a full run, since a single `--mission` legitimately sees one.
  if (targets.length === missions.length) {
    const unused = Object.keys(DEV_061_UNFORCED).filter((id) => !built.some((L) => L.id === id))
    if (unused.length) {
      throw new Error(
        `DEV-061: no mission matched ${unused.join(', ')}. Remove the stale entry or fix the id.`,
      )
    }
  }

  if (flag('--summary') || targets.length > 1) {
    console.log('')
    printTable(rows)
  }
  if (problems.length) {
    console.log('\nCHECK REPORTS (2016 shipped these; they are recorded, not fixed here):')
    for (const p of problems) console.log(`  ! ${p}`)
  }

  // ── DEV-146: the half of the pairing one mission cannot see ───────────────
  //
  // `dev146AmbientTraffic` asserts the mission's OWN environment against the
  // recorded one, because that is all it has in scope. The other half — the
  // donor exists, and it is over the same island — needs both levels, so it is
  // here, where every one of them has been built. Only on a full run: a
  // single-mission extraction has nothing to cross-check against.
  if (targets.length === missions.length) {
    const envById = new Map(built.map((L) => [L.id, L.environment]))
    for (const L of built) {
      const traffic = L.ambientTraffic
      if (!traffic) continue
      const donorEnv = envById.get(traffic.mission)
      if (donorEnv === undefined) {
        throw new Error(
          `DEV-146: ${L.id} borrows the course of "${traffic.mission}", which is not a mission ` +
            `this extractor emits. Known: ${[...envById.keys()].join(', ')}`,
        )
      }
      if (donorEnv !== L.environment) {
        throw new Error(
          `DEV-146: ${L.id} is over "${L.environment}" and its traffic donor ` +
            `"${traffic.mission}" is over "${donorEnv}". Ambient traffic needs ONE island.`,
        )
      }
    }
  }

  // PORT_PLAN 4.7: emit structural assertions alongside the data so CI can diff them.
  // A numeric error costs a constant; a structural error costs a rewrite.
  if (targets.length === missions.length && !flag('--no-write') && !flag('--stdout')) {
    const assertions = {
      _comment:
        'Structural assertions for CI (PORT_PLAN 4.7). Regenerate with ' +
        '`node tools/extract/level.mjs --all`. A diff here means a structural claim moved.',
      generatedBy: 'tools/extract/level.mjs',
      legacyProjectRoot: '$FF2_LEGACY',
      missions: Object.fromEntries(built.map((L) => [L.id, L._meta.structural])),
    }
    writeOut(
      path.join(OUT_DIR, '_structural-assertions.json'),
      `${JSON.stringify(assertions, null, 2)}\n`,
    )
    writeOut(path.join(OUT_DIR, '_summary.md'), summaryMarkdown(rows, problems))
    console.error(`wrote ${path.join(OUT_DIR, '_structural-assertions.json')} and _summary.md`)
  }

  // --check: fail only on things that are broken in the EXTRACTOR, never on things that were
  // broken in 2016. rookie_01's unreachable platinum is data, not a bug in this tool.
  if (flag('--check')) {
    const hard = [
      'spawn-present',
      'respawn-present',
      'boundary-present',
      'route-space-resolved',
      // All three are "the reader found nothing", which is the failure mode this
      // extractor keeps having and the one that looks like valid empty data.
      'pads-have-triggers',
      'clouds-present',
      'ui-strings-read',
      'finish-present',
      'start-sequence-present',
    ]
    const fatal = built.flatMap((L) =>
      L._meta.checks
        .filter((c) => !c.ok && hard.includes(c.id))
        .map((c) => `${L.id}: ${c.id} -- ${c.msg}`),
    )
    if (fatal.length) {
      console.error('\nEXTRACTOR CHECK FAILED:')
      for (const f of fatal) console.error(`  x ${f}`)
      process.exitCode = 1
    } else {
      console.error(`\ncheck OK: ${built.length} level(s), no extractor-level failures`)
    }
  }
}

function summaryMarkdown(rows, problems) {
  const cols = Object.keys(rows[0])
  const w = {}
  for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length))
  const line = (cells) => `| ${cols.map((c, i) => String(cells[i]).padEnd(w[c])).join(' | ')} |`
  const body = [
    '# Extracted levels — summary',
    '',
    'Generated by `tools/extract/level.mjs --all`. Do not edit by hand.',
    '',
    '`orbs` and `pads` read `live/placed` when they differ: `placed` is what the scene',
    'authors placed, `live` is what a player can reach after the liveness walk.',
    '',
    line(cols),
    `|${cols.map((c) => '-'.repeat(w[c] + 2)).join('|')}|`,
    ...rows.map((r) => line(cols.map((c) => r[c]))),
    '',
  ]
  if (problems.length) {
    body.push('## Reported coherence failures (shipped in 2016)', '')
    for (const p of problems) body.push(`- ${p}`)
    body.push('')
  }
  return body.join('\n')
}

try {
  main()
} catch (e) {
  console.error(`\nlevel.mjs: ${e.message}`)
  if (process.env.FF2_DEBUG) console.error(e.stack)
  process.exit(1)
}
