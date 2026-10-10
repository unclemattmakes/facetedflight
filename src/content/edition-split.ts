// src/content/edition-split.ts — Classic is a LOOK: which half of a preset a
// player's choice decides, and which half is always Anniversary's. DEV-452, D35.
//
// Matt, 2026-09-27: *"i'd prefer if the classic vs anniversary split was just
// for the in-mission visuals. otherwise serve players the latest and greatest
// in the menus."* Offered the two readings, he chose VISUALS ONLY. So a
// mission flies Anniversary's rules whatever was chosen, and the choice
// changes what the mission LOOKS like.
//
// ── One place, and every reader unchanged ─────────────────────────────────
//
// A preset is one object with one shape (`Edition`), read by a hundred
// features through `editionState.current`. Rather than teach each of them
// which preset to read, the edition state COMPOSES one: the chosen preset's
// look keys laid over the rules preset, here, and every reader goes on
// reading `current` as before. `lookOnRules` is that composition and
// `EDITION_KEY_CLASS` is its whole policy, one row per key, two levels deep.
// `tests/unit/edition-split.test.ts` refuses a key in either preset that has
// no row, and a row naming a key neither preset has, so a new key cannot ship
// without somebody deciding which side of D35 it is on.
//
// ── What decides a row ────────────────────────────────────────────────────
//
// `rules` is anything that changes what a lap IS: what scores, what is solid,
// who races, what the ship can do. It is also the whole of `gameplay`, which
// is exactly the block the lap server hashes into a board's rules
// (`net/lap-courses-build.ts`), so a Classic-look lap lands on Anniversary's
// board by construction and can never split one or restart one. `look` is
// what a mission draws and nothing else. Sound is neither, and it is on the
// Anniversary side, which is D35's "otherwise the latest and greatest"; the
// row says so, and DEV-452 brings it back as a call.
//
// `id`, `title` and `note` are the LOOK's: the composed preset names the look
// it wears, which is what every lookdev label and perf trace means by "the
// edition". The rules preset's own identity is `editionState.rules`, and the
// laps, the boards and the rooms read that.

import type { Edition } from '@/content/edition-schema'

export type EditionKeyClass = 'look' | 'rules'

export interface EditionKeyRow {
  readonly class: EditionKeyClass
  /** Why, in a line: the row a reader argues with. */
  readonly why: string
}

const look = (why: string): EditionKeyRow => ({ class: 'look', why })
const rules = (why: string): EditionKeyRow => ({ class: 'rules', why })

/**
 * Every key of a preset, `block.key`, and which side of D35 it is on. Blocks
 * whose rows all agree are taken whole from that side.
 */
export const EDITION_KEY_CLASS: Readonly<Record<string, EditionKeyRow>> = {
  // ── render: the picture ────────────────────────────────────────────────
  'render.toneMapping': look('the tone curve'),
  'render.exposure': look('the exposure'),
  'render.haze': look('aerial perspective'),
  'render.illustrative': look('the diffuse warp on the land'),
  'render.shadows': look('cast shadows'),
  'render.shipShadow': look('the ship’s own shadow'),
  'render.cockpitShadow': look('the cockpit’s shadow'),
  'render.cockpitSelfShadow': look('the cockpit shadowing itself'),
  'render.nearShadow': look('sharp shadows round the eye (DEV-582)'),
  'render.smoothSky': look('the sky’s gradient'),
  'render.sunHeight': look('where the sun is DRAWN; the level carries the light'),
  'render.cloudShadow': look('the clouds’ shadows (DEV-585)'),
  'render.canopyShade': look('the canopy’s shading'),
  'render.skyVisibility': look('sky light on the terrain'),
  'render.horizonGeo': look('the far horizon'),
  'render.coast': look('the coastline'),
  'render.seaReflection': look('the islands in the sea, flat ultra only (DEV-583)'),
  'render.flatFov': look('the flat screen’s field of view'),
  'render.clouds': look('the clouds'),
  'render.bloom': look('bloom'),
  'render.thirdPerson': look('the chase camera'),
  'render.racerLivery': look('what the racers wear, not who races'),
  'render.sceneTint': look('a colour filter over the picture (DEV-446)'),
  // ── fx: effects, all drawn ─────────────────────────────────────────────
  'fx.speedLines': look('streaks'),
  'fx.speedRamp': look('the streaks’ ramp'),
  'fx.wingTrails': look('wing-tip trails'),
  'fx.motes': look('near-field air'),
  'fx.ringBurst': look('a gate’s burst'),
  'fx.gatePulse': look('a gate’s screen pulse'),
  'fx.waterSpray': look('spray'),
  // DEV-613: a look. Nothing a splash does reaches the sim, and 2016 threw none,
  // so a Classic-look crash into the sea goes in without one.
  'fx.splash': look('a splash where anything crosses the sea'),
  // DEV-464: on the RULES side, where the strike is. It is not a broken prop's
  // facets (those are the fracture, which the colliders already bring on both
  // looks); it is the only thing a STANDING strike draws. As a look, Classic
  // kept Anniversary's standing tree and drew nothing as the ship went through.
  'fx.propBurst': rules('what a standing strike draws: it goes where the strike goes'),
  // ── cockpit: the seat you look out of ──────────────────────────────────
  'cockpit.shake': look('camera shake'),
  'cockpit.lighting': look('the cockpit’s light'),
  'cockpit.body': look('the cockpit’s art'),
  'cockpit.placement': look('where the panels hang'),
  // ── audio: not a visual, so on the Anniversary side (a call) ───────────
  'audio.speedCurves': rules('sound is not a visual: D35’s "otherwise the latest"'),
  'audio.engine': rules('sound is not a visual: D35’s "otherwise the latest"'),
  'audio.lift': rules('sound is not a visual: D35’s "otherwise the latest"'),
  // ── terrain: drawn; the collision surface is the sim's ─────────────────
  'terrain.ocean': look('the sea’s mesh and motion'),
  'terrain.oceanRings': look('the sea’s mesh; the sim collides with the height field'),
  'terrain.detailRing': look('drawn detail near the eye; the sim collides with the height field'),
  'terrain.lodFade': look('the LOD fade'),
  'terrain.diagonalFix': look('the terrain diagonal'),
  'terrain.bakedLight': look('baked light'),
  'terrain.surfaceGloss': look('gloss'),
  // ── hud: what the panel draws (a call: two of them help you race) ──────
  'hud.speedUnit': look('the unit on the panel'),
  'hud.nextGateArrow': look('a drawn aid; the gates are the same'),
  'hud.raceMap': look('a drawn aid; the field is the same'),
  'hud.bars': look('two bars on the panel; the combo and the tank are the same'),
  // ── props: what STANDS is rules (it is solid), how it is drawn is look ─
  'props.enabled': rules('whether the scatter exists: gameplay.propCollision makes it solid'),
  'props.seed': rules('where each prop stands'),
  'props.clearance': rules('where each prop stands'),
  'props.variants': rules('which prop, and so its collider'),
  'props.scale': rules('how big, and so its collider'),
  'props.groundSnap': rules('the height each prop stands at'),
  'props.maxSlope': rules('which slopes are planted'),
  'props.scatter': rules('what is planted'),
  'props.unbakedPasses': rules('which passes are planted'),
  'props.scatterShadows': look('whether the scatter casts'),
  'props.meshLod': look('the far meshes; the collider is the near one’s'),
  'props.birds': look('flocks, which nothing hits'),
  // ── gates, boundary, menu: drawn ───────────────────────────────────────
  'gates.passedFade': look('how a passed gate leaves'),
  'gates.finishBanner': look('the finish, marked'),
  'boundary.fuzz': look('the out-of-bounds static; the boundary is the level’s'),
  'life.boats': look('boats at their moorings: not an obstacle, not a collider (DEV-447)'),
  'life.dolphins': look('leaps on their own clock: nothing hits them, nothing scores (DEV-449)'),
  'menu.holoTerrainColours': look('the room’s tables: read in the menus, which wear Anniversary'),
  'menu.medalOutline': look('the room’s medals: read in the menus, which wear Anniversary'),
  // ── gameplay: the block a board is hashed from ─────────────────────────
  'gameplay.proximity': rules('scoring'),
  'gameplay.gateEvents': rules('scoring'),
  'gameplay.chainMeter': rules('scoring'),
  'gameplay.gateBullseye': rules('lives in the hashed block (a call: it is drawn)'),
  'gameplay.racers': rules('who races, where they start, what they do'),
  'gameplay.crash': rules('what a crash is'),
  'gameplay.propCollision': rules('what is solid'),
  'gameplay.energy': rules('boost'),
  'gameplay.energyRace': rules('the race tank'),
  'gameplay.ambientTraffic': rules('lives in the hashed block (a call: nothing hits it)'),
  'gameplay.variants': rules('which aircraft you may fly'),
  'gameplay.glider': rules('which aircraft you may fly'),
  'gameplay.rooms': rules('who you race'),
  'gameplay.editor': rules('what the menus offer (they wear Anniversary, D35)'),
  'gameplay.tv': rules('what the menus offer (they wear Anniversary, D35)'),
}

/** The row for `path`, or null. A key with no row is RULES at runtime (see the file header). */
export const editionKeyClass = (path: string): EditionKeyClass =>
  EDITION_KEY_CLASS[path]?.class ?? 'rules'

/** The blocks of a preset that carry keys (everything but its name and note). */
/**
 * The blocks, read off the rows rather than listed: a block the table names is
 * a block the composition handles, so a new one (DEV-447 added `life` the same
 * afternoon) cannot be classified and then silently taken from the rules.
 */
const BLOCKS: readonly string[] = [
  ...new Set(Object.keys(EDITION_KEY_CLASS).map((path) => path.split('.')[0] as string)),
]

type Block = string

/** Does every row in `block` come from one side? Then the block is taken whole. */
const wholeBlock = (block: Block): EditionKeyClass | null => {
  const classes = new Set(
    Object.entries(EDITION_KEY_CLASS)
      .filter(([path]) => path.startsWith(`${block}.`))
      .map(([, row]) => row.class),
  )
  return classes.size === 1 ? ([...classes][0] as EditionKeyClass) : null
}

const WHOLE: Readonly<Record<Block, EditionKeyClass | null>> = Object.fromEntries(
  BLOCKS.map((b) => [b, wholeBlock(b)]),
) as Record<Block, EditionKeyClass | null>

const mergeBlock = (
  block: Block,
  lookBlock: object | undefined,
  rulesBlock: object | undefined,
): object => {
  const out: Record<string, unknown> = { ...(rulesBlock as Record<string, unknown> | undefined) }
  // A test's partial preset may carry no block at all; a validated one always does.
  for (const [k, v] of Object.entries((lookBlock ?? {}) as Record<string, unknown>)) {
    if (k !== 'note' && editionKeyClass(`${block}.${k}`) === 'look') out[k] = v
  }
  return out
}

/** A VR path's side: its row, or its block's row for a deeper path. */
const vrPathClass = (path: string): EditionKeyClass => {
  const [block, key] = path.split('.')
  return editionKeyClass(`${block}.${key}`)
}

/**
 * The preset a mission wears: `look`'s look keys over `rules`. Identity when
 * the two are the same preset, so a page on one preset composes nothing and
 * every identity comparison downstream (`setImmersive`, the feature mask)
 * sees the object it always saw.
 *
 * The VR list is composed by the same rows: the look's entries for look
 * paths, the rules preset's for rules paths, so a headset turns off the same
 * rules for everyone and the look's own choices for its look.
 */
export const lookOnRules = (look: Edition, rules: Edition): Edition => {
  if (look === rules) return look
  const out: Record<string, unknown> = {
    ...(rules as unknown as Record<string, unknown>),
    id: look.id,
    title: look.title,
    note: look.note,
  }
  for (const block of BLOCKS) {
    const whole = WHOLE[block]
    const l = (look as unknown as Record<string, object | undefined>)[block]
    const r = (rules as unknown as Record<string, object | undefined>)[block]
    out[block] = whole === 'look' ? l : whole === 'rules' ? r : mergeBlock(block, l, r)
  }
  const disable = [
    ...(look.vr?.disable ?? []).filter((p) => vrPathClass(p) === 'look'),
    ...(rules.vr?.disable ?? []).filter((p) => vrPathClass(p) === 'rules'),
  ]
  if (disable.length > 0) out.vr = { ...(look.vr ?? rules.vr), disable }
  else delete out.vr
  return out as unknown as Edition
}
