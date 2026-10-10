// tests/unit/lesson-tokens.test.ts — a prompt in the device's own words. DEV-377.
//
// `docs/plan/FLIGHT-INSTRUCTOR.md` §5.1: `{throttle}` is `right trigger` in a
// headset, `R2` on a pad, `right thumb, up` on a phone and `Space` on a
// keyboard, read off the Controls page's rows so the plate and the page cannot
// disagree; `{pitchUp}` / `{pitchDown}` follow `invertPitch` (D16).
//
// The trap this file is written against is CLAUDE.md's *"a test that compares
// two of your own devices has not tested either of them"*. So the words are
// held to things OUTSIDE the resolver: the keyboard's own bindings in
// `input/keyboard.ts`, the pitch the keyboard reader actually produces when the
// named key is pressed, and the plan's own four words for `{throttle}`.

import { describe, expect, it } from 'vitest'
import { CUE_IDS } from '@/audio/cues'
import { actionsForEvent } from '@/audio/events'
import { type ComfortSettings, DEFAULT_SETTINGS } from '@/boot/settings'
import { LESSON_CONTROL_TOKENS, LESSON_TOKENS, lessonSpeedTarget } from '@/content/level-schema'
import { noActions } from '@/input/actions'
import {
  AUTOPILOT_KEYS,
  attachKeyboard,
  BINDINGS,
  CONFIRM_KEYS,
  ENTER_VR_KEYS,
  RACE_LAP_KEYS,
  SHARE_LAP_KEYS,
} from '@/input/keyboard'
import { fitBody, wrapText } from '@/render/briefing'
import {
  actionsActive,
  type ControlsDevice,
  chooseWords,
  contextFor,
  controlsRows,
  controlWord,
  deviceOf,
  KEYBOARD_WORDS,
  latestFlatDevice,
  launchWord,
  pitchWords,
  resolveLessonText,
  startingFlatDevice,
} from '@/render/controls-menu'
import { formatSpeed } from '@/render/hud'

const DEVICES: readonly ControlsDevice[] = ['xr', 'pad', 'touch', 'keyboard']
const NORMAL: ComfortSettings = { ...DEFAULT_SETTINGS, invertPitch: false }
const INVERTED: ComfortSettings = { ...DEFAULT_SETTINGS, invertPitch: true }
const VALUES = { nextRing: 4, speed: '153 km/h', target: '180 km/h' }

/** `KeyW` → `W`, `Space` → `Space`, `ControlLeft` → `Ctrl`: the name a key cap carries. */
const keyName = (code: string): string =>
  code.startsWith('Key')
    ? code.slice(3)
    : code.startsWith('Control')
      ? 'Ctrl'
      : code.startsWith('Shift')
        ? 'Shift'
        : code.startsWith('Arrow')
          ? code.slice(5)
          : code.replace(/^Numpad/, '')

/** The key names bound to one of the keyboard's actions. */
const bound = (action: keyof typeof BINDINGS): string[] => BINDINGS[action].map(keyName)

describe('every token resolves, on every device', () => {
  it('names every control token in words, never braces, on all four', () => {
    for (const device of DEVICES) {
      for (const token of LESSON_CONTROL_TOKENS) {
        for (const s of [NORMAL, INVERTED]) {
          const word = controlWord(token, s, device)
          expect(word.length, `${token} on ${device}`).toBeGreaterThan(0)
          expect(word, `${token} on ${device}`).not.toMatch(/[{}]/)
        }
      }
    }
  })

  it('leaves no brace in a prompt carrying every token the schema knows', () => {
    const prompt = LESSON_TOKENS.map((t) => `{${t}}`).join(' and ')
    for (const device of DEVICES) {
      const text = resolveLessonText(prompt, NORMAL, device, VALUES)
      expect(text, device).not.toMatch(/[{}]/)
    }
  })

  it("says the plan's four words for {throttle}", () => {
    const words = Object.fromEntries(
      DEVICES.map((d) => [d, resolveLessonText('{throttle}', NORMAL, d, VALUES)]),
    )
    // The first letter is a sentence's capital; the words are §5.1's.
    expect(words).toEqual({
      xr: 'Right trigger',
      pad: 'R2',
      touch: 'Right thumb, up',
      keyboard: 'Space',
    })
  })

  it('reads the Controls page, so the two cannot disagree', () => {
    const rowOf = { throttle: 'throttle', boost: 'boost', slow: 'slow', fly: 'fly', roll: 'roll' }
    for (const device of DEVICES) {
      const rows = controlsRows(NORMAL, contextFor(device))
      for (const [token, id] of Object.entries(rowOf)) {
        const row = rows.find((r) => r.id === id)
        expect(controlWord(token as 'throttle', NORMAL, device), `${token} on ${device}`).toBe(
          row?.value,
        )
      }
    }
  })

  it('writes the values: the ring to make for, and the speed as the dash prints it', () => {
    // The dash's own formatter, in each preset's unit: the plate and the
    // readout under it print one number for one speed (Anniversary km/h,
    // Classic 2016's bare m/s).
    for (const unit of ['kmh', 'ms'] as const) {
      const speed = formatSpeed(42.4, unit)
      expect(
        resolveLessonText('Turn back to ring {nextRing}. SPEED {speed}', NORMAL, 'pad', {
          nextRing: 4,
          speed,
          target: null,
        }),
      ).toBe(`Turn back to ring 4. SPEED ${speed}`)
    }
    expect(formatSpeed(42.4, 'kmh')).toBe('153 km/h')
    expect(formatSpeed(42.4, 'ms')).toBe('42')
  })

  it("writes {target} as the prompt's own threshold, in the dash's unit (DEV-378)", () => {
    // The number is the TRIGGER's, read by `lessonSpeedTarget`, never typed
    // beside it: the step that ends at 50 m/s says 180 km/h on Anniversary and
    // 50 on Classic, and the plate and the rule cannot disagree.
    const ends = { kind: 'speedAtLeast', mps: 50, forSeconds: 1 } as const
    expect(lessonSpeedTarget(ends)).toBe(50)
    expect(lessonSpeedTarget({ kind: 'speedAtMost', mps: 5, forSeconds: 3 })).toBe(5)
    // A sequence prints its first member that asks for a speed.
    expect(
      lessonSpeedTarget({
        kind: 'sequence',
        of: [
          { kind: 'bankAtLeast', degrees: 30 },
          { kind: 'speedAtLeast', mps: 120, forSeconds: 1 },
        ],
      }),
    ).toBe(120)
    // Anything else asks for none, which the validator refuses to pair with it.
    expect(lessonSpeedTarget({ kind: 'passGate', ring: 3 })).toBeNull()
    expect(lessonSpeedTarget({ kind: 'launched' })).toBeNull()
    for (const [unit, printed] of [
      ['kmh', '180 km/h'],
      ['ms', '50'],
    ] as const) {
      const target = formatSpeed(lessonSpeedTarget(ends) as number, unit)
      expect(target).toBe(printed)
      expect(
        resolveLessonText('{target}, SPEED {speed}', NORMAL, 'pad', {
          nextRing: 1,
          speed: formatSpeed(42.4, unit),
          target,
        }),
      ).toBe(`${printed}, SPEED ${formatSpeed(42.4, unit)}`)
    }
  })

  it('capitalises a word that opens a sentence, and only then', () => {
    expect(resolveLessonText('{pitchUp} to climb.', NORMAL, 'pad', VALUES)).toBe(
      'Left stick back to climb.',
    )
    expect(resolveLessonText('Dive. {pitchDown} now', NORMAL, 'pad', VALUES)).toBe(
      'Dive. Left stick forward now',
    )
    expect(resolveLessonText('Roll with {roll}.', NORMAL, 'pad', VALUES)).toBe(
      'Roll with right stick.',
    )
  })
})

describe('the keyboard column names keys the keyboard binds', () => {
  it('names a bound key for every row, from input/keyboard.ts', () => {
    // Held to the BINDINGS, not to a copy of them: move a key there and this goes red.
    expect(bound('throttle')).toContain(KEYBOARD_WORDS.throttle)
    expect(bound('boost')).toContain(KEYBOARD_WORDS.boost)
    expect(bound('airbrake')).toContain(KEYBOARD_WORDS.slow)
    expect(bound('noseDown')).toContain(KEYBOARD_WORDS.noseDown)
    expect(bound('noseUp')).toContain(KEYBOARD_WORDS.noseUp)
    const [bankLeft, bankRight] = KEYBOARD_WORDS.roll.split(' / ')
    expect(bound('bankLeft')).toContain(bankLeft)
    expect(bound('bankRight')).toContain(bankRight)
    const [pitch, yaw] = KEYBOARD_WORDS.fly.split(' ')
    expect(pitch?.split('/')).toEqual([KEYBOARD_WORDS.noseDown, KEYBOARD_WORDS.noseUp])
    expect(bound('yawLeft')).toContain(yaw?.split('/')[0])
    expect(bound('yawRight')).toContain(yaw?.split('/')[1])
    expect(CONFIRM_KEYS.map(keyName)).toContain(KEYBOARD_WORDS.launch)
  })

  it('names the keys with no row of their own, two rows of two, each one bound (DEV-598, DEV-835)', () => {
    expect(AUTOPILOT_KEYS.map(keyName)).toContain(KEYBOARD_WORDS.autopilot)
    expect(ENTER_VR_KEYS.map(keyName)).toContain(KEYBOARD_WORDS.enterVr)
    expect(RACE_LAP_KEYS.map(keyName)).toContain(KEYBOARD_WORDS.raceLap)
    expect(SHARE_LAP_KEYS.map(keyName)).toContain(KEYBOARD_WORDS.shareLap)
    const keys = (ctx: Parameters<typeof controlsRows>[1]) =>
      controlsRows(NORMAL, ctx).find((r) => r.id === 'keys')
    const keys2 = (ctx: Parameters<typeof controlsRows>[1]) =>
      controlsRows(NORMAL, ctx).find((r) => r.id === 'keys2')
    expect(keys({ xr: false, touch: false, keyboard: true })?.value).toBe('P H')
    expect(keys2({ xr: false, touch: false, keyboard: true })?.value).toBe('R G')
    expect(keys2({ xr: false, touch: false })).toBeUndefined()
    // A keyboard row, and only that: the pad, the phone and the headset bind none of these keys.
    expect(keys({ xr: false, touch: false })).toBeUndefined()
    expect(keys({ xr: false, touch: true, keyboard: true })).toBeUndefined()
    expect(keys({ xr: true, touch: false, keyboard: true })).toBeUndefined()
  })

  it('shows the keyboard column only where the keyboard is the last device, below xr and touch', () => {
    expect(deviceOf({ xr: false, touch: false, keyboard: true })).toBe('keyboard')
    expect(deviceOf({ xr: true, touch: false, keyboard: true })).toBe('xr')
    expect(deviceOf({ xr: false, touch: true, keyboard: true })).toBe('touch')
    expect(deviceOf({ xr: false, touch: false })).toBe('pad')
    const throttle = (keyboard: boolean) =>
      controlsRows(NORMAL, { xr: false, touch: false, keyboard }).find((r) => r.id === 'throttle')
        ?.value
    expect(throttle(true)).toBe('Space')
    expect(throttle(false)).toBe('R2')
  })

  it('names the launch key: A on a pad and a headset, the screen on a phone, Enter on a keyboard', () => {
    expect(launchWord('pad')).toBe('A')
    expect(launchWord('xr')).toBe('A')
    // DEV-607: the LAUNCH chip is gone; a tap on the screen launches.
    expect(launchWord('touch')).toBe('the screen')
    expect(launchWord('keyboard')).toBe('Enter')
  })
})

describe('{pitchUp} climbs, and flips with invertPitch (D16)', () => {
  /** Press the keys `word` names on a real keyboard reader, and read the pitch it produces. */
  const pitchFromKey = (word: string, s: ComfortSettings): number => {
    const target = new EventTarget()
    const kb = attachKeyboard(target)
    const code = Object.values(BINDINGS)
      .flat()
      .find((c) => keyName(c) === word) as string
    target.dispatchEvent(Object.assign(new Event('keydown'), { code }))
    // Past the ramp: the pitch the flight model would be handed.
    let pitch = 0
    for (let i = 0; i < 30; i++) pitch = kb.read(0.02, { invertPitch: s.invertPitch }).pitch
    kb.dispose()
    return pitch
  }

  it('names the key that pitches the nose UP on the keyboard, both ways round', () => {
    // +pitch is nose DOWN (`sim/autopilot.ts`, measured); the key the word
    // names must give a negative pitch, and the invert must move the word.
    for (const s of [NORMAL, INVERTED]) {
      expect(pitchFromKey(pitchWords(s, 'keyboard').up, s), `invert ${s.invertPitch}`).toBeLessThan(
        0,
      )
      expect(
        pitchFromKey(pitchWords(s, 'keyboard').down, s),
        `invert ${s.invertPitch}`,
      ).toBeGreaterThan(0)
    }
    expect(pitchWords(NORMAL, 'keyboard').up).not.toBe(pitchWords(INVERTED, 'keyboard').up)
  })

  it('says pull back to climb on a stick with the invert off, and push forward with it on', () => {
    // `xr-input.test.ts` measures the default as "push forward to dive": a
    // stick pulled back climbs. The invert is its opposite.
    for (const device of ['pad', 'xr'] as const) {
      expect(controlWord('pitchUp', NORMAL, device)).toBe('left stick back')
      expect(controlWord('pitchDown', NORMAL, device)).toBe('left stick forward')
      expect(controlWord('pitchUp', INVERTED, device)).toBe('left stick forward')
      expect(controlWord('pitchDown', INVERTED, device)).toBe('left stick back')
    }
    expect(controlWord('pitchUp', NORMAL, 'touch')).toBe('left thumb down')
    expect(controlWord('pitchUp', INVERTED, 'touch')).toBe('left thumb up')
  })

  it("puts the same words on the Controls page's invert note", () => {
    // The note said "pull back to climb" with the invert ON — the default's
    // gesture, and the one the switch undoes.
    for (const device of DEVICES) {
      for (const s of [NORMAL, INVERTED]) {
        const note = controlsRows(s, contextFor(device)).find((r) => r.id === 'invert')?.note
        expect(note, `${device} invert ${s.invertPitch}`).toBe(
          `${pitchWords(s, device).up} to climb`,
        )
      }
    }
    expect(controlsRows(INVERTED, contextFor('pad')).find((r) => r.id === 'invert')?.note).toBe(
      'left stick forward to climb',
    )
  })
})

describe('the device a page starts with (DEV-596)', () => {
  it('is touch on a phone and the KEYBOARD on a desktop, never the pad', () => {
    // The SHIPPED default, pinned: the 2026-10-03 playtest's mouse player read
    // "PRESS A TO CHOOSE" and "Hold R2 to fly." on a laptop while it was 'pad'.
    expect(startingFlatDevice(true)).toBe('touch')
    expect(startingFlatDevice(false)).toBe('keyboard')
    expect(chooseWords(startingFlatDevice(false))).toBe('press Enter to choose')
  })
})

describe('the last device that produced input', () => {
  it('moves to the device a hand touched, and stays there when nothing is touched', () => {
    expect(latestFlatDevice('pad', { pad: false, keyboard: true, touch: false })).toBe('keyboard')
    expect(latestFlatDevice('keyboard', { pad: false, keyboard: false, touch: false })).toBe(
      'keyboard',
    )
    expect(latestFlatDevice('keyboard', { pad: true, keyboard: false, touch: false })).toBe('pad')
    expect(latestFlatDevice('pad', { pad: false, keyboard: false, touch: true })).toBe('touch')
  })

  it('counts a hand, not a stick resting off-centre', () => {
    expect(actionsActive(noActions())).toBe(false)
    expect(actionsActive({ ...noActions(), pitch: 0.1, roll: -0.15 })).toBe(false)
    expect(actionsActive({ ...noActions(), yaw: 0.6 })).toBe(true)
    expect(actionsActive({ ...noActions(), throttle: 1 })).toBe(true)
    expect(actionsActive({ ...noActions(), airbrake: true })).toBe(true)
  })
})

describe('the two chirps (plan §5.2)', () => {
  it('are in the catalogue, and each event plays its own', () => {
    expect(CUE_IDS).toContain('lesson.prompt')
    expect(CUE_IDS).toContain('lesson.done')
    expect(actionsForEvent({ type: 'lesson.prompt' }, [])).toEqual([
      { kind: 'play', cue: 'lesson.prompt' },
    ])
    expect(actionsForEvent({ type: 'lesson.done' }, [])).toEqual([
      { kind: 'play', cue: 'lesson.done' },
    ])
  })
})

describe('the plate fits a prompt, and leaves the briefing as it was', () => {
  /** A monospace font: 0.6 of the size per character, exact. */
  const measure = (px: number, s: string) => s.length * px * 0.6
  // The briefing's canvas: 0.66 x 0.22 m at 1400 px per metre, less its pad.
  const W = 924 - 2 * 46.2
  const H = 308

  it("draws 2016's briefing at the full size, as before", () => {
    const text = "Fly through as many rings as you can before time runs out. Don't CRASH!!"
    const fit = fitBody(text, W, H, measure)
    expect(fit.px).toBe(H * 0.12)
    expect(fit.lines).toEqual(wrapText(text, W, (s) => measure(H * 0.12, s)))
  })

  it('shrinks a long prompt until it fits, rather than dropping its last line off the plate', () => {
    const text =
      'Roll with right stick, then let go. It stays banked: this ship never levels itself. ' +
      'Roll it back to level, and hold it there while I watch.'
    const full = wrapText(text, W, (s) => measure(H * 0.12, s))
    expect(full.length).toBeGreaterThan(3)
    const fit = fitBody(text, W, H, measure)
    expect(fit.px).toBeLessThan(H * 0.12)
    // Every line's centre on the plate: the first at 0.48 of the height, then
    // one leading apart, the last no lower than 0.9.
    expect(0.48 * H + (fit.lines.length - 1) * fit.px * 1.35).toBeLessThanOrEqual(0.9 * H)
    expect(fit.lines.join(' ')).toBe(text)
  })
})
