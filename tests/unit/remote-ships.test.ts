// A remote player's name tag is a thing in the world (DEV-388 follow-up; Matt,
// 2026-09-27: "hide name tags everywhere (when they should be obscured)").
//
// Which pass draws it is decided by `render/bloom.ts`'s own classifier, so the
// classifier is the oracle here: a material it calls UI is drawn after the
// world with the depth buffer cleared, over every hill. The screen-level proof
// is `tests/e2e/room-tag-occlusion.spec.ts`; this is the rule it rests on, in
// node, where a change to either side of it goes red at once.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { NAME_TAG_MATERIAL, srgbCss } from '@/game/remote-ships'
import { isUiObject } from '@/render/bloom'

describe('a name tag', () => {
  it('is drawn with the world, depth-tested, never in the UI pass', () => {
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ ...NAME_TAG_MATERIAL }))
    expect(isUiObject(tag)).toBe(false)
    expect(tag.material.depthTest).toBe(true)
    // It does not write depth: two tags, or a tag and a trail, never cut holes in each other.
    expect(tag.material.depthWrite).toBe(false)
  })

  it('paints its stripe in the palette colour as CSS', () => {
    expect(srgbCss([1, 0.5, 0])).toBe('rgb(255,128,0)')
  })
})
