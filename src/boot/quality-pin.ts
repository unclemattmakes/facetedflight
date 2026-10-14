// src/boot/quality-pin.ts — `?quality=` and `?adaptive=`, pinned for ONE load.
//
// DEV-161 / DEV-178, and `docs/testing/perf-protocol.md` §3. Taking a row off
// this build means holding the resolution still: a GPU number read while the
// adaptive controller is walking the pixel count up and down is a number about
// the controller, and `?adaptive=0` is how a measurement says so. The quality
// preset is the same argument one level up — `low` and `high` are different
// framebuffer scales, so a baseline row has to say which one it was taken at.
//
// ── Why this is a PIN and not a setting ───────────────────────────────────
//
// Exactly `?edition=`'s shape (`boot/app.ts`'s `EDITION_PARAM`,
// `docs/plan/ANNIVERSARY.md` §0): the stored settings are the PLAYER's, and a
// development switch must never write to them. Somebody who takes one
// measurement row with `?quality=low` and then plays the game must not find
// their headset at 0.7 scale for ever with no memory of having chosen it.
//
// So the pin never enters the `ComfortSettings` the menus hold — those are the
// object `saveSettings` writes — and is overlaid only where the settings reach
// the things that consume them. `tests/unit/quality-pin.test.ts` asserts that
// as a property: pinning must not change what would be written.
//
// ── And a menu change still wins ──────────────────────────────────────────
//
// `clearMovedPins` is the half that makes "pinned for a load" mean pinned
// rather than locked. A player (or the lead, mid-session, in a headset) who
// turns adaptive resolution back on in the comfort menu has said something
// about THIS load that is newer than the URL, so the pin on that field drops
// and the menu owns it from then on. A change to some OTHER row — the volume,
// the vignette — leaves the pin alone, which is the difference between this
// and a literal reading of `?edition=`'s behaviour: there, any settings change
// at all quietly returns the pinned field to the stored value. That is a
// footgun on a switch whose whole job is to hold a measurement still.

import { type ComfortSettings, QUALITIES, type QualitySetting } from '@/boot/settings'

/**
 * The quality presets a URL may name: every one, `ultra` included (DEV-581),
 * which is what lets perf-scale and the same-tick A/B pin it. It IS
 * `QualitySetting`'s list rather than a mirror of it, so a fifth tier cannot be
 * forgotten here the way `ultra` would have been.
 */
const QUALITY_IDS: readonly QualitySetting[] = QUALITIES

/** What is pinned for this load. `null` on a field means "the player's". */
export interface QualityPins {
  readonly quality: QualitySetting | null
  readonly adaptive: boolean | null
  /**
   * `?aa=0|1` — multisampling, DEV-165.
   *
   * NOT part of `ComfortSettings` and therefore not in `applyQualityPins`:
   * MSAA is a WebGL CONTEXT ATTRIBUTE, read once when the context is created
   * and never again. So it cannot be a live setting the way the tier and the
   * adaptive switch are, it does not belong in the object `saveSettings`
   * writes, and `clearMovedPins` has no row to clear — there is no menu
   * control that could move it. `render/renderer.ts` takes it as an argument
   * at construction and that is the whole of its life.
   */
  readonly msaa: boolean | null
  /**
   * `?hz=90` — the DISPLAY's refresh rate, stated. DEV-179.
   *
   * Like `msaa`, not part of `ComfortSettings` and therefore not in
   * `applyQualityPins`: the display's rate is not a preference, it is a fact
   * about the hardware the player is wearing, and nothing in the comfort menu
   * could ever move it. It goes to `render/quality.ts` as
   * `QualityOptions.displayHz` and pins `displayHz` for the load.
   *
   * It exists because the measurement has one failure mode the operator does
   * not: `resolveDisplayRate` needs both R and R/2 inside one 3 s window to
   * name R, and `stickyDisplayHz` needs one such window to have happened at
   * least once. A lap that never reaches the display's rate at all contains no
   * such window — lap 4 came close, at six frames out of 2,364 — and the
   * budget would then be the tier's, which reports headroom that is not there.
   * Somebody who has just set SteamVR to 90 can simply say so.
   */
  readonly hz: number | null
}

export const NO_QUALITY_PINS: QualityPins = Object.freeze({
  quality: null,
  adaptive: null,
  msaa: null,
  hz: null,
})

/**
 * `?quality=low|medium|high`. Null for absent, and null with a warning for a
 * typo — a bad query string must never be a black page, which is the rule
 * `EDITION_PARAM` and `?mode=` already follow.
 */
export const parseQualityPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): QualitySetting | null => {
  if (raw === null) return null
  if ((QUALITY_IDS as readonly string[]).includes(raw)) return raw as QualitySetting
  warn(`?quality=${raw} is not one of ${QUALITY_IDS.join(', ')}; ignored`)
  return null
}

/**
 * `?adaptive=0|1`. Also accepts `off`/`on` and `false`/`true`, because the
 * recipe in `docs/testing/perf-protocol.md` is typed into a headset's address
 * bar by hand and a switch that only answers to one spelling is a switch that
 * silently does nothing on the day it matters.
 */
export const parseAdaptivePin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): boolean | null => {
  if (raw === null) return null
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === '') return true
  warn(`?adaptive=${raw} is not 0 or 1; ignored`)
  return null
}

/** `?submit=`: the submit-early arms (DEV-971). `off` is today's frame. */
export type SubmitPin = 'off' | 'flush' | 'reorder'

/**
 * `?submit=flush|reorder|off`. Anything else is ignored with a warning and
 * reads as `off`, so a typo cannot silently change the frame being measured.
 */
export const parseSubmitPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): SubmitPin => {
  if (raw === null || raw === 'off') return 'off'
  if (raw === 'flush' || raw === 'reorder') return raw
  warn(`?submit=${raw} is not flush, reorder or off; ignored`)
  return 'off'
}

/**
 * `?aa=0|1`. Same spellings as `?adaptive=`, for the same reason: this is
 * typed into a headset's address bar by hand.
 */
export const parseMsaaPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): boolean | null => {
  if (raw === null) return null
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === '') return true
  warn(`?aa=${raw} is not 0 or 1; ignored`)
  return null
}

/**
 * The rates `?hz=` will accept, low and high. DEV-179.
 *
 * Not `KNOWN_REFRESH_HZ` — that list is `boot/perf-recorder.ts`'s and its job
 * is to SNAP a measurement to a plausible display. This one refuses a typo, so
 * it has to be a range rather than a list: a headset whose refresh is not on
 * anybody's list is exactly the case a pin is for, and a pin that answered
 * "that is not a real refresh rate" to the one machine that needed it would be
 * useless. 20 is below any display anyone ships and 500 is above; what is
 * actually being caught is `?hz=9O` and `?hz=0`.
 */
export const HZ_PIN_MIN = 20
export const HZ_PIN_MAX = 500

/**
 * `?hz=<rate>` — the display's refresh, stated by whoever set it.
 *
 * Null for absent and null with a warning for anything unusable, the rule every
 * switch in this file follows: a mistyped query string must never be a black
 * page, and a measurement session in a headset cannot debug one.
 */
export const parseHzPin = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): number | null => {
  if (raw === null || raw.trim() === '') return null
  const hz = Number(raw)
  if (!Number.isFinite(hz) || hz < HZ_PIN_MIN || hz > HZ_PIN_MAX) {
    warn(`?hz=${raw} is not a refresh rate between ${HZ_PIN_MIN} and ${HZ_PIN_MAX}; ignored`)
    return null
  }
  return hz
}

/**
 * The settings as the RENDERER should see them this load.
 *
 * Returns the same object when nothing is pinned, so the common path allocates
 * nothing and an identity check still holds (`editionState.setSettings` skips
 * on `next === settings`).
 */
export const applyQualityPins = (settings: ComfortSettings, pins: QualityPins): ComfortSettings => {
  if (pins.quality === null && pins.adaptive === null) return settings
  return {
    ...settings,
    // A pinned tier is a CHOICE for this load (DEV-334): it holds in a headset
    // too, rather than AUTO trading it for the headset's default.
    ...(pins.quality === null ? {} : { quality: pins.quality, qualityAuto: false }),
    ...(pins.adaptive === null ? {} : { adaptiveResolution: pins.adaptive }),
  }
}

/**
 * Drop any pin the player has just moved in the menu.
 *
 * `previous` is the settings the menu was showing; `next` is what it now says.
 * A field that changed is a field the player has an opinion about, and the
 * opinion is newer than the URL.
 */
export const clearMovedPins = (
  pins: QualityPins,
  previous: ComfortSettings,
  next: ComfortSettings,
): QualityPins => {
  // DEV-334: High -> Auto keeps `quality` at 'high', so the AUTO flag is part
  // of what "the player moved the quality row" means.
  const quality =
    next.quality !== previous.quality || next.qualityAuto !== previous.qualityAuto
      ? null
      : pins.quality
  const adaptive = next.adaptiveResolution !== previous.adaptiveResolution ? null : pins.adaptive
  // `msaa` and `hz` are carried through untouched: there is no menu row for
  // either, so nothing the player can do makes the URL stale. See
  // `QualityPins.msaa` and `QualityPins.hz`.
  return quality === pins.quality && adaptive === pins.adaptive
    ? pins
    : { quality, adaptive, msaa: pins.msaa, hz: pins.hz }
}

/** Is anything pinned at all? For the one console line that says so. */
export const hasQualityPin = (pins: QualityPins): boolean =>
  pins.quality !== null || pins.adaptive !== null || pins.msaa !== null || pins.hz !== null

/** `quality=low, adaptive=off` — what the console prints once at boot. */
export const describeQualityPins = (pins: QualityPins): string =>
  [
    pins.quality === null ? null : `quality=${pins.quality}`,
    pins.adaptive === null ? null : `adaptive=${pins.adaptive ? 'on' : 'off'}`,
    pins.msaa === null ? null : `aa=${pins.msaa ? 'on' : 'off'}`,
    pins.hz === null ? null : `hz=${pins.hz}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
