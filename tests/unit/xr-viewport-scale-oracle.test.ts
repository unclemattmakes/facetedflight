// tests/unit/xr-viewport-scale-oracle.test.ts — DEV-236.
//
// **The ordering the viewport-scale fix rests on, read out of three's own
// build rather than out of our belief about it.**
//
// `render/quality.ts` requests a viewport scale from inside the app's animation
// callback. Whether that does anything at all is a fact about three, not about
// us, and it has two halves:
//
//   1. three reads the PER-VIEW viewport every frame, and writes it onto the
//      eye camera. If it read it once at session start, no request could ever
//      reach the compositor and the whole fix would be a no-op with a plate row
//      saying otherwise.
//   2. three reads it BEFORE it calls us. The spec's "viewport modifiable" flag
//      is true at the start of an animation frame and false once `getViewport()`
//      has been called for that view — so our request cannot take effect on the
//      frame it is made, and lands on the NEXT frame's read. One frame of
//      latency against a controller whose hysteresis is measured in seconds.
//
// Both are relationships between lines in `three.module.js`, so both are
// asserted as ORDERINGS rather than as line numbers: a line number is a fact
// about one release, an ordering is the thing the fix depends on. CLAUDE.md,
// trap 24 — *a test that re-derives its expectation the way the code does has
// not tested the code* — and the same reason `xr-eye-layers.test.ts` reads
// `three.module.js` instead of transcribing the mask arithmetic.
//
// `three` is pinned exact, so if a bump moves any of this the test goes red and
// somebody reads the new `onAnimationFrame` before the pin moves. That IS the
// measured result an upgrade is supposed to land with.
//
// ── §3 is the "next offender" half ────────────────────────────────────────
//
// DEV-208 aimed `requestViewportScale` at `renderer.xr.getBaseLayer()`. Nothing
// caught it for six weeks, because a feature detection that is false asks for
// nothing and says nothing. §3 is the sweep that catches the next module to
// reach for the layer — the same shape as `xr-eye-layers.test.ts` §3, for the
// same reason: when you fix one instance, guard all of them.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO as ROOT } from './helpers/repo-root'
import { listTs } from './helpers/source-tree'

/** The built module three actually ships, read inside the `it` (CLAUDE.md). */
const threeBuild = (): string =>
  fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

/**
 * The index of `needle`, failing with the needle spelled out when it is gone.
 *
 * A bare `indexOf` returning -1 would make every ordering assertion below read
 * `-1 < 12345` and PASS, which is the failure mode this whole file exists to
 * avoid. So the absence is the loud case.
 */
const at = (haystack: string, needle: string): number => {
  const i = haystack.indexOf(needle)
  expect(i, `three's build no longer contains: ${needle}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('§1 three re-reads the per-view viewport every frame', () => {
  it('reads getViewport(view) or getViewSubImage(...).viewport inside the view loop', () => {
    const build = threeBuild()
    // Both paths, because which one runs depends on whether the runtime has the
    // Layers API — and the fix has to work on both. `glBaseLayer` is the
    // `XRWebGLLayer` path; `glProjLayer` is the projection-layer path, which is
    // what a Steam Frame session actually builds.
    at(build, 'viewport = glBaseLayer.getViewport( view );')
    at(build, 'const glSubImage = glBinding.getViewSubImage( glProjLayer, view );')
    at(build, 'viewport = glSubImage.viewport;')
  })

  it('writes that viewport onto the eye camera, so a smaller ask is a smaller draw', () => {
    // The half that turns "three read it" into "the GPU drew fewer pixels".
    // Without this line the request would reach the runtime and change nothing
    // this renderer does.
    at(
      threeBuild(),
      'camera.viewport.set( viewport.x, viewport.y, viewport.width, viewport.height );',
    )
  })
})

describe('§2 three reads the viewport BEFORE it calls the app back', () => {
  it('orders getViewerPose, then the per-view viewport, then our callback', () => {
    const build = threeBuild()
    const pose = at(build, 'pose = frame.getViewerPose(')
    const webglViewport = at(build, 'viewport = glBaseLayer.getViewport( view );')
    const subImage = at(build, 'const glSubImage = glBinding.getViewSubImage( glProjLayer, view );')
    const callback = at(
      build,
      'if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );',
    )

    // THE relationship. A request made in our loop is made after this frame's
    // view has stopped being "viewport modifiable", so it lands on the next
    // frame's read. If this ever inverts, `pushViewportScale` becomes a
    // same-frame knob and the comment above it is wrong.
    expect(pose, 'the pose is read first').toBeLessThan(webglViewport)
    expect(webglViewport, 'XRWebGLLayer path reads before the callback').toBeLessThan(callback)
    expect(subImage, 'projection-layer path reads before the callback').toBeLessThan(callback)
  })

  it('makes getFrame() non-null only inside that callback', () => {
    // `pushViewportScale` has no frame threaded into it; it reads
    // `renderer.xr.getFrame()` and relies on three nulling it after the
    // callback returns, which is what makes an `apply()` from a settings menu a
    // no-op instead of an `InvalidStateError` on a stale `XRView`.
    const build = threeBuild()
    const declared = at(build, 'let xrFrame = null;')
    const assign = at(build, 'xrFrame = frame;')
    const callback = at(build, 'if ( onAnimationFrameCallback ) onAnimationFrameCallback')
    // Searched FROM the callback, not from the top of the file. `let xrFrame =
    // null;` contains `xrFrame = null;`, so a plain `indexOf` finds the
    // DECLARATION — thousands of lines above `onAnimationFrame` — and the
    // ordering assertion then passes while proving the reverse of what it says.
    // Which is this file's own subject arriving in its own assertions: a
    // detector that matches the first thing shaped like the answer.
    const cleared = build.indexOf('xrFrame = null;', callback)

    expect(declared, 'declared before it is assigned').toBeLessThan(assign)
    expect(assign, 'assigned before the callback').toBeLessThan(callback)
    expect(cleared, 'nulled again after the callback returns').toBeGreaterThan(callback)
  })
})

describe('§3 nothing in src/ asks a LAYER for a viewport scale', () => {
  it('never reaches requestViewportScale through getBaseLayer', () => {
    // DEV-208's defect, as a sweep. The WebXR Device API puts
    // `requestViewportScale` and `recommendedViewportScale` on `XRView`; no
    // layer type has either, so a `getBaseLayer()` anywhere near one of those
    // names is the bug coming back.
    //
    // Comments are stripped first, so `quality.ts`'s several paragraphs
    // explaining that the layer is the wrong object do not trip the guard that
    // exists because of them.
    const offenders: string[] = []
    for (const file of listTs(path.join(ROOT, 'src'))) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      // Any `getBaseLayer` within 400 characters of a viewport-scale name. Wide
      // on purpose: the original bug had a `getBaseLayer?.()` call, a type
      // annotation and a feature detect spread over six lines.
      for (const hit of code.matchAll(
        /getBaseLayer[\s\S]{0,400}?(?:request|recommended)ViewportScale/g,
      ) as Iterable<RegExpMatchArray>) {
        offenders.push(
          `${path.relative(ROOT, file).replaceAll(path.sep, '/')}: ${hit[0].slice(0, 60)}…`,
        )
      }
    }
    expect(offenders, 'dynamic viewport scaling lives on XRView — see §1').toEqual([])
  })

  it('asks a view that came out of a viewer pose', () => {
    // The positive control for §3's negative. A sweep that only ever asserts an
    // absence passes just as well on a file that deleted the feature, which is
    // the failure mode CLAUDE.md names for `?pointerlock=0`: the suite goes
    // green because the thing it was watching is gone.
    const code = fs.readFileSync(path.join(ROOT, 'src/render/quality.ts'), 'utf8')
    const body = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(body, 'the frame is read from three').toContain('getFrame')
    expect(body, 'the views come from the viewer pose').toContain('getViewerPose')
    expect(body, 'and each one is asked').toContain('requestViewportScale')
  })
})
