// src/render/options-plate-pose.ts: where the OPTIONS pages stand when the hangar
// or the title draws them: exactly where the pause plate stands. DEV-882, DEV-897.
//
// DEV-882 (playtest 2026-10-09) sized them as the pause plate's own page: the
// same card, so a row subtends the angle it does in the cockpit (6 degrees up to
// five rows, 4.00 at the eight OPTIONS holds). DEV-897 (Matt, 2026-10-10, after
// wearing 0.28.0: *"right now it's positioned in an odd place - plz make sure it's
// positioned the same as in the game. (i noticed this especially in VR)"*) puts it
// where the pause plate is too. DEV-882 had kept the SIZE and moved the plate to the
// title menu's 2.0 m, and in a headset hung its top edge under the eye line at that
// distance, so the page was twice as far as the cockpit's and nowhere near the same
// height. Now there is one pose, `pausePlateOffset` (`render/pause.ts`), which the
// cockpit also adds to its eye:
//
//   * `PANEL_DISTANCE` ahead of the eye and `PANEL_DROP` below it (the origin; the
//     card's top edge pins at `TOP_LOCAL_Y`, so any row count keeps the title band
//     on the eye line), at the pause plate's own scale, 1.
//   * Square to the view. A headset's view is level (the rig's forward), so the plate
//     stands upright, as in the cockpit. A flat screen in the hangar looks DOWN at the
//     tables (the chair's resting pitch), so the same offset is turned by that pitch
//     and the plate is tipped to face the eye: the cockpit's pose in the view's frame.
//   * A phone's fit is the pause plate's own (`pausePhoneFit`, DEV-796): x1.8 and lifted
//     to centre on the eye line.
//
// Pure, so a test can hold it against the pause plate without a canvas.

import { PANEL_DISTANCE, pausePlateOffset, TITLE_M } from '@/render/pause'
import { pausePhoneFit, phoneUi } from '@/render/phone-floor'

/** Metres in front of the eye: the pause plate's own distance (DEV-897). */
export const OPTIONS_PLATE_DISTANCE = PANEL_DISTANCE

/** The scale on the pause plate's own metres: 1, since the plate stands where the pause plate does. */
export const OPTIONS_PLATE_SCALE = 1

/** A plate's pose under the rig: where its origin is, its scale, and how far it tips about x (radians). */
export interface OptionsPlatePose {
  readonly position: readonly [number, number, number]
  readonly scale: number
  /** Rotation about x: the plate faces the eye when the view looks along `centreRad`. 0 in a headset. */
  readonly tilt: number
}

/**
 * The plate's pose under the rig for a page of `rows` rows under the heading
 * band and `bodyM` metres of body (the credits roll's band). `centreRad` is the
 * elevation the view looks along, radians, negative down (flat only; a headset's
 * view is level).
 */
export const optionsPlatePoseAt = (
  rows: number,
  bodyM: number,
  flat: boolean,
  centreRad: number,
  titleM: number = TITLE_M,
): OptionsPlatePose => {
  // DEV-894: a phone fits the plate as the pause plate does, flat only.
  const fit =
    flat && phoneUi.on
      ? pausePhoneFit(rows, titleM + Math.max(0, bodyM))
      : { scale: OPTIONS_PLATE_SCALE, lift: 0 }
  const pitch = flat ? centreRad : 0
  return { position: pausePlateOffset(pitch, fit.lift), scale: fit.scale, tilt: pitch }
}
