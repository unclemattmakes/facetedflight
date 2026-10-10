// src/input/turn-phone.ts: a phone plays sideways. DEV-566.
//
// Matt, 2026-10-02: *"let's make it so it's landscape only in phone mode"*.
//
// So a phone held upright gets one screen, over everything: TURN YOUR PHONE.
// Nothing behind it takes input while it stands, and a live run is paused (the
// pause menu, as a lost focus opens it since DEV-563) and STAYS paused after
// the turn, until the player presses RESUME. A run that carried on by itself
// the moment the phone came round would be a run that started without its
// player.
//
// ── Which devices are a PHONE ───────────────────────────────────────────
//
// Two answers, and neither is a user agent:
//
//  1. The game's own touch mode, `capabilities.touch` (`capability-gate.ts`:
//     touch points AND a coarse primary pointer, or `?touch=`). A desktop is
//     never one, so a desktop is never asked to turn anything.
//  2. A SCREEN whose short side is under `PHONE_SHORT_SIDE_PX`. That is what
//     separates a phone from a tablet, which the touch mode does not: both are
//     glass, and Matt's rule is about the phone. 600 css px is the line every
//     platform draws between the two (Android's "compact" width class is under
//     600 dp; the smallest iPad is 744 pt across), and it is the SCREEN, not
//     the window, so a tablet in split view is still a tablet.
//
// Portrait is the VIEWPORT taller than it is wide, the same reading CSS's
// `(orientation: portrait)` makes. Square counts as upright, as it does there.
//
// ── What happens to the portrait layouts built before this row ───────────
//
// Several were built for a phone held upright (the touch row's narrow-width
// rules, DEV-290; the title's credit line at the top; the hangar's first step
// framing one table; FF-TV's portrait layer). They are left exactly as they
// are. On a phone they cannot be reached any more, because the turn screen
// stands over them; a TABLET held upright still reaches the ones keyed on
// aspect, so they are not dead code. This row deliberately sweeps none of it.
//
// ── The orientation lock, asked for and never relied on ──────────────────
//
// `screen.orientation.lock('landscape')` is the platform's own version of this
// screen, and where it works the player never sees ours. It works almost
// nowhere a link opens: Chrome on Android grants it only to a fullscreen page
// (or an installed app), iOS Safari has no `lock` at all, and every refusal is
// a rejected promise. So a phone's first press asks for fullscreen (Matt,
// 2026-10-02), the lock is asked on every entry to fullscreen (or on that
// press where fullscreen is refused or absent), every rejection is caught, and
// the turn screen is the behaviour whether the lock took or not.
//
// No three.js. The rule is plain functions a unit test reads; the DOM half
// below is the only part that needs a page, and `mobile-controls.spec.ts`
// drives it on an emulated Pixel 7.

/**
 * The short side, in css px, below which a touch screen is a PHONE.
 *
 * Not tuning: it is the platform's own phone/tablet line (see the header).
 * A Pixel 7 is 412, the largest iPhone 440; the smallest iPad is 744.
 */
export const PHONE_SHORT_SIDE_PX = 600

/** What the rule needs to know, all of it readable off a window. */
export interface TurnInputs {
  /** The game's touch mode, `capabilities.touch`. */
  readonly touch: boolean
  /** `screen.width` / `screen.height`, css px. */
  readonly screenWidth: number
  readonly screenHeight: number
  /** `innerWidth` / `innerHeight`, css px. */
  readonly viewWidth: number
  readonly viewHeight: number
}

/** A touch device whose screen is phone-sized. A tablet and a desktop are not. */
export const isPhone = (i: Pick<TurnInputs, 'touch' | 'screenWidth' | 'screenHeight'>): boolean =>
  i.touch && Math.min(i.screenWidth, i.screenHeight) < PHONE_SHORT_SIDE_PX

/** Held upright: the viewport is at least as tall as it is wide. */
export const isUpright = (i: Pick<TurnInputs, 'viewWidth' | 'viewHeight'>): boolean =>
  i.viewHeight >= i.viewWidth && i.viewWidth > 0

/** Whether the turn screen stands over the game. */
export const wantsTurnScreen = (i: TurnInputs): boolean => isPhone(i) && isUpright(i)

// ── The words, exported so the spec reads them from here ─────────────────

/** The screen's title, in the pause plate's capitals. */
export const TURN_TITLE = 'TURN YOUR PHONE'
/** The line under it, always. */
export const TURN_NOTE = 'Faceted Flight flies sideways.'
/** Added while a run is paused behind the screen, so the player knows it waits for them. */
export const TURN_PAUSED_NOTE = 'Your flight is paused.'
/**
 * DEV-595: added on a phone that has no element fullscreen and is not already
 * running from the home screen. Today that is an iPhone (Safari, and every
 * other iPhone browser, which is Safari underneath): its only route to a game
 * without the browser's bars is Add to Home Screen, which `index.html`'s
 * manifest and apple-mobile-web-app tags make launch without them.
 */
export const TURN_HOME_SCREEN_NOTE = 'Full screen: tap Share, then Add to Home Screen.'

import {
  UI_ACCENT,
  UI_DIM,
  UI_INK,
  UI_PLATE,
  UI_PLATE_EDGE,
  UI_SCRIM,
  UI_STACK,
} from '@/render/ui-tokens'

/**
 * Where the page remembers that the home-screen line has been shown. It is
 * shown on ONE page load (the first time the turn screen stands with it) and
 * never again on that phone: a hint, not a nag (the lead, relaying Matt's
 * iPhone, 2026-10-03). Storage that is absent or refused just means it shows
 * again next time, which is the harmless way to be wrong.
 */
export const HOME_HINT_STORAGE_KEY = 'ff2.homeScreenHint.seen'

/**
 * How many activated presses may ask for fullscreen before the page stops
 * asking (DEV-595). One is Matt's rule; the other two are for a press the
 * browser refused (a document not yet active, a press it did not count), so a
 * refusal is not the last word, and a browser that refuses every time is not
 * asked on every tap for ever.
 */
export const FULLSCREEN_TRIES = 3

/** The element's id, one constant so a spec and the stylesheet cannot drift. */
export const TURN_ROOT_ID = 'turn-phone'

export interface TurnScreen {
  /** The screen is standing over the game right now. Read once a frame. */
  readonly up: boolean
  /** Show the paused line (a live run is held behind the screen). */
  setPausedNote(on: boolean): void
  dispose(): void
}

/** A desktop, a tablet with no phone in it, a test: no element, never up. */
export const noTurnScreen = (): TurnScreen => ({
  up: false,
  setPausedNote: () => {},
  dispose: () => {},
})

// The pause plate's palette (`render/pause.ts`): the same panel, in DOM,
// because a canvas plate in the world cannot stand over a whole phone screen
// and stay readable at its device-pixel ratio. The ground is index.html's.
// (No backticks anywhere in this stylesheet: it is a template literal.)
const CSS = `
#${TURN_ROOT_ID} {
  position: fixed;
  inset: 0;
  z-index: 15;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(24px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px));
  background: ${UI_SCRIM};
  pointer-events: auto;
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#${TURN_ROOT_ID}[hidden] { display: none; }
#${TURN_ROOT_ID} .plate {
  width: min(320px, 100%);
  padding: 28px 20px 24px;
  border: 1px solid ${UI_PLATE_EDGE};
  border-left: 6px solid ${UI_ACCENT};
  border-radius: 0;
  background: ${UI_PLATE};
  text-align: center;
  font-family: ${UI_STACK};
  font-synthesis: none;
  text-transform: uppercase;
}
#${TURN_ROOT_ID} svg { display: block; width: 96px; height: 96px; margin: 0 auto 18px; }
#${TURN_ROOT_ID} h2 {
  margin: 0 0 10px;
  color: ${UI_ACCENT};
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
#${TURN_ROOT_ID} p {
  margin: 0;
  color: ${UI_DIM};
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}
#${TURN_ROOT_ID} p.paused { margin-top: 8px; color: ${UI_INK}; }
#${TURN_ROOT_ID} p.paused[hidden] { display: none; }
#${TURN_ROOT_ID} p.home { margin-top: 14px; color: ${UI_ACCENT}; font-size: 12px; }
#${TURN_ROOT_ID} p.home[hidden] { display: none; }
`

// A phone outline, upright and faint, and the same phone on its side in the
// accent, with the arrow that turns one into the other.
const ICON = `<svg viewBox="0 0 96 96" aria-hidden="true">
<rect x="14" y="10" width="30" height="52" rx="5" fill="none" stroke="${UI_DIM}" stroke-width="3" opacity="0.6"/>
<rect x="34" y="52" width="52" height="30" rx="5" fill="none" stroke="${UI_ACCENT}" stroke-width="3"/>
<path d="M58 14 A 26 26 0 0 1 80 38" fill="none" stroke="${UI_INK}" stroke-width="3" stroke-linecap="round"/>
<path d="M73 36 L80 40 L84 32" fill="none" stroke="${UI_INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

/** The pieces of a window the screen reads. Structural, so a test can hand in a stand-in. */
export interface TurnWindow {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly screen?: {
    readonly width: number
    readonly height: number
    readonly orientation?: { lock?(o: 'landscape'): Promise<void> }
  }
  /** `standalone` is iOS's "launched from the home screen"; `userActivation` is the spec's. */
  readonly navigator?: {
    readonly standalone?: boolean
    readonly userActivation?: { readonly isActive: boolean }
  }
  matchMedia?(query: string): { readonly matches: boolean }
  readonly visualViewport?: {
    addEventListener(type: string, fn: () => void): void
    removeEventListener(type: string, fn: () => void): void
  } | null
  requestAnimationFrame?(fn: () => void): number
  cancelAnimationFrame?(id: number): void
  /** For the home-screen line's one showing. Reading it may throw (blocked storage). */
  readonly localStorage?: Pick<Storage, 'getItem' | 'setItem'> | null
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void
}

/**
 * Ask the platform for landscape. Never awaited by anything that matters, and
 * never allowed to throw: `lock` is missing on iOS, and rejects outside
 * fullscreen on Android. Returns what happened, for the console line.
 */
export const askLandscapeLock = async (
  orientation: { lock?(o: 'landscape'): Promise<void> } | undefined,
): Promise<string> => {
  if (typeof orientation?.lock !== 'function') return 'not offered'
  try {
    await orientation.lock('landscape')
    return 'granted'
  } catch (err) {
    return `refused (${(err as { name?: string })?.name ?? 'error'})`
  }
}

/** The page can ask for element fullscreen at all. An iPhone cannot (an iPad can). */
export const offersFullscreen = (doc: Pick<Document, 'documentElement'> | null): boolean =>
  typeof (doc?.documentElement as { requestFullscreen?: unknown } | null)?.requestFullscreen ===
  'function'

/**
 * Already running without the browser's bars: launched from the home screen
 * (iOS's `navigator.standalone`, or an installed app's display mode).
 */
export const runsStandalone = (win: Pick<TurnWindow, 'navigator' | 'matchMedia'> | null): boolean =>
  win?.navigator?.standalone === true ||
  win?.matchMedia?.('(display-mode: standalone)').matches === true ||
  win?.matchMedia?.('(display-mode: fullscreen)').matches === true

/**
 * Mount the turn screen. Built only where the game is in touch mode
 * (`enabled`); whether it is a PHONE is asked live, because a folding phone
 * changes its screen when it opens.
 */
export const attachTurnScreen = (
  doc: Document | null,
  win: TurnWindow | null,
  options: { readonly enabled: boolean },
): TurnScreen => {
  if (!options.enabled || !doc?.body || !win) return noTurnScreen()

  if (!doc.getElementById(`${TURN_ROOT_ID}-style`)) {
    const style = doc.createElement('style')
    style.id = `${TURN_ROOT_ID}-style`
    style.textContent = CSS
    doc.head.appendChild(style)
  }

  const root = doc.createElement('div')
  root.id = TURN_ROOT_ID
  root.setAttribute('role', 'alertdialog')
  root.setAttribute('aria-modal', 'true')
  root.hidden = true
  const plate = doc.createElement('div')
  plate.className = 'plate'
  plate.innerHTML = ICON
  const title = doc.createElement('h2')
  title.textContent = TURN_TITLE
  const note = doc.createElement('p')
  note.textContent = TURN_NOTE
  const paused = doc.createElement('p')
  paused.className = 'paused'
  paused.textContent = TURN_PAUSED_NOTE
  paused.hidden = true
  // DEV-595: the one line an iPhone player can act on. Decided once at mount
  // for the PLATFORM (no element fullscreen, not from the home screen) and for
  // this phone's history (never shown before), and shown only while this is a
  // phone, which is asked live in `update`.
  const home = doc.createElement('p')
  home.className = 'home'
  home.textContent = TURN_HOME_SCREEN_NOTE
  home.hidden = true
  const hintSeen = (): boolean => {
    try {
      return win.localStorage?.getItem(HOME_HINT_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  }
  const homeRoute = !offersFullscreen(doc) && !runsStandalone(win)
  let homeRecorded = false
  plate.append(title, note, paused, home)
  root.appendChild(plate)
  root.setAttribute('aria-labelledby', `${TURN_ROOT_ID}-title`)
  title.id = `${TURN_ROOT_ID}-title`
  // Last in the body, so it is over everything that does not set a higher
  // z-index (the boot-failure line does, on purpose: a page that cannot boot
  // says so even to a phone held upright).
  doc.body.appendChild(root)

  // ── nothing behind it takes input ─────────────────────────────────────
  //
  // A finger lands on this element, which covers the glass, so the touch
  // controls (z-index 1) and the canvas never see it. A KEY has no position to
  // be covered at, so it is stopped here, in the capture phase on the window,
  // before the keyboard reader or a menu's own listener. Only the press: a
  // key RELEASE goes through, or a key held while the phone turned would stay
  // down in `keyboard.ts` for ever. (Pads are held off in `gamepad.ts`.)
  const swallowKey = (e: Event) => {
    if (!root.hidden) e.stopPropagation()
  }
  // And nothing a finger does on it becomes a scroll, a zoom or a click.
  const swallowPointer = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'contextmenu']) {
    root.addEventListener(type, swallowPointer)
  }

  const read = (): boolean =>
    wantsTurnScreen({
      touch: true,
      screenWidth: win.screen?.width ?? win.innerWidth,
      screenHeight: win.screen?.height ?? win.innerHeight,
      viewWidth: win.innerWidth,
      viewHeight: win.innerHeight,
    })
  // `data-turn-phone` on the body says which way round the screen is, for a
  // spec to wait on and for anyone reading the page: set on mount, so a phone
  // that boots in landscape reads `down` rather than nothing.
  doc.body.dataset.turnPhone = 'down'
  const phoneNow = (): boolean =>
    isPhone({
      touch: true,
      screenWidth: win.screen?.width ?? 0,
      screenHeight: win.screen?.height ?? 0,
    })
  const update = () => {
    // DEV-795: the flag is read live, so a hint the title's credit line already
    // gave (`input/title-home-hint.ts`) is not given again here; one this screen
    // is showing stays for the page.
    const wantHome = homeRoute && phoneNow() && (homeRecorded || !hintSeen())
    if (home.hidden === wantHome) home.hidden = !wantHome
    const up = read()
    // The first time the line is actually in front of the player, remember it:
    // it stays for this page, and the next load does not show it.
    if (up && wantHome && !homeRecorded) {
      homeRecorded = true
      try {
        win.localStorage?.setItem(HOME_HINT_STORAGE_KEY, '1')
      } catch {
        // Refused storage: it shows again next load, which is harmless.
      }
    }
    if (up === !root.hidden) return
    root.hidden = !up
    doc.body.dataset.turnPhone = up ? 'up' : 'down'
    console.info(`turn screen: ${up ? 'UP (a phone held upright)' : 'down'}`)
  }

  // DEV-595: iOS Safari can report the pre-turn `innerWidth` / `innerHeight`
  // inside `orientationchange` (and in a `resize` sent ahead of its layout),
  // with no second event once the numbers are right. So every event that can
  // turn the page is read now AND on the next two animation frames, and the
  // visual viewport's `resize` is one of them. (`render/canvas-fit.ts` does
  // the same for the picture.)
  let frame: number | null = null
  let framesLeft = 0
  const follow = () => {
    frame = null
    update()
    framesLeft -= 1
    if (framesLeft > 0 && win.requestAnimationFrame) frame = win.requestAnimationFrame(follow)
  }
  const settle = () => {
    update()
    framesLeft = 2
    if (frame === null && win.requestAnimationFrame) frame = win.requestAnimationFrame(follow)
  }

  // The lock: on the first press (a page with no activation is refused by
  // every browser that has the call), and on every entry to fullscreen.
  const ask = (why: string) => {
    if (!phoneNow()) return
    void askLandscapeLock(win.screen?.orientation).then((how) =>
      console.info(`orientation lock (${why}): ${how}`),
    )
  }
  // Matt, 2026-10-02 (*"sure"*, to fullscreen on a phone's first tap): the
  // first press on a phone also asks for fullscreen, the one state in which
  // Android Chrome grants the lock. The lock is then asked by `onFullscreen`.
  // Where the page cannot go fullscreen (an iPhone has no element fullscreen)
  // the lock is asked on that press as before, and the turn screen stays the
  // behaviour.
  //
  // DEV-595 (Matt, on his phone: *"doesn't go into full screen"*). What the
  // first version did not do:
  //
  //  - It spent its one chance on the first `pointerup` of any kind. A
  //    `pointerup` is a user activation only from a touch or a pen, and a touch
  //    the browser takes for a pan ends in `pointercancel`, not `pointerup`. So
  //    `touchend` (also an activation) is listened for too, and only a press
  //    the browser says IS an activation (`navigator.userActivation.isActive`,
  //    where it has one) is spent.
  //  - A refusal was final. A later press may ask again, up to
  //    `FULLSCREEN_TRIES` in all. A grant ends the asking, so a player who
  //    leaves fullscreen is not pulled back into it.
  //  - It said nothing to an iPhone, which has no element fullscreen at all.
  //    The turn screen now carries `TURN_HOME_SCREEN_NOTE` there (above).
  let tries = 0
  let pending = false
  let granted = false
  let lockAsked = false
  const askLockOnce = () => {
    if (lockAsked) return
    lockAsked = true
    ask('first press')
  }
  const activated = (): boolean => win.navigator?.userActivation?.isActive ?? true
  const onPress = () => {
    if (granted || pending || tries >= FULLSCREEN_TRIES || !activated()) return
    // A tablet or a desktop is never asked, now or later.
    if (!phoneNow()) {
      tries = FULLSCREEN_TRIES
      return
    }
    tries += 1
    if (doc.fullscreenElement) {
      granted = true
      return
    }
    const el = doc.documentElement as
      | (HTMLElement & { requestFullscreen?: HTMLElement['requestFullscreen'] })
      | null
    if (typeof el?.requestFullscreen !== 'function') {
      // No fullscreen to ask for (an iPhone): the lock once, and done.
      tries = FULLSCREEN_TRIES
      askLockOnce()
      return
    }
    pending = true
    el.requestFullscreen({ navigationUI: 'hide' }).then(
      () => {
        pending = false
        granted = true
        console.info(`fullscreen (press ${tries}): granted`)
      },
      (err: unknown) => {
        pending = false
        console.info(
          `fullscreen (press ${tries} of ${FULLSCREEN_TRIES}): refused (${(err as { name?: string })?.name ?? 'error'})`,
        )
        askLockOnce()
      },
    )
  }
  const onFullscreen = () => {
    if (doc.fullscreenElement) ask('fullscreen')
  }

  win.addEventListener('keydown', swallowKey, true)
  win.addEventListener('keypress', swallowKey, true)
  win.addEventListener('resize', settle)
  win.addEventListener('orientationchange', settle)
  win.visualViewport?.addEventListener('resize', settle)
  win.addEventListener('pointerup', onPress, true)
  win.addEventListener('touchend', onPress, true)
  doc.addEventListener('fullscreenchange', onFullscreen)
  update()

  return {
    get up() {
      return !root.hidden
    },
    setPausedNote(on: boolean) {
      // Called every frame; the DOM is written only when the answer changes.
      if (paused.hidden === on) paused.hidden = !on
    },
    dispose() {
      win.removeEventListener('keydown', swallowKey, true)
      win.removeEventListener('keypress', swallowKey, true)
      win.removeEventListener('resize', settle)
      win.removeEventListener('orientationchange', settle)
      win.visualViewport?.removeEventListener('resize', settle)
      if (frame !== null) win.cancelAnimationFrame?.(frame)
      win.removeEventListener('pointerup', onPress, true)
      win.removeEventListener('touchend', onPress, true)
      doc.removeEventListener('fullscreenchange', onFullscreen)
      root.remove()
      delete doc.body.dataset.turnPhone
    },
  }
}
