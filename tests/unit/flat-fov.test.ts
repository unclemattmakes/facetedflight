// tests/unit/flat-fov.test.ts — a wider lens with speed, and the three places
// it must NOT be one (DEV-093).
//
// The order is the order these would hurt in:
//
//  1. **Never in VR.** research 05 §R7: writing `camera.fov` while presenting
//     desynchronises the rendered frustum from the compositor's lens assumptions
//     and is a direct nausea trigger. This is the only assertion here that is
//     about harm rather than about looks, so it is first and it is asserted from
//     both directions — the `isPresenting` guard, and the restore at both ends
//     of a session.
//  2. **Classic is untouched.** Same reason as every other row's Classic test:
//     if a Classic flag ever does something, "the ledger as it stands" stops
//     being a fact and no sim test would notice, because this is render-side.
//  3. **It settles, and a settled lens costs nothing.** An exponential ease
//     never reaches its target, so without the snap the projection matrix would
//     be rebuilt every frame for ever and `camera.fov` would never be exactly
//     the base again. Both halves are asserted by COUNTING
//     `updateProjectionMatrix`, not by believing the comment.
//  4. **The preset's curve is argued from the game's own speeds.** DEV-069's
//     lesson: when the sheet has a key for the thing you are implementing,
//     import the key and assert against it. Three of the five breakpoints are
//     constants-sheet numbers and this is where that claim is checked rather
//     than asserted in a note.
//
// No GL context: `createFlatFov` takes a `PerspectiveCamera` (real, three needs
// no context for one) and the two renderer properties it reads, so a plain
// object stands in for the renderer — the same shape `tone.test.ts` uses.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition, EditionFlatFov } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { DERIVED, HOVERJET } from '@/generated/constants.generated'
import { baseFovFor, createFlatFov, FOV_SNAP_DEGREES, fovFor } from '@/render/flat-fov'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

/** The renderer's own lens, from `render/renderer.ts`. Read, never retyped. */
const RENDERER_FOV = 70

/**
 * A fake renderer: the one property `update` reads, and the two session events.
 *
 * `isPresenting` is writable so a test can start a session without a headset,
 * and `fire` stands in for three dispatching `sessionstart` / `sessionend`.
 */
const fakeRenderer = () => {
  const listeners = new Map<string, Set<() => void>>()
  return {
    xr: {
      isPresenting: false,
      addEventListener(type: string, fn: () => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener(type: string, fn: () => void) {
        listeners.get(type)?.delete(fn)
      },
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
  }
}

/** A real camera, and a count of every projection rebuild it is asked for. */
const fakeCamera = () => {
  const camera = new THREE.PerspectiveCamera(RENDERER_FOV, 16 / 9, 0.08, 6000)
  const counted = camera as THREE.PerspectiveCamera & { rebuilds: number }
  counted.rebuilds = 0
  const real = camera.updateProjectionMatrix.bind(camera)
  counted.updateProjectionMatrix = () => {
    counted.rebuilds++
    real()
  }
  return counted
}

const rig = (edition: Edition) => {
  const camera = fakeCamera()
  const renderer = fakeRenderer()
  const state = createEditionState(edition, DEFAULT_SETTINGS)
  const fov = createFlatFov(state, camera, renderer as never)
  return { camera, renderer, state, fov }
}

/** Run `n` frames at 60 Hz. The real loop's dt, near enough to matter. */
const steps = (
  fov: { update(a: number, b: boolean, c: number): void },
  airspeed: number,
  active: boolean,
  n: number,
  dt = 1 / 60,
): void => {
  for (let i = 0; i < n; i++) fov.update(airspeed, active, dt)
}

describe('the renderer is the only other thing that touches the camera', () => {
  it('never writes camera.fov in renderer.ts — the resize handler sets aspect only', async () => {
    // The one place a dynamic fov could be silently undone, and the reason this
    // is a file read rather than a comment: `onResize` calls
    // `updateProjectionMatrix`, which PRESERVES whatever fov is there — but a
    // future hand reaching for `camera.fov = 70` in that handler would put the
    // lens back on every window resize, and nothing else in the suite would
    // notice because no test resizes a window.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/render/renderer.ts', 'utf8'),
    )
    expect(src).not.toMatch(/camera\.fov\s*=/)
    // And the thing it DOES write, so this test fails loudly if the handler is
    // rewritten rather than passing on an empty file.
    expect(src).toMatch(/camera\.aspect\s*=/)
  })
})

describe('fovFor — the pure half', () => {
  const block = anniversary.render.flatFov

  it('is the base exactly, at and below the first breakpoint', () => {
    // Load-bearing: at cruise the lens is the AUTHORED one, so every existing
    // A/B frame of a cruising ship is unchanged and the effect is a change
    // signal rather than a new baseline.
    expect(fovFor(block, 0, RENDERER_FOV)).toBe(RENDERER_FOV)
    expect(fovFor(block, 50, RENDERER_FOV)).toBe(RENDERER_FOV)
    expect(fovFor(block, block.addBySpeed[0]?.[0] ?? 0, RENDERER_FOV)).toBe(RENDERER_FOV)
  })

  it('is non-decreasing in airspeed, over the whole reachable range', () => {
    // The property, not a value: a lens that narrowed somewhere in the middle
    // would be a speed cue pointing the wrong way for part of the run, and it
    // would be invisible in any test that sampled two speeds.
    let previous = -Infinity
    for (let v = -50; v <= 500; v += 0.5) {
      const deg = fovFor(block, v, RENDERER_FOV)
      expect(deg, `airspeed ${v}`).toBeGreaterThanOrEqual(previous)
      previous = deg
    }
  })

  it('is FLAT above the top breakpoint, never extrapolated', () => {
    const top = block.addBySpeed[block.addBySpeed.length - 1] as readonly [number, number]
    expect(fovFor(block, top[0], RENDERER_FOV)).toBeCloseTo(RENDERER_FOV + top[1], 6)
    // 1,000 m/s is not reachable; the point is that if it were, the lens would
    // be the same as at the top of the curve rather than a wide-angle fisheye.
    expect(fovFor(block, 1000, RENDERER_FOV)).toBeCloseTo(RENDERER_FOV + top[1], 6)
  })

  it('is the base at every speed when the flag is off', () => {
    for (const v of [0, 90, 180, 240, 340, 1000]) {
      expect(fovFor(classic.render.flatFov, v, RENDERER_FOV)).toBe(RENDERER_FOV)
    }
  })

  it('clamps a preset that would produce an unusable projection', () => {
    // `updateProjectionMatrix` takes `tan(fov/2)`: 180 is a divide by zero and
    // the projection matrix goes to NaN, which renders an EMPTY frame rather
    // than a wrong one. A curve top is a delta and nothing else checks it.
    const absurd: EditionFlatFov = {
      ...anniversary.render.flatFov,
      addBySpeed: [
        [0, 0],
        [100, 400],
      ],
    }
    const wide = fovFor(absurd, 100, RENDERER_FOV)
    expect(wide).toBeLessThan(180)
    expect(Number.isFinite(wide)).toBe(true)

    const negative: EditionFlatFov = {
      ...anniversary.render.flatFov,
      addBySpeed: [
        [0, 0],
        [100, -400],
      ],
    }
    expect(fovFor(negative, 100, RENDERER_FOV)).toBeGreaterThan(0)
  })
})

describe('baseFovFor', () => {
  it('falls back to the renderer’s own lens when base is null', () => {
    expect(anniversary.render.flatFov.base).toBeNull()
    expect(classic.render.flatFov.base).toBeNull()
    expect(baseFovFor(anniversary.render.flatFov, RENDERER_FOV)).toBe(RENDERER_FOV)
    // And it keeps meaning "the renderer's", so moving that number moves this.
    expect(baseFovFor(anniversary.render.flatFov, 55)).toBe(55)
  })

  it('takes an override when the preset states one', () => {
    const narrow: EditionFlatFov = { ...anniversary.render.flatFov, base: 58 }
    expect(baseFovFor(narrow, RENDERER_FOV)).toBe(58)
  })
})

describe('NEVER IN VR — research 05 §R7', () => {
  it('leaves camera.fov alone while presenting, at any speed, with the flag on', () => {
    const { camera, renderer, fov } = rig(anniversary)
    renderer.xr.isPresenting = true
    const before = camera.fov
    const rebuilds = camera.rebuilds
    // 340 m/s is the top of the curve: if anything were going to move, it would.
    steps(fov, 340, true, 200)
    expect(camera.fov).toBe(before)
    expect(camera.rebuilds).toBe(rebuilds)
  })

  it('restores the base when a session STARTS, mid-effect', () => {
    const { camera, renderer, fov } = rig(anniversary)
    steps(fov, 340, true, 200)
    expect(camera.fov).toBeGreaterThan(RENDERER_FOV)

    renderer.xr.isPresenting = true
    renderer.fire('sessionstart')
    expect(camera.fov).toBe(RENDERER_FOV)
    // And it stays there: no frame in session writes anything.
    steps(fov, 340, true, 200)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('restores the base when a session ENDS, over three’s own back-derived fov', () => {
    // `WebXRManager.updateCamera` writes `camera.fov` itself every XR frame,
    // back-derived from the XRView's projection matrix
    // (`three.module.js:14676`) — so a Quest leaves the FLAT camera on ~96°.
    // That wart predates this feature; the restore fixes it for free, and this
    // is the assertion that says so.
    const { camera, renderer, fov } = rig(anniversary)
    renderer.xr.isPresenting = true
    camera.fov = 96.1 // what three left behind
    renderer.xr.isPresenting = false
    renderer.fire('sessionend')
    expect(camera.fov).toBe(RENDERER_FOV)
    expect(fov.current).toBe(RENDERER_FOV)
  })
})

describe('Classic is untouched', () => {
  it('writes nothing and rebuilds nothing, through a whole run', () => {
    const { camera, fov } = rig(classic)
    const rebuilds = camera.rebuilds
    // A sweep from a standstill to the top of the boost ladder and back.
    for (const v of [0, 25, 90, 120, 180, 240, 350, 240, 90, 0]) steps(fov, v, true, 60)
    expect(camera.fov).toBe(RENDERER_FOV)
    expect(camera.rebuilds).toBe(rebuilds)
  })
})

describe('the ease', () => {
  it('opens toward fovFor and settles EXACTLY there, inside two seconds', () => {
    // TWO SECONDS, not six hundred frames, and that is the point: run an
    // exponential long enough and float64 saturates, so "it converged" would
    // pass with no snap at all and the test would be measuring the mantissa
    // rather than the code. At the preset's 0.22 s time constant the remaining
    // gap after 2 s is 1.2e-4 of 7.5°, which is a thousandth of a degree — real,
    // invisible, and exactly what the snap is for.
    const { camera, fov } = rig(anniversary)
    const want = fovFor(anniversary.render.flatFov, 240, RENDERER_FOV)
    steps(fov, 240, true, 120)
    expect(camera.fov).toBe(want)
    expect(fov.current).toBe(want)
    expect(fov.target).toBe(want)
  })

  it('stops rebuilding the projection once it has settled', () => {
    // Without the snap, exponential decay would rebuild the projection matrix
    // every frame for the rest of the session — 144 a second, for ever.
    const { camera, fov } = rig(anniversary)
    steps(fov, 240, true, 120)
    const settled = camera.rebuilds
    steps(fov, 240, true, 300)
    expect(camera.rebuilds).toBe(settled)
  })

  it('is monotonic on the way up — no overshoot, no ringing', () => {
    const { camera, fov } = rig(anniversary)
    let previous = camera.fov
    const want = fovFor(anniversary.render.flatFov, 340, RENDERER_FOV)
    for (let i = 0; i < 400; i++) {
      fov.update(340, true, 1 / 60)
      expect(camera.fov).toBeGreaterThanOrEqual(previous)
      expect(camera.fov).toBeLessThanOrEqual(want)
      previous = camera.fov
    }
  })

  it('closes MORE SLOWLY than it opens', () => {
    // The one thing `Boost_FOV.cs` settles: it grows its lerp parameter at
    // `speed` on the way out and at `speed * 0.8` on the way back. The preset's
    // ratio is bigger than that and is a number to argue with; the DIRECTION is
    // what this asserts, because that is the part with a source.
    const block = anniversary.render.flatFov
    expect(block.releaseSeconds).toBeGreaterThan(block.attackSeconds)

    const open = rig(anniversary)
    const shut = rig(anniversary)
    const top = fovFor(block, 340, RENDERER_FOV)
    // Both travel the same distance, in opposite directions, for the same time.
    steps(open.fov, 340, true, 12)
    steps(shut.fov, 340, true, 600) // all the way up first
    expect(shut.camera.fov).toBe(top)
    steps(shut.fov, 0, true, 12)

    const opened = open.camera.fov - RENDERER_FOV
    const closed = top - shut.camera.fov
    expect(opened).toBeGreaterThan(closed)
  })

  it('is frame-rate independent: the same wall time lands in the same place', () => {
    // A fixed per-frame lerp factor would make this effect nearly twice as fast
    // on a 144 Hz monitor as on a 72 Hz one, which is how a tuned feel becomes a
    // per-machine feel. One second of easing, two frame rates.
    const slow = rig(anniversary)
    const fast = rig(anniversary)
    steps(slow.fov, 240, true, 72, 1 / 72)
    steps(fast.fov, 240, true, 144, 1 / 144)
    expect(fast.camera.fov).toBeCloseTo(slow.camera.fov, 3)
  })

  it('converges in ONE step from a huge dt — a tab that was hidden', () => {
    const { camera, fov } = rig(anniversary)
    fov.update(240, true, 10)
    expect(camera.fov).toBe(fovFor(anniversary.render.flatFov, 240, RENDERER_FOV))
  })
})

describe('inactive is the base, and those are three different noes', () => {
  it('returns to the base exactly, and then leaves it alone', () => {
    // The hangar, the pause plate and the elevator ride all have a non-zero
    // body velocity and none of them should move the lens; so does `?view=cam`,
    // where two screenshots of one viewpoint have to be the same screenshot.
    const { camera, fov } = rig(anniversary)
    steps(fov, 340, true, 240)
    expect(camera.fov).toBeGreaterThan(RENDERER_FOV)

    steps(fov, 340, false, 240)
    expect(camera.fov).toBe(RENDERER_FOV)
    const settled = camera.rebuilds
    steps(fov, 340, false, 120)
    expect(camera.rebuilds).toBe(settled)
  })
})

describe('a preset flip', () => {
  it('lands the new base immediately and drops any lookdev patch', () => {
    const { camera, state, fov } = rig(anniversary)
    steps(fov, 340, true, 600)
    expect(camera.fov).toBeGreaterThan(RENDERER_FOV)

    state.setLook(classic)
    // Immediately, not eased: `base` is content, and easing between two presets'
    // idea of the resting lens would make the flip itself look like an effect.
    expect(camera.fov).toBe(RENDERER_FOV)
    expect(fov.block.enabled).toBe(false)
    steps(fov, 340, true, 600)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('applies a base override at CONSTRUCTION, before the first frame', () => {
    // So the very first photograph of the flat build is already the lens the
    // preset asked for, rather than one frame of 70.
    const narrow: Edition = {
      ...anniversary,
      render: { ...anniversary.render, flatFov: { ...anniversary.render.flatFov, base: 58 } },
    }
    const { camera, fov } = rig(narrow)
    expect(camera.fov).toBe(58)
    expect(fov.base).toBe(58)
  })
})

describe('the lookdev door', () => {
  it('takes a live patch and a preset flip discards it', () => {
    const { camera, state, fov } = rig(anniversary)
    fov.tune({
      addBySpeed: [
        [0, 0],
        [100, 20],
      ],
    })
    steps(fov, 100, true, 600)
    expect(camera.fov).toBeCloseTo(RENDERER_FOV + 20, 6)

    state.setLook(classic)
    expect(fov.block.addBySpeed).toEqual(classic.render.flatFov.addBySpeed)
  })

  it('moves the base live, and snaps', () => {
    const { camera, fov } = rig(anniversary)
    fov.setBase(58)
    expect(camera.fov).toBe(58)
    expect(fov.base).toBe(58)
    // And the curve is still a delta ON the new base, not an absolute.
    steps(fov, 340, true, 600)
    expect(camera.fov).toBe(fovFor(anniversary.render.flatFov, 340, 58))
  })
})

describe('the preset’s curve is argued from the game’s own speeds', () => {
  const curve = anniversary.render.flatFov.addBySpeed
  const at = (x: number): number => {
    const point = curve.find((p) => p[0] === x)
    if (!point) throw new Error(`no breakpoint at ${x} m/s — the curve is ${JSON.stringify(curve)}`)
    return point[1]
  }

  it('starts at zero on the UNBOOSTED terminal speed, off the sheet', () => {
    // `derived.hoverjet.terminalSpeedCruise` — the thrust/drag fixed point with
    // gravity off, and ANNIVERSARY.md §2.1's "90 m/s at 300 m". Imported rather
    // than retyped: DEV-069's lesson is that a generated constant no code path
    // reads is documentation, not a guard.
    const cruise = DERIVED.hoverjet.terminalSpeedCruise
    expect(cruise).toBeGreaterThan(89)
    expect(cruise).toBeLessThan(91)
    expect(at(90)).toBe(0)
    expect(Math.abs(90 - cruise)).toBeLessThan(0.2)
  })

  it('steps at the boost floors the particles and the shake step at', () => {
    // A lens that opened at 200 while the plume lit at 240 would read as two
    // unrelated effects. Same argument `game/cockpit-shake.ts` makes for the
    // buffet, same source.
    expect(HOVERJET.ship.minBoostEffectsSpeed).toBe(120)
    expect(HOVERJET.ship.minBoostEffect_stage2_speed).toBe(240)
    expect(at(120)).toBeGreaterThan(0)
    expect(at(240)).toBeGreaterThan(at(120))
  })

  it('has its middle breakpoint on the BOOSTED terminal speed', () => {
    // `derived.hoverjet.terminalSpeedBoost` = 179.6229, exactly twice cruise.
    // This is the speed a player actually HOLDS on a straight with the boost in
    // and no speed chain, so it is the one value on this curve that is felt for
    // seconds at a time rather than passed through.
    const boost = DERIVED.hoverjet.terminalSpeedBoost
    expect(boost / DERIVED.hoverjet.terminalSpeedCruise).toBeCloseTo(2, 3)
    expect(Math.abs(180 - boost)).toBeLessThan(0.4)
    expect(at(180)).toBeGreaterThan(0)
  })

  it('opens by a racing-cue amount and not a fisheye', () => {
    // The sanity band, and the pair of numbers Matt is being asked to argue
    // with. At the boosted terminal the lens is 5° wider than authored — about
    // 7 % — and at the top of the curve 9°. A wide lens minifies, so this is
    // spending a little of ANNIVERSARY.md §1.5 item 8's scale to buy §2's speed;
    // the row says so.
    const held = fovFor(anniversary.render.flatFov, 180, RENDERER_FOV)
    expect(held - RENDERER_FOV).toBeGreaterThan(2)
    expect(held - RENDERER_FOV).toBeLessThan(8)
    const top = fovFor(anniversary.render.flatFov, 340, RENDERER_FOV)
    expect(top - RENDERER_FOV).toBeLessThan(15)
  })

  it('Classic’s block is a no-op by its NUMBERS, not only by its flag', () => {
    // Belt and braces, like every other Classic block: somebody flipping the
    // flag by hand to see what it does has to get nothing.
    expect(classic.render.flatFov.enabled).toBe(false)
    for (const [, y] of classic.render.flatFov.addBySpeed) expect(y).toBe(0)
    const on: EditionFlatFov = { ...classic.render.flatFov, enabled: true }
    for (const v of [0, 90, 180, 240, 350]) {
      expect(fovFor(on, v, RENDERER_FOV)).toBe(RENDERER_FOV)
    }
  })

  it('has time constants a person can feel, and a snap far below one', () => {
    const block = anniversary.render.flatFov
    // Under 20 ms is a cut and over two seconds is a lens nobody noticed moving.
    expect(block.attackSeconds).toBeGreaterThan(0.02)
    expect(block.attackSeconds).toBeLessThan(2)
    expect(block.releaseSeconds).toBeLessThan(4)
    // 0.01° of a 70° lens is one part in 7,000: the snap must be well under
    // anything the curve asks for, or it would eat the effect rather than end it.
    expect(FOV_SNAP_DEGREES).toBeLessThan(0.1)
  })
})

describe('the override — another camera’s answer (DEV-128)', () => {
  // The third-person arm hands its own speed term in here rather than writing
  // `camera.fov` itself, so this stays the one writer and the never-in-VR rule
  // is kept in one place for both cameras.

  it('eases to base + override, whatever `active` and the preset say', () => {
    // Classic, whose own curve is flat and whose flag is off: the override
    // still moves the lens, because it is not this feature's curve.
    const { camera, fov } = rig(classic)
    for (let i = 0; i < 400; i++) fov.update(0, false, 1 / 60, 6)
    expect(camera.fov).toBeCloseTo(RENDERER_FOV + 6, 6)
  })

  it('an override of zero is EXACTLY the base — 2016’s rigid camera at 2016’s one fov', () => {
    const { camera, fov } = rig(anniversary)
    for (let i = 0; i < 400; i++) fov.update(340, true, 1 / 60, 0)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('returns to the cockpit curve when the override is withdrawn', () => {
    const { camera, fov } = rig(anniversary)
    for (let i = 0; i < 400; i++) fov.update(340, false, 1 / 60, 8)
    expect(camera.fov).toBeCloseTo(RENDERER_FOV + 8, 6)
    for (let i = 0; i < 400; i++) fov.update(340, true, 1 / 60, null)
    expect(camera.fov).toBeCloseTo(fovFor(anniversary.render.flatFov, 340, RENDERER_FOV), 6)
    for (let i = 0; i < 400; i++) fov.update(0, false, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('is refused in a session like everything else here', () => {
    const { camera, renderer, fov } = rig(anniversary)
    renderer.xr.isPresenting = true
    for (let i = 0; i < 100; i++) fov.update(340, false, 1 / 60, 10)
    expect(camera.fov).toBe(RENDERER_FOV)
  })
})

describe('the one-shot kick (DEV-636, `feel.fovKick`)', () => {
  it('widens the lens by about `deg`, then returns to the base EXACTLY', () => {
    const { camera, fov } = rig(anniversary)
    fov.kick(2, 0.15)
    let peak = camera.fov
    for (let i = 0; i < 12; i++) {
      fov.update(0, true, 1 / 60)
      peak = Math.max(peak, camera.fov)
    }
    expect(peak).toBeGreaterThan(RENDERER_FOV + 0.5)
    expect(peak).toBeLessThanOrEqual(RENDERER_FOV + 2 + 1e-9)
    for (let i = 0; i < 240; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('is refused while presenting, and discarded by a session start', () => {
    const a = rig(anniversary)
    a.renderer.xr.isPresenting = true
    a.fov.kick(3, 0.3)
    a.renderer.xr.isPresenting = false
    for (let i = 0; i < 30; i++) a.fov.update(0, true, 1 / 60)
    expect(a.camera.fov).toBe(RENDERER_FOV)
    const b = rig(anniversary)
    b.fov.kick(3, 5)
    b.renderer.fire('sessionstart')
    for (let i = 0; i < 30; i++) b.fov.update(0, true, 1 / 60)
    expect(b.camera.fov).toBe(RENDERER_FOV)
  })

  it('does not move a photography viewpoint (active false, no override)', () => {
    const { camera, fov } = rig(anniversary)
    fov.kick(3, 0.3)
    for (let i = 0; i < 30; i++) fov.update(0, false, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('a weaker kick does not cut a stronger one short; a stronger one replaces', () => {
    const { camera, fov } = rig(anniversary)
    fov.kick(4, 1)
    fov.kick(1, 0.1)
    for (let i = 0; i < 10; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBeGreaterThan(RENDERER_FOV + 1.5)
    const b = rig(anniversary)
    b.fov.kick(1, 1)
    b.fov.kick(4, 1)
    for (let i = 0; i < 10; i++) b.fov.update(0, true, 1 / 60)
    expect(b.camera.fov).toBeGreaterThan(RENDERER_FOV + 1.5)
  })

  it('ignores a non-positive degree or duration', () => {
    const { camera, fov } = rig(anniversary)
    fov.kick(0, 1)
    fov.kick(-2, 1)
    fov.kick(2, 0)
    fov.kick(Number.NaN, 1)
    for (let i = 0; i < 30; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('is exact on Classic too once spent: the base, with no rebuild left over', () => {
    const { camera, fov } = rig(classic)
    fov.kick(2, 0.1)
    for (let i = 0; i < 120; i++) fov.update(0, true, 1 / 60)
    const rebuilds = camera.rebuilds
    for (let i = 0; i < 120; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
    expect(camera.rebuilds).toBe(rebuilds)
  })
})

describe('the sustained push (DEV-640, a boost you can feel)', () => {
  it('opens the lens by `deg` while held, and returns to the base EXACTLY when released', () => {
    const { camera, fov } = rig(anniversary)
    fov.push(3)
    for (let i = 0; i < 600; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBeCloseTo(RENDERER_FOV + 3, 6)
    fov.push(0)
    for (let i = 0; i < 600; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('is eased, not a jump: the first frame is a fraction of it', () => {
    const { camera, fov } = rig(anniversary)
    fov.push(3)
    fov.update(0, true, 1 / 60)
    expect(camera.fov).toBeGreaterThan(RENDERER_FOV)
    expect(camera.fov).toBeLessThan(RENDERER_FOV + 3)
  })

  it('is refused while presenting and held at nothing off a live frame', () => {
    const a = rig(anniversary)
    a.renderer.xr.isPresenting = true
    a.fov.push(3)
    a.renderer.xr.isPresenting = false
    for (let i = 0; i < 200; i++) a.fov.update(0, true, 1 / 60)
    expect(a.camera.fov).toBe(RENDERER_FOV)
    const b = rig(anniversary)
    b.fov.push(3)
    for (let i = 0; i < 200; i++) b.fov.update(0, false, 1 / 60)
    expect(b.camera.fov).toBe(RENDERER_FOV)
  })

  it('a non-positive or non-finite push is no push', () => {
    const { camera, fov } = rig(anniversary)
    for (const d of [0, -3, Number.NaN]) fov.push(d)
    for (let i = 0; i < 100; i++) fov.update(0, true, 1 / 60)
    expect(camera.fov).toBe(RENDERER_FOV)
  })

  it('rides on top of the speed term, added and never replacing', () => {
    const { camera, fov } = rig(anniversary)
    for (let i = 0; i < 600; i++) fov.update(340, true, 1 / 60)
    const cruising = camera.fov
    fov.push(3)
    for (let i = 0; i < 600; i++) fov.update(340, true, 1 / 60)
    expect(camera.fov).toBeCloseTo(cruising + 3, 6)
  })
})
