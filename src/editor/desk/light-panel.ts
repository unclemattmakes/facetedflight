// src/editor/desk/light-panel.ts — the panel's LIGHT group: the sun and the
// tint. DEV-476 (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
//
// Matt: *"would love to change time-of-day and lighting tint settings"*, and of
// the options, *"sun sliders plus a tint: sun height and direction, and a
// colour tint reusing DEV-446's scene tint, saved in the course."*
//
// Its own module so `panel.ts` carries one import, one line in each of its two
// types, and one line where the group is made, placed and drawn — the panel is
// shared with DEV-478's row, and a contiguous group elsewhere keeps the two
// merges apart. Plain DOM, holding no state: `render` draws what the desk says,
// and every control reports an intent, as the rest of the panel does.
//
// The four controls are LIVE, like DEV-473's sliders: every `input` while one
// is dragged is a `live` commit (the desk moves the light, the sea's glint and
// the sky's disc at once) and the release is a final one (the desk seals the
// undo step and re-bakes the far-shadow and sky-visibility maps). A group
// folded shut by default, so the panel's other rows stay where people know
// them; it opens with one click on its heading.

import { hexToSrgb, srgbToHex } from '@/content/colour-hex'
import { PLAYER_COURSE_LIGHT, SUN_ELEVATION_FLOOR } from '@/content/player-course-light'
import { make, tipper } from '@/editor/ui/dom'

/** One line per control, as `PANEL_TIPS`; the e2e holds every control to having one. */
export const LIGHT_TIPS = {
  light: 'The sun and a colour tint for this course. The sky itself stays the base’s.',
  'sun-height':
    'How high the sun stands, in degrees above the horizon: low is dawn or dusk, high is midday.',
  'sun-direction':
    'Which way the sun shines from, in degrees round the island. Shadows fall the other way.',
  'tint-colour': 'A colour to lean the whole picture toward. Its brightness is ignored.',
  'tint-amount': 'How far toward the tint colour: 0 % is none.',
  'sky-light': 'Put back the base’s own sun, and no tint.',
} as const

export type LightTipName = keyof typeof LIGHT_TIPS

export interface LightPanelState {
  /** The course's light as flown (the sky's own when the course has none). */
  readonly azimuth: number
  readonly elevation: number
  readonly tint: readonly [number, number, number]
  readonly tintAmount: number
  /** Whether the course has a light block of its own. */
  readonly own: boolean
  /** True when the sky moved the sun from where the last slider asked for it. */
  readonly held: boolean
  readonly busy: boolean
}

export interface LightPanelActions {
  /** The sun's two angles, degrees. `live` while a slider is dragged; its release is final. */
  sun(azimuth: number, elevation: number, live: boolean): void
  /** The tint, sRGB 0..1, and its amount 0..1. `live` as `sun`. */
  tint(colour: readonly [number, number, number], amount: number, live: boolean): void
  /** The sky's own light: the course's block removed. */
  skyLight(): void
}

export interface LightGroup {
  readonly element: HTMLElement
  render(state: LightPanelState): void
}

/** `#rrggbb` of an sRGB 0..1 colour, as `<input type=color>` wants it. */
export const tintHex = srgbToHex

/** The sRGB 0..1 colour of a `#rrggbb`. */
export const tintOfHex = hexToSrgb

/** Degrees as the readout says them. */
const deg = (v: number): string => `${v.toFixed(1)}°`

export const createLightGroup = (actions: LightPanelActions): LightGroup => {
  const tip = tipper<LightTipName>(LIGHT_TIPS)
  const range = (name: LightTipName, min: number, max: number, step: number): HTMLInputElement =>
    tip(
      make('input', { type: 'range', min: String(min), max: String(max), step: String(step) }),
      name,
    )
  const q = PLAYER_COURSE_LIGHT.angleQuantumDegrees
  const height = range(
    'sun-height',
    SUN_ELEVATION_FLOOR,
    PLAYER_COURSE_LIGHT.elevationMaxDegrees,
    q,
  )
  const direction = range('sun-direction', -180, 180, q)
  const colour = tip(make('input', { type: 'color' }), 'tint-colour')
  const amount = range('tint-amount', 0, 1, PLAYER_COURSE_LIGHT.tintAmountQuantum)
  const heightOut = make('span', { className: 'readout' })
  heightOut.dataset.editor = 'sun-height-readout'
  const directionOut = make('span', { className: 'readout' })
  directionOut.dataset.editor = 'sun-direction-readout'
  const amountOut = make('span', { className: 'readout' })
  const heldOut = make('div', { className: 'readout' })
  heldOut.dataset.editor = 'sun-held'
  const reset = tip(
    make('button', { type: 'button', textContent: "Base's own light" }),
    'sky-light',
  )
  reset.addEventListener('click', () => actions.skyLight())

  const sun = (live: boolean): void =>
    actions.sun(Number.parseFloat(direction.value), Number.parseFloat(height.value), live)
  const tinted = (live: boolean): void =>
    actions.tint(tintOfHex(colour.value), Number.parseFloat(amount.value), live)
  for (const [input, send] of [
    [height, sun],
    [direction, sun],
    [amount, tinted],
    [colour, tinted],
  ] as const) {
    input.addEventListener('input', () => send(true))
    input.addEventListener('change', () => send(false))
  }
  // As DEV-473's sliders: a mouse drag gives the keys back on release, so
  // Ctrl+Z undoes it at once. After the release's `change`, which fires first.
  for (const input of [height, direction, amount]) {
    input.addEventListener('pointerup', () => setTimeout(() => input.blur(), 0))
  }

  const line = (label: string, input: HTMLInputElement, out: HTMLElement): HTMLElement =>
    make(
      'div',
      { className: 'row' },
      make('label', { textContent: label, title: input.title }),
      input,
      out,
    )
  const summary = tip(make('summary', { textContent: 'Light: sun and tint' }), 'light')
  summary.style.cssText = 'cursor:pointer;color:#b8c6d4'
  const element = make(
    'details',
    { className: 'group' },
    summary,
    line('Sun height', height, heightOut),
    line('Sun direction', direction, directionOut),
    line('Tint', colour, amountOut),
    make('div', { className: 'row' }, amount),
    heldOut,
    make('div', { className: 'buttons' }, reset),
  )
  element.dataset.editor = 'light-group'

  /**
   * Every control shows the draft's value, even the one being dragged — as
   * DEV-473's sliders do — so a sun the sky holds stops where it is held.
   */
  const show = (input: HTMLInputElement, v: string): void => {
    if (input.value !== v) input.value = v
  }

  return {
    element,
    render(s) {
      show(height, String(s.elevation))
      show(direction, String(s.azimuth))
      show(colour, tintHex(s.tint))
      show(amount, String(s.tintAmount))
      heightOut.textContent = deg(s.elevation)
      directionOut.textContent = deg(s.azimuth)
      amountOut.textContent = `${Math.round(s.tintAmount * 100)} %`
      heldOut.textContent = s.held
        ? 'The sky holds the sun here: past it the sun would sit where its own sky is dark.'
        : s.own
          ? ''
          : "The base's own sun."
      for (const input of [height, direction, colour, amount]) input.disabled = s.busy
      reset.disabled = s.busy || !s.own
      element.dataset.own = s.own ? 'yes' : 'no'
      element.dataset.azimuth = String(s.azimuth)
      element.dataset.elevation = String(s.elevation)
    },
  }
}
