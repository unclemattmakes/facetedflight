// tests/unit/edition-vr-layer.test.ts — the two layers over a preset, and the
// identity contract the renderer leans on.
//
// DEV-263. Matt, 2026-09-21, after the first worn A/B this project has taken:
// *"off in VR, on in flat."* Classic held 96.9 % of its frames at 90 Hz and
// Anniversary 75.0 % — same mission, same 1512 px eye, same minute — while flat
// the same build runs ~178 fps with 1.02 ms of GPU. So the cheaper look is
// worth having where the headset is and would only cost look on a monitor.
//
// Two layers, applied in order: the preset's own `vr.disable` while presenting,
// then a manual override map that can put anything back. `edition-content.test.ts`
// owns the claims about the FILES; this owns the composition.
//
// ── The thing most worth guarding here is an IDENTITY, not a value ────────
//
// Every system with an Anniversary behaviour re-reads on notify, and several
// rebuild materials when they do. So `current` returning a fresh-but-equal
// object is not a harmless inefficiency: it is a shader recompile in the frame
// the headset goes on. Entering VR on Classic must notify nobody.

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures, withFeatureOverrides } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

const enabled = (e: Edition, path: string): boolean | undefined =>
  new Map(editionFeatures(e)).get(path)?.enabled

/** The first path Anniversary turns off in VR, whatever the list currently is. */
const A_VR_PATH = (ANNIVERSARY.vr?.disable ?? [])[0] as string

describe('the VR layer', () => {
  it('is off in flat and on while presenting, and back again', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    expect(enabled(s.current, A_VR_PATH), 'flat keeps the full preset').toBe(true)
    s.setImmersive(true)
    expect(enabled(s.current, A_VR_PATH), 'VR turns it off').toBe(false)
    s.setImmersive(false)
    expect(enabled(s.current, A_VR_PATH), 'and the monitor gets it back').toBe(true)
  })

  it('NOTIFIES on the way in and on the way out', () => {
    // The mechanism the whole feature rides on: the systems do not poll, they
    // subscribe, so a layer that changed `current` without notifying would
    // render the flat look inside the headset until something else moved.
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setImmersive(true)
    expect(calls).toBe(1)
    s.setImmersive(false)
    expect(calls).toBe(2)
  })

  it('notifies NOBODY on a preset with no vr block — Classic', () => {
    // THE identity contract. Classic resolves to the same object in both
    // places, so entering VR on it must not rebuild a single material.
    const s = createEditionState(CLASSIC, DEFAULT_SETTINGS)
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    const before = s.current
    s.setImmersive(true)
    expect(calls, 'Classic has nothing to change').toBe(0)
    expect(s.current, 'and is the same object, by identity').toBe(before)
  })

  it('is idempotent — setting the state it already has changes nothing', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    s.setImmersive(true)
    const inVr = s.current
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setImmersive(true)
    expect(calls).toBe(0)
    expect(s.current).toBe(inVr)
  })

  it('survives an edition flip WHILE presenting', () => {
    // The pause menu's EDITION page is one press away in a headset, so this
    // path is reachable by a player rather than only by a test. The cache is
    // per-edition and has to be dropped with it.
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    s.setImmersive(true)
    expect(enabled(s.current, A_VR_PATH)).toBe(false)
    s.setLook(CLASSIC)
    expect(s.current.id, 'the flip took').toBe('classic')
    s.setLook(ANNIVERSARY)
    expect(enabled(s.current, A_VR_PATH), 'still the VR resolution, not the flat one').toBe(false)
  })
})

describe('the override layer', () => {
  it('can put a VR-disabled feature BACK ON, which is the point of it', () => {
    // A list of things to disable could not express this, and the Advanced
    // pause page needs it: you cannot look at what a feature costs in the
    // headset if the only direction the knob turns is off.
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    s.setImmersive(true)
    expect(enabled(s.current, A_VR_PATH)).toBe(false)
    s.setFeatureOverrides({ [A_VR_PATH]: true })
    expect(enabled(s.current, A_VR_PATH), 'the manual layer wins over the VR layer').toBe(true)
  })

  it('applies in flat too, and notifies', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setFeatureOverrides({ [A_VR_PATH]: false })
    expect(enabled(s.current, A_VR_PATH)).toBe(false)
    expect(calls).toBe(1)
  })

  it('does not notify when it asks for what is already true', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    let calls = 0
    s.subscribe(() => {
      calls += 1
    })
    s.setFeatureOverrides({ [A_VR_PATH]: true }) // flat already has it on
    expect(calls).toBe(0)
  })

  it('IGNORES an unknown path instead of throwing', () => {
    // The opposite rule to `validateEdition`, deliberately. These come from a
    // URL pin and from stored settings, both of which outlive the build that
    // wrote them — a feature removed in a later version must not brick a load.
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    expect(() => s.setFeatureOverrides({ 'render.thereIsNoSuchThing': true })).not.toThrow()
    expect(s.current, 'and nothing moved').toBe(ANNIVERSARY)
  })
})

describe('withFeatureOverrides', () => {
  it('returns the SAME object when every override already agrees', () => {
    expect(withFeatureOverrides(CLASSIC, {})).toBe(CLASSIC)
    const alreadyOff = (CLASSIC.vr?.disable ?? [])[0] ?? 'render.bloom'
    expect(withFeatureOverrides(CLASSIC, { [alreadyOff]: false })).toBe(CLASSIC)
  })

  it('does not mutate the input', () => {
    // A shallow copy would leave the two presets SHARING feature objects, and
    // every test that looks at one preset at a time would still pass.
    const before = enabled(ANNIVERSARY, A_VR_PATH)
    const out = withFeatureOverrides(ANNIVERSARY, { [A_VR_PATH]: false })
    expect(enabled(out, A_VR_PATH)).toBe(false)
    expect(enabled(ANNIVERSARY, A_VR_PATH), 'the original is untouched').toBe(before)
  })
})
