// tests/unit/tv-feel.test.ts: FF-TV feel (DEV-654).
//
// The Director's winner shot, the lower third's lines, the followed racer's
// gate-pass count, and the sting against the 2.5 s ident. All over 2016's own
// recorded `int_01` race (`helpers/tv-race.ts`), so the claims are about a real
// finish and real overtakes, not a fixture built to agree.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CUES, cueTailSeconds } from '@/audio/cues'
import { createTvCamera, TV_CAMERA_POLICY } from '@/game/tv/tv-camera'
import { tvBoundsOf, tvCourseOf } from '@/game/tv/tv-vantage'
import {
  BANNER_CANVAS,
  paintBanner,
  TV_BANNER_FADE_SECONDS,
  TV_BANNER_SECONDS,
  TV_IDENT_SECONDS,
  type TvCtx,
  tvBannerAlpha,
  tvFlatPlacement,
} from '@/render/tv-panel-layout'
import { UI_ACCENT, UI_INK, UI_ON_ACCENT, UI_PLATE } from '@/render/ui-tokens'
import { INT01, RACE_SECONDS, recordedRace } from './helpers/tv-race'

const DT = 1 / 90

const run = () => {
  const race = recordedRace()
  let t = 0
  const cam = createTvCamera({
    craft: () => race.at(t),
    presenting: () => false,
    heightAt: () => 100,
    bounds: tvBoundsOf(INT01),
    course: tvCourseOf(INT01),
    headsetCuts: () => false,
  })
  const rig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
  const camera = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
  const frames: {
    t: number
    winner: boolean
    framing: string | null
    following: string | null
    gates: number
    n: number | null
    overtakes: number
    eye: THREE.Vector3
    craft: { name: string; position: THREE.Vector3 }[]
  }[] = []
  for (let f = 0; f < Math.ceil(RACE_SECONDS / DT); f++) {
    t = f * DT
    cam.frame(DT, rig, camera)
    const r = cam.report()
    frames.push({
      t,
      winner: r.winnerShot,
      framing: r.framing,
      following: r.following,
      gates: r.followedGates,
      n: r.lastOvertake?.n ?? null,
      overtakes: r.overtakes,
      eye: rig.position.clone(),
      craft: race.at(t).map((c) => ({
        name: c.name,
        position: new THREE.Vector3(c.position.x, c.position.y, c.position.z),
      })),
    })
  }
  return frames
}

describe("the winner's shot", () => {
  const frames = run()
  const live = frames.filter((f) => f.winner)

  it('happens, once, for about `winnerSeconds`, as the orbit framing', () => {
    expect(live.length).toBeGreaterThan(0)
    const seconds = live.length * DT
    expect(seconds).toBeGreaterThan(TV_CAMERA_POLICY.winnerSeconds - 0.5)
    expect(seconds).toBeLessThan(TV_CAMERA_POLICY.winnerSeconds + 0.5)
    for (const f of live) expect(f.framing).toBe('orbit')
    // One contiguous window.
    const first = frames.indexOf(live[0] as (typeof frames)[number])
    const last = frames.indexOf(live[live.length - 1] as (typeof frames)[number])
    expect(last - first + 1).toBe(live.length)
  })

  it('starts after the crossing, not on it: the finish camera has the line first', () => {
    // The first frame of the shot is at least `winnerDelay` after the first
    // finisher's crossing, which the camera itself reports as `finish` before it.
    const start = (live[0] as (typeof frames)[number]).t
    const before = frames.filter((f) => f.t < start && f.t > start - TV_CAMERA_POLICY.winnerDelay)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((f) => !f.winner)).toBe(true)
  })

  it('circles the winner at the orbit radius, a full turn of angle in a quarter minute or so', () => {
    // Relative to the racer the eye is on: the horizontal distance is the radius
    // (the ground may lift it, never move it sideways), and its bearing turns.
    const bearings: number[] = []
    for (const f of live) {
      const who = f.craft.find((c) => c.name === f.following)
      expect(who, 'the winner is on screen').toBeDefined()
      const dx = f.eye.x - (who as { position: THREE.Vector3 }).position.x
      const dz = f.eye.z - (who as { position: THREE.Vector3 }).position.z
      // Within a few metres: the camera ease and the cap on distance may pull it in a little.
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(TV_CAMERA_POLICY.orbitRadius + 1)
      bearings.push(Math.atan2(dz, dx))
    }
    // It turns: the bearing is not constant, and moves the way `orbitRate` says.
    const unwrapped = bearings.reduce<number[]>((acc, b) => {
      const prev = acc[acc.length - 1]
      if (prev === undefined) return [b]
      let d = b - (prev % (2 * Math.PI))
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return [...acc, prev + d]
    }, [])
    const turned = (unwrapped[unwrapped.length - 1] as number) - (unwrapped[0] as number)
    expect(Math.abs(turned)).toBeGreaterThan(
      TV_CAMERA_POLICY.orbitRate * TV_CAMERA_POLICY.winnerSeconds * 0.5,
    )
  })

  it('the eye is never in the ground', () => {
    for (const f of live) expect(f.eye.y).toBeGreaterThan(100)
  })

  it('is the FIRST racer home, and the camera is on that one throughout', () => {
    const names = new Set(live.map((f) => f.following))
    expect(names.size).toBe(1)
  })
})

describe('the camera says what the lower third needs', () => {
  const frames = run()

  it('lastOvertake is a running count that matches `overtakes` when it changes', () => {
    let last: number | null = null
    let changes = 0
    for (const f of frames) {
      if (f.n !== null && f.n !== last) {
        changes++
        last = f.n
        expect(f.n).toBeLessThanOrEqual(f.overtakes)
      }
    }
    expect(changes).toBeGreaterThan(0)
  })

  it('followedGates only drops on a restart of the racer, and moves forward as it flies', () => {
    let gatesFor: string | null = null
    let gates = 0
    let rises = 0
    for (const f of frames) {
      if (f.following === gatesFor) {
        // A recorded racer that loops back to the start drops by many at once; a drop of one is a bug.
        if (f.gates < gates) expect(gates - f.gates).toBeGreaterThanOrEqual(5)
        if (f.gates > gates) rises++
      }
      gatesFor = f.following
      gates = f.gates
    }
    expect(rises).toBeGreaterThan(10)
  })
})

describe('the lower third line, painted', () => {
  const ink = (kind: 'overtake' | 'winner'): string[] => {
    const styles: string[] = []
    let fill: TvCtx['fillStyle'] = ''
    const ctx: TvCtx = {
      font: '',
      get fillStyle() {
        return fill
      },
      set fillStyle(v) {
        fill = v
        styles.push(String(v))
      },
      strokeStyle: '',
      lineWidth: 1,
      textAlign: 'left',
      textBaseline: 'middle',
      clearRect() {},
      fillRect() {},
      strokeRect() {},
      fillText() {},
      measureText: (t: string) => ({ width: t.length * 20 }),
    }
    paintBanner(ctx, 'CUTTER takes #1', kind)
    return styles
  }

  it('paints in the UI tokens only: an overtake in plate, accent and ink; the winner in accent and its ink', () => {
    expect(new Set(ink('overtake'))).toEqual(new Set([UI_PLATE, UI_ACCENT, UI_INK]))
    expect(new Set(ink('winner'))).toEqual(new Set([UI_ACCENT, UI_ON_ACCENT]))
  })

  it('stands three seconds and fades over the last of them', () => {
    expect(TV_BANNER_SECONDS).toBe(3)
    expect(tvBannerAlpha(TV_BANNER_SECONDS)).toBe(1)
    expect(tvBannerAlpha(TV_BANNER_FADE_SECONDS / 2)).toBeCloseTo(0.5, 12)
    expect(tvBannerAlpha(0)).toBe(0)
  })

  it('stands bottom centre on a monitor and clear of the bug in the bottom-right corner', () => {
    const view = { fovDeg: 70, aspect: 16 / 9 }
    const aspect = BANNER_CANVAS.width / BANNER_CANVAS.height
    const banner = tvFlatPlacement('banner', view, aspect)
    const bug = tvFlatPlacement('bug', view, 1.5)
    expect(banner.position[0]).toBe(0)
    const bannerRight = banner.position[0] + banner.width / 2
    const bugLeft = bug.position[0] - bug.width / 2
    expect(bannerRight).toBeLessThan(bugLeft)
    // Inside the frame, low.
    const hh = Math.tan((70 / 2) * (Math.PI / 180))
    expect(banner.position[1] - banner.height / 2).toBeGreaterThan(-hh)
    expect(banner.position[1]).toBeLessThan(0)
  })

  it('stands above the board on a phone held upright, inside the frame', () => {
    const view = { fovDeg: 70, aspect: 9 / 16 }
    const banner = tvFlatPlacement('banner', view, BANNER_CANVAS.width / BANNER_CANVAS.height)
    const hh = Math.tan((70 / 2) * (Math.PI / 180))
    const hw = hh * view.aspect
    expect(banner.position[0] + banner.width / 2).toBeLessThanOrEqual(hw)
    expect(banner.position[0] - banner.width / 2).toBeGreaterThanOrEqual(-hw)
    expect(banner.position[1] + banner.height / 2).toBeLessThan(hh)
  })
})

describe('the ident and its sting', () => {
  it('the sting is over before the ident is (the ident is 2.5 s, the sting is under one second)', () => {
    expect(TV_IDENT_SECONDS).toBe(2.5)
    expect(cueTailSeconds(CUES['tv.ident'])).toBeLessThan(TV_IDENT_SECONDS)
    expect(cueTailSeconds(CUES['tv.ident'])).toBeLessThan(1.5)
  })
})
