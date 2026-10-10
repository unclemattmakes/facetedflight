// tests/unit/spider-charge-input.test.ts — "both triggers", on every device,
// charges the jumping spider. DEV-383.
//
// AIRCRAFT-VARIANTS §4.1: the charge is the JumpSeat's BOOST gesture — throttle
// and boost together — so nothing is rebound: XR right trigger + left trigger
// (or the right grip), pad RT + LT (or R1), keyboard Space/Shift + Z/Ctrl,
// touch the throttle stick + BOOST. This file puts each device's gesture
// through its OWN reader, then through the seam's own mapping
// (`jumpSeatInputOf`), into a spider standing on the ground, and asks the one
// question that matters: does it charge, and does letting go of the boost side
// fire it?
//
// Compared against the MECHANIC, not against another device (CLAUDE.md: "a test
// that compares two of your own devices has not tested either of them").
//
// Proved red: `jumpSeatInputOf` dropping the boost (`out.boost = 0`) — every
// device's gesture then charges nothing.

import { describe, expect, it } from 'vitest'
import { createJumpChargeAudio, stepJumpChargeAudio } from '@/audio/jump-charge'
import { resolveVariant } from '@/content/load-aircraft'
import { jumpSeatFor, jumpSeatInputOf } from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'
import type { FlightActions } from '@/input/actions'
import { BUTTON, readGamepad } from '@/input/gamepad'
import { attachKeyboard, BINDINGS } from '@/input/keyboard'
import { CENTRED, NO_TOUCH_BUTTONS, stickVector, touchActions } from '@/input/touch'
import { readXrInput } from '@/input/xr'
import { FIXED_DT } from '@/sim/constants'
import { type JumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { SPIDER_READY } from './helpers/spider-ready'

const OPTS = { invertPitch: false }
const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }

// ── the four devices, each through its own reader ─────────────────────────

const keyboardHolding = (codes: readonly string[]): FlightActions => {
  const listeners = new Map<string, Set<(e: unknown) => void>>()
  const target = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn)
    },
  }
  const keyboard = attachKeyboard(target as unknown as EventTarget)
  try {
    for (const code of codes) {
      for (const fn of listeners.get('keydown') ?? []) fn({ code, preventDefault() {} })
    }
    return keyboard.read(1, OPTS)
  } finally {
    keyboard.dispose()
  }
}

const padHolding = (buttons: Record<number, number>): FlightActions => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [
        {
          connected: true,
          mapping: 'standard',
          axes: [0, 0, 0, 0],
          buttons: Array.from({ length: 17 }, (_, i) => ({
            value: buttons[i] ?? 0,
            pressed: (buttons[i] ?? 0) > 0.5,
          })),
        },
      ],
    },
    configurable: true,
    writable: true,
  })
  try {
    return readGamepad(OPTS)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
}

const xrHolding = (right: Record<number, number>, left: Record<number, number>): FlightActions => {
  const controller = (handedness: XRHandedness, buttons: Record<number, number>) =>
    ({
      handedness,
      targetRayMode: 'tracked-pointer',
      gamepad: {
        mapping: 'xr-standard',
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 6 }, (_, i) => ({
          value: buttons[i] ?? 0,
          pressed: (buttons[i] ?? 0) > 0.5,
          touched: false,
        })),
      },
    }) as unknown as XRInputSource
  const session = {
    inputSources: [controller('right', right), controller('left', left)],
  } as unknown as XRSession
  return readXrInput(session, OPTS).actions
}

/** The right thumb pushed fully forward (the throttle), and the BOOST chip. */
const touchHolding = (boost: boolean): FlightActions =>
  touchActions(CENTRED, stickVector(0, -200), { ...NO_TOUCH_BUTTONS, boost }, OPTS)

/** XR `xr-standard`: button 0 is the trigger, 1 the grip. */
const TRIGGER = 0
const GRIP = 1

const GESTURES: readonly {
  readonly device: string
  readonly both: () => FlightActions
  readonly throttleOnly: () => FlightActions
}[] = [
  {
    device: 'XR: right trigger + left trigger',
    both: () => xrHolding({ [TRIGGER]: 1 }, { [TRIGGER]: 1 }),
    throttleOnly: () => xrHolding({ [TRIGGER]: 1 }, {}),
  },
  {
    device: 'XR: right trigger + right grip',
    both: () => xrHolding({ [TRIGGER]: 1, [GRIP]: 1 }, {}),
    throttleOnly: () => xrHolding({ [TRIGGER]: 1 }, {}),
  },
  {
    device: 'pad: RT + LT',
    both: () => padHolding({ [BUTTON.r2]: 1, [BUTTON.l2]: 1 }),
    throttleOnly: () => padHolding({ [BUTTON.r2]: 1 }),
  },
  {
    device: 'pad: RT + R1',
    both: () => padHolding({ [BUTTON.r2]: 1, [BUTTON.r1]: 1 }),
    throttleOnly: () => padHolding({ [BUTTON.r2]: 1 }),
  },
  {
    device: 'keyboard: Space + Z',
    both: () => keyboardHolding(['Space', 'KeyZ']),
    throttleOnly: () => keyboardHolding(['Space']),
  },
  {
    device: 'keyboard: Shift + Ctrl',
    both: () => keyboardHolding(['ShiftLeft', 'ControlLeft']),
    throttleOnly: () => keyboardHolding(['ShiftLeft']),
  },
  {
    device: 'touch: throttle stick + BOOST',
    both: () => touchHolding(true),
    throttleOnly: () => touchHolding(false),
  },
]

// ── a spider on the ground ────────────────────────────────────────────────

const FLAT: HeightField = buildHeightField(
  {
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = 0.5
      out.g = 0.5
      out.b = 0.5
      return out
    },
  } as unknown as MapSampler,
  {
    terrainSize: 1024,
    terrainHeight: 100,
    baseResolution: 8,
    chunkSize: 256,
    randomOffset: 0,
    seed: 1,
  } as unknown as FacetedTerrainParams,
  { position: [0, 0, 0], scale: [1, 1, 1] },
)
const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

const standingSpider = (): { seat: JumpSeat; step: (actions: FlightActions) => void } => {
  const seat = jumpSeatFor(resolveVariant('jumpseat', 'spider', ANNIVERSARY))
  seat.live = true
  seat.body.position.x = 500
  seat.body.position.y = 53
  seat.body.position.z = 500
  const collision = createTerrainCollision()
  const input = noJumpSeatInput()
  const step = (actions: FlightActions): void => {
    stepJumpSeat(seat, jumpSeatInputOf(actions, input), [FLAT], FIXED_DT)
    stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
  }
  const idle: FlightActions = { ...touchHolding(false), throttle: 0 }
  for (let i = 0; i < 600; i++) step(idle)
  return { seat, step }
}

// NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
// and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
describe.skipIf(!SPIDER_READY)(
  'both triggers charge the spider on every device, and letting go of the boost side fires it',
  () => {
    it('the bindings are the JumpSeat boost gesture, unchanged (§1.5: nothing is rebound)', () => {
      expect(BINDINGS.throttle).toContain('Space')
      expect(BINDINGS.boost).toContain('KeyZ')
    })

    for (const g of GESTURES) {
      it(g.device, () => {
        const both = g.both()
        expect(both.throttle, 'the gesture opens the throttle').toBeGreaterThan(0)
        expect(both.boost, 'and holds the boost').toBe(true)
        const { seat, step } = standingSpider()
        for (let i = 0; i < Math.round(0.5 / FIXED_DT); i++) step(both)
        expect(seat.jump?.charge ?? 0).toBeGreaterThan(0.4)
        // Let go of the boost side, keep the throttle: it fires, and the jet stays lit.
        const release = g.throttleOnly()
        expect(release.boost).toBe(false)
        expect(release.throttle).toBeGreaterThan(0)
        step(release)
        expect(seat.jump?.jumps).toBe(1)
        for (let i = 0; i < 30; i++) step(release)
        expect(seat.body.velocity.y).toBeGreaterThan(10)
        expect(seat.appliedThrust).toBeGreaterThan(0)
      })
    }
  },
)

describe.skipIf(!SPIDER_READY)(
  'the charge tone follows a real spider’s charge (DEV-383, AIRCRAFT-VARIANTS §4.5)',
  () => {
    it('sounds on exactly the ticks the seat is charging, and stops on the tick it jumps', () => {
      const { seat, step } = standingSpider()
      const tone = createJumpChargeAudio()
      const both = keyboardHolding(['Space', 'KeyZ'])
      const release = keyboardHolding(['Space'])
      const heard: boolean[] = []
      const charging: boolean[] = []
      const run = (actions: FlightActions, n: number) => {
        for (let i = 0; i < n; i++) {
          step(actions)
          stepJumpChargeAudio(tone, seat.jump?.charge, [])
          heard.push(tone.playing)
          charging.push(seat.jump?.charging === true)
        }
      }
      run(release, 20) // the jet alone: no charge, no tone
      run(both, Math.round(0.6 / FIXED_DT))
      run(release, 20) // it fires on the first of these
      expect(seat.jump?.jumps).toBe(1)
      expect(heard).toEqual(charging)
      expect(heard.filter(Boolean).length).toBe(Math.round(0.6 / FIXED_DT))
    })
  },
)
