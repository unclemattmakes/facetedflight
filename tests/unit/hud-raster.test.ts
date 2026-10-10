/**
 * tests/unit/hud-raster.test.ts — DEV-256. Which PROCESS rasterises the HUD's
 * canvas, as an arm that can be checked rather than asserted.
 *
 * ── What this suite is for ─────────────────────────────────────────────────
 *
 * `render/hud.ts`'s DEV-256 block has the hypothesis and the arithmetic. The
 * part that needs a test is not the hypothesis — that is the coordinator's
 * measurement on a quiet box — it is the MECHANISM: does the mode reach the
 * canvas, does the default stay the panel that shipped, and does a live flip
 * rebuild everything it has to rebuild and release everything it has to
 * release.
 *
 * ── The one thing about `getContext` that shapes the whole row ────────────
 *
 * Context options are honoured **only on a canvas's first `getContext` call**;
 * every later call returns the same context and ignores its arguments. So
 * unlike DEV-244's three texture fields there is no live field to write, and
 * the two facts that follow are the two things worth testing hardest:
 *
 *   1. the mode is a CONSTRUCTION argument, so a pin that misses construction
 *      is silently the other arm and nothing on the object disagrees;
 *   2. a live flip is a REBUILD — new canvas, new `CanvasTexture`, new
 *      `material.map`, old texture disposed.
 *
 * ── The assertions that fail on 06ec551 ───────────────────────────────────
 *
 * Every `describe` but the last: `parseHudRaster`, `hudContextOptions`,
 * `classifyHudRaster`, `createHud`'s argument, `setRaster` and the report's
 * three new fields do not exist there. The last one is the guard in the other
 * direction — it pins WHICH ARM SHIPS.
 *
 * ── That last block was rewritten by DEV-266, and why ─────────────────────
 *
 * It used to pin `createHud()`'s no-argument fallback and call itself "the
 * SHIPPED panel". Those were the same thing when this file was written and
 * stopped being the same thing on 2026-09-20, when `07bf549` shipped the
 * software canvas by editing `boot/app.ts` — a module no unit test imports.
 * Every assertion here stayed green; the e2e spec that spelled `gpu` went red
 * on `main` and stayed red for a day. The shipped default is one exported
 * constant now, and the last block is the single hand-maintained assertion
 * about its value. See its own comment.
 *
 * ── Compared against something outside the port ───────────────────────────
 *
 * CLAUDE.md: a test that compares two of your own devices has not tested
 * either. So the rebuild assertions do not read a flag this module sets — they
 * read **three's own** `Texture.version`, **three's own** `dispose` event and
 * **three's own** `Source` identity, which is the same instrument
 * `hud-upload.test.ts` uses and the same reason.
 */

import type * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyHudRaster,
  createHud,
  describeHudRaster,
  HUD_RASTER_CPU,
  HUD_RASTER_GPU,
  HUD_RASTER_SHIPPED,
  HUD_REDRAW_LIVE,
  type Hud,
  type HudState,
  hudContextOptions,
  parseHudRaster,
  sameHudRaster,
} from '@/render/hud'

// ── The canvas stub ────────────────────────────────────────────────────────
//
// `hud-upload.test.ts`'s shape with two differences, and both are the subject
// here rather than conveniences:
//
//   * `createElement` returns a **fresh element every call**, because this
//     suite's whole question is whether a flip builds a NEW canvas. The other
//     suite's single shared element would make a rebuild invisible — it would
//     hand back the same object and every identity assertion would pass by
//     construction, which is the definitional-zero trap DEV-241 paid for.
//   * the context implements `getContextAttributes`, echoing what it was
//     created with, because that is exactly what a browser does and it is what
//     `classifyHudRaster` reads.

interface StubCanvas {
  width: number
  height: number
  /** Every `getContext` argument this element saw, in order. */
  readonly asked: (CanvasRenderingContext2DSettings | undefined)[]
  getContext: (
    id: string,
    options?: CanvasRenderingContext2DSettings,
  ) => Record<string, unknown> | null
}

interface CanvasLog {
  /** Every element `document.createElement('canvas')` has produced. */
  readonly made: StubCanvas[]
  /** Sources passed to `drawImage`, so the carry-forward can be asserted. */
  readonly drawn: unknown[]
}

const installCanvas = (): CanvasLog => {
  const log: CanvasLog = { made: [], drawn: [] }
  const make = (): StubCanvas => {
    const asked: (CanvasRenderingContext2DSettings | undefined)[] = []
    let context: Record<string, unknown> | null = null
    const element: StubCanvas = {
      width: 0,
      height: 0,
      asked,
      getContext(_id, options) {
        asked.push(options)
        // THE REAL RULE, MODELLED: options are honoured on the FIRST call and
        // the same context comes back forever after. A stub that rebuilt the
        // context each time would let a bug through that the browser will not
        // — a second `getContext` with different options silently doing
        // nothing is the trap this whole row is built around.
        if (context) return context
        const settings: CanvasRenderingContext2DSettings = { ...(options ?? {}) }
        const noop = () => {}
        context = {
          fillStyle: '',
          strokeStyle: '',
          font: '',
          lineWidth: 0,
          textAlign: '',
          textBaseline: '',
          clearRect: noop,
          fillRect: noop,
          beginPath: noop,
          roundRect: noop,
          fill: noop,
          stroke: noop,
          fillText: noop,
          measureText: (s: string) => ({ width: s.length * 8 }),
          drawImage: (source: unknown) => {
            log.drawn.push(source)
          },
          getContextAttributes: () => settings,
        }
        return context
      },
    }
    return element
  }
  vi.stubGlobal('document', {
    createElement: () => {
      const element = make()
      log.made.push(element)
      return element
    },
  })
  return log
}

/** A stub with no `getContextAttributes` and no `drawImage` — an older engine. */
const installBareCanvas = (): void => {
  const noop = () => {}
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    clearRect: noop,
    fillRect: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    measureText: (s: string) => ({ width: s.length * 8 }),
  }
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

const textureOf = (hud: Hud): THREE.Texture => {
  const mesh = hud.object as THREE.Mesh
  const material = mesh.material as THREE.MeshBasicMaterial
  const map = material.map
  if (!map) throw new Error('hud-raster: the panel has no map')
  return map
}

/** A mid-run panel, so `update()` has something to draw. */
const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 170,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: true,
  ...over,
})

// ───────────────────────────────────────────────────────────────────────────

describe('parseHudRaster — and the aliases it must REFUSE', () => {
  it('reads every spelling a shell command plausibly carries', () => {
    for (const raw of ['gpu', 'GPU', ' gpu ', 'accelerated', 'hardware']) {
      expect(parseHudRaster(raw), raw).toEqual({ kind: 'gpu' })
    }
    for (const raw of [
      'cpu',
      'CPU',
      ' cpu ',
      'software',
      'willReadFrequently',
      'will-read-frequently',
      'read_frequently',
    ]) {
      expect(parseHudRaster(raw), raw).toEqual({ kind: 'cpu' })
    }
  })

  it('round-trips through describeHudRaster, which is what makes an e2e check comparable', () => {
    // The mechanism check compares an ASK against a READING by string. If any
    // accepted spelling failed to land on its canonical token the arm would
    // refuse itself on a spelling — DEV-243's `10` / `10hz` lesson in the shape
    // it takes here, and DEV-244 wrote the same test for the same reason.
    for (const raw of ['gpu', 'hardware', 'cpu', 'software', 'WILL-READ-FREQUENTLY']) {
      const parsed = parseHudRaster(raw)
      expect(parsed, raw).not.toBeNull()
      const spelled = describeHudRaster(parsed as NonNullable<typeof parsed>)
      expect(parseHudRaster(spelled), `${raw} -> ${spelled}`).toEqual(parsed)
      expect(['gpu', 'cpu']).toContain(spelled)
    }
  })

  it('REFUSES on/off/live/freeze by name — one word, three pins, opposite meanings', () => {
    // The deliberate half, and there are THREE pins on this panel now.
    // `?hudRedraw=off` means a FREEZE: no repaints at all. `?hudRaster=off`
    // would read to a person as "no raster" and to a parser as "the arm is
    // off", i.e. the SHIPPED path. Asserted by name so nobody later adds the
    // alias as a kindness.
    for (const raw of ['on', 'off', 'live', 'freeze', 'mip', 'nomip', '1', '0', 'yes', 'no']) {
      expect(parseHudRaster(raw), raw).toBeNull()
    }
  })

  it('is null for nothing at all, which the caller treats as "unpinned"', () => {
    expect(parseHudRaster(null)).toBeNull()
    expect(parseHudRaster(undefined)).toBeNull()
    expect(parseHudRaster('')).toBeNull()
    expect(parseHudRaster('   ')).toBeNull()
  })

  it('sameHudRaster compares the mode and not the object', () => {
    expect(sameHudRaster(HUD_RASTER_GPU, { kind: 'gpu' })).toBe(true)
    expect(sameHudRaster(HUD_RASTER_CPU, { kind: 'cpu' })).toBe(true)
    expect(sameHudRaster(HUD_RASTER_GPU, HUD_RASTER_CPU)).toBe(false)
  })
})

describe('hudContextOptions — what each arm asks getContext for', () => {
  it('cpu asks for willReadFrequently, which is the whole mechanism', () => {
    expect(hudContextOptions(HUD_RASTER_CPU)).toEqual({ willReadFrequently: true })
  })

  it('gpu SPELLS the false rather than omitting the field', () => {
    // Identical to omitting it as far as the spec is concerned, and NOT
    // identical as far as `getContextAttributes()` is concerned — which is the
    // point. An arm expressed by absence is the one nobody can check
    // afterwards (DEV-244's reason for accepting `?hudUpload=mip`), and here
    // it is not a style preference: `classifyHudRaster` reads the attribute
    // back, so EITHER arm has to be a thing the attribute can say — including
    // whichever one currently ships, which has now been both of them.
    expect(hudContextOptions(HUD_RASTER_GPU)).toEqual({ willReadFrequently: false })
  })
})

describe('classifyHudRaster — the LIVE read, and the three answers it has', () => {
  it('reads cpu and gpu off the context attributes', () => {
    expect(
      classifyHudRaster({ getContextAttributes: () => ({ willReadFrequently: true }) }),
    ).toEqual({ kind: 'cpu' })
    expect(
      classifyHudRaster({ getContextAttributes: () => ({ willReadFrequently: false }) }),
    ).toEqual({ kind: 'gpu' })
  })

  it('is NULL where the engine cannot answer, and does not collapse that into gpu', () => {
    // The trap this guards: `!!undefined` is `false`, so a boolean coercion
    // would report the SHIPPED arm on an engine that simply does not report,
    // and the report would read as agreement. A probe that cannot fail is not
    // a probe — the same argument `classifyHudTexture`'s `null` makes.
    expect(classifyHudRaster({})).toBeNull()
    expect(classifyHudRaster({ getContextAttributes: () => null })).toBeNull()
    expect(classifyHudRaster({ getContextAttributes: () => ({}) })).toBeNull()
  })
})

describe('createHud takes the mode at CONSTRUCTION, because getContext does', () => {
  it('asks the canvas for exactly what the arm spells', () => {
    const log = installCanvas()
    createHud({ raster: HUD_RASTER_CPU })
    const canvas = log.made[0] as StubCanvas
    expect(canvas.asked).toEqual([{ willReadFrequently: true }])
  })

  it('reports the intent and the LIVE reading separately, and they agree', () => {
    installCanvas()
    for (const [mode, token] of [
      [HUD_RASTER_GPU, 'gpu'],
      [HUD_RASTER_CPU, 'cpu'],
    ] as const) {
      const report = createHud({ raster: mode }).report()
      expect(report.raster, token).toBe(token)
      // DEV-244's discipline: the intent and the reading are two fields, so a
      // pin that never reached the canvas is a disagreement and not an echo.
      // Here the separation does more work than it does there, because there
      // is no live field to write — a missed pin is silently the other arm.
      expect(report.liveRaster, token).toBe(token)
      expect(report.rasterRebuilds, token).toBe(0)
    }
  })

  it('reports liveRaster NULL rather than guessing, where the context cannot say', () => {
    installBareCanvas()
    const report = createHud({ raster: HUD_RASTER_CPU }).report()
    // The ask is still the ask; what is unknown is whether it landed.
    expect(report.raster).toBe('cpu')
    expect(report.liveRaster).toBeNull()
  })

  it('does not disturb the panel: same size, same texture state, same cadence', () => {
    installCanvas()
    // BOTH arms spelled, and that is DEV-266 rather than verbosity. This line
    // was `createHud()` — the library default — and the library default is
    // now the same `cpu` the next line asks for, so the comparison would have
    // been a config against ITSELF: eight assertions that cannot fail, going
    // green for the wrong reason. An arm expressed by absence is the one
    // nobody can check afterwards, on this side of the suite too.
    const shipped = createHud({ raster: HUD_RASTER_GPU }).report()
    const arm = createHud({ raster: HUD_RASTER_CPU }).report()
    // The raster arm changes WHICH BACKEND draws, and nothing else. Everything
    // DEV-243 and DEV-244 measure has to be untouched, or the two rows'
    // numbers stop being comparable across it.
    expect(arm.pixels).toEqual(shipped.pixels)
    expect(arm.bytes).toBe(shipped.bytes)
    expect(arm.mipLevels).toBe(shipped.mipLevels)
    expect(arm.mipBytes).toBe(shipped.mipBytes)
    expect(arm.uploadBytes).toBe(shipped.uploadBytes)
    expect(arm.cadence).toBe(shipped.cadence)
    expect(arm.upload).toBe(shipped.upload)
    expect(arm.liveUpload).toBe(shipped.liveUpload)
  })
})

/**
 * DEV-266: **every HUD in this block spells its STARTING arm**, and none of
 * them takes `createHud()`'s default.
 *
 * Six of these read `createHud()` and then flipped to `cpu`, which was a real
 * flip only for as long as the factory's default was `gpu`. When DEV-266 made
 * that default the shipped `cpu`, five of the six went red inside a minute —
 * `setRaster` is a no-op for the mode already in force, so there was no
 * rebuild left to assert. Red was the lucky outcome. The sixth would have
 * gone on passing over a flip that never happened, and so would any test here
 * whose assertion survives a no-op.
 *
 * A test of a TRANSITION has to name both ends. Taking one of them from a
 * default means the test quietly changes meaning whenever the default moves,
 * which is the whole subject of this file's header.
 */
describe('setRaster — a REBUILD, not a field write', () => {
  it('is a no-op for the mode already in force, and that is what makes the frame loop safe', () => {
    const log = installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    const before = textureOf(hud)
    for (let i = 0; i < 90; i++) hud.setRaster(HUD_RASTER_GPU)
    // `boot/app.ts` calls this every frame. Without the guard, ninety frames
    // would be ninety canvases and ninety `CanvasTexture`s — which is the
    // sharper edge of DEV-244's own no-op argument.
    expect(log.made).toHaveLength(1)
    expect(textureOf(hud)).toBe(before)
    expect(hud.report().rasterRebuilds).toBe(0)
  })

  it('builds a NEW canvas and asks IT for the new mode', () => {
    const log = installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    hud.setRaster(HUD_RASTER_CPU)
    expect(log.made).toHaveLength(2)
    // THE WHOLE REASON THE REBUILD EXISTS. The first element was asked for
    // `false` and can never be asked again; the second is asked for `true` on
    // its first and only `getContext`.
    expect((log.made[0] as StubCanvas).asked).toEqual([{ willReadFrequently: false }])
    expect((log.made[1] as StubCanvas).asked).toEqual([{ willReadFrequently: true }])
    const report = hud.report()
    expect(report.raster).toBe('cpu')
    expect(report.liveRaster).toBe('cpu')
    expect(report.rasterRebuilds).toBe(1)
  })

  it('points the MATERIAL at the new texture and DISPOSES the old one', () => {
    installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    const before = textureOf(hud)
    let disposed = 0
    // three's OWN dispose event, not a flag of ours — which is what makes this
    // a test of the release rather than a second reading of the intent.
    // `WebGLTextures.onTextureDispose` (three.module.js:11329) hangs off this
    // event and is what frees the `WebGLTexture`; if it never fires, nothing
    // frees.
    before.addEventListener('dispose', () => {
      disposed += 1
    })
    hud.setRaster(HUD_RASTER_CPU)
    const after = textureOf(hud)
    expect(after).not.toBe(before)
    expect(disposed).toBe(1)
    // A NEW `Source` as well as a new texture, which is what makes three drop
    // the whole `_sources` entry at `:11390` rather than leaving a live
    // `WebGLTexture` behind under the old cache key.
    expect(after.source).not.toBe(before.source)
  })

  it('carries the old pixels across, so the panel never blinks out', () => {
    const log = installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    hud.update(state(), 0)
    hud.setRaster(HUD_RASTER_CPU)
    // One `drawImage`, of the OLD element onto the new context. Asserted by
    // identity rather than by count alone: drawing the new canvas onto itself
    // would also be one call and would carry nothing.
    expect(log.drawn).toEqual([log.made[0]])
  })

  it('does not throw where the context has no drawImage', () => {
    // The node stubs in the other HUD suites implement the calls they count
    // and not the whole 2-D API. A panel that throws in a headless test is a
    // panel nobody can test, so the carry-forward is guarded on the method.
    installBareCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    expect(() => {
      hud.setRaster(HUD_RASTER_CPU)
    }).not.toThrow()
    expect(hud.report().rasterRebuilds).toBe(1)
  })

  it('OWES a repaint after a flip, so the new canvas does not stay empty', () => {
    installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    hud.setRedraw(HUD_REDRAW_LIVE)
    hud.update(state(), 0)
    const painted = hud.paints
    expect(painted).toBeGreaterThan(0)
    // The signature has NOT moved, so without the debt this second call would
    // return early and the freshly built canvas would hold only the carried
    // pixels for the rest of the run.
    hud.update(state(), 1)
    expect(hud.paints, 'an unchanged state must not repaint on its own').toBe(painted)
    hud.setRaster(HUD_RASTER_CPU)
    hud.update(state(), 2)
    expect(hud.paints, 'the flip did not leave the panel owing a native repaint').toBe(painted + 1)
  })

  it('never lets `uploads` read BELOW `repaints`, which is the false finding a reset would make', () => {
    installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    hud.setRedraw(HUD_REDRAW_LIVE)
    for (let i = 0; i < 5; i++) hud.update(state({ ringsPassed: i }), i)
    const before = hud.report()
    hud.setRaster(HUD_RASTER_CPU)
    const after = hud.report()
    // `uploads` is three's own `Texture.version`, and a new `CanvasTexture`
    // starts its own at 1. Banking the retired one keeps the field meaning
    // "uploads this PANEL has caused" — without it this would read
    // `uploads < repaints`, which is exactly the shape of "a draw path forgot
    // a needsUpdate" and is the only finding the field exists to make.
    expect(after.uploads).toBeGreaterThanOrEqual(before.uploads)
    expect(after.uploads).toBeGreaterThanOrEqual(after.repaints)
    // And the relation is exact: one upload per repaint, plus the blank upload
    // every `CanvasTexture` constructor asks for, plus one per rebuild.
    expect(after.uploads).toBe(after.repaints + 1 + after.rasterRebuilds)
  })

  it('a flip back to gpu is another rebuild, and lands', () => {
    const log = installCanvas()
    const hud = createHud({ raster: HUD_RASTER_GPU })
    hud.setRaster(HUD_RASTER_CPU)
    hud.setRaster(HUD_RASTER_GPU)
    expect(log.made).toHaveLength(3)
    const report = hud.report()
    expect(report.raster).toBe('gpu')
    expect(report.liveRaster).toBe('gpu')
    expect(report.rasterRebuilds).toBe(2)
  })
})

/**
 * DEV-266. **The one assertion in the repo that a default change must edit by
 * hand — and the reason it exists is that the previous version of this block
 * stayed green through exactly such a change.**
 *
 * It used to be called *"the SHIPPED panel, pinned"* and it asserted that
 * `createHud()` with no argument is `gpu`. That was true and it was not the
 * shipped panel: `07bf549` shipped `cpu` by editing a `??` in `boot/app.ts`,
 * which this suite cannot see, and every test here went on passing while
 * `tests/e2e/hud-upload-pixels.spec.ts` went red on `main` for a day. A guard
 * named after the thing it does not guard is worse than no guard, because the
 * name is what the next person reads.
 *
 * So the shipped default is now one exported constant, `HUD_RASTER_SHIPPED`,
 * and everything that can derive from it does — `createHud`'s fallback, the
 * pin in `boot/app.ts`, and the e2e spec's arms. **This block is the one
 * place that does not derive**, because a suite that read the constant to
 * decide what the constant should be would agree with any value it was given:
 * CLAUDE.md, *a test that compares two of your own devices has not tested
 * either*. The value below is checked against the ledger — DEV-256's row and
 * the `HUD_RASTER_PIN` block in `boot/app.ts` — and nothing else.
 *
 * **Flipping the default is this line plus that constant.** If you are here
 * because this assertion failed, that is the gate working: change it
 * deliberately, and check that DEV-256's row still says what ships.
 */
describe('WHICH RASTER SHIPS — pinned against the ledger, derived from nothing', () => {
  it('the shipped raster is the SOFTWARE canvas (DEV-256, 07bf549, 2026-09-20)', () => {
    expect(describeHudRaster(HUD_RASTER_SHIPPED)).toBe('cpu')
    expect(sameHudRaster(HUD_RASTER_SHIPPED, HUD_RASTER_CPU)).toBe(true)
  })

  it('createHud() with no argument is that same canvas, not a second opinion', () => {
    // The trap this closes: two defaults. Before DEV-266 the factory fell back
    // to `gpu` while the boot path fell back to `cpu`, so "the default" was
    // two different answers depending on which door you came through, and the
    // comment on the factory claimed its answer was "byte for byte the
    // shipped panel". Reading the constant here is the right move where
    // reading it above would not be: the question is whether the factory
    // AGREES with the shipped default, not what that default is.
    installCanvas()
    const report = createHud().report()
    expect(report.raster).toBe(describeHudRaster(HUD_RASTER_SHIPPED))
    expect(report.liveRaster).toBe(describeHudRaster(HUD_RASTER_SHIPPED))
    expect(report.rasterRebuilds).toBe(0)
  })

  it('and what it asks the canvas for is the shipped arm’s own context options', () => {
    // `{ willReadFrequently: false }` and no options at all are the same
    // canvas to the spec, which is why this is asserted as the OPTIONS OBJECT
    // rather than as a hard-coded literal: it stays a real statement about the
    // shipped path whichever arm ships.
    const log = installCanvas()
    createHud()
    expect((log.made[0] as StubCanvas).asked).toEqual([hudContextOptions(HUD_RASTER_SHIPPED)])
    expect(hudContextOptions(HUD_RASTER_GPU).willReadFrequently).toBe(false)
    expect(hudContextOptions(HUD_RASTER_CPU).willReadFrequently).toBe(true)
  })

  it('the panel is still 560 x 203 and still drawing', () => {
    installCanvas()
    const hud = createHud()
    hud.setRedraw(HUD_REDRAW_LIVE)
    hud.update(state(), 0)
    const report = hud.report()
    expect(report.pixels).toEqual({ width: 560, height: 203 })
    expect(report.repaints).toBe(1)
    // DEV-244's own range, re-read here rather than re-derived: a repaint that
    // stopped asking the backend for anything would be a panel that stopped
    // drawing, and every number above would still look right.
    expect(report.canvasOps.total).toBeGreaterThanOrEqual(19)
    expect(report.canvasOps.total).toBeLessThanOrEqual(26)
  })
})
