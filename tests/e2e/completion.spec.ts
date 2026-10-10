/**
 * tests/e2e/completion.spec.ts — **can the game be finished?**
 *
 * Every other spec proves one screen. `walkthrough.spec.ts` proves the four
 * screens hand over to each other, and stops at boarding. `lap.spec.ts` proves
 * one lap scores, and gets there with `?autopilot=1`, which sets
 * `screen = 'mission'` at boot and so skips the title and the entire level
 * select. The question a player would actually ask — *open the game with
 * nothing set, choose something, fly it, reach an end, and see it recorded* —
 * had never been asked end to end.
 *
 * It was asked on 2026-09-13, and the answer was **no, for six of thirteen**.
 * See "what the first run found" below.
 *
 * ── "Complete" is three different things ─────────────────────────────────
 *
 * `game/modes.ts` gives each mode its own ending and they do not agree:
 *
 *   Ring Attack     `endsOn: 'finishGate'`, `clockEnds: true`  — the finish
 *                   gate, or the 180 s clock. Something always ends it.
 *   Target Practice `endsOn: 'finishGate'`, `clockEnds: false` — the finish pad
 *                   and nothing else. DEV-056: enforcing the clock here made two
 *                   missions unwinnable, so a run that never reaches the pad
 *                   never ends at all.
 *   Free Flight     `endsOn: 'never'`, no clock — **it has no ending.** The
 *                   medal lands mid-air on the orb that crosses the band
 *                   (`awardWhen: 'onCrossing'`, 2016's `LevelEnd.cs:202-243`).
 *
 * A sweep that polled `finished` for all thirteen would hang on kauai for ever
 * and report it as a bug. So "done" is asked per mode.
 *
 * ── Why P, and why it is not the forbidden shortcut ──────────────────────
 *
 * The flying is the autopilot, toggled with **P** — `AUTOPILOT_KEYS` in
 * `input/keyboard.ts`, in the shipped build, on the keyboard a player has.
 * `?autopilot=1` would have been one character and is exactly what CLAUDE.md
 * forbids: it boots straight into the cockpit, so the run it proves is one that
 * never had a title screen or a level select in front of it. Pressing P after
 * boarding is the harness doing something a player can do, in the build the
 * player gets — the same line `fixtures/canvas.ts` draws for pointer lock.
 *
 * **It does NOT prove a human can fly these.** The autopilot is a proportional
 * controller aiming at the same gate spheres a player gets. This is evidence
 * that the courses, the scoring, the medal curves and the whole screen chain
 * work; it is no evidence at all about difficulty. A person answers that, in a
 * headset.
 *
 ── What the first run found, and what each assertion now holds ──────────
 *
 * The first run of this file found three defects, all of them fixed on the same
 * day. The assertions that named them are gone; these are what replaced them,
 * and each one fails if its fix is ever backed out.
 *
 * **1. Six missions could not be reached at all.** `app.ts` built the hangar —
 * the room, the chair, the holotables, the entire picker — AND the title screen
 * inside `if (launchArt?.platform && launchArt.shaft)`, and **no JumpSeat
 * mission has launch art**: 2016's JumpSeat spawns on its own sprung legs with
 * no elevator, so `level.spawn.launch` is null on all six. Picking one out of
 * the picker reloaded into an empty pale-blue void with nothing a press could
 * do. The room is the same room on every mission — all seven rigs are the same
 * `[9.35, 1.75, 9.28]` platform — so it now needs no rig at all.
 * *"every mission has a level select"*, below, is the guard.
 *
 * **2. The results panel was a dead end.** It offers `A or ENTER to fly again`
 * and pausing was refused while `lastResult` is set, so the only road back to
 * the picker was to fly the finished mission AGAIN, pause that, and quit it. The
 * pause control now means *go home* on that panel — 2016's `missionResults`
 * carries `Button_Next.cs`, whose fallback target is `setGameplayOptions`, the
 * level select (`_ui-flow.md` §3). The loop test takes that road.
 *
 * **3. Two missions reset in a loop every 15.5 s and could not be finished by
 * anybody.** `sim/boundary.ts` tested *are you outside right now*, where
 * `PlayerBoundary.OnTriggerExit` is an EDGE: Unity never fires it for a collider
 * that was not inside. `int_01_jumpSeat` and `adv_02_jumpSeat` respawn 2.6 km
 * from a 2,047 m sphere, so every death put them straight back into another
 * countdown. The boundary now arms on entry, which is 2016 exactly.
 *
 * On DEV-061, the four browser runs since have been less tidy than either story:
 * `int_02_jumpSeat` finished three times and stalled once. `MARGINAL` carries
 * the numbers and is the reason this file asserts that it SCORES rather than
 * that it finishes.
 *
 * ── The two halves ───────────────────────────────────────────────────────
 *
 * 1. Always run: the reachability claims, and **the loop** — one mission, from
 *    `/?xr=off` with nothing else set, through every screen the game has, to a
 *    medal, and back to the hangar with the time on the table.
 * 2. **Every mission**, behind `E2E_COMPLETE_ALL=1`: thirteen of those, about
 *    sixteen minutes at `--workers=2`:
 *
 *        E2E_COMPLETE_ALL=1 E2E_PORT=<yours> pnpm exec playwright test \
 *          tests/e2e/completion.spec.ts --workers=2
 */
import fs from 'node:fs'
import path from 'node:path'
import { SPIDER_READY } from '../unit/helpers/spider-ready'
import { bootReady, switchSettled } from './fixtures/boot'
import { dropFocus } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import {
  aimAtCourse,
  hangarAim,
  hangarOn,
  lookUntilAimed as lookUntilDoor,
  throughDoors,
  throughVariants,
} from './fixtures/hangar'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'
import { pressTitleRow, TITLE_ROW } from './fixtures/title'

/* ──────────────────────────────────────────────────────────── the content ── */

interface LevelFile {
  id: string
  title: string
  mode: string
  vehicle: string
  /** Which of 2016's three ranks — the level select's third step (DEV-203). */
  difficulty: string
  environment: string
  spawn?: { launch?: { platform?: unknown; shaft?: unknown } | null } | null
}

/**
 * Relative to the repo root, which is where Playwright runs.
 *
 * `__dirname` is not available: `package.json` declares `"type": "module"`, so
 * an ESM spec has none and the whole FILE fails to load — `--list` reported
 * "0 tests in 0 files", which looks exactly like a spec nobody wrote.
 * `route-sweep.spec.ts` and `spec-sweep.spec.ts` both read content this way.
 */
const LEVEL_DIR = 'content/levels'

/**
 * The thirteen, read off the disk — never a list in this file.
 *
 * Hard rule 6: a fourteenth mission must not need a code change, and a sweep
 * that names its missions is a sweep that quietly stops covering the game the
 * day one is added. `tests/unit/mission-index.test.ts` holds the same line for
 * `src/`, and the first test below holds it for this file.
 */
const LEVELS: LevelFile[] = fs
  .readdirSync(LEVEL_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8')) as LevelFile)

/**
 * The mode a mission RUNS in, which is not always the one it was authored in.
 *
 * `hoverJet_kauai_beg` is authored Ring Attack and forced to Free Flight; FF2
 * drops 2016's second forcing, on `int_02_jumpSeat` (DEV-061). Transcribed
 * rather than imported — a Playwright spec has no `@/` alias — and
 * `tests/unit/forced-mode.test.ts` is what keeps the original honest.
 */
const runningMode = (level: LevelFile): string =>
  level.id === 'hoverJet_kauai_beg' ? 'freeFlight' : level.mode

/**
 * Missions with no launch elevator — the six the level select used to skip.
 *
 * 2016's JumpSeat spawns on its own sprung legs with no shaft to ride, so
 * `spawn.launch` is null on all six. That is CONTENT and correct; what was wrong
 * was `app.ts` building the room and the title screen inside the same `if`. Kept
 * as a derived list so the "every mission has a level select" test below can say
 * *which* missions it is really proving something about — a version of that test
 * that only ever visited a HoverJet mission would pass for ever and prove
 * nothing.
 */
const NO_LAUNCH_RIG = LEVELS.filter(
  (l) => !(l.spawn?.launch?.platform && l.spawn.launch.shaft),
).map((l) => l.id)

/**
 * The mission the game boots into when the URL names none — `boot/app.ts:1192`,
 * `params.get('mission') ?? 'int_01_hoverJet'`.
 *
 * Needed since DEV-203 because the level select no longer rotates itself to the
 * loaded mission, so a walk down it has to say which course it is walking TO.
 * Asserted rather than assumed: if the default moves, this file should say so
 * rather than start swapping worlds in a test about walking the menu.
 */
const BOOT_LEVEL = LEVELS.find((l) => l.id === 'int_01_hoverJet') as LevelFile

/**
 * The two that used to reset in a loop, kept as a NAMED list so the sweep can
 * say it is proving something about them specifically.
 *
 * Both respawn about 2.6 km from a 2,047 m play-area sphere, so under the old
 * level-based boundary every death put them straight into another countdown:
 * the race clock climbed to 15.1 and dropped to 2.1, over and over, while the
 * ship snapped back. `sim/boundary.ts` now arms on entry, as
 * `PlayerBoundary.OnTriggerExit` does, and `tests/unit/boundary.test.ts` holds
 * the rule. This list is what stops that fix being proved only where it was
 * never needed.
 */
const WAS_LOOPING = ['int_01_jumpSeat', 'adv_02_jumpSeat']

/**
 * The one mission whose COMPLETION this suite will not assert, and why.
 *
 * `int_02_jumpSeat` is DEV-061's divert limit cycle, and it sits exactly on the
 * edge. Four browser runs:
 *
 *     8/9  2,050  bronze  ENDED at 336.4 s
 *     8/9  2,050  bronze  ENDED at 336.8 s
 *     4/9      -       -  open, tank dry, 364.5 s
 *     8/9  2,050  bronze  ENDED at 315.2 s
 *
 * Three finishes and a stall, on the same build and the same course. It is not
 * the level select, and it is not the boundary: with `noTerrain` the same
 * controller takes 9/9 for gold, so the route, the fuel, the clock and the
 * scorer are all sound, and 239 m of alpine ground above the line out of pad 4
 * is what the controller cannot reliably solve. Every refuel diversion restarts
 * `waypointTimeoutSeconds`, so when it loses the argument it never abandons.
 *
 * A browser run is not deterministic the way the headless harness is — the sim
 * steps on a fixed dt but the NUMBER of steps a frame delivers follows the
 * machine — so a controller balanced on an edge falls off it sometimes. An
 * assertion that it finishes is a coin toss dressed as a guarantee, and a suite
 * with one of those in it is a suite people stop believing.
 *
 * So what is asserted here is what is TRUE every time: it is reachable, it
 * boards, it flies, it scores, and nothing resets under it. **A person may well
 * fly it fine** (a worn question), and
 * `tests/unit/jumpseat-autopilot-missions.test.ts` is where the controller's own
 * behaviour is pinned.
 */
const MARGINAL = ['int_02_jumpSeat']

/**
 * The missions whose autopilot can lose its run to a HEAD STRIKE. DEV-403.
 *
 * 2016's JumpSeat death, ported on both presets: the pilot's head touches
 * anything, and the run restarts. On Anniversary the props count, and flown
 * headless over Anniversary's forest (`tests/unit/helpers/jumpseat-run.ts`'s
 * `forest`), `int_01_jumpSeat`'s autopilot grazes a palm at about 92 s in a
 * 60-degree dive. The autopilot's head guard sees the palm, but its brake cuts the
 * throttle of a seat leaning that far, and the seat falls into it. That is a
 * controller limit recorded in DEV-403's row, not a mission a player cannot fly.
 *
 * So on this mission a reset is allowed, and ONLY a head strike's: `WAS_LOOPING`
 * names it for the boundary fix, and an out-of-bounds restart here is still red.
 * A run that met no palm (a browser run is not deterministic, see `MARGINAL`) is
 * asserted in full like any other.
 *
 * `int_02_jumpSeat` joins it (DEV-543; Matt, 2026-09-30: *"accept a restart"*).
 * Its autopilot strikes its head on ONE alpine hillside, climbing past it at
 * about 97–103 s on the way to pad 6: 6 starts in 24 on DEV-530's legs and 4 in
 * 24 on the legs before them, headless with the forest, all at the same place
 * (DEV-530's follow-up). A longer head look-ahead removed the strike there and
 * cost a pad on every run, and `adv_02_jumpSeat` six strikes in eight, so it
 * is the controller's edge, not the course's. Since DEV-530 a restart resets
 * the pilot too and the run flies on, so the claim is the same as
 * `int_01_jumpSeat`'s: it scores, and the only restart is a head strike.
 */
const HEAD_STRIKE_OPEN = ['int_01_jumpSeat', 'int_02_jumpSeat']

/* ──────────────────────────────────────────────────────────── the probes ── */

interface Probe {
  finished: boolean
  elapsed: number
  counted: number
  countTotal: number
  medal: string | undefined
  score: string | undefined
  best: string | undefined
  ship: [number, number, number] | null
  panelVisible: boolean
  hudVisible: boolean
  briefingVisible: boolean
  /**
   * Is the island drawn?
   *
   * Asked of the scene ON SCREEN (`__ff2.stage()`), not of the mission scene —
   * because the menu is a different `THREE.Scene` now, the way 2016's is, and
   * the island is not in it at all. It used to be: the room hung at the base of
   * the mission's launch shaft, which on simonet is 96 m under the sea and on
   * alpine is inside solid hillside, so choosing Alpine Forest put you inside a
   * hill. DEV-076.
   *
   * **Not a reading of the reveal** — see `roomVisible`. DEV-268.
   */
  worldVisible: boolean
  /**
   * Are you sealed in the launch room, with the world not yet revealed?
   *
   * `app.ts` writes `launchRoom.object.visible = !revealed` every frame,
   * OUTSIDE the `?rideHide` branch, so this is the reveal itself. `worldVisible`
   * is not: it reads the land group's flag, which is one arm's mechanism for
   * acting on the reveal, and under the shipped `?rideHide=bore` (DEV-249, on
   * by default since `07bf549`) that group stays drawn for the whole ride on
   * purpose while a single chunk comes and goes. Asking it "am I underground"
   * got the answer `true` from the day the default flipped. DEV-268.
   */
  roomVisible: boolean
}

/**
 * The run's own state, off `__ff2.mission`, plus the panels and the ship.
 *
 * **Not `document.body.dataset`, for the counts.** `data-rings` is written by
 * `restartRun` and by the scoring branches, so on a mission that has not scored
 * yet it is simply absent — and a spec defaulting it to `'0/0'` reads "took
 * nothing out of nothing" for a course with eleven orbs on it. That is how
 * kauai's first row in this file came out `0/0`. `mission.counted` and
 * `mission.countTotal` are the numbers the HUD itself draws.
 */
const probe = async (page: import('@playwright/test').Page): Promise<Probe> =>
  (await page.evaluate(() => {
    const w = globalThis as unknown as Ff2GlobalMaybe
    // OR across the traverse, not last-wins: 2016's logo mesh has a submesh
    // called `title`, and a traverse that overwrites reported a hidden screen as
    // a visible one for two specs. `walkthrough.spec.ts` carries the same note.
    const seen: Record<string, boolean> = {}
    w.__ff2?.stage().traverse((o) => {
      if (o.name) seen[o.name] = seen[o.name] === true || o.visible === true
    })
    const m = w.__ff2?.mission
    const p = w.__ff2?.flight()?.jet.body.position
    const d = document.body.dataset
    return {
      finished: m?.finished === true,
      elapsed: Number((m?.elapsed ?? 0).toFixed(1)),
      counted: m?.counted ?? 0,
      countTotal: m?.countTotal ?? 0,
      medal: d.medal,
      score: d.finalScore,
      best: d.best,
      ship: p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null,
      panelVisible: seen.results === true,
      hudVisible: seen.hud === true,
      briefingVisible: seen.briefing === true,
      worldVisible: seen['world-terrain'] === true,
      roomVisible: seen['launch-room'] === true,
    }
  })) as Probe

interface MenuState {
  view: string
  /**
   * WHICH place or course is under the pointer — `simonet`, `rookie_01_hoverJet`.
   *
   * `aim.kind` alone cannot drive a test that has to reach a SPECIFIC world, and
   * "choose a course in another world" is the one path that reloads the
   * document. Without this the only mission any spec ever selected was the one
   * already loaded, which is the path that does not reload.
   */
  aimName: string | null
  /**
   * What the nose pointer is on — and the only honest "the level select is
   * LIVE" there is.
   *
   * `boot/app.ts` calls `hangar.gaze()` only while `screen === 'menu'`, and a
   * frame without it clears the aim. So a non-null aim means the room is the
   * screen you are on.
   *
   * **Trap: `scene.traverse` cannot answer this.** Nothing ever sets
   * `hangar.object.visible` — the room is added once and stays visible for the
   * life of the page, behind you, while you fly. A spec asserting "the hangar is
   * up" is asserting that the hangar was BUILT, which is true in the cockpit
   * too, and this file had two such assertions passing for the wrong reason
   * before the first run of it.
   */
  aim: string | null
  flown: number
  /** The steps this room walks (DEV-382): five on Anniversary, 2016's four on Classic. */
  views: readonly string[]
}

/** The level select's own state, or null when the room does not exist at all. */
const menu = async (page: import('@playwright/test').Page): Promise<MenuState | null> =>
  page.evaluate(() => {
    const h = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.hangarAim()
    if (!h) return null
    // One name per kind of table, so `lookUntilAimed` works on every step.
    const named =
      h.aim?.kind === 'vehicle'
        ? (h.aim.vehicle?.vehicle ?? null)
        : h.aim?.kind === 'variant'
          ? (h.aim.variant?.id ?? null)
          : h.aim?.kind === 'mode'
            ? (h.aim.mode?.mode ?? null)
            : h.aim?.kind === 'rank'
              ? (h.aim.rank?.difficulty ?? null)
              : h.aim?.kind === 'mission'
                ? (h.aim.mission?.id ?? null)
                : null
    return {
      view: h.view,
      aim: h.aim?.kind ?? null,
      aimName: named,
      // Counted off the AIRCRAFT, which hold every course between them — the
      // ranks list is only the open aircraft's, and would undercount.
      flown: h.vehicles.reduce((n, v) => n + v.flown, 0),
      views: h.views,
    }
  })

/**
 * Held, not tapped.
 *
 * Every confirm in this game is a LEVEL read once a frame, so a press that lands
 * between two frames is a press nothing saw. `lap.spec.ts`, `pause.spec.ts` and
 * `walkthrough.spec.ts` all carry the same note; it has cost a run each time
 * somebody reached for `page.keyboard.press`.
 */
const hold = async (
  page: import('@playwright/test').Page,
  key: string,
  settle = 400,
): Promise<void> => {
  await page.keyboard.down(key)
  await page.waitForTimeout(200)
  await page.keyboard.up(key)
  await page.waitForTimeout(settle)
}

/**
 * Boot, click through the gesture gate, and wait for a world to exist.
 *
 * `bootReady`, not `data-terrain-ready`: since DEV-281 a bare `/?xr=off` stands
 * on the title screen and builds no mission at all — the island is generated by
 * the last press of `pickAndBoard`, which is the route in this file exists to
 * walk. A URL carrying `menu=0` or `?mission=` still boots a mission world and
 * there the two are the same moment. See `fixtures/boot.ts`.
 */
const boot = async (page: import('@playwright/test').Page, query: string): Promise<void> => {
  await page.goto(query)
  await firstPress(page)
  await bootReady(page, 240_000)
  // A load that starts on the TITLE must not be clicked: since DEV-301 a click
  // there is a real press, so the focusing click left the title and the walk's
  // own Enter then chose an aircraft. Since DEV-604 the same is true of the
  // HANGAR, where a `title=0` load starts: a click on the table under the
  // centre presses it. So no load is clicked for focus.
  await dropFocus(page)
  await page.waitForTimeout(1_200)
}

/**
 * Turn the seat right until `name` is the thing under the pointer.
 *
 * `name` is whatever `menu()`'s `aimName` says for the step that is up: an
 * aircraft key, a rank key, or a mission id. One search for all three steps,
 * because the arc and the gaze are the same on all three.
 *
 * A SEARCH rather than a computed yaw: the arc's bearings depend on how many
 * tables there are and on which one the loaded mission sits in, so a fixed
 * number of degrees is a number that breaks the day a third aircraft lands.
 * `KeyD` turns the seat right and `KeyA` left — `tests/e2e/mouse-look.spec.ts`
 * pins those directions against the pad's own stick, so this file never asserts
 * a sign.
 *
 * ── And it sweeps BOTH WAYS, which it did not have to before ────────────
 *
 * The arc is 90 degrees wide and the room is 360, so turning one way from a
 * table at one end takes you the long way round — 270 degrees of empty room
 * before the table you wanted. Measured on the ranks step: a notch turns the
 * seat about 3.7 degrees, so a one-directional search needs ~90 of them to come
 * back round, and 60 was not enough. Sweeping right and then left is both
 * quicker and what a person does when they overshoot.
 */
const nudgeSeat = async (
  page: import('@playwright/test').Page,
  key: 'KeyA' | 'KeyD',
): Promise<void> => {
  await page.keyboard.down(key)
  await page.waitForTimeout(80)
  await page.keyboard.up(key)
  await page.waitForTimeout(80)
}

const lookUntilAimed = async (
  page: import('@playwright/test').Page,
  name: string,
  steps = 32,
): Promise<boolean> => {
  const on = async () => (await menu(page))?.aimName === name
  for (let i = 0; i < steps; i++) {
    if (await on()) return true
    await nudgeSeat(page, 'KeyD')
  }
  // Back past home and out the other side. Twice the budget, because the sweep
  // above has already spent one arc's worth going the wrong way.
  for (let i = 0; i < steps * 2; i++) {
    if (await on()) return true
    await nudgeSeat(page, 'KeyA')
  }
  return on()
}

/**
 * Walk all four steps — aircraft, flight plan, rank, course — to a NAMED
 * course, and board it. (Three on Ring Attack since DEV-420: its place table
 * carries the rank as a column of ski-map marks, and the course is its mark.)
 *
 * ── FOUR steps, and every one of them aimed (DEV-203) ───────────────────
 *
 * Matt, from the headset, 2026-09-17: **"free flight should be a mode. so
 * aircraft > mode > difficulty > location (these should be fixed, not randomly
 * placed as they are now)."** Two changes land on this helper at once.
 *
 * The extra step is the small half. The big half is that it now has to say
 * WHICH course it wants. It used to press three times with no aiming, because
 * `slotsFor` rotated every page so the thing you had arrived in sat under the
 * resting pointer — so `?mission=<id>` followed by three blind presses boarded
 * that same mission, and the sweep below could trust it. Nothing rotates now.
 * A blind walk would take whatever happens to be at the resting bearing, board
 * a mission the caller did not ask for, and then be flown against the WRONG
 * MODE's ending condition — a sweep that passes while proving nothing about the
 * mission named in its own test title.
 *
 * So the target is explicit and every step is a search, which is also what a
 * player does. The resting position on a step can legitimately be empty — a
 * place with no course at that rank is a dead plate, and a press there does
 * nothing — and where it is not, it is whatever the layout rests there (Ring
 * Attack, on the HoverJet's plans since DEV-419), not what this caller named.
 */
const pickAndBoard = async (
  page: import('@playwright/test').Page,
  level: LevelFile,
): Promise<void> => {
  // DEV-558: the room opens on its doors; SINGLE PLAYER is the way to the
  // aircraft, and the seat is left turned to it, so what rests under the
  // pointer on the aircraft step is not asserted (the walk searches anyway).
  await throughDoors(page)
  const before = await menu(page)
  expect(before?.view, 'Single Player opens the aircraft').toBe('vehicles')

  // The steps THIS room walks, read off the room at every step: Anniversary
  // asks for the aircraft's VARIANT after the aircraft (DEV-382), and
  // `standard` is 2016's machine, under the resting pointer; Classic's room
  // walks 2016's four; and a plan whose place carries its difficulty (Ring
  // Attack, DEV-420) walks no rank step — which the room knows only once the
  // plan is open, so the list is asked again before each step.
  for (const [view, want] of [
    ['vehicles', level.vehicle],
    ['variants', 'standard'],
    ['modes', runningMode(level)],
    ['ranks', level.difficulty],
    ['courses', level.id],
  ] as const) {
    const now = await menu(page)
    if (!(now?.views ?? []).includes(view)) continue
    expect(now?.view, `${level.id}: on the ${view} step`).toBe(view)
    // The last step through the fixture's course search: on a place arc the
    // course is a difficulty MARK in a place table's column, found by turning
    // to the place and looking at the mark, which picks it (DEV-420).
    const found =
      view === 'courses' ? await aimAtCourse(page, want) : await lookUntilAimed(page, want)
    expect(found, `${level.id}: found ${want} on the ${view} arc`).toBe(true)
    await hold(page, 'Enter')
  }
  // ── and the world that last press asked for is actually in (DEV-281) ────
  //
  // On the route a stranger takes, choosing a course IS the load: boot built
  // the title valley and nothing else. `data-switching` is set synchronously at
  // the press and cleared when the swap finishes, so the pair closes the window
  // in which `terrain-ready` still describes a world being thrown away. The
  // same wait `fixtures/hangar.ts`'s `board()` does, for the same reason.
  await switchSettled(page, 240_000)
}

/**
 * Wall-clock a single mission gets to reach its ending, once it is flying.
 *
 * `adv_02_jumpSeat` takes 242 s of sim time and `adv_01_jumpSeat` 229 s
 * (`jumpseat-autopilot-missions.test.ts`), so anything under five minutes would
 * time the two longest courses out and read as a failure of the game rather than
 * of the budget. DEV-056 is the row that made those two legal.
 */
const FLY_BUDGET = 360_000

/**
 * How long a Free Flight mission is watched before the claim is made.
 *
 * It has no ending to wait for, so this is not a budget — it is a WINDOW, and
 * the claim made inside it is *"this never finishes, and the ship is flying"*.
 * Thirty seconds is plenty for both. Waiting six minutes for a medal that was
 * never coming is what the first run of this file did.
 */
const FREE_FLIGHT_WINDOW = 30_000

/**
 * Fly until the mission reports an ending, or the budget runs out.
 *
 * Returns the last probe either way — **it does not throw on a timeout.** "Did
 * not end" is a result this file has to be able to REPORT rather than crash on:
 * a `poll().toBe(true)` here would turn one stalled controller into a red suite
 * with no table in it, and the table is the whole point.
 */
const flyUntilDone = async (
  page: import('@playwright/test').Page,
  mode: string,
): Promise<Probe & { seconds: number; wentBackwards: boolean; highWater: number }> => {
  const started = Date.now()
  const budget = mode === 'freeFlight' ? FREE_FLIGHT_WINDOW : FLY_BUDGET
  let last = await probe(page)
  // A race clock cannot run backwards in a run that is merely going badly. If it
  // does, the run was RESET under us — `PlayerBoundary`, a kill trigger, or
  // anything else that calls `restartRun` — and that is a different failure from
  // "did not finish", worth telling apart because only one of them is a bug in
  // the game rather than in the controller.
  let highWater = last.elapsed
  let wentBackwards = false
  while (!(mode !== 'freeFlight' && last.finished) && Date.now() - started < budget) {
    await page.waitForTimeout(2_000)
    last = await probe(page)
    if (last.elapsed + 0.5 < highWater) wentBackwards = true
    highWater = Math.max(highWater, last.elapsed)
  }
  return {
    ...last,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    wentBackwards,
    highWater,
  }
}

/* ════════════════════════════════════════ 1. the claims that always run ══ */

test.describe('@gpu the game can be finished', () => {
  test.setTimeout(600_000)

  test('the sweep below covers every mission the build ships', () => {
    // Cheap, always runs, and it is the guard on the expensive half: if the
    // content directory grows and this file's reader stops matching it, the
    // sweep silently covers less of the game than it says it does.
    const onDisk = fs
      .readdirSync(LEVEL_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    expect(LEVELS.length, 'one entry per level JSON').toBe(onDisk.length)
    expect(LEVELS.length, 'and there are some').toBeGreaterThan(0)
    for (const level of LEVELS) {
      expect(level.id, 'every level has an id').toBeTruthy()
      expect(['ringAttack', 'targetPractice', 'freeFlight']).toContain(runningMode(level))
    }
    // The named missions exist. A typo here would quietly stop the sweep from
    // proving anything in particular about them.
    for (const id of [...WAS_LOOPING, ...NO_LAUNCH_RIG, ...MARGINAL]) {
      expect(LEVELS.map((l) => l.id)).toContain(id)
    }
  })

  /**
   * Every mission has a level select — **including the six with no launch rig**.
   *
   * Deliberately visits one of those six rather than any mission, because that
   * is the case that was broken: the room used to be built inside the elevator's
   * `if`, so six of the thirteen booted into a void with no chair, no tables and
   * no press that did anything, and the picker offered them anyway.
   *
   * One page load, and it goes red the moment the room goes back inside that
   * `if`. `NO_LAUNCH_RIG` is derived from the level JSON, so if a future mission
   * loses its rig this starts covering that one too.
   */
  test('every mission has a level select, rig or no rig', async ({ page }) => {
    expect(NO_LAUNCH_RIG.length, 'six of thirteen have no launch elevator').toBe(6)
    for (const id of NO_LAUNCH_RIG) expect(id).toContain('jumpSeat')

    // This is the screen a player lands on after picking a JumpSeat course out
    // of the picker and letting the document reload — `boot/app.ts` sets
    // `?mission=` and reloads on a cross-mission choice, which is the route in.
    await boot(page, `/?mission=${NO_LAUNCH_RIG[0]}&xr=off&title=0`)

    const room = await menu(page)
    expect(room, `${NO_LAUNCH_RIG[0]}: the room exists`).not.toBeNull()
    // DEV-558: on its doors, the first step. DEV-565: four on this (preview)
    // build, laid centred, so the resting pointer falls between Quick Race and
    // Multiplayer; a turn of the seat puts a door under it, which is the room
    // taking a gaze (the claim the resting aim used to carry).
    expect(room?.view, 'and it opens on its doors').toBe('doors')
    expect(await lookUntilDoor(page, 'multiplayer'), 'a door under the pointer').toBe(true)
    await expect
      .poll(async () => (await menu(page))?.aim, {
        message: 'the room aims a door',
        timeout: 15_000,
      })
      .toBe('door')

    // The room is a ROOM: the island is not drawn through its walls. See
    // `Probe.worldVisible` — this was false-in-effect on simonet alone, which is
    // the only environment the menu had ever been opened in.
    expect((await probe(page)).worldVisible, 'no island inside the room').toBe(false)

    // And it goes all the way through: an aircraft, a flight plan, a rank, a
    // course, a ship. NAMED, since DEV-203: with nothing rotating, a blind walk
    // would descend into the HoverJet — it is position 0 of the aircraft arc —
    // and this test would board a HoverJet while claiming a JumpSeat, which is
    // a pass for the wrong reason and the exact failure `pickAndBoard`'s note
    // is about.
    const jumpSeat = LEVELS.find((l) => l.id === NO_LAUNCH_RIG[0]) as LevelFile
    expect(jumpSeat.vehicle, 'the target really is the other aircraft').toBe('jumpseat')
    await pickAndBoard(page, jumpSeat)
    // Polled: the loaded mission IS this course, so the press boards through
    // the load fade with no world to wait on, and the HUD stands at its black.
    await expect
      .poll(async () => (await probe(page)).hudVisible, {
        message: 'boards a JumpSeat from the picker',
        timeout: 30_000,
      })
      .toBe(true)
    const aboard = await probe(page)
    expect(aboard.worldVisible, 'and the island comes back when you do').toBe(true)
  })

  /**
   * Choosing a course in ANOTHER world swaps it IN PLACE — no reload at all.
   *
   * Matt, 2026-09-14: *"when i selected alpine forest > rookie_01, it put me
   * back in the html page, not the 3d game."* It did, because a cross-world
   * choice used to set `?mission=` and let the document go — and `index.html`'s
   * card is a curtain over a game that has already booted, so the reload put the
   * curtain back up. In a headset it was worse: a reload ends the immersive
   * session and `requestSession` needs a gesture, so changing course threw you
   * out of VR entirely.
   *
   * `switchMission` replaces the world under the menu instead (DEV-077), which
   * only became possible once the menu was its own scene (DEV-076).
   *
   * **The claim is a token on `window`.** Nothing else distinguishes "the page
   * reloaded and came back looking right" from "the page never reloaded", and
   * the first of those is the bug. A `data-` attribute would not do it — the new
   * document would set one too.
   *
   * This is the ONLY spec that selects a mission other than the one already
   * loaded, which is why the original bug survived a suite that boards from the
   * resting pointer fifteen times: that path never switches worlds.
   */
  test('choosing a course in ANOTHER world swaps it in place, with no reload', async ({ page }) => {
    await boot(page, '/?xr=off&title=0')
    // DEV-558: the room opens on its doors; SINGLE PLAYER, and the seat back to rest.
    await throughDoors(page)

    // The aircraft arc's first position is the HoverJet, which is also the one
    // the loaded mission flies — so the first press still needs no aiming, and
    // that is now a fact about the ORDER rather than about a rotation (DEV-203).
    // Everything below it is searched: the loaded mission is `int_01_hoverJet`,
    // Ring Attack and Intermediate, and the course that proves the swap is a
    // Beginner one.
    expect((await menu(page))?.aimName, 'the first aircraft is the HoverJet').toBe('hoverjet')
    await hold(page, 'Enter')
    // DEV-382: Anniversary asks for the VARIANT next; standard, under the pointer.
    await throughVariants(page)

    expect((await menu(page))?.view, 'a press on an aircraft opens its plans').toBe('modes')
    expect(await lookUntilAimed(page, 'ringAttack'), 'found Ring Attack by looking').toBe(true)
    await hold(page, 'Enter')

    // DEV-420: Ring Attack opens its PLACES — the rank is a mark on each
    // place's table, so there is no Beginner page to press through.
    const courses = await menu(page)
    expect(courses?.view, "inside the HoverJet's Ring Attack places").toBe('courses')
    // A DIFFERENT course in a DIFFERENT world — alpine, where the loaded
    // mission is on simonet — which is the whole point of the swap: turn to
    // Alpine Forest and look at its green square.
    expect(await aimAtCourse(page, 'rookie_01_hoverJet'), 'found Alpine Forest by looking').toBe(
      true,
    )
    const chosen = (await menu(page))?.aimName as string
    expect(chosen, 'and not the one already loaded').not.toBe('int_01_hoverJet')

    // A token on `window`. It cannot survive a reload, and that is the point.
    await page.evaluate(() => {
      ;(globalThis as unknown as { __noReload?: string }).__noReload = 'alive'
    })

    await hold(page, 'Enter')

    // The world is replaced under the room, and `switchMission` only boards you
    // once the whole thing has landed — so the HUD appearing is the completion
    // signal. Polling the objective count instead would pass far too early: the
    // mission state is swapped before the terrain is built.
    await expect
      .poll(async () => (await probe(page)).hudVisible, { timeout: 300_000, intervals: [1_000] })
      .toBe(true)

    // The OBJECTIVE COUNT says it is really the other course: 16 gates against
    // `int_01_hoverJet`'s 21, which is the mission's own number and not a flag
    // anyone could set by accident.
    expect((await probe(page)).countTotal, `${chosen} is the loaded mission`).toBe(16)

    const survived = await page.evaluate(
      () => (globalThis as unknown as { __noReload?: string }).__noReload ?? null,
    )
    expect(survived, `${chosen} loaded without reloading the document`).toBe('alive')

    // And you are IN it: aboard, on the pad, with the new mission's briefing —
    // which is 2016's shape, where picking in `setGameplayOptions` loads the
    // mission scene with you already in it.

    // ── and you are at the BOTTOM of its shaft, with no island in the room ──
    //
    // This asserted `worldVisible` straight away, and on alpine that is the one
    // place it must not be true: the base of `rookie_01_hoverJet`'s shaft is
    // 98.8 m inside the hillside, and the world is not drawn until the lift
    // breaks the surface — which is what 2016's `trigger_enableTerrain` did and
    // what the port now does (DEV-094). The claim it was making, *"the swap
    // really built a world"*, is the same one; it just arrives 15.5 s later, on
    // the ride the swapped mission is owed.
    //
    // **DEV-268: it now asks `roomVisible`, which is the reveal itself.** The
    // land group's flag stopped answering "am I underground" when
    // `?rideHide=bore` shipped on — the group is deliberately drawn for the
    // whole ride, minus the one chunk the bore crosses — so this read `true`
    // and the poll below returned on its first tick. Nothing about the room
    // moved; measured on a real load, there is still not one vertex of the
    // world inside the shaft in either arm, which is what
    // `launch-ride-on-switch.spec.ts` scans for and this file trusts it on.
    expect((await probe(page)).roomVisible, 'sealed in the launch room, underground').toBe(true)
    await hold(page, 'Enter')
    await expect
      .poll(async () => (await probe(page)).roomVisible, { timeout: 60_000, intervals: [500] })
      .toBe(false)
    expect((await probe(page)).worldVisible, 'and the island is drawn once you are out').toBe(true)
  })

  test('start it, choose a place, choose a course, fly it, and it is on the board', async ({
    page,
  }) => {
    // `/?xr=off` and NOTHING ELSE. No `title=0`, no `menu=0`, no `ride=0`, no
    // `?mission=` — this is the URL a stranger opens, and every screen the game
    // has stands in front of it. `xr=off` only skips the OpenXR probe, which
    // would otherwise launch SteamVR on the machine running this.
    await boot(page, '/?xr=off')

    // ── the title ──────────────────────────────────────────────────────────
    expect((await probe(page)).hudVisible, 'no cockpit on the title screen').toBe(false)
    await pressTitleRow(page, TITLE_ROW.hangar) // DEV-441: Single Player, then Hangar

    // ── the level select, all four steps ───────────────────────────────────
    const seated = await probe(page)
    expect(seated.hudVisible, 'down the shaft and out of the ship').toBe(false)
    // DEV-565: the room is the SCREEN (`hangarAim().screen`, DEV-558), not a
    // non-null aim: preview's four doors stand centred and the resting pointer
    // falls between two of them, so the live room aims nothing until you look.
    await hangarOn(page, 'doors')
    expect((await menu(page))?.flown, 'nothing flown yet').toBe(0)
    // The mission the game boots into with no `?mission=`, so no world swap
    // happens here and the walk stays a walk. `flyUntilDone` below is told
    // `'ringAttack'`, and this is where that comes from.
    await pickAndBoard(page, BOOT_LEVEL)

    // ── the pad ────────────────────────────────────────────────────────────
    const pad = await probe(page)
    expect(pad.hudVisible, 'aboard, HUD up').toBe(true)
    expect(pad.briefingVisible, "and 2016's briefing with it").toBe(true)
    expect(pad.finished, 'nothing has been flown yet').toBe(false)

    // ── launch, then hand the stick over ───────────────────────────────────
    await hold(page, 'Enter')
    await hold(page, 'KeyP')

    const run = await flyUntilDone(page, 'ringAttack')
    expect(run.finished, `the run ended (${run.elapsed}s of race clock)`).toBe(true)
    expect(run.panelVisible, 'the results panel is up').toBe(true)

    // It SCORED, rather than ending on the clock with nothing taken — which
    // would satisfy "finished" and mean the course was never flown.
    expect(run.countTotal, 'the course has gates').toBeGreaterThan(0)
    expect(run.counted, 'and the run took most of them').toBeGreaterThan(run.countTotal / 2)
    expect(Number(run.score), 'with a score on the panel').toBeGreaterThan(0)
    // DEV-601: the autopilot flew it (P, above), so no medal, whatever the
    // rings earned. A medal from a run the player flew is
    // `player-course-share.spec.ts`'s first test.
    expect(run.medal, 'no medal for an autopilot run').toBe('none')

    // ── and the loop CLOSES ───────────────────────────────────────────────
    //
    // **One press.** The results panel used to be a dead end — it offers `A or
    // ENTER to fly again` and pausing was refused while `lastResult` is set, so
    // the only road back to the picker was to fly the finished mission AGAIN,
    // pause that, and quit it. Four steps nobody would find.
    //
    // DEV-406: A now means *go home* on that panel (Matt, 2026-09-25: "take me
    // back to the hangar when i press A"), and the pause control is another go.
    // Still one meaning per button, which is the point `app.ts` makes.
    await hold(page, 'Enter')

    // The room has the screen again. Asserted on the SCREEN (DEV-565, as
    // above), not on the hangar group's `visible`: see `MenuState.aim`.
    await expect
      .poll(async () => (await hangarAim(page))?.screen ?? null, {
        timeout: 20_000,
        intervals: [500],
      })
      .toBe('menu')
    const home = await probe(page)
    expect(home.hudVisible, 'out of the ship').toBe(false)
    expect(home.panelVisible, 'and the results panel is down').toBe(false)
    // DEV-601: and no best was kept, so the table you launched from still says
    // none flown. (DEV-073's refresh, which puts a run you DID fly on that
    // table, is no longer reached by this autopilot run; the stored best it
    // reads is written by `player-course-share.spec.ts`'s key-flown run.)
    expect(Number(home.best || 0), 'no best kept for an autopilot run').toBe(0)
    await page.waitForTimeout(1_000)
    expect((await menu(page))?.flown ?? 0, 'the table says none flown').toBe(0)
  })
})

/* ═══════════════════════════════════════════════ 2. all thirteen of them ══ */

const ALL = process.env.E2E_COMPLETE_ALL === '1'

test.describe('@gpu every mission can be flown to an ending', () => {
  test.skip(!ALL, 'set E2E_COMPLETE_ALL=1 — thirteen missions, about sixteen minutes')
  test.describe.configure({ mode: 'parallel' })

  for (const level of LEVELS) {
    const mode = runningMode(level)

    test(`${level.id} — ${level.title}`, async ({ page }) => {
      test.setTimeout(FLY_BUDGET + 300_000)
      // Every restart the app makes, by the name it gives it (DEV-403, below).
      const logs: string[] = []
      page.on('console', (m) => logs.push(m.text()))

      // `?title=0` only skips the monument. The hangar, ALL FOUR steps of the
      // level select, the lift where there is one and the countdown are all
      // still in front of this, on every one of the thirteen — which is the
      // thing that was not true when this file was written. There is no
      // `menu=0` here any more, and there should never be one: a sweep that
      // routes around the menu cannot tell you the menu works.
      //
      // The walk is told which course to take (DEV-203). It boots into the same
      // one, so nothing swaps — but the arc no longer rotates itself to the
      // loaded mission, so a blind walk would board whatever sat at the resting
      // bearing and then be flown against `mode`, which belongs to the mission
      // in this test's title and not to the one it boarded.
      await boot(page, `/?mission=${level.id}&xr=off&title=0`)
      await pickAndBoard(page, level)

      // Boarding is a FADE, and this sweep boots into the mission it boards, so
      // the last press swaps no world: `pickAndBoard`'s terrain-ready wait is
      // already satisfied at the press and returns at once. A single probe then
      // can land inside the fade (DEV-530's follow-up: two runs of six on
      // `int_02_jumpSeat`, on either set of legs, read hud, world and room all
      // hidden with the ship on its pad), so this waits for the HUD the way a
      // player waits for the fade.
      await expect
        .poll(async () => (await probe(page)).hudVisible, { timeout: 30_000, intervals: [250] })
        .toBe(true)
      const pad = await probe(page)
      expect(pad.hudVisible, `${level.id}: aboard`).toBe(true)
      const spawn = pad.ship

      await hold(page, 'Enter')
      await hold(page, 'KeyP')
      const run = await flyUntilDone(page, mode)

      // One row per mission, whatever happens — the reason `flyUntilDone` does
      // not throw. Reading thirteen of these is how anyone finds out that a
      // course got harder, and no assertion can say that.
      console.info(
        [
          level.id.padEnd(20),
          mode.padEnd(15),
          `${run.counted}/${run.countTotal}`.padStart(7),
          `score ${String(run.score ?? '-').padStart(6)}`,
          `medal ${(run.medal ?? '-').padEnd(9)}`,
          run.finished ? 'ENDED' : run.wentBackwards ? 'LOOP ' : 'open ',
          `clock ${String(run.elapsed).padStart(6)}s`,
          `peak ${String(run.highWater).padStart(6)}s`,
        ].join('  '),
      )

      // ── what every mission must do ──────────────────────────────────────
      //
      // It boards, and the ship LEAVES THE PAD. The floor under everything else
      // here: a run that ends having never moved is a run that never flew, and
      // it would satisfy "finished" on any Ring Attack mission by sitting still
      // for 180 s.
      expect(spawn, `${level.id}: there is a ship`).not.toBeNull()
      const moved = Math.hypot(
        (run.ship?.[0] ?? 0) - (spawn?.[0] ?? 0),
        (run.ship?.[1] ?? 0) - (spawn?.[1] ?? 0),
        (run.ship?.[2] ?? 0) - (spawn?.[2] ?? 0),
      )
      expect(moved, `${level.id}: flew somewhere (${Math.round(moved)} m)`).toBeGreaterThan(50)

      if (mode === 'freeFlight') {
        // ── Free Flight is a bad candidate for the autopilot, and that is a
        //    statement about the CONTROLLER, not about the mission ──────────
        //
        // `sim/autopilot.ts` aims at `nextGate(course.gates, course.passed)`.
        // kauai has **zero rings and eleven orbs**, so `courseGates` is empty,
        // `nextGate` returns -1 on the first tick and on every tick after, and
        // the controller has no target at all. Measured: **0 of 11 orbs in 362
        // seconds**, twice, before this branch existed.
        //
        // So this asserts what the MODE guarantees and nothing the autopilot
        // would have to earn: the objective exists, and the run never ends —
        // which is `endsOn: 'never'`, and the assertion that catches somebody
        // giving Free Flight a clock. Whether those eleven orbs are REACHABLE is
        // `tests/unit/orb-floor.test.ts`'s question; DEV-067 raised five buried
        // ones to the floor 2016 itself sets, and gold was impossible before it.
        expect(run.countTotal, `${level.id}: has orbs to find`).toBeGreaterThan(0)
        expect(run.finished, `${level.id}: Free Flight has no ending`).toBe(false)
        return
      }

      // **Nothing resets under you.** A race clock cannot run backwards in a run
      // that is merely going badly — only a `restartRun` can do that — so this
      // is the guard on `sim/boundary.ts` arming on entry, and it is checked on
      // EVERY mission rather than only on the two that used to loop. Those two
      // are named in `WAS_LOOPING` so the sweep can say it is proving something
      // about them in particular.
      //
      // The app names every restart on the console. No mission may restart for
      // any reason but a head strike, and only `HEAD_STRIKE_OPEN` may restart
      // for that one (DEV-403).
      const restarts = logs.filter((l) => l.includes('run restarted at the respawn marker'))
      const headStrikes = restarts.filter((l) => l.startsWith('head strike')).length
      expect(
        restarts.filter((l) => !l.startsWith('head strike')),
        `${level.id}: no boundary or fuel restart`,
      ).toEqual([])
      const struck = HEAD_STRIKE_OPEN.includes(level.id) && headStrikes > 0
      if (!struck) {
        expect(run.wentBackwards, `${level.id}: the run never reset under us`).toBe(false)
      }

      // Everything else scores. The assertion that would have been red for the
      // whole life of the port on six of the thirteen.
      expect(run.counted, `${level.id}: took something`).toBeGreaterThan(0)

      if (struck) {
        // Scores, and the only restart was the head strike. See `HEAD_STRIKE_OPEN`.
        console.info(`${level.id}: ${headStrikes} head strike(s) restarted the run (DEV-403)`)
        return
      }

      if (MARGINAL.includes(level.id)) {
        // Scores, and that is the claim. See `MARGINAL` — three finishes and a
        // stall across four runs is not something to assert either way.
        return
      }

      expect(run.finished, `${level.id}: reached an ending at ${run.elapsed}s`).toBe(true)
      expect(run.panelVisible, `${level.id}: results panel up`).toBe(true)
      expect(Number(run.score), `${level.id}: scored`).toBeGreaterThan(0)
    })
  }
})

/* ═══════════════════════════════════ 3. an aircraft variant, flown to an end ══ */

/**
 * DEV-384: the JumpSeat's overclocked variant finishes a course, through the
 * whole route a player takes, in the build a player gets.
 *
 * `?variant=` is the development switch ahead of the hangar's variant step
 * (DEV-380; DEV-382 builds the step): it is read when the flight is BUILT, so
 * the walk below still picks the aircraft, the plan, the rank and the course.
 * The claim is two halves, and each is asserted on its own: the flight on the
 * seam is the variant's (`flight().variant`), and it reaches the finish.
 *
 * `rookie_01_jumpSeat` because it is the shortest JumpSeat course (63 s of sim
 * for standard, 66 s overclocked, `tests/unit/variant-overclocked.test.ts`), so
 * this runs in every pass of the file rather than behind `E2E_COMPLETE_ALL`.
 * The other five are flown headless in that unit file.
 */
test.describe('@gpu an aircraft variant can be finished', () => {
  test('?variant=overclocked finishes rookie_01_jumpSeat', async ({ page }) => {
    test.setTimeout(FLY_BUDGET + 300_000)
    const level = LEVELS.find((l) => l.id === 'rookie_01_jumpSeat') as LevelFile
    expect(level, 'the course exists').toBeDefined()
    const mode = runningMode(level)

    await boot(page, `/?mission=${level.id}&xr=off&title=0&variant=overclocked`)
    await pickAndBoard(page, level)

    const flown = await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.flight()?.variant ?? null,
    )
    expect(flown, 'the seat on the seam was built from the variant').toBe('overclocked')

    await hold(page, 'Enter')
    await hold(page, 'KeyP')
    const run = await flyUntilDone(page, mode)
    console.info(
      [
        `${level.id} (overclocked)`.padEnd(32),
        `${run.counted}/${run.countTotal}`.padStart(7),
        `score ${String(run.score ?? '-').padStart(6)}`,
        `medal ${(run.medal ?? '-').padEnd(9)}`,
        run.finished ? 'ENDED' : run.wentBackwards ? 'LOOP ' : 'open ',
        `clock ${String(run.elapsed).padStart(6)}s`,
      ].join('  '),
    )

    expect(run.wentBackwards, 'the run never reset under us').toBe(false)
    expect(run.counted, 'took something').toBeGreaterThan(0)
    expect(run.finished, `reached an ending at ${run.elapsed}s`).toBe(true)
    expect(run.panelVisible, 'results panel up').toBe(true)
    expect(Number(run.score), 'scored').toBeGreaterThan(0)
  })

  /**
   * DEV-383: the jumping spider finishes the same course, HOPPING. Its jet
   * cannot climb, so the in-game autopilot flies it with the hop planner at the
   * end of `sim/jumpseat-autopilot.ts`, and the seam's `jump` reports the hops.
   * The other five courses are flown headless in `variant-spider.test.ts`.
   *
   * NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is
   * `listed: false` and its autopilot is abandoned, so this skips on
   * `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
   */
  test('?variant=spider finishes rookie_01_jumpSeat by jumping', async ({ page }) => {
    test.skip(!SPIDER_READY, 'the jumping spider is not ready to ship (listed: false, DEV-403)')
    test.setTimeout(FLY_BUDGET + 300_000)
    const level = LEVELS.find((l) => l.id === 'rookie_01_jumpSeat') as LevelFile
    expect(level, 'the course exists').toBeDefined()
    const mode = runningMode(level)

    await boot(page, `/?mission=${level.id}&xr=off&title=0&variant=spider`)
    await pickAndBoard(page, level)

    const aboard = await page.evaluate(() => {
      const f = (globalThis as unknown as Ff2GlobalMaybe).__ff2?.flight()
      return f ? { variant: f.variant, jumps: f.jump?.jumps ?? null } : null
    })
    expect(aboard?.variant, 'the seat on the seam was built from the variant').toBe('spider')
    expect(aboard?.jumps, 'and it carries a jump').toBe(0)

    await hold(page, 'Enter')
    await hold(page, 'KeyP')
    const run = await flyUntilDone(page, mode)
    const jumps = await page.evaluate(
      () => (globalThis as unknown as Ff2GlobalMaybe).__ff2?.flight()?.jump?.jumps ?? 0,
    )
    console.info(
      [
        `${level.id} (spider)`.padEnd(32),
        `${run.counted}/${run.countTotal}`.padStart(7),
        `score ${String(run.score ?? '-').padStart(6)}`,
        `medal ${(run.medal ?? '-').padEnd(9)}`,
        run.finished ? 'ENDED' : run.wentBackwards ? 'LOOP ' : 'open ',
        `clock ${String(run.elapsed).padStart(6)}s`,
        `jumps ${jumps}`,
      ].join('  '),
    )

    expect(run.wentBackwards, 'the run never reset under us').toBe(false)
    expect(jumps, 'it got there by jumping').toBeGreaterThan(0)
    expect(run.counted, 'took something').toBeGreaterThan(0)
    expect(run.finished, `reached an ending at ${run.elapsed}s`).toBe(true)
    expect(run.panelVisible, 'results panel up').toBe(true)
    expect(Number(run.score), 'scored').toBeGreaterThan(0)
  })
})

/* ═══════════════════════════════ 4. every HoverJet variant, to the finish ══ */

/**
 * The HoverJet's variants, read off `content/aircraft/hoverjet.json` with `fs`
 * — not through `content/load-aircraft.ts`, whose `import.meta.glob` would
 * take the whole Playwright collection down with it. `standard` is the walk
 * above; every other variant in the file is flown here, so a new one is covered
 * without an edit.
 */
const HOVERJET_VARIANTS = (
  JSON.parse(fs.readFileSync('content/aircraft/hoverjet.json', 'utf8')) as {
    variants: { id: string; scale: Record<string, number> }[]
  }
).variants.filter((v) => v.id !== 'standard')

/** The HoverJet block of the generated sheet, for what each scaled key should read. */
const HOVERJET_SHEET = (
  JSON.parse(fs.readFileSync('src/generated/constants.generated.json', 'utf8')) as {
    hoverjet: Record<string, Record<string, unknown>>
  }
).hoverjet

const sheetAt = (sheet: unknown, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], sheet)

/**
 * DEV-381: `?variant=acrobat` and `?variant=speed` fly `int_01` to the finish.
 *
 * `?variant=` is DEV-380's development switch, resolved when the flight is
 * built, which is boarding. So the walk is the one above, the variant is proved
 * LIVE by the flying jet's own sheet reading the file's factors, and then the
 * autopilot flies it to the finish gate, as the walk's own lap does.
 *
 * The autopilot is the player's (P), which follows the line's velocity profile
 * — and that profile is built from `boot/app.ts`'s `SHIP_TOP_SPEED`, standard's
 * boosted terminal, so on the speed jet it is held near standard's speed. This
 * proves the variant FINISHES, not what it is worth: the laps are
 * `tests/unit/variant-fairness.test.ts`'s.
 */
test.describe('@gpu every HoverJet variant can be flown to the finish (DEV-381)', () => {
  test.setTimeout(FLY_BUDGET + 300_000)

  test('there is something to fly', () => {
    expect(HOVERJET_VARIANTS.length, 'hoverjet.json has variants besides standard').toBeGreaterThan(
      0,
    )
  })

  for (const variant of HOVERJET_VARIANTS) {
    test(`${BOOT_LEVEL.id} on ?variant=${variant.id}`, async ({ page }) => {
      await boot(page, `/?mission=${BOOT_LEVEL.id}&xr=off&title=0&variant=${variant.id}`)
      await pickAndBoard(page, BOOT_LEVEL)

      const keys = Object.keys(variant.scale)
      expect(keys.length, `${variant.id} scales something`).toBeGreaterThan(0)
      const flying = await page.evaluate((paths) => {
        const w = globalThis as unknown as Ff2GlobalMaybe
        const sheet = w.__ff2?.flight()?.jet.sheet
        return paths.map((p) =>
          p
            .split('.')
            .reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], sheet),
        )
      }, keys)
      keys.forEach((key, i) => {
        const want = (sheetAt(HOVERJET_SHEET, key) as number) * (variant.scale[key] as number)
        expect(flying[i], `${variant.id}: the flying jet's ${key}`).toBeCloseTo(want, 9)
      })

      await hold(page, 'Enter')
      await hold(page, 'KeyP')
      const run = await flyUntilDone(page, 'ringAttack')
      console.info(
        [
          `${BOOT_LEVEL.id} ?variant=${variant.id}`.padEnd(34),
          `${run.counted}/${run.countTotal}`.padStart(7),
          `score ${String(run.score ?? '-').padStart(6)}`,
          `medal ${(run.medal ?? '-').padEnd(9)}`,
          run.finished ? 'ENDED' : run.wentBackwards ? 'LOOP ' : 'open ',
          `clock ${String(run.elapsed).padStart(6)}s`,
        ].join('  '),
      )

      expect(run.wentBackwards, `${variant.id}: the run never reset under us`).toBe(false)
      expect(run.finished, `${variant.id}: reached the finish at ${run.elapsed}s`).toBe(true)
      expect(run.panelVisible, `${variant.id}: results panel up`).toBe(true)
      expect(run.counted, `${variant.id}: took most of the rings`).toBeGreaterThan(
        run.countTotal / 2,
      )
      // DEV-601: the autopilot flew it, so no medal, whatever the rings earned.
      expect(run.medal, `${variant.id}: no medal for an autopilot run`).toBe('none')
    })
  }
})
