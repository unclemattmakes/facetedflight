// src/boot/tv-camera-input.ts: the devices TV's camera listens to. DEV-481.
//
// plan/FF-TV.md §5.3: one Camera key cycles Director → Follow → Free (C on a
// keyboard, Y on a pad); ← → (a pad's bumpers) pick the next or previous
// racer; Free flies with the editor's fly-look: the RIGHT button held (or a
// pointer lock) looks, W/S/A/D/Q/E move, the wheel sets the speed; a pad's two
// sticks; a phone's one-finger drag looks. In a headset, outside Free, a stick
// FLICK picks the next/previous racer and the thumbstick's press cycles the
// mode. In Free at launch the sticks are AXES (DEV-481 follow-up): the left
// stick flies along the head's gaze (up forward, sideways along its level
// right), the right stick's x turns smoothly and its y rises (pushed up) or
// sinks. With the comfort cuts on, a flick in Free snaps 30° instead. The
// trigger is the app's own confirm (a press), which `tv-watch-camera.ts` reads
// as next racer, as on a flat screen, or a teleport with the cuts on.
//
// The listeners live here so `game/tv/tv-camera.ts` stays pure; `read()` hands
// what happened since the last call and clears it. Nothing here is a flight
// control: a viewer's own craft is hidden and never launched, so the keys a
// viewer presses move no ship. These keys are only READ while watching.
//
// A phone's held FORWARD is a chip on the touch overlay (plan §5.3); the chip
// is DEV-480/482's (the overlay and the plate are theirs). Until it lands, two
// fingers held down fly forward, so a phone's Free is not stuck in place.

import type { TvCameraInput } from '@/game/tv/tv-camera'
import { createEdges } from '@/input/edge'
import { AXIS, BUTTON, firstStandardPad } from '@/input/gamepad'
import { isTextEntry } from '@/input/text-entry'
import { XR_AXIS, XR_BUTTON } from '@/input/xr'

export interface TvRawInput extends TvCameraInput {
  /** The Camera key went down this read (C, a pad's Y, the headset stick's press). */
  readonly cycle: boolean
  /** Next / previous racer this read (→ ←, a pad's bumpers, a headset stick flick outside Free). */
  readonly next: boolean
  readonly previous: boolean
  /** The look came from a deliberate gesture (a right-drag, a touch drag), not a free mouse under pointer lock. */
  readonly deliberateLook: boolean
  /**
   * DEV-628: a plain left click or a one-finger tap on the canvas this read: a
   * press that did not travel (`TV_TAP_PX`) and did not linger (`TV_TAP_MS`).
   * A drag is never a tap. `tv-watch-camera.ts` reads it as the next racer.
   */
  readonly tap: boolean
}

/** DEV-628: a press that moves further than this, CSS px, is a drag; the lower third's own pick uses the same. */
export const TV_TAP_PX = 12
/** DEV-628: a press held longer than this, ms, is not a tap. */
export const TV_TAP_MS = 500

/** What `read` needs of an `xr-standard` gamepad. */
interface XrPadLike {
  readonly mapping: string
  readonly axes: readonly number[]
  readonly buttons: readonly { readonly pressed: boolean }[]
}

/** What `read` needs of a WebXR session: its input sources' gamepads. */
interface XrSessionLike {
  readonly inputSources: Iterable<{
    readonly handedness: string
    readonly gamepad?: XrPadLike | null | undefined
  }>
}

export interface TvCameraInputSource {
  /**
   * Everything since the last read. `inFree`: a headset is in Free. `smooth`:
   * that Free flies (the sticks as axes: left moves, right turns and rises);
   * otherwise a stick flick snaps in Free (the comfort cuts) or picks a racer.
   */
  read(
    presenting: boolean,
    session: XrSessionLike | null,
    inFree: boolean,
    smooth?: boolean,
  ): TvRawInput
  dispose(): void
}

/** A flick: past `FLICK_ON`, re-armed below `FLICK_OFF`. */
const FLICK_ON = 0.7
const FLICK_OFF = 0.3

export const attachTvCameraInput = (
  canvas: HTMLElement,
  win: Window & typeof globalThis = globalThis as Window & typeof globalThis,
): TvCameraInputSource => {
  const held = new Set<string>()
  let cycle = false
  let next = false
  let previous = false
  let lookDx = 0
  let lookDy = 0
  let deliberate = false
  let wheel = 0
  let rightHeld = false
  /**
   * DEV-616: the left button held: a drag orbits (Director, Follow) or looks
   * (Free), with no capture. The click it ends in presses nothing: `boot/app.ts`
   * spends no mouse click as a confirm while TV is on.
   */
  let leftHeld = false
  /** When a read last happened (performance.now): a watcher not reading does not want the right button eaten. */
  let readAt = Number.NEGATIVE_INFINITY
  const touches = new Map<number, { x: number; y: number }>()
  /** DEV-628: where and when each press that could still be a tap went down. */
  const downs = new Map<number, { x: number; y: number; t: number }>()
  let tap = false
  const padEdges = createEdges<number>()
  const flickArmed = new Map<string, boolean>()
  const stickEdges = createEdges<string>()
  const watching = (): boolean => win.performance.now() - readAt < 500

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent
    if (isTextEntry(e.target)) return
    held.add(e.code)
    // Edges only while watching: an arrow pressed in flight must not be a "next racer" later.
    if (e.repeat || !watching()) return
    if (e.code === 'KeyC') cycle = true
    else if (e.code === 'ArrowRight') next = true
    else if (e.code === 'ArrowLeft') previous = true
  }
  const onKeyUp = (ev: Event): void => {
    held.delete((ev as KeyboardEvent).code)
  }
  const onBlur = (): void => {
    held.clear()
    rightHeld = false
    leftHeld = false
    touches.clear()
    downs.clear()
  }
  const onPointerDown = (ev: Event): void => {
    const e = ev as PointerEvent
    if (e.pointerType === 'touch') touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    else if (e.button === 2) rightHeld = true
    else if (e.button === 0) leftHeld = true
    // A tap is one finger, or the left button; a second finger makes neither a tap.
    if (e.pointerType === 'touch' ? touches.size === 1 : e.button === 0)
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp })
    else downs.clear()
  }
  const onPointerUp = (ev: Event): void => {
    const e = ev as PointerEvent
    const d = downs.get(e.pointerId)
    downs.delete(e.pointerId)
    if (
      d &&
      ev.type === 'pointerup' &&
      watching() &&
      Math.hypot(e.clientX - d.x, e.clientY - d.y) <= TV_TAP_PX &&
      e.timeStamp - d.t <= TV_TAP_MS
    )
      tap = true
    if (e.pointerType === 'touch') touches.delete(e.pointerId)
    else if (e.button === 2) rightHeld = false
    else if (e.button === 0) leftHeld = false
  }
  const onPointerMove = (ev: Event): void => {
    const e = ev as PointerEvent
    // A press that has travelled is a drag, even if it comes back.
    const d = downs.get(e.pointerId)
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > TV_TAP_PX) downs.delete(e.pointerId)
    if (!watching()) return
    if (e.pointerType === 'touch') {
      const t = touches.get(e.pointerId)
      if (!t) return
      // One finger looks; with two down the second is the held Forward and the look stays still.
      if (touches.size === 1) {
        lookDx += e.clientX - t.x
        lookDy += e.clientY - t.y
        deliberate = true
      }
      t.x = e.clientX
      t.y = e.clientY
      return
    }
    const locked = win.document.pointerLockElement === canvas
    if (!rightHeld && !leftHeld && !locked) return
    lookDx += e.movementX
    lookDy += e.movementY
    if (rightHeld || leftHeld) deliberate = true
  }
  const onWheel = (ev: Event): void => {
    if (watching()) wheel += (ev as WheelEvent).deltaY
  }
  const onContextMenu = (ev: Event): void => {
    // The right button is the look while watching: no menu over the race.
    if (watching()) ev.preventDefault()
  }

  win.addEventListener('keydown', onKeyDown)
  win.addEventListener('keyup', onKeyUp)
  win.addEventListener('blur', onBlur)
  canvas.addEventListener('pointerdown', onPointerDown)
  win.addEventListener('pointerup', onPointerUp)
  win.addEventListener('pointercancel', onPointerUp)
  win.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('wheel', onWheel, { passive: true })
  canvas.addEventListener('contextmenu', onContextMenu)

  return {
    read(presenting, session, inFree, smooth = false) {
      readAt = win.performance.now()
      let xrMoveX = 0
      let xrMoveY = 0
      let xrTurn = 0
      let xrRise = 0
      let padMoveX = 0
      let padMoveY = 0
      let padLookX = 0
      let padLookY = 0
      let padRise = 0
      let snap: -1 | 0 | 1 = 0
      // A pad (standard mapping), flat only: in a session the controllers are the headset's.
      // DEV-695: through `firstStandardPad`, the one reader, so DEV-566's hold
      // applies (a pad paired to an upright phone reads as unplugged here too).
      if (!presenting) {
        const pad = firstStandardPad()
        if (pad) {
          const b = (i: number): boolean => pad.buttons[i]?.pressed ?? false
          if (padEdges.step(BUTTON.y, b(BUTTON.y))) cycle = true
          if (padEdges.step(BUTTON.l1, b(BUTTON.l1))) previous = true
          if (padEdges.step(BUTTON.r1, b(BUTTON.r1))) next = true
          padMoveX = pad.axes[AXIS.leftX] ?? 0
          padMoveY = pad.axes[AXIS.leftY] ?? 0
          padLookX = pad.axes[AXIS.rightX] ?? 0
          padLookY = pad.axes[AXIS.rightY] ?? 0
          padRise = (pad.buttons[BUTTON.r2]?.value ?? 0) - (pad.buttons[BUTTON.l2]?.value ?? 0)
        }
      }
      // The headset: a stick FLICK (snap in Free, a racer otherwise) and the stick's press (the Camera key).
      if (presenting && session) {
        for (const src of session.inputSources) {
          const gp = src.gamepad
          if (gp?.mapping !== 'xr-standard') continue
          const hand = src.handedness
          const x = gp.axes[XR_AXIS.stickX] ?? 0
          const y = gp.axes[XR_AXIS.stickY] ?? 0
          if (inFree && smooth) {
            // Free flies: the left stick moves (up is forward along the gaze),
            // the right stick's x turns and its y rises (pushed up) or sinks.
            if (hand === 'left') {
              xrMoveX = x
              xrMoveY = y
            } else {
              xrTurn = x
              xrRise = -y
            }
          } else {
            const armed = flickArmed.get(hand) ?? true
            if (armed && Math.abs(x) > FLICK_ON) {
              flickArmed.set(hand, false)
              const dir = x > 0 ? 1 : -1
              if (inFree) snap = dir
              else if (dir > 0) next = true
              else previous = true
            } else if (!armed && Math.abs(x) < FLICK_OFF) flickArmed.set(hand, true)
          }
          const press = gp.buttons[XR_BUTTON.stick]?.pressed ?? false
          if (stickEdges.step(hand, press)) cycle = true
        }
      }
      const out: TvRawInput = {
        lookDx,
        lookDy,
        padLookX,
        padLookY,
        padMoveX,
        padMoveY,
        padRise,
        keys: {
          forward: held.has('KeyW') || touches.size >= 2,
          back: held.has('KeyS'),
          left: held.has('KeyA'),
          right: held.has('KeyD'),
          down: held.has('KeyQ'),
          up: held.has('KeyE'),
        },
        wheel,
        snap,
        xrMoveX,
        xrMoveY,
        xrTurn,
        xrRise,
        cycle,
        next,
        previous,
        deliberateLook: deliberate,
        tap,
      }
      tap = false
      cycle = false
      next = false
      previous = false
      lookDx = 0
      lookDy = 0
      deliberate = false
      wheel = 0
      return out
    },
    dispose() {
      win.removeEventListener('keydown', onKeyDown)
      win.removeEventListener('keyup', onKeyUp)
      win.removeEventListener('blur', onBlur)
      canvas.removeEventListener('pointerdown', onPointerDown)
      win.removeEventListener('pointerup', onPointerUp)
      win.removeEventListener('pointercancel', onPointerUp)
      win.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContextMenu)
    },
  }
}
