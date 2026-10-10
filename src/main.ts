// src/main.ts: the entry point. Keeps the page's DOM wiring in one place so
// `boot/app.ts` stays about the game.
//
// There is no landing card any more (DEV-557). Matt, 2026-10-01: *"let's get
// rid of the html curtain. it's confusing that the game can be fully
// functional, yet the curtain is still up."* The title screen is what a
// visitor sees from the first frame, and its rows, its ENTER VR plate
// (`render/title-vr.ts`) and its first press are the game's. What is left here:
// the build version, a message for a page that cannot boot, and the
// first-gesture hook that the card's Start click used to be. The credit line
// left the title for the pause plate's CREDITS page (DEV-614).

// DEV-611: Bitter 700, the splash wordmark's face (unclemattmakes.com's), latin only.
// Bundled from the package and served from this origin, not a font service.
import '@fontsource/bitter/latin-700.css'
import { bootApp } from '@/boot/app'
import { SPLASH_PORTRAIT_PATH, startDevSplash } from '@/boot/dev-splash'
import { startStats, stats } from '@/boot/stats-beacon'
import { BUILD_VERSION } from '@/boot/version'
import { ASSET_BASE_URL_ENV, assetUrl, hasAssetBaseUrl } from '@/content/asset-url'
import { titleLine } from '@/render/credits-menu'
import { installUiCapsInBrowser } from '@/render/ui-font'
import { applyUncleMattLink } from '@/render/uncle-matt-link'

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`main.ts: #${id} missing from index.html`)
  return node as T
}

// Gameplay statistics decide, once, whether this page reports (DEV-590,
// `boot/stats-beacon.ts`): first, so a page that cannot boot is counted too.
startStats()

// CRYSTAL is a capitals face: the 2-D context sets UI-stack text in capitals
// (DEV-848, `render/ui-font.ts`), before any plate paints.
installUiCapsInBrowser()

const canvas = el<HTMLCanvasElement>('viewport')
const failure = el<HTMLParagraphElement>('boot-failure')

// The version a player reads is on the CREDITS page (DEV-614,
// `render/credits-menu.ts`), drawn on a canvas. The page states it too, as
// `body[data-build]`, beside `data-load`: one fact the specs (and anybody with
// devtools) can read without opening a menu, as `#build-version` was until
// the footer went.
document.body.dataset.build = BUILD_VERSION
// And one line at the title's foot, the version beside the copyright (DEV-614
// follow-up, Matt: "show version number on the title screen, same line as
// copyright"). Shown while the title is up (`index.html`'s `#title-line`).
el<HTMLParagraphElement>('title-line').textContent = titleLine(BUILD_VERSION)

/**
 * Say, on the page, that it cannot boot. Shown ONLY on failure (DEV-557): the
 * card's status line used to carry this, and it is the one job of the card's
 * that a headset session diagnosed the hard way (below).
 */
const fail = (message: string): void => {
  failure.textContent = message
  failure.hidden = false
  document.body.dataset.bootFailed = 'true'
}

// ── The content gate, checked BEFORE anything boots ────────────────────
//
// `MissingAssetBaseUrlError` was written to be "a loud, legible failure at boot
// instead of a black screen and a console 404" (asset-url.ts). It is, on a
// monitor, with devtools open.
//
// In a headset it is neither. The first time this was worn, `.env` was missing,
// every asset URL threw, the world promise rejected, and the session came up as
// an empty pink sky with no way to find out why: no console, no DOM.
//
// So the check stays in front of the game. An error you can only read by
// taking the headset off is not a loud failure.
if (!hasAssetBaseUrl()) {
  fail(
    `${ASSET_BASE_URL_ENV} is not set, so there is no game content to load. ` +
      'Copy .env.example to .env (or run with VITE_ASSET_BASE_URL=/ to serve a ' +
      'locally hydrated public/). See docs/asset-storage.md.',
  )
  // Read by the e2e spec, and by anyone wondering why nothing is happening.
  document.body.dataset.assetBaseMissing = 'true'
  stats.gate('no-asset-base')
  throw new Error(`${ASSET_BASE_URL_ENV} is not set, refusing to boot into an empty world`)
}

// ── The developer splash (DEV-611) ─────────────────────────────────────
//
// The page's "loading into the app" screen, once a browser session, over
// whatever the URL boots. Started AFTER the content gate above, whose failure
// line it must not stand over (and `index.html` hides it under
// `data-boot-failed` for the two failures below). `boot/dev-splash.ts` has the
// rules, and Matt's words for them.
const splash = startDevSplash(
  document.getElementById('dev-splash'),
  () => performance.now(),
  assetUrl(SPLASH_PORTRAIT_PATH),
)
// DEV-803: the same portrait, the title's bottom-left link (`#uncle-matt-link`),
// made by the code the making-of header shares (`render/uncle-matt-link.ts`).
applyUncleMattLink(el<HTMLAnchorElement>('uncle-matt-link'))

// A boot that throws (no WebGL context, a renderer that will not start) used
// to leave the card reading "Checking what this device can do..." for ever.
// Now it says what happened.
const app = await bootApp(canvas, { splash }).catch((err: unknown) => {
  fail(
    `This browser could not start the game: ${String((err as Error)?.message ?? err)}. ` +
      'It needs WebGL 2; a current Chrome, Edge or Safari has it.',
  )
  stats.gate(/webgl/i.test(String((err as Error)?.message ?? err)) ? 'no-webgl2' : 'failed')
  throw err
})
app.start()

// Dev-only handle for the e2e specs and the browser console. Not in a
// production build: `import.meta.env.DEV` is statically false there, so the
// assignment is dropped entirely rather than shipped and ignored.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as { __ff2?: unknown }).__ff2 = app
}

// ── `__ff2perf`: the read-only handle that SHIPS (VR-PERF §5.4, DEV-160) ──
//
// OUTSIDE the block above, on purpose, and it is the whole point of the
// feature. WebXR needs a real certificate, so a headset only ever opens the
// DEPLOYED URL, where `import.meta.env.DEV` is statically false and the line
// above is dropped from the bundle. Every instrument this port has built was
// therefore invisible in precisely the place the measurements have to be taken.
//
// It is a different kind of handle from `__ff2`: an allow-list of frozen
// snapshots, nothing that writes to the game, nothing that hands out a scene
// object (`boot/perf-surface.ts`). And it exists only when `app.perfSurface` is
// non-null, which is only under `?perf=1`, so a visitor who has not asked for
// it has no extra object and no extra work per frame.
if (app.perfSurface) {
  ;(globalThis as unknown as { __ff2perf?: unknown }).__ff2perf = app.perfSurface
  console.info('perf: __ff2perf is live; try __ff2perf.budget(), .session(), .trace.status()')
}

// ── How far the load is, for a spec and for the failure line ────────────
//
// The card's Start button used to count the load and go live at `ready`; the
// specs waited on it. The title's own emblem-on-black is what a visitor sees
// while the valley builds (`render/title-curtain.ts`), and the loading scene's
// plate counts a course in (DEV-355). This attribute is the same fact as the
// button's `disabled`, read-only, for a spec to wait on. A FAILURE is shown.
app.onLoadProgress((state) => {
  document.body.dataset.load = state.phase
  splash.progress(state)
  if (state.phase === 'failed' && state.error) fail(state.error)
})

// ── The valley comes up BEFORE any press (DEV-279) ──────────────────────
//
// `fade.release()` needs BOTH `revealRequested` and `firstWorldSettled`. Asking
// for the reveal here, at boot, leaves `firstWorldSettled` as the late one: a
// half-built world still assembles behind black (L4 of `docs/plan/LOADING.md`)
// and nothing waits on a human.
app.showWorld()

// The thumbsticks and chips are the game's controls, and the game is on screen
// from the first frame: there is no card left for them to wait behind. What a
// touch screen shows on the title (taps for its rows) is `boot/app.ts`'s
// per-frame context, as it always was once the card had gone.
app.touch.setVisible(true)

// ── The first gesture: the card's Start click, now ANY press (DEV-557) ───
//
// The card's click did two things for the game, and neither was pointer lock
// (`input/look.ts` captures on a canvas click of its own):
//
//  1. It was the page's first USER ACTIVATION, so `reveal()` could build the
//     AudioContext inside it. A browser suspends a context created without
//     one, and Safari will resume one only inside the gesture's own handler,
//     which is why this runs HERE, in the event, and not in the frame loop.
//  2. It marked the page as having had its gesture, which is what a `?tv` or
//     `?watch=` link waits for before it boards (audio needs it), in
//     `boot/app.ts`, where the flag lives.
//
// So the same call now rides the player's first real input, whatever it is:
// a key, a click, a touch. Listened for in the CAPTURE phase on the window so
// nothing the game does with the event can stop it, and never consumed: the
// press goes on to do whatever it does on the title (DEV-557's row says why a
// waiting link takes it instead).
//
// Only an activation-triggering event counts (HTML: a keydown other than
// Escape, a mousedown, a pointerdown from a mouse, a pointerup from anything
// else, a touchend), and `userActivation.isActive` is the spec's own answer to
// "was that one?", so the listener stays until one was.
//
// A GAMEPAD press is none of these: the platform gives a page no activation
// for it. The game notes a pad's press itself (`boot/app.ts`, the confirm
// block) so a pad-only player's link still boards and the title still works,
// and it asks the AudioContext to resume; the browser may keep it silent until
// a key, a click or a touch. That is the most a page can do.
const GESTURES = ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend', 'click'] as const
const activated = (e: Event): boolean => {
  if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Escape') return false
  const ua = (navigator as { userActivation?: { isActive: boolean } }).userActivation
  return ua ? ua.isActive : e.type !== 'pointerdown'
}
const onGesture = (e: Event): void => {
  if (!activated(e)) return
  app.reveal()
  document.body.dataset.firstInput = 'true'
  for (const type of GESTURES) globalThis.removeEventListener(type, onGesture, true)
}
for (const type of GESTURES) globalThis.addEventListener(type, onGesture, true)
