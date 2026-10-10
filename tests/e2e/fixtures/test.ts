/**
 * The suite's `test`: Playwright's, with every page SKIPPING the developer
 * splash the way a player does. DEV-611, DEV-872.
 *
 * The splash (`src/boot/dev-splash.ts`) shows on EVERY load, and a press made
 * inside its hold is swallowed as a skip (Matt's rule: the skipping press does
 * not also press the game). About 160 specs wait on `data-title-ready` /
 * `data-terrain-ready` by hand and then press, so each page needs the splash
 * gone first. Until DEV-872 this fixture pre-set the game's "seen" storage
 * key; the game no longer has one, and no switch replaces it.
 *
 * **The fixture presses Enter.** An init script (every page, every navigation,
 * once, centrally) watches the body: the moment the splash is up AND the game
 * says its scene is in (`data-title-ready` or `data-terrain-ready`), it sends
 * the keydown and keyup a player's Enter makes, and repeats every 50 ms until
 * the splash is no longer `up` (a press before the splash itself has seen the
 * load report is ignored by design, so the first may not land). That is the
 * skip the game already accepts from a person; the build, the boot and every
 * line of the splash module are the ones a player runs. A load that FAILS drops
 * the splash by itself, and the script stops when `data-splash` leaves `up`.
 *
 * `dev-splash.spec.ts` opts out with `test.use({ skipsSplash: false })` and
 * meets the splash as a player does. A spec that builds its own context
 * (`browser.newContext`, the XR persistent profile) calls {@link skipSplash} on
 * it, because a `context` fixture override cannot reach a context it did not
 * make. `tests/unit/e2e-base-test.test.ts` refuses a spec that imports `test`
 * from anywhere else.
 */
import { type BrowserContext, test as base, type Page } from '@playwright/test'

export * from '@playwright/test'

/** Open every page of `context` as a player who presses Enter on the loaded splash. */
export const skipSplash = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    const press = (type: 'keydown' | 'keyup'): void => {
      window.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
      )
    }
    const timer = setInterval(() => {
      const d = document.body?.dataset
      if (d === undefined) return
      if (d.splash === 'fading' || d.splash === 'gone') {
        clearInterval(timer)
        return
      }
      if (d.splash === 'up' && (d.titleReady === 'true' || d.terrainReady === 'true')) {
        press('keydown')
        press('keyup')
      }
    }, 50)
  })
}

/**
 * An uncaught error BEFORE the game says it has booted (`data-title-ready` or
 * `data-terrain-ready` on the body) is a crash: nothing will ever set the
 * attribute the spec waits on. On 2026-10-07 a module-init error
 * (`LOD_FADE_DEFINE` read before initialization) left every spec of a gate on a
 * black page until its 180 s readiness timeout, reporting a timeout and not the
 * error (Matt: "the tests aren't looking at the console logs"). So the page is
 * closed at once, which ends whatever the spec is waiting on, and the error is
 * the test's failure. An error AFTER boot is left to the specs that watch for it
 * (`fixtures/page-errors.ts`): some provoke one on purpose. Only pages of the
 * fixture's own context are watched; a spec that builds its own context is not.
 */
const bootCrashMessage = (crashes: readonly string[]): string =>
  'The page threw before the game booted, so this spec could only wait on a ' +
  `black screen:\n  ${crashes.join('\n  ')}`

export const test = base.extend<{ skipsSplash: boolean; bootCrash: undefined }>({
  skipsSplash: [true, { option: true }],
  context: async ({ context, skipsSplash }, use) => {
    if (skipsSplash) await skipSplash(context)
    await use(context)
  },
  bootCrash: [
    async ({ context }, use) => {
      const crashes: string[] = []
      const watch = (page: Page): void => {
        page.on('pageerror', (err) => {
          void (async () => {
            const booted = await page
              .evaluate(
                () =>
                  document.body?.dataset.titleReady === 'true' ||
                  document.body?.dataset.terrainReady === 'true',
              )
              .catch(() => true)
            if (booted) return
            crashes.push(`${err.name}: ${err.message}`)
            await page.close().catch(() => {})
          })()
        })
      }
      for (const page of context.pages()) watch(page)
      context.on('page', watch)
      await use(undefined)
      if (crashes.length > 0) throw new Error(bootCrashMessage(crashes))
    },
    { auto: true },
  ],
})
