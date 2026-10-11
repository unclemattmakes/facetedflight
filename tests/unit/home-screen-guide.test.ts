// tests/unit/home-screen-guide.test.ts: DEV-842 (QUESTIONS-FOR-MATT item 3).
//
// The add-to-home-screen card: shown on a phone browser that is not already
// running from the home screen, dismissable, remembered; never on a desktop, a
// tablet, an installed app, or while a session presents (the frame loop then
// passes the title as down).

import { describe, expect, it } from 'vitest'
import {
  createHomeScreenGuide,
  GUIDE_ANDROID_STEPS,
  GUIDE_CHIP,
  GUIDE_DISMISS,
  GUIDE_HIDE,
  GUIDE_IOS_STEPS,
  GUIDE_LEAD,
  GUIDE_ROOT_ID,
  GUIDE_STORAGE_KEY,
  guideApplies,
} from '@/input/home-screen-guide'
import { HOME_HINT_STORAGE_KEY, type TurnWindow } from '@/input/turn-phone'

/** The least DOM the card touches: a tree of nodes with a text field and listeners. */
class FakeNode {
  id = ''
  className = ''
  hidden = false
  type = ''
  textContent = ''
  children: FakeNode[] = []
  parent: FakeNode | null = null
  listeners = new Map<string, () => void>()
  constructor(readonly tag: string) {}
  setAttribute(): void {}
  appendChild(n: FakeNode): FakeNode {
    n.parent = this
    this.children.push(n)
    return n
  }
  append(...ns: FakeNode[]): void {
    for (const n of ns) this.appendChild(n)
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, fn)
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())]
  }
}

const fakeDoc = () => {
  const body = new FakeNode('body')
  const head = new FakeNode('head')
  const doc = {
    body,
    head,
    createElement: (tag: string) => new FakeNode(tag),
    getElementById: (id: string) => [...body.all(), ...head.all()].find((n) => n.id === id) ?? null,
  }
  return { doc: doc as unknown as Document, body }
}

const store = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  }
}

const win = (
  over: Partial<{ standalone: boolean; display: boolean; wide: boolean }> = {},
): TurnWindow =>
  ({
    screen: over.wide ? { width: 1180, height: 820 } : { width: 390, height: 844 },
    navigator: { standalone: over.standalone === true },
    matchMedia: (q: string) => ({ matches: over.display === true && q.includes('standalone') }),
  }) as unknown as TurnWindow

const card = (body: FakeNode): FakeNode | undefined =>
  body.children.find((c) => c.id === GUIDE_ROOT_ID)

describe('when the guide applies', () => {
  it('a phone browser: yes', () => {
    expect(guideApplies(win(), true)).toBe(true)
  })
  it('already launched from the home screen (iOS standalone or display-mode): no', () => {
    expect(guideApplies(win({ standalone: true }), true)).toBe(false)
    expect(guideApplies(win({ display: true }), true)).toBe(false)
  })
  it('a tablet or a desktop (no touch mode): no', () => {
    expect(guideApplies(win({ wide: true }), true)).toBe(false)
    expect(guideApplies(win(), false)).toBe(false)
  })
})

describe('the card', () => {
  it('shows on the title with the sentence and both platforms steps', () => {
    const { doc, body } = fakeDoc()
    const guide = createHomeScreenGuide({ doc, win: win(), enabled: true, storage: store() })
    expect(card(body)).toBeUndefined()
    guide.frame(true, false)
    const el = card(body)
    expect(el).toBeDefined()
    expect(guide.showing).toBe(true)
    const text = (el as FakeNode)
      .all()
      .map((n) => n.textContent)
      .join('|')
    expect(text).toContain(GUIDE_LEAD)
    for (const step of [...GUIDE_IOS_STEPS, ...GUIDE_ANDROID_STEPS]) expect(text).toContain(step)
  })

  it('waits for the title, and yields to the turn screen and to a session', () => {
    const { doc, body } = fakeDoc()
    const guide = createHomeScreenGuide({ doc, win: win(), enabled: true, storage: store() })
    guide.frame(false, false)
    expect(card(body)).toBeUndefined()
    guide.frame(true, true)
    expect(card(body)).toBeUndefined()
    guide.frame(true, false)
    expect(guide.showing).toBe(true)
    // A presenting session reports the title as down.
    guide.frame(false, false)
    expect(guide.showing).toBe(false)
    guide.frame(true, false)
    expect(guide.showing).toBe(true)
  })

  it('dismissing removes it, remembers it, and also silences the shorter hints', () => {
    const { doc, body } = fakeDoc()
    const s = store()
    const guide = createHomeScreenGuide({ doc, win: win(), enabled: true, storage: s })
    guide.frame(true, false)
    const button = (card(body) as FakeNode)
      .all()
      .find((n) => n.tag === 'button' && n.textContent === GUIDE_DISMISS) as FakeNode
    button.listeners.get('click')?.()
    expect(card(body)).toBeUndefined()
    expect(s.map.get(GUIDE_STORAGE_KEY)).toBe('1')
    expect(s.map.get(HOME_HINT_STORAGE_KEY)).toBe('1')
    guide.frame(true, false)
    expect(card(body)).toBeUndefined()
  })

  it('opens as a chip; the chip opens the card and LATER folds it back (DEV-902)', () => {
    const { doc, body } = fakeDoc()
    const guide = createHomeScreenGuide({ doc, win: win(), enabled: true, storage: store() })
    guide.frame(true, false)
    const root = card(body) as FakeNode
    const press = (words: string) =>
      root
        .all()
        .find((n) => n.tag === 'button' && n.textContent === words)
        ?.listeners.get('click')?.()
    expect(root.className).toBe('')
    expect(root.children[0]?.className).toBe('chip')
    press(GUIDE_CHIP)
    expect(root.className).toBe('open')
    press(GUIDE_HIDE)
    expect(root.className).toBe('')
    expect(guide.showing).toBe(true)
  })

  it('does not come back on a later load once dismissed', () => {
    const { doc, body } = fakeDoc()
    const guide = createHomeScreenGuide({
      doc,
      win: win(),
      enabled: true,
      storage: store({ [GUIDE_STORAGE_KEY]: '1' }),
    })
    guide.frame(true, false)
    expect(card(body)).toBeUndefined()
  })

  it('never builds where it does not apply: desktop, tablet, installed app', () => {
    for (const [w, enabled] of [
      [win(), false],
      [win({ wide: true }), true],
      [win({ standalone: true }), true],
      [win({ display: true }), true],
    ] as const) {
      const { doc, body } = fakeDoc()
      const guide = createHomeScreenGuide({ doc, win: w, enabled, storage: store() })
      guide.frame(true, false)
      expect(card(body)).toBeUndefined()
      expect(guide.showing).toBe(false)
    }
  })

  it('refused storage shows it and still dismisses without throwing', () => {
    const { doc, body } = fakeDoc()
    const refusing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const guide = createHomeScreenGuide({ doc, win: win(), enabled: true, storage: refusing })
    guide.frame(true, false)
    expect(guide.showing).toBe(true)
    expect(() => guide.dismiss()).not.toThrow()
    expect(card(body)).toBeUndefined()
  })
})
