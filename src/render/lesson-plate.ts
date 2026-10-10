// src/render/lesson-plate.ts — the lesson's prompt, on the briefing plate. DEV-377.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §5.1. **The briefing plate, reused**: the
// same component (`render/briefing.ts`), in the same cockpit-locked pose — about
// 11 degrees above the sightline, 1.05 m out — so a lesson adds no new surface
// to a cockpit that already has one for exactly this: a sentence to read at the
// top of a run. The title is the step, the body is the prompt, and it stays up
// for the whole step, because in a lesson the prompt IS the task.
//
// ── What this file adds to the briefing ───────────────────────────────────
//
// 1. **A cross-fade, never a pop.** Two plates at one pose; a new prompt draws
//    on the back one and the two trade opacity over {@link FADE_SECONDS}. A
//    prompt that pops is a flash in the upper field of view, in a headset, at
//    every step — and a step can change mid-turn.
// 2. **A live number without a strobe.** `{speed}` changes every tick. The
//    text is redrawn in place (no fade: it is the same prompt) and at most every
//    {@link LIVE_REDRAW_SECONDS}, because each redraw is a canvas upload.
// 3. **The lens, in third person.** The briefing hides there; a lesson plate
//    must not (§5.1), so it goes onto the camera beside the third-person panel,
//    which on a flat screen costs no comfort — the chase camera never exists in
//    a headset (DEV-128).
//
// **Nothing head-locked in a headset.** In the seat the plate hangs where the
// briefing hangs, on the ship's frame; the rig never carries it. `render/hud.ts`
// has the argument.
//
// The words are not resolved here: `render/controls-menu.ts`'s
// `resolveLessonText` turns `{throttle}` into the device's word before this
// ever sees the text, so this file is a picture of a string and nothing more.

import * as THREE from 'three'
import { type Briefing, createBriefing } from '@/render/briefing'

/** Seconds a new prompt takes to replace the old one. Long enough to read as a change, not a flicker. */
export const FADE_SECONDS = 0.3

/** The fastest a prompt whose words did not change is redrawn for a live value. 5 Hz. */
export const LIVE_REDRAW_SECONDS = 0.2

/**
 * On the lens in third person: centred, above the ship, in CAMERA space. The
 * chase camera's panel is at (0, -0.5, -1) (`render.thirdPerson.hudOffset`), so
 * this is its mirror above the ship: at 1.1 m and a 70-degree lens the frame's
 * half-height is 0.77 m, and the plate's top edge (0.61 m) is inside it.
 */
const LENS_POSITION = new THREE.Vector3(0, 0.5, -1.1)

/** What the plate should say. */
export interface LessonPlateState {
  /** A change of key is a new prompt, and cross-fades; the same key redraws in place. */
  readonly key: string
  readonly title: string
  readonly text: string
}

export interface LessonPlate {
  readonly object: THREE.Group
  /** What the plate is showing, or fading to. A reading, for probes and specs. */
  readonly shown: LessonPlateState | null
  /** 0..1: how far the current cross-fade has got; 1 when none is running. */
  readonly fade: number
  /**
   * Say `state` (null: fade out). `dt` is a FRAME delta — the fade is a look,
   * not a rule, so it runs on the render clock.
   */
  update(state: LessonPlateState | null, dt: number): void
  setVisible(visible: boolean): void
  /** In the seat: the briefing's own parent and pose. */
  placeInSeat(briefing: THREE.Object3D): void
  /** Third person: on the camera. */
  placeOnLens(camera: THREE.Camera): void
  dispose(): void
}

export const createLessonPlate = (): LessonPlate => {
  const object = new THREE.Group()
  object.name = 'lesson-plate'
  object.visible = false
  const plates: [Briefing, Briefing] = [createBriefing(), createBriefing()]
  for (const [i, p] of plates.entries()) {
    p.object.name = `lesson-plate:${i}`
    p.setVisible(true)
    p.setOpacity(0)
    object.add(p.object)
  }
  // `front` is the plate being faded TO, or the one up when nothing moves.
  let front = 0
  let fade = 1
  let shown: LessonPlateState | null = null
  let sinceRedraw = 0

  const draw = (plate: Briefing, state: LessonPlateState): void =>
    plate.update({ title: state.title, text: state.text })

  const setOpacities = (): void => {
    const a = plates[front] as Briefing
    const b = plates[1 - front] as Briefing
    a.setOpacity(shown ? fade : 0)
    b.setOpacity(1 - fade)
  }

  return {
    object,
    get shown() {
      return shown
    },
    get fade() {
      return fade
    },
    update(state, dt) {
      if (state?.key !== shown?.key || (state === null) !== (shown === null)) {
        // A new prompt: onto the back plate, which becomes the front. A fade
        // already running is finished first — the plate that was coming in is
        // the one going out.
        front = 1 - front
        fade = 0
        shown = state
        sinceRedraw = 0
        if (state) draw(plates[front] as Briefing, state)
      } else if (state && shown && (state.text !== shown.text || state.title !== shown.title)) {
        // The same prompt with a live value moved: in place, at a capped rate.
        sinceRedraw += dt
        if (sinceRedraw >= LIVE_REDRAW_SECONDS) {
          sinceRedraw = 0
          shown = state
          draw(plates[front] as Briefing, state)
        }
      }
      fade = Math.min(1, fade + (FADE_SECONDS > 0 ? dt / FADE_SECONDS : 1))
      setOpacities()
    },
    setVisible(visible) {
      object.visible = visible
    },
    placeInSeat(briefing) {
      const parent = briefing.parent
      if (parent && object.parent !== parent) parent.add(object)
      object.position.copy(briefing.position)
      object.quaternion.copy(briefing.quaternion)
      object.scale.copy(briefing.scale)
    },
    placeOnLens(camera) {
      if (object.parent !== camera) camera.add(object)
      object.position.copy(LENS_POSITION)
      object.quaternion.identity()
      object.scale.setScalar(1)
    },
    dispose() {
      object.removeFromParent()
      for (const p of plates) p.dispose()
    },
  }
}
