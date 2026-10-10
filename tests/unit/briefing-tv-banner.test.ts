// tests/unit/briefing-tv-banner.test.ts: FF-TV shows no launch banner. DEV-863.
//
// Matt, 2026-10-08: "i'm seeing the 'press a to launch' panel during FFTV". A
// viewer has no ship, so the pad's prompt, the ride's "Powering On..." and the
// countdown are a player's lines, never a broadcast's.

import { describe, expect, it } from 'vitest'
import { type BriefingCtx, createBriefing } from '@/boot/app/flight/briefing'
import type { Level } from '@/content/level-schema'
import { launchSpecOf } from '@/game/course-specs'
import { createLaunch } from '@/sim/launch'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVEL = int01 as unknown as Level

const SPEC = launchSpecOf(LEVEL, false)

const banner = (tv: boolean): string | null => {
  const ctx = {
    boundarySpec: null,
    launch: createLaunch(SPEC),
    launchSpec: SPEC,
    level: LEVEL,
    roomWaitingLine: () => null,
    confirmDevice: () => 'pad',
    tvActive: () => tv,
  } as unknown as BriefingCtx
  return createBriefing(ctx).launchBanner()
}

describe('DEV-863: the launch banner is a pilot line, not a viewer line', () => {
  it('a player waiting on the pad is told how to launch', () => {
    expect(banner(false)).toMatch(/launch/i)
  })

  it('FF-TV, on the same pad, shows nothing', () => {
    expect(banner(true)).toBeNull()
  })
})
