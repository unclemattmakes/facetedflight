/**
 * tests/e2e/fixtures/landing.ts: arriving, the way a player does now. DEV-557.
 *
 * ── What this replaces ──────────────────────────────────────────────────
 *
 * Until DEV-557 every spec started with `page.locator('#start').click()`: the
 * landing card's Start button. That one line did three things, and a spec
 * leaned on all of them without saying so:
 *
 *  1. It WAITED: Playwright's click waits for the button to be enabled, and
 *     the button enabled when the load reached `ready` (or `failed`).
 *  2. It took the card off the canvas, so a later click could land.
 *  3. It was the page's first USER GESTURE: `reveal()` built the AudioContext
 *     inside it, and a `?tv` or `?watch=` link boards only after it.
 *
 * Matt, 2026-10-01: *"let's get rid of the html curtain."* So there is no card
 * to take away (2), and what is left is what a PLAYER does: the page loads,
 * they see the title (or, under a dev switch like `?mission=`, the course),
 * and they press something. `firstPress` is that, and it never asks the game
 * for a different path: the wait reads `data-load`, the same fact the button's
 * `disabled` carried, and the press is a real keydown (or a real tap).
 *
 * ── Which press, and why it is a KEY ────────────────────────────────────
 *
 * `FIRST_KEY`, a key the game binds to nothing (`input/keyboard.ts` has no
 * T, and neither does `boot/app.ts`; the letter plate types it, and that plate
 * is never up at boot). So the press is the page's first user activation and
 * nothing else, which is exactly what the card's Start click was to the game.
 *
 * Not a click on the canvas, which was the first version and cost a spec: on
 * the title a click on the world is the mouse-look CAPTURE (DEV-418), and the
 * lock and its release hand the look a pixel or two of movement. That left the
 * title's camera 0.14 degrees off, and the hangar's seat a fraction of a notch
 * further round, which `menu-light-compile.spec.ts` (which walks the hangar by
 * notches) failed on every time, and passed on every time without the click.
 * A player's mouse moves anyway; a harness's first press should not.
 *
 * On the title this still waits for the rows first: BEFORE they are up, over
 * the emblem on black, a press is a real press that leaves for the hangar
 * (DEV-301), and while that is not true of T, a spec that moves on from here
 * expects the title it would see.
 *
 * On a touch device (`tap: true`) it is a tap on the glass at the centre,
 * which on the title picks no row and is not a capture.
 */
import { expect, type Page } from '@playwright/test'
import { bootWorld, splashGone } from './boot'
import { CANVAS, releasePointer } from './canvas'
import { titleMenu, titleRowsUp } from './title'

/** The terrain generator's budget on a cold cache, as `fixtures/boot.ts` has it. */
const LOAD_TIMEOUT = 240_000

/**
 * The load the page booted is in: `ready`, or `failed` (which shows its own
 * message, `#boot-failure`). The fact the card's Start button used to carry in
 * its `disabled`.
 */
export const loadSettled = async (page: Page, timeout = LOAD_TIMEOUT): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-load', /^(ready|failed)$/, { timeout })
}

export interface FirstPressOptions {
  /** How long the load may take. */
  readonly timeout?: number
  /** A finger rather than a mouse: a phone's first touch. */
  readonly tap?: boolean
}

/**
 * The player's first input, once the page is ready for one: a key (or a
 * tap). Resolves once the page has had its gesture
 * (`data-first-input`, which `main.ts` sets beside `reveal()`).
 */
export const firstPress = async (page: Page, options: FirstPressOptions = {}): Promise<void> => {
  await loadSettled(page, options.timeout ?? LOAD_TIMEOUT)
  // DEV-872: the developer splash is gone before anything is pressed. A press made inside its
  // hold (or its fade) is swallowed as the skip, so a first press, or the START that follows
  // it, would otherwise land on a title that never left. `bootReady` does the same for the
  // specs that wait by hand; doing it here covers every spec that goes through `firstPress`.
  await splashGone(page)
  if ((await bootWorld(page)) === 'title') await titleRowsUp(page)
  if (options.tap) {
    const box = await page.locator(CANVAS).boundingBox()
    if (!box) throw new Error('firstPress: the canvas has no box')
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  } else {
    // Held for a frame, as every key here is (`fixtures/hangar.ts`'s `hold`).
    await page.keyboard.down(FIRST_KEY)
    await page.waitForTimeout(120)
    await page.keyboard.up(FIRST_KEY)
  }
  await expect(page.locator('body')).toHaveAttribute('data-first-input', 'true')
}

/** The first press: a key nothing in the game is bound to. See the header. */
export const FIRST_KEY = 'KeyT'

/** `__ff2.titleMenu().vr`, the title's ENTER VR (a row under START since DEV-558). */
export interface TitleVrProbe {
  shown: boolean
  state: string
  label: string
  note: string
  aimed: boolean
  at: { x: number; y: number } | null
}

export const titleVr = async (page: Page): Promise<TitleVrProbe | null> =>
  ((await titleMenu(page)) as unknown as { vr?: TitleVrProbe } | null)?.vr ?? null

/**
 * Put the headset on, the way a player does from where the page is.
 *
 * On the title: CLICK the ENTER VR row, once it says a headset is there (a
 * plate beside the rows until DEV-558). Anywhere else (a `?mission=` boot has
 * no title): press H, the row's key hint, which works from any flat screen.
 * Both are a real click or keydown, which is the transient activation
 * `requestSession` needs. Returns once the click or key has been given; the
 * caller waits on what it expects (presenting, or the browser's refusal).
 * Since DEV-558 a session asked for ON THE TITLE goes on to the hangar's first
 * step (Matt: *"Clicking either should take us to the Hangar"*).
 */
export const enterVr = async (page: Page, timeout = LOAD_TIMEOUT): Promise<void> => {
  await loadSettled(page, timeout)
  if ((await bootWorld(page)) === 'title') {
    await titleRowsUp(page)
    await expect
      .poll(async () => (await titleVr(page))?.state ?? null, {
        message: 'the title says a headset is there (ENTER VR, not CONNECT VR HEADSET)',
        timeout: 60_000,
      })
      .toBe('enter')
    const vr = (await titleVr(page)) as TitleVrProbe
    expect(vr.shown, 'the ENTER VR plate is drawn').toBe(true)
    // DEV-872: the rows come up at the splash fade's START, and a click inside the fade
    // is the splash's, so wait it out before pressing (`splashGone`'s header).
    await splashGone(page)
    const at = vr.at as { x: number; y: number }
    await page.mouse.click(at.x, at.y)
    await releasePointer(page)
    return
  }
  // Held, not tapped: the game reads keys once a frame (`fixtures/hangar.ts`'s `hold`).
  await page.keyboard.down('KeyH')
  await page.waitForTimeout(200)
  await page.keyboard.up('KeyH')
}
