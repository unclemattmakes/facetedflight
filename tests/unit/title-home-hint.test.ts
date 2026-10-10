// tests/unit/title-home-hint.test.ts: DEV-795 (QUESTIONS-FOR-MATT item 21).
//
// The Add to Home Screen line also stands once on the title's credit line, for
// a phone that opened the link already sideways and never met the turn screen.
// One hint per DEVICE: it shares the turn screen's own flag, so whichever shows
// it first, the other does not.

import { describe, expect, it } from 'vitest'
import { createTitleHomeHint, TITLE_HOME_HINT_MS } from '@/input/title-home-hint'
import { HOME_HINT_STORAGE_KEY, TURN_HOME_SCREEN_NOTE, type TurnWindow } from '@/input/turn-phone'

const CREDIT = 'v1.0.0 · © 2016 and 2026, Uncle Matt Makes'

const store = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  }
}

/** An iPhone 13 Pro held sideways: a phone-sized screen, no element fullscreen. */
const iphone = (over: Partial<{ standalone: boolean; wide: boolean }> = {}) => ({
  win: {
    screen: over.wide ? { width: 1180, height: 820 } : { width: 390, height: 844 },
    navigator: { standalone: over.standalone === true },
    matchMedia: () => ({ matches: false }),
  } as unknown as TurnWindow,
  doc: { documentElement: {} } as unknown as Pick<Document, 'documentElement'>,
})

const make = (
  o: {
    storage?: ReturnType<typeof store>
    enabled?: boolean
    platform?: ReturnType<typeof iphone>
    doc?: Pick<Document, 'documentElement'>
  } = {},
) => {
  const line = { textContent: CREDIT as string | null }
  const storage = o.storage ?? store()
  const platform = o.platform ?? iphone()
  const hint = createTitleHomeHint({
    line,
    doc: o.doc ?? platform.doc,
    win: platform.win,
    enabled: o.enabled ?? true,
    storage,
  })
  return { line, storage, hint }
}

describe('the home-screen line on the title’s credit line (DEV-795)', () => {
  it('stands in the credit line once the title is up, and puts the credit back', () => {
    const { line, hint, storage } = make()
    hint.frame(false, false, 0)
    expect(line.textContent, 'nothing before the title is up').toBe(CREDIT)
    hint.frame(true, false, 100)
    expect(line.textContent).toBe(TURN_HOME_SCREEN_NOTE)
    expect(storage.map.get(HOME_HINT_STORAGE_KEY)).toBe('1')
    hint.frame(true, false, 100 + TITLE_HOME_HINT_MS - 1)
    expect(line.textContent).toBe(TURN_HOME_SCREEN_NOTE)
    hint.frame(true, false, 100 + TITLE_HOME_HINT_MS)
    expect(line.textContent).toBe(CREDIT)
    expect(hint.done).toBe(true)
  })

  it('is once per device: the flag the turn screen writes keeps it away, and it writes that flag', () => {
    const seen = make({ storage: store({ [HOME_HINT_STORAGE_KEY]: '1' }) })
    seen.hint.frame(true, false, 0)
    expect(seen.line.textContent).toBe(CREDIT)
    expect(seen.hint.done).toBe(true)
    // And a second page load after this one's showing finds the flag set.
    const first = make()
    first.hint.frame(true, false, 0)
    const next = make({ storage: first.storage })
    next.hint.frame(true, false, 0)
    expect(next.line.textContent).toBe(CREDIT)
  })

  it('never stands over the turn screen, which says the same line itself', () => {
    const { line, hint, storage } = make()
    hint.frame(true, true, 0)
    expect(line.textContent).toBe(CREDIT)
    expect(storage.map.has(HOME_HINT_STORAGE_KEY), 'nothing was told, nothing recorded').toBe(false)
    // The turn screen takes over while it is showing: the credit comes back.
    hint.frame(true, false, 10)
    expect(line.textContent).toBe(TURN_HOME_SCREEN_NOTE)
    hint.frame(true, true, 20)
    expect(line.textContent).toBe(CREDIT)
  })

  it('goes when the title goes', () => {
    const { line, hint } = make()
    hint.frame(true, false, 0)
    hint.frame(false, false, 50)
    expect(line.textContent).toBe(CREDIT)
    hint.frame(true, false, 60)
    expect(line.textContent, 'and does not come back').toBe(CREDIT)
  })

  it('is for an iPhone only: not a tablet, not from the home screen, not where fullscreen exists, not on a desktop', () => {
    for (const [name, m] of [
      ['a tablet', make({ platform: iphone({ wide: true }) })],
      ['launched from the home screen', make({ platform: iphone({ standalone: true }) })],
      [
        'an Android phone (element fullscreen)',
        make({ doc: { documentElement: { requestFullscreen: () => {} } } as never }),
      ],
      ['no touch mode', make({ enabled: false })],
    ] as const) {
      m.hint.frame(true, false, 0)
      expect(m.line.textContent, name).toBe(CREDIT)
      expect(m.storage.map.has(HOME_HINT_STORAGE_KEY), name).toBe(false)
    }
  })

  it('survives a storage that refuses (it may show again next load, which is harmless)', () => {
    const line = { textContent: CREDIT as string | null }
    const { win, doc } = iphone()
    const hint = createTitleHomeHint({
      line,
      doc,
      win,
      enabled: true,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
      },
    })
    expect(() => hint.frame(true, false, 0)).not.toThrow()
    expect(line.textContent).toBe(TURN_HOME_SCREEN_NOTE)
  })
})
