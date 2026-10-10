/**
 * "The world is in" — which since DEV-281 is two questions, not one.
 *
 * ── What changed ─────────────────────────────────────────────────────────
 *
 * Boot used to build BOTH worlds — the mission island and the title valley —
 * in one `Promise.all`, so `data-terrain-ready` answered every form of the
 * question at once and sixty specs waited on it without having to say which
 * one they meant. Matt, 2026-09-21: *"it shouldn't be loading the islands in
 * the first place is my entire point."* It does not any more: a boot into the
 * title screen builds the valley and nothing else, and the island is generated
 * at the first course selection.
 *
 * So the attribute keeps its meaning — **`data-terrain-ready` is the MISSION
 * world** — and a spec that only wanted "boot has finished" gets `bootReady`,
 * which is either. Widening `terrain-ready` to mean both would have been the
 * cheaper edit and the wrong one: the specs that genuinely need an island are
 * the ones that would then have raced it, silently, and a screenshot of a world
 * that is still assembling is a green test and a wrong picture.
 *
 * ── Which to use ─────────────────────────────────────────────────────────
 *
 * - `bootReady` — you are about to look at, or walk through, whatever boot put
 *   on screen. The title screen, the landing card, the level select.
 * - `missionReady` — you need the island, the course or the ship. `board()`
 *   already calls it for you, so a spec that boards needs neither.
 *
 * A URL carrying `menu=0`, `view=cam`, `autopilot=1` or `title=0` builds the
 * mission world at boot, and there the two are the same moment (`boot/app.ts`:
 * any first screen but the title builds it). An ORBIT view (`view=wide`,
 * `view=low`) is NOT a viewpoint and boots the title; `terrain-screenshot.spec.ts`
 * waited 90 s on exactly that.
 */
import { expect, type Page } from '@playwright/test'

/**
 * DEV-611, DEV-872: the developer splash has gone. It shows on every load;
 * the suite's `test` (`./test.ts`) skips it with a press once the scene is in,
 * so this is `gone` within a beat, and it matters to a spec that opts out
 * of that, or a context nobody gave the skip. While it is on
 * screen, its fade included, the game takes no confirm (a press after the load
 * skips it and is swallowed, so it does not also press the title underneath:
 * Matt's rule). So `gone`, not merely "not up": a press made during the fade
 * is swallowed too. `bootReady` and `missionReady` call it; `titleRowsUp`
 * waits on the curtain, which lifts at the fade's START, so a spec that
 * presses after `titleRowsUp` on a first visit calls this as well.
 */
export const splashGone = async (page: Page, timeout = 30_000): Promise<void> => {
  await page.waitForSelector('body[data-splash="gone"]', { timeout })
}

/** The terrain generator's budget on a cold cache. Every caller used 180 s. */
const READY_TIMEOUT = 180_000

/**
 * Whichever world this URL boots is in the scene.
 *
 * A selector rather than two awaits, because the two are alternatives and
 * polling one then the other would spend the first one's whole timeout on the
 * boot that was never going to set it.
 */
export const bootReady = async (page: Page, timeout = READY_TIMEOUT): Promise<void> => {
  await page.waitForSelector('body[data-terrain-ready="true"], body[data-title-ready="true"]', {
    timeout,
  })
  await splashGone(page)
}

/** The MISSION world — island, course, ship — is in the scene. */
export const missionReady = async (page: Page, timeout = READY_TIMEOUT): Promise<void> => {
  await expect(page.locator('body')).toHaveAttribute('data-terrain-ready', 'true', { timeout })
  await splashGone(page)
}

/**
 * A course SWITCH has finished: the mission world is in AND `data-switching`
 * is off. A different question from `missionReady`, which is true while an
 * earlier course is still on screen and the next one is being built (the
 * flag is set synchronously at the press, so this closes that window). It
 * takes no splash wait: a switch happens in a running game, long after the
 * splash. The caller names the timeout, because a switch's budget is the
 * generator's and every call site chose its own.
 */
export const switchSettled = async (page: Page, timeout = READY_TIMEOUT): Promise<void> => {
  await page.waitForSelector('body[data-terrain-ready="true"]:not([data-switching])', { timeout })
}

/**
 * `data-switching` is not `'true'` any more: the press that began a course switch
 * has finished, and nothing else is asked. The editor's fly buttons wait on this
 * after the editor reports `flying`, then on `missionReady` for the world. Not
 * `switchSettled`, which also needs the terrain up in the same selector.
 */
export const switchGone = async (page: Page, timeout = 180_000): Promise<void> => {
  await expect(page.locator('body')).not.toHaveAttribute('data-switching', 'true', { timeout })
}

/** Which world boot built, as `app.ts` publishes it. `'title'` or `'mission'`. */
export const bootWorld = async (page: Page): Promise<string | null> =>
  page.getAttribute('body', 'data-boot-world')
