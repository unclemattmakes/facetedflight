// tests/unit/phone-plates-geometry.test.ts: DEV-894, the plates the e2e sweep cannot reach.
//
// The room lobby and the join-code keypad need a rooms sidecar, so the phone sweep
// (`tests/e2e/phone-plates.spec.ts`) does not stand them up. Their phone poses are
// held here as geometry on a Pixel 7 held sideways: the glass is 412 css px tall at
// a vertical field of view the pause plate's measurement gives (a 35.5-degree plate
// was 365 px of 720, so 70 degrees), and 915 wide.

import { afterEach, describe, expect, it } from 'vitest'
import { rowBand } from '@/render/pause'
import { PHONE_MIN_TAP_PX, phoneUi } from '@/render/phone-floor'
import { codePlateExtent } from '@/render/room-code-plate'
import {
  LOBBY_BEARING_DEG,
  LOBBY_DISTANCE,
  LOBBY_SCALE,
  lobbyGapDeg,
  lobbyPlateOffset,
} from '@/render/room-lobby'

const VFOV_DEG = 70
const GLASS_H = 412
const GLASS_W = 915
const PX_PER_DEG = GLASS_H / VFOV_DEG
const HALF_H_DEG = 57

afterEach(() => {
  phoneUi.on = false
})

describe('the lobby on a phone (DEV-894)', () => {
  it('a desktop is unchanged', () => {
    phoneUi.on = false
    expect(lobbyPlateOffset(LOBBY_BEARING_DEG.roster)[0]).toBeCloseTo(
      Math.sin((LOBBY_BEARING_DEG.roster * Math.PI) / 180) * LOBBY_DISTANCE,
      9,
    )
  })

  it('its rows are over the tap floor, the pair does not touch, and both stay in the frame', () => {
    phoneUi.on = true
    const [rx, ry, rz] = lobbyPlateOffset(LOBBY_BEARING_DEG.roster)
    const [ax] = lobbyPlateOffset(LOBBY_BEARING_DEG.actions)
    // A seven-row roster: rows at the plate's scale, as degrees at the plate's distance.
    const scale = 2.2 * 1.35
    const rowDeg = ((Math.atan((rowBand(7) * scale) / 2 / LOBBY_DISTANCE) * 2) / Math.PI) * 180
    expect(rowDeg * PX_PER_DEG, 'row pitch').toBeGreaterThanOrEqual(PHONE_MIN_TAP_PX)
    // Horizontal: each plate's far edge inside the half field of view, and a gap between them.
    const half = Math.atan((0.56 * scale) / 2 / LOBBY_DISTANCE) * (180 / Math.PI)
    const centre = Math.atan2(Math.abs(rx), -rz) * (180 / Math.PI)
    expect(centre + half, 'far edge').toBeLessThan(HALF_H_DEG)
    expect(centre * 2 - 2 * half, 'gap between the pair').toBeGreaterThan(0)
    expect(ax).toBeCloseTo(-rx, 9)
    // Vertical: the seven-row plate's top and bottom inside +-35 degrees.
    const tall = (rowBand(7) * 7 + 0.1092 + 0.021) * scale
    const top = ry + 0.21 * scale
    const toDeg = (y: number) => Math.atan2(y, -rz) * (180 / Math.PI)
    expect(Math.abs(toDeg(top))).toBeLessThan(VFOV_DEG / 2)
    expect(Math.abs(toDeg(top - tall))).toBeLessThan(VFOV_DEG / 2)
    expect(GLASS_W).toBeGreaterThan(0)
  })

  it('negative control: the desktop gap closes at the phone scale, so the bearings had to move', () => {
    phoneUi.on = false
    const widerAt19 = (Math.atan((0.56 * LOBBY_SCALE * 1.35) / 2 / LOBBY_DISTANCE) * 180) / Math.PI
    expect(LOBBY_BEARING_DEG.actions - LOBBY_BEARING_DEG.roster - 2 * widerAt19).toBeLessThan(0)
    expect(lobbyGapDeg()).toBeGreaterThan(0)
  })
})

describe('the join-code keypad on a phone (DEV-894)', () => {
  it('is centred on the eye line and inside the frame', () => {
    phoneUi.on = true
    const e = codePlateExtent()
    expect(e.topDeg).toBeGreaterThan(0)
    expect(e.bottomDeg).toBeLessThan(0)
    expect(Math.abs(e.topDeg + e.bottomDeg), 'centred').toBeLessThan(1.5)
    expect(e.topDeg).toBeLessThan(VFOV_DEG / 2)
    expect(e.halfWidthDeg).toBeLessThan(HALF_H_DEG)
  })
})
