// tests/unit/confirm-prompt-device.test.ts — "Press A" said to a keyboard. DEV-396.
//
// `docs/BUGS.md`, 2026-09-24, flat build, keyboard: the dash plate on the pad
// said `Press A to launch` and the pause plate's footer `PRESS A TO CHOOSE`. On
// the keyboard A banks left and the confirm is Enter.
//
// CLAUDE.md's *"a test that compares two of your own devices has not tested
// either of them"* is why the words here are held to things OUTSIDE the
// wording: the keyboard's own `BINDINGS` and `CONFIRM_KEYS`
// (`input/keyboard.ts`), the touch chip's `CONFIRM_LABEL` (`input/confirm.ts`),
// and 2016's own `launchPrompt` out of every generated level.
//
// The last block reads `boot/app.ts` as text, as `xr-select.test.ts` does: the
// bug was a WIRING bug as much as a wording one — the device was tracked only in
// the mission branch, so the hangar's Enter never reached it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BINDINGS, CONFIRM_KEYS } from '@/input/keyboard'
import { type ControlsDevice, chooseWords, launchPromptFor } from '@/render/controls-menu'
import { appFileThroughWith, appSourceThroughCtx } from './helpers/app-source'

const ROOT = join(__dirname, '..', '..')
const LEVELS = join(ROOT, 'content', 'levels')

/** 2016's launch prompt, level by level, as the level JSON carries it. */
const prompts = (): { id: string; prompt: string }[] =>
  readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => {
      const level = JSON.parse(readFileSync(join(LEVELS, f), 'utf8')) as {
        id: string
        ui?: { strings?: { launchPrompt?: string } }
      }
      return { id: level.id, prompt: level.ui?.strings?.launchPrompt ?? '' }
    })
    .filter((p) => p.prompt !== '')

/** `KeyA` -> `A`, `Enter` -> `Enter`, `NumpadEnter` -> `Enter`: the name on the key cap. */
const keyName = (code: string): string =>
  code.startsWith('Key') ? code.slice(3) : code.replace(/^Numpad/, '')

/** Every key the keyboard binds to FLYING, by its cap: A is `bankLeft`. */
const flightKeys = new Set(Object.values(BINDINGS).flatMap((codes) => codes.map(keyName)))
const confirmKeys = new Set(CONFIRM_KEYS.map(keyName))

/** The words of a prompt, as a player reads them. */
const words = (s: string): string[] => s.split(/[^A-Za-z]+/).filter(Boolean)

describe('2016 prompt, worded for the device', () => {
  it('finds 2016 launch prompt in every generated level (the sample is not empty)', () => {
    expect(prompts().length).toBeGreaterThan(0)
    for (const { prompt } of prompts()) expect(words(prompt)).toContain('A')
  })

  it('leaves it byte for byte on a pad and in a headset, where A IS the confirm', () => {
    for (const { prompt } of prompts()) {
      expect(launchPromptFor(prompt, 'pad')).toBe(prompt)
      expect(launchPromptFor(prompt, 'xr')).toBe(prompt)
    }
  })

  it('names a key CONFIRM_KEYS binds on a keyboard, and no key bound to flying', () => {
    for (const { id, prompt } of prompts()) {
      const said = words(launchPromptFor(prompt, 'keyboard'))
      expect(
        said.filter((w) => confirmKeys.has(w)),
        `${id}: ${said.join(' ')}`,
      ).not.toHaveLength(0)
      // The bug, stated against the bindings: 2016's A is `bankLeft` here.
      expect(
        said.filter((w) => flightKeys.has(w)),
        `${id}: ${said.join(' ')}`,
      ).toEqual([])
    }
  })

  it('says tap the screen on a phone, which is the launch since DEV-607 took the chip away', () => {
    for (const { prompt } of prompts()) {
      const said = launchPromptFor(prompt, 'touch')
      expect(said).toContain('the screen')
      expect(words(said)).not.toContain('A')
      expect(said.startsWith('Tap')).toBe(true)
    }
  })

  it('returns a prompt that names no A button as it came, on every device', () => {
    const DEVICES: readonly ControlsDevice[] = ['xr', 'pad', 'touch', 'keyboard']
    for (const device of DEVICES) {
      expect(launchPromptFor('Hold on', device)).toBe('Hold on')
      // A word that merely CONTAINS a capital A is not the button.
      expect(launchPromptFor('ALTITUDE Alert', device)).toBe('ALTITUDE Alert')
    }
  })
})

describe("the pause plate's footer, worded for the device", () => {
  it('names a confirm key on a keyboard, and no key bound to flying', () => {
    const said = words(chooseWords('keyboard'))
    expect(said.filter((w) => confirmKeys.has(w))).not.toHaveLength(0)
    expect(said.filter((w) => flightKeys.has(w))).toEqual([])
  })

  it("keeps A on a pad and in a headset, and DEV-291's tap on a phone", () => {
    expect(chooseWords('pad')).toBe('press A to choose')
    expect(chooseWords('xr')).toBe('press A to choose')
    expect(chooseWords('touch')).toBe('tap an option')
  })
})

describe('boot/app.ts asks the device in the hands, on every screen', () => {
  // Read through the split's `ctx.` plumbing: the lobby, the letter plate, the
  // briefing's prompts and the lesson's device moved to `boot/app/` modules.
  const app = appSourceThroughCtx()

  it("routes 2016's launch prompt through the device wording", () => {
    expect(app).toMatch(/launchPromptFor\(\s*uiString\(level, 'launchPrompt'/)
  })

  it("puts no choose hint on any pause plate, only the roster's room code (DEV-861)", () => {
    // Matt, 2026-10-08: remove "press A to choose" and "press Enter to choose".
    // No plate is handed a `confirm` any more; the one footer left is asked for
    // by name (DEV-389: the roster's footer is the room's code, not a prompt).
    expect([...app.matchAll(/^\s*confirm: (.+),$/gm)].map((m) => m[1])).toEqual([])
    const footers = [...app.matchAll(/^\s*footer: (.+),$/gm)].map((m) => m[1] ?? '')
    expect(footers).toContain("lobbyRosterFooter(roomId ?? '')")
    expect(footers.filter((f) => /chooseWords/.test(f))).toEqual([])
  })

  it('has no big touch button past the title, and a tap on the thing in its place (DEV-607)', () => {
    // Matt, 2026-10-03: "remove the big button everywhere once tap-to-choose lands".
    expect(app).toContain("return confirmMeans(now) === 'start' ? confirmLabel(now) : null")
    // Taps are asked for wherever the button pressed: the letter plate, the
    // lobby, TV's plate, the pad and the results panel (the hangar since DEV-604).
    for (const where of [
      'codeUp() ||',
      'lobbyUp() ||',
      'tvView.plateUp() ||',
      'glassConfirms(),',
    ]) {
      expect(app).toContain(where)
    }
    expect(app).toContain('if (glassConfirms() && touch.readMenuTap() !== null) titleTapped = true')
    // APP-SPLIT 4.3b: the lobby's plate and rows are `roomLobby`'s now; the frame
    // reads them through its accessors.
    expect(app).toMatch(
      /(?:roomLobby\.)?lobbyPlate\?\.pick\(ray\.origin, ray\.direction, (?:roomLobby\.)?lobbyRows\.length\)/,
    )
  })

  it('starts every desktop prompt from ONE default, startingFlatDevice (DEV-596)', () => {
    // The title footer (built before `flatDevice` exists) and the tracked
    // device both: two copies of the old literal disagreed with nothing only
    // because both said 'pad'.
    // APP-SPLIT 4.8: the tracked device lives in `boot/app/flight/lesson.ts`, which
    // reads the closure's `capabilities` through its `ctx`: the same binding.
    expect(app.match(/startingFlatDevice\((?:ctx\.)?capabilities\.touch\)/g)).toHaveLength(1)
    expect(app).not.toMatch(/touch \? 'touch' : 'pad'/)
  })

  it('tracks the device ONCE, in the frame body, before the confirm handler branches on the screen', () => {
    // One update: a second copy in the mission branch is how the hangar's
    // Enter went unheard.
    expect(app.match(/flatDevice = latestFlatDevice\(/g)).toHaveLength(1)
    // Order is a claim about ONE file: the one the frame body is in.
    const frame = appFileThroughWith('const frame = (time').text
    const frameAt = frame.indexOf('const frame = (time')
    const callAt = frame.search(/^ {4}trackDevice\(pad, keys, thumbs\)$/m)
    const handlerAt = frame.indexOf('if (confirmPressed && (flight')
    expect(handlerAt, 'the confirm handler, in the frame body').toBeGreaterThan(-1)
    expect(frameAt).toBeGreaterThan(0)
    // At the frame body's own indentation, so no screen test encloses it.
    expect(callAt).toBeGreaterThan(frameAt)
    expect(callAt).toBeLessThan(handlerAt)
  })
})
