// tests/unit/hud-gauges.test.ts — DEV-257's arm, and the pairing it turns on.
//
// ── What is being defended ───────────────────────────────────────────────
//
// `docs/plan/HUD-REDESIGN.md` §5.3: the four readings that force the HUD's
// canvas to raster are all CONTINUOUS quantities, and three of them were
// already drawn as plain `fillRect` bars. Moving them to geometry collapses
// the canvas's repaint rate to the clock. Five jobs here, and §2 is the one
// the whole row rests on:
//
//  1. **The arm is an ARM.** With `?hudGauges=off` — the default — nothing is
//     constructed, nothing joins the scene graph, and the panel is the one
//     that ships. `render/cockpit-interior.ts` makes the same promise for
//     Classic and it is stricter than "the flag is off".
//  2. **Both halves move, or neither.** The readings have to leave the canvas
//     draw AND leave `hudSignature` together. Out of the draw alone is the
//     cost with none of the benefit; out of the signature alone is a stale
//     panel, which is worse because it looks right. Asserted by driving the
//     REAL `draw()` through a recording canvas and comparing the op SEQUENCE
//     — not by reading the two functions and agreeing with myself.
//  3. **The geometry lands on the pixels the canvas was covering.** Read back
//     off the live `BufferAttribute`, converted to canvas pixels, and compared
//     against the arguments the real `draw()` passed to `fillRect` WITH THE
//     ARM DOWN. That is an expectation measured from the other implementation
//     rather than re-derived the way this one derives it (CLAUDE.md trap 24).
//  4. **Absent is not zero** (DEV-154). Absent draws nothing; 0 draws an empty
//     track. The canvas did not make that distinction for the proximity meter
//     until DEV-154 and the geometry must not lose it again.
//  5. **The geometry, not the rotation.** The needle is an oriented asymmetric
//     object and orientation bugs are a CLASS here with four instances, three
//     of them caught by Matt from a screenshot rather than by 400+ green
//     tests. So every needle assertion below is a distance, a length or an
//     ordering read off the mesh — never a quaternion, which is a belief
//     written twice.

import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DERIVED } from '@/generated/constants.generated'
import { isUiObject, UI_LAYER } from '@/render/bloom'
import {
  createHud,
  formatSpeed,
  HEIGHT,
  HUD_GAUGE_PALETTE,
  type Hud,
  type HudState,
  hudCanvasOps,
  hudSignature,
  hudSpeedText,
  PIXELS_PER_METRE,
  WIDTH,
} from '@/render/hud'
import {
  describeHudGauges,
  HUD_GAUGE_DIGIT_STEP,
  HUD_GAUGE_QUADS,
  HUD_GAUGE_SPEED_FULL_SCALE,
  HUD_GAUGE_TICKS,
  HUD_GAUGES_OFF,
  type HudGauges,
  hudGaugeCoarsenSpeed,
  hudGaugeRects,
  hudGaugesKeepDigits,
  hudGaugesOn,
  hudPanelLayout,
  parseHudGauges,
  sameHudGauges,
} from '@/render/hud-gauges'
import { terminalSpeed } from '@/sim/speed-chain'

/**
 * How close two canvas-pixel readings have to be, given that the trip goes
 * through a `Float32Array`.
 *
 * **Derived, not tuned until it passed.** A vertex is stored as float32, whose
 * relative epsilon is 1.19e-7; the panel's local coordinates are at most
 * `WIDTH / 2` = 0.2 m, so the absolute storage error is at most ~2.4e-8 m, and
 * multiplying back by `PIXELS_PER_METRE` = 1400 makes that ~3.4e-5 canvas
 * pixels. 1e-3 is thirty times that headroom and still four orders of
 * magnitude inside one pixel, so it cannot hide a placement bug — the first
 * pass at this file used 1e-6 and failed on the round trip alone, which is
 * a fact about the storage and not about the geometry.
 */
const PX = 1e-3

const BAR: HudGauges = { kind: 'bar', digits: true }
const NEEDLE: HudGauges = { kind: 'needle', digits: true }
const BAR_ONLY: HudGauges = { kind: 'bar', digits: false }

// ── The recording canvas ───────────────────────────────────────────────────
//
// `hud-upload.test.ts`'s counting stub, with the arguments kept. It counts
// because it is asking *how much did one repaint ask of the backend*; this one
// records because it is asking *WHAT did the repaint draw* — which is the
// question both §2 and §3 turn on, and neither can be answered by a total.

interface Recorded {
  /** Every context method call, as `name(args…)`, in order. */
  readonly calls: string[]
  /** Just the `fillRect`s, with their arguments, in order. */
  readonly rects: { x: number; y: number; w: number; h: number; fill: string }[]
}

const installCanvas = (): Recorded => {
  const rec: Recorded = { calls: [], rects: [] }
  const context: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
  }
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      rec.calls.push(`${name}(${args.join(',')})`)
    }
  for (const name of ['clearRect', 'beginPath', 'roundRect', 'fill', 'stroke']) {
    context[name] = log(name)
  }
  context.fillRect = (x: number, y: number, w: number, h: number) => {
    rec.calls.push(`fillRect(${x},${y},${w},${h}) ${String(context.fillStyle)}`)
    rec.rects.push({ x, y, w, h, fill: String(context.fillStyle) })
  }
  context.fillText = (...args: unknown[]) => {
    rec.calls.push(`fillText(${args.join(',')})`)
  }
  context.measureText = (s: string) => {
    rec.calls.push(`measureText(${s})`)
    return { width: s.length * 8 }
  }
  const element = { width: 0, height: 0, getContext: () => context }
  vi.stubGlobal('document', { createElement: () => element })
  return rec
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** A mid-run HoverJet panel with every optional reading live. */
const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 112,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: false,
  chain: { stacks: 3, fraction: 0.62 },
  energy: { fraction: 0.55, available: true },
  ...over,
})

/** The gauge mesh hanging off a panel, or null when the arm is down. */
const meshOf = (hud: Hud): THREE.Mesh | null => {
  const found = hud.object.children.find((c) => c.name === 'hud-gauges')
  return (found as THREE.Mesh | undefined) ?? null
}

/**
 * The live quads, read back off the attribute and returned to CANVAS PIXELS.
 *
 * The inverse of the mapping `createHudGauges` applies, written out here so
 * that §3 compares a number in the canvas's own units against the canvas's own
 * `fillRect` arguments. Collapsed quads (DEV-154's "nothing") are dropped.
 */
const quadsInPixels = (
  mesh: THREE.Mesh,
): { x: number; y: number; w: number; h: number; corners: number[] }[] => {
  const pos = mesh.geometry.getAttribute('position')
  const out: { x: number; y: number; w: number; h: number; corners: number[] }[] = []
  for (let q = 0; q < pos.count / 4; q += 1) {
    const corners: number[] = []
    for (let c = 0; c < 4; c += 1) {
      const i = q * 4 + c
      corners.push(
        (pos.getX(i) + WIDTH / 2) * PIXELS_PER_METRE,
        (HEIGHT / 2 - pos.getY(i)) * PIXELS_PER_METRE,
      )
    }
    const xs = [corners[0], corners[2], corners[4], corners[6]] as number[]
    const ys = [corners[1], corners[3], corners[5], corners[7]] as number[]
    const w = Math.max(...xs) - Math.min(...xs)
    const h = Math.max(...ys) - Math.min(...ys)
    // A collapsed quad is four identical vertices: zero extent both ways.
    if (w === 0 && h === 0) continue
    out.push({ x: Math.min(...xs), y: Math.min(...ys), w, h, corners })
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────────

describe('§0 the switch parses, round-trips, and refuses the other pins words', () => {
  it('reads every spelling a shell command plausibly carries', () => {
    for (const raw of ['off', 'OFF', ' none ']) {
      expect(parseHudGauges(raw), raw).toEqual({ kind: 'off' })
    }
    for (const raw of ['on', 'bar', 'BARS', ' Bar ']) {
      expect(parseHudGauges(raw), raw).toEqual({ kind: 'bar', digits: true })
    }
    for (const raw of ['needle', 'NEEDLE']) {
      expect(parseHudGauges(raw), raw).toEqual({ kind: 'needle', digits: true })
    }
    for (const raw of ['bar-only', 'bar_only', 'barOnly', 'BARS ONLY']) {
      expect(parseHudGauges(raw), raw).toEqual({ kind: 'bar', digits: false })
    }
    for (const raw of ['needle-only', 'needleOnly']) {
      expect(parseHudGauges(raw), raw).toEqual({ kind: 'needle', digits: false })
    }
  })

  it('round-trips through describeHudGauges, which is what makes an e2e check comparable', () => {
    // The mechanism check compares an ASK against a READING by string. An
    // accepted spelling that failed to land on its canonical token would make
    // the arm refuse itself on a spelling — DEV-243's `10` / `10hz` lesson.
    for (const raw of ['off', 'on', 'bar', 'needle', 'barOnly', 'needle-only']) {
      const parsed = parseHudGauges(raw)
      expect(parsed, raw).not.toBeNull()
      const spelled = describeHudGauges(parsed as NonNullable<typeof parsed>)
      expect(parseHudGauges(spelled), `${raw} -> ${spelled}`).toEqual(parsed)
      expect(['off', 'bar', 'needle', 'bar-only', 'needle-only']).toContain(spelled)
    }
  })

  it('REFUSES the other two pins vocabulary rather than guessing', () => {
    // There are three pins on this one panel now. `?hudRedraw=live` and
    // `?hudUpload=nomip` mean things, and a word from one silently accepted by
    // another is the trap `parseHudUpload`'s header spells out at length.
    for (const raw of ['live', 'freeze', 'mip', 'nomip', '10hz', 'yes', '']) {
      expect(parseHudGauges(raw), raw).toBeNull()
    }
    expect(parseHudGauges(null)).toBeNull()
    expect(parseHudGauges(undefined)).toBeNull()
  })

  it('answers the two questions the draw asks, separately', () => {
    expect(hudGaugesOn(HUD_GAUGES_OFF)).toBe(false)
    expect(hudGaugesKeepDigits(HUD_GAUGES_OFF)).toBe(false)
    expect(hudGaugesOn(BAR_ONLY)).toBe(true)
    expect(hudGaugesKeepDigits(BAR_ONLY)).toBe(false)
    expect(hudGaugesOn(BAR)).toBe(true)
    expect(hudGaugesKeepDigits(BAR)).toBe(true)
  })

  it('compares two modes without collapsing the digit half', () => {
    expect(sameHudGauges(BAR, BAR)).toBe(true)
    expect(sameHudGauges(BAR, BAR_ONLY)).toBe(false)
    expect(sameHudGauges(BAR, NEEDLE)).toBe(false)
    expect(sameHudGauges(HUD_GAUGES_OFF, HUD_GAUGES_OFF)).toBe(true)
  })
})

describe('§1 the arm is an ARM — off constructs nothing', () => {
  it('adds no child, no geometry and no material with the flag down', () => {
    installCanvas()
    const hud = createHud()
    expect(hud.object.children).toHaveLength(0)
    expect(meshOf(hud)).toBeNull()
    hud.update(state(), 0)
    expect(hud.object.children).toHaveLength(0)
    const report = hud.report()
    expect(report.gauges).toBe('off')
    expect(report.gaugeQuads).toBe(0)
    hud.dispose()
  })

  it('draws the shipped panel byte for byte with the flag down', () => {
    // The pixel gate is an e2e screenshot diff; this is its unit-level
    // counterpart and it is the one that runs in CI. The claim is narrow and
    // exact: the recorded call SEQUENCE with a default `createHud()` is the
    // same one an explicit `off` produces, so nothing about this row changed
    // the default path.
    const a = installCanvas()
    const hudA = createHud()
    hudA.update(state(), 0)
    const withDefault = [...a.calls]
    hudA.dispose()

    vi.unstubAllGlobals()
    const b = installCanvas()
    const hudB = createHud({ gauges: HUD_GAUGES_OFF })
    hudB.update(state(), 0)
    hudB.dispose()

    expect(b.calls).toEqual(withDefault)
    expect(withDefault.length).toBeGreaterThan(0)
  })

  it('constructs on the way UP and disposes on the way back down', () => {
    installCanvas()
    const hud = createHud()
    expect(meshOf(hud)).toBeNull()
    hud.setGauges(BAR)
    expect(meshOf(hud)).not.toBeNull()
    hud.setGauges(HUD_GAUGES_OFF)
    expect(meshOf(hud)).toBeNull()
    expect(hud.report().gaugeQuads).toBe(0)
    hud.dispose()
  })

  it('is a NO-OP when the mode is already in force — app.ts calls it every frame', () => {
    // Unguarded this would dispose and rebuild a BufferGeometry and a Material
    // ninety times a second. The observable is object IDENTITY: the same mesh
    // has to survive a re-assert.
    installCanvas()
    const hud = createHud({ gauges: BAR })
    const first = meshOf(hud)
    for (let i = 0; i < 10; i += 1) hud.setGauges({ kind: 'bar', digits: true })
    expect(meshOf(hud)).toBe(first)
    hud.dispose()
  })
})

describe('§2 BOTH halves move, or neither — the pairing', () => {
  /**
   * Two states that differ ONLY in the four continuous readings.
   *
   * This is the discriminating pair. With the arm up the panel must not care
   * that any of these moved: not the signature (or it repaints for nothing)
   * and not the draw (or it paints a bar it no longer owns). With the arm down
   * it must care about all of them, which is the control — a test that only
   * checked the "on" half would pass on a build that had removed the readings
   * from the canvas entirely.
   */
  const quiet = state({
    chain: { stacks: 3, fraction: 0.05 },
    energy: { fraction: 0.05, available: true },
    speed: 40,
  })
  const loud = state({
    chain: { stacks: 3, fraction: 0.95 },
    energy: { fraction: 0.95, available: false },
    speed: 41,
  })

  it('the signature STOPS MOVING for all four, with the arm up', () => {
    for (const mode of [BAR, NEEDLE, BAR_ONLY]) {
      expect(hudSignature(quiet, mode), describeHudGauges(mode)).toBe(hudSignature(loud, mode))
    }
  })

  it('and still moves for all four with the arm DOWN — the control', () => {
    expect(hudSignature(quiet)).not.toBe(hudSignature(loud))
  })

  it('the real draw() produces an IDENTICAL call sequence for both, with the arm up', () => {
    // The other half, and it is measured rather than reasoned: the actual
    // `draw()` runs through a recording canvas and the two op sequences are
    // compared verbatim, arguments included. A bar left behind in the canvas
    // would differ by a `fillRect`; a colour left behind would differ by its
    // `fillStyle`.
    for (const mode of [BAR, NEEDLE, BAR_ONLY]) {
      vi.unstubAllGlobals()
      const a = installCanvas()
      const hudA = createHud({ gauges: mode })
      hudA.update(quiet, 0)
      const first = [...a.calls]
      hudA.dispose()

      vi.unstubAllGlobals()
      const b = installCanvas()
      const hudB = createHud({ gauges: mode })
      hudB.update(loud, 0)
      hudB.dispose()

      expect(b.calls, describeHudGauges(mode)).toEqual(first)
    }
  })

  it('and DIFFERS for both with the arm down — the control again', () => {
    const a = installCanvas()
    const hudA = createHud()
    hudA.update(quiet, 0)
    const first = [...a.calls]
    hudA.dispose()

    vi.unstubAllGlobals()
    const b = installCanvas()
    const hudB = createHud()
    hudB.update(loud, 0)
    hudB.dispose()

    expect(b.calls).not.toEqual(first)
  })

  it('the panel does NOT repaint when only a continuous reading moved', () => {
    // The consequence the whole row is for, stated as the behaviour rather
    // than as the mechanism: with the arm up, a frame in which only the four
    // gauges moved costs no canvas raster at all.
    installCanvas()
    const hud = createHud({ gauges: BAR })
    hud.update(quiet, 0)
    const after = hud.report().repaints
    for (let i = 1; i <= 20; i += 1) {
      hud.update(
        state({
          chain: { stacks: 3, fraction: 1 - i / 20 },
          energy: { fraction: i / 20, available: true },
          speed: 40,
        }),
        i * 1000,
      )
    }
    expect(hud.report().repaints).toBe(after)
    hud.dispose()
  })

  it('but the CLOCK still repaints it, which is the rate that remains', () => {
    installCanvas()
    const hud = createHud({ gauges: BAR_ONLY })
    hud.update(state({ elapsed: 10 }), 0)
    const after = hud.report().repaints
    hud.update(state({ elapsed: 11 }), 1000)
    expect(hud.report().repaints).toBe(after + 1)
    hud.dispose()
  })

  it('and so does the GATE COUNT and the chain STACK badge, which stay text', () => {
    // `stacks` is the `+N` in the corner and it is still drawn on the canvas,
    // so freezing it along with the cooldown fraction would leave that badge a
    // gate behind. The split has to be exact.
    expect(hudSignature(state({ ringsPassed: 7 }), BAR)).not.toBe(
      hudSignature(state({ ringsPassed: 8 }), BAR),
    )
    expect(hudSignature(state({ chain: { stacks: 3, fraction: 0.5 } }), BAR)).not.toBe(
      hudSignature(state({ chain: { stacks: 4, fraction: 0.5 } }), BAR),
    )
  })
})

describe('§3 hudCanvasOps still predicts the real draw, at every mode', () => {
  it('matches the recorded total for both vehicles and all four modes', () => {
    // `hudCanvasOps` mirrors `draw()` branch for branch, which is exactly the
    // kind of prediction that drifts — its own comment says the mirroring is
    // "a liability held by a test rather than by care". DEV-257 added branches
    // to both and this is what keeps the contract.
    const cases: [string, HudState][] = [
      ['hoverjet', state()],
      ['jumpseat', state({ chain: undefined, timeLimit: 0 })],
      ['classic', state({ chain: undefined, energy: undefined })],
      [
        'empty bars',
        state({
          chain: { stacks: 2, fraction: 0 },
          energy: { fraction: 0, available: false },
        }),
      ],
      ['award', state({ award: 'PERFECT', awardTone: 'gain', multiplier: 3, autopilot: true })],
      ['banner', state({ banner: '3' })],
    ]
    for (const mode of [HUD_GAUGES_OFF, BAR, NEEDLE, BAR_ONLY]) {
      for (const [name, s] of cases) {
        vi.unstubAllGlobals()
        const rec = installCanvas()
        const hud = createHud({ gauges: mode })
        hud.update(s, 0)
        hud.dispose()
        const predicted = hudCanvasOps(s, mode)
        expect(rec.calls.length, `${describeHudGauges(mode)} / ${name}`).toBe(predicted.total)
      }
    }
  })

  it('reports FEWER canvas ops with the arm up — the saving, as a count', () => {
    // The evidence for the row, and it is a COUNT rather than a duration,
    // which is what makes it takeable on a contended box.
    const s = state()
    const off = hudCanvasOps(s, HUD_GAUGES_OFF)
    expect(hudCanvasOps(s, BAR).total).toBeLessThan(off.total)
    // Four fillRects leave (the combo's track + fill since DEV-615, the
    // tank's track + fill), and since DEV-410's follow-up the tank's BOOST
    // word with them; the digits stay. (Six before DEV-615, when five rects
    // left: the proximity meter's two, the tank's two and the chain's one.)
    expect(off.total - hudCanvasOps(s, BAR).total).toBe(5)
    // …and one more text with the digits gone.
    expect(off.total - hudCanvasOps(s, BAR_ONLY).total).toBe(6)
  })
})

describe('§4 the geometry lands on the pixels the canvas was covering', () => {
  it('reproduces the canvas own fillRect arguments for the ported bars', () => {
    // THE measured expectation. `draw()` runs with the arm DOWN through the
    // recording canvas; the quads are then read back off the live attribute
    // and converted to canvas pixels. Neither side re-derives the other's
    // arithmetic — one is a recording of the shipped implementation.
    const s = state()
    const rec = installCanvas()
    const off = createHud()
    off.update(s, 0)
    off.dispose()
    const drawn = rec.rects

    vi.unstubAllGlobals()
    installCanvas()
    const on = createHud({ gauges: BAR })
    on.update(s, 0)
    const mesh = meshOf(on)
    expect(mesh).not.toBeNull()
    const quads = quadsInPixels(mesh as THREE.Mesh)

    // The canvas drew four rects (the combo's two and the tank's two, since
    // DEV-615); the geometry carries those four plus the two the new speed
    // gauge adds.
    expect(drawn).toHaveLength(4)
    expect(quads).toHaveLength(6)
    for (const want of drawn) {
      const hit = quads.find(
        (q) =>
          Math.abs(q.x - want.x) < PX &&
          Math.abs(q.y - want.y) < PX &&
          Math.abs(q.w - want.w) < PX &&
          Math.abs(q.h - want.h) < PX,
      )
      expect(
        hit,
        `canvas drew ${want.x},${want.y} ${want.w}x${want.h} (${want.fill})`,
      ).toBeDefined()
    }
    on.dispose()
  })

  it('keeps every quad inside the panel', () => {
    // A gauge that ran off the plate would be geometry floating in the
    // cockpit. Checked over the extremes of every reading and both forms,
    // because the needle's arc is the one that could reach outside.
    for (const mode of [BAR, NEEDLE]) {
      for (const speed of [
        0,
        1,
        45,
        90,
        HUD_GAUGE_SPEED_FULL_SCALE,
        HUD_GAUGE_SPEED_FULL_SCALE * 3,
      ]) {
        vi.unstubAllGlobals()
        installCanvas()
        const hud = createHud({ gauges: mode })
        hud.update(
          state({
            speed,
            chain: { stacks: 9, fraction: 1 },
            energy: { fraction: 1, available: true },
          }),
          0,
        )
        const pos = (meshOf(hud) as THREE.Mesh).geometry.getAttribute('position')
        for (let i = 0; i < pos.count; i += 1) {
          expect(
            Math.abs(pos.getX(i)),
            `${describeHudGauges(mode)} @${speed} x`,
          ).toBeLessThanOrEqual(WIDTH / 2 + 1e-9)
          expect(
            Math.abs(pos.getY(i)),
            `${describeHudGauges(mode)} @${speed} y`,
          ).toBeLessThanOrEqual(HEIGHT / 2 + 1e-9)
        }
        hud.dispose()
      }
    }
  })

  it('puts the speed gauge on the speed row, and the combo on the count row (DEV-615)', () => {
    // A geometric claim, checked against the canvas's own coordinates rather
    // than against a number typed here: the speed gauge must be inside row 2,
    // and the gate combo's bar inside row 0, where the canvas paints it.
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const rects = hudGaugeRects(state(), layout, HUD_GAUGE_PALETTE, BAR, HUD_GAUGE_SPEED_FULL_SCALE)
    const speed = rects.find((r) => r.id === 'speed')
    const chain = rects.find((r) => r.id === 'chain')
    expect(speed).toBeDefined()
    expect(chain).toBeDefined()
    const rowTop = (row: number) => row * (layout.rowH + layout.gap)
    expect((speed as { y: number }).y).toBeGreaterThan(rowTop(2))
    expect((speed as { y: number; h: number }).y + (speed as { h: number }).h).toBeLessThan(
      rowTop(2) + layout.rowH,
    )
    expect((chain as { y: number }).y).toBeGreaterThan(rowTop(0))
    expect((chain as { y: number; h: number }).y + (chain as { h: number }).h).toBeLessThan(
      rowTop(0) + layout.rowH,
    )
  })
})

describe('§5 absent is not zero — DEV-154, kept', () => {
  it('draws NOTHING at all for a reading that is absent', () => {
    installCanvas()
    const hud = createHud({ gauges: BAR })
    hud.update(state({ chain: undefined, energy: undefined }), 0)
    const ids = quadsInPixels(meshOf(hud) as THREE.Mesh)
    // Only the speed gauge's track and fill survive: there is no vehicle
    // without a speed, so that one is always present.
    expect(ids).toHaveLength(2)
    hud.dispose()
  })

  it('draws an EMPTY TRACK for a reading that is zero', () => {
    installCanvas()
    const hud = createHud({ gauges: BAR })
    hud.update(
      state({
        speed: 0,
        chain: { stacks: 3, fraction: 0 },
        energy: { fraction: 0, available: false },
      }),
      0,
    )
    const quads = quadsInPixels(meshOf(hud) as THREE.Mesh)
    // Three tracks (the combo's, the tank's, the speed's) and not one fill.
    // The combo has its track only while one is banked (DEV-615).
    expect(quads).toHaveLength(3)
    hud.dispose()
  })

  it('states the distinction the way the field comment does', () => {
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const ids = (over: Partial<HudState>): string[] =>
      hudGaugeRects(state(over), layout, HUD_GAUGE_PALETTE, BAR, HUD_GAUGE_SPEED_FULL_SCALE).map(
        (r) => r.id,
      )
    expect(ids({ chain: undefined })).not.toContain('chain-track')
    expect(ids({ chain: { stacks: 0, fraction: 0 } })).not.toContain('chain-track')
    expect(ids({ chain: { stacks: 1, fraction: 0 } })).toContain('chain-track')
    expect(ids({ chain: { stacks: 1, fraction: 0 } })).not.toContain('chain')
    expect(ids({ energy: undefined })).not.toContain('energy-track')
    expect(ids({ energy: { fraction: 0, available: true } })).toContain('energy-track')
  })

  it('inks a locked-out tank differently from a charging one', () => {
    // An empty tank and a locked-out tank look identical and are not. The
    // canvas made that distinction in colour and the geometry has to keep it.
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const ink = (available: boolean): string | undefined =>
      hudGaugeRects(
        state({ energy: { fraction: 0.5, available } }),
        layout,
        HUD_GAUGE_PALETTE,
        BAR,
        HUD_GAUGE_SPEED_FULL_SCALE,
      ).find((r) => r.id === 'energy')?.colour
    // DEV-567: out is the warm ink, not a second pale cyan.
    expect(ink(true)).toBe(HUD_GAUGE_PALETTE.charge)
    expect(ink(false)).toBe(HUD_GAUGE_PALETTE.boostOut)
    expect(ink(true)).not.toBe(ink(false))
    const track = (available: boolean): string | undefined =>
      hudGaugeRects(
        state({ energy: { fraction: 0, available } }),
        hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE),
        HUD_GAUGE_PALETTE,
        BAR,
        HUD_GAUGE_SPEED_FULL_SCALE,
      ).find((r) => r.id === 'energy-track')?.colour
    expect(track(true)).toBe(HUD_GAUGE_PALETTE.tankTrack)
    expect(track(false)).toBe(HUD_GAUGE_PALETTE.boostOutTrack)
  })

  it('DEV-567: the canvas and the arm agree on the tank, mark and all, while boost is out', () => {
    // The arm's rects against the lens canvas's own fillRects, for the one
    // state that draws three of them.
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const energy = { fraction: 0.15, available: false, burning: false, reengage: 0.25 }
    const ids = hudGaugeRects(
      state({ energy }),
      layout,
      HUD_GAUGE_PALETTE,
      BAR,
      HUD_GAUGE_SPEED_FULL_SCALE,
    ).filter((r) => r.id.startsWith('energy'))
    expect(ids.map((r) => r.id)).toEqual(['energy-track', 'energy', 'energy-mark'])
    const mark = ids[2]
    expect(mark?.colour).toBe(HUD_GAUGE_PALETTE.ink)
    expect((mark?.x ?? 0) + (mark?.w ?? 0) / 2).toBeCloseTo(
      layout.padX + (layout.w - layout.padX * 2) * 0.25,
      9,
    )
  })

  it('clamps out of range rather than drawing past the track', () => {
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const full = layout.w - layout.padX * 2
    const over = hudGaugeRects(
      state({ chain: { stacks: 2, fraction: 4 }, speed: HUD_GAUGE_SPEED_FULL_SCALE * 9 }),
      layout,
      HUD_GAUGE_PALETTE,
      BAR,
      HUD_GAUGE_SPEED_FULL_SCALE,
    )
    expect(over.find((r) => r.id === 'chain')?.w).toBeCloseTo(full, 9)
    expect(over.find((r) => r.id === 'speed')?.w).toBeCloseTo(full, 9)
    const under = hudGaugeRects(
      state({ chain: { stacks: 2, fraction: -3 } }),
      layout,
      HUD_GAUGE_PALETTE,
      BAR,
      HUD_GAUGE_SPEED_FULL_SCALE,
    )
    expect(under.map((r) => r.id)).not.toContain('chain')
    expect(under.map((r) => r.id)).toContain('chain-track')
  })
})

describe('§6 the needle — the GEOMETRY, never the rotation', () => {
  /** The blade quad, which is always the last one written in needle form. */
  const bladeOf = (hud: Hud): number[] => {
    const quads = quadsInPixels(meshOf(hud) as THREE.Mesh)
    return quads[quads.length - 1]?.corners ?? []
  }
  const bladeAt = (speed: number): number[] => {
    vi.unstubAllGlobals()
    installCanvas()
    const hud = createHud({ gauges: NEEDLE })
    hud.update(state({ speed }), 0)
    const corners = bladeOf(hud)
    hud.dispose()
    return corners
  }
  /** Midpoint of the two corners at the far end of the blade. */
  const tip = (c: number[]): [number, number] => [
    ((c[0] as number) + (c[2] as number)) / 2,
    ((c[1] as number) + (c[3] as number)) / 2,
  ]
  const root = (c: number[]): [number, number] => [
    ((c[4] as number) + (c[6] as number)) / 2,
    ((c[5] as number) + (c[7] as number)) / 2,
  ]
  const len = (c: number[]): number => Math.hypot(tip(c)[0] - root(c)[0], tip(c)[1] - root(c)[1])

  it('is the SAME BLADE at every speed — a rotation, not a stretch', () => {
    // The assertion that is true independently of what I believed about the
    // maths. If the blade changed length across the sweep it would not be a
    // needle turning on a pivot, whatever the quaternion said.
    const lengths = [0, 0.25, 0.5, 0.75, 1].map((f) => len(bladeAt(f * HUD_GAUGE_SPEED_FULL_SCALE)))
    for (const l of lengths) expect(Math.abs(l - (lengths[0] as number))).toBeLessThan(PX)
    expect(lengths[0] as number).toBeGreaterThan(0)
  })

  it('sweeps left to right, monotonically, with speed', () => {
    const xs = [0, 0.25, 0.5, 0.75, 1].map((f) => tip(bladeAt(f * HUD_GAUGE_SPEED_FULL_SCALE))[0])
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i] as number, `step ${i}`).toBeGreaterThan(xs[i - 1] as number)
    }
    // SYMMETRIC about its own midpoint, which is a relationship and stays true
    // whatever the scale is centred on. The first version of this assertion
    // pinned the midpoint to the middle of the PANEL, and it went red the
    // moment a frame showed the blade sitting on the `6` of `660 km/h` and the
    // scale had to move left into the gap between the two texts. A value
    // assertion had to be edited to follow the code; this one did not.
    const mid = ((xs[0] as number) + (xs[4] as number)) / 2
    expect(Math.abs((xs[2] as number) - mid)).toBeLessThan(PX)
    // And the whole sweep clears both of the row's texts — the LABEL on the
    // left and the longest shipped VALUE on the right (`660 km/h`, which is
    // the string that caught this). Bounds in panel fractions, because that is
    // what the collision is about.
    const wPx = WIDTH * PIXELS_PER_METRE
    expect(Math.min(...xs) / wPx, 'the sweep runs into SPEED:').toBeGreaterThan(0.26)
    expect(Math.max(...xs) / wPx, 'the sweep runs into the value').toBeLessThan(0.6)
  })

  it('ARCS — the two ends dip by the same amount and the middle is highest', () => {
    // The tell that separates a needle from a marker sliding along a rail, and
    // it is a symmetry rather than an angle: a bug in the pivot would break
    // the equality, a bug in the radius would break the ordering.
    const ys = [0, 0.5, 1].map((f) => tip(bladeAt(f * HUD_GAUGE_SPEED_FULL_SCALE))[1])
    expect(Math.abs((ys[0] as number) - (ys[2] as number))).toBeLessThan(PX)
    // Canvas y runs DOWN, so "highest" is the smallest — and the dip has to be
    // a real one rather than a rounding, or a flat rail would pass this.
    expect((ys[0] as number) - (ys[1] as number)).toBeGreaterThan(1)
  })

  it('draws its scale as static graduations that do not move with the reading', () => {
    vi.unstubAllGlobals()
    installCanvas()
    const slow = createHud({ gauges: NEEDLE })
    slow.update(state({ speed: 10 }), 0)
    const a = quadsInPixels(meshOf(slow) as THREE.Mesh)
    slow.update(state({ speed: 170 }), 16)
    const b = quadsInPixels(meshOf(slow) as THREE.Mesh)
    // Everything but the blade is unchanged; the blade is the last quad.
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length - 1; i += 1) {
      expect(b[i]?.corners, `quad ${i}`).toEqual(a[i]?.corners)
    }
    expect(b[b.length - 1]?.corners).not.toEqual(a[a.length - 1]?.corners)
    slow.dispose()
  })

  it('fits its ticks and its blade in the pool, with room for the bars', () => {
    // A pool that overflowed would silently drop the blade — the reading — and
    // keep the scale, which is the failure that looks like a working gauge.
    expect(HUD_GAUGE_QUADS).toBeGreaterThanOrEqual(HUD_GAUGE_TICKS + 1 + 5)
    installCanvas()
    const hud = createHud({ gauges: NEEDLE })
    // The most bars at once: a live combo (track + fill, DEV-615) and a tank
    // that is out and refilling (track, fill and the quarter mark, DEV-567).
    hud.update(
      state({ energy: { fraction: 0.15, available: false, burning: false, reengage: 0.25 } }),
      0,
    )
    expect(hud.report().gaugeQuads).toBe(HUD_GAUGE_TICKS + 1 + 5)
    expect(hud.report().gaugeQuads).toBeLessThanOrEqual(HUD_GAUGE_QUADS)
    hud.dispose()
  })
})

describe('§7 one draw call, on a layer both eyes can see', () => {
  it('is ONE mesh with ONE material and ONE index buffer', () => {
    // §5.3's budget: one extra draw against the 121 the reveal reaches. Four
    // meshes would be four, and in a session there is no separate UI pass to
    // hide them in — `bloom.ts:436` returns false on `isPresenting`.
    installCanvas()
    const hud = createHud({ gauges: NEEDLE })
    hud.update(state(), 0)
    const meshes: THREE.Mesh[] = []
    hud.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'hud-gauges') meshes.push(o as THREE.Mesh)
    })
    expect(meshes).toHaveLength(1)
    const mesh = meshes[0] as THREE.Mesh
    expect(Array.isArray(mesh.material)).toBe(false)
    expect(mesh.geometry.getIndex()).not.toBeNull()
    expect(mesh.geometry.groups).toHaveLength(0)
    hud.dispose()
  })

  it('reaches BOTH EYES — DEV-141, by the mechanism bloom actually uses', () => {
    // `UI_LAYER` is 3 because layers 1 and 2 are the WebXR eyes and an object
    // on one is ABSENT from the other. This mesh never names a layer: it is
    // `toneMapped: false`, and that flag IS what `bloom.ts`'s `classify()`
    // keys on. So the guard is that `isUiObject` accepts it — which is what
    // stops somebody deleting the flag as redundant.
    installCanvas()
    const hud = createHud({ gauges: BAR })
    const mesh = meshOf(hud) as THREE.Mesh
    expect(isUiObject(mesh)).toBe(true)
    expect(UI_LAYER).toBeGreaterThanOrEqual(3)
    // And a CHILD of the panel, which is what makes the traverse classify both
    // in one pass — the failure that would matter is them being classified
    // apart, and a traverse cannot do that.
    expect(mesh.parent).toBe(hud.object)
    hud.dispose()
  })

  it('wears the panel own material treatment, and needs no shader patch', () => {
    installCanvas()
    const hud = createHud({ gauges: BAR })
    const mesh = meshOf(hud) as THREE.Mesh
    const material = mesh.material as THREE.MeshBasicMaterial
    expect(material.toneMapped).toBe(false)
    expect(material.depthTest).toBe(false)
    expect(material.depthWrite).toBe(false)
    expect(material.transparent).toBe(true)
    expect(material.vertexColors).toBe(true)
    // No `onBeforeCompile`, so no `tagProgramCacheKey` is owed (DEV-194).
    expect(material.onBeforeCompile.toString()).toBe(
      new THREE.MeshBasicMaterial().onBeforeCompile.toString(),
    )
    // itemSize 4, which is what makes three define `USE_COLOR_ALPHA` and keep
    // the palette's two translucent tracks translucent.
    expect(mesh.geometry.getAttribute('color').itemSize).toBe(4)
    // Drawn AFTER the panel it sits on. With `depthTest: false` on both it is
    // the order and nothing else that decides.
    expect(mesh.renderOrder).toBeGreaterThan(hud.object.renderOrder)
    hud.dispose()
  })

  it('invents no colour — every ink is one the panel already used', () => {
    // ART_DIRECTION pillar 4's argument applied to a UI palette: in six months
    // a colour typed into `src/render/` is indistinguishable from one that was
    // reasoned about. A sixth entry is a DEVIATIONS row and a question.
    const layout = hudPanelLayout(WIDTH * PIXELS_PER_METRE, HEIGHT * PIXELS_PER_METRE)
    const allowed = new Set(Object.values(HUD_GAUGE_PALETTE))
    for (const mode of [BAR, NEEDLE]) {
      for (const r of hudGaugeRects(
        state(),
        layout,
        HUD_GAUGE_PALETTE,
        mode,
        HUD_GAUGE_SPEED_FULL_SCALE,
      )) {
        expect(allowed.has(r.colour), `${r.id} -> ${r.colour}`).toBe(true)
      }
    }
    // And the new one is `render/instrument-colour.ts`'s INSTRUMENT_ACCENT,
    // which is the family the launch room and the shaft bars already wear.
    expect(HUD_GAUGE_PALETTE.instrument.toLowerCase()).toBe(`#${(0x8ad8e0).toString(16)}`)
  })
})

describe('§8 two panels do not share a scratch — DEV-032', () => {
  it('stepping a SECOND panel leaves the first exactly where it was', () => {
    // The guard CLAUDE.md names by hand, because a single-object test cannot
    // see this class of bug at all: with one instance there is nobody to
    // inherit from. Two vehicles each build their own HUD
    // (`game/flight.ts:581`, `game/jumpseat-flight.ts:396`).
    installCanvas()
    const a = createHud({ gauges: NEEDLE })
    const b = createHud({ gauges: NEEDLE })
    a.update(
      state({
        speed: 20,
        chain: { stacks: 2, fraction: 0.1 },
        energy: { fraction: 0.2, available: true },
      }),
      0,
    )
    const before = Array.from(
      ((meshOf(a) as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute)
        .array as Float32Array,
    )
    const beforeColour = Array.from(
      ((meshOf(a) as THREE.Mesh).geometry.getAttribute('color') as THREE.BufferAttribute)
        .array as Float32Array,
    )
    b.update(
      state({
        speed: 175,
        chain: { stacks: 2, fraction: 0.95 },
        energy: { fraction: 0.9, available: false },
      }),
      0,
    )
    const after = Array.from(
      ((meshOf(a) as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute)
        .array as Float32Array,
    )
    const afterColour = Array.from(
      ((meshOf(a) as THREE.Mesh).geometry.getAttribute('color') as THREE.BufferAttribute)
        .array as Float32Array,
    )
    expect(after).toEqual(before)
    expect(afterColour).toEqual(beforeColour)
    // …and the two really did end up different, or the assertion above is
    // vacuous.
    const other = Array.from(
      ((meshOf(b) as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute)
        .array as Float32Array,
    )
    expect(other).not.toEqual(before)
    a.dispose()
    b.dispose()
  })
})

describe('§9a the full scale is the sim own number, not arithmetic written twice', () => {
  it('equals terminalSpeed() with a full 21-gate chain', () => {
    // CLAUDE.md, DEV-027: a DERIVED number needs the same provenance
    // discipline as an extracted one, and nothing guards a number you
    // computed yourself in a scratch script. So the constant is checked
    // against `sim/speed-chain.ts`'s OWN `terminalSpeed()` — a function
    // outside this module, written for a different purpose (checking the
    // chain against the ghosts) — rather than against the same multiplication
    // retyped here, which would be trap 24 exactly.
    //
    // The inputs: `hoverjet.ship.maxSpeed` 437.5 N, the chain's code-default
    // increment 18, `int_01_hoverJet`'s 21 gates, the boost multiplier 2, and
    // the rigidbody's mass 4 and drag 1.2.
    expect(HUD_GAUGE_SPEED_FULL_SCALE).toBeCloseTo(terminalSpeed(437.5 + 18 * 21, 2, 4, 1.2), 9)
  })

  it('is the multiplier the SHEET states, not one that was chosen', () => {
    // The boost multiplier above is not a free parameter: the generated sheet
    // carries both terminals and their ratio is 2.
    //
    // **To within the sheet's OWN rounding, and the first version of this
    // said "exactly" and went red.** 179.6229 / 89.8115 is 1.999998886…,
    // because both entries are written to four decimal places — so the claim
    // that survives is about the sheet's precision, not about the algebra. A
    // number quoted to more digits than its source has is the shape of thing
    // DEV-027 is about.
    expect(DERIVED.hoverjet.terminalSpeedBoost / DERIVED.hoverjet.terminalSpeedCruise).toBeCloseTo(
      2,
      4,
    )
  })

  it('covers the speeds a real flight reaches — the bug the frames found', () => {
    // The first value here was `terminalSpeedBoost` (179.6229), and the photo
    // set came back with both forms PEGGED at both marks because the measured
    // flight speed was 181.3 and 183.1 m/s. A gauge that reads full for most
    // of a run is not a gauge, and no unit test would have said so: the
    // pictures did. This is that finding, kept as a number.
    expect(HUD_GAUGE_SPEED_FULL_SCALE).toBeGreaterThan(183.1)
    // …and the unchained terminal, which is where it was, does not.
    expect(DERIVED.hoverjet.terminalSpeedBoost).toBeLessThan(183.1)
  })
})

describe('§9 the speed digits — coarsened, or gone', () => {
  it('prints the shipped text with the arm down, byte for byte', () => {
    for (const speed of [0, 41.4, 112.7, 179.6]) {
      expect(hudSpeedText(state({ speed }))).toBe(formatSpeed(speed))
      expect(hudSpeedText(state({ speed, speedUnit: 'kmh' }), HUD_GAUGES_OFF)).toBe(
        formatSpeed(speed, 'kmh'),
      )
    }
  })

  it('lands on a multiple of the step, in the unit the row PRINTS', () => {
    // The point of coarsening in the DISPLAYED unit: "five" has to mean five
    // of what the player reads, or the km/h row steps on untidy numbers and
    // the whole exercise buys nothing.
    for (const speed of [0, 7.3, 41.4, 112.7, 179.6]) {
      const ms = hudSpeedText(state({ speed }), BAR) as string
      expect(Number(ms) % HUD_GAUGE_DIGIT_STEP, `${speed} m/s -> ${ms}`).toBe(0)
      const kmh = hudSpeedText(state({ speed, speedUnit: 'kmh' }), BAR) as string
      expect(Number(kmh.replace(' km/h', '')) % HUD_GAUGE_DIGIT_STEP, `${speed} -> ${kmh}`).toBe(0)
    }
  })

  it('moves far less often than the shipped row — the repaint saving, counted', () => {
    // A count over a realistic acceleration, which is the evidence for the
    // claim that the digits stop being what rasters the panel.
    const distinct = (mode: HudGauges): number => {
      const seen = new Set<string | null>()
      for (let i = 0; i <= 2000; i += 1)
        seen.add(hudSpeedText(state({ speed: (i / 2000) * 179.6 }), mode))
      return seen.size
    }
    expect(distinct(BAR)).toBeLessThan(distinct(HUD_GAUGES_OFF) / 4)
    expect(distinct(BAR_ONLY)).toBe(1)
  })

  it('drops the row entirely under -only, and the label stays', () => {
    expect(hudSpeedText(state(), BAR_ONLY)).toBeNull()
    const rec = installCanvas()
    const hud = createHud({ gauges: BAR_ONLY })
    hud.update(state(), 0)
    hud.dispose()
    const texts = rec.calls.filter((c) => c.startsWith('fillText('))
    expect(texts.some((t) => t.includes('SPEED:'))).toBe(true)
    expect(texts.some((t) => t.includes('112'))).toBe(false)
  })

  it('is exact arithmetic, not a float that drifts through 3.6', () => {
    for (const speed of [0, 1, 33.333, 112.7, 179.6229]) {
      const coarse = hudGaugeCoarsenSpeed(speed, 3.6)
      expect(Math.round(coarse * 3.6) % HUD_GAUGE_DIGIT_STEP, `${speed}`).toBe(0)
    }
  })
})
