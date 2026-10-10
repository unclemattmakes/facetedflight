// src/input/title-home-hint.ts: the Add to Home Screen line, on the title's
// credit line, once per device. DEV-795.
//
// DEV-595 gave an iPhone player one line they can act on (an iPhone has no
// element fullscreen; Add to Home Screen is its only route to a game without
// Safari's bars): *Full screen: tap Share, then Add to Home Screen.*, on the
// TURN YOUR PHONE screen, once. A player who opened the link already sideways
// never meets that screen and never reads the line. Matt, 2026-10-07 ("go with
// your recs", QUESTIONS item 21): the line also shows once on the title's credit
// line (`#title-line`), for them.
//
// ONE hint per device, whichever place shows it first: both read and write the
// turn screen's own flag (`HOME_HINT_STORAGE_KEY`), so a player the turn screen
// has told is not told again here, and the turn screen reads the flag live, so
// one the title has told is not told there. The conditions are the turn
// screen's (a phone, no element fullscreen, not already launched from the home
// screen), asked of the same functions.
//
// The line REPLACES the credit text for a few seconds and then puts it back:
// the credit line is one line at 12 px inside the safe areas, and both strings
// side by side would not fit a phone's width. It stands in the credit line's
// own style, and is only ever on screen while the title is up and the turn
// screen is not.
//
// No three.js, no globals: the page, the window and the storage are handed in,
// so a unit test drives it in node.

import { readFlagKey, safeLocalStorage } from '@/game/storage'
import {
  HOME_HINT_STORAGE_KEY,
  isPhone,
  offersFullscreen,
  runsStandalone,
  TURN_HOME_SCREEN_NOTE,
  type TurnWindow,
} from '@/input/turn-phone'

/** How long the hint stands in the credit line, milliseconds. A line to read once, not a banner. */
export const TITLE_HOME_HINT_MS = 8000

export interface TitleHomeHint {
  /**
   * Once a frame. `titleUp`: the title's rows are up; `turnUp`: the turn
   * screen stands over the game (it shows the same line itself).
   */
  frame(titleUp: boolean, turnUp: boolean, nowMs: number): void
  /** The hint has been shown, or can never be: nothing more to do. */
  readonly done: boolean
}

export interface TitleHomeHintOptions {
  /** The credit line's element: only its `textContent` is touched. */
  readonly line: { textContent: string | null }
  readonly doc: Pick<Document, 'documentElement'> | null
  readonly win: TurnWindow | null
  /** The game's touch mode, as `attachTurnScreen` is told it. */
  readonly enabled: boolean
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export const createTitleHomeHint = (o: TitleHomeHintOptions): TitleHomeHint => {
  const storage = o.storage === undefined ? safeLocalStorage() : o.storage
  let done = false
  let showing = false
  let startedAt = 0
  let original: string | null = null

  const due = (): boolean =>
    o.enabled &&
    isPhone({
      touch: true,
      screenWidth: o.win?.screen?.width ?? 0,
      screenHeight: o.win?.screen?.height ?? 0,
    }) &&
    !offersFullscreen(o.doc) &&
    !runsStandalone(o.win) &&
    !readFlagKey(storage, HOME_HINT_STORAGE_KEY)

  const restore = (): void => {
    o.line.textContent = original
    showing = false
    done = true
  }

  return {
    get done() {
      return done
    },
    frame(titleUp, turnUp, nowMs) {
      if (done) return
      if (!showing) {
        if (!titleUp || turnUp) return
        if (!due()) {
          done = true
          return
        }
        original = o.line.textContent
        o.line.textContent = TURN_HOME_SCREEN_NOTE
        showing = true
        startedAt = nowMs
        try {
          storage?.setItem(HOME_HINT_STORAGE_KEY, '1')
        } catch {
          // Refused storage: it shows again next load, which is harmless.
        }
        return
      }
      // Shown: until its time is up, or the title or the turn screen takes over.
      if (nowMs - startedAt >= TITLE_HOME_HINT_MS || !titleUp || turnUp) restore()
    },
  }
}
