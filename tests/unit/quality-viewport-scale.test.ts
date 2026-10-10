// tests/unit/quality-viewport-scale.test.ts — DEV-208, corrected by DEV-236.
//
// **The adaptive controller had nowhere to spend its step in a session, and
// nothing said so. Then it had somewhere, and still spent nothing, and nothing
// said that either.**
//
// DEV-208 found the right API and called it on the wrong object:
// `renderer.xr.getBaseLayer().requestViewportScale(s)`. The WebXR Device API
// puts dynamic viewport scaling on **`XRView`** — `requestViewportScale(scale)`
// to write, `recommendedViewportScale` to read — and an `XRProjectionLayer` has
// neither. So the feature detection guarding the call
// (`typeof layer.requestViewportScale !== 'function'`) was false on every
// runtime, on every frame, of every session this build has ever had, and the
// early return it took was indistinguishable from a controller at rest.
//
// ── Why the OLD version of this file did not catch it ─────────────────────
//
// Because it built its own layer double with a `requestViewportScale` on it and
// then asserted the code called it. Every assertion passed. It is CLAUDE.md's
// *"a test that compares two of your own devices has not tested either of
// them"* in its purest form: the double agreed with the code because both were
// written from the same wrong belief, and no amount of more assertions of that
// shape could ever have disagreed.
//
// Two of its assertions were not merely blind but actively wrong, and they are
// worth naming because they are what a rewrite has to delete rather than
// extend:
//
//   - *"asks the projection layer while presenting"* — the layer must never be
//     asked. Reversed below, with the same double kept for the opposite
//     purpose: it carries the method so that a call to it is RECORDED. No real
//     layer has one, which is precisely why the bug was silent.
//   - *"asks once, not once a frame — the layer is only told when it
//     changes"* — a view's "requested viewport scale" is re-asked per frame by
//     the spec's own example and by MDN's, and a view is only reachable from
//     inside the animation loop at all. Once-on-change is not an optimisation
//     of this API, it is a different API.
//
// ── What separates the two explanations ───────────────────────────────────
//
// A double that records BOTH — a layer spy and a pair of view spies — in one
// stub, so "which object did this reach" is answered by the test rather than
// assumed by it. On the unfixed code the layer column fills and the view
// columns stay empty; on the fixed code the reverse. There is no arrangement of
// the old assertions that could tell those two apart, and there is no way for
// these ones not to.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { createQualityController } from '@/render/quality'

type Renderer = import('three').WebGLRenderer

/** How many `requestViewportScale` methods a given view double carries. */
type ViewKind = 'scalable' | 'inert'

/**
 * A renderer stub that records WHICH object each request reached.
 *
 * `getFrame` is three's own name and its own contract — `WebXRManager` assigns
 * `xrFrame` at the top of `onAnimationFrame` and nulls it after the callback
 * returns — so `inFrame: false` models every caller outside the animation loop
 * (a comfort-menu `apply()`, a `sessionstart` listener) and is a null return,
 * not an absent method.
 *
 * The LAYER double carries `requestViewportScale` on purpose. No real
 * `XRProjectionLayer` or `XRWebGLLayer` has one — that is the whole reason
 * DEV-208's call was silent rather than a TypeError — so a spy here is the only
 * way an assertion can distinguish "asked the wrong object" from "asked
 * nothing".
 */
const stub = (opts: {
  presenting: boolean
  /** One entry per eye. Two, for a stereo session, unless a test says otherwise. */
  views?: readonly ViewKind[]
  /** Does `renderer.xr.getFrame()` return a frame? Default: yes while presenting. */
  inFrame?: boolean
  /** Does `getViewerPose()` return a pose? Default: yes. */
  pose?: boolean
}) => {
  const kinds: readonly ViewKind[] = opts.views ?? ['scalable', 'scalable']
  /** What each view was asked for, in order. `asked[i]` is eye `i`. */
  const asked: number[][] = kinds.map(() => [])
  /** What the LAYER was asked for. Must stay empty for ever. */
  const layerAsked: number[] = []
  const pixelRatios: number[] = []
  const foveations: number[] = []

  const views = kinds.map((kind, i) =>
    kind === 'scalable'
      ? {
          eye: i === 0 ? 'left' : 'right',
          requestViewportScale: (s: number) => asked[i]?.push(s),
        }
      : // A runtime that does not implement dynamic viewport scaling. Asking it
        // must be a silent no-op, never a TypeError inside the frame loop.
        { eye: i === 0 ? 'left' : 'right' },
  )

  const layer = { requestViewportScale: (s: number) => layerAsked.push(s) }
  const inFrame = opts.inFrame ?? true

  const renderer = {
    xr: {
      isPresenting: opts.presenting,
      setFoveation: (v: number) => foveations.push(v),
      setFramebufferScaleFactor: () => {},
      getSession: () => null,
      getBaseLayer: () => layer,
      getReferenceSpace: () => ({ space: 'local' }),
      getFrame: () =>
        inFrame ? { getViewerPose: () => (opts.pose === false ? null : { views }) } : null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setPixelRatio: (v: number) => pixelRatios.push(v),
  } as unknown as Renderer

  return { renderer, asked, layerAsked, pixelRatios, foveations }
}

const settings = { ...DEFAULT_SETTINGS }

/** Build a controller, drive `n` presenting frames, and hand back the spies. */
const flown = (s: ReturnType<typeof stub>, n: number, over = settings) => {
  const q = createQualityController(s.renderer, { devicePixelRatio: () => 2 })
  q.apply(over)
  for (let i = 0; i < n; i++) q.frame(1 / 90)
  const report = q.report
  q.dispose()
  return report
}

describe('the request reaches the XRView, and only the XRView', () => {
  it('asks EVERY view in the pose, not the layer', () => {
    // THE assertion of this row. Both halves are needed and neither is
    // sufficient: a fix that asked only `views[0]` would leave the right eye at
    // full size, which is DEV-141's shape — a monocular bug a monocular harness
    // cannot see — and a fix that asked the view AND the layer would still be
    // carrying the belief that produced the defect.
    const s = stub({ presenting: true })
    flown(s, 1)
    expect(s.asked[0], 'left eye').toEqual([1])
    expect(s.asked[1], 'right eye').toEqual([1])
    expect(s.layerAsked, 'the layer has no such method on any real runtime').toEqual([])
  })

  it('asks on every presenting frame, because the spec re-requests per frame', () => {
    // A view's "requested viewport scale" takes effect when `getViewport()` is
    // next called for that view; the spec's own example and MDN's both call
    // `requestViewportScale` inside the animation loop, every frame, for every
    // view. Once-on-change — which is what DEV-208 shipped — is a different
    // API, and on a runtime that resets the slot per frame it is no API at all.
    const s = stub({ presenting: true })
    flown(s, 10)
    expect(s.asked[0]?.length, 'ten frames, ten requests').toBe(10)
    expect(s.asked[1]?.length).toBe(10)
    expect(s.layerAsked).toEqual([])
  })

  it('never sets a pixel ratio while presenting', () => {
    // `setPixelRatio` in a session routes through `setSize`, which three
    // refuses with a warning — the warning-per-frame that buried a real one the
    // first time this was worn. It must stay untouched.
    const s = stub({ presenting: true })
    flown(s, 5)
    expect(s.pixelRatios, 'setPixelRatio is refused while presenting — three warns').toEqual([])
  })
})

describe('nothing is asked where there is nothing to ask', () => {
  it('requests nothing when not presenting, and moves the pixel ratio instead', () => {
    const s = stub({ presenting: false })
    flown(s, 5)
    expect(s.asked[0], 'there is no session to scale the viewport of').toEqual([])
    expect(s.asked[1]).toEqual([])
    expect(s.layerAsked).toEqual([])
    expect(s.pixelRatios, 'the flat surface takes the step instead').not.toEqual([])
  })

  it('requests nothing outside the animation loop — getFrame() is null there', () => {
    // Not a defensive nicety: `WebXRManager` nulls `xrFrame` after the callback
    // returns, and an `XRView` read outside its own frame throws
    // `InvalidStateError`. A comfort-menu `apply()` lands here, and the right
    // behaviour is to do nothing and let the next frame ask.
    const s = stub({ presenting: true, inFrame: false })
    const report = flown(s, 5)
    expect(s.asked[0]).toEqual([])
    expect(s.layerAsked).toEqual([])
    expect(report.viewportScale, 'nothing reached a view, so nothing is reported').toBeNull()
  })

  it('survives a frame with no viewer pose — tracking lost', () => {
    const s = stub({ presenting: true, pose: false })
    expect(() => flown(s, 5)).not.toThrow()
    expect(s.asked[0]).toEqual([])
  })
})

describe('a runtime with no dynamic viewport scaling', () => {
  it('does not throw, and reports null rather than a number nobody heard', () => {
    // The distinction this row exists for. `report.viewportScale` must separate
    // "we asked for 0.6" from "this runtime has no such knob" — and the OLD
    // code could not, because it took its answer from the layer's type. Here
    // the layer double HAS the method and the views do not, which is the exact
    // arrangement that made the bug invisible: the unfixed code reports a
    // number it never delivered.
    const s = stub({ presenting: true, views: ['inert', 'inert'] })
    let report: ReturnType<typeof flown>
    expect(() => {
      report = flown(s, 5)
    }).not.toThrow()
    expect(s.layerAsked, 'a layer is never a substitute for a view').toEqual([])
    // biome-ignore lint/style/noNonNullAssertion: assigned by the closure above
    expect(report!.viewportScale, 'nothing was applied, so nothing is reported').toBeNull()
  })

  it('still asks the views that DO have it when one eye does not', () => {
    // A runtime this shape has not been met. It is here because the loop must
    // skip a view rather than abandon the pose: half a stereo pair scaled is
    // worse than none, and an early `return` on the first inert view would do
    // exactly that if the eyes ever arrived in the other order.
    const s = stub({ presenting: true, views: ['inert', 'scalable'] })
    flown(s, 3)
    expect(s.asked[0]).toEqual([])
    expect(s.asked[1]?.length).toBe(3)
  })
})

describe('what it asks for', () => {
  it('asks for full resolution when nothing is under pressure', () => {
    // Asking for 1 rather than not asking at all matters: the requested scale
    // persists on the view, so a session that inherited one must be told to go
    // back.
    const s = stub({ presenting: true })
    flown(s, 1)
    expect(s.asked[0]).toEqual([1])
  })

  it('asks for 1.0 on EVERY frame when adaptive resolution is off', () => {
    // `?adaptive=0` is the measuring configuration
    // (`docs/testing/perf-protocol.md` §3) and it must render FULL SIZE. A
    // runtime that remembered a 0.6 from before the switch was thrown would
    // otherwise pin every reading taken after it — DEV-178's leak with the
    // surfaces swapped, and the reason this push sits OUTSIDE the
    // `adaptiveResolution` branch in `frame()` rather than inside it.
    const s = stub({ presenting: true })
    flown(s, 8, { ...settings, adaptiveResolution: false })
    expect(s.asked[0]?.length, 'the arm that must not fall silent').toBe(8)
    expect(
      s.asked[0]?.every((v) => v === 1),
      'every one of them full size',
    ).toBe(true)
    expect(s.asked[1]?.every((v) => v === 1)).toBe(true)
  })

  it('never asks for a scale outside the spec range (0, 1]', () => {
    // The spec: "a number greater than 0.0 and less than or equal to 1.0". The
    // controller's own steps satisfy it, so this is a guard on the STEPS rather
    // than on this function — which is the point, because the steps are a table
    // somebody will extend.
    const s = stub({ presenting: true })
    flown(s, 40)
    for (const eye of s.asked) {
      for (const v of eye) {
        expect(v, `scale ${v} is outside (0, 1]`).toBeGreaterThan(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the adaptive step always has exactly one surface', () => {
  it('reports exactly one of pixelRatio and viewportScale, never both or neither', () => {
    // Written as the complement rather than as two values: a reader who finds
    // both null while `scale` is below 1 is looking at a controller degrading
    // with nowhere to spend it, which is what every XR session did between
    // DEV-178 and DEV-208 — and, because DEV-208 aimed at the layer, for six
    // weeks after it too.
    for (const presenting of [true, false]) {
      const s = stub({ presenting })
      const r = flown(s, 2)
      const flat = r.pixelRatio !== null
      const xr = r.viewportScale !== null
      expect(flat, `presenting=${presenting}: pixelRatio`).toBe(!presenting)
      expect(xr, `presenting=${presenting}: viewportScale`).toBe(presenting)
    }
  })

  it('reports the number it actually sent, not the number it wanted to send', () => {
    // `report.viewportScale` is read onto the perf plate and into the trace
    // header. It has to be the ask that LANDED on a view, or the plate becomes
    // the third instrument in this story to agree with a belief instead of with
    // the runtime.
    const s = stub({ presenting: true })
    const r = flown(s, 6)
    const last = s.asked[0]?.at(-1)
    expect(r.viewportScale).toBe(last)
  })
})
