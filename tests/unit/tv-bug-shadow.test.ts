// DEV-903: every shadow on the FF-TV bug falls DOWN and to the RIGHT of what casts it.
//
// Matt, 2026-10-10: *"FFTV logo's drop shadow is 'up and left' when it should be
// 'down and right'"*. The offsets were right on the canvas and the blob still read
// up and left on screen, because its plane stood behind the gem and the bug sits in
// the bottom-right corner: depth pulls a plane toward the screen's centre. So this
// pins the two halves somebody would edit, and `tests/e2e/tv-bug-shadow.spec.ts`
// reads the fall on the real frame (`tvPanel.probe().bugShadows`).

import { describe, expect, it } from 'vitest'
import { TV_BUG_ORDER, TV_SHADOW, tvBlobZ } from '@/render/tv-bug'

describe('the TV bug shadows fall down and right (DEV-903)', () => {
  it('paints both offsets down and right: canvas y points DOWN, so both are positive', () => {
    expect(TV_SHADOW.dx, 'right').toBeGreaterThan(0)
    expect(TV_SHADOW.dy, 'down (canvas y is down)').toBeGreaterThan(0)
    expect(
      TV_SHADOW.blobFall,
      'the blob falls the same way as the word, not against it',
    ).toBeGreaterThan(0)
  })

  it('stands the blob at the logo middle depth, not behind it, where parallax throws it up and left', () => {
    const logo = { min: { z: -0.3 }, max: { z: 0.5 } }
    expect(tvBlobZ(logo)).toBeCloseTo(0.1, 12)
    expect(tvBlobZ(logo)).toBeGreaterThan(logo.min.z)
  })

  it('keeps the blob behind the gold by drawing it first', () => {
    expect(TV_BUG_ORDER.blob).toBeLessThan(TV_BUG_ORDER.emblem)
  })
})
