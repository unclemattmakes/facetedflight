// tests/unit/xr-eye-projection.test.ts — the per-eye frustum a trace stamps
// (DEV-227).
//
// VR-PERF-WAVE-3 §6, the paragraph headed *"And the rig is not calibrated on
// FOV"*. The VRto3D rig drew **46 % more triangles than the worn capture of the
// same mission** — 14.14M against 9.69M on `rookie_01_hoverJet` — because its
// `fov: 90` square eye is a wider cone than the Steam Frame's per-eye
// projection. That makes the rig-vs-worn offset a sum of two effects in
// opposite directions (no video encoder on the GPU makes the rig cheaper; half
// a world of extra geometry makes it dearer), and no absolute number could be
// filed off it.
//
// And it could not simply be looked up, which is what this file is really
// about: the worn capture's header
// (`perf-out/capture/ff2-perf-capture-2026-09-19_06-27-22.json`) carries
// `version`, `mode`, `edition`, `mission`, `startedAt`, `budgetMs`,
// `budgetSource`, `frames` and `columns` — and nothing whatsoever about the
// shape of the cone those numbers were drawn through. **A reading whose one
// free parameter was never written down cannot be reproduced anywhere.**
//
// ── Why the assertions here are the shapes they are ──────────────────────
//
// There is no headless WebXR (CLAUDE.md), so nothing in a `pnpm test` can make
// a real `XRView`. That leaves two honest oracles and this file uses both, and
// neither of them is "the code, run again":
//
//   §1 reads **three's own build** and pins the ordering the viewport read
//      depends on — the same move `xr-eye-layers.test.ts` makes, for the same
//      reason: a claim about three's private ordering is read out of three,
//      never remembered.
//   §2 builds projection matrices **forwards** from frustum edges we choose,
//      and asks the extractor to give those edges back. The forward formula and
//      the inverse are different arithmetic, which is the whole point —
//      CLAUDE.md trap 24: *a test that re-derives its expectation the way the
//      code does has not tested the code.*
//
// §5 is the half that is not about maths at all: **a flat run must stamp
// `null`, not zeros.** A zeroed frustum is a field of view of nothing, it looks
// like a measurement, and this project has already filed one derived number it
// could not defend (DEV-027).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createPerfSurface,
  eyeProjections,
  eyeViewportWidth,
  IDLE_XR_PROBE,
  type PerfSurfaceDeps,
  projectionFromMatrix,
  refreshXrProbe,
  type XrProbe,
  type XrProbeSource,
} from '@/boot/perf-surface'
import {
  createTraceRecorder,
  eyeFov,
  formatTraceSummary,
  type TraceEyeProjection,
  type TraceSummary,
} from '@/boot/perf-trace'
import { REPO as ROOT } from './helpers/repo-root'

/**
 * A GL projection matrix built FORWARDS from the six frustum planes, exactly as
 * the OpenGL red book states it, column-major — the storage order an `XRView`
 * hands out.
 *
 *     m[0] = 2n/(r-l)   m[5] = 2n/(t-b)
 *     m[8] = (r+l)/(r-l)   m[9] = (t+b)/(t-b)
 *     m[10] = -(f+n)/(f-n)   m[11] = -1   m[14] = -2fn/(f-n)
 *
 * This is the independent half of §2. It shares no line with
 * `projectionFromMatrix`, which runs the other way.
 */
const glProjection = (
  l: number,
  r: number,
  b: number,
  t: number,
  n: number,
  f: number,
): Float32Array => {
  const m = new Float32Array(16)
  m[0] = (2 * n) / (r - l)
  m[5] = (2 * n) / (t - b)
  m[8] = (r + l) / (r - l)
  m[9] = (t + b) / (t - b)
  m[10] = -(f + n) / (f - n)
  m[11] = -1
  m[14] = (-2 * f * n) / (f - n)
  return m
}

/** Float32 round-trips a ratio to about seven digits; 1e-5 is slack, not luck. */
const CLOSE = 5

describe('§1 three still hands us a per-eye viewport before our own callback', () => {
  it('fills camera.viewport and camera.projectionMatrix, then calls the app', () => {
    // Inside the `it`, never in the `describe` body — a `describe` body runs at
    // COLLECTION and would throw `ENOENT` wherever `node_modules/three` is a
    // literal path that does not exist (CLAUDE.md, `describe.skipIf`).
    const build = fs.readFileSync(
      path.join(ROOT, 'node_modules/three/build/three.module.js'),
      'utf8',
    )

    // The two reads three makes per view. The `projectionMatrix` one is here as
    // documentation of what we deliberately do NOT use — we read the matrix off
    // the `XRView` itself, because three's copy is three's to change.
    const viewportSet = build.indexOf(
      'camera.viewport.set( viewport.x, viewport.y, viewport.width, viewport.height );',
    )
    expect(viewportSet).toBeGreaterThan(-1)
    expect(build).toContain('camera.projectionMatrix.fromArray( view.projectionMatrix );')

    // BOTH layer paths, because which one is live is a property of the browser:
    // an `XRWebGLLayer` answers `getViewport`, an `XRProjectionLayer` only
    // yields a viewport through the binding's sub-image — and this rig takes
    // the second (`XrProbe.layer` reads `XRProjectionLayer` on this desktop).
    // Doing either of those ourselves would be a second reader with a second
    // chance to pick the wrong path; three has already picked.
    expect(build).toContain('viewport = glBaseLayer.getViewport( view );')
    expect(build).toContain('const glSubImage = glBinding.getViewSubImage( glProjLayer, view );')

    // The ordering the whole thing rests on. If this ever inverts, the probe
    // reads the PREVIOUS frame's viewport — which on a fixed-size session is
    // indistinguishable from the right answer, and on a session that just
    // changed scale is silently one frame stale.
    const callback = build.indexOf(
      'if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );',
    )
    expect(callback).toBeGreaterThan(-1)
    expect(viewportSet).toBeLessThan(callback)
  })
})

describe('§2 the frustum comes back out of a matrix built forwards from its edges', () => {
  it('reads a SYMMETRIC 90° square eye as four unit tangents', () => {
    const n = 0.1
    const p = projectionFromMatrix(glProjection(-n, n, -n, n, n, 1000), 'left', null)
    expect(p).not.toBeNull()
    expect(p?.tanRight).toBeCloseTo(1, CLOSE)
    expect(p?.tanLeft).toBeCloseTo(-1, CLOSE)
    expect(p?.tanUp).toBeCloseTo(1, CLOSE)
    expect(p?.tanDown).toBeCloseTo(-1, CLOSE)
    expect(p?.eye).toBe('left')
  })

  it('reads an ASYMMETRIC frustum without flattening it to one half-angle', () => {
    // The case that matters and the case a `fovy` cannot express. A real
    // headset's eye sees further outboard than inboard; these four are
    // deliberately all different from each other so that any transposition,
    // sign flip or axis swap in the extractor shows up as a wrong number rather
    // than as a symmetry that happens to survive.
    const n = 0.05
    const [l, r, b, t] = [-1.24 * n, 0.97 * n, -1.13 * n, 1.05 * n]
    const p = projectionFromMatrix(glProjection(l, r, b, t, n, 2000), 'right', null)
    expect(p?.tanLeft).toBeCloseTo(-1.24, CLOSE)
    expect(p?.tanRight).toBeCloseTo(0.97, CLOSE)
    expect(p?.tanDown).toBeCloseTo(-1.13, CLOSE)
    expect(p?.tanUp).toBeCloseTo(1.05, CLOSE)
    // And the thing the tangents are FOR: the four are not two, and reading one
    // side as "the" half-angle would overstate this eye by 12 %.
    expect(Math.abs(p?.tanLeft ?? 0)).not.toBeCloseTo(Math.abs(p?.tanRight ?? 0), 2)
  })

  it('is a property of the CONE only — near and far do not move it', () => {
    // A frustum's tangents are ratios to the near plane, so the same cone at two
    // different near distances must read identically. This is the assertion that
    // catches a near/far term leaking into the extraction: it cannot be
    // satisfied by any formula that consults `m[10]` or `m[14]`.
    const cone = (n: number, f: number) =>
      projectionFromMatrix(glProjection(-1.3 * n, 0.9 * n, -1.1 * n, 1.2 * n, n, f), 'left', null)
    const near = cone(0.01, 100)
    const far = cone(4, 100000)
    expect(far?.tanLeft).toBeCloseTo(near?.tanLeft ?? 0, CLOSE)
    expect(far?.tanRight).toBeCloseTo(near?.tanRight ?? 0, CLOSE)
    expect(far?.tanUp).toBeCloseTo(near?.tanUp ?? 0, CLOSE)
    expect(far?.tanDown).toBeCloseTo(near?.tanDown ?? 0, CLOSE)
  })

  it('carries the viewport through untouched, including a null one', () => {
    const vp = { x: 1512, y: 0, w: 1512, h: 1680 }
    const p = projectionFromMatrix(glProjection(-1, 1, -1, 1, 1, 100), 'right', vp)
    expect(p?.viewport).toEqual(vp)
    expect(projectionFromMatrix(glProjection(-1, 1, -1, 1, 1, 100), 'right', null)?.viewport).toBe(
      null,
    )
  })

  it('answers null rather than a number for everything it cannot read', () => {
    // Every one of these would otherwise produce a finite-looking tangent or an
    // `Infinity`, and both get filed. `null` cannot be.
    expect(projectionFromMatrix(null, 'left', null)).toBeNull()
    expect(projectionFromMatrix(undefined, 'left', null)).toBeNull()
    expect(projectionFromMatrix({}, 'left', null)).toBeNull()
    expect(projectionFromMatrix([1, 2, 3], 'left', null)).toBeNull()
    const nan = glProjection(-1, 1, -1, 1, 1, 100)
    nan[9] = Number.NaN
    expect(projectionFromMatrix(nan, 'left', null)).toBeNull()
    // A zero x-scale is a frustum of no width: the division would be Infinity,
    // which reads as "an enormous field of view" rather than as "broken".
    const flat = glProjection(-1, 1, -1, 1, 1, 100)
    flat[0] = 0
    expect(projectionFromMatrix(flat, 'left', null)).toBeNull()
  })

  it('accepts a plain array, because not every runtime hands out a Float32Array', () => {
    const asArray = Array.from(glProjection(-2, 2, -1, 1, 1, 50))
    expect(projectionFromMatrix(asArray, 'none', null)?.tanRight).toBeCloseTo(2, CLOSE)
  })
})

describe('§3 the stored tangents restate as the angles a rig config is written in', () => {
  const asym = (): TraceEyeProjection => {
    const n = 0.1
    const p = projectionFromMatrix(
      glProjection(-1.24 * n, 0.97 * n, -1.13 * n, 1.05 * n, n, 1000),
      'right',
      { x: 0, y: 0, w: 2016, h: 2016 },
    )
    if (p === null) throw new Error('fixture')
    return p
  }

  it('is a DIFFERENCE of two arctangents, not twice one of them', () => {
    // The shortcut this assertion exists to forbid. `2 * atan(tanRight)` is
    // right only for a symmetric frustum, and using it on a real eye is exactly
    // the reasoning that made a square 90° rig look like a fair stand-in for
    // the Frame.
    const f = eyeFov(asym())
    const truth = (Math.atan(0.97) - Math.atan(-1.24)) * (180 / Math.PI)
    expect(f.horizontalDeg).toBeCloseTo(truth, CLOSE)
    const shortcut = 2 * Math.atan(0.97) * (180 / Math.PI)
    expect(Math.abs(f.horizontalDeg - shortcut)).toBeGreaterThan(5)
  })

  it('reports a 90° square eye as 90 by 90, aspect 1, skew 0', () => {
    const n = 0.1
    const p = projectionFromMatrix(glProjection(-n, n, -n, n, n, 500), 'left', null)
    if (p === null) throw new Error('fixture')
    const f = eyeFov(p)
    expect(f.horizontalDeg).toBeCloseTo(90, 4)
    expect(f.verticalDeg).toBeCloseTo(90, 4)
    expect(f.aspect).toBeCloseTo(1, CLOSE)
    expect(f.skewX).toBeCloseTo(0, CLOSE)
    expect(f.skewY).toBeCloseTo(0, CLOSE)
  })

  it('aspect is a ratio of TANGENTS, and is not the ratio of the two angles', () => {
    const p = asym()
    const f = eyeFov(p)
    expect(f.aspect).toBeCloseTo((0.97 + 1.24) / (1.05 + 1.13), CLOSE)
    // `tan` is not linear, so the angle ratio is a different number. It is
    // close enough here to be mistaken for the right one by eye and far enough
    // to matter, which is the worst possible spacing and the reason for the
    // assertion.
    expect(f.aspect).not.toBeCloseTo(f.horizontalDeg / f.verticalDeg, 4)
  })

  it('skew IS the matrix entry, so a symmetric rig cannot reproduce a non-zero one', () => {
    // `skewX` is `m[8]` and `skewY` is `m[9]` — a reading of the projection
    // matrix rather than a derivation from it. Asserting it against the matrix
    // we built is what makes that claim checkable.
    const n = 0.1
    const m = glProjection(-1.24 * n, 0.97 * n, -1.13 * n, 1.05 * n, n, 1000)
    const f = eyeFov(asym())
    expect(f.skewX).toBeCloseTo(m[8] as number, CLOSE)
    expect(f.skewY).toBeCloseTo(m[9] as number, CLOSE)
    expect(f.skewX).not.toBeCloseTo(0, 2)
  })
})

describe('§4 the probe reads the frustum where it already reads the views', () => {
  const source = (over: Record<string, unknown> = {}): XrProbeSource =>
    ({
      isPresenting: true,
      getSession: () => ({ enabledFeatures: ['local', 'layers'] }),
      getFrame: () => ({
        getViewerPose: () => ({
          views: [
            {
              eye: 'left',
              projectionMatrix: glProjection(-0.124, 0.097, -0.113, 0.105, 0.1, 1000),
              requestViewportScale: () => {},
            },
            {
              eye: 'right',
              projectionMatrix: glProjection(-0.097, 0.124, -0.113, 0.105, 0.1, 1000),
              requestViewportScale: () => {},
            },
          ],
        }),
      }),
      getReferenceSpace: () => ({}),
      getBaseLayer: () => {
        class XRProjectionLayer {
          textureWidth = 3024
          textureHeight = 1512
        }
        return new XRProjectionLayer()
      },
      // three's `Vector4` is (x, y, WIDTH, HEIGHT) — the `z`/`w` naming is the
      // one thing about this read that is easy to get backwards.
      getCamera: () => ({
        cameras: [
          { viewport: { x: 0, y: 0, z: 1512, w: 1512 } },
          { viewport: { x: 1512, y: 0, z: 1512, w: 1512 } },
        ],
      }),
      ...over,
    }) as unknown as XrProbeSource

  it('gives each eye its own frustum and its own slice of the layer', () => {
    const p = refreshXrProbe(source())
    expect(p.views).toHaveLength(2)
    const [left, right] = [p.views[0]?.projection, p.views[1]?.projection]
    expect(left?.eye).toBe('left')
    expect(right?.eye).toBe('right')
    // The two eyes are MIRRORS of each other, which is what a real stereo pair
    // looks like and what a bug that reads one view twice cannot produce.
    expect(left?.tanLeft).toBeCloseTo(-1.24, CLOSE)
    expect(right?.tanRight).toBeCloseTo(1.24, CLOSE)
    expect(left?.viewport).toEqual({ x: 0, y: 0, w: 1512, h: 1512 })
    expect(right?.viewport).toEqual({ x: 1512, y: 0, w: 1512, h: 1512 })
  })

  it('still reports the frustum when nothing can tell it the viewport', () => {
    // The two halves are independent, and the one that matters for the FOV
    // calibration is the frustum. A missing array camera must not cost it.
    const p = refreshXrProbe(source({ getCamera: undefined }))
    expect(p.views[0]?.projection?.tanLeft).toBeCloseTo(-1.24, CLOSE)
    expect(p.views[0]?.projection?.viewport).toBeNull()
  })

  it('reads the same rectangle for the trace column as for the header stamp', () => {
    // DEV-236. `eyeViewportWidth` is the per-frame `vp_w` column and
    // `eyeViewports` is DEV-227's header stamp, and they are two functions over
    // one `Vector4` — a second reader is a second chance to be wrong about
    // which field is the width.
    //
    // So this asserts the RELATIONSHIP rather than the number (trap 24): the
    // column equals the stamp's `w`, whatever that is. A version that returned
    // `.w` — three's HEIGHT — passes a `toBe(1512)` on a square eye and fails
    // this on any rig that is not square, which is every real headset.
    const p = refreshXrProbe(source())
    expect(eyeViewportWidth(source())).toBe(p.views[0]?.projection?.viewport?.w)

    const wide = {
      getCamera: () => ({ cameras: [{ viewport: { x: 0, y: 0, z: 1832, w: 1920 } }] }),
    }
    expect(eyeViewportWidth(source(wide))).toBe(1832)
    expect(refreshXrProbe(source(wide)).views[0]?.projection?.viewport?.w).toBe(1832)
  })

  it('reports 0 rather than a guess where there is no eye', () => {
    // Flat, or one frame of a session changing shape. 0 is the flat path's
    // answer everywhere in the trace, and the header stamp is `null` there —
    // so a canvas width in this column would be compared against nothing.
    expect(eyeViewportWidth(source({ getCamera: undefined }))).toBe(0)
    expect(eyeViewportWidth(source({ getCamera: () => null }))).toBe(0)
    expect(eyeViewportWidth(source({ getCamera: () => ({ cameras: [] }) }))).toBe(0)
    expect(
      eyeViewportWidth(source({ getCamera: () => ({ cameras: [{ viewport: undefined }] }) })),
    ).toBe(0)
    expect(
      eyeViewportWidth(
        source({ getCamera: () => ({ cameras: [{ viewport: { z: Number.NaN } }] }) }),
      ),
      'NaN is not a width',
    ).toBe(0)
  })

  it('leaves an eye null when the camera list is a different length', () => {
    // One frame of a session changing shape. The eye three has not caught up on
    // reports no viewport rather than borrowing its neighbour's.
    const p = refreshXrProbe(
      source({ getCamera: () => ({ cameras: [{ viewport: { x: 0, y: 0, z: 800, w: 900 } }] }) }),
    )
    expect(p.views[0]?.projection?.viewport).toEqual({ x: 0, y: 0, w: 800, h: 900 })
    expect(p.views[1]?.projection?.viewport).toBeNull()
  })

  it('reports a view with no projectionMatrix as null, not as zeros', () => {
    const p = refreshXrProbe(
      source({
        getFrame: () => ({
          getViewerPose: () => ({ views: [{ eye: 'left', requestViewportScale: () => {} }] }),
        }),
      }),
    )
    expect(p.views).toHaveLength(1)
    expect(p.views[0]?.projection).toBeNull()
  })

  it('names an eye it cannot identify rather than guessing a side', () => {
    const p = refreshXrProbe(
      source({
        getFrame: () => ({
          getViewerPose: () => ({
            views: [{ projectionMatrix: glProjection(-1, 1, -1, 1, 1, 100) }],
          }),
        }),
      }),
    )
    expect(p.views[0]?.projection?.eye).toBe('unknown')
  })

  it('is frozen, projection and viewport included', () => {
    const p = refreshXrProbe(source())
    const one = p.views[0]?.projection
    expect(Object.isFrozen(one)).toBe(true)
    expect(Object.isFrozen(one?.viewport)).toBe(true)
  })

  it('does not take the frame loop down when the array camera throws', () => {
    const p = refreshXrProbe(
      source({
        getCamera: () => {
          throw new Error('InvalidStateError')
        },
      }),
    )
    // The probe's own try/catch owns this: a diagnostic may report nothing, and
    // may never be the reason a headset goes black.
    expect(p).toBe(IDLE_XR_PROBE)
  })
})

describe('§5 the stamp: absent on the flat path, and never zero', () => {
  const probe = (over: Partial<XrProbe> = {}): XrProbe =>
    ({ ...IDLE_XR_PROBE, presenting: true, views: [], ...over }) as XrProbe

  const eye = (label: string): TraceEyeProjection => {
    const p = projectionFromMatrix(glProjection(-0.124, 0.097, -0.113, 0.105, 0.1, 1000), label, {
      x: 0,
      y: 0,
      w: 1512,
      h: 1512,
    })
    if (p === null) throw new Error('fixture')
    return p
  }

  it('is null out of session — the flat path has no eyes to describe', () => {
    expect(eyeProjections(IDLE_XR_PROBE)).toBeNull()
  })

  it('distinguishes "no session" from "a session we could not read"', () => {
    // Both are absences and they are not the same absence. `null` says there
    // was no headset; `[]` says there was one and the frame had nothing in it.
    // Collapsing them would make a tracking-loss frame and a desktop run file
    // the same way.
    expect(eyeProjections(probe())).toEqual([])
    expect(
      eyeProjections(
        probe({
          views: [
            { recommendedViewportScale: null, requestViewportScale: false, projection: null },
          ],
        }),
      ),
    ).toEqual([])
    expect(eyeProjections(IDLE_XR_PROBE)).not.toEqual([])
  })

  it('carries one entry per eye that had a frustum', () => {
    const p = probe({
      views: [
        { recommendedViewportScale: null, requestViewportScale: true, projection: eye('left') },
        { recommendedViewportScale: null, requestViewportScale: true, projection: null },
        { recommendedViewportScale: null, requestViewportScale: true, projection: eye('right') },
      ],
    })
    const out = eyeProjections(p)
    expect(out?.map((v) => v.eye)).toEqual(['left', 'right'])
  })

  it('lands in the trace HEADER, which is the artefact a rig is set from', () => {
    const t = createTraceRecorder()
    t.start(1, { mission: 'rookie_01_hoverJet', projection: [eye('left'), eye('right')] })
    t.stop()
    const header = JSON.parse(t.dump().split('\n')[0] as string)
    expect(header.projection).toHaveLength(2)
    expect(header.projection[0].eye).toBe('left')
    expect(header.projection[0].tanLeft).toBeCloseTo(-1.24, CLOSE)
    expect(header.projection[0].viewport).toEqual({ x: 0, y: 0, w: 1512, h: 1512 })
    // And the summary, which is what `perf-capture.ts` stores as JSON beside the
    // CSV and what the console line is built from. One quantity, three surfaces.
    expect(t.summary().projection).toHaveLength(2)
  })

  it('writes null into the header on a flat run rather than omitting the key', () => {
    // `null` and "absent" read the same in JavaScript and differently in a
    // spreadsheet, a notebook and a diff. The key is always there; what changes
    // is whether it has a frustum in it.
    const t = createTraceRecorder()
    t.start(1, { mission: 'int_01_hoverJet' })
    t.stop()
    const line = t.dump().split('\n')[0] as string
    expect(line).toContain('"projection":null')
    expect(JSON.parse(line)).toHaveProperty('projection', null)
    expect(t.summary().projection).toBeNull()
  })

  it('survives __ff2perf-s snapshot, which is the line the protocol tells you to type', () => {
    // `perf-protocol.md` §1a says to read the frustum off
    // `__ff2perf.trace.summary().projection` in a headset, and that handle does
    // not forward the summary — it runs it through `plainFrozen`, which DROPS
    // any value whose prototype is not `Object.prototype`. Four frozen object
    // literals inside a frozen array are plain and survive; that is a claim
    // about a code path a worn session depends on and there is no reading it
    // back once the headset is off, so it is asserted rather than reasoned
    // about.
    const t = createTraceRecorder()
    t.start(1, { projection: [eye('left'), eye('right')] })
    t.stop()
    const deps = {
      trace: {
        start: () => {},
        stop: () => {},
        status: () => t.status,
        frames: () => t.frames,
        summary: () => t.summary(),
        dump: () => t.dump(),
      },
    } as unknown as PerfSurfaceDeps
    const surface = createPerfSurface(deps, { storage: null })
    // `PerfSurface.trace.summary()` is typed `unknown` on purpose — the public
    // handle hands out opaque data — so the cast is the test saying what it
    // expects to find, which is the thing being checked.
    const out = (surface.trace.summary() as TraceSummary).projection
    expect(out).toHaveLength(2)
    expect(out?.[0]?.eye).toBe('left')
    expect(out?.[0]?.tanLeft).toBeCloseTo(-1.24, CLOSE)
    // The nested viewport is one level deeper than anything else on a summary,
    // and a recursion that stopped short would leave it `DROPPED` rather than
    // absent — a string where a shape should be.
    expect(out?.[1]?.viewport).toEqual({ x: 0, y: 0, w: 1512, h: 1512 })
  })

  it('prints an eye line only when there is an eye', () => {
    const t = createTraceRecorder()
    t.start(1, { projection: [eye('left')] })
    t.frame({
      dtMs: 11,
      ticks: 1,
      simMs: 0.3,
      renderMs: 2,
      frameMs: 3,
      gpuMs: 8,
      gpuFresh: true,
      calls: 200,
      triangles: 9_690_000,
      programs: 78,
      scale: 1,
      hz: 90,
      shipX: 0,
      shipZ: 0,
      elapsedSeconds: 0,
      tierMs: 11.1,
      terrainPending: 0,
      terrainDetailPending: 0,
      terrainFading: 0,
      seaPending: 0,
      seaFading: 0,
      pieces: 0,
      viewportWidth: 1512,
      // DEV-243. This spec is about the eye header, not the panel, so the
      // count sits at zero — but the field is required, deliberately: a
      // TraceSample with an optional column is a column that can be silently
      // absent from a run nobody noticed was missing it.
      hudPaints: 0,
      platePaints: 0,
      phase: 1,
      features: 0,
    })
    t.stop()
    const withEye = formatTraceSummary(t.summary())
    expect(withEye).toContain('eye left')
    expect(withEye).toContain('aspect')

    const flat = createTraceRecorder()
    flat.start(1, {})
    flat.stop()
    expect(formatTraceSummary(flat.summary())).not.toContain('eye ')
  })
})
