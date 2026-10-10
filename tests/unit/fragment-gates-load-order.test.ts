// Loaded FIRST, `lod-fade` used to reach `fragment-gates` through
// delegating-clone -> point-light-scope while it was still initialising, and
// `GATE_DEFINES` read `LOD_FADE_DEFINE` in its temporal dead zone: "Cannot
// access 'LOD_FADE_DEFINE' before initialization" at boot, once the app.ts
// split changed which module the entry reached first (Matt, 2026-10-07). The
// modules are imported DYNAMICALLY, lod-fade first, because a static import
// list is re-sorted by the formatter and the order that broke would no longer
// be the order tested. Red before `render/lod-fade-define.ts` existed.
import { describe, expect, it } from 'vitest'

describe('fragment-gates and lod-fade load in either order', () => {
  it('GATE_DEFINES.lodFade is the fade define when lod-fade loads first', async () => {
    const { LOD_FADE_DEFINE } = await import('@/render/lod-fade')
    const { GATE_DEFINES } = await import('@/render/fragment-gates')
    expect(LOD_FADE_DEFINE).toBe('FF2_LOD_FADE')
    expect(GATE_DEFINES.lodFade).toBe(LOD_FADE_DEFINE)
  })
})
