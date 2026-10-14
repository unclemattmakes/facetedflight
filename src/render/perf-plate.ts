// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/render/perf-plate.ts — the perf readout, in the cockpit, where a headset
// can actually read it.
//
// DEV-160, `docs/plan/VR-PERF.md` §5.5 D, gap 4. `boot/perf-hud.ts` prints every
// number this plate prints and prints them into the DOM, which means that in an
// immersive session there is nothing to see: *"`dom-overlay` is not reliably
// granted on Quest"* (CLAUDE.md), and where it is granted it composites as a
// flat layer fighting the stereo image. Every performance number this port has
// ever taken is a monitor at vsync (gap 1) for exactly this reason — the
// instrument could not go where the question is.
//
// ── Why it is parented to the SHIP, not the rig ───────────────────────────
//
// `render/hud.ts`'s header, and the reason is not about perf at all:
//
//   > A panel parented to the camera rig is head-locked: it follows your eyes
//   > and never moves relative to them. That is the single most reliable way to
//   > make someone ill in VR, because it removes the fixed reference the
//   > vestibular system is trying to agree with.
//
// A dev panel that makes the tester ill is a dev panel that shortens the
// measurement session it exists to serve. So this sits beside the HUD on the
// console, at the HUD's own tilt and scale, and you look at it.
//
// ── Why it never touches `layers` ─────────────────────────────────────────
//
// **Layers 1 and 2 are the WebXR eyes** (DEV-141): `WebXRManager` derives the
// eye cameras as `mask & -5` and `mask & -3`, so an object on layer 1 is ABSENT
// from the right eye. The whole readable UI shipped monocular that way and Matt
// found it in a headset. The mechanism that puts a surface on `UI_LAYER` is
// `render/bloom.ts`'s `classify()`, which keys on `material.toneMapped ===
// false` — nothing here calls `layers.set`, and `tests/unit/xr-eye-layers.test.ts`
// greps `src/` to keep it that way. `toneMapped: false` below is doing two jobs:
// it exempts a canvas-drawn sRGB texture from the Anniversary tone curve
// (`render/tone.ts`), and it is the classifier's entire input.
//
// ── Why the text comes in as strings ──────────────────────────────────────
//
// `boot/perf-format.ts` builds the ten rows and is three-free and DOM-free, so
// the FORMAT has a node test and this file has nothing left to get wrong but
// pixels. It also makes the redraw rule exact: the signature is the rows joined,
// so a texture upload happens when and only when a character changes. `app.ts`
// calls `update()` at 4 Hz; the canvas moves far less often than that.

import type * as THREE from 'three'
import { createUiPlate } from '@/render/ui-plate'
import { UI_MONO_STACK } from '@/render/ui-tokens'
import { type CanvasPanelReport, createPanelCounter, WIDTH as HUD_W, PIXELS_PER_METRE } from './hud'

/** The plate, in metres. Wider and taller than the HUD: ten rows of small type. */
export const PLATE_W = 0.36
export const PLATE_H = 0.24

/**
 * Which side of the HUD it sits on. −1 is the pilot's LEFT.
 *
 * Left because the right of the glareshield already carries the next-gate arrow
 * (DEV-124, `nextGateArrow.offset` is centred but the arrow swings), and because
 * a right-handed tester reaching for a controller does it on the right. Exported
 * so `app.ts` names the constant rather than a bare `-1`.
 */
export const PLATE_SIDE = -1 as const

/**
 * The gap between the two panels' near edges, metres.
 *
 * Small enough that they read as one instrument cluster and large enough that
 * neither is mistaken for a row of the other.
 */
export const PLATE_GAP = 0.03

/**
 * The rows the grid is laid out FOR — `perfPlateLines` returns exactly this
 * many, and at that count the plate looks the way it was designed to.
 *
 * **It is a FLOOR, not a cap.** `draw` divides by `max(ROWS, lines.length)`,
 * because `app.ts` appends live diagnostics — `xrInputLine()`, the frame-error
 * line — after the ten. Dividing by the constant put row index 10 at
 * `padY + rowH * 10.5`, which is past the bottom edge: **drawn, and off the
 * canvas.** Matt, wearing the Frame, from the session that was supposed to read
 * the controller mapping off it: *"i don't see anything about the buttons in
 * the perf panel. is it out of bounds from the perf panel?"* It was, exactly.
 *
 * The second half is worse than the missing row, and is why this is a floor
 * rather than a clamp on `lines`: the type-fitting loop below measures EVERY
 * line, so the invisible one still shrank the type on the nine that were
 * visible. An instrument that is harder to read because of a row you cannot see
 * is a bug with no symptom pointing at it.
 */
const ROWS = 10

/**
 * How many row slots the grid is divided into for `n` lines of text.
 *
 * Exported so the floor can be asserted without a canvas — `draw` needs a 2d
 * context and the unit suite runs in node, which is exactly how the clipped
 * row survived: the only thing that could see it was a human in a headset.
 */
export const plateRows = (n: number): number => Math.max(ROWS, n)

export type PlateSide = -1 | 1

/** The HUD's placement block — `EditionHudPlacement` is assignable as-is. */
export interface PlateHudPlacement {
  readonly offset: readonly [number, number, number]
  readonly tilt: number
  readonly scale: number
}

/**
 * The flying vehicle's eye, in ship space — `Flight.eye`.
 *
 * **Passed in rather than imported, and that is a correction to VR-PERF §5.5**,
 * which says "`flight.ts`'s `EYE`". There are TWO: `game/flight.ts`'s `EYE` is
 * the HoverJet's (0, 0.86, 1.27) and `game/jumpseat-flight.ts`'s `JUMPSEAT_EYE`
 * is its own, and six of the thirteen shipped missions fly the JumpSeat. A
 * module-level constant here would put the plate in the wrong place on those
 * six — and `Flight.eye` exists precisely so a caller never has to guess which
 * vehicle is flying.
 *
 * Structural, so a `THREE.Vector3` satisfies it without this file caring.
 */
export interface PlateEye {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface PerfPlate {
  readonly object: THREE.Object3D
  /**
   * Redraw, if and only if the rows differ from the ones on the canvas.
   *
   * Cheap to call with unchanged text: one join and one string compare.
   */
  update(lines: readonly string[], nowMs?: number): void
  /** Sit beside the HUD, at its tilt and scale, `side` of it. */
  place(hud: PlateHudPlacement, side: PlateSide, eye: PlateEye): void
  setVisible(visible: boolean): void
  /**
   * DEV-243. Repaints so far — the trace column, without `report()`'s
   * allocation.
   */
  readonly paints: number
  /**
   * DEV-243. The same counts `render/hud.ts` reports for the HUD, in the same
   * shape, on purpose.
   *
   * **This plate is the control for the HUD's finding.** Both are a
   * `CanvasTexture` on the flight object at the same pixel density, both
   * `toneMapped: false`, both on `UI_LAYER`, both one transparent quad — and
   * they differ in exactly two measurable ways: this one is 49 % MORE canvas
   * (504 × 336 against 560 × 203) and repaints at 4 Hz at most against the
   * HUD's ~frame rate. Queue H priced the pair at −0.30 p95 against −2.35, so
   * the bigger panel at a fraction of the rate costs a fraction of the cost:
   * it is the RATE, not the panel. `bytesPerSecond` is that argument as one
   * number. (`VR-PERF-WAVE-4.md` §3.5, `DEVIATIONS.md` DEV-243 §2b.)
   *
   * **And a consequence for every number this programme has taken**: this
   * plate exists only under `?perf=1` (`boot/app.ts`'s `PERF_HUD`), which is
   * every trace run and no player's session. Its ~0.3 ms of p95 is the
   * instrument, and no player pays it.
   */
  report(): CanvasPanelReport
  dispose(): void
}

// `boot/perf-hud.ts`'s palette, not `render/hud.ts`'s. The DOM panel and this
// plate print the same numbers and a reader should not have to work out which
// one they are looking at; and a dev instrument that looked like the game's own
// teal console would end up in a screenshot somebody files as art.
const INK = '#d8e2ee'
const HEAD = '#7fd1ff'
const BACK = 'rgba(14, 18, 26, 0.86)'
const EDGE = 'rgba(140, 200, 255, 0.28)'

/**
 * The x offset from the HUD's centre to the plate's, in the SHIP's frame.
 *
 * `HUD_W / 2 + PLATE_GAP + PLATE_W / 2` is half of each panel plus the gap —
 * the two near edges then sit `PLATE_GAP` apart, which is the thing that is
 * actually true and the thing a test can check. Times `hudScale` because both
 * panels are scaled by it: the HUD's DRAWN half-width is `HUD_W / 2 * scale`,
 * so an unscaled offset would overlap the HUD at any scale below 1 and leave a
 * growing gutter above it. At the shipped `scale: 1` (both editions) this is
 * §5.5's formula exactly; the factor only matters to a lookdev Placement drag
 * (DEV-129), which is the one way the number ever moves.
 *
 * Exported so the relationship can be asserted without a canvas — `tests/unit/
 * perf-plate.test.ts`. *Test the geometry, not the rotation* (CLAUDE.md).
 */
export const plateOffsetX = (hudScale: number, side: PlateSide): number =>
  side * (HUD_W / 2 + PLATE_GAP + PLATE_W / 2) * hudScale

export const createPerfPlate = (): PerfPlate => {
  // `ui-plate.ts`: the HUD's pixel density, so the two panels' type is the same
  // size on the retina at the same distance (0.36 x 0.24 m -> 504 x 336); sRGB
  // and anisotropy 4, because small type is read at a rake (the plate is tilted
  // with the HUD, so the far edge is always at a glancing angle); and the
  // material that exempts the plate from the Anniversary tone curve AND is the
  // only thing that puts it on `UI_LAYER` (`render/bloom.ts`'s `classify()`,
  // DEV-141), always legible for `render/hud.ts`'s reason: the cockpit will
  // happily occlude a panel's bottom edge, and an instrument you cannot read in
  // the one situation you need it is not an instrument. Safe because this is only
  // ever shown from inside the cockpit: `app.ts` hides it in third person.
  //
  // Ordered after the HUD (10), so where the two overlap during a Placement drag
  // the dev plate is the one on top, it is the thing being positioned. Hidden
  // until the first `update()`: an empty dark rectangle in the cockpit would be
  // a defect report.
  const plate = createUiPlate({
    name: 'perf-plate',
    widthM: PLATE_W,
    heightM: PLATE_H,
    renderOrder: 11,
    pxPerM: PIXELS_PER_METRE,
  })
  const { canvas, ctx, object } = plate

  let signature = ''
  // DEV-243. The SAME counter `render/hud.ts` keeps, so "repaints per second"
  // means one thing across both panels: a second definition on the control is
  // how a comparison between two instruments becomes a comparison of two
  // definitions.
  const counter = createPanelCounter()

  const draw = (lines: readonly string[]): void => {
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const padX = w * 0.026
    const padY = h * 0.028
    // See ROWS: a floor, so the shipped ten-row layout is untouched and an
    // eleventh row compresses the grid instead of falling off the bottom.
    const rowH = (h - padY * 2) / plateRows(lines.length)
    const radius = rowH * 0.5

    ctx.fillStyle = BACK
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, radius)
    ctx.fill()
    ctx.strokeStyle = EDGE
    ctx.lineWidth = Math.max(1, rowH * 0.06)
    ctx.stroke()

    // ── Type size is MEASURED, not assumed ───────────────────────────────
    //
    // The rows are not a fixed width: `DRAW 540 calls (2 eyes ≈ 270/eye) · 5.9M
    // tri · 41 prog` is half as long again as `MEM 812 geo · 33 tex`, and the
    // long one grows a digit the first time a soak runs somewhere busy. Picking
    // a size by counting characters would mean the plate silently clips the one
    // row that got interesting. So: start at the row height, measure the widest
    // line, and shrink until it fits. One `measureText` a line, at most four
    // times a second, only when the text changed.
    //
    // The consequence a row's AUTHOR has to know, because it is not local to
    // the row: the fit is over ALL of them, so a row that grows past the current
    // widest shrinks the type on the other nine. That is a legibility change to
    // an instrument read through a headset, and it is invisible in a node test
    // of the strings. DEV-179 added a fourth number to HITCH under that rule —
    // `· tier 73%` is eleven characters and leaves it well short of XR and
    // DRAW, which are the two that set the size. `tests/unit/perf-format.test.ts`
    // holds it: the row a change lands on must not become the longest.
    const face = UI_MONO_STACK
    const startPx = rowH * 0.66
    ctx.font = `${Math.round(startPx)}px ${face}`
    let widest = 0
    for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width)
    const available = w - padX * 2
    const fontPx = widest > available ? startPx * (available / widest) : startPx
    ctx.font = `${fontPx.toFixed(2)}px ${face}`

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    lines.forEach((line, i) => {
      // The first row is the WHICH-BUILD row. A frame-time reading with no
      // preset and no version on it is a number nobody can file
      // (`boot/perf-hud.ts` says the same about its own ED row), so it gets the
      // accent that says "read me first".
      ctx.fillStyle = i === 0 ? HEAD : INK
      // `maxWidth` as well as the fitted size: belt and braces, because a row
      // that somehow still overran would otherwise paint over the border.
      ctx.fillText(line, padX, padY + rowH * (i + 0.5), available)
    })

    plate.commit()
  }

  return {
    object,

    update(lines, nowMs = performance.now()) {
      // Every call, admitted or not — `seconds` is the panel's life, so the
      // rate is repaints per second of RUNNING. `boot/app.ts` only calls this
      // at 4 Hz and only while the plate is visible, so the window this rate
      // is over is the plate's visible life and not the session's; the trace's
      // `plate_paints` column is the authority for the in-flight rate, exactly
      // as `hud_paints` is for the HUD.
      counter.seen(nowMs)
      const next = lines.join('\n')
      if (next === signature) return
      signature = next
      counter.painted(nowMs)
      draw(lines)
    },

    place(hud, side, eye) {
      object.position.set(
        eye.x + hud.offset[0] + plateOffsetX(hud.scale, side),
        eye.y + hud.offset[1],
        eye.z + hud.offset[2],
      )
      object.rotation.set(hud.tilt, 0, 0)
      object.scale.setScalar(hud.scale)
    },

    setVisible(visible) {
      object.visible = visible
    },

    get paints() {
      return counter.repaints
    },

    report() {
      // `texture.version` is three's counter, not a second one of ours — the
      // same oracle `render/hud.ts` reads, for the same reason. So is
      // `texture.generateMipmaps` (DEV-244): the plate carries no upload lever
      // and its chain is therefore always on, but reading the flag rather than
      // passing `true` is what keeps `mipBytes` a statement about this texture
      // instead of an assumption about it.
      return counter.report(
        'perf-plate',
        canvas.width,
        canvas.height,
        plate.texture.version,
        plate.texture.generateMipmaps,
      )
    },

    dispose() {
      plate.dispose()
    },
  }
}
