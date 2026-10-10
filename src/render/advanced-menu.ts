// src/render/advanced-menu.ts — the per-feature toggles, and the bisect they exist for.
//
// DEV-269. Matt, 2026-09-21: *"instead of a URL toggle - add these as toggles
// to pause menu under advanced quality settings or something. if something
// won't take effect until restarting, let me know."*
//
// ── Why the page exists ──────────────────────────────────────────────────
//
// The first worn A/B this project has taken put Classic at 96.9 % of frames at
// 90 Hz and Anniversary at 75.0 %, same mission, same 1512 px eye, same minute.
// DEV-263 turns five features off in VR and closes part of that gap; what is
// left is spread across shadows, props, bloom and the detail ring, and finding
// WHICH means flying the same course with one thing moved at a time.
//
// Done from a URL that is nine rebuilds and nine headset sessions. Done from
// here it is one session, because the whole point is that these land LIVE.
//
// ── Every row says when it lands, and that is not decoration ─────────────
//
// Matt hit the failure this prevents on 2026-09-21: he moved QUALITY to `low`
// mid-flight to see whether it helped, and it did nothing at all —
// `setFramebufferScaleFactor` is read when three builds the XR layer and is
// refused once presenting, so the eye buffer stayed at 2160 px and `vp_w`
// never moved. The menu accepted the press, the setting persisted, and the
// experiment silently never ran. **A control that appears to work and does not
// is worse than no control**, so a row that cannot land now says so on itself.
// `comfort-menu.ts`'s QUALITY row set that precedent ("resolution — the next
// session; edges, the next load"); this page follows it.
//
// Everything on THIS page is live. The two that are not — MSAA (a WebGL
// context attribute, so the next load) and resolution (the next session) —
// are deliberately NOT here: they already have a row on the comfort page that
// says when they land, and duplicating them here would be a second place to
// press for the same deferred effect.
//
// ── Why seven rows, and why the page is behind `?perf=1` ─────────────────
//
// `ROWS_MAX_M` is fixed, so rows do not make a page taller — they make each
// other shorter. Eight rows are 4.00° each at the panel's distance and that is
// already the comfort page's height; ten would be 3.20°, under what a head can
// hold. So the list below is SEVEN toggles plus BACK, and `ADVANCED_FEATURES`
// is the one constant to edit when the bisect wants a different seven.
//
// The same arithmetic decides where the row that OPENS this page lives. Two
// rows arrived on the ROOT plate the same morning — this one and DEV-270's
// EXIT VR — and together they would have taken a player in a headset from 7
// rows at 4.57° to 9 at **3.55°**. Only one of them is for players: EXIT VR is
// a way out of a session anybody can get stuck in, and this is an instrument
// for bisecting a frame. So `ADVANCED_OPTION` is a DEV row under `?perf=1`,
// like PERF CAPTURE, which costs nothing real — hunting frames means loading
// with the perf plate anyway.
//
// Clouds and terrain fade are the two features left off, and both on purpose:
// Matt cannot see the clouds from the cockpit (*"i don't see them anyways"*)
// and wants the fade off generally rather than as an experiment. Neither is a
// question worth a row while the plate is this tight.
//
// ── DEV-838: the page is for players now ─────────────────────────────────
//
// Matt, 2026-10-08: players get too many options in a wall of text. The row
// that opens this page left `?perf=1` and sits on OPTIONS for everyone, and
// the comfort page gave up Auto quality and Foveation to it (SETTING_ROWS).
// The page is TEN rows now, 3.2 degrees each in a headset, below the 4.00 the
// paragraphs above argued for; that is a call for Matt (docs/QUESTIONS-FOR-MATT.md).
//
// ── DEV-302 / DEV-303: the page did not keep its own promise ─────────────
//
// Found by reading this file line by line to write DEV-269's missing ledger
// row, and every one of them is the header above arriving at the file that
// wrote it — *"a control that appears to work and does not is worse than no
// control"*, four times, on the instrument NEXT.md's action 1 uses to find
// where Anniversary's frame goes.
//
//  * **The PROPS row could not remove the trees, and its note named them.**
//    Its path is `props`; `props.enabled` was read by
//    `game/props/load-dressing.ts` and by nothing else, so pressing it moved
//    the generated dressing — 3 draw calls, 87,448 triangles of rocks and
//    shrubs — and left the 2016 baked scatter, which is **7.42 M triangles
//    and 88–93 % of desert's and alpine's world pass**, untouched. The note
//    read *"trees, rocks and birds — 1.2 M triangles of them"*. Press it,
//    watch the frame time not move, conclude props are not the cost. DEV-303.
//  * **Three rows showed the REQUEST rather than the renderer**, which
//    `effectiveState` below has in full: shadows and the detail ring are both
//    off at quality `low`, and bloom has never composited in a headset.
//
// The shape they share is worth more than the three fixes: a row whose state
// is read through the SAME function the renderer calls cannot drift this way,
// and a row that echoes the flag always can. `effective` is that, and it is
// composed from `shadowsEnabled` and `detailRingFor` rather than copied.

import type { ComfortSettings } from '@/boot/settings'
import { type Edition, editionFeatures } from '@/content/edition-schema'
import { detailRingFor } from '@/game/terrain/detail-ring'
import type { PauseOption } from '@/render/pause'
import { createSettingsPage, type SettingsPage } from '@/render/settings-page'
import { shadowsEnabled } from '@/render/shadows'

/** What the caller still has to do. Only one thing, and it is leaving. */
export type AdvancedAction = 'none' | 'back'

/** The label the ROOT pause menu uses for the row that opens this page. */
export const ADVANCED_OPTION: PauseOption = {
  id: 'advanced',
  // DEV-859: the label is EFFECTS (it is a list of effects with a cost each) and
  // the page hangs off MORE. The id, the file and the settings keep the old name.
  label: 'Effects',
  note: 'auto quality, foveation, and each effect on or off',
}

/**
 * DEV-838: the two settings that moved here from the comfort page. Matt,
 * 2026-10-08: players get too many options in a wall of text. Auto quality and
 * foveation are for somebody tuning a frame, not for a first visit, so they sit
 * at the TOP of this page and the comfort page keeps what a player needs
 * (vignette, horizon, volume, quality, recentre). They are not
 * `ADVANCED_FEATURES`: those are `editionFeatures()` keys, these are two
 * fields of `ComfortSettings`, so they have their own tiny table.
 */
const SETTING_ROWS = [
  {
    id: 'adaptive',
    label: 'Auto quality',
    note: 'drop resolution before dropping frames',
    field: 'adaptiveResolution',
  },
  {
    id: 'foveation',
    label: 'Foveation',
    note: 'sharper edges, or a cheaper frame',
    field: 'foveation',
  },
] as const satisfies readonly {
  readonly id: string
  readonly label: string
  readonly note: string
  readonly field: 'adaptiveResolution' | 'foveation'
}[]

export const ADVANCED_TITLE = '- EFFECTS -'

/**
 * What the renderer is DOING, for a row whose flag is not the whole story.
 *
 * DEV-302. See the block comment above `effectiveState`.
 */
export interface AdvancedContext {
  /** The live comfort settings. `quality` is the one that gates two rows. */
  readonly settings: ComfortSettings
  /** Is a headset presenting right now? `EditionState.immersive`. */
  readonly presenting: boolean
}

/**
 * One row each. `path` is an `editionFeatures()` key — the same registry
 * `vr.disable` and `?feature=` are checked against, so there is one spelling of
 * what a feature IS.
 *
 * `note` says what the thing COSTS rather than what it is, because the reason
 * to open this page is to find frames. "Shadows" tells a player nothing; "the
 * sun's depth pass and the cockpit's" tells them why it is on the list. And it
 * says it for the surface they are ON: Bloom's used to read "a full-screen
 * pass over both eyes", which Matt read as a promise it was running in his
 * headset, where it never had (DEV-336).
 */
export interface AdvancedFeature {
  readonly id: string
  readonly path: string
  readonly label: string
  readonly note: string
  /**
   * What the RENDERER is doing, when something downstream of the flag can
   * disagree with it. Omitted means the flag is the whole story.
   *
   * Composed from the real decider wherever there is one — `shadowsEnabled`
   * and `detailRingFor` are the functions the renderer itself calls, so this
   * is a second CALL and not a second copy of the rule. Bloom's arm is the
   * flag itself since DEV-336: the post pass still refuses while presenting,
   * but the halos take its place there, and `advanced-menu.test.ts` reads
   * `render/bloom.ts` as text to pin the refusal the halos exist for.
   */
  readonly effective?: (live: Edition, ctx: AdvancedContext) => boolean
  /**
   * Why the row is not what the flag says, when it is not. Replaces `note`.
   *
   * *"A row that cannot land now says so on itself"* — this file's own header,
   * about the QUALITY row that accepted a press and did nothing. The same rule
   * one level along: a row that is being FORCED says what is forcing it.
   */
  readonly forcedNote?: (live: Edition, ctx: AdvancedContext) => string
}

export const ADVANCED_FEATURES: readonly AdvancedFeature[] = [
  {
    id: 'shadows',
    path: 'render.shadows',
    label: 'Shadows',
    // DEV-323: the cockpit's near map rides on this row rather than an eighth
    // one — `cockpitSelfShadowEnabled` composes `shadowsEnabled`, so pressing
    // this takes both passes out, and the note says so because a bisect that
    // did not know would price the near map as part of the sun's.
    note: "the sun's depth pass and the cockpit's; Classic has none",
    effective: (live, ctx) => shadowsEnabled(live, ctx.settings),
    forcedNote: () => 'quality LOW has no shadow map — the preset says on',
  },
  {
    id: 'props',
    path: 'props',
    label: 'Props',
    // DEV-303. This note used to read "trees, rocks and birds — 1.2 M
    // triangles of them", and it named the one class the row could not reach:
    // the row's path is `props`, `props.enabled` was read by
    // `game/props/load-dressing.ts` alone, and the 2016 baked scatter — the
    // actual forest, 7.42 M triangles and 88–93 % of desert's and alpine's
    // world pass — is built by `loadProps`, which never read it.
    //
    // The row reaches both now. What it does NOT reach is the COLLIDERS: they
    // are built once at world build from `gameplay.propCollision`, which is a
    // feature of its own, so a tree you have hidden is still solid. Said here
    // rather than discovered at 200 m/s.
    note: 'trees, rocks and birds — the draws and the fill, not the colliders',
  },
  {
    id: 'bloom',
    path: 'render.bloom',
    label: 'Bloom',
    // DEV-336. The note used to read "a full-screen pass over both eyes", and
    // Matt read it as a promise: *"it actually talks about a bloom in each
    // eye"*. The pass never ran in a headset (`render/bloom.ts` refuses while
    // presenting). Now the flag has an answer on both surfaces, the post pass
    // on a monitor and `render/vr-halo.ts`'s halos in a headset, so the row's
    // state IS the flag and the note names both.
    note: 'a glow pass on a monitor; halos on the gate studs and the sun in a headset',
    // Declared, because `render/bloom.ts` still refuses to composite while
    // presenting and the DEV-302 guard asks every gated row to say how it
    // answers. The answer is now the flag on BOTH surfaces: the pass on a
    // monitor, the halos in a headset (`boot/app.ts`'s DEV-336 block draws
    // them exactly while presenting with `render.bloom.enabled`).
    effective: (live) => live.render.bloom.enabled,
  },
  {
    id: 'detailring',
    path: 'terrain.detailRing',
    label: 'Detail ring',
    note: 'finer ground within 320 m of you',
    effective: (live, ctx) =>
      detailRingFor(live.terrain.detailRing, { quality: ctx.settings.quality, isOcean: false }) !==
      null,
    forcedNote: () => 'quality LOW has no detail ring — the preset says on',
  },
  {
    id: 'gloss',
    path: 'terrain.surfaceGloss',
    label: 'Surface gloss',
    note: 'six per-fragment classes over all the terrain',
  },
  {
    id: 'haze',
    path: 'render.haze',
    label: 'Haze',
    note: 'aerial perspective at distance',
  },
  {
    id: 'illustrative',
    path: 'render.illustrative',
    label: 'Illustrative',
    note: 'the drawn look, over the whole frame',
  },
]

/** Row ids in order, BACK last. Switch on a name, never on an index. */
export const ADVANCED_ROW_IDS: readonly string[] = [
  ...SETTING_ROWS.map((r) => r.id),
  ...ADVANCED_FEATURES.map((f) => f.id),
  'back',
]

/**
 * Is this feature live right now, on the preset as it currently resolves?
 *
 * Read off `editionFeatures(live)` and NOT off `settings.featureOverrides`,
 * which is the whole reason this takes an `Edition`. The override map is what
 * the player ASKED FOR and is usually empty; the edition is what the renderer
 * IS DOING, after the preset, the VR layer and the overrides have composed. A
 * row that showed the request would read "on" for a feature `vr.disable` has
 * turned off — the two disagree exactly in the headset, which is the only place
 * this page matters.
 */
/**
 * Is the 2016 baked scatter (the forest, the palms) drawn? DEV-332.
 *
 * Only an explicit OFF in the override layer hides it: the Props row on this
 * page, or `?feature=props:off`. NOT the preset's `props.enabled`, and that
 * distinction is the bug this fixes. DEV-303 drove the scatter's visibility
 * from `props.enabled` so the row could bisect the forest's cost, but in the
 * PRESETS that flag means the generated DRESSING. Classic ships it false,
 * because 2016 had no dressing, and so from DEV-303 on Classic drew no forest
 * at all. `spawn-clearing.spec.ts` said so (*"classic drew the scatter"*,
 * 0 instances) and was read as an old red.
 *
 * So the scatter is 2016's content and always drawn, and the row can still
 * take it out, because pressing the row writes the override this reads.
 */
export const propScatterVisible = (overrides: Readonly<Record<string, boolean>>): boolean =>
  overrides.props !== false

export const featureIsOn = (live: Edition, path: string): boolean =>
  new Map(editionFeatures(live)).get(path)?.enabled === true

/**
 * What the row SHOWS: the renderer's answer, not the request. DEV-302.
 *
 * ── The bug, which is this file's own thesis arriving at this file ───────
 *
 * `featureIsOn` reads `editionFeatures(live)` — the preset after `vr.disable`
 * and the overrides — and the header above is proud of that, correctly: it is
 * *"what the renderer IS DOING, after the preset, the VR layer and the
 * overrides have composed"*, and a row showing the stored REQUEST would read
 * "on" for something `vr.disable` had turned off.
 *
 * It was one gate short. Three rows have a SECOND gate, downstream of the
 * edition entirely, which the composed preset cannot see:
 *
 *  * **Shadows** — `shadowsEnabled` is `enabled && quality !== 'low'`.
 *  * **Detail ring** — `detailRingFor` returns null at quality `low`.
 *  * **Bloom** — `willComposite` is `!renderer.xr.isPresenting && enabled`,
 *    and `render()` returns false on `isPresenting`. It has never run in a
 *    headset, which is the only place this page matters.
 *
 * So the page said "on" for three things the renderer was not doing, on the
 * instrument NEXT.md's action 1 uses to decide where Anniversary's frame goes.
 * *"A control that appears to work and does not is worse than no control"* is
 * this file's own sentence, and this is it one level up: a READOUT that
 * appears to read and does not.
 *
 * ── Why the press still toggles the FLAG, which is the call to argue with ─
 *
 * Two alternatives were considered and both are worse:
 *
 *  * **Toggle against the effective state.** At quality `low` with the flag
 *    on, the row reads "off", so a press would write `true` — the value it
 *    already has. Nothing moves. That is the forbidden thing exactly.
 *  * **Refuse the press while forced.** Then a flag turned off at `low` agrees
 *    with the renderer, becomes pressable, is turned on, and is now stuck
 *    on-and-forced-off for the session: a one-way door inside a menu.
 *
 * So a press always moves the FLAG and the NOTE always says what is sitting on
 * top of it. The value never lies and the press always does something visible.
 */
export const effectiveState = (
  feature: AdvancedFeature,
  live: Edition,
  ctx: AdvancedContext,
): { readonly on: boolean; readonly forced: boolean } => {
  const flag = featureIsOn(live, feature.path)
  const on = feature.effective ? feature.effective(live, ctx) : flag
  return { on, forced: on !== flag }
}

/**
 * Every row's effective state as one integer: bit `i` is `ADVANCED_FEATURES[i]`
 * ON, exactly as the page shows it. DEV-335.
 *
 * For the perf trace's `features` column. Matt, after the second worn flight:
 * the detail ring *"seemed to be the biggest win"*, and the capture could not
 * say whether it was: it recorded what every frame cost and nothing about which
 * rows were pressed. The bit names travel in the trace header
 * (`TraceMeta.featureBits`), taken from this same list, so a reader never
 * hard-codes the order.
 */
export const advancedFeatureMask = (live: Edition, ctx: AdvancedContext): number => {
  let mask = 0
  for (let i = 0; i < ADVANCED_FEATURES.length; i++) {
    if (effectiveState(ADVANCED_FEATURES[i] as AdvancedFeature, live, ctx).on) mask |= 1 << i
  }
  return mask
}

/** The page, rendered against the preset AND the renderer state, right now. */
export const advancedRows = (live: Edition, ctx: AdvancedContext): readonly PauseOption[] => [
  ...SETTING_ROWS.map((r) => ({
    id: r.id,
    label: r.label,
    note: r.note,
    value: ctx.settings[r.field] ? 'on' : 'off',
  })),
  ...ADVANCED_FEATURES.map((f) => {
    const { on, forced } = effectiveState(f, live, ctx)
    return {
      id: f.id,
      label: f.label,
      note: forced && f.forcedNote ? f.forcedNote(live, ctx) : f.note,
      value: on ? 'on' : 'off',
    }
  }),
  { id: 'back', label: 'Back', note: 'to more' },
]

export interface AdvancedActivation {
  readonly settings: ComfortSettings
  readonly action: AdvancedAction
  /** True when `settings` differs from what went in. */
  readonly changed: boolean
}

/**
 * Press A on row `index`. Pure, like `activateEditionRow`: the caller decides
 * when a write happens. An out-of-range index is a no-op rather than a throw.
 *
 * Toggles against the LIVE state, not against the stored override. Pressing a
 * row whose feature `vr.disable` has turned off writes `true` and puts it back
 * — which is the case the page exists for, and which a map keyed on "has the
 * player touched this" could not express.
 */
export const activateAdvancedRow = (
  settings: ComfortSettings,
  live: Edition,
  index: number,
): AdvancedActivation => {
  const id = ADVANCED_ROW_IDS[index]
  const still = { settings, action: 'none' as AdvancedAction, changed: false }
  if (id === 'back') return { ...still, action: 'back' }
  const setting = SETTING_ROWS.find((r) => r.id === id)
  if (setting !== undefined) {
    return {
      settings: { ...settings, [setting.field]: !settings[setting.field] },
      action: 'none',
      changed: true,
    }
  }
  const feature = ADVANCED_FEATURES.find((f) => f.id === id)
  if (feature === undefined) return still
  return {
    settings: {
      ...settings,
      featureOverrides: {
        ...settings.featureOverrides,
        [feature.path]: !featureIsOn(live, feature.path),
      },
    },
    action: 'none',
    changed: true,
  }
}

// ── The little state machine `app.ts` holds, mirroring EditionMenu ────────

/** All of it is `createSettingsPage`'s. */
export type AdvancedMenu = SettingsPage<AdvancedAction>

export interface AdvancedMenuOptions {
  readonly settings: ComfortSettings
  /**
   * The preset as it resolves RIGHT NOW — a getter, not a value, because the
   * rows have to re-read it after every press and after entering VR. Handing in
   * an `Edition` would freeze the page on whatever was live when it opened,
   * which is the bug this whole file is about somebody else's control having.
   */
  readonly live: () => Edition
  /**
   * Is a headset presenting right now? A getter, for `live`'s reason.
   *
   * REQUIRED rather than defaulted, and that is DEV-302's structural half: a
   * default of `false` is a wiring miss that reads as the bug it replaces —
   * the bloom row saying "on" in the one place this page matters. A caller
   * that has not wired it does not compile.
   */
  readonly presenting: () => boolean
  readonly onChange: (settings: ComfortSettings) => void
  /** Injectable so the tests can watch the write, and hand in a store that throws. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export const createAdvancedMenu = (options: AdvancedMenuOptions): AdvancedMenu =>
  createSettingsPage(options, {
    title: ADVANCED_TITLE,
    rows: (settings) =>
      advancedRows(options.live(), {
        settings,
        presenting: options.presenting(),
      }),
    activate: (settings, index) => activateAdvancedRow(settings, options.live(), index),
  })
