/**
 * tests/e2e/fixtures/canvas.ts — clicking the game canvas, and letting go of
 * the pointer afterwards.
 *
 * ── The thing this exists for ────────────────────────────────────────────
 *
 * Clicking `#viewport` captures the pointer: `input/look.ts` requests Pointer
 * Lock on that click, because click-to-capture and Escape-to-release is what
 * every mouse-look page on the web does and what the API was built for.
 *
 * **While the pointer is captured, the canvas receives every mouse event and
 * nothing else on the page is clickable.** That is not a browser quirk or a
 * Playwright limitation — it is what pointer lock means, and it is true for a
 * player too. Chrome says so in as many words, and a spec that ignores it gets
 * this, forever, until the test times out five minutes later:
 *
 *     performing click action
 *     <canvas id="viewport"> intercepts pointer events
 *     retrying click action
 *
 * Measured, when the capture first landed: `lookdev.spec.ts` failed two runs in
 * three and the whole suite went from 1.7 minutes to nine.
 *
 * ── Why the fix is HERE and not in the game ──────────────────────────────
 *
 * The tempting fix is a switch — `?pointerlock=0` — that makes the game skip
 * the capture under test. **Do not.** It would mean the tested path and the
 * played path are different code, and this project has already paid that bill
 * once: the first build anyone wore reached a pink sky and nothing else,
 * because `VITE_ASSET_BASE_URL` was set by Playwright's config and by no human
 * being. *The one path nobody runs is the one a human uses.*
 *
 * So the game keeps its capture, and the HARNESS does what a player does: press
 * Escape. `document.exitPointerLock()` is the same release the browser performs
 * on Escape, and it needs no user gesture, so a spec can call it.
 *
 * **Since DEV-563 the game ANSWERS that Escape**: a capture let go in a live
 * mission opens the pause menu, because that release is the only form a
 * player's captured Escape takes. So `releasePointer` closes a menu its own
 * release opened, with the second Escape a player would press, and a spec that
 * wants the menu calls `dropPointer`. Do not reach for Playwright's
 * `keyboard.press('Escape')` to stand in for the first one: CDP delivers it to
 * the page as a keydown and the capture survives, which is not what Chrome
 * does with a real key (measured 2026-10-01; `tests/unit/escape-pause.test.ts`).
 *
 * ── Which one to use ─────────────────────────────────────────────────────
 *
 * `focusCanvas` for almost everything — specs click the canvas to put keyboard
 * focus somewhere sensible, not because they want mouse-look, and a spec that
 * touches any DOM afterwards (the lookdev panel, the landing overlay) MUST NOT
 * be holding the pointer.
 *
 * `captureCanvas` only when the locked state is the thing under test. There is
 * exactly one such spec — `mouse-look.spec.ts` — and it is worth having,
 * because `page.mouse.move()` does deliver `movementX/Y` while locked, so the
 * real control can be driven end to end rather than only unit-tested.
 *
 * `dropFocus` where the canvas must not be clicked at all. See below.
 *
 * ── A CLICK IS A BUTTON PRESS NOW, and why these still work (DEV-301) ────
 *
 * Since DEV-301 the mouse is a fifth aimer: while the pointer is captured, a
 * click on the canvas rides the same `confirm` as A, Enter and the XR trigger,
 * and selects whatever the gaze or the nose pointer is on.
 *
 * **The click that CAPTURES the pointer is spent on the capture and presses
 * nothing**, which is exactly why `focusCanvas` still means what it always
 * meant: it clicks from a released state, so it buys the pointer, hands it
 * straight back, and no button is pressed. Every one of its call sites is
 * unchanged by that feature, and that is a property of the design rather than
 * luck — `input/look.ts`'s `readClick` is where it is written down.
 *
 * The TITLE SCREEN is the one place that is not quite that (DEV-418, which
 * replaced DEV-301's "the title never captures"). Before its rows are up — the
 * emblem on black (the landing card too, until DEV-557) - there is no capture there and a click is
 * a real press that leaves for the hangar. Once they are up it looks around
 * like the hangar: a click on the WORLD is the capture and presses nothing,
 * but a click that lands ON one of its rows is a press of that row. So
 * `focusCanvas` on the title presses something or nothing depending on WHERE
 * the canvas's centre falls and WHEN the rows came up. A spec that wants the
 * title to stay up wants `dropFocus`, which clicks nothing at all.
 *
 * **And the HANGAR, since DEV-604.** A click from the free cursor that lands ON
 * a table, a difficulty mark or a floor plate aims the room through it and
 * presses it, as on the title; a click on the floor, the walls or the air is
 * the capture, as before. At rest a table stands under the canvas's centre, so
 * `focusCanvas` in the hangar PRESSES that table. Use `dropFocus` there too.
 */
import type { Page } from '@playwright/test'

/** The game canvas. One selector, so a rename is one edit. */
export const CANVAS = '#viewport'

/**
 * Click the canvas for focus, then give the pointer straight back.
 *
 * The click still runs the game's real capture — nothing is stubbed, and the
 * code path under test is the one a player takes. This is only the Escape that
 * follows.
 */
export const focusCanvas = async (page: Page): Promise<void> => {
  await page.locator(CANVAS).click()
  await releasePointer(page)
}

/**
 * Click the canvas at a VIEWPORT point (CSS pixels), then give the pointer back.
 *
 * DEV-469, for the course editor, where a click is a tool: it places a point
 * on the ground under the cursor or picks the handle there, so WHERE matters.
 * The editor asks the mouse-look to stand down while it is up, so nothing is
 * captured; the release is here anyway, so the helper means the same thing on
 * any screen.
 */
export const clickCanvasAt = async (page: Page, x: number, y: number): Promise<void> => {
  const box = await page.locator(CANVAS).boundingBox()
  if (!box) throw new Error('clickCanvasAt: the canvas has no box')
  await page.locator(CANVAS).click({ position: { x: x - box.x, y: y - box.y } })
  await releasePointer(page)
}

/**
 * Move the mouse over the canvas to a VIEWPORT point (CSS pixels), pressing
 * nothing: a HOVER. DEV-472, for the course editor's gizmo, whose arrows light
 * under the cursor. A real `pointermove`, as a mouse sends it.
 */
export const hoverCanvasAt = async (page: Page, x: number, y: number): Promise<void> => {
  await page.mouse.move(x, y, { steps: 4 })
}

/** The keys a drag may hold, as Playwright names them. */
export type DragModifier = 'Shift' | 'Alt' | 'Control'

/**
 * A DRAG on the canvas with real pointer events: hover to `from`, press
 * `button` (holding `modifiers`), move to `to` in `steps`, release — the
 * gesture a hand makes, never a call into what the gesture drives. DEV-472:
 * the editor's gizmo and its Maya/UE camera. Gives the pointer back after, as
 * `clickCanvasAt` does.
 */
export const dragCanvas = async (
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: {
    button?: 'left' | 'middle' | 'right'
    modifiers?: DragModifier[]
    steps?: number
  } = {},
): Promise<void> => {
  const button = options.button ?? 'left'
  const modifiers = options.modifiers ?? []
  await page.mouse.move(from.x, from.y, { steps: 4 })
  for (const m of modifiers) await page.keyboard.down(m)
  try {
    await page.mouse.down({ button })
    await page.mouse.move(to.x, to.y, { steps: options.steps ?? 12 })
    await page.mouse.up({ button })
  } finally {
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m)
  }
  await releasePointer(page)
}

/**
 * HOLD a mouse button on the canvas at `at` while `during` runs, then let go:
 * a press, whatever the hand does meanwhile (keys, a wait), a release. DEV-472
 * follow-up, for the editor's right-button fly, where W moves the eye only
 * while the button is held.
 */
export const holdCanvasButton = async (
  page: Page,
  at: { x: number; y: number },
  button: 'left' | 'middle' | 'right',
  during: () => Promise<void>,
): Promise<void> => {
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await page.mouse.down({ button })
  try {
    await during()
  } finally {
    await page.mouse.up({ button })
  }
  await releasePointer(page)
}

/** Clicks `captureCanvas` makes before it gives up, and how long each waits. */
const CAPTURE_TRIES = 3
const CAPTURE_WAIT_MS = 500
/** Chrome's refusal after an exit lasts about a second; a player clicks again after it. */
const CAPTURE_COOLDOWN_MS = 1_100

/**
 * Click the canvas and KEEP the pointer, for the specs that test looking.
 *
 * **A click the browser refuses gets clicked again, as a player would.** Chrome
 * grants a lock only to a focused document (headed workers share one desktop,
 * and the window in front has the focus) and turns a request down for about a
 * second after the page has left a lock. Either way the capture came back with
 * no lock at all: `pause.spec.ts`'s cursor test failed two runs in three that
 * way, on every commit back to before the split, the FIRST repetition passing
 * and the next two not. The game's click is unchanged and still runs the real
 * capture; this raises the window, waits out a refusal and clicks again, as a
 * person whose click did not take the pointer does. A refused click presses
 * nothing (`input/look.ts`'s `onClick` spends it on the request), so a second
 * one cannot press twice.
 */
export const captureCanvas = async (page: Page): Promise<void> => {
  for (let tries = 1; tries <= CAPTURE_TRIES; tries++) {
    // The lock is granted only to a FOCUSED document, and headed workers share
    // one desktop: whichever window the OS last raised has the focus. A player's
    // window is the one in front, so put this one there first.
    await page.bringToFront()
    await page.locator(CANVAS).click()
    const until = Date.now() + CAPTURE_WAIT_MS
    while (Date.now() < until) {
      if (await pointerIsLocked(page)) return
      await page.waitForTimeout(50)
    }
    if (tries < CAPTURE_TRIES) await page.waitForTimeout(CAPTURE_COOLDOWN_MS)
  }
  throw new Error(
    `captureCanvas: the canvas did not take the pointer after ${CAPTURE_TRIES} clicks ` +
      `(${CAPTURE_WAIT_MS} ms each, ${CAPTURE_COOLDOWN_MS} ms apart)`,
  )
}

/**
 * Take keyboard focus off the landing page's button, pressing NOTHING.
 *
 * For the title screen, where a canvas click is a real press (see the header).
 * `attachKeyboard` binds to `globalThis`, so a key reaches the game whatever
 * has focus — but Enter on a still-focused `<button>` activates the button,
 * and the landing card's Start is exactly where the click before this left it.
 * So the job is to let go of it, not to focus something else.
 *
 * This presses nothing and touches no game code. It is the harness doing LESS,
 * not the game doing something different under test.
 *
 * Since DEV-557 the page has no button to hold focus (the landing card is
 * gone), so this is usually a no-op; it stays because it is still the right
 * statement of "press nothing, take focus off whatever has it".
 */
export const dropFocus = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const el = document.activeElement
    if (el instanceof HTMLElement) el.blur()
  })
}

/**
 * Let go of the pointer, if the page is holding it, and leave the game as the
 * release found it.
 *
 * Safe to call when nothing is captured: `exitPointerLock` on an unlocked
 * document is a no-op, and a helper that threw in the ordinary case would just
 * get wrapped in a try/catch at every call site.
 *
 * ── DEV-563: in a live mission, the release now PAUSES ───────────────────
 *
 * A player's Escape while captured reaches the page only as the capture
 * ending, so the game opens its pause menu on any release it did not ask for,
 * and this one is not the game's. That is the feature, and the harness does
 * not dodge it: it answers it the way the player would, with a second Escape,
 * which the game reads as a key now that the pointer is free and which closes
 * the menu. Only a menu THIS release opened is closed: one that was already up
 * is the spec's own, and stays.
 *
 * `dropPointer` is the release alone, for a spec that wants to see the pause.
 */
export const releasePointer = async (page: Page): Promise<void> => {
  const before = await page.evaluate(() => {
    const held = document.pointerLockElement !== null
    const ff2 = (globalThis as { __ff2?: { pausePlate?: () => { open: boolean } } }).__ff2
    const open = held && ff2?.pausePlate?.().open === true
    document.exitPointerLock?.()
    return { held, open }
  })
  if (!before.held || before.open) return
  // The game reads the lost capture on its next frame: wait for the change to
  // land and then for three frames, so "nothing opened" is a frame that looked.
  await page.waitForFunction(() => document.pointerLockElement === null)
  await afterFrames(page, 3)
  if (!(await pauseIsOpen(page))) return
  // Held across frames: the game edge-detects a LEVEL once a frame, so a tap
  // that lands between two frames is a press it never saw (pause.spec.ts).
  await page.keyboard.down('Escape')
  await page.waitForTimeout(200)
  await page.keyboard.up('Escape')
  await page.waitForFunction(
    () =>
      (globalThis as { __ff2?: { pausePlate?: () => { open: boolean } } }).__ff2?.pausePlate?.()
        .open !== true,
    undefined,
    { timeout: 5000 },
  )
}

/**
 * Let go of the pointer and NOTHING else: the player's Escape while captured,
 * as the page sees it. In a live mission this opens the pause menu (DEV-563).
 */
export const dropPointer = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    document.exitPointerLock?.()
  })
}

/** Whether the pause plate is up (`__ff2.pausePlate().open`, which is `paused`). */
export const pauseIsOpen = async (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __ff2?: { pausePlate?: () => { open: boolean } } }).__ff2?.pausePlate?.()
        .open === true,
  )

/** Resolve after `n` animation frames, each of which runs the game's frame. */
const afterFrames = async (page: Page, n: number): Promise<void> => {
  await page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let left = count
        const tick = (): void => {
          left -= 1
          if (left <= 0) done()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    n,
  )
}

/** Whether the page currently holds the pointer. For asserting, not for waiting. */
export const pointerIsLocked = async (page: Page): Promise<boolean> =>
  page.evaluate(() => document.pointerLockElement !== null)
