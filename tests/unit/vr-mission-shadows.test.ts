// tests/unit/vr-mission-shadows.test.ts: in a headset, a MISSION draws no sun
// shadow map and the menus keep theirs. DEV-932, lever 2 of
// docs/plan/ANNIVERSARY-VR-FRAMERATE.md. tests/e2e/vr-mission-shadows.spec.ts
// drives the same claims through IWER on compiled programs.
//
// Three claims, each through the seam a headset uses (`setImmersive`, which
// `boot/app.ts` calls on `sessionstart`):
//   1. the far-field term still shadows the terrain with the map gone;
//   2. the hangar's key light and the title's sun still cast;
//   3. nothing that samples the sun's map runs without it (the cockpit's own
//      map, the near cascade, the hull's shadow draw, the cockpit receiving).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, editionFeatures } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { cockpitSelfShadowEnabled } from '@/render/cockpit-self-shadow'
import { sunHeightChunk } from '@/render/far-shadow'
import { createRoomShadows } from '@/render/hangar-light'
import { nearShadowEnabled } from '@/render/near-shadow'
import {
  createSunShadows,
  missionShadowsEnabled,
  type ShadowFlags,
  type ShadowRenderer,
  shadowReceiversFor,
  shadowsEnabled,
} from '@/render/shadows'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

const inVr = (edition: Edition) => {
  const state = createEditionState(edition, DEFAULT_SETTINGS)
  state.setImmersive(true)
  return state
}

const flags = (): ShadowFlags => ({ castShadow: false, receiveShadow: false })
const renderer = (): ShadowRenderer => ({
  shadowMap: { enabled: false, type: THREE.BasicShadowMap },
})
const sun = (): THREE.DirectionalLight => {
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(1000, 200, 0)
  return light
}

describe('the preset (DEV-932)', () => {
  it('lists the mission map in Anniversary’s vr.disable and leaves render.shadows alone', () => {
    const list = ANNIVERSARY.vr?.disable ?? []
    expect(list).toContain('render.missionShadows')
    expect(list, 'the menus’ machinery must stay on in a headset').not.toContain('render.shadows')
    expect(list, 'the far-field term must stay on').not.toContain('render.sunHeight')
    // `perEntry` is prose in the file, not a typed field: read the JSON as data.
    const perEntry = (anniversaryJson as { vr: { perEntry: Record<string, string> } }).vr.perEntry
    expect(perEntry['render.missionShadows']).toMatch(/ANNIVERSARY-VR-FRAMERATE/)
  })

  it('is on flat and off in a headset, while the machinery stays on', () => {
    const flat = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS).current
    expect(missionShadowsEnabled(flat, DEFAULT_SETTINGS)).toBe(true)
    const vr = inVr(ANNIVERSARY).current
    expect(missionShadowsEnabled(vr, DEFAULT_SETTINGS)).toBe(false)
    expect(shadowsEnabled(vr, DEFAULT_SETTINGS)).toBe(true)
  })

  it('is inert on Classic, which has no map anywhere', () => {
    expect(missionShadowsEnabled(CLASSIC, DEFAULT_SETTINGS)).toBe(false)
    expect(new Map(editionFeatures(CLASSIC)).get('render.missionShadows')?.enabled).toBe(false)
  })

  it('comes back for a session with ?feature=render.missionShadows:on', () => {
    const state = inVr(ANNIVERSARY)
    state.setFeatureOverrides({ 'render.missionShadows': true })
    expect(missionShadowsEnabled(state.current, DEFAULT_SETTINGS)).toBe(true)
  })
})

describe('1. the far-field term still shadows the terrain with the mission map off', () => {
  it('keeps render.sunHeight on in a headset', () => {
    expect(inVr(ANNIVERSARY).current.render.sunHeight.enabled).toBe(true)
  })

  it('multiplies the sun by the swept term on the branch a light with no map compiles', () => {
    // three compiles `USE_SHADOWMAP` only for a casting light, and with the
    // mission map off the sun does not cast (claim 3 below). So the branch the
    // terrain's program takes in a headset is the `#if !( defined(
    // USE_SHADOWMAP ) ...)` one, and it must carry the multiply.
    const chunk = sunHeightChunk()
    const guard =
      '#if !( defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS ) )'
    const at = chunk.indexOf(guard)
    expect(at, 'the no-map branch exists').toBeGreaterThan(-1)
    const branch = chunk.slice(at, chunk.indexOf('#endif', at))
    expect(branch).toContain('directLight.color *= ff2SunHeightTerm();')
  })
})

describe('2. the menus keep their shadows in a headset', () => {
  it('the hangar’s key light still casts', () => {
    const room = new THREE.Group()
    const key = new THREE.DirectionalLight(0xffffff, 3)
    room.add(key, key.target)
    const state = inVr(ANNIVERSARY)
    const shadows = createRoomShadows(room, key, state)
    expect(key.castShadow, 'the room’s 2016 key light, DEV-440').toBe(true)
    expect(shadows.on).toBe(true)
    shadows.dispose()
  })

  it('the title’s sun still casts, and a mission’s does not, through the same system', () => {
    for (const [world, want] of [
      ['title', true],
      ['mission', false],
    ] as const) {
      const r = renderer()
      const light = sun()
      const ground = flags()
      const state = inVr(ANNIVERSARY)
      const shadows = createSunShadows(r, light, state)
      shadows.attach({ landmarks: [ground], world })
      expect(light.castShadow, `${world}: the sun casts`).toBe(want)
      expect(ground.receiveShadow, `${world}: the ground receives`).toBe(want)
      expect(r.shadowMap.enabled, `${world}: the machinery is on for the hangar`).toBe(true)
      shadows.dispose()
    }
  })
})

describe('3. nothing samples a map that is not drawn', () => {
  it('turns every pass that rides the mission map off with it', () => {
    const vr = inVr(ANNIVERSARY).current
    expect(cockpitSelfShadowEnabled(vr, DEFAULT_SETTINGS), 'the canopy bars’ own map').toBe(false)
    expect(nearShadowEnabled(vr, DEFAULT_SETTINGS), 'the near cascade').toBe(false)
    expect(shadowReceiversFor(vr, DEFAULT_SETTINGS).cockpit, 'the cockpit receiving').toBe(false)
    // And they are all on flat, so the four lines above are not vacuous.
    const flat = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS).current
    expect(cockpitSelfShadowEnabled(flat, DEFAULT_SETTINGS)).toBe(true)
    expect(nearShadowEnabled(flat, DEFAULT_SETTINGS)).toBe(true)
    expect(shadowReceiversFor(flat, DEFAULT_SETTINGS).cockpit).toBe(true)
  })

  it('a mission in a headset has no casting sun and no object flagged to cast or receive', () => {
    const r = renderer()
    const light = sun()
    const subjects = { scatter: [flags()], landmarks: [flags()], shipExterior: [flags()] }
    const state = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const shadows = createSunShadows(r, light, state)
    shadows.attach(subjects)
    expect(light.castShadow, 'flat casts, so the VR half is not vacuous').toBe(true)
    state.setImmersive(true)
    expect(light.castShadow).toBe(false)
    expect(shadows.on).toBe(false)
    expect(shadows.fit, 'no fit for a map that is not drawn').toBe(null)
    for (const f of [...subjects.scatter, ...subjects.landmarks, ...subjects.shipExterior]) {
      expect(f).toEqual({ castShadow: false, receiveShadow: false })
    }
    state.setImmersive(false)
    expect(light.castShadow, 'and the monitor gets it back').toBe(true)
    shadows.dispose()
  })
})
