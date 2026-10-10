// tests/unit/title-curtain.test.ts — the emblem on black, the valley behind it.
// DEV-352.
//
// Matt: *"would it be possible to load and light the logo first? then fade in
// the bg?"* `render/title-curtain.ts` does it with a black quad that sorts
// BETWEEN the world and the emblem, and every property that makes that true is
// a premise about three or about this repo's own classifier rather than about
// the file itself. So the premises are what is pinned:
//
//   §1 three still sorts and blends the way the curtain relies on — read out of
//      three's own build, the way `xr-eye-layers.test.ts` reads it, because a
//      claim about three's private ordering is a claim a three upgrade can
//      falsify silently (CLAUDE.md, the program-cache-key trap).
//   §2 the curtain is a WORLD object, not UI — the one flag that, set the
//      "obvious" way, would put it over the emblem under bloom.
//   §3 the orders: above everything the title world sorts, below the fade.
//   §4 the schedule is the fade's ramp and it ends out of sight.
//
// What none of this can see is the picture, which is what
// `tests/e2e/title-emblem-first.spec.ts` and the photographs in the row are for.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { isUiObject } from '@/render/bloom'
import {
  COCKPIT_FIRST_ORDER,
  OCEAN_LATE_ORDER,
  SKY_FIRST_ORDER,
  SKY_LAST_ORDER,
} from '@/render/draw-order'
import { fadeRamp, LOAD_FADE_SECONDS, SOLID_AT } from '@/render/fade'
import {
  CURTAIN_ORDER,
  createTitleCurtain,
  curtainAmount,
  EMBLEM_ORDER,
} from '@/render/title-curtain'
import { createVignette } from '@/render/vignette'
import { REPO as ROOT } from './helpers/repo-root'

const THREE_BUILD = () =>
  fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

describe('§1 three sorts and blends the way the curtain relies on', () => {
  it('puts a non-transparent material in the OPAQUE list', () => {
    // `WebGLRenderList.push`: transmission first, then `transparent === true`,
    // and everything else is opaque. The curtain is `transparent: false`.
    const src = THREE_BUILD()
    expect(src).toMatch(
      /if \( material\.transmission > 0\.0 \) \{[\s\S]{0,120}\} else if \( material\.transparent === true \) \{[\s\S]{0,80}transparent\.push\( renderItem \);[\s\S]{0,80}opaque\.push\( renderItem \);/,
    )
  })

  it('switches blending off only for NormalBlending, so a custom blend survives', () => {
    // Which is why the curtain can be in the opaque list AND blend.
    expect(THREE_BUILD()).toContain(
      '( material.blending === NormalBlending && material.transparent === false )\n\t\t\t? setBlending( NoBlending )',
    )
  })

  it('sorts the opaque list by renderOrder before material or depth', () => {
    const src = THREE_BUILD()
    const body = src.slice(src.indexOf('function painterSortStable( a, b ) {'))
    const order = [
      'a.groupOrder !== b.groupOrder',
      'a.renderOrder !== b.renderOrder',
      'a.z !== b.z',
    ]
    const at = order.map((needle) => body.indexOf(needle))
    for (const i of at) expect(i).toBeGreaterThan(-1)
    expect(at).toEqual([...at].sort((x, y) => x - y))
  })
})

describe('§2 the curtain is in the world, and it blends', () => {
  const curtain = createTitleCurtain()
  const material = curtain.object.material as THREE.ShaderMaterial

  it('is NOT a UI object, or bloom would draw it over the emblem', () => {
    // `bloom.ts` moves `toneMapped === false` onto `UI_LAYER` and draws that
    // layer in a pass of its own AFTER the composite. The fade lives there,
    // which is exactly why the fade cannot do this job.
    expect(isUiObject(curtain.object)).toBe(false)
    expect(material.toneMapped).toBe(true)
  })

  it('is opaque-listed, custom-blended, and depth-blind', () => {
    expect(material.transparent).toBe(false)
    expect(material.blending).toBe(THREE.CustomBlending)
    expect(material.blendSrc).toBe(THREE.SrcAlphaFactor)
    expect(material.blendDst).toBe(THREE.OneMinusSrcAlphaFactor)
    // Draws over everything drawn before it, and leaves no depth behind for
    // the emblem to fail against.
    expect(material.depthTest).toBe(false)
    expect(material.depthWrite).toBe(false)
    // A clip-space quad's bounding sphere sits at the origin; culled against
    // the frustum it would vanish whenever the camera is not looking at 0,0,0.
    expect(curtain.object.frustumCulled).toBe(false)
  })
})

describe('§3 where it sorts', () => {
  it('lands after everything the title world draws in its opaque list', () => {
    for (const order of [
      SKY_FIRST_ORDER,
      SKY_LAST_ORDER,
      OCEAN_LATE_ORDER,
      COCKPIT_FIRST_ORDER,
      0,
    ]) {
      expect(CURTAIN_ORDER).toBeGreaterThan(order)
    }
    expect(createTitleCurtain().object.renderOrder).toBe(CURTAIN_ORDER)
  })

  it('puts the emblem immediately after it', () => {
    expect(EMBLEM_ORDER).toBeGreaterThan(CURTAIN_ORDER)
  })

  it('stays UNDER the fade, which must still black out the emblem on a one-pass frame', () => {
    // On Classic and in a headset there is no UI pass: the vignette is in the
    // same list, and the boot's solid black has to cover the emblem too.
    expect(createVignette().object.renderOrder).toBeGreaterThan(EMBLEM_ORDER)
  })
})

describe('§4 the schedule', () => {
  it('is 2016 fade ramp, inverted — solid at 0, clear at SOLID_AT of the way', () => {
    expect(curtainAmount(0, LOAD_FADE_SECONDS)).toBe(1)
    expect(curtainAmount(LOAD_FADE_SECONDS * SOLID_AT, LOAD_FADE_SECONDS)).toBe(0)
    for (let t = 0; t <= LOAD_FADE_SECONDS; t += 0.05) {
      expect(curtainAmount(t, LOAD_FADE_SECONDS)).toBeCloseTo(
        1 - fadeRamp(t, LOAD_FADE_SECONDS),
        12,
      )
    }
  })

  it('holds until lifted, then clears and takes itself out of the picture', () => {
    const curtain = createTitleCurtain()
    for (let i = 0; i < 120; i++) curtain.update(1 / 60)
    expect(curtain.phase).toBe('held')
    expect(curtain.amount).toBe(1)
    curtain.lift(LOAD_FADE_SECONDS)
    let last = curtain.amount
    let frames = 0
    while (curtain.phase !== 'gone' && frames < 600) {
      curtain.update(1 / 60)
      expect(curtain.amount).toBeLessThanOrEqual(last)
      last = curtain.amount
      frames++
    }
    expect(curtain.phase).toBe('gone')
    expect(curtain.amount).toBe(0)
    expect(curtain.object.visible).toBe(false)
    // Within the ramp's own length, give or take one frame.
    expect(frames / 60).toBeLessThanOrEqual(LOAD_FADE_SECONDS * SOLID_AT + 1 / 60)
  })

  it('ignores a second lift, so the valley cannot restart its own fade', () => {
    const curtain = createTitleCurtain()
    curtain.lift(LOAD_FADE_SECONDS)
    for (let i = 0; i < 20; i++) curtain.update(1 / 60)
    const partway = curtain.amount
    curtain.lift(LOAD_FADE_SECONDS)
    curtain.update(0)
    expect(curtain.amount).toBe(partway)
  })
})
