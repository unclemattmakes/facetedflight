// src/boot/app/pins.ts — what the page decides before boot: the URL's pins
// and switches, and the module-level constants and holders that sat beside
// them at the top of `boot/app.ts`.
//
// Moved verbatim (APP-SPLIT phase 1, `docs/plan/APP-SPLIT.md`), with `export`
// added and nothing else. Every value here is evaluated ONCE, when the module
// is first imported, exactly as it was at the top of `boot/app.ts`; the one
// statement that is not a declaration, the `setShaftPaint` call, runs at that
// moment too, and nothing reads the shaft paint before a room loads.
//
// Three stayed behind in `boot/app.ts`. Two are `let`s the closure ASSIGNS
// (`customGroundPropsMs`, `customGroundReceipt`), and an imported binding
// cannot be assigned; they move when their owner does (APP-SPLIT §5, phase 3).
// The third is `SNAP_AT`: the frame loop narrows it through an aliased
// condition (`const snapPending = SNAP_AT !== null && ...`), which TypeScript
// does for a module's own `const` and not for an imported binding — so moving
// it would mean editing the loop, and a move does not edit. Its `?snap=` doc
// sits above `SUN_HALO_METRES`, which an older edit put between the two, so
// that constant stayed with them.

import * as THREE from 'three'
import {
  parseAdaptivePin,
  parseHzPin,
  parseMsaaPin,
  parseQualityPin,
  parseSubmitPin,
  type QualityPins,
  type SubmitPin,
} from '@/boot/quality-pin'
import {
  listedVariants,
  type ResolvedVariant,
  type VariantsEdition,
} from '@/content/aircraft-schema'
import { BUILD_CHANNEL } from '@/content/build-channel'
import {
  BAKED_LIGHT_RUNGS,
  type BakedLightRung,
  EDITION_IDS,
  type EditionId,
} from '@/content/edition-schema'
import type { GameMode, Level, VehicleId } from '@/content/level-schema'
import { aircraftFor, resolveVariant } from '@/content/load-aircraft'
import type { PlaytestRequest } from '@/editor/core'
import { vrValueOffFrom } from '@/game/edition'
import { HOVERJET_LAT_ACCEL_MEASURED } from '@/game/measured'
import { MODES } from '@/game/modes'
import { roomIdFrom } from '@/game/room-client'
import { urlTaint } from '@/game/run-taint'
import { previewIslandDoor } from '@/game/terrain/custom-ground'
import { flightVariantRequest, rememberedVariant } from '@/game/variant-choice'
import { isLapId } from '@/net/lap-client'
import {
  describeHudRaster,
  describeHudRedraw,
  describeHudUpload,
  describeHudWarm,
  HUD_RASTER_SHIPPED,
  HUD_REDRAW_DEFAULT,
  HUD_UPLOAD_MIP,
  HUD_WARM_DEFAULT,
  type HudRaster,
  type HudRedraw,
  type HudUpload,
  parseHudRaster,
  parseHudRedraw,
  parseHudUpload,
  parseHudWarm,
} from '@/render/hud'
import {
  describeHudGauges,
  HUD_GAUGES_OFF,
  type HudGauges,
  parseHudGauges,
} from '@/render/hud-gauges'
import { parseLensMaskPin } from '@/render/lens-mask'
import { SHAFT_PAINT_SHIPPED, setShaftPaint, shaftPaintParam } from '@/render/shaft-paint'
import { type SunLightRule, sunLightRuleFrom } from '@/render/sun-light-rule'
import { parseTerrainLit, type TerrainLit } from '@/render/terrain-mesh'
import type { CrashSpec } from '@/sim/crash'
import { parseTraceSeconds } from '../perf-trace'
import { parseSnap } from '../snap'
import { audioOff, xrProbeOff } from '../switches'
import { parseTriple, resolveViewpoint } from '../viewpoints'

/**
 * `?view=fly` (the default) puts you in the cockpit. `?view=wide` and
 * `?view=low` orbit the island instead, which is what the screenshot spec uses
 * and what answers "does Simonet look like Simonet" without a pilot.
 */
export const FLY = 'fly'

/**
 * The M0.6 camera: a slow orbit around the island group.
 *
 * A placeholder in the sense that M1 replaces it with the HoverJet, but not an
 * arbitrary one — it exists to answer the question this milestone is actually
 * about, which is "does Simonet Islands look like Simonet Islands". So it sits
 * high enough to show the whole 4 km archipelago and the mountain range in the
 * north-east that the oracle sweep found the sampler bugs in.
 */
export interface OrbitView {
  readonly target: THREE.Vector3
  readonly radius: number
  readonly height: number
  /** Radians per second. */
  readonly speed: number
  /** Where the lap starts, so a screenshot at t=0 is repeatable. */
  readonly phase: number
}

/**
 * Two cameras, because they answer different questions.
 *
 * `wide` shows the whole 4 km archipelago — the silhouette, which is what the
 * oracle sweep verified numerically and what a 2016 screenshot can be held up
 * against.
 *
 * `low` flies at roughly the altitude the HoverJet does. At 3 km a facet is
 * sub-pixel and the terrain reads as noise; the faceting IS the art style, so a
 * view that cannot resolve it cannot tell you whether the port looks right.
 *
 * Pick with `?view=low`. M1 replaces both with the ship.
 */
//
// The targets are in WORLD space, which is not the terrain's mesh space. The
// island is placed at `worldOffset + its own transform` and then flipped into
// three's handedness, so its 4 km square lands at roughly x -2158..1938,
// z -2229..1867, centred near (-110, ., -181) — nowhere near the (2048, 2048)
// these used to point at when the terrain was drawn at its mesh coordinates.
export const VIEWS: Record<string, OrbitView> = {
  wide: {
    // Centre of the island group, at about the height of the peaks.
    target: new THREE.Vector3(-110, 40, -181),
    radius: 3100,
    height: 1250,
    // One lap in ~85 s — slow enough to read, quick enough to see.
    speed: 0.074,
    // Start on the mountains, not the empty south-west corner.
    phase: 2.5,
  },
  low: {
    // The high massif the oracle sweep found the sampler bugs in: mesh (2680,
    // 3400) on the heightmap, which lands here once placed and flipped.
    target: new THREE.Vector3(522, 338, -1533),
    radius: 900,
    height: 620,
    speed: 0.11,
    phase: 3.9,
  },
}

export const params = new URLSearchParams(globalThis.location?.search ?? '')
export const view = params.get('view') ?? FLY

/**
 * `?room=<id or code>`: the room this page's LINK names, at boot, or null (BE-15).
 * DEV-389 joins it; DEV-388 skips the lift for it (`SKIP_RIDE`). Only the
 * INITIAL value is here: `app.ts`'s `roomId` is a `let` that changes as rooms
 * are joined and left, and its address-bar writes read the live URL, not this.
 */
export const ROOM_AT_BOOT: string | null = roomIdFrom(params.get('room'))

const seatFrom = (raw: string | null): number | null => {
  const seat = Number(raw)
  return Number.isInteger(seat) && seat > 0 ? seat : null
}

/** `?watch=<room>`: this page WATCHES a room instead of racing in it (DEV-436), or null. */
export const WATCH_AT_BOOT: string | null = roomIdFrom(params.get('watch'))

/**
 * `?follow=<seat>`: which seat TV's camera follows at boot (DEV-481), a whole
 * number from 1 up, or null. Not `tv-link.ts`'s `followOf`: that one also caps
 * the seat at the room's size and answers the `?tv=` link; this is the camera's
 * own raw pin and has no cap.
 */
export const TV_FOLLOW_AT_BOOT: number | null = seatFrom(params.get('follow'))

/** `?snap=<seconds>`: freeze the sim at that mission time (`boot/snap.ts`), or null. */
export const SNAP_AT_PIN: number | null = parseSnap(params.get('snap'))

/**
 * `?xr=off`: never ask the platform for a headset (it starts SteamVR). One
 * answer for app.ts; the capability gate reads the same switch through
 * `../switches`, which this file cannot be imported from (BE-15).
 */
export const XR_PROBE_OFF = xrProbeOff(params)

/**
 * `?audio=off`: the audio system boots on the silent backend and no menu press
 * can bring a device back.
 */
export const AUDIO_OFF = audioOff(params)

/**
 * `?autopilot` (or `?autopilot=1`) flies the course on its own.
 *
 * For watching the whole run without holding a stick for two minutes: it presses
 * A, rides the lift, and then flies all 21 gates using the SAME flight model and
 * the SAME gate spheres a player gets (`sim/autopilot.ts`). It is not a replay —
 * nothing is pre-recorded — so what you are watching is the real sim.
 *
 * Toggle it mid-run with **P** to take over, and again to hand it back. Any
 * flight input also stands it down, on the theory that grabbing the stick means
 * you want the stick.
 */
export const AUTOPILOT_AT_BOOT = params.has('autopilot') && params.get('autopilot') !== '0'

/**
 * Which ambient to light from: `shipped` (default) or `sky`.
 *
 * See `applyLighting`. The default is 2016's baked SH, mismatch and all.
 */
export const AMBIENT_SOURCE = params.get('ambient') === 'sky' ? 'sky' : 'shipped'

/**
 * How many times finer the ocean is drawn than 2016 drew it. **Matt's call.**
 *
 * *"the ocean isn't nearly dense enough, especially compared to the screenshots
 * and the terrain... i think it should be roughly 4x denser."* (2026-09-10)
 *
 * ── What 2016 actually had, since this is a deviation from it ────────────
 *
 * The shipped component on `LevelArt_SimonetIslands.prefab` reads `TerrainSize:
 * 32768, ChunkSize: 1024, BaseResolution: 32, LODLevels: 6`, and
 * `FacetedTerrain.HeightmapInfo` computes `quadPerChunk = ChunkSize /
 * BaseResolution` with **LOD0 the finest** and each level a stride of 2 over the
 * same grid. So the ocean's finest quad is 32 mesh units, and the plate's scale
 * is 8: **256 m**. Verified in the component, in the generator, and in our own
 * extracted constants, which agree on every field. The sea really was that
 * coarse, and the land beside it is 8 m.
 *
 * ── And the ocean was not even drawing at LOD0 ──────────────────────────
 *
 * The bigger half of "not dense enough" turned out to be the LOD test, not the
 * mesh: those chunks are **8,192 m across** and 2016 measured to their CENTRE,
 * so the water under the ship was judged up to 5.8 km away. Four ocean chunks
 * on `int_01` and not one at LOD0 — two at LOD2, two at LOD3, quads of 1,024
 * and 2,048 m. `chunkDistance` in `game/terrain/load-terrain.ts` now measures
 * to the chunk's footprint, which recovers the LOD0 the generator could always
 * produce. That alone is the ~4x Matt read off the screenshot.
 *
 * ── And then the subdivided sea was STILL flat, for a third reason ──────
 *
 * Matt again: *"can you make sure noise is applied to the base ocean mesh before
 * the ocean shader movement is applied? (it all looks kinda flat still)"*
 * Barycentric sub-vertices land exactly on the parent's plane, so subdivision
 * alone multiplied the triangles and added no relief whatsoever — the mesh's
 * noise only ever existed at the original grid points. `subdivideTriangleSoup`
 * now jitters the interior lattice points by the terrain's own `RandomOffset`,
 * hashed from position so a chunk does not reshuffle when it swaps LOD.
 *
 * **Matt's call, 2026-09-10: "ocean=4 as the default (or if we can go 1 lvl of
 * subdivision higher)". Measured, and it is 8.**
 *
 * | | ocean triangles | sub-quad at LOD0 | desktop |
 * |---|---|---|---|
 * | 1 — 2016's geometry | 5,920 | 256 m | 181 fps |
 * | 4 | 94,720 | 64 m | 181 fps |
 * | **8 — the default** | **378,880** | **32 m** | 181 fps |
 *
 * The island is 134,784 for scale, so the sea is now the most expensive thing
 * in the scene. Desktop does not notice at any setting — all three sit on the
 * same cap — but **the headset is unmeasured**, and 380k triangles of water is a
 * real budget item for a Quest. `?ocean=4` halves the facet count and `?ocean=1`
 * is 2016 exactly, so the dial-back is one character if the XR pass wants it.
 *
 * ── The default is a ladder now (DEV-183) ────────────────────────────────
 *
 * DEV-183 quoted a worn `?ocean=8` → `?ocean=1` reading here, and it is
 * **WITHDRAWN** (`docs/plan/VR-PERF-WAVE-2-WORK.md` §6b: two loads by
 * construction, and the queue meant to confirm it read `?ocean=1` as MORE
 * expensive than the ladder). So what the sea's vertices cost in a headset is
 * still unmeasured. The default is no longer ONE number: it is
 * `terrain.ocean.subdivisionByLod` in the edition preset, a rung per LOD band —
 * and on `int_01` that ladder is inert over most of the route, where every built
 * sea chunk is at LOD 0 (DEV-183 §3).
 *
 * This switch is now a PIN over that ladder rather than the ladder itself. Set
 * it and every band takes the same number, which is what makes `?ocean=1`
 * 2016's geometry and `?ocean=8` the build that shipped before DEV-183 — the
 * two loads an A/B of this change is taken between.
 */
export const OCEAN_PIN = (() => {
  const raw = Number(params.get('ocean'))
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null
})()

/**
 * `?oceanRings=1|0` (or `on|off`): DEV-339, a PIN over `terrain.oceanRings.enabled`
 * for the load, the way `?ocean=` is over the ladder. `null` on every ordinary
 * load and the preset decides. It sets which sea is built at load; the live
 * switch within a run is `__ff2.oceanRings(on)`.
 */
export const OCEAN_RINGS_PIN: boolean | null = (() => {
  const raw = params.get('oceanRings')
  if (raw === null || raw === '') return null
  if (raw === '1' || raw === 'on') return true
  if (raw === '0' || raw === 'off') return false
  console.warn(`?oceanRings=${raw} is not 1|0|on|off, ignored: the preset decides.`)
  return null
})()

/**
 * `?bakedRung=1|3` — DEV-237, a PIN over `terrain.bakedLight.rung`, the same
 * shape `?ocean=` is over the sea's ladder. `null` on every ordinary load, and
 * the preset decides.
 *
 * ── Why it exists at all, which is a fact about the HARNESS ──────────────
 *
 * `VRTO3D_FLAGS_ON=terrain.bakedLight` cannot reach the rung.
 * `tests/e2e/xr-vrto3d-trace.spec.ts`'s flip is
 * `block[b] = { ...target, enabled }` — it spreads every other field of the
 * block straight through from the preset, on purpose, because a flag path is
 * two segments and a third would switch off the wrong block. So the flag says
 * *bake* and this says *which rung*, and DEV-237's two arms are two loads that
 * differ by one query parameter rather than by a build.
 *
 * An unrecognised value warns and is dropped rather than throwing, like every
 * other switch in this family: a typo in an env var should cost a row, not a
 * run. It cannot silently select the wrong rung, because the arm's mechanism
 * check reads the rung back off the materials and refuses a trace that
 * disagrees with what was asked for.
 */
export const BAKED_RUNG_PIN: BakedLightRung | null = (() => {
  const raw = params.get('bakedRung')
  if (raw === null || raw === '') return null
  // Matched by its STRING form against the list rather than parsed as a number,
  // because DEV-240's rung is named `split` and a `Number()` of it is NaN. The
  // list is the one place a rung is defined (`content/edition-schema.ts`), so a
  // rung added there is reachable here without a second edit.
  const match = (BAKED_LIGHT_RUNGS as readonly BakedLightRung[]).find((r) => String(r) === raw)
  if (match !== undefined) return match
  console.warn(
    `?bakedRung=${raw} is not one of ${BAKED_LIGHT_RUNGS.join('|')} — ignored, the preset decides. ` +
      '3 drops the shadow multiply with everything else (DEV-232); 1 keeps it and shadows the ' +
      "ambient with it (DEV-237); 'split' bakes the halves apart and shadows only the direct " +
      'one (DEV-240).',
  )
  return null
})()

/**
 * `?terrainLit=standard|noibl|lambert|basic` — what SHADING MODEL the island's
 * chunks use. A measurement switch; `standard` is the default and is the
 * shipped material byte for byte. DEV-182.
 *
 * `render/terrain-mesh.ts`'s `TerrainLit` block is the whole argument: the
 * chunks are 51 % of the worn frame and 2.15 ms of that is fill, all four
 * Anniversary systems riding on the material measured at zero, so the cost is
 * the BASE stack and the only way to price a base stack is to render the frame
 * without parts of it.
 *
 * Handed to the LAND terrain and to nothing else, on purpose. The ocean would
 * ignore it anyway (`terrainMaterial` tests the shader, exactly as it does for
 * the F0 and the warp), and the title valley is 30 km away and is never in a
 * mission frame — so the switch moves precisely the one census row,
 * `world-terrain/chunks`, that the number is about. A sweep that also changed
 * the sea would price two systems as one.
 */
export const TERRAIN_LIT: TerrainLit =
  parseTerrainLit(params.get('terrainLit'), (m) => console.warn(m)) ?? 'standard'

/**
 * `?pointLights=keep` — DON'T take DEV-192's cut. A measurement switch, and it
 * exists for one reason: **the A arm of the photograph.**
 *
 * The row's whole claim is that cutting the cabin lamps out of the world's
 * shaders moves no pixel, and the only way to photograph that is to render the
 * same frame with the loop still in. Without a pin the comparison is two
 * BUILDS, which `docs/testing/perf-protocol.md` §3a-ter says this machine
 * cannot do for anything fill-dominated — and, worse, two builds is a
 * comparison nobody can repeat a month from now without a git checkout.
 *
 * Same family as `?terrainLit=`, `?fog=off`, `?ocean=` and `?aa=`: an
 * instrument, off by default, with the shipped path as its default value. It
 * is NOT a harness switch — no spec needs it to pass, `point-light-scope.spec.ts`
 * never sets it, and the game a player loads has no idea it exists.
 */
export const KEEP_POINT_LIGHTS = params.get('pointLights') === 'keep'

/**
 * `?feature=<path>:on|off,<path>:on|off` — force `editionFeatures()` flags.
 * DEV-263.
 *
 * ── Why this exists, and why it is not a harness switch ──────────────────
 *
 * `view-toggle-compile.spec.ts` tests DEV-186's invariant — that toggling the
 * view does not recompile every lit material — and it does so through the
 * cockpit's two cabin lamps, because a light COUNT is field #36 of three's
 * program cache key. On 2026-09-21 Matt turned those lamps off
 * (`cockpit.lighting.enabled: false`, *"we don't need the cockpit point
 * lights"*) and the spec went red **on its own premise**:
 *
 *     expect(first.pointLights, 'the cockpit is lit in first person')
 *       .toBeGreaterThan(0)      // Received: 0
 *
 * Read that carefully, because it decides what the right fix is. The preset
 * moving did not change the spec's ANSWER — it removed its QUESTION. The
 * invariant is still real and the code that can break it is still there, one
 * boolean away. Deleting the spec would delete a guard rather than a feature.
 *
 * So this pin puts the question back. **It is not the forbidden thing.**
 * CLAUDE.md's rule is *"never make the test harness take a different code path
 * to get green"*, and the line it draws is *"whether the GAME behaves
 * differently, not whether the harness does something extra"*. This configures
 * the game into a state the game supports, through the same code, the way
 * `?edition=`, `?quality=`, `?props=off` and `?aa=` already do. What it must
 * NOT become is a way to make a spec pass by skipping what it tests.
 *
 * The honest caveat, stated here rather than discovered later: a spec using
 * this pin is testing a configuration **nobody ships**. That is why the
 * shipped-off claim has its own separate test in `edition-content.test.ts`
 * (*"the cockpit point lights are off in BOTH presets"*). Two claims, two
 * tests, neither standing in for the other.
 *
 * An unknown path is IGNORED rather than refused — see `withFeatureOverrides`.
 * A malformed entry warns and is skipped, so one typo does not silently void
 * the rest of the list.
 */
export const FEATURE_PINS: Readonly<Record<string, boolean>> = (() => {
  const raw = params.get('feature')
  if (raw === null) return {}
  const out: Record<string, boolean> = {}
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const at = trimmed.lastIndexOf(':')
    const path = at < 0 ? trimmed : trimmed.slice(0, at)
    const state = at < 0 ? '' : trimmed.slice(at + 1)
    if (state !== 'on' && state !== 'off') {
      console.warn(`?feature: ignoring "${trimmed}" — expected <path>:on or <path>:off`)
      continue
    }
    out[path] = state === 'on'
  }
  // Printed whenever it is set, never when it is not: a trace or a screenshot
  // taken under a pin is one nobody can attribute to an arm afterwards, and
  // this one changes what the renderer builds.
  if (Object.keys(out).length > 0) {
    console.info(`feature pins (DEV-263): ${JSON.stringify(out)}`)
  }
  return out
})()

/**
 * `?vrFxTrim=0` and `?vrMeshLod=0`: the OFF arms of two VR-only value layers,
 * for the worn A/B (`docs/plan/ANNIVERSARY-VR-FRAMERATE.md` section 5). Both
 * are ON by default in a headset (Matt, 2026-10-12: "default to on").
 *
 * - `?vrFxTrim=0` (DEV-934, lever 5) keeps the flat speed-line width and mote
 *   count in the headset: every `vr.override` path under `fx.`.
 * - `?vrMeshLod=0` (DEV-935, lever 8) keeps the flat `props.meshLod` rung
 *   edges in the headset.
 *
 * Nothing changes on a monitor either way: `vr.override` is only read while
 * presenting (`content/edition-schema.ts`, `applyVrOverrides`).
 */
export const VR_VALUE_OFF: (path: string) => boolean = (() => {
  const off = vrValueOffFrom(params)
  if (params.get('vrFxTrim') === '0' || params.get('vrMeshLod') === '0') {
    console.info(
      `vr value pins (DEV-934/935): fxTrim ${off('fx.speedLines') ? 'off' : 'on'}, meshLod ${off('props.meshLod') ? 'off' : 'on'}`,
    )
  }
  return off
})()
/**
 * `?chunkBatch=0` turns the land's chunk batching OFF. DEV-904; ON by default.
 *
 * The land's chunk grid is drawn through one `THREE.BatchedMesh` per LOD band
 * (`render/chunk-batch.ts`), which DEV-193 measured at 261 draws down to 65 on
 * `int_01_hoverJet`. `game/terrain/load-terrain.ts` owns the batches: a chunk
 * is in its band while it is plain geometry at a settled LOD, leaves it to
 * cross-fade (DEV-130) and rejoins at `finishFade`. The sea is never batched.
 *
 * The pin exists as the OFF arm of an A/B (`docs/testing/perf-protocol.md`
 * section 3d): `__ff2.chunkBatch(false)` and `(true)` flip it on a live page,
 * one load and two readings. It is not a quality setting and no preset reads it.
 */
export const CHUNK_BATCH = params.get('chunkBatch') !== '0'

/**
 * `?lookdev=1`: the in-game tuning panel, `L` to toggle.
 *
 * Matt: *"stub out an in-game lookdev menu where i can tune tweakable settings
 * in realtime."* Off by default and never in a headset: it is DOM, and
 * `dom-overlay` is not reliably granted on Quest. Tune on the monitor, fly in
 * the headset. The switch lives here, and the panel behind it
 * (`lookdev-panel.ts`) is a dynamic import in `world/build.ts` (DEV-961), so a
 * visitor who never asks for it does not download it.
 */
export const LOOKDEV = params.get('lookdev') === '1'

/**
 * `?lensMask=0` turns the app's lens mask OFF; `?lensMask=<radius>` sizes it.
 * DEV-930, lever 9; ON by default in a headset, both looks.
 *
 * The mask primes near depth outside a circle in each eye's NDC, so nothing
 * the lens cannot show is shaded (`render/lens-mask.ts`). It draws only in a
 * session, so on a monitor this pin changes nothing. The radius is uncalibrated
 * and the default is conservative; the worn sitting sizes it during fast head
 * yaw, at load with this pin or live with `__ff2.lensMask(<radius>)`, and
 * `?lensMask=0` is the off arm of that A/B. `null` is off.
 */
export const LENS_MASK_AT_BOOT: number | null = (() => {
  const raw = params.get('lensMask')
  const radius = parseLensMaskPin(raw, (m) => console.warn(m))
  if (raw !== null) console.info(`lens mask pin (DEV-930): ${radius === null ? 'off' : radius}`)
  return radius
})()

/**
 * `?hudRedraw=live` · `?hudRedraw=freeze` · `?hudRedraw=<hz>` — DEV-243, and
 * **DEV-248 made the 10 Hz budget the DEFAULT**.
 *
 * *Matt, 2026-09-20: "sounds like we should enable the redraw budget."* Unset
 * is `HUD_REDRAW_DEFAULT` — `10hz` — and `?hudRedraw=live` is the arm that
 * restores the pre-DEV-248 panel, which is how the change gets measured. On
 * `int_01_hoverJet`, the release mission, wave 4 §3.10: the old default read
 * GPU p95 7.75–8.10 across six baselines against a 7.78 rule, and the budget
 * read 7.09 · 7.16 · 7.20 in three separate runs. It is the difference between
 * straddling the rule and clearing it.
 *
 * The cockpit HUD is a 560 × 203 `CanvasTexture` and a repaint re-uploads the
 * whole canvas from inside `renderer.render`, i.e. inside this file's
 * `gpu.begin() … gpu.end()` bracket. `render/hud.ts`'s DEV-243 block carries
 * three's own line numbers for the upload and the mip regeneration on top of
 * it; the short version is that `hudSignature` holds the rounded speed in m/s,
 * so on a flight the panel re-uploads on most frames.
 *
 * `VR-PERF-WAVE-4.md` §3.5 queue F found the vehicle group carrying the whole
 * of every mission's ±1.7 ms per-frame residual, and queue H narrowed it to
 * this one object by name.
 *
 * Three arms:
 *
 *  · `freeze` — one paint, ever. The panel stays in the scene and stays drawn,
 *    so this isolates the UPLOAD from the panel's PRESENCE. Read against the
 *    `jumpseat/hud` hide, whose difference from this is the presence.
 *    Note what it looks like: the one paint is the first `update()` of the run,
 *    which is the launch banner, so the panel reads `press A` all flight. That
 *    is correct for a measurement and wrong for a screenshot.
 *  · `<hz>` — a rate. **10 is the shipped one** (`HUD_REDRAW_DEFAULT`): 2016
 *    updated its rows at the frame rate, but a rounded m/s at 90 Hz is not
 *    something a player reads, and it is the only rate anyone has measured.
 *  · `live` — 2016's cadence, and what this port shipped until DEV-248. It is
 *    now the A/B arm: a default that cannot be turned off is a default nobody
 *    can price.
 *
 * Unset is `HUD_REDRAW_DEFAULT`, and an unparseable value warns and falls back
 * to it: a typo in an env var on a 60-second run should cost a console line,
 * not the run — **and it must fall back to the DEFAULT rather than to `live`,
 * or a typo would silently measure the arm.** `__ff2.hud()` is the same switch
 * on a LIVE page, which is what perf-protocol §3d asks for — one load, two
 * readings, no cross-run pin.
 */
export const HUD_REDRAW_PIN: HudRedraw = (() => {
  const raw = params.get('hudRedraw')
  if (raw === null) return HUD_REDRAW_DEFAULT
  const parsed = parseHudRedraw(raw)
  if (parsed === null) {
    console.warn(
      `hud: ignoring ?hudRedraw=${raw} — expected 'freeze', 'live' or a rate in Hz; ` +
        `staying on the default ${describeHudRedraw(HUD_REDRAW_DEFAULT)}`,
    )
    return HUD_REDRAW_DEFAULT
  }
  // The arm announces itself in the log. A measurement run's console is the
  // one artefact that survives beside the trace, and an arm nobody can see in
  // it is an arm that has to be reconstructed from a shell command afterwards.
  //
  // DEV-248 moved the test from "not `live`" to "somebody asked", because
  // `live` is now an arm and the default is not. The silent case is the one
  // nobody pinned; every explicit `?hudRedraw=` says so, including `live`.
  console.info(`hud: redraw cadence ${describeHudRedraw(parsed)} (pinned)`)
  return parsed
})()

/**
 * `?hudUpload=nomip` · `?hudUpload=mip` — DEV-244, and it is the OTHER half of
 * DEV-243.
 *
 * The budget above is the MEDIAN lever and this is the TAIL lever, which is a
 * measured distinction rather than a tidy one. Wave 4 §3.8, on
 * `int_01_hoverJet`: `?hudRedraw=10` takes GPU p50 from 6.17 to 4.22 — 95 % of
 * everything `freeze` buys — and p95 from 7.77 to only 7.16, which is 46 %. At
 * 9.2 Hz on a 70 fps flight 13 % of frames still carry an upload and the
 * 95th-percentile frame is by definition one of them. **A budget makes the cost
 * rarer; it cannot make the rare frame cheap, and the pass rule is on p95.**
 *
 * `nomip` removes `three.module.js:12396`'s unconditional `generateMipmap` from
 * every upload that remains — one driver call and the nine dependent filter
 * passes behind it, 150,332 B written and four times that read — by setting
 * `generateMipmaps = false` and `minFilter = LinearFilter`. `render/hud.ts`'s
 * DEV-244 block prices all four candidates in bytes and says why the other
 * three are not built.
 *
 * **It is a PIXEL change and it is bigger than it looks.** three refuses
 * anisotropic filtering for any minFilter that is not mipmap-linear
 * (`three.module.js:11701`), so `nomip` loses the chain AND the panel's
 * `anisotropy = 4`, on a surface that is raked at dz/dy 1.08 and read at a
 * glance while flying. `tests/e2e/hud-upload-pixels.spec.ts` photographs it;
 * ART_DIRECTION's rule is that a thing too small has not been reviewed, it has
 * been rendered.
 *
 * Unset is `mip`, which is byte-for-byte the shipped panel. `mip` is also
 * ACCEPTED as a spelling, for `?hudRedraw=live`'s reason: an arm expressed by
 * absence is the one nobody can check afterwards. `on`, `off`, `live` and
 * `freeze` are refused — `?hudRedraw=off` already means a freeze, and one word
 * meaning opposite things on two pins of one panel is a trap rather than a
 * convenience.
 */
export const HUD_UPLOAD_PIN: HudUpload = (() => {
  const raw = params.get('hudUpload')
  if (raw === null) return HUD_UPLOAD_MIP
  const parsed = parseHudUpload(raw)
  if (parsed === null) {
    console.warn(`hud: ignoring ?hudUpload=${raw} — expected 'mip' or 'nomip'`)
    return HUD_UPLOAD_MIP
  }
  // Same argument as the cadence's: a measurement run's console is the one
  // artefact that survives beside the trace, and an arm nobody can see in it is
  // an arm that has to be reconstructed from a shell command afterwards.
  if (parsed.kind !== 'mip') console.info(`hud: upload ${describeHudUpload(parsed)}`)
  return parsed
})()

/**
 * `?hudRaster=cpu` · `?hudRaster=gpu` — DEV-256, and it is the THIRD pin on
 * this one panel. DEV-243 made the uploads rarer, DEV-244 made each one carry
 * less, and this one asks whether either was ever the cost.
 *
 * `render/hud.ts`'s DEV-256 block has the arithmetic; the short form is that
 * ~22 context calls on 113,680 pixels costing 2.1 ms is **~95 microseconds per
 * call**, which is absurd for a rounded-rect fill, so essentially all of it is
 * overhead rather than work. The Chrome trace names the slice
 * `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` **in the GPU process**, and a
 * `Flush` is what waiting looks like. `cpu` asks Chromium for a software canvas
 * (`getContext('2d', { willReadFrequently: true })`), which under that
 * hypothesis has no cross-process raster to wait for.
 *
 * **Load-time only for the pin, because it cannot be otherwise:** `getContext`
 * options are honoured on a canvas's FIRST context and ignored on every later
 * call, so the mode is baked in at construction. `__ff2.hudRaster(...)` flips
 * it on a live page by rebuilding the canvas and the texture — see `setRaster`
 * — and that is a real rebuild, not a field write.
 *
 * **It should change no pixel**, which is a claim and not an assumption:
 * software and GPU raster of the same 2-D calls are intended to be identical,
 * and `tests/e2e/hud-upload-pixels.spec.ts` photographs both arms and diffs
 * them. Unlike `?hudUpload=nomip` this is not a filtering change at all — the
 * texture state is untouched.
 *
 * Unset is `HUD_RASTER_SHIPPED` — `cpu` since DEV-256, and named rather than
 * spelled so this sentence cannot go stale again (DEV-266; it read "unset is
 * `gpu`, which is the shipped canvas" for a day after that stopped being
 * true). **Both arms are ACCEPTED as spellings**, for `?hudRedraw=live`'s and
 * `?hudUpload=mip`'s reason: an arm expressed by absence is the one nobody
 * can check afterwards — which now cuts for `cpu` as much as for `gpu`, since
 * the default has moved once already. `on`, `off`,
 * `live` and `freeze` are refused — `?hudRedraw=off` already means a freeze,
 * and one word meaning opposite things on three pins of one panel is a trap
 * rather than a convenience.
 *
 * **No duration has been measured.** The arm exists so the coordinator can take
 * one on a quiet box; nothing here claims it is faster.
 */
export const HUD_RASTER_PIN: HudRaster = (() => {
  const raw = params.get('hudRaster')
  const parsed = raw === null ? null : parseHudRaster(raw)
  if (raw !== null && parsed === null) {
    console.warn(`hud: ignoring ?hudRaster=${raw} — expected 'gpu' or 'cpu'`)
  }
  // ── DEV-256 SHIPS ON, 2026-09-20 — and the argument is the REGIME ────────
  //
  // Matt: *"i'm a lil frustrated that some of our perf wins today are
  // defaulting to off."* Fair, and the number that settles this one is not
  // the panel's, it is the frame's.
  //
  // `perf-baseline.md`: worn GPU p95 is **8.45 ms against a 7.78 ms rule**
  // (0.7 × 11.111), so **the app is 9 % over the 90 Hz GPU budget** and
  // SteamVR holding the 45 Hz tier is a defensible decision rather than a
  // mystery. We are GPU-bound, with the compositor and the stream encoder
  // sharing the same laptop GPU.
  //
  // A software canvas MOVES the panel's raster off that GPU and onto the main
  // thread. Measured over twelve rides: it removes **every**
  // `DoEndRasterCHROMIUM` slice from the trace (14 → 0), and costs about
  // **+0.4 ms of main-thread rAF p95** — 4.53 against a control spanning
  // 3.91–4.14 — on a main thread whose median callback is **0.29 ms**.
  //
  // **Trading GPU for main thread is the right direction when the GPU is the
  // one over budget**, and it is the whole of why this is on. It is also
  // **pixel-identical**, not approximately: five captures of the panel's own
  // canvas hash the same, 0 px differ, max channel delta 0.
  //
  // `?hudRaster=gpu` is the way back, and the +0.4 ms is a single reading, so
  // **a worn capture can overturn this**. That is what the pin is for.
  //
  // DEV-266: `HUD_RASTER_SHIPPED`, not `HUD_RASTER_CPU`. The VALUE lives in
  // `render/hud.ts` and this line only consumes it, because when this was a
  // literal here the flip to `cpu` left `hud-upload-pixels.spec.ts` asserting
  // `gpu` and red on `main` for a day. Overturning the paragraph above is now
  // one line there, not a literal per site.
  const on = parsed ?? HUD_RASTER_SHIPPED
  // Printed on every load, pinned or not: this decides which PROCESS rasters
  // the panel, and a trace with no line saying which is a trace nobody can
  // attribute to an arm afterwards.
  console.info(`hud: raster ${describeHudRaster(on)} (DEV-256)`)
  return on
})()

/**
 * `?hudWarm=on` · `?hudWarm=off` — DEV-250, and it is the RELEASE FRAME's
 * lever where the two above are the median's and the tail's.
 *
 * On `rookie_01_hoverJet` the frame the player is released into flight is
 * dt 27.7 ms with 2.00 ms inside `renderer.render`, and a Chrome trace names
 * the other 25 as `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` in the GPU
 * PROCESS. `?hudRedraw=freeze` takes that frame to 11.1 ms, so it is this
 * panel; `render/hud.ts`'s DEV-250 block has the font-size arithmetic that
 * says which part of the raster is new at release and why the lift ride
 * cannot have warmed it.
 *
 * On, this paints the panel once at its FLIGHT layout just before
 * `warmWorld`'s draw and hands that draw the panel to render, so the raster
 * and the upload both happen under the loading curtain. It is DEV-117's move,
 * applied to a canvas instead of to a shader.
 *
 * **OFF by default, and it stays off until both arms have been measured on a
 * quiet box.** DEV-248 is the precedent and the discipline is the same one:
 * this repo does not move a default it has only reasoned about, and the
 * measurement wants `?hudRedraw=freeze` beside it as the floor. See the
 * DEV-250 row in `docs/DEVIATIONS.md` for the commands.
 */
export const HUD_WARM_PIN: boolean = (() => {
  const raw = params.get('hudWarm')
  const parsed = raw === null ? null : parseHudWarm(raw)
  if (raw !== null && parsed === null) {
    console.warn(`hud: ignoring ?hudWarm=${raw} — expected 'on' or 'off'`)
  }
  // DEV-250 IS THE DEFAULT since 2026-09-20 (Matt, on the release-window
  // measurement in `render/hud.ts`'s `HUD_WARM_DEFAULT` block: 33 ms to 11.2,
  // which is the `freeze` floor exactly, for no pixel and no program).
  // `?hudWarm=off` is the arm that goes back.
  const on = parsed ?? HUD_WARM_DEFAULT
  // Printed on EVERY load, pinned or not, and that is deliberate for a reason
  // the other pins do not have: this one changes what happens under the
  // LOADING CURTAIN, where nothing is on screen to show it ran. A trace with
  // no line here is a trace nobody can attribute to an arm afterwards.
  console.info(`hud: warm ${describeHudWarm(on)} (DEV-250)`)
  return on
})()

/**
 * `?hudGauges=bar` · `needle` · `bar-only` · `needle-only` · `off` — DEV-257,
 * and it is the answer to BOTH of Matt's complaints about this panel with one
 * change.
 *
 * *"our perf work has identified the game's hud has a huge perf problem … the
 * current method is problematic anyway since it feels disjointed from the
 * actual cockpit"* — and the thing that makes the panel expensive is the thing
 * that makes it feel pasted on. It is a picture of an instrument, repainted,
 * rather than an instrument.
 *
 * The four readings that move at frame rate are all continuous quantities, and
 * three of them were already drawn as plain `fillRect` bars. They move onto
 * geometry; the text stays on the canvas. What is left to force a raster is
 * the clock at 1 Hz, the gate count a few times a minute, and events — which
 * is roughly a TENTH of DEV-248's budgeted 10 Hz and a fiftieth of `live`.
 *
 * **It is better on both axes rather than a trade.** DEV-248's budget bought
 * its 0.6 ms with a speed readout that steps nine times a second; under this
 * arm the speed gauge is smooth at frame rate and the numbers that remain
 * genuinely only change once a second. Whether the budget can therefore be
 * retired is a separate decision on measured numbers and is NOT taken here —
 * `HUD_REDRAW_DEFAULT` is untouched.
 *
 * **It is a PIXEL change**, so it is off by default and it has an
 * `ART_DIRECTION.md` read and a `DEVIATIONS.md` row behind it. With the arm
 * down the panel is byte-identical and pixel-identical to what ships:
 * `render/hud.ts` constructs no geometry, no material and no node, which is
 * stricter than "the flag is off" and is the promise
 * `render/cockpit-interior.ts` makes for Classic.
 *
 * The two FORMS are the one genuinely new design on this panel — the three
 * ported bars keep their exact rectangles and their exact inks — and they are
 * both here because the project's rule is to photograph a thing before
 * believing it. `bar` is the smallest change; `needle` is the most
 * instrument-like. `-only` drops the speed DIGITS, which is the variant that
 * takes the repaint rate all the way down to the clock.
 */
export const HUD_GAUGES_PIN: HudGauges = (() => {
  const raw = params.get('hudGauges')
  if (raw === null) return HUD_GAUGES_OFF
  const parsed = parseHudGauges(raw)
  if (parsed === null) {
    console.warn(
      `hud: ignoring ?hudGauges=${raw} — expected 'off', 'bar', 'needle', 'bar-only' or 'needle-only'`,
    )
    return HUD_GAUGES_OFF
  }
  // Same argument as the other two pins on this panel: a measurement run's
  // console is the one artefact that survives beside the trace, and an arm
  // nobody can see in it is an arm that has to be reconstructed from a shell
  // command afterwards.
  if (parsed.kind !== 'off') console.info(`hud: gauges ${describeHudGauges(parsed)}`)
  return parsed
})()

/**
 * `?propCells=<n>` overrides the props' culling grid, `n` cells per axis. A
 * DEV switch for `tests/e2e/render-census.spec.ts`-style measurement: 1 is the
 * pre-DEV-118 layout (one mesh per palette entry, nothing culled), and the
 * shipped value is `PROP_CELLS_PER_AXIS` in `game/props/cells.ts`. Unset or
 * nonsense leaves the shipped grid alone.
 */
export const PROP_CELLS = (() => {
  const raw = Number(params.get('propCells'))
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined
})()

/**
 * `?propLod=off` or `?propLod=<metres>` overrides 2016's prop reveal distance.
 *
 * A DEV switch for the A/B, exactly like `?propCells=` above. `off` is
 * `Infinity` — the whole scatter at every distance, which is the frame the port
 * drew before DEV-225 and the BASELINE arm of that measurement. A number is a
 * radius in metres for every pass. Unset leaves each generator's own extracted
 * value alone: 1280 m on desert, Simonet and Kauai, 1920 and 1280 on alpine.
 *
 * It is NOT a preset flag and deliberately so: 2016 culled its scatter past
 * `LODDistance` on the build Classic reproduces, so this is fidelity on both
 * editions rather than an Anniversary addition. `docs/DEVIATIONS.md` DEV-225.
 */
export const PROP_LOD = (() => {
  const raw = params.get('propLod')
  if (raw === null) return undefined
  if (raw === 'off') return Number.POSITIVE_INFINITY
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  console.warn(`?propLod=${raw} is not "off" or a positive number of metres — ignored`)
  return undefined
})()

/**
 * `?swell=<metres>` retunes the ocean wave. A DEVIATION, off by default.
 *
 * Measured at the shipped settings, over the ocean's real 256 m vertex grid:
 *
 * | vertex spacing | height range | facet tilt, mean / worst |
 * |---|---|---|
 * | **256 m — what ships** | +/-4 m | **0.39 deg / 1.02 deg** |
 * | 64 m | +/-4 m | 2.22 / 6.76 |
 * | 16 m | +/-4 m | 4.47 / 12.86 |
 *
 * `_DisplaceFrequency` 0.4 on world metres is an **11.1 m** wave on a mesh whose
 * vertices are **256 m** apart — a 23x undersample, so the geometry carries
 * noise rather than a wave. That is faithful: our GLSL matches Unity's
 * `Core.cginc` line for line and the plate really is 32 mesh units at 8x scale.
 * 2016's sea was equally flat, and the faceting Matt remembers is the cranked
 * specular he identified himself, not the geometry.
 *
 * So this is art direction, not a fix. `?swell=1024` gives a wave four quads
 * long, which the mesh CAN carry and which reads as a rolling swell. Nothing
 * changes unless it is asked for.
 */
export const SWELL = (() => {
  const raw = Number(params.get('swell'))
  return Number.isFinite(raw) && raw > 0 ? raw : null
})()

/**
 * Wireframe, because shading cannot answer a question about geometry.
 *
 * Matt: *"plz add the ability to show wireframe of the ocean. it's still a
 * flat surface."* The ocean's quads are 32 m of mesh times the plate's 8x =
 * **256 m** in world space, and a 4 m wave across 256 m is about a degree of
 * facet tilt. Diffuse shading cannot show a degree; the wireframe shows the
 * vertices themselves, which is the only view that settles it outright.
 *
 * `?wire=ocean` | `islands` | `all` at boot, and **O** cycles it in flight.
 * The displacement is a VERTEX shader, so the wireframe rides the wave — a
 * flat grid of lines means the sea really is flat, not that the view is wrong.
 */
export const WIRE_STAGES = ['off', 'ocean', 'islands', 'all'] as const
export type WireStage = (typeof WIRE_STAGES)[number]
export const WIRE_AT_BOOT: WireStage =
  (WIRE_STAGES as readonly string[]).indexOf(params.get('wire') ?? '') > 0
    ? (params.get('wire') as WireStage)
    : 'off'

/**
 * Who you race. `ai` (default) or `ghosts`. **Matt's call, DEV-026.**
 *
 * *"let's simplify and deviate from 2016 by giving our ghosts the same autopilot
 * logic we're using for the player proxy."*
 *
 * This is the biggest deviation in the ledger, because "against ghosts recorded
 * in 2016" is one of the port's stated pillars. So the recordings are kept, not
 * deleted: `?opponents=ghosts` runs them exactly as before, and the clips, the
 * extractor and their tests all stand.
 *
 * What it buys is a race. A recording cannot respond to you and cannot be
 * tuned, and on `int_01` it runs at roughly half the pace a boosted autopilot
 * manages — the opposition was a kilometre behind by the ninth second.
 */
export const OPPONENTS = params.get('opponents') === 'ghosts' ? 'ghosts' : 'ai'

/**
 * `?particles=cpu`: DEV-925. The GPU engine (`render/gpu-particles.ts`) is the
 * default since Matt's call, 2026-10-12: *"make gpu the default - try and
 * match the behavior of the older systems, but it's ok if they're not
 * exact"*. This pin puts the 2016 port's CPU engine back for an A/B; anything
 * else is `gpu`.
 */
export const PARTICLE_ENGINE: 'cpu' | 'gpu' = params.get('particles') === 'cpu' ? 'cpu' : 'gpu'

/**
 * The URL's half of D30's `runTainted` (DEV-371): every switch in it that is
 * not on `game/run-taint.ts`'s presentation-only allowlist, as `?name`. A lap
 * flown from such a URL may be kept and raced here, and never submitted. The
 * autopilot's half is taken per tick, in the fixed step.
 */
export const URL_TAINT = urlTaint(params)

/**
 * `?ghost=<id>` — a shared lap's link (DEV-373, PLAYER-GHOSTS §4.2 door 3: the
 * "beat my 78.4 s" message). The lap is fetched at boot; once it is in, the
 * title's Quick Race row names whose ghost it is and a press boards that
 * course, in that aircraft, behind Quick Race's one fade and no ride.
 *
 * ON the presentation allowlist (`game/run-taint.ts`): a ghost is intangible,
 * so a lap raced from a link is a clean lap. An id that is not the server's
 * shape never reaches the network.
 */
export const GHOST_LINK_ID: string | null = ((): string | null => {
  const raw = params.get('ghost')
  if (raw === null) return null
  if (isLapId(raw)) return raw
  console.warn(`?ghost=${raw} is not a lap id; ignored`)
  return null
})()

/**
 * The HoverJet's lateral limit, MEASURED off its own flight model: a turn
 * radius of 136 m at 149 m/s, 162 m/s² (about 5 g). The ship OUT-TURNS this
 * course — a 99-degree corner between 513 m legs wants about 215 m of radius
 * and it has 136 — so the velocity profile's curvature limit bites only in the
 * tight corners.
 *
 * The profile's other numbers are the JET's, off its sheet
 * (`sim/hoverjet.ts`'s `speedProfileModel`): its top speed since the DEV-382
 * follow-up, and since DEV-394 its braking and its acceleration too. They were
 * `SHIP_BRAKE_ACCEL` 5.3 m/s² and `SHIP_ACCEL` 8, and neither is what the flight
 * model does: with the throttle shut it sheds 1.218 m/s every METRE (Unity's
 * drag), 180 to 123 m/s in 47 m of coasting rather than the 1,630 m the old
 * profile planned for.
 */
export const SHIP_LAT_ACCEL = HOVERJET_LAT_ACCEL_MEASURED

/**
 * Follow the AUTHORED RACING LINE. **On.** `?guide=off` goes back to aiming
 * gate to gate.
 *
 * `CurvyClonePath` is the Curvy spline 2016 built the course around: 421 points
 * over 11.3 km, every gate on it to within 0.4 m, and it never enters terrain.
 *
 * ── It was off until the textbook answer was looked up ───────────────────
 *
 * Following it by pure pursuit alone was a regression — 12 gates against 18 —
 * because a pursuit follower cuts corners and missed rings by two metres. Two
 * home-grown attempts at a fix (a shorter lookahead, then curvature-scaling it)
 * both oscillated and made it worse.
 *
 * What racing games actually do is a **velocity profile**: compute the target
 * speed at every point once, in three passes, and look it up. See
 * `sim/route.ts`'s `withSpeedProfile`. The backward braking pass is the one that
 * matters: it starts the lift before the corner is in view. (This said the
 * ship decelerates at 5.3 m/s², so braking had to start 1.6 km out. It does
 * not: it sheds 1.218 m/s every metre with the throttle shut, and DEV-394
 * rebuilt the profile on that.)
 *
 *     gate-to-gate aiming                 18 gates in 70 s, biggest gap 5.5 s
 *     line + cross-track, no profile      17 gates,          biggest gap 7.2 s
 *     line + velocity profile             **19 gates**,      biggest gap 5.6 s
 */
export const GUIDE_SPLINE = params.get('guide') !== 'off'

/**
 * The crash rule, off, for a vehicle it is not written for (DEV-126). Every
 * number is zero and none of them is read while `enabled` is false; this
 * exists so the JumpSeat is not handed the HoverJet's preset by accident.
 */
export const NO_CRASH: CrashSpec = {
  enabled: false,
  minImpactSpeed: 0,
  resetBackMetres: 0,
  clearanceMetres: 0,
  resetSpeed: 0,
  holdSeconds: 0,
  resetClearStepMetres: 0,
}

/**
 * `?ride=0` cuts the elevator ride again. Default: you ride it, ONCE.
 *
 * **Matt cut it on 2026-09-10** — *"the platform floats up and then the ship
 * floats up. plz make it so the platform starts at the top position... we cut
 * the elevator ride for this version"* (DEV-024) — and the cut was right at the
 * time, because the ride was 15.5 seconds of rising out of a hole with nothing
 * at the bottom of it.
 *
 * **Restored on 2026-09-11**, because there is now a hangar down there and the
 * ride is what it was always for: *"you started in an underground hangar and
 * rode the shaft up. Very inspired by Evangelion."* DEV-035.
 *
 * ONCE, though. See `rideSpent` — 15.5 seconds is an establishing shot the
 * first time and a toll every time after, and the results panel's "press A to
 * fly again" is the loop this version exists to make worth using.
 */
export const SKIP_RIDE = params.get('ride') === '0' || ROOM_AT_BOOT !== null // DEV-388: no lift in a room

/**
 * `?rideHide=all | bore` — what is held off the screen during the lift ride.
 * DEV-249. Default `all`, which is what has always shipped.
 *
 * ── Why there is a choice here at all ─────────────────────────────────────
 *
 * Matt, worn, 2026-09-20: *"the app gets locked to 45 hz just after the
 * elevator reaches the top - when the terrain is unhidden ... what i'd suggest
 * is making the amount of object needed to be hidden, smaller. so if the
 * elevator is under 1 terrain chunk - hide only that chunk."*
 *
 * He was right and the measurement is DEV-249. On the frame the land comes
 * back, the world pass goes from **54 draw calls and 69,686 triangles to 121
 * and 3,789,178** — 54× the geometry, permanently, in one frame — and
 * `renderer.render` costs **12.40 ms against a 1.30 ms baseline**. Flat that
 * is invisible; the harness draws a tenth of a worn frame's pixels. Worn it is
 * the whole flight arriving at once, and **a compositor latches on a STEP**.
 *
 * ── Why hiding less is not the same as hiding nothing ─────────────────────
 *
 * The reason the land is hidden is ONE intersection: with the shaft sealed
 * (DEV-106) the only world the eye can see from inside the tube is what
 * crosses the tube's own volume, and on `rookie_01_hoverJet` that is a
 * hillside standing 1.4 m proud of the deck for a third of a second. That is a
 * property of the few chunks the BORE passes through — **measured on
 * `rookie_01_hoverJet`, exactly ONE of alpine's 64** — so `bore` hides that
 * one and leaves the other 63 drawn for the whole ride.
 *
 * The trade is deliberate and it is not "free": the ride then costs what the
 * flight costs, because the world is being drawn throughout. **That is the
 * point.** A flat cost curve gives a latching compositor nothing to latch on,
 * and if it does drop it does so with 15 s of steady load still to run rather
 * than at the instant the player is handed the stick.
 *
 * Props need no equivalent: DEV-100's `spawnClearing` already clears every
 * scattered prop within 51.97 m of the spawn, which is far wider than the
 * 7.6 m the bore selection actually reaches on `rookie_01_hoverJet`.
 */
/**
 * **SHIPS AS `bore`, 2026-09-20.** It was built default-`all` pending a worn
 * look, and that caution was wrong twice over: the fix is **Matt's own**, for
 * the **exact symptom he is still reporting worn**, and the thing it was
 * waiting on — *"nobody has ridden it and looked down to check the right
 * chunks are hidden"* — is answered by the code above rather than by a ride.
 * The selection is a real geometric test on each chunk's **world bounds**
 * against `boreRadius + randomOffset`, and `chunk.visible = revealed` is
 * written **every frame**, so the chunks come back at the reveal and no hole
 * can outlive the ride. It logs loudly when it selects none.
 *
 * `?rideHide=all` is the way back.
 *
 * **What it costs is in the block above and is the point**: the ride draws the
 * world throughout instead of stepping into it, so a latching compositor gets
 * a flat curve instead of a 54× cliff at the one instant the player is handed
 * the stick. Flat, the ride's dt is unchanged at 5.60; worn, the ride is where
 * the cost lands, with 15 s of steady load before flight begins.
 */
export const RIDE_HIDE: 'all' | 'bore' = params.get('rideHide') === 'all' ? 'all' : 'bore'

/**
 * `?menu=0` drops you straight into the cockpit. Default: you start in the chair.
 *
 * **Matt, 2026-09-11:** *"in the original game, we had a title screen, then the
 * mission select screen (the ship selection screen was in there too). players
 * were not in the cockpit while in the menus. that was only on the missions."*
 *
 * The first build of the hangar got this wrong — it put the camera in the
 * cockpit and argued that the cockpit WAS the seat. The source says otherwise
 * and so does he: `MM_Commander_Chair_01`, the jet parked 8–10 m away, and the
 * mission scene is a different scene. You choose, and THEN you are in the ship.
 *
 * `?autopilot=1` skips it too — the autopilot exists to fly the course, and a
 * menu it has to be talked through is a menu in the way of every lap spec.
 *
 * ~~DEV-469: and so does `?edit=1`~~. DEV-471 took `?edit=1` out: it boots
 * to the MENU screen with no world and goes to the island through MAKE A
 * COURSE's door, the loading scene (`EDIT_AT_BOOT`, below, and the editor's
 * block in `bootApp`).
 */
export const SKIP_MENU = params.get('menu') === '0'

/**
 * DEV-469: `?edit=1` — the desktop course editor, over the world of
 * `?mission=` (or the default), as the development switch EDITOR.md §5.3 keeps
 * beside the title's door. Only where the build has the editor: the menus'
 * `gameplay.editor` block decides, as it decides the title's row (D35), so a
 * build without the editor ignores it and lands in the cockpit, as `?menu=0`
 * would (DEV-471: through the loading scene, below). (A release build has the editor since DEV-470, so the switch works
 * there too, as `?mission=` does.)
 *
 * DEV-471: it arrives the way MAKE A COURSE does. Boot lands on the MENU screen
 * with no world (`bootWorld` `'none'`), the loading scene stands at once (the
 * course's plate and the turning emblem, DEV-355 and DEV-434) and the island
 * is built behind it by `switchMission`, as the title's door builds it. It
 * used to boot INTO the mission and open the editor at boot: the panel stood,
 * live, over a black canvas for the whole build, with nothing to say anything
 * was happening but the landing card's button (Matt: *"want a loading screen
 * to understand it's doing something"*).
 */
export const EDIT_AT_BOOT = params.get('edit') === '1'

/**
 * DEV-540: `?edit=1&shipped=<id>` — the editor opened on a SHIPPED mission
 * (plan/SHIPPED-COURSE-EDITS.md §4.3), to edit its override
 * (`content/overrides/<id>.json`) and save it through the dev server's write
 * (DEV-539). **`pnpm dev` only**: `import.meta.env.DEV` is a literal `false`
 * in a production build, so this is `null` there and every branch that reads
 * it folds away with the shipped desk's dynamic import inside it — a
 * player has no repo to write to (`tests/unit/editor-shipped-door.test.ts`).
 * It changes only what the editor opens, and it is not on `run-taint.ts`'s
 * allowlist, so a lap flown under it taints, as any unlisted switch does.
 */
export const SHIPPED_AT_BOOT: string | null = import.meta.env.DEV ? params.get('shipped') : null

/**
 * DEV-489: `?island=cone` — the editor opens over a SYNTHETIC custom island
 * (`game/terrain/custom-ground.ts`'s `previewIsland`) instead of the sky's own
 * ground, by the doors a person takes into it (MAKE A COURSE, `?edit=1`).
 *
 * **A preview-build door, and only a door.** It is read on the preview channel
 * and never on a release build (`BUILD_CHANNEL`), and all it does is put a
 * ground on the level those doors already load. Everything after — the world
 * build, the editor, the playtest, the flight — is the path DEV-490's import
 * and DEV-493's seeds will feed with a player's own ground, so what a spec
 * flies through it is the game, not a harness path (CLAUDE.md).
 */
export const ISLAND_AT_BOOT = params.get('island')

/**
 * `level` over the `?island=` preview ground, or `level` itself. DEV-489. The
 * decision, the release channel's refusal included, is `previewIslandDoor`'s,
 * pinned in `custom-ground.test.ts`.
 */
export const withPreviewIsland = (level: Level): Level => {
  const next = previewIslandDoor(BUILD_CHANNEL, ISLAND_AT_BOOT, level)
  if (ISLAND_AT_BOOT && BUILD_CHANNEL !== 'release' && next === level) {
    console.warn(`island: no preview ground "${ISLAND_AT_BOOT}"`)
  }
  return next
}

/**
 * DEV-469: the editor's playtest in flight, or null. MODULE-level, not in the
 * editor's block inside `bootApp`, because the world build reads it
 * (`buildWorld`: a partial run keeps no lap) and at boot the build runs before
 * that block's lines have — a `let` there would be a TDZ error in waiting.
 */
export const EDITOR_RUN: { request: PlaytestRequest | null } = { request: null }

/**
 * DEV-469: is the run in flight a "fly from here" — a PART of a course? It
 * keeps the full course's medals (DEV-468's `playtestLevel`), so it must never
 * award one or keep a best or a lap (EDITOR-DISPATCH, DEV-469). DEV-475: a
 * full lap is `fromT` null, from the start pad; any number is a part.
 */
export const editorPartialRun = (): boolean => {
  const r = EDITOR_RUN.request
  return r !== null && r.fromT !== null
}

/**
 * DEV-491: the editor's RECORDING flight in flight, or null: the level it is
 * flown in (the core's `recordingLevel`, Free Flight from the draft's pad).
 * Module-level beside `EDITOR_RUN`, for its reason: the pause plate's rows
 * read it, and they are built above the editor's block.
 */
export const EDITOR_RECORD: { level: Level | null } = { level: null }

/**
 * `?title=0` skips the title screen. Default: you start on it.
 *
 * **Matt, 2026-09-11:** *"the title screen in the original FF started with the
 * player in a field, the 3D logo giant out front, and the ai racers on a
 * predetermined path. (press A to start)"* - then underground for the menus,
 * then the missions. Three screens, and this is the first.
 *
 * `?menu=0` and `?autopilot=1` imply it: both exist to get to the flying.
 */
export const SKIP_TITLE = params.get('title') === '0'

/**
 * Where the title screen's alpine valley is parked, THREE space.
 *
 * This is the offset applied to the terrain's own transform, which puts the
 * map's CORNER near it — and since DEV-042 the map then swings around that
 * corner by 2016's own rotation, so the number to check is not this one but
 * where the valley ends up. Measured: world AABB x [25,825 .. 30,222],
 * z [−4,541 .. −181], nearest corner **25.8 km** from the Simonet origin. The
 * far plane is 6 km, so that is **4.3 far planes** and the two worlds still
 * cannot see each other — but it used to be five, and the rotation is what
 * spent the difference. The ocean is not here either (its own `visibleRadius`
 * is centred on the island), so the valley sits alone under the sky, which is
 * what a title screen wants.
 *
 * If a future change rotates or re-parks this valley again, re-derive that
 * clearance rather than trusting this sentence: it is a number computed from
 * two others, which is exactly the kind DEV-027 says goes stale quietly.
 */
export const TITLE_VALLEY_OFFSET: readonly [number, number, number] = [30_000, 0, 0]

/**
 * The three layer the logo and its key light share.
 *
 * 23 to match 2016's `SpecialLighting`, though any spare bit would do — what
 * matters is that the spotlight and the logo share it and nothing else does.
 *
 * Three's rule is the same as Unity's culling mask: a light affects an object
 * when `light.layers.test(object.layers)` finds a common bit. So the logo gets
 * 23 IN ADDITION to 0 — drop 0 and the camera, which only looks at 0, stops
 * seeing it at all.
 */
export const LOGO_LAYER = 23

/**
 * How much of 2016's spotlight intensity the logo key actually gets.
 *
 * Matt's call, by eye, with the real logo in the real valley under the real
 * menu sun: full strength blew out the gold. Named rather than folded into the
 * expression so it reads as a DEVIATION from a measured number instead of
 * looking like part of the measurement (DEV-044).
 *
 * 0.8 until DEV-635, when Matt said it was still blowing the logo out. Swept
 * live at 1.0, 0.5, 0.3 and 0 of the 0.8 value on the flat title: at half,
 * the gold reads as gold and every facet separates; at 0.3 the silver goes
 * dull; at 0 the emblem is orange. Half of 0.8 is 0.4.
 */
export const LOGO_KEY_TRIM = 0.4

/**
 * The TITLE screen's own sun, off `main_menu.unity`.
 *
 * Matt: *"are we missing the d-light / sun from the old menu?"* — we were. The
 * valley was lit by `int_01`'s sun, and the two are not remotely the same
 * light:
 *
 *   menu      39.3 deg above the horizon, warm (0.956, 0.861, 0.611), 0.6
 *   int_01     4.0 deg above the horizon,      (0.831, 0.569, 0.391), 1.3
 *
 * A 4-degree sunset raking across an alpine valley is why the title screen came
 * out hazy and flat, and why the logo needed an emissive floor to be visible at
 * all. This is a proper midday sun.
 *
 * `Directional light` is a plain scene GameObject (`&1035699663`, `m_IsActive:
 * 1`) with its `Light` at `&1035699664` (`m_Enabled: 1`) and its transform at
 * `&1035699665` — so it passes the liveness walk. CLAUDE.md's rule that the sun
 * is per-MISSION turns out to hold for the menu too: the menu is a scene, and
 * it carries its own.
 *
 * Direction is UNITY space, like `lighting.sun.direction`. The colour is the
 * raw `m_Color`, and three linearises it per channel (`SRGBColorSpace`) before
 * the intensity multiplies. That is NOT quite Unity 5.4's rule, which folds the
 * intensity in first — `GammaToLinearSpace(m_Color × intensity)` — and which
 * the missions' suns have taken since DEV-454 (the extractor writes it into
 * `lighting.sun.colorLinear`; until then this comment said the extractor
 * converted, and it did not). For this light the hue barely moves — (1, 0.789,
 * 0.368) here against (1, 0.796, 0.384) — but 2016's rule draws it at 0.54 of
 * this brightness (the intensity under 1 goes through the curve too). The
 * title is not a mission and is left as it is: DEV-454 names it as a call.
 */
export const TITLE_SUN = {
  direction: [0.0261, -0.6338, 0.7731],
  colorSrgb: [0.9558824, 0.8608758, 0.6114836],
  intensity: 0.6,
} as const

/**
 * The TITLE screen's own FOG and AMBIENT, off `main_menu.unity`. DEV-155.
 *
 * `TITLE_SUN` above fixed the sun and stopped there, so the valley kept
 * flying `int_01`'s **air**: a pink height fog with its dense half at 164 m,
 * and Simonet's Marmoset ambient yawed 139 degrees. Same bug, twice more.
 * Matt's question about the sun — *"are we missing the d-light / sun from the
 * old menu?"* — has the same answer for both of these.
 *
 * ── the fog ───────────────────────────────────────────────────────────────
 *
 * `main_menu.unity`'s `RenderSettings` (`!u!104 &2`): `m_Fog: 1`,
 * `m_FogMode: 2` (exponential), `m_FogDensity: 0.00015`, `m_FogColor`
 * (0.8455882, 0.9680527, 1) — a COLD pale blue against `int_01`'s
 * (0.866667, 0.658824, 0.698039), which is pink.
 *
 * **And there is no height fog here.** The GlobalFog fields in a level JSON
 * (`height`, `heightDensity`, `startDistance`, `radial`) come from a
 * `GlobalFog` image effect on the MISSION camera; `PreFabs/Cameras.prefab`,
 * which is the camera `TitleScene/Cameras` instantiates, carries none — its
 * script list is MouseLook, Input_Look, Fade_Mesh, CameraMode, Bloom,
 * NoiseAndGrain, the OVR and SteamVR rigs, and CheckEntitlements. So the menu
 * ran Unity's plain exponential fog and nothing else, which at 300 m is about
 * 4 % and at 3 km is about a third: a clear day with distance on it.
 *
 * DEV-018's ×0.50 thinning is NOT applied. That was Matt's call about the
 * three Simonet-sunset MISSIONS and their height fog; this is a different
 * scene's fog, it has never been tuned, and halving an untuned number to
 * match a tuning made for something else is how a measurement turns into a
 * habit. If the valley wants thinning it gets its own row.
 *
 * ── the ambient ───────────────────────────────────────────────────────────
 *
 * `LevelLogic/Sky Manager`'s `_GlobalSky` is fileID **2008952522**, which is
 * the `Sky` on the root GameObject `Pisa` — not the one on `Forest`, which is
 * live, enabled, and not the global sky. `titlescreen.unity` points at the
 * same component, so the whole 2016 menu flow is lit by Pisa.
 *
 * `masterIntensity` 1.19 × `diffIntensity` 0.67 = **0.7973**, which is
 * `_ExposureIBL.x` (Sky.cs:582). `Pisa`'s transform is identity in both
 * scenes, so unlike Simonet's `ibl_sky` there is no sky rotation at all — the
 * port was lighting an alpine valley through a 139-degree yaw that belongs to
 * an island 30 km away.
 *
 * The 27 floats are the serialised `SH.c`, verified against the serialised
 * `cBuffer` by the identity `cBuffer[i] = c[i] * SH_BASIS_CONSTANT[i]`
 * (0.2877324 = 1.0199848 × 0.28209479), which is the same cross-check
 * `tools/extract/constants.mjs` runs on every environment's IBL.
 *
 * HAND-CARRIED, like `TITLE_SUN` and for the same reason: the extractors read
 * MISSION scenes and environment prefabs, and `main_menu.unity` is neither.
 * Every field above cites its file and its fileID so the next person can check
 * it; getting the menu into the generated sheet is an open item on DEV-155.
 */
export const TITLE_FOG = {
  mode: 2,
  density: 0.00015,
  linearStart: 0,
  linearEnd: 998,
  colorSrgb: [0.8455882, 0.9680527, 1],
} as const

export const TITLE_IBL = {
  // `Pisa` Sky, `main_menu.unity` &2008952522 — byte-identical to the one in
  // `titlescreen.unity`, which is the corroboration rather than the source.
  sh: [
    1.0199848, 0.85216135, 0.8241094, 0.45185566, 0.3761862, 0.3925171, 0.024962872, 0.2273162,
    0.3751282, -0.097699724, -0.12702571, -0.15192586, -0.033459518, -0.04560229, -0.05470487,
    -0.012184581, 0.069241494, 0.13173872, 0.041378934, 0.042385537, 0.039425828, 0.0032465379,
    -0.036014926, -0.05923965, -0.0025865133, 0.0014751581, -0.0042347168,
  ],
  /** `Pisa`'s transform, and it is identity in both menu scenes. */
  rotationUnity: [0, 0, 0, 1],
  exposure: { diffuse: 1.19 * 0.67, specular: 1.19 * 1 },
} as const

/**
 * `?fog=off` draws with no fog at all. A DIAGNOSTIC, never a default.
 *
 * `int_01` is lit from 4 degrees, so most of what you see on a mountainside is
 * ambient plus fog rather than sun. Being able to remove one of the two is the
 * difference between judging the terrain's colour and judging the fog's.
 */
export const FOG_ENABLED = params.get('fog') !== 'off'

/**
 * `?fogsky=off`: put 2016's single flat fog colour back.
 *
 * On by default because the flat colour leaves a visible seam at the skyline:
 * the fog is 1.4x to 2.7x brighter than the sky it fades into and nearly twice
 * as blue, and no single colour can fix that because the sky's own horizon
 * swings by a factor of two around the compass. See `render/unity-fog.ts`.
 * Read here and handed to `missionFog` as an argument (DEV-509).
 */
export const FOG_TAKES_SKY_COLOUR = params.get('fogsky') !== 'off'

/**
 * `?props=off` skips the environment prop layer.
 *
 * On by default — the forest is the environment, not decoration. The switch
 * exists because props are ~10 extra draw calls of ~6,000 instances and the
 * whole layer is currently drawn without LOD, so it is the first thing to
 * remove when judging a frame budget or a terrain colour.
 */
export const PROPS_ON = params.get('props') !== 'off'

/**
 * `?tint=raw` uses the material tint unconverted — a DIAGNOSTIC, not a reading.
 *
 * The 2016 project rendered Linear and the steady-state chunk carries no
 * property block, so converting is what shipped. See `render/terrain-mesh.ts`.
 */
export const TINT_IS_SRGB = params.get('tint') !== 'raw'

/**
 * DEV-454: every mission's sun is 2016's since the extractor took Unity 5.4's
 * light rule, and `?sunlight=port` puts back the rule the port drew by before
 * it — the raw `m_Color` as if linear — for A/B. Applied where the level is
 * ASSIGNED, so every reader of the sun takes the same one. `render/sun-light-rule.ts`.
 */
export const SUN_LIGHT_RULE: SunLightRule = sunLightRuleFrom(params.get('sunlight'))
export const ORBIT: OrbitView = VIEWS[view] ?? (VIEWS.wide as OrbitView)

/**
 * `?view=chase` — a third-person camera locked to one of the AI racers.
 *
 * Matt: *"add a 3rd person debug cam to the ai racers plz."*
 *
 * `?chase=fast` (the default), `?chase=steady`, or `?chase=player` to sit
 * behind your own ship instead. The opposition is the hardest thing in this
 * game to look at: it is in front of you when it is winning and behind you when
 * it is not, and either way you are flying. Four screenshot runs went on
 * guessing where a racer was before this existed.
 *
 * The offset is `right,up,back` in the SHIP's frame, metres —
 * `?chaseOffset=12,10,30` overrides it. Back and up so the engine trail reads,
 * to the side so it is not foreshortened into a dot.
 *
 * The camera's own roll is NOT taken from the ship. A racer banks to 0.8 rad
 * through a gate and a rigidly-parented camera rolls with it, which is
 * unwatchable; this keeps world up and only follows position and heading.
 */
export const CHASE_TARGET = view === 'chase' ? (params.get('chase') ?? 'fast') : null
export const CHASE_OFFSET = parseTriple(params.get('chaseOffset')) ?? [12, 10, 30]
/** How far ahead of the ship the camera looks, metres. */
export const CHASE_LEAD = 25

/**
 * `?camera=third` — boot with CHANGE VIEW already pressed (DEV-128).
 *
 * A development switch for the specs and the screenshots, like `?autopilot=1`.
 * The PLAYER's choice is `settings.cameraView`, persisted the way 2016's
 * `PlayerPrefs["PlayerCameraPref"]` was; this only decides the first frame of
 * one load and writes nothing back.
 */
export const CAMERA_AT_BOOT = params.get('camera') === 'third'

/**
 * A FIXED camera, for screenshots of a specific thing.
 *
 * `?view=cam&cam=water-glint`, or `?view=cam&eye=x,y,z&look=x,y,z`. The orbit
 * views cannot be aimed, and half of one session went on not being able to point
 * at the sea's specular — which is only visible looking toward a sun four
 * degrees above the horizon. See `boot/viewpoints.ts`.
 */
export const VIEWPOINT = resolveViewpoint(params)

/**
 * The mission this build shows. `int_01_hoverJet` is the vertical slice
 * (PORT_PLAN §3): HoverJet, Ring Attack, Simonet Islands.
 *
 * `?mission=<id>` picks another of the thirteen. It is a DEVELOPMENT switch,
 * not the level select — the hangar's holotable is where a player chooses, and
 * it shows one mission today. This exists because the id was a hard-coded
 * literal, which meant the other twelve courses were extracted, validated,
 * schema-checked, carried in git and **impossible to look at**. A level you
 * cannot load is a level nobody has checked.
 *
 * An unknown id throws from `loadLevel` with the full list, which is the
 * behaviour that file was written for.
 */
export const MISSION = params.get('mission') ?? 'int_01_hoverJet'

/**
 * `?mode=<id>` — the MODE SELECT, as a development switch. DEV-144.
 *
 * `runningMode(level, requested)` has taken a request since it was written and
 * has never been given one: `Level.ReadGameMode()` reads the player's choice
 * unless the scene forces one, and this port has had no place for the player to
 * choose. This is that place, in the same class as `?mission=` — a dev switch
 * ahead of a menu, not a substitute for one.
 *
 * A level's own forcing still wins, which is `runningMode`'s rule and not this
 * one's: `hoverJet_kauai_beg` is locked to Free Flight and stays locked.
 *
 * An unknown id is ignored with a console line rather than being fatal — same
 * posture as `?edition=`, and a typo in a URL should not be a black page.
 */
export const MODE_PARAM: GameMode | null = ((): GameMode | null => {
  const raw = params.get('mode')
  if (!raw) return null
  // The keys of `MODES`, so a fifth mode needs no edit here — the list this
  // validates against is the mode table itself.
  if (Object.hasOwn(MODES, raw)) return raw as GameMode
  console.warn(`?mode=${raw} is not a mode. Known: ${Object.keys(MODES).join(', ')}`)
  return null
})()

/**
 * `?edition=classic|anniversary` — the preset for THIS load, never written back.
 *
 * The stored setting is the player's (`boot/settings.ts`); this is the
 * development switch beside it, so a screenshot spec or an A/B run can pin a
 * preset without touching what the player chose. An unknown id is ignored
 * rather than fatal, with a line in the console: a typo in a URL should not be
 * a black page. docs/plan/ANNIVERSARY.md §0.
 */
/**
 * The edition every MENU wears, whatever the player chose: the title, the
 * hangar and its steps, the room lobby and the loading scene. DEV-405 made it
 * the title's (Matt, 2026-09-26: *"the latest visual upgrades by default"*);
 * DEV-451 made it every menu's (Matt, 2026-09-27: *"our menus should only
 * ever be anniversary"*). The chosen edition is worn inside a mission only.
 */
export const MENU_EDITION: EditionId = 'anniversary'

export const EDITION_PARAM: EditionId | null = ((): EditionId | null => {
  const raw = params.get('edition')
  if (raw === null) return null
  if ((EDITION_IDS as readonly string[]).includes(raw)) return raw as EditionId
  console.warn(`?edition=${raw} is not one of ${EDITION_IDS.join(', ')}; ignored`)
  return null
})()

/**
 * `?rules=classic` — 2016's RULES for this load: a development switch, like
 * `?opponents=ghosts`, and never a player's choice. DEV-452 (D35).
 *
 * Matt, 2026-09-27: the Classic/Anniversary split is *"just for the in-mission
 * visuals"*, so every run flies Anniversary's rules and `?edition=` (and the
 * Edition page) pick only the look. `classic.json`'s rules stay in the tree as
 * the fidelity reference the tests fly — 2016's two racers, no energy, no
 * crash, no prop collision — and this is the one way to reach them. Unknown
 * ids are ignored with a line in the console, as `?edition=`'s are.
 */
export const RULES_PARAM: EditionId | null = ((): EditionId | null => {
  const raw = params.get('rules')
  if (raw === null) return null
  if ((EDITION_IDS as readonly string[]).includes(raw)) return raw as EditionId
  console.warn(`?rules=${raw} is not one of ${EDITION_IDS.join(', ')}; ignored`)
  return null
})()

/** The rules every run on this page flies (DEV-452, D35): Anniversary's. */
export const RULES_EDITION: EditionId = RULES_PARAM ?? MENU_EDITION

/**
 * `?vrLookTier=0`: AUTO's headset tier does NOT follow the look. DEV-931.
 *
 * On by default: a headset on AUTO wearing Anniversary gets `low`'s 1512 px
 * eye (`VR_AUTO_QUALITY_ANNIVERSARY`, `boot/settings.ts`). This pin is the OFF
 * arm of the worn A/B, the headset back at `medium`'s 1620 px, in the same
 * build. Never stored, never a harness switch: the game supports both answers.
 */
export const VR_LOOK_TIER: boolean = params.get('vrLookTier') !== '0'

/**
 * `?shaftPaint=hangar|2016` — the elevator shaft's paint, a development A/B
 * (DEV-456, `render/shaft-paint.ts`). Set once, before any room loads; never
 * stored. Absent, the shipped paint: the hangar's colours up the shaft.
 */
setShaftPaint(shaftPaintParam(params.get('shaftPaint')) ?? SHAFT_PAINT_SHIPPED)

/**
 * `?variant=<id>` — the AIRCRAFT VARIANT, as a development switch. DEV-380.
 *
 * The same class as `?mission=` and `?mode=`: a switch ahead of the hangar's
 * variant step (DEV-382), never written back. It names a variant of whichever
 * aircraft the mission flies, resolved against that aircraft's own
 * `content/aircraft/<vehicle>.json` and the LIVE edition at the moment the
 * flight is built — so an edition flipped mid-run applies at the next board.
 *
 * Never fatal, same posture as `?edition=`: an id the aircraft does not have
 * flies `standard` with a console line naming the ones it does, and on Classic
 * (`gameplay.variants.enabled` false) every request flies `standard` with a
 * line saying so. `content/aircraft-schema.ts`'s `resolveVariantIn` is the
 * rule; this only reads the URL and prints the note.
 */
export const VARIANT_PARAM: string | null = params.get('variant')

/**
 * The variant each aircraft was BOARDED in from the hangar, this page's life
 * (DEV-382). The flight is built from it ahead of `?variant=` and the store:
 * `?variant=` is a pin for the boot, as `?mission=` is, and the hangar changes
 * both. Held here as well as stored because the store can throw (a private
 * window), and the choice must still fly.
 */
export const boardedVariant = new Map<VehicleId, string>()

/**
 * The variant `vehicle` last flew: this load's board, else the remembered one
 * (`ff2.variant.v1`), validated against `known` — or null when it has flown
 * none, which is not the same as `standard`: the hangar's LAST FLOWN label
 * marks a flight, and a first visit has had none. What that label and Quick
 * Race (Matt: *"your last HoverJet choice"*) read; null flies `standard`.
 */
export const lastVariantOf = (vehicle: VehicleId, known: readonly string[]): string | null => {
  const boarded = boardedVariant.get(vehicle)
  return boarded !== undefined && known.includes(boarded)
    ? boarded
    : rememberedVariant(vehicle, known)
}

export const flightVariantFor = (vehicle: VehicleId, edition: VariantsEdition): ResolvedVariant => {
  // Classic: 2016's machine whatever was boarded or stored (AIRCRAFT-VARIANTS
  // §8). Only the URL pin is worth a line, as DEV-380 wrote it.
  if (!edition.gameplay.variants.enabled) {
    const variant = resolveVariant(vehicle, VARIANT_PARAM, edition)
    if (variant.note) console.warn(`?variant=: ${variant.note}`)
    return variant
  }
  const known = aircraftFor(vehicle).variants.map((v) => v.id)
  // A remembered choice counts only among the variants the hangar OFFERS: one
  // marked not ready to ship (`listed: false`, the jumping spider) flies
  // `standard` for a player who picked it before. The pin still reaches it.
  const offered = listedVariants(aircraftFor(vehicle)).map((v) => v.id)
  // The pin, then the hangar's board, then the last flown (DEV-382 follow-up):
  // `game/variant-choice.ts`'s `flightVariantRequest` is the precedence.
  const request = flightVariantRequest(
    VARIANT_PARAM,
    known,
    boardedVariant.get(vehicle),
    rememberedVariant(vehicle, offered),
  )
  if (VARIANT_PARAM !== null && request.source !== 'pin') {
    console.warn(
      `?variant=: the ${vehicle} has no variant "${VARIANT_PARAM}"; flying the ${request.source === 'none' ? 'standard' : request.source} one. Known: ${known.join(', ')}`,
    )
  }
  const variant = resolveVariant(vehicle, request.id, edition)
  if (variant.note) console.warn(`${request.source}: ${variant.note}`)
  return variant
}

/** Does `?variant=` pin this aircraft's flights this load? Then nothing is remembered. */
export const variantPinned = (vehicle: VehicleId): boolean =>
  VARIANT_PARAM !== null && aircraftFor(vehicle).variants.some((v) => v.id === VARIANT_PARAM)

/**
 * `?quality=low|medium|high` and `?adaptive=0|1` — pinned for THIS load.
 *
 * `EDITION_PARAM`'s shape exactly, and for the same reason: the stored settings
 * are the player's and a development switch must never write to them. What they
 * are FOR is `docs/testing/perf-protocol.md` §3 — a GPU number read while the
 * adaptive controller is walking the pixel count around is a number about the
 * controller, so a baseline row is taken with `?adaptive=0` and says which
 * preset it was taken at. See `boot/quality-pin.ts` for the pin's whole
 * contract, including the one place it deliberately differs from `?edition=`.
 */
export const QUALITY_PINS: QualityPins = Object.freeze({
  quality: parseQualityPin(params.get('quality'), (m) => console.warn(m)),
  adaptive: parseAdaptivePin(params.get('adaptive'), (m) => console.warn(m)),
  msaa: parseMsaaPin(params.get('aa'), (m) => console.warn(m)),
  hz: parseHzPin(params.get('hz'), (m) => console.warn(m)),
})

/**
 * `?perf=1` builds the frame-time overlay. Backquote hides and shows it.
 *
 * A development switch like `?lookdev=1`, and the same shape: DOM rather than
 * scene, so flat-screen only; nothing persisted; absent by default. What it is
 * FOR is ANNIVERSARY.md §7 — p95 frame time is the gate on the four visual
 * proposals with a budget risk, and until now the port had adaptive resolution
 * quietly protecting the frame and no way to see what it was protecting it from.
 * See `boot/perf-hud.ts`.
 */
export const PERF_HUD = params.has('perf') && params.get('perf') !== '0'

/**
 * `?trace=<seconds>` records every frame of the flight and stores the result.
 *
 * VR-PERF §5.6 (DEV-160), gap 6 — the port has no soak and no heap-growth
 * check, and on a headset there is no devtools to watch one in. The workflow
 * this switch exists for, and the reason it stores rather than prints:
 *
 *     /?perf=1&autopilot=1&mission=int_01_hoverJet&trace=120
 *
 * open it, Enter VR, fly it (or let the autopilot), TAKE THE HEADSET OFF, then
 * read `__ff2perf.trace.last()` or `.download()` on the desktop. Nothing about
 * the run is different — the trace is an observer, and `?perf=1` may add
 * instrumentation but never changes the build.
 *
 * Without `autopilot=1` the same URL records a human-flown soak, which is the
 * one that finds the hitches a deterministic line through the course never
 * reaches. See `boot/perf-trace.ts`.
 */
export const TRACE_SECONDS = parseTraceSeconds(params.get('trace'))

/**
 * How long a trace keeps recording after the run is over, ms. DEV-177.
 *
 * The hook used to stop ON the run-over frame, which meant the interval AFTER
 * a run-over was never in a trace — and that interval is the worst stall this
 * build has produced: **2.8 s between frame callbacks** on the worn session,
 * outside `frame()` entirely, with `frame()` itself reading 7 ms and the GPU
 * 5 ms (DEV-160 §3). The one event most worth a trace was the one event that
 * ended the trace.
 *
 * Five seconds because the stall is under three and the results screen settles
 * inside five; the trace's own window still wins if it elapses first, so
 * `?trace=<s>` never records longer than it was asked for.
 */
export const TRACE_RUN_OVER_TAIL_MS = 5000

/**
 * How often the in-headset plate may redraw, ms. VR-PERF §5.5: "≤ 4 Hz, no
 * canvas upload per frame". A measurement constant in boot/, named rather
 * than a literal at the call site.
 */
export const PLATE_INTERVAL_MS = 250

/**
 * How long the mission's warm-up waits for 2016's launch rig to land, ms
 * (DEV-438). It began loading with the room several seconds earlier, so this
 * is a bound for a slow R2 and not a delay anybody waits out: past it the
 * generated rig rides, which is the rig the game shipped before the row.
 */
export const LAUNCH_RIG_2016_WAIT_MS = 10_000

/**
 * ── What `?mission=` immediately turned up, 2026-09-11 ────────────────────
 *
 * **The terrain below is hard-coded to Simonet and does not read
 * `level.environment`.** So a mission in another environment does not fail —
 * it loads, renders Simonet Islands, and puts 2016's own briefing copy over
 * it. `hoverJet_kauai_beg` comes up captioned "KAUAI - FREE FLIGHT" above a
 * Simonet hillside and looks, at a glance, like a working second course.
 *
 * That is the exact shape CLAUDE.md warns about for the two
 * `islandgroup_height.png` files: **almost right is the most expensive kind of
 * wrong**, and it is only visible if you ask which terrain key was requested
 * rather than whether the screen came up. Probed across all thirteen missions,
 * five reported `data-terrain-ready` and every one of them was Simonet.
 *
 * Driving `loadTerrain` from `level.environment` is the first real step of the
 * remaining-tracks work; it is deliberately NOT done in the same commit as
 * this switch, because this switch is what makes the bug observable and the
 * two want separate before/after evidence.
 */

/**
 * `?submit=flush` or `?submit=reorder`; absent or `off` is today's frame.
 * DEV-971, the submit-early A/B. A MEASUREMENT pin, OFF by default, and no arm
 * becomes the default without a quiet-box table
 * (`docs/plan/eval-wave/eval-frame-trace.md`).
 *
 * three records WebGL calls into Chrome's command buffer, and the renderer
 * process hands that buffer to the GPU process only when it fills, when a task
 * ends, or when something flushes it. The draw is the frame's last big
 * submission and the perf recorder runs after it, so the GPU can sit idle for
 * the tail of our JS.
 *
 *   `flush`    `gl.flush()` right after the render phase's draw.
 *   `reorder`  that, plus `phaseAudio`'s work (the listener, the music filter,
 *              the racers' engines, the overtake cue) moved to after the flush.
 *              The HUD repaint is NOT moved: its canvas is uploaded inside the
 *              draw, so running it after would show last frame's HUD, which is
 *              a latency change and not a reorder. The perf recording already
 *              runs after the draw.
 *
 * Read once at load, like every pin here. Printed only when set.
 */
export const SUBMIT_PIN: SubmitPin = (() => {
  const pin = parseSubmitPin(params.get('submit'), (m) => console.warn(`submit: ${m}`))
  if (pin !== 'off') console.info(`submit: ${pin} (DEV-971)`)
  return pin
})()
