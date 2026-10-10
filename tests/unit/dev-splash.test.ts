// DEV-611, DEV-872: the developer splash's schedule, its every-load rule, and the
// two hooks `boot/app.ts` holds for it. The DOM driver is exercised by
// `tests/e2e/dev-splash.spec.ts`; this pins the arithmetic it runs on.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  barTarget,
  fadeAt,
  SPLASH_BEATS,
  SPLASH_FINAL_TYPE_MS,
  SPLASH_HOLD_MS,
  SPLASH_LANDED_MS,
  SPLASH_TYPE_FAST_MS,
  SPLASH_TYPE_SLOW_MS,
  SPLASH_WORDS,
  splashFrameAt,
  startDevSplash,
} from '@/boot/dev-splash'
import type { LoadState } from '@/boot/load-progress'
import { appSourceThroughCtx, codeOnly, readThroughCtx } from './helpers/app-source'

const state = (phase: LoadState['phase'], fraction = 0): LoadState => ({
  phase,
  fraction,
  place: 'Faceted Flight',
  error: null,
})

describe('the typewriter: type, sit, delete, type the next (DEV-624)', () => {
  it('ends on the game', () => {
    expect(SPLASH_WORDS.at(-1)).toBe('Faceted Flight')
    expect(SPLASH_BEATS).toHaveLength(SPLASH_WORDS.length)
  })

  it('types, sits and deletes every word back to back, and never deletes the game', () => {
    let t = 0
    for (const [i, b] of SPLASH_BEATS.entries()) {
      expect(b.from).toBeCloseTo(t, 9)
      expect(b.typedAt).toBeGreaterThan(b.from)
      expect(b.deleteFrom).toBeGreaterThan(b.typedAt)
      if (i < SPLASH_BEATS.length - 1) expect(b.until).toBeGreaterThan(b.deleteFrom)
      t = b.until
    }
    const final = SPLASH_BEATS.at(-1) as (typeof SPLASH_BEATS)[number]
    expect(final.until).toBe(final.deleteFrom)
  })

  it('goes slow, then speeds up (DEV-611: "slow - speed up - hold")', () => {
    const perLetter = SPLASH_BEATS.slice(0, -1).map(
      (b, i) => (b.typedAt - b.from) / ((SPLASH_WORDS[i] as string).length - 1),
    )
    expect(perLetter[0]).toBeCloseTo(SPLASH_TYPE_SLOW_MS, 6)
    expect(perLetter.at(-1)).toBeCloseTo(SPLASH_TYPE_FAST_MS, 6)
    for (let i = 1; i < perLetter.length; i++)
      expect(perLetter[i]).toBeLessThan(perLetter[i - 1] as number)
  })

  it("then holds on Faceted Flight for Matt's 2.5 s", () => {
    const final = SPLASH_BEATS.at(-1) as (typeof SPLASH_BEATS)[number]
    expect(SPLASH_LANDED_MS).toBe(final.typedAt)
    expect(final.typedAt - final.from).toBeCloseTo(
      ('Faceted Flight'.length - 1) * SPLASH_FINAL_TYPE_MS,
      6,
    )
    expect(final.until - final.typedAt).toBeCloseTo(SPLASH_HOLD_MS, 6)
  })

  it('types every word a letter at a time, then deletes it a letter at a time, in order', () => {
    // Every frame the blank shows a PREFIX of a word: up one letter while it
    // types, down one while it deletes, never a jump, never a swap mid-word.
    const seen: number[] = []
    let prev = { index: 0, letters: 0 }
    for (let ms = 0; ms <= SPLASH_LANDED_MS + 500; ms += 1) {
      const f = splashFrameAt(ms)
      if (seen.at(-1) !== f.index) {
        // A new word starts only once the one before it is deleted to nothing.
        if (seen.length) expect(prev.letters).toBe(0)
        expect(f.letters).toBe(1)
        seen.push(f.index)
      } else {
        expect(Math.abs(f.letters - prev.letters)).toBeLessThanOrEqual(1)
      }
      prev = f
    }
    expect(seen).toEqual(SPLASH_WORDS.map((_, i) => i))
  })

  it('shows each word in full while it sits, and nothing between two words', () => {
    for (const [i, b] of SPLASH_BEATS.entries()) {
      const n = (SPLASH_WORDS[i] as string).length
      expect(splashFrameAt((b.typedAt + b.deleteFrom) / 2)).toEqual({ index: i, letters: n })
      if (i < SPLASH_BEATS.length - 1) expect(splashFrameAt(b.until - 0.001).letters).toBe(0)
    }
  })

  it('lands typed in full on Faceted Flight and stays there', () => {
    const last = SPLASH_WORDS.length - 1
    const full = { index: last, letters: 'Faceted Flight'.length }
    expect(splashFrameAt(SPLASH_LANDED_MS)).toEqual(full)
    expect(splashFrameAt(SPLASH_LANDED_MS + 60_000)).toEqual(full)
    expect(splashFrameAt(SPLASH_LANDED_MS - 1).letters).toBeLessThan(full.letters)
  })

  it('is a short screen: the game is typed within five seconds', () => {
    expect(SPLASH_LANDED_MS).toBeLessThan(5000)
  })

  it('sizes the blank with the same words index.html paints', () => {
    const html = readFileSync('index.html', 'utf8')
    const words = [...html.matchAll(/class="dev-splash__sizer">([^<]*)</g)].map((m) => m[1])
    expect(words).toEqual([...SPLASH_WORDS])
  })
})

describe('when it goes', () => {
  const held = SPLASH_LANDED_MS + SPLASH_HOLD_MS

  it("is Matt's 2.5 s after the last word", () => {
    expect(SPLASH_HOLD_MS).toBe(2500)
  })

  it('never before the scene is loaded, pressed or not', () => {
    expect(fadeAt(null, null)).toBeNull()
    expect(fadeAt(null, 100)).toBeNull()
  })

  it('a quick load waits for the roll and the hold', () => {
    expect(fadeAt(1000, null)).toBe(held)
  })

  it('a slow load goes the moment it is in', () => {
    expect(fadeAt(held + 4000, null)).toBe(held + 4000)
  })

  it('a press once loaded goes then, hold or no hold', () => {
    expect(fadeAt(1000, 1200)).toBe(1200)
    expect(fadeAt(1000, held + 50)).toBe(held + 50)
  })
})

describe('the bar', () => {
  it('fills with the terrain, keeps a little for the assembly, and ends full', () => {
    expect(barTarget(state('terrain', 0))).toBe(0)
    expect(barTarget(state('terrain', 1))).toBeLessThan(barTarget(state('assembling')))
    expect(barTarget(state('assembling'))).toBeLessThan(1)
    expect(barTarget(state('ready'))).toBe(1)
  })
})

describe('every load (DEV-872)', () => {
  // A fake page, enough for `startDevSplash` to run in node: the same builder
  // for a first load and for a "second load of the session", which is the point.
  const el = (): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      dataset: {},
      style: {},
      classList: { add: () => {} },
      textContent: '',
      removed: false,
      addEventListener: () => {},
      setAttribute: () => {},
      remove: () => {
        node.removed = true
      },
    }
    return node
  }
  const load = (): { root: Record<string, unknown>; body: { dataset: Record<string, string> } } => {
    const root = el()
    const parts = [el(), el(), el()]
    root.querySelector = (sel: string) =>
      sel === '.dev-splash__typed' ? parts[0] : sel === '.dev-splash__fill' ? parts[1] : parts[2]
    const body = { dataset: {} as Record<string, string> }
    vi.stubGlobal('document', { body })
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', () => {})
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('setTimeout', () => 0)
    return { root, body }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('shows on a load, and on the next load of the same session, the same way', () => {
    for (let visit = 0; visit < 3; visit++) {
      const { root, body } = load()
      startDevSplash(root as unknown as HTMLElement, () => 0, 'p.webp')
      expect(body.dataset.splash, `visit ${visit}`).toBe('up')
      expect(root.removed, `visit ${visit}`).toBe(false)
    }
  })

  it('remembers nothing between loads: no storage in the module or the first paint', () => {
    const module = readFileSync('src/boot/dev-splash.ts', 'utf8')
    expect(codeOnly(module)).not.toMatch(/sessionStorage|localStorage|splash\.seen/)
    const html = readFileSync('index.html', 'utf8')
    expect(html).not.toMatch(/splash-seen|splashSeen|ff\.splash\.seen/)
  })
})

describe("boot/app.ts's two hooks", () => {
  const code = codeOnly(appSourceThroughCtx())

  it('reads every press as already held while the splash is up, before the edges', () => {
    const gate = code.indexOf('if (splash?.covering()) confirmKey.hold()')
    const edge = code.indexOf('const confirmPressed = confirmKey.step(confirm)')
    const lift = code.indexOf('if (confirmPressed) cardLifted = true', edge)
    expect(gate, 'the gate').toBeGreaterThan(-1)
    // Before the first edge the frame acts on, so neither can fire through it.
    expect(edge).toBeGreaterThan(gate)
    // The step is the one that records the REAL down state (what keeps the
    // skipping press from being a fresh edge once it has gone), so it has to run
    // on every frame: a `const` at the frame body's own indentation, and ahead
    // of the first thing that reads the edge.
    expect(code.slice(edge - 5, edge), 'the step is not inside a branch').toBe('\n    ')
    expect(lift).toBeGreaterThan(edge)
    // Nothing reads the old hand-written latch any more.
    expect(code).not.toContain('confirmHeld')
  })

  it("lifts the title's curtain on the splash's fade", () => {
    // Read through the split's plumbing (APP-SPLIT §6): the hook lives in
    // `boot/app/title/world.ts`, where the closure's curtain is `ctx.titleCurtain`.
    expect(readThroughCtx(code)).toContain(
      'splash.lifting.then(() => titleCurtain?.lift(LOAD_FADE_SECONDS))',
    )
  })
})
