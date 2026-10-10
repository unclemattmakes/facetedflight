// tests/unit/camera-reads-drawn.test.ts: a camera that follows a craft reads
// the pose THIS frame draws. DEV-612 (and DEV-319's rule, in its frame-order
// form).
//
// Matt, 2026-10-03, watching the TV specs: "the hoverjet that's being chases
// is juddery." TV's camera reads the craft's DRAWN Object3Ds, as DEV-319 made
// every camera do, but it ran BEFORE the frame drew them: the exhibition's
// racers were placed only by `liveRacers.render(alpha)` and a room's ships only
// by `roomRender`, both after the camera block, so the camera sat on the pose
// the previous frame drew and the hull led it by one frame's travel.
// `tests/e2e/chase-camera-smooth.spec.ts`'s TV arms measure it in a browser;
// this is the same rule as frame order, which CI can run.

import { describe, expect, it } from 'vitest'
import { appFileThroughWith, appSourceThroughCtx, inOrder } from './helpers/app-source'

/** The racers' and the room's placement, the cameras that read them, then the trails. */
const ORDER = [
  // stepFixed hands back `alpha`; the lift is drawn from it (DEV-445) ...
  'elevator?.render(alpha)',
  // ... and so, now, is everything a camera follows.
  'liveRacers?.place(alpha)',
  'roomPlace() //',
  // The cameras: `?view=chase` (DEV-319), `?watch=` and TV live (DEV-481),
  // TV's exhibition (DEV-483 through DEV-481).
  'chaseCamera(render.camera, CHASE_TARGET, liveRacers, flight)',
  'watchCamera(frameSeconds)',
  'exhibition.frame(frameSeconds, alpha)',
  // The trails, which face the eye the cameras just placed.
  'liveRacers?.render(alpha, cameraWorld',
  'roomRender(cameraWorld',
]

describe('the craft a camera follows are placed before the camera reads them (DEV-612)', () => {
  it('places the racers and the room’s ships after the step and before every camera', () => {
    const frame = appFileThroughWith('liveRacers?.place(alpha)').text
    // Throws, naming the anchor, if any is missing or out of order.
    expect(inOrder(frame, ORDER)).toHaveLength(ORDER.length)
  })

  it('places a room’s ships in one place, so no second placement can land after a camera', () => {
    const calls = appSourceThroughCtx().match(/roomShips\??\.update\(/g) ?? []
    expect(calls).toHaveLength(1)
    const places = appSourceThroughCtx().match(/liveRacers\??\.place\(/g) ?? []
    expect(places).toHaveLength(1)
  })
})
