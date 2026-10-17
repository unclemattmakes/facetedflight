// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/boot/dev-splash.ts: the developer splash, the page's "loading into the
// app" screen. DEV-611.
//
// Matt, 2026-10-03: *"a 'developer splash' section to our app's start - like
// how other games show the publisher, then developer, or engine, etc."* A
// light screen with the Uncle Matt Makes wordmark, its blank filled with
// words the way unclemattmakes.com's hero does (that site's `MAKES`; typed,
// since DEV-624), landing on Faceted Flight, over a load bar. *"once loaded and
// 2.5 seconds after 'Uncle Matt Makes: Faceted Flight' - fade out to reveal the
// loaded in title screen."*
//
// And on who sees it and how it is skipped: *"the splash should be like a
// "loading into the app" screen - so for all visitors making their first visit
// of the session. allow them to skip if pressing A (or clicking or tapping) and
// the scene is loaded"*. So:
//
//  - **Every load, whatever the URL.** The front door, a lap link, a room
//    invite, `?tv`, `?mission=` and `?edit=1` alike. It began as once per
//    browser session; DEV-872, Matt, 2026-10-08: *"show the splash screen every
//    time the players visit. right now it's great loading confirmation as
//    opposed to that black screen."* So nothing is remembered between loads.
//  - **A skip is honoured only once the scene is loaded.** A on a pad, a click,
//    a tap, Enter or Space. Before that a press does nothing at all.
//  - **The press that skips is not also a press on the game.** While the splash
//    is on screen, its fade included, `boot/app.ts` reads every confirm as
//    already HELD (`DevSplash.covering`), so a key or button still down when
//    it goes is not a fresh edge: it does not press the title's row underneath.
//    The fade counts: the splash's own frame can start it ahead of the game's
//    frame in the same tick, and a gate that opened at the fade's first frame
//    let the skipping press through as a fresh edge (the e2e caught it).
//
// ── It must not be DEV-557's curtain again ──────────────────────────────────
//
// DEV-557 took the HTML landing card away because *"the game can be fully
// functional, yet the curtain is still up."* So this one has a short, fixed
// life and nothing to click: it goes the moment BOTH of its conditions hold
// (loaded; the game typed and held 2.5 s), a press takes the hold away, and a
// load that FAILS takes it down at once so `#boot-failure` is readable.
//
// ── What it holds back ─────────────────────────────────────────────────────
//
// The title's emblem curtain (`render/title-curtain.ts`) lifts when the valley
// is in, and the flypast starts its clock on that frame. Behind this splash
// that opening pass would fly unseen, so `boot/app.ts` lifts the curtain on
// {@link DevSplash.lifting} instead: the valley fades in as this fades out.

import type { LoadState } from '@/boot/load-progress'

/**
 * The blank's words, the last one the game. Matt, 2026-10-03: *"ones similar
 * to the website"*: unclemattmakes.com's own `MAKES`, in the site's order, eight
 * of its eleven (a mess, toys and glowy bits sat out to keep the typing short),
 * with games last so the game follows it. Matt, 2026-10-15: *"add PolyFish as
 * one of the words it cycles through"*, his other game, just before this one
 * (PolyFish's own splash returns the favour with Faceted Flight).
 */
export const SPLASH_WORDS = [
  'stuff',
  'simulations',
  'automata',
  'critter cams',
  '3d prints',
  'doughnuts',
  'mistakes',
  'games',
  'PolyFish',
  'Faceted Flight',
] as const

/**
 * The typewriter. DEV-624, Matt, 2026-10-04: *"i'd love if the splash screen
 * used a typewriter effect to reveal the variable words instead of a "swipe"
 * transition that is currently used. so type it out. then delete it, then type
 * the new one out. kinda getting rid of that vertical scroll i previously asked
 * for."* So the blank's word is TYPED a letter at a time, sits, is DELETED a
 * letter at a time, and the next is typed: no slide, no wipe. DEV-611's pace
 * stays (*"slow - speed up - hold"*): every word types, sits and deletes faster
 * than the one before, a geometric ramp from the first word's numbers to the
 * last's, and Faceted Flight is typed and held for {@link SPLASH_HOLD_MS}.
 */
export const SPLASH_TYPE_SLOW_MS = 45
/** Per letter, the last word before the game. See {@link SPLASH_TYPE_SLOW_MS}. */
export const SPLASH_TYPE_FAST_MS = 16
/** How long the first word sits typed before it is deleted, ms. */
export const SPLASH_SIT_SLOW_MS = 220
/** How long the last word before the game sits, ms. */
export const SPLASH_SIT_FAST_MS = 60
/** A backspace is quicker than a keystroke: this share of the word's letter time. */
export const SPLASH_DELETE_SHARE = 0.4
/** Faceted Flight, per letter, ms: quick, but slow enough to read as typed. */
export const SPLASH_FINAL_TYPE_MS = 45
/**
 * The longest the wordmark waits for Bitter and the portrait before it shows, ms.
 * Both come after the splash's first paint (the face with the bundle,
 * `@fontsource/bitter` in `main.ts`; the portrait off the content bucket), so the
 * lockup is held back for them rather than changing face or popping a picture
 * in mid-word. On a slow line it stops waiting: Georgia reads fine, and the
 * portrait fades in when it lands.
 */
export const SPLASH_FACE_WAIT_MS = 600
/** Matt's number: how long "Faceted Flight" holds before the fade may start, ms. */
export const SPLASH_HOLD_MS = 2500
/** The fade out to the game, ms. */
export const SPLASH_FADE_MS = 700

/** One word's turn on the clock, ms after the typing starts. */
export interface SplashBeat {
  /** Its first letter goes in. */
  readonly from: number
  /** Its last letter is in: it sits. */
  readonly typedAt: number
  /** It starts being deleted (the last word never is: this is the end of the hold). */
  readonly deleteFrom: number
  /** It is gone, and the next word's first letter goes in. */
  readonly until: number
}

/**
 * What a splash says: a value a sequel passes its own. The default is this
 * game's words, the last one the game's name.
 */
export interface SplashConfig {
  readonly words: readonly string[]
}

export const DEFAULT_SPLASH_CONFIG: SplashConfig = { words: SPLASH_WORDS }

/** Every word's turn for `words`, in order. The last one's `until` is the end of the hold. */
export const splashBeats = (words: readonly string[]): readonly SplashBeat[] => {
  const beats: SplashBeat[] = []
  const ramp = words.length - 1
  const step = (slow: number, fast: number, i: number): number =>
    slow * (fast / slow) ** (i / Math.max(1, ramp - 1))
  let t = 0
  for (let i = 0; i < ramp; i++) {
    const letters = (words[i] as string).length
    const type = step(SPLASH_TYPE_SLOW_MS, SPLASH_TYPE_FAST_MS, i)
    // The first letter goes in at once; each next one a letter-time later.
    const typedAt = t + (letters - 1) * type
    const deleteFrom = typedAt + step(SPLASH_SIT_SLOW_MS, SPLASH_SIT_FAST_MS, i)
    const until = deleteFrom + letters * type * SPLASH_DELETE_SHARE
    beats.push({ from: t, typedAt, deleteFrom, until })
    t = until
  }
  const typedAt = t + ((words[ramp] as string).length - 1) * SPLASH_FINAL_TYPE_MS
  beats.push({
    from: t,
    typedAt,
    deleteFrom: typedAt + SPLASH_HOLD_MS,
    until: typedAt + SPLASH_HOLD_MS,
  })
  return beats
}

/** Every word's turn for this game's words. */
export const SPLASH_BEATS: readonly SplashBeat[] = splashBeats(SPLASH_WORDS)

/** When Faceted Flight is typed in full, ms after the typing starts: the hold begins. */
export const SPLASH_LANDED_MS = (SPLASH_BEATS.at(-1) as SplashBeat).typedAt

/** What the blank shows at one moment: a word, and how many of its letters. */
export interface SplashFrame {
  readonly index: number
  readonly letters: number
}

/** The blank at `ms` after the typing starts. */
export const splashFrameAt = (
  ms: number,
  words: readonly string[] = SPLASH_WORDS,
  beats: readonly SplashBeat[] = words === SPLASH_WORDS ? SPLASH_BEATS : splashBeats(words),
): SplashFrame => {
  const last = beats.length - 1
  let i = 0
  while (i < last && ms >= (beats[i] as SplashBeat).until) i++
  const b = beats[i] as SplashBeat
  const word = words[i] as string
  const n = word.length
  const t = Math.max(0, ms - b.from)
  if (ms < b.typedAt)
    return { index: i, letters: Math.min(n, Math.floor((t / (b.typedAt - b.from)) * (n - 1)) + 1) }
  if (i === last || ms < b.deleteFrom) return { index: i, letters: n }
  const gone = Math.floor(((ms - b.deleteFrom) / (b.until - b.deleteFrom)) * n) + 1
  return { index: i, letters: Math.max(0, n - gone) }
}

/** The portrait, unclemattmakes.com's round mascot, on the content bucket. */
export const SPLASH_PORTRAIT_PATH = 'assets/brand/uncle-matt-circle.webp'

/** The keyboard keys that skip, by `KeyboardEvent.key`. */
export const SPLASH_SKIP_KEYS: readonly string[] = ['Enter', ' ']

/**
 * Where the bar is heading for a load state, 0..1. The terrain fraction is
 * most of the wait and fills most of the bar; assembling is the rest of the
 * build, so the bar does not sit at 100% while work is still running
 * (`load-progress.ts`'s *"a new lie replacing the old one"*).
 */
export const barTarget = (state: LoadState): number => {
  switch (state.phase) {
    case 'terrain':
      return 0.9 * state.fraction
    case 'assembling':
      return 0.95
    default:
      return 1
  }
}

/**
 * When the fade starts, ms after the splash starts, or null while it may not.
 * `loadedAt` is when the scene reported `ready`; `skippedAt` a press, which is
 * only ever recorded once loaded. Without one: loaded AND the last word landed
 * and held. With one: then.
 */
export const fadeAt = (
  loadedAt: number | null,
  skippedAt: number | null,
  landedMs: number = SPLASH_LANDED_MS,
): number | null => {
  if (loadedAt === null) return null
  if (skippedAt !== null) return Math.max(loadedAt, skippedAt)
  return Math.max(loadedAt, landedMs + SPLASH_HOLD_MS)
}

/** The splash's life, as `data-splash` on the body says it. */
export type SplashPhase = 'up' | 'fading' | 'gone'

export interface DevSplash {
  /** Feed it the load: `app.onLoadProgress`'s listener. */
  progress(state: LoadState): void
  /**
   * Is it on screen, up or fading? While it is, the game takes no confirm.
   * NOT `phase === 'up'`: see the header on the fade.
   */
  covering(): boolean
  /**
   * Settles when the fade STARTS (or at once, when there is no splash). The
   * title's curtain lifts on it, so the valley comes up as this goes.
   */
  readonly lifting: Promise<void>
}

const NO_SPLASH: DevSplash = {
  progress: () => {},
  covering: () => false,
  lifting: Promise.resolve(),
}

/** Is the standard mapping's A (button 0) down on any pad? */
const padA = (): boolean => {
  const pads = globalThis.navigator?.getGamepads?.() ?? []
  for (const pad of pads) if (pad?.buttons[0]?.pressed) return true
  return false
}

/**
 * Drive `#dev-splash` in `index.html`. It runs on every load (DEV-872); a
 * page without the element has nothing to drive. `portraitUrl` is
 * where the mascot is served (`assetUrl(SPLASH_PORTRAIT_PATH)`, from `main.ts`).
 */
export const startDevSplash = (
  root: HTMLElement | null,
  now: () => number,
  portraitUrl: string,
  config: SplashConfig = DEFAULT_SPLASH_CONFIG,
): DevSplash => {
  const words = config.words
  const beats = splashBeats(words)
  const landedMs = (beats.at(-1) as SplashBeat).typedAt
  const body = document.body
  const typed = root?.querySelector<HTMLElement>('.dev-splash__typed') ?? null
  const fill = root?.querySelector<HTMLElement>('.dev-splash__fill') ?? null
  const bar = root?.querySelector<HTMLElement>('.dev-splash__bar') ?? null
  const portrait = root?.querySelector<HTMLImageElement>('.dev-splash__portrait') ?? null
  if (root === null || typed === null || fill === null || bar === null) {
    root?.remove()
    body.dataset.splash = 'gone'
    return NO_SPLASH
  }

  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let t0 = now()
  let loadedAt: number | null = null
  let skippedAt: number | null = null
  let phase: SplashPhase = 'up'
  let target = 0
  let drawn = 0
  let last = t0
  let frame = 0
  let release = (): void => {}
  const lifting = new Promise<void>((resolve) => {
    release = resolve
  })
  body.dataset.splash = phase

  // The blank, from one frame of the schedule: the word's first `letters`
  // letters, written as text (the caret after it is CSS).
  let drawnKey = ''
  const render = (f: SplashFrame): void => {
    const key = `${f.index}:${f.letters}`
    if (key === drawnKey) return
    drawnKey = key
    const word = words[f.index] as string
    typed.textContent = word.slice(0, f.letters)
    typed.dataset.word = String(f.index)
    typed.dataset.letters = String(f.letters)
    typed.dataset.filled =
      f.index === words.length - 1 && f.letters === word.length ? 'true' : 'false'
  }
  const LANDED: SplashFrame = {
    index: words.length - 1,
    letters: (words.at(-1) as string).length,
  }
  render(reduced ? LANDED : splashFrameAt(0, words, beats))

  const skip = (): void => {
    // Only once the scene is in (Matt). Before that a press does nothing.
    if (phase !== 'up' || loadedAt === null || skippedAt !== null) return
    skippedAt = now() - t0
    render(LANDED)
  }
  // Capture phase, never consumed: `main.ts`'s first gesture rides the same
  // press, and builds the sound inside it.
  const onKey = (e: KeyboardEvent): void => {
    if (SPLASH_SKIP_KEYS.includes(e.key)) skip()
  }
  const onPointer = (): void => skip()
  globalThis.addEventListener('keydown', onKey, true)
  globalThis.addEventListener('pointerdown', onPointer, true)

  const finish = (): void => {
    globalThis.removeEventListener('keydown', onKey, true)
    globalThis.removeEventListener('pointerdown', onPointer, true)
    cancelAnimationFrame(frame)
    phase = 'gone'
    body.dataset.splash = phase
    root.remove()
    release()
  }
  const startFade = (): void => {
    if (phase !== 'up') return
    phase = 'fading'
    body.dataset.splash = phase
    root.style.transition = `opacity ${SPLASH_FADE_MS}ms ease`
    root.style.opacity = '0'
    root.style.pointerEvents = 'none'
    // Not on `transitionend`: a hidden tab runs no transitions, and a splash
    // that waited on one would stand over a loaded game for ever.
    setTimeout(finish, SPLASH_FADE_MS)
    release()
  }

  // The face and the portrait. The typing's clock starts when the lockup can
  // show in Bitter with its picture (or when it stops waiting), so its first
  // word is not spent behind an empty slot and nothing changes face or pops in
  // mid-word.
  let faced = false
  const showFace = (): void => {
    if (faced || phase === 'gone') return
    faced = true
    t0 = now()
    last = t0
    root.classList.add('is-faced')
  }
  const fonts = (document as { fonts?: { load(font: string): Promise<unknown> } }).fonts
  const faceReady = fonts
    ? fonts.load('700 1em Bitter').then(
        () => {},
        () => {},
      )
    : Promise.resolve()
  const portraitReady = new Promise<void>((resolve) => {
    if (portrait === null) return resolve()
    portrait.addEventListener('load', () => {
      portrait.classList.add('is-loaded')
      resolve()
    })
    // A portrait that cannot load leaves the wordmark on its own, never a
    // broken-image box.
    portrait.addEventListener('error', () => {
      portrait.remove()
      resolve()
    })
    portrait.src = portraitUrl
  })
  void Promise.all([faceReady, portraitReady]).then(showFace)
  setTimeout(showFace, SPLASH_FACE_WAIT_MS)

  let padWasDown = padA()
  const tick = (): void => {
    const t = now()
    const ms = t - t0
    if (phase === 'up' && faced) {
      if (!reduced && skippedAt === null) render(splashFrameAt(ms, words, beats))
      // A pad gives a page no event: read A here, on its press edge.
      const pad = padA()
      if (pad && !padWasDown) skip()
      padWasDown = pad
      const at = fadeAt(loadedAt, skippedAt, landedMs)
      if (at !== null && ms >= at) startFade()
    }
    // The bar eases toward the load rather than jumping chunk to chunk.
    const dt = Math.min(0.1, (t - last) / 1000)
    last = t
    drawn += (target - drawn) * (1 - Math.exp(-dt * 8))
    if (target - drawn < 0.002) drawn = target
    fill.style.transform = `scaleX(${drawn.toFixed(4)})`
    bar.setAttribute('aria-valuenow', String(Math.round(drawn * 100)))
    if (phase !== 'gone') frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  return {
    progress(state) {
      if (phase === 'gone') return
      if (state.phase === 'failed') {
        // The failure line has to be readable, now.
        finish()
        return
      }
      target = Math.max(target, barTarget(state))
      if (state.phase === 'ready' && loadedAt === null) {
        loadedAt = now() - t0
        // A load slower than the typing and its hold goes HERE, in the task
        // that reported it, not on the next frame: whoever reads the game's
        // own ready attribute set in this same task (a player's press, a
        // spec's) never finds the splash still up and eating it.
        if (loadedAt >= (fadeAt(loadedAt, null, landedMs) ?? Number.POSITIVE_INFINITY)) startFade()
      }
    },
    covering: () => phase !== 'gone',
    lifting,
  }
}
