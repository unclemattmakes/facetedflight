// src/render/tv-panel-controls.ts: FF-TV's way out and its how-to, on a flat
// screen and a phone. DEV-628.
//
// Matt, playing 0.20.0: "fftv: no way to exit a broadcast / unclear how to
// change which racer i'm following". The plate (CAMERA, NEXT RACE, SHARE THIS
// VIEW, LEAVE TV) was the only way out, behind Backspace or a pad's Start, and
// nothing on screen said so; a phone's touch overlay covered the race with
// flight sticks for a ship nobody flies. So, while TV is on screen and no
// headset is presenting:
//
//   * EXIT, top left: LEAVE TV, back to the hangar (`tv-view.ts`'s `leave`).
//   * MENU beside it: TV's plate, as the pad's Start and the M key open it.
//   * One line of hint under them, naming the controls for the device in
//     hand and the camera's mode (a click or tap follows the next racer, a
//     drag orbits; in Free a drag looks and W/A/S/D fly).
//
// DOM, not glass: these are a monitor's and a phone's controls, and a page's
// buttons are the ones every browser already knows how to press (a headset
// has the plate and B). Above the touch overlay (z-index 1), which `boot/app.ts`
// hides on TV while the plate is down so a finger reaches the race.

import type { TvCameraMode } from '@/game/tv/tv-camera'
import { isTextEntry } from '@/input/text-entry'
import {
  UI_ACCENT,
  UI_INK,
  UI_ON_ACCENT,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_STACK,
} from '@/render/ui-tokens'

export const TV_CONTROLS_ROOT_ID = 'tv-controls'

export interface TvControlsState {
  /** TV is on screen, flat (no headset presenting). */
  readonly shown: boolean
  /** A phone or tablet: the words name taps, not keys. */
  readonly touch: boolean
  /** TV's plate is up: the hint steps aside, EXIT stays. */
  readonly plateUp: boolean
  /** The camera's mode, or null before one is built. */
  readonly mode: TvCameraMode | null
}

export interface TvControlsReport {
  readonly shown: boolean
  readonly hint: string
  readonly exits: number
  readonly menus: number
}

export interface TvControls {
  update(state: TvControlsState): void
  report(): TvControlsReport
  dispose(): void
}

/** The hint for the device and mode: what a press, a drag and the keys do now. */
export const tvControlsHint = (touch: boolean, mode: TvCameraMode | null): string => {
  if (touch) {
    return mode === 'free'
      ? 'TAP follow a racer · DRAG look · MENU camera'
      : 'TAP next racer · DRAG orbit · MENU camera'
  }
  return mode === 'free'
    ? 'CLICK follow a racer · DRAG look · W A S D fly · C camera · M menu · ESC exit'
    : 'CLICK next racer · DRAG orbit · ← → racer · C camera · M menu · ESC exit'
}

const CSS = `
#${TV_CONTROLS_ROOT_ID} {
  position: fixed;
  top: calc(10px + env(safe-area-inset-top, 0px));
  left: calc(12px + env(safe-area-inset-left, 0px));
  right: calc(12px + env(safe-area-inset-right, 0px));
  z-index: 2;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  font: 700 14px/1 ${UI_STACK};
  font-synthesis: none;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${UI_INK};
}
#${TV_CONTROLS_ROOT_ID}[hidden] { display: none; }
#${TV_CONTROLS_ROOT_ID} .row { display: flex; gap: 8px; align-items: center; }
/* DEV-653: flat plates with one hard accent edge, as a broadcast's tabs are, not pills. */
#${TV_CONTROLS_ROOT_ID} button {
  pointer-events: auto;
  touch-action: manipulation;
  height: 34px;
  padding: 0 16px 0 13px;
  margin: 0;
  font: inherit;
  color: inherit;
  background: ${UI_PLATE};
  border: 1px solid ${UI_PLATE_EDGE};
  border-bottom: 3px solid ${UI_ACCENT};
  border-radius: 0;
  cursor: pointer;
}
#${TV_CONTROLS_ROOT_ID} button:hover { background: ${UI_ACCENT}; color: ${UI_ON_ACCENT}; }
#${TV_CONTROLS_ROOT_ID} .hint {
  margin-top: 8px;
  font-weight: 500;
  font-size: 14px;
  letter-spacing: 0.06em;
  text-transform: none;
  opacity: 0.85;
  transition: opacity 0.6s ease;
  text-shadow: 0 1px 2px ${UI_PLATE};
  max-width: min(100%, 720px);
  line-height: 1.4;
}
#${TV_CONTROLS_ROOT_ID} .hint[hidden] { display: none; }
`

/** DEV-653: the hint stands this long after the last input, then fades (milliseconds). */
export const TV_HINT_IDLE_MS = 6000

/** The hint's opacity after `idleMs` without input: full, then gone. */
export const tvHintOpacity = (idleMs: number): number => (idleMs < TV_HINT_IDLE_MS ? 0.85 : 0)

export const createTvControls = (o: {
  readonly onExit: () => void
  readonly onMenu: () => void
  readonly doc?: Document
  /** A clock, ms. Absent: `performance.now`. */
  readonly now?: () => number
}): TvControls => {
  const doc = o.doc ?? document
  const style = doc.createElement('style')
  style.textContent = CSS
  doc.head.appendChild(style)
  const root = doc.createElement('div')
  root.id = TV_CONTROLS_ROOT_ID
  root.hidden = true
  const row = doc.createElement('div')
  row.className = 'row'
  const button = (label: string, act: string, run: () => void): HTMLButtonElement => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.dataset.act = act
    // The press is the button's alone: nothing under it hears a tap or a drag.
    b.addEventListener('pointerdown', (e) => e.stopPropagation())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      b.blur()
      run()
    })
    row.appendChild(b)
    return b
  }
  let exits = 0
  let menus = 0
  button('EXIT', 'exit', () => {
    exits++
    o.onExit()
  })
  button('MENU', 'menu', () => {
    menus++
    o.onMenu()
  })
  const hint = doc.createElement('div')
  hint.className = 'hint'
  root.append(row, hint)
  doc.body.appendChild(root)

  let shown = false
  const now = o.now ?? (() => performance.now())
  let lastInput = now()
  /** Any input at all brings the hint back (DEV-653). */
  const touched = (): void => {
    lastInput = now()
  }
  const inputEvents = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const
  for (const name of inputEvents)
    doc.defaultView?.addEventListener(name, touched, { passive: true })
  const onKey = (ev: KeyboardEvent): void => {
    if (!shown || ev.repeat || ev.code !== 'KeyM') return
    if (isTextEntry(ev.target)) return
    menus++
    o.onMenu()
  }
  doc.defaultView?.addEventListener('keydown', onKey)

  return {
    update(s) {
      if (s.shown !== shown) {
        shown = s.shown
        root.hidden = !shown
        if (shown) lastInput = now()
      }
      if (!shown) return
      const text = tvControlsHint(s.touch, s.mode)
      if (hint.textContent !== text) {
        hint.textContent = text
        lastInput = now() // a new mode is news
      }
      hint.hidden = s.plateUp
      hint.style.opacity = String(tvHintOpacity(now() - lastInput))
    },
    report: () => ({ shown, hint: shown ? (hint.textContent ?? '') : '', exits, menus }),
    dispose() {
      doc.defaultView?.removeEventListener('keydown', onKey)
      for (const name of inputEvents) doc.defaultView?.removeEventListener(name, touched)
      root.remove()
      style.remove()
    },
  }
}
