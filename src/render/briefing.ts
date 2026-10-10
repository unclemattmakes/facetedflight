// src/render/briefing.ts — what the mission is, before you fly it.
//
// 2016 shows this the instant the ship spawns: `panel_mission` is `m_IsActive:
// 1` at t=0 on `PlayerShip_SR14_Photon.prefab`, carrying
//
//     Fly through as many rings as you can before time runs out. Don't CRASH!!
//
// alongside `panel_Startup`'s "Powering On...". `panel_mission` is killed at
// 3.8 s by its OWN `disableAfterDelay` (`disableDelay: 3.8` on
// `PlayerShip_SR14_Photon.prefab:10176`), then redundantly again at ~4.12 s by
// `HUD_Ship.DelayedStart`'s `0.12f + 4f` (`HUD_Ship.cs:88-99`), against a panel
// already inactive. `panel_Startup` carries no such component — it goes via
// `UI_CamDependant.UpdateUI()`. See `docs/research/_ui-flow.md` §4, and DEV-217
// for why `HUD_Ship.cs:97-99` is the wrong citation for the 3.8.
//
// ── Why it is its own panel rather than the HUD banner ──────────────────
//
// `launchBanner()` is one short line drawn INTO the instrument panel, and it is
// the right shape for "Press A to launch" and "3". A briefing is a sentence that
// has to wrap, and wrapping it into the banner's slot would shrink the
// countdown's type to fit the longest string it might ever hold.
//
// ── The string is hand-carried, and that is a known shortcut ────────────
//
// It is copied from the prefab with the line cited above, exactly as the launch
// banner's two strings already are. Every UI string in `src/render` is like
// this today — GATES, TIME, SPEED, "- PAUSE -" — because the extractor reads
// components and transforms and does not yet read `UnityEngine.UI.Text.m_Text`.
// Teaching it to is a job of its own (`m_Script` guid
// `f5f67c52d1564df4a8936ccd202a3bd8`, `m_Text` beneath it), after which this
// belongs in the level JSON where rule 6 says mission content lives.

import type * as THREE from 'three'
import { drawPlate, wrapText } from '@/render/ui-draw'
import { createUiPlate, UI_PIXELS_PER_METRE } from '@/render/ui-plate'
import { UI_ACCENT as ACCENT, uiFont as font, UI_INK as INK, uiType } from '@/render/ui-tokens'
import type { LaunchPhase } from '@/sim/launch'
import { SKI_MARK_COLOURS, type SkiMarkShape } from './ski-marks'

/**
 * How far up the ride the plate is GONE, as a share of the ride's height
 * (DEV-526). Matt, 2026-09-29, of the briefing call: *"half way up the ride"*.
 */
export const BRIEFING_DOWN_AT = 0.5

/**
 * How much of the ride's height the fade takes, ending at `BRIEFING_DOWN_AT`
 * (DEV-526): 40 % to 50 % of the 106.6 m climb, which the lift covers in its
 * fast middle in 0.9 s (8.19 s to 9.11 s after the press on `int_01`, pinned
 * by `tests/unit/briefing-up.test.ts`). A fade rather than a pop because the
 * plate already fades (`setOpacity`, DEV-377's lesson cross-fade).
 */
export const BRIEFING_FADE = 0.1

/** The launch as the briefing reads it: the phase, and the platform's height. */
export interface BriefingLaunch {
  readonly phase: LaunchPhase
  /** Metres above the spawn marker (`LaunchState.rise`). */
  readonly rise: number
}

/**
 * The briefing plate's opacity, 0..1, from the launch alone (DEV-526).
 *
 * Up on the pad (`waiting`), whatever the platform's height: a ride that was
 * skipped (a Quick Race, a retry) waits at the TOP, and the plate is what you
 * read there. While the lift RISES, full until 40 % of the way up, fading to
 * nothing at HALF WAY, by HEIGHT (`rise` over `top`, the curve's end,
 * `sim/launch.ts`'s `topRise`). Down through the countdown and the flight.
 * `launch` is null on a mission with no elevator rig (the six JumpSeat
 * courses), which has no pad to read it on.
 *
 * **By height, not by time**, because Matt said *up*, and height is what the
 * rider sees go by: the shaft wall. The ride's state carries both
 * (`LaunchState.rise` and `.elapsed`); on `elevator_up.anim` they part by about
 * 1.4 s (half the height, 53.3 m, is 9.11 s after the press; half the clip's
 * 15.47 s is 7.73 s, at 37.9 m, because the clip holds 0.6 s at the bottom and
 * 1.5 s at the top). Either way the plate is gone well before the world is
 * revealed (`render/elevator.ts`'s `REVEAL_RISE`, 12.41 s after the press, 3.3
 * s after the plate goes): the moment over the first gate that DEV-395 took the
 * plate away for.
 */
export const briefingOpacity = (launch: BriefingLaunch | null, top: number): number => {
  if (!launch) return 0
  if (launch.phase === 'waiting') return 1
  if (launch.phase !== 'rising' || !(top > 0)) return 0
  const up = launch.rise / top
  const fade = (BRIEFING_DOWN_AT - up) / BRIEFING_FADE
  return fade >= 1 ? 1 : fade <= 0 ? 0 : fade
}

/**
 * Whether the briefing is up at all: `briefingOpacity` above zero.
 *
 * **DEV-526 moves the drop to HALF WAY UP the ride.** DEV-395 (below) had
 * taken it down at the launch press; Matt's answer to the call that followed,
 * whose two options were the press and the reveal, was neither: *"half way up
 * the ride"*. What DEV-395 was for survives it: the plate is gone seconds
 * before the platform breaks the surface over the first gate.
 *
 * DEV-395, as it stood: whether the briefing is up, from the launch alone: ON
 * THE PAD, and nowhere else.
 *
 * **It drops when the ride STARTS (DEV-395).** It was `waiting || rising`, so
 * the plate rode the whole 15.5 s lift and floated dead centre over the first
 * gate as the platform broke the surface, which the 2026-09-24 playtest called
 * the best moment in the build. Matt (look call 8): *"keep the motes, drop the
 * briefing during the elevator ride."* The launch press is the "I've read it".
 *
 * 2016 never showed it through the ride either: `panel_mission` dies 3.8 s
 * after SPAWN on its own `disableAfterDelay` (DEV-217), so a pilot who pressed
 * at once saw it for the first few seconds of the climb and one who waited saw
 * it go before the press. FF2 keeps it for as long as you wait (a timer would
 * expire mid-read) and takes it away on the press. Both editions: one
 * predicate, and it moves Classic toward 2016 rather than away.
 *
 * A Quick Race's no-ride start never enters `rising` (`startLaunch` with
 * `skipRide` goes straight to `countdown`), so there the plate was already down
 * at the countdown and this changes nothing.
 */
export const briefingUp = (launch: BriefingLaunch | null, top: number): boolean =>
  briefingOpacity(launch, top) > 0

export interface BriefingState {
  /** The body copy. Wrapped here, so the caller need not know the width. */
  readonly text: string
  /** The heading — the mission's name, in the player's language not Unity's. */
  readonly title: string
  /**
   * DEV-631: the course's difficulty, drawn before the heading as the hangar's
   * ski mark (green square, blue circle, black diamond). Absent: no mark (the
   * Classic look, a course with no rank).
   */
  readonly mark?: SkiMarkShape | null
}

export interface Briefing {
  readonly object: THREE.Object3D
  setVisible(visible: boolean): void
  update(state: BriefingState): void
  /**
   * The whole plate's opacity, 0..1, over the plate's own alpha. DEV-377: the
   * lesson plate cross-fades two of these rather than popping one.
   */
  setOpacity(opacity: number): void
  dispose(): void
}

/**
 * Panel size in metres.
 *
 * Wider than the pause menu and shorter, because it is read once at a stop and
 * never aimed at — a paragraph wants line lengths, not targets.
 */
const WIDTH = 0.66
const HEIGHT = 0.22
const PIXELS_PER_METRE = UI_PIXELS_PER_METRE

// `wrapText` moved to `ui-draw.ts` (three-free, so the TV panel's layout can use it
// too); it stays exported from here for the callers and tests that name it.
export { wrapText }

/** The body's type, as a fraction of the plate's height: 2016's briefing reads at this. */
const BODY = 0.12
/** Line pitch, in body heights. */
const LEADING = 1.35
/** Where the first body line sits, and the lowest a line's centre may sit, as fractions of the height. */
const FIRST_LINE = 0.48
const LAST_LINE = 0.9
/** The smallest the body shrinks to before it overflows instead: two thirds of the full size. */
const SMALLEST = 0.08

/**
 * The body's size and its lines: the full size if the text fits in the lines
 * the plate has room for, else the largest smaller size that does, down to
 * {@link SMALLEST} — below which it overflows rather than become unreadable.
 *
 * DEV-377. 2016's briefing is two lines and never shrinks (it fits at the full
 * size, so this returns exactly what the plate drew before); a lesson prompt
 * can be three or four, and a fixed size would push the last one off the
 * plate. `measure` is injected, as `wrapText`'s is, so a test needs no canvas.
 */
export const fitBody = (
  text: string,
  maxWidth: number,
  height: number,
  measure: (px: number, s: string) => number,
): { px: number; lines: string[] } => {
  let px = height * BODY
  const floor = height * SMALLEST
  for (;;) {
    const size = px
    const lines = wrapText(text, maxWidth, (s) => measure(size, s))
    const room = Math.floor((height * (LAST_LINE - FIRST_LINE)) / (size * LEADING)) + 1
    if (lines.length <= room || size <= floor) return { px: size, lines }
    px = Math.max(floor, size * 0.9)
  }
}

/** A colour off the ski marks' table, as a canvas colour. */
const css = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`

/**
 * DEV-631: one ski mark, `size` across, centred at (x, y), on a white card a
 * third larger: the same shapes and colours the hangar's tables stand.
 */
const drawMark = (
  ctx: CanvasRenderingContext2D,
  shape: SkiMarkShape,
  x: number,
  y: number,
  size: number,
): void => {
  const path = (r: number) => {
    ctx.beginPath()
    if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2)
    else if (shape === 'diamond') {
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r, y)
      ctx.closePath()
    } else ctx.rect(x - r, y - r, r * 2, r * 2)
  }
  // A diamond's half-diagonal is its "radius"; a square's half-side reads the
  // same size beside it at 0.86 of that, as the hangar's geometry draws them.
  const r = shape === 'square' ? size * 0.43 : size * 0.5
  path(r * 1.34)
  ctx.fillStyle = INK
  ctx.fill()
  path(r)
  ctx.fillStyle = css(SKI_MARK_COLOURS[shape])
  ctx.fill()
}

export const createBriefing = (): Briefing => {
  // Unlit and untoned (`render/tone.ts`, DEV-081), through `ui-plate.ts`.
  const plate = createUiPlate({
    name: 'briefing',
    widthM: WIDTH,
    heightM: HEIGHT,
    renderOrder: 10, // with the HUD; the pause menu and results sit above
    pxPerM: PIXELS_PER_METRE,
  })
  const { canvas, ctx, object, material } = plate

  let signature = ''

  const draw = (state: BriefingState) => {
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // DEV-647: the same broadcast plate as every menu (it was a lighter local pair
    // that sat with the HUD; one plate is the point of the tokens).
    drawPlate(ctx, w, h, { bar: h * 0.035, lineWidth: Math.max(2, h * 0.008) })

    const pad = w * 0.05
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // DEV-631: the difficulty mark, on its white card as a trail sign is
    // (`render/ski-marks.ts` says why), then the heading after it.
    let titleX = pad
    if (state.mark) {
      const s = h * 0.15
      drawMark(ctx, state.mark, pad + s / 2, h * 0.22, s)
      titleX = pad + s * 1.45
    }
    ctx.fillStyle = ACCENT
    ctx.font = font(uiType(h * 0.16, PIXELS_PER_METRE).title)
    ctx.fillText(state.title.toUpperCase(), titleX, h * 0.22)

    ctx.fillStyle = INK
    const { px: bodyPx, lines } = fitBody(state.text, w - pad * 2, h, (px, s) => {
      ctx.font = font(px, 500)
      return ctx.measureText(s).width
    })
    ctx.font = font(bodyPx, 500)
    lines.forEach((line, i) => {
      ctx.fillText(line, pad, h * 0.48 + i * bodyPx * 1.35)
    })

    plate.commit()
  }

  return {
    object,
    setVisible(visible: boolean) {
      object.visible = visible
    },
    update(state: BriefingState) {
      const next = `${state.title}|${state.text}|${state.mark ?? ''}`
      if (next === signature) return
      signature = next
      draw(state)
    },
    setOpacity(opacity: number) {
      material.opacity = opacity
    },
    dispose() {
      plate.dispose()
    },
  }
}
