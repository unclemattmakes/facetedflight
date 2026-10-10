// tests/unit/xr-input.test.ts — the controls that only exist inside a session.
//
// ── The bug this file is the answer to ────────────────────────────────────
//
// The frame loop read `navigator.getGamepads()` and nothing else. XR controllers
// are never in there — not before a session, not during one — so the headset
// build had a cockpit, a course, ghosts, the right lighting, and no controls.
// On a PC with a pad plugged in, everything worked.
//
// That is the shape of bug this project keeps finding: correct on the machine
// you develop on, broken on the machine you ship to. So the interesting test is
// not "does the stick move the ship" but "does VR agree with flat", and most of
// what follows is that comparison.
//
// ── The layout: 2016's scheme "a", on two hands ───────────────────────────
//
//   left stick X  -> yaw        left stick Y  -> pitch
//   right stick X -> roll       right trigger -> throttle
//   left trigger  -> boost      left grip ("L1") -> airbrake
//   right grip    -> boost      right B -> brake
//   left stick DOWN + click -> recentre
//
// The LEFT stick flies the nose and the right stick's horizontal rolls, which
// is `Input_Ship.cs:488-492` — the scheme the shipped prefab names. See
// `control-scheme.test.ts`, which holds this mapping against that constant, and
// `input/gamepad.ts` for what was here before and why it was not scheme "a".
//
// No DOM and no WebXR runtime needed: `readXrInput` takes an `XRSession` and
// reads `inputSources`, which is a plain array of plain objects.

import { describe, expect, it } from 'vitest'
import { mergeActions, noActions } from '@/input/actions'
import { DEAD_ZONE_LOWER, readGamepad } from '@/input/gamepad'
import { readXrInput } from '@/input/xr'

/** `xr-standard`: axes 0,1 touchpad; 2,3 thumbstick. Buttons 0 trigger, 1 squeeze, 3 stick click. */
const controller = (
  handedness: XRHandedness,
  { axes = [0, 0, 0, 0], buttons = {} }: { axes?: number[]; buttons?: Record<number, number> } = {},
): XRInputSource =>
  ({
    handedness,
    targetRayMode: 'tracked-pointer',
    gamepad: {
      mapping: 'xr-standard',
      axes,
      buttons: Array.from({ length: 6 }, (_, i) => ({
        value: buttons[i] ?? 0,
        pressed: (buttons[i] ?? 0) > 0.5,
        touched: false,
      })),
    },
  }) as unknown as XRInputSource

const session = (...sources: XRInputSource[]): XRSession =>
  ({ inputSources: sources }) as unknown as XRSession

const OPTS = { invertPitch: false }

describe('an XR session with nothing usable in it', () => {
  it('returns neutral actions rather than throwing, before or without a session', () => {
    // `renderer.xr.getSession()` is null out of session, and this is called every
    // frame in flat play. It must be free and quiet.
    // Exhaustive on purpose — `toEqual` against a literal means a new field
    // added to `XrInputResult` fails here until someone decides what its
    // no-session value is. DEV-207 added two and that is how they were caught.
    expect(readXrInput(null, OPTS)).toEqual({
      actions: noActions(),
      hasSticks: false,
      recenter: false,
      pause: false,
      menuStep: 0,
      back: false,
      confirm: false,
      autopilot: false,
      raceLap: false,
      // DEV-373: nothing to share without a session, as nothing to race.
      shareLap: false,
    })
  })

  it('survives the first frames of a session, when inputSources is still empty', () => {
    // Quest reports controllers a frame or two after the session starts. Those
    // frames are real — the first headset session warned about missing sticks
    // four seconds in, with perfectly good controllers, for exactly this reason.
    const result = readXrInput(session(), OPTS)
    expect(result.actions).toEqual(noActions())
    expect(result.hasSticks).toBe(false)
  })

  it('reports hasSticks: false for a headset with no controllers at all', () => {
    // Apple Vision Pro supports `immersive-vr` and has NO controllers — its
    // input sources are transient pointers with no `gamepad`. That is a device
    // state, not an error, and the caller has to be able to say so.
    const gaze = { handedness: 'none', targetRayMode: 'transient-pointer' } as XRInputSource
    expect(readXrInput(session(gaze), OPTS).hasSticks).toBe(false)
  })
})

describe('the sticks', () => {
  it('puts pitch and yaw on the LEFT stick and roll on the right', () => {
    const result = readXrInput(
      session(
        controller('left', { axes: [0, 0, 0.6, -0.7] }),
        controller('right', { axes: [0, 0, 0.8, 0] }),
      ),
      OPTS,
    )
    // Right stick pushed RIGHT: negated, because +roll banks LEFT
    // (`sim/autopilot.ts:44`, measured off the integrator rather than reasoned).
    expect(result.actions.roll).toBeLessThan(0)
    // Left stick pushed FORWARD is -Y, and pitch is negated, so this reads + —
    // and +pitch is nose DOWN, which is "push forward to dive".
    expect(result.actions.pitch).toBeGreaterThan(0)
    // Left stick pushed RIGHT, and +yaw is nose right, so it is NOT negated.
    expect(result.actions.yaw).toBeGreaterThan(0)
    expect(result.hasSticks).toBe(true)
  })

  it('leaves the right stick’s Y axis alone', () => {
    // Scheme "a" has three axes and a pad has four. Giving the spare one a job
    // in VR and not on the pad would break the parity below, and a second pitch
    // axis under the other thumb is two hands on the same job.
    const result = readXrInput(session(controller('right', { axes: [0, 0, 0, 0.9] })), OPTS)
    // Per axis, not `toEqual`: roll is negated, so an untouched right stick
    // yields NEGATIVE zero and `Object.is(-0, 0)` is false. -0 flies exactly
    // like 0; it is only worth not tripping over.
    expect(result.actions.pitch).toBeCloseTo(0, 10)
    expect(result.actions.yaw).toBeCloseTo(0, 10)
    expect(result.actions.roll).toBeCloseTo(0, 10)
    expect(result.actions.throttle).toBe(0)
  })

  it('agrees with the gamepad axis for axis, which is the whole point', () => {
    // The claim: a stick pushed the same way produces the same flight, in VR and
    // flat. `FlightActions` exists so the sim never learns which device it was,
    // and that promise is only kept if the two readers agree.
    //
    // Pad axes are [leftX, leftY, rightX, rightY]; the xr thumbstick is axes 2,3
    // on each hand. So the SAME physical gesture is written differently for each
    // reader, which is what makes this a real comparison rather than a tautology.
    const cases = [
      {
        name: 'left stick forward-left (dive, yaw left)',
        pad: [-0.7, -0.7, 0, 0],
        xrL: [0, 0, -0.7, -0.7],
        xrR: [0, 0, 0, 0],
      },
      {
        name: 'right stick right (the aileron)',
        pad: [0, 0, 0.9, 0],
        xrL: [0, 0, 0, 0],
        xrR: [0, 0, 0.9, 0],
      },
      {
        name: 'both sticks',
        pad: [0.5, 0.5, -0.45, 0],
        xrL: [0, 0, 0.5, 0.5],
        xrR: [0, 0, -0.45, 0],
      },
    ]
    for (const { name, pad, xrL, xrR } of cases) {
      const flat = withPad({ axes: pad, buttons: [] }, () => readGamepad(OPTS))
      const vr = readXrInput(
        session(controller('left', { axes: xrL }), controller('right', { axes: xrR })),
        OPTS,
      ).actions
      expect(vr.pitch, `${name}: pitch`).toBeCloseTo(flat.pitch, 6)
      expect(vr.roll, `${name}: roll`).toBeCloseTo(flat.roll, 6)
      expect(vr.yaw, `${name}: yaw`).toBeCloseTo(flat.yaw, 6)
    }
  })

  it('honours the global pitch invert, and defaults to the flyable direction', () => {
    // `invertPitch` is one switch for the whole game (D16). A device that applied
    // its own would put VR and flat on opposite conventions.
    const axes = [0, 0, 0, 0.8]
    const normal = readXrInput(session(controller('left', { axes })), OPTS).actions.pitch
    const inverted = readXrInput(session(controller('left', { axes })), { invertPitch: true })
      .actions.pitch
    expect(inverted).toBeCloseTo(-normal, 6)
    // The DEFAULT is `invertPitch: false` — the shipped HoverJet prefab's — and
    // it has to mean "push forward to dive". A stick PULLED BACK (+Y) therefore
    // reads negative, because +pitch is nose down.
    expect(normal).toBeLessThan(0)
  })

  it('uses 2016’s dead zones, because a Touch stick is an analogue stick', () => {
    const inside = readXrInput(
      session(controller('right', { axes: [0, 0, DEAD_ZONE_LOWER - 0.01, 0] })),
      OPTS,
    )
    // `toBeCloseTo`, not `toBe(0)`: roll is negated, so a dead stick produces
    // NEGATIVE zero and `Object.is(-0, 0)` is false. Not worth chasing out of
    // the mapping — -0 flies exactly like 0 — but worth not tripping over.
    expect(inside.actions.roll).toBeCloseTo(0, 10)
    const outside = readXrInput(
      session(controller('right', { axes: [0, 0, DEAD_ZONE_LOWER + 0.2, 0] })),
      OPTS,
    )
    expect(Math.abs(outside.actions.roll)).toBeGreaterThan(0)
  })
})

describe('the buttons', () => {
  it('keeps the throttle ANALOGUE', () => {
    // The right trigger, like the pad's. A flight throttle that is on or off is
    // a different game.
    const half = readXrInput(session(controller('right', { buttons: { 0: 0.4 } })), OPTS)
    expect(half.actions.throttle).toBeCloseTo(0.4, 6)
    expect(half.actions.boost).toBe(false)
  })

  it('starts the mission on the right hand A, like 2016 did', () => {
    // `Input_Ship` begins the elevator on `device.Action1.IsPressed`
    // (Input_Ship.cs:381), and InControl's Action1 is the bottom face button —
    // A on a pad, A on a Touch controller's right hand. `xr-standard` puts it at
    // button 4.
    const pressed = readXrInput(session(controller('right', { buttons: { 4: 1 } })), OPTS)
    expect(pressed.confirm).toBe(true)
    // It is NOT a flight action: the sim consumes those and "begin the mission"
    // has no business reaching the flight model. Compared per axis rather than
    // with `toEqual` because roll and pitch are negated, so a centred stick
    // yields -0 and `Object.is(-0, 0)` is false.
    expect(pressed.actions.pitch).toBeCloseTo(0, 10)
    expect(pressed.actions.roll).toBeCloseTo(0, 10)
    expect(pressed.actions.yaw).toBeCloseTo(0, 10)
    expect(pressed.actions.throttle).toBe(0)
    expect(pressed.actions.boost).toBe(false)
    expect(pressed.actions.brake).toBe(false)
    expect(pressed.actions.airbrake).toBe(false)

    // And nothing else on either hand sets it — most importantly not the
    // triggers or grips, which are held constantly in flight.
    const busy = readXrInput(
      session(
        controller('left', { axes: [0, 0, 0, 0.9], buttons: { 0: 1, 1: 1, 3: 1, 5: 1 } }),
        controller('right', { axes: [0, 0, 0.9, 0.9], buttons: { 0: 1, 1: 1, 3: 1, 5: 1 } }),
      ),
      OPTS,
    )
    expect(busy.confirm).toBe(false)
  })

  it('boosts on the LEFT trigger, as 2016 did', () => {
    // `Input_Ship.cs:426` boosts on the left trigger held with the right. This
    // port had it on a shoulder button for four sessions and never said so
    // anywhere a player could read, which is how "i don't know how to boost"
    // happens. The left grip keeps the airbrake; the brake moved to B.
    const left = readXrInput(session(controller('left', { buttons: { 0: 1, 1: 1 } })), OPTS)
    expect(left.actions.boost, 'left trigger').toBe(true)
    expect(left.actions.airbrake, 'left grip').toBe(true)
    expect(left.actions.brake).toBe(false)

    // A trigger barely touched is not a boost: 2016's own 0.1 threshold
    // (`Input_Ship.cs:435`), and the pad's left trigger uses the same one.
    const grazed = readXrInput(session(controller('left', { buttons: { 0: 0.05 } })), OPTS)
    expect(grazed.actions.boost).toBe(false)

    const right = readXrInput(session(controller('right', { buttons: { 1: 1, 5: 1 } })), OPTS)
    expect(right.actions.boost, 'right grip, the alternate').toBe(true)
    expect(right.actions.brake, 'B — 2016’s Action2').toBe(true)
    expect(right.actions.airbrake).toBe(false)
  })

  it('agrees with the gamepad on the buttons too, not just the axes', () => {
    // The parity claim has to cover buttons or it is half a claim: the pad's
    // left trigger is button 6 and its L1 is button 4, and those must produce
    // the same actions as the Touch controller's trigger and grip.
    const flat = withPad({ axes: [0, 0, 0, 0], buttons: [0, 1, 0, 0, 1, 0, 1, 0.6] }, () =>
      readGamepad(OPTS),
    )
    const vr = readXrInput(
      session(
        controller('left', { buttons: { 0: 1, 1: 1 } }),
        controller('right', { buttons: { 0: 0.6, 5: 1 } }),
      ),
      OPTS,
    ).actions
    expect(vr.brake, 'brake').toBe(flat.brake)
    expect(vr.airbrake, 'airbrake').toBe(flat.airbrake)
    expect(vr.throttle, 'throttle').toBeCloseTo(flat.throttle, 6)
    expect(vr.boost, 'boost').toBe(flat.boost)
  })
})

describe('recentre — "left hand dpad down dir"', () => {
  it('needs the stick pushed DOWN *and* clicked', () => {
    // On Touch there is no dpad, so it is the left stick pushed down and
    // clicked — and the CLICK is load-bearing. Pushing that stick down is PITCH
    // and happens constantly, so direction alone would recentre the world every
    // time you dived.
    const divingHard = readXrInput(session(controller('left', { axes: [0, 0, 0, 1] })), OPTS)
    expect(divingHard.recenter, 'stick fully down, not clicked').toBe(false)

    const clickedLevel = readXrInput(
      session(controller('left', { axes: [0, 0, 0, 0], buttons: { 3: 1 } })),
      OPTS,
    )
    expect(clickedLevel.recenter, 'clicked, stick centred').toBe(false)

    const both = readXrInput(
      session(controller('left', { axes: [0, 0, 0, 0.9], buttons: { 3: 1 } })),
      OPTS,
    )
    expect(both.recenter, 'down AND clicked').toBe(true)

    // UP and clicked is not it either — the direction has a sign.
    const up = readXrInput(
      session(controller('left', { axes: [0, 0, 0, -0.9], buttons: { 3: 1 } })),
      OPTS,
    )
    expect(up.recenter).toBe(false)
  })

  it('reads as the lower half of the pad on a touchpad device', () => {
    // The literal reading of Matt's words, for a controller that actually has a
    // dpad-shaped input: `xr-standard` puts the touchpad on axes 0,1 and its
    // click on button 2.
    const pressed = readXrInput(
      session(controller('left', { axes: [0, 0.9], buttons: { 2: 1 } })),
      OPTS,
    )
    expect(pressed.recenter).toBe(true)
    const touchedOnly = readXrInput(session(controller('left', { axes: [0, 0.9] })), OPTS)
    expect(touchedOnly.recenter).toBe(false)
  })

  it('stays out of FlightActions entirely', () => {
    // The sim consumes FlightActions and nothing else. A view command in there
    // would reach the flight model.
    const asked = readXrInput(
      session(controller('left', { axes: [0, 0, 0, 0.9], buttons: { 3: 1 } })),
      OPTS,
    )
    expect(asked.recenter).toBe(true)
    // Pitch is the one thing that legitimately moves: the left stick IS pushed
    // down, and the left stick's vertical is the elevator.
    expect({ ...asked.actions, pitch: 0 }).toEqual(noActions())
  })
})

describe('devices that are not a Touch controller', () => {
  it('flies on one hand if that is all the runtime reports', () => {
    // A dropped or unbound controller should not take the whole ship with it.
    const left = readXrInput(session(controller('left', { axes: [0, 0, 0.8, 0.8] })), OPTS)
    expect(left.actions.yaw).toBeGreaterThan(0)
    expect(Math.abs(left.actions.pitch)).toBeGreaterThan(0)
    expect(left.actions.roll).toBe(0)
    expect(left.hasSticks).toBe(true)

    const right = readXrInput(session(controller('right', { axes: [0, 0, 0.8, 0] })), OPTS)
    expect(Math.abs(right.actions.roll)).toBeGreaterThan(0)
    expect(right.actions.yaw).toBe(0)
  })

  it('falls back to the touchpad axes only when there is no thumbstick', () => {
    // `xr-standard` reserves 0,1 for a touchpad and 2,3 for the stick. A device
    // with only a touchpad stops at two axes — reading 2,3 there gets
    // `undefined`, which `shapeAxis` would quietly turn into a dead stick.
    const pad = readXrInput(
      session(controller('left', { axes: [0.8, -0.8] }), controller('right', { axes: [0.8, 0] })),
      OPTS,
    )
    expect(Math.abs(pad.actions.roll)).toBeGreaterThan(0)
    expect(Math.abs(pad.actions.pitch)).toBeGreaterThan(0)
    expect(Math.abs(pad.actions.yaw)).toBeGreaterThan(0)

    // And a four-axis device must NOT read the touchpad: a thumb resting on the
    // pad would fight the stick.
    const both = readXrInput(
      session(
        controller('left', { axes: [0.9, 0.9, 0, 0] }),
        controller('right', { axes: [0.9, 0.9, 0, 0] }),
      ),
      OPTS,
    )
    expect(both.actions.roll).toBeCloseTo(0, 10)
    expect(both.actions.pitch).toBeCloseTo(0, 10)
    expect(both.actions.yaw).toBeCloseTo(0, 10)
  })
})

describe('merging with the other devices', () => {
  it('lets a paired pad and the Touch sticks coexist', () => {
    // Not hypothetical: a Quest can have a Bluetooth pad connected, and a PC
    // headset almost always does. Neither should have to be declared the real
    // one.
    const xr = readXrInput(session(controller('left', { axes: [0, 0, 0.9, 0] })), OPTS).actions
    const flat = { ...noActions(), roll: 0.5, throttle: 1 }
    const merged = mergeActions(flat, xr)
    expect(merged.roll).toBeCloseTo(0.5, 6)
    expect(merged.yaw).toBeCloseTo(xr.yaw, 6)
    expect(merged.throttle).toBe(1)
  })

  it('is a no-op on the flat build, so nothing regresses out of session', () => {
    const flat = { ...noActions(), pitch: -0.4, throttle: 0.7, boost: true }
    expect(mergeActions(flat, readXrInput(null, OPTS).actions)).toEqual(flat)
  })
})

/**
 * Run `fn` with a fake `navigator.getGamepads`, so the pad reader can be compared against.
 *
 * `defineProperty`, not assignment: Node exposes `globalThis.navigator` as a getter-only
 * accessor, so `navigator = ...` throws in a module under strict mode. The original descriptor is
 * put back afterwards rather than deleted, or the next test in the file gets a global that Node
 * did not give it.
 */
function withPad<T>(pad: { axes: number[]; buttons: number[] }, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [
        {
          connected: true,
          mapping: 'standard',
          axes: pad.axes,
          buttons: Array.from({ length: 8 }, (_, i) => ({
            value: pad.buttons[i] ?? 0,
            pressed: (pad.buttons[i] ?? 0) > 0.5,
          })),
        },
      ],
    },
    configurable: true,
    writable: true,
  })
  try {
    return fn()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
}

// ── DEV-207: the left face buttons are a D-PAD on a Steam Frame ───────────
//
// SteamVR has no Frame profile to advertise — the registry's `valve` folder
// holds exactly one file, `valve-index.json` — so it describes the whole device
// as `oculus-touch`. That profile has seven indices and no 4-way, so the
// Frame's left-hand D-pad folds into the two face-button slots.
//
// Measured on the hardware, 2026-09-17: eight presses (up, up, down, down,
// left, left, right, right) produced exactly TWO distinct indices, 4 and 5, and
// nothing at all on axes 0/1. **Which two directions survive is a SteamVR
// mapping decision for a device the registry does not describe**, and is not
// knowable from inside the page.
//
// Every assertion below is written so that not knowing is fine.
describe('pause is reachable from either left face button', () => {
  const left = (button: number): ReturnType<typeof readXrInput> =>
    readXrInput(
      session(controller('left', { buttons: { [button]: 1 } }), controller('right')),
      OPTS,
    )

  it('opens on index 4 AND on index 5 — the property that survives not knowing', () => {
    // THE assertion. Matt asked for "pause on dpad left or right"; binding one
    // index would be a coin flip on which directions SteamVR kept, and the
    // losing side of that coin is another headset session to discover.
    expect(left(4).pause, 'index 4 must open the plate').toBe(true)
    expect(left(5).pause, 'index 5 must open the plate').toBe(true)
  })

  it('and not from anything else on that hand', () => {
    // The flight controls must not open a menu. Trigger is boost, squeeze is
    // the airbrake, the stick click is half of recentre.
    for (const idx of [0, 1, 2, 3]) {
      expect(left(idx).pause, `index ${idx} is a flight control, not pause`).toBe(false)
    }
  })

  it('steps the menu with the same two buttons, in opposite directions', () => {
    // The other half of Matt's ask — "disable that when the pause menu is up".
    // The buttons do not go away while the plate is open, they change JOB, and
    // the two jobs have to come from the same source or they can disagree about
    // which buttons exist.
    expect(left(4).menuStep).toBe(-1)
    expect(left(5).menuStep).toBe(1)
    expect(left(0).menuStep).toBe(0)
  })

  it('menuStep moves exactly when pause would have — asserted as a relationship', () => {
    // Not two lists to keep in sync. Whatever opens the plate is what steps it,
    // which is what makes "the D-pad works the menu" true by construction
    // rather than by two people remembering the same pair of numbers.
    for (const idx of [0, 1, 2, 3, 4, 5]) {
      const r = left(idx)
      expect(r.menuStep !== 0, `index ${idx}`).toBe(r.pause)
    }
  })
})

describe('B backs out, A accepts — the Xbox convention Matt asked for', () => {
  const right = (button: number): ReturnType<typeof readXrInput> =>
    readXrInput(
      session(controller('left'), controller('right', { buttons: { [button]: 1 } })),
      OPTS,
    )

  it('back is the right hand`s index 5, which is B on a pad and on a Touch', () => {
    expect(right(5).back).toBe(true)
    expect(right(4).back).toBe(false)
  })

  it('confirm stays on A, which Matt confirmed already worked in the headset', () => {
    expect(right(4).confirm).toBe(true)
    expect(right(5).confirm).toBe(false)
  })

  it('back and brake are the SAME button, and that is the design', () => {
    // They can never be read in one frame: `app.ts` reads `back` only while
    // paused, and a paused run is handed `noActions()`. Asserted rather than
    // left implicit, because someone reading `out.brake = pressed(right, 5)`
    // and `back: pressed(right, 5)` should find the reason here rather than
    // conclude one of them is a bug.
    const r = right(5)
    expect(r.back).toBe(true)
    expect(r.actions.brake).toBe(true)
  })
})

describe('the autopilot is off the D-pad', () => {
  const chord = (buttons: {
    left?: Record<number, number>
    right?: Record<number, number>
  }): ReturnType<typeof readXrInput> =>
    readXrInput(
      session(
        controller('left', { buttons: buttons.left ?? {} }),
        controller('right', { buttons: buttons.right ?? {} }),
      ),
      OPTS,
    )

  it('does NOT engage on the left index 4 it used to live on', () => {
    // The regression this exists to prevent, and it is not hypothetical: index
    // 4 is now a D-pad direction that opens the pause plate, and `app.ts` holds
    // autopilot for two seconds. Leaving it here would have meant that holding
    // a direction to step a list engaged the autopilot mid-menu.
    expect(chord({ left: { 4: 1 } }).autopilot).toBe(false)
    expect(chord({ left: { 5: 1 } }).autopilot).toBe(false)
  })

  it('needs BOTH grips — neither one alone', () => {
    // A chord is only a chord if half of it does nothing. Each grip alone is a
    // flight control that gets used constantly: left is the airbrake, right is
    // the alternate boost.
    expect(chord({ left: { 1: 1 } }).autopilot).toBe(false)
    expect(chord({ right: { 1: 1 } }).autopilot).toBe(false)
    expect(chord({ left: { 1: 1 }, right: { 1: 1 } }).autopilot).toBe(true)
  })

  it('still lets both grips do their flight jobs while held', () => {
    // The chord must not STEAL the inputs. Holding both is a contradictory
    // flight command, which is exactly why it is safe to overload — but the
    // airbrake and the boost still have to be what they were.
    const r = chord({ left: { 1: 1 }, right: { 1: 1 } })
    expect(r.actions.airbrake).toBe(true)
    expect(r.actions.boost).toBe(true)
  })
})
