/**
 * Eval wave E (DEV-951 to DEV-954): four engine seams that became parameters.
 * Each test says the default IS the old constant, so a sequel can pass its own
 * value and this game is untouched.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPLASH_CONFIG,
  fadeAt,
  SPLASH_BEATS,
  SPLASH_LANDED_MS,
  SPLASH_WORDS,
  splashBeats,
  splashFrameAt,
} from '@/boot/dev-splash'
import { FADE } from '@/generated/constants.generated'
import {
  CUT_FADE_SECONDS,
  createFade,
  DEFAULT_FADE_TIMINGS,
  fadeRamp,
  SOLID_AT,
} from '@/render/fade'
import { DEFAULT_UI_THEME, UI_STACK, uiFont } from '@/render/ui-tokens'
import { FIXED_DT } from '@/sim/constants'
import { createClock, stepFixed } from '@/sim/integrator'

describe('stepFixed takes its step', () => {
  it('defaults to FIXED_DT and passes it to every tick', () => {
    const a = createClock()
    const b = createClock()
    const seen: number[] = []
    const alphaA = stepFixed(a, 0.1, (dt) => seen.push(dt))
    const alphaB = stepFixed(b, 0.1, () => {}, FIXED_DT)
    expect(new Set(seen)).toEqual(new Set([FIXED_DT]))
    expect(a).toEqual(b)
    expect(alphaA).toBe(alphaB)
  })

  it('a different step changes the tick count', () => {
    const c = createClock()
    stepFixed(c, 0.1, () => {}, 0.05)
    expect(c.tick).toBe(2)
  })
})

describe('splash words are a config', () => {
  it('the default is the shipped words and the shipped schedule', () => {
    expect(DEFAULT_SPLASH_CONFIG.words).toBe(SPLASH_WORDS)
    expect(splashBeats(SPLASH_WORDS)).toEqual(SPLASH_BEATS)
    for (const ms of [0, 100, 1000, 5000, SPLASH_LANDED_MS, SPLASH_LANDED_MS + 1]) {
      expect(splashFrameAt(ms, SPLASH_WORDS)).toEqual(splashFrameAt(ms))
    }
    expect(fadeAt(1, null, SPLASH_LANDED_MS)).toBe(fadeAt(1, null))
  })

  it('other words give another schedule', () => {
    const words = ['a', 'bb', 'the game']
    const beats = splashBeats(words)
    expect(beats).toHaveLength(3)
    expect(splashFrameAt(1e9, words, beats)).toEqual({ index: 2, letters: 8 })
  })
})

describe('fade timings are a parameter', () => {
  it('the default carries 2016 solid-at and the cut length', () => {
    expect(DEFAULT_FADE_TIMINGS).toEqual({
      solidAt: FADE.solidAtFraction,
      blackOutInSeconds: CUT_FADE_SECONDS,
    })
    expect(DEFAULT_FADE_TIMINGS.solidAt).toBe(SOLID_AT)
    expect(fadeRamp(0.4, 1, SOLID_AT)).toBe(fadeRamp(0.4, 1))
  })

  it('createFade() equals createFade(default) frame for frame', () => {
    const run = (f: ReturnType<typeof createFade>): number[] => {
      f.blackOut()
      f.release()
      const out: number[] = []
      for (let i = 0; i < 60; i++) {
        f.update(0.01)
        out.push(f.amount)
      }
      return out
    }
    expect(run(createFade(DEFAULT_FADE_TIMINGS))).toEqual(run(createFade()))
  })

  it('a longer way back from black is slower', () => {
    const f = createFade({ solidAt: 1, blackOutInSeconds: 10 })
    f.blackOut()
    f.release()
    f.update(0.1)
    f.update(0.1)
    expect(f.amount).toBeGreaterThan(0.9)
  })
})

describe('the UI font is a theme', () => {
  it('the default theme is CRYSTAL and the shipped stack', () => {
    expect(DEFAULT_UI_THEME.stack).toBe(UI_STACK)
    expect(uiFont(20, 700, DEFAULT_UI_THEME)).toBe(uiFont(20))
  })

  it('another theme is named in the string', () => {
    const t = { stack: '"Sequel Sans", sans-serif', loaded: () => true }
    expect(uiFont(12, 700, t)).toBe('400 12px "Sequel Sans", sans-serif')
  })
})
