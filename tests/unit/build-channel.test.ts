// tests/unit/build-channel.test.ts — DEV-411, variants and the glider on
// preview only; DEV-470, rooms and the editor shipped (D36); DEV-578, TV
// shipped (Matt, 2026-10-03: *"FF-TV - move to production"*).
//
// What is worth asserting:
//  1. The LIST, by value. Taking a feature off it ships the feature to
//     production, so that edit has to be made here on purpose (CLAUDE.md,
//     "CHANGING A SHIPPED DEFAULT").
//  2. Only the branch Cloudflare builds as production is `release`.
//  3. A release build turns each listed block off and moves NOTHING else; the
//     preview build is the preset itself.
//  4. Each listed block really is a feature the preset has on, so the switch
//     is not guarding something already off.
//  5. The suite runs the preview build, which is what `main` ships.
//  6. DEV-470: what a release build now HAS: rooms and the editor on, and
//     since DEV-578 TV, so its hangar's first step is the same four tables as
//     preview's, read the way `boot/app.ts` reads them (the menus' preset,
//     Anniversary, as this channel loads it).

import { describe, expect, it } from 'vitest'
import { BUILD_CHANNEL, channelFor, forChannel, PREVIEW_ONLY } from '@/content/build-channel'
import { type Edition, validateEdition } from '@/content/edition-schema'
import { DOOR, doorCards } from '@/render/hangar-doors'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const anniversary = validateEdition(anniversaryJson as unknown as Edition)
const classic = validateEdition(classicJson as unknown as Edition)

describe('DEV-411 — variants and the glider stay on preview (rooms and the editor ship, DEV-470)', () => {
  it('holds exactly these features back from a release build', () => {
    // DEV-480 put TV here until it was worn; DEV-578 took it off at Matt's word
    // (2026-10-03: *"FF-TV - move to production"*).
    expect([...PREVIEW_ONLY]).toEqual(['variants', 'glider'])
  })

  it('is `release` only on the release branch', () => {
    expect(channelFor('release')).toBe('release')
    for (const branch of ['main', 'release-candidate', 'Release', '', undefined]) {
      expect(channelFor(branch), String(branch)).toBe('preview')
    }
  })

  it('turns each held-back feature off in a release build, and moves nothing else', () => {
    for (const key of PREVIEW_ONLY) {
      expect(anniversary.gameplay[key].enabled, `Anniversary ships ${key} on preview`).toBe(true)
    }
    const shipped = forChannel(anniversary, 'release')
    for (const key of PREVIEW_ONLY) {
      expect(shipped.gameplay[key].enabled, key).toBe(false)
      const { enabled: _a, ...rest } = shipped.gameplay[key]
      const { enabled: _b, ...before } = anniversary.gameplay[key]
      expect(rest, `${key}: only its flag moved`).toEqual(before)
    }
    const others = Object.keys(anniversary.gameplay).filter(
      (k) => !(PREVIEW_ONLY as readonly string[]).includes(k),
    )
    for (const k of others) {
      expect(shipped.gameplay[k as keyof Edition['gameplay']], k).toBe(
        anniversary.gameplay[k as keyof Edition['gameplay']],
      )
    }
    const { gameplay: _g, ...shippedRest } = shipped
    const { gameplay: _h, ...presetRest } = anniversary
    expect(shippedRest).toEqual(presetRest)
    // And the preset it came from is untouched.
    for (const key of PREVIEW_ONLY) expect(anniversary.gameplay[key].enabled).toBe(true)
  })

  it('still validates as a preset once the features are off', () => {
    expect(() => validateEdition(forChannel(anniversary, 'release'))).not.toThrow()
    expect(() => validateEdition(forChannel(classic, 'release'))).not.toThrow()
  })

  it('hands the preview build the preset itself', () => {
    expect(forChannel(anniversary, 'preview')).toBe(anniversary)
    expect(forChannel(classic, 'preview')).toBe(classic)
  })

  it('runs this suite as the preview build, which is what main ships', () => {
    expect(BUILD_CHANNEL).toBe('preview')
  })
})

// ── DEV-470: what 1.0 ships (D36) ───────────────────────────────────────────
//
// Matt, 2026-09-27: *"multiplayer & editor ship."* The title's rows read the
// MENUS' preset — Anniversary as the channel loads it (`menuFlags` and
// `coursesInput` in `boot/app.ts`, D35) — so the release title is asserted
// from exactly that: `forChannel(anniversary, 'release')`'s two flags into the
// title's own page functions. An empty course list stands in for the
// library (`coursesInput` is null only where the editor is off).

describe('DEV-470 — a release build ships rooms and the course editor', () => {
  const release = forChannel(anniversary, 'release')

  it('has rooms, the editor and (DEV-578) TV on, and still no variants and no glider', () => {
    expect(release.gameplay.rooms.enabled, 'rooms ship (D36)').toBe(true)
    expect(release.gameplay.editor.enabled, 'the editor ships (D36)').toBe(true)
    expect(release.gameplay.variants.enabled, 'variants stay preview-only').toBe(false)
    expect(release.gameplay.glider.enabled, 'the glider stays preview-only').toBe(false)
    expect(release.gameplay.tv.enabled, 'TV ships (DEV-578)').toBe(true)
    // And with TV on, the headset's comfort cuts stay as the preset has them
    // (off: TV in a headset is the flat camera, DEV-481 follow-up).
    expect(release.gameplay.tv.headsetCuts).toEqual(anniversary.gameplay.tv.headsetCuts)
  })

  it('DEV-558, DEV-565, DEV-578: its hangar opens on QUICK RACE, SINGLE PLAYER, MULTIPLAYER and FF-TV, as preview’s does', () => {
    // The first step's tables, read the way `boot/app.ts` reads them: off the
    // MENUS' preset as each channel ships it. TV ships since DEV-578, so a
    // release build's first step is four tables, preview's four (DEV-565
    // added QUICK RACE, which reads no flag), SINGLE PLAYER under the resting
    // pointer (Matt, 2026-10-02: *"single player under the pointer"*).
    const doorsOf = (e: typeof release) =>
      doorCards({
        rooms: e.gameplay.rooms.enabled,
        tv: e.gameplay.tv.enabled,
        firstVisit: false,
        linkRoom: null,
        roomNotice: null,
      }).map((d) => d.id)
    // DEV-620: and CREDITS, first, off the left end, on both channels.
    expect(doorsOf(release)).toEqual([
      DOOR.options,
      DOOR.quickRace,
      DOOR.single,
      DOOR.multiplayer,
      DOOR.tv,
    ])
    const preview = forChannel(anniversary, 'preview')
    expect(doorsOf(preview)).toEqual(doorsOf(release))
  })
})
