// src/game/edition.ts — the preset that is live right now, and the one knob
// that scales the speed effects.
//
// ── One owner, read every frame ──────────────────────────────────────────
//
// `boot/app.ts` loads the preset the settings name (or `?edition=` for one
// load), holds it here, and hands this object to every system that has an
// Anniversary behaviour. A system READS `current` when it needs it — a getter,
// cheap, and always the live one — and may `subscribe` if it has to rebuild
// something on a flip (a tone mapper, a material). Nothing else holds a copy,
// so a flip cannot leave one subsystem on the old preset, which is the exact
// failure the level-select reload (`app.ts`, `?mission=`) exists to avoid.
//
// ── The speed slider is a COMFORT setting, and it multiplies ─────────────
//
// docs/plan/ANNIVERSARY.md §2.6: everything that creates a sense of speed does
// it by increasing optic flow, and optic flow IS vection — the thing the comfort
// block (DEV-058) exists to limit. So the near-field air, the streak width, the
// cockpit shake and the gate pulse all scale together by ONE number, off / light
// / full, that sits on the same `ComfortSettings` as the vignette and persists
// with it. `speedFx` here is that number, resolved: 0, 0.5 or 1.
//
// A feature checks BOTH — its own flag on the preset, and this scale — and
// draws nothing when either is zero. Classic has every flag off, so on Classic
// the slider is inert, which is what "Classic" has to mean.

//
// ── The LOOK and the RULES are two presets, composed (DEV-452, D35) ──────
//
// Matt, 2026-09-27: the Classic/Anniversary split is *"just for the
// in-mission visuals"*. So this holds TWO presets: the one whose look is worn
// (`setLook`, which the menus and the missions flip between, DEV-451) and the
// one whose rules every run flies (`rules`, fixed for the page: Anniversary,
// or Classic behind `?rules=classic` as the 2016 reference the tests fly).
// `current` is the look laid over the rules by `content/edition-split.ts`,
// so every reader goes on reading one preset. `current.id` names the LOOK;
// a board, a lap and a room ask `rules.id`.

import type { ComfortSettings, SpeedFxSetting } from '@/boot/settings'
import { applyVrOverrides, type Edition, withFeatureOverrides } from '@/content/edition-schema'
import { lookOnRules } from '@/content/edition-split'

/**
 * off / light / full as a multiplier. `light` is HALF, not "a bit": the feature
 * agents author the effect at `full` for a monitor and the headset default of
 * `light` has to be a real reduction, not a rounding.
 */
export const SPEED_FX_SCALE: Readonly<Record<SpeedFxSetting, number>> = {
  off: 0,
  light: 0.5,
  full: 1,
}

export const speedFxScale = (setting: SpeedFxSetting): number => SPEED_FX_SCALE[setting]

export type EditionListener = (edition: Edition, settings: ComfortSettings) => void

export interface EditionState {
  /**
   * The live preset: the worn LOOK over the page's RULES (DEV-452). A getter:
   * read it when you need it, never cache it. Its `id` names the look.
   */
  readonly current: Edition
  /**
   * The preset every run on this page flies by: its `gameplay` is `current`'s,
   * and its `id` is the one a lap, a board and a room are keyed on. Fixed for
   * the page (DEV-452).
   */
  readonly rules: Edition
  /** The live comfort settings, as last handed in. */
  readonly settings: ComfortSettings
  /** `speedFxScale(settings.speedFx)`: 0, 0.5 or 1. */
  readonly speedFx: number
  /**
   * A flip of the LOOK (DEV-451, DEV-452): the rules stay. Notifies subscribers
   * after the swap. Named for what it changes since D35, so a caller that
   * meant "change the rules" does not compile rather than silently changing
   * the look.
   */
  setLook(edition: Edition): void
  /**
   * BOTH halves at once, to one preset: the development handle's (`__ff2`),
   * for the specs and perf tools that clone `current`, move one flag and put
   * it back, whichever side of D35 the flag is on. Never a player's path: a
   * player's flip is `setLook`, and the page's rules are fixed.
   */
  setPreset(edition: Edition): void
  /**
   * The headset started or stopped presenting. Notifies if `current` moved.
   * DEV-263.
   *
   * Called from `boot/app.ts`'s `sessionstart` / `sessionend`. Everything that
   * has an Anniversary behaviour already re-reads on notify — that is what
   * `attachEditionHaze` and its siblings are — so the VR look arrives the same
   * way an edition flip does, with no second code path.
   */
  setImmersive(on: boolean): void
  /** Whether `current` is the VR resolution of the preset. DEV-263. */
  readonly immersive: boolean
  /**
   * Force `editionFeatures()` flags on or off, over the top of everything else.
   * DEV-263.
   *
   * The `?feature=` pin sets this once at boot; the Advanced pause page will
   * move it at runtime. Applied AFTER the VR layer, so it can turn a
   * VR-disabled feature back on — which is the point of it.
   *
   * A path that is not a feature is ignored rather than refused: these come
   * from a URL and from stored settings, both of which outlive the build that
   * wrote them. The edition FILES are held to the opposite rule.
   */
  setFeatureOverrides(overrides: Readonly<Record<string, boolean>>): void
  /** The override layer as last set. DEV-263. */
  readonly featureOverrides: Readonly<Record<string, boolean>>
  /** The comfort settings moved (the slider, or anything else). Notifies. */
  setSettings(settings: ComfortSettings): void
  /** Called on every `set` and `setSettings`. Returns the unsubscribe. */
  subscribe(listener: EditionListener): () => void
}

export const createEditionState = (
  initial: Edition,
  initialSettings: ComfortSettings,
  /** The page's rules (DEV-452). Absent: the look's own, one preset whole. */
  initialRules: Edition = initial,
): EditionState => {
  /** The worn LOOK. `resolved()` lays it over `rules`. */
  let edition = initial
  /** The page's RULES. Moved only by `setPreset`, the development handle's. */
  let rules = initialRules
  let settings = initialSettings
  const listeners = new Set<EditionListener>()
  /** DEV-263: is a headset presenting? Decides which resolution `current` is. */
  let immersive = false
  /**
   * `applyVrOverrides(edition)`, computed once per edition rather than per read.
   *
   * `current` is documented as "read it when you need it" and is read every
   * frame by several systems, so it may not clone a preset. Invalidated by
   * `setLook`, which is the only thing that can change what the override applies to.
   */
  let vrEdition: Edition | null = null
  /** DEV-263: the `?feature=` pin and (later) the Advanced page's rows. */
  let overrides: Readonly<Record<string, boolean>> = {}
  /** `resolved()`'s answer, cached against the inputs that can change it. */
  let composed: Edition | null = null
  /**
   * DEV-452: the look over the rules, once per look, so a VR edge or an
   * override that changes nothing compares the SAME object and notifies no one.
   */
  let worn: Edition | null = null
  const resolved = (): Edition => {
    if (composed !== null) return composed
    // VR first, then the manual layer on top, so an override can turn a
    // VR-disabled feature back ON. Two `withFeatureOverrides` calls rather than
    // one merged map, because the VR layer is the preset's own data and the
    // override layer is the operator's — merging them here would make a
    // `?feature=` pin indistinguishable from something anniversary.json asked
    // for, in the one place that has to tell them apart.
    //
    // The look over the rules first (DEV-452): the VR list is the composed
    // preset's, so the look's VR choices and the rules' travel with them.
    worn ??= lookOnRules(edition, rules)
    let base = worn
    if (immersive) {
      if (vrEdition === null) vrEdition = applyVrOverrides(base)
      base = vrEdition
    }
    composed = withFeatureOverrides(base, overrides)
    return composed
  }

  const notify = (): void => {
    const live = resolved()
    for (const l of listeners) l(live, settings)
  }

  return {
    get current() {
      return resolved()
    },
    get immersive() {
      return immersive
    },
    get settings() {
      return settings
    },
    get speedFx() {
      return speedFxScale(settings.speedFx)
    },
    get featureOverrides() {
      return overrides
    },
    get rules() {
      return rules
    },
    setLook(next) {
      // The look already worn, handed back (`setLook(state.current)`), is no
      // change either: `current` is the look laid over the rules, a different
      // object from the preset that was set.
      if (next === edition || next === worn || next === composed) return
      edition = next
      worn = null
      vrEdition = null
      composed = null
      notify()
    },
    setPreset(next) {
      if (next === edition && next === rules) return
      edition = next
      rules = next
      worn = null
      vrEdition = null
      composed = null
      notify()
    },
    setFeatureOverrides(next) {
      // Same before/clear/after order as `setImmersive`, for the same reason.
      const before = resolved()
      overrides = next
      composed = null
      // Identity again: setting an override that the preset already satisfies
      // must not rebuild a single material.
      if (resolved() === before) return
      notify()
    },
    setImmersive(on) {
      if (on === immersive) return
      // The BEFORE and AFTER of `current`, compared by identity. A preset with
      // no `vr` block — Classic, and Anniversary before DEV-263 — resolves to
      // the same object either way, and `applyVrOverrides` returns the input
      // when it would be a no-op precisely so this comparison can be made.
      // Without it, entering VR on Classic would notify every subscriber and
      // rebuild materials to arrive at the preset it already had.
      //
      // The cache is cleared AFTER `before` is taken and BEFORE the second
      // read, in that order. Clearing it once up front looks equivalent and is
      // not: `resolved()` would repopulate `composed` on the `before` call and
      // the `after` call would then return that same cached object, so the
      // comparison would be an object against itself and this would never
      // notify — a flip into VR that silently changed nothing.
      const before = resolved()
      immersive = on
      composed = null
      if (resolved() === before) return
      notify()
    },
    setSettings(next) {
      if (next === settings) return
      settings = next
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
