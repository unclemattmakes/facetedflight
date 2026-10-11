// src/input/home-screen-guide.ts: "add Faceted Flight to your home screen". DEV-842.
//
// Matt, 2026-10-08 (QUESTIONS item 3, phones work): the full-screen experience
// comes from adding the game to the home screen, with quick instructions. A phone
// browser keeps its address and tool bars on screen; a page launched from the
// home screen does not. DEV-595 and DEV-795 gave an iPhone one line for this (the
// turn screen's, and the title's credit line). This is the whole card, for every
// phone: the sentence, then the steps for iOS and for Android, because the page
// cannot tell which of the browsers on a phone it is in well enough to hide the
// other half (an iPhone's Chrome is Safari underneath and Android's Samsung
// Internet is neither).
//
// Shown on the TITLE, once the title's rows are up, on a PHONE (the game's touch
// mode and a screen whose short side is under `PHONE_SHORT_SIDE_PX`) that is NOT
// already running from the home screen (`navigator.standalone`, or an installed
// app's `display-mode: standalone`, or `fullscreen`). Never on a desktop, never
// on a tablet, never in an XR session (a DOM card is invisible in a headset, and
// the frame loop passes `titleUp` false while one is presenting).
//
// It never blocks the title: it opens as one chip, PLAY FULL SCREEN, in the top
// right corner, clear of everything the phone's title shows (DEV-902; the open
// card at the top left covered half the emblem and the rows on a 667 px phone,
// photographed). A tap opens the card, and the card is click-through except its
// two buttons: GOT IT, which dismisses it for good, and LATER, which folds it
// back to the chip.
//
// Dismissable, and remembered: closing it writes `GUIDE_STORAGE_KEY` and the card
// never comes back on that phone. It also writes the older hint's flag
// (`HOME_HINT_STORAGE_KEY`), so a player who has read this card is not told the
// shorter version of the same thing on the turn screen or the credit line. Storage
// that is refused only means it shows again next load.
//
// No three.js. The page, the window and the storage are handed in so a unit test
// drives it in node with a stand-in document.

import { readFlagKey, safeLocalStorage } from '@/game/storage'
import { HOME_HINT_STORAGE_KEY, isPhone, runsStandalone, type TurnWindow } from '@/input/turn-phone'
import { UI_ACCENT, UI_DIM, UI_INK, UI_PLATE, UI_PLATE_EDGE, UI_STACK } from '@/render/ui-tokens'

/** Where the page remembers the card was dismissed. */
export const GUIDE_STORAGE_KEY = 'ff2.homeScreenGuide.dismissed'

export const GUIDE_ROOT_ID = 'home-screen-guide'

export const GUIDE_TITLE = 'GET THE FULL-SCREEN EXPERIENCE'
export const GUIDE_LEAD =
  'To get the full-screen experience, add Faceted Flight to your home screen.'
export const GUIDE_IOS_HEAD = 'iPhone'
export const GUIDE_IOS_STEPS: readonly string[] = [
  'Tap the Share button.',
  'Tap Add to Home Screen.',
]
export const GUIDE_ANDROID_HEAD = 'Android'
export const GUIDE_ANDROID_STEPS: readonly string[] = [
  'Open the browser menu.',
  'Tap Install app, or Add to Home screen.',
]
export const GUIDE_DISMISS = 'GOT IT'
/** DEV-902: the chip the card folds into on the title, and the card's button that folds it. */
export const GUIDE_CHIP = 'PLAY FULL SCREEN'
export const GUIDE_HIDE = 'LATER'

export interface HomeScreenGuideOptions {
  readonly doc: Document | null
  readonly win: TurnWindow | null
  /** The game's touch mode, `capabilities.touch`. */
  readonly enabled: boolean
  /** Undefined reads `localStorage` (wrapped); null is no storage at all. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export interface HomeScreenGuide {
  /**
   * Once a frame. `titleUp`: the title's rows are up on a flat screen (false
   * in an XR session); `turnUp`: the turn screen stands over the game.
   */
  frame(titleUp: boolean, turnUp: boolean): void
  /** The card is on screen right now. */
  readonly showing: boolean
  dismiss(): void
  dispose(): void
}

/** A desktop, a tablet, a test with no page: nothing to show. */
export const noHomeScreenGuide = (): HomeScreenGuide => ({
  frame: () => {},
  showing: false,
  dismiss: () => {},
  dispose: () => {},
})

/**
 * Whether this window is a phone browser that has not been launched from the
 * home screen. The platform half of "show it"; the history half (dismissed
 * before) is the storage's.
 */
export const guideApplies = (
  win: Pick<TurnWindow, 'screen' | 'navigator' | 'matchMedia'> | null,
  touch: boolean,
): boolean =>
  win !== null &&
  isPhone({
    touch,
    screenWidth: win.screen?.width ?? 0,
    screenHeight: win.screen?.height ?? 0,
  }) &&
  !runsStandalone(win)

const CSS = `
#${GUIDE_ROOT_ID} {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 14;
  max-width: min(420px, 60vw);
  padding: calc(8px + env(safe-area-inset-top, 0px)) calc(8px + env(safe-area-inset-right, 0px)) 8px 8px;
  pointer-events: none;
  font-family: ${UI_STACK};
}
#${GUIDE_ROOT_ID}[hidden] { display: none; }
#${GUIDE_ROOT_ID}:not(.open) .card { display: none; }
#${GUIDE_ROOT_ID}.open .chip { display: none; }
#${GUIDE_ROOT_ID} .chip {
  display: block;
  margin: 0 0 0 auto;
  font-size: 13px;
  border-left: 6px solid ${UI_ACCENT};
  background: ${UI_PLATE};
}
#${GUIDE_ROOT_ID} .card {
  pointer-events: none;
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
  border: 1px solid ${UI_PLATE_EDGE};
  border-left: 6px solid ${UI_ACCENT};
  background: ${UI_PLATE};
  color: ${UI_DIM};
  font-size: 13px;
  line-height: 1.4;
}
#${GUIDE_ROOT_ID} h2 { margin: 0 0 4px; color: ${UI_ACCENT}; font-size: 14px; letter-spacing: 0.06em; }
#${GUIDE_ROOT_ID} p { margin: 0 0 6px; color: ${UI_INK}; }
#${GUIDE_ROOT_ID} .cols { display: flex; gap: 16px; }
#${GUIDE_ROOT_ID} .col { flex: 1 1 0; min-width: 0; }
#${GUIDE_ROOT_ID} h3 { margin: 0 0 2px; color: ${UI_INK}; font-size: 12px; letter-spacing: 0.05em; }
#${GUIDE_ROOT_ID} ol { margin: 0; padding-left: 18px; }
#${GUIDE_ROOT_ID} button {
  pointer-events: auto;
  margin-top: 6px;
  min-height: 32px;
  padding: 0 16px;
  border: 1px solid ${UI_ACCENT};
  background: transparent;
  color: ${UI_ACCENT};
  font: inherit;
  font-weight: 700;
  letter-spacing: 0.06em;
}
#${GUIDE_ROOT_ID} .card button + button { margin-left: 8px; }
`

export const createHomeScreenGuide = (o: HomeScreenGuideOptions): HomeScreenGuide => {
  const { doc, win } = o
  if (!o.enabled || !doc?.body || !win) return noHomeScreenGuide()
  const storage = o.storage === undefined ? safeLocalStorage() : o.storage

  let root: HTMLElement | null = null
  let finished = false

  const remember = (): void => {
    try {
      storage?.setItem(GUIDE_STORAGE_KEY, '1')
      storage?.setItem(HOME_HINT_STORAGE_KEY, '1')
    } catch {
      // Refused storage: it shows again next load, which is the harmless way to be wrong.
    }
  }

  const build = (): HTMLElement => {
    if (!doc.getElementById(`${GUIDE_ROOT_ID}-style`)) {
      const style = doc.createElement('style')
      style.id = `${GUIDE_ROOT_ID}-style`
      style.textContent = CSS
      doc.head.appendChild(style)
    }
    const el = doc.createElement('div')
    el.id = GUIDE_ROOT_ID
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', GUIDE_TITLE)
    const card = doc.createElement('div')
    card.className = 'card'
    const title = doc.createElement('h2')
    title.textContent = GUIDE_TITLE
    const lead = doc.createElement('p')
    lead.textContent = GUIDE_LEAD
    const cols = doc.createElement('div')
    cols.className = 'cols'
    const column = (head: string, steps: readonly string[]): HTMLElement => {
      const col = doc.createElement('div')
      col.className = 'col'
      const h = doc.createElement('h3')
      h.textContent = head
      const ol = doc.createElement('ol')
      for (const step of steps) {
        const li = doc.createElement('li')
        li.textContent = step
        ol.appendChild(li)
      }
      col.append(h, ol)
      return col
    }
    cols.append(
      column(GUIDE_IOS_HEAD, GUIDE_IOS_STEPS),
      column(GUIDE_ANDROID_HEAD, GUIDE_ANDROID_STEPS),
    )
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = GUIDE_DISMISS
    button.addEventListener('click', () => api.dismiss())
    // DEV-902: the card folds back to its chip, for a player who wants it later.
    const hide = doc.createElement('button')
    hide.type = 'button'
    hide.textContent = GUIDE_HIDE
    hide.addEventListener('click', () => {
      el.className = ''
    })
    card.append(title, lead, cols, button, hide)
    // DEV-902: closed, the card is one chip in the corner; a tap opens it.
    const chip = doc.createElement('button')
    chip.type = 'button'
    chip.className = 'chip'
    chip.textContent = GUIDE_CHIP
    chip.addEventListener('click', () => {
      el.className = 'open'
    })
    el.append(chip, card)
    doc.body.appendChild(el)
    return el
  }

  const api: HomeScreenGuide = {
    get showing() {
      return root !== null && !root.hidden
    },
    frame(titleUp, turnUp) {
      if (finished) return
      if (root === null) {
        if (!titleUp || turnUp) return
        // Decided once, on the first frame the title is up: the platform and
        // this phone's history do not change under a page.
        if (!guideApplies(win, true) || readFlagKey(storage, GUIDE_STORAGE_KEY)) {
          finished = true
          return
        }
        root = build()
        return
      }
      // Shown: it yields to the turn screen and to anything that takes the
      // title away (a mission, a session), and comes back with the title.
      root.hidden = !titleUp || turnUp
    },
    dismiss() {
      if (finished) return
      finished = true
      remember()
      root?.remove()
      root = null
    },
    dispose() {
      finished = true
      root?.remove()
      root = null
    },
  }
  return api
}
