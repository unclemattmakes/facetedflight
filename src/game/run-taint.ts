// src/game/run-taint.ts — was this lap flown under the game's own rules? DEV-371.
//
// D30 item 2, named in the threat model and never built until now (`PLAYER-GHOSTS.md`
// §2: `grep -rn runTainted src/` was empty). A lap is TAINTED when something
// other than the player and the shipped rules could have moved it:
//
//   · the autopilot flew the ship at any tick of the run (`?autopilot`, P, the
//     AUTO chip or the headset hold, all of which set `autopilot` in
//     `boot/app.ts`);
//   · the page was opened with any URL switch that is NOT on the allowlist
//     below;
//   · the preset changed mid-lap (the lap is keyed by ONE edition's rules).
//
// A tainted lap may be kept on this device and raced; it may never be
// submitted (DEV-373 reads the flag). Nothing here is a defence against a
// determined cheater, who owns the page: D30's model is "we deter casual
// cheating and delete the rest", and this is the casual half.
//
// ── An ALLOWLIST, so a switch added later taints by default ──────────────
//
// The plan's rule, and the reason for its shape: a list of the switches that
// change the game would be right on the day it was written and wrong the day
// somebody adds `?gravity=`. So the list is the other way round — the switches
// that change only what is DRAWN, MEASURED or SELECTED — and everything else,
// including a switch nobody has written yet, taints.
//
// By KEY, not by value. `?autopilot=0` taints though it turns nothing on, and
// `?props=on` taints though it is the shipped value: a switch is either
// presentation or it is not, and reading values would mean re-deriving each
// switch's parser here, which is a second copy with no way to say it drifted.
// The cost of the rule is a lap nobody can submit from a URL nobody types.
//
// SIM-FREE and DOM-FREE: the caller hands in the query string.

/**
 * The URL switches that cannot change a lap, each with the reason it cannot.
 * Everything not named here taints (see the header).
 *
 * Deliberately short. A development switch that is presentation-only but that
 * no player has in a URL (`?fog=`, `?wire=`, `?tint=`, the `?hud*=` pins) is
 * left off: tainting it costs nobody anything, and every entry here is one
 * somebody must be sure of. `tests/unit/run-taint.test.ts` holds each name to a
 * switch the source actually reads, so a typo cannot quietly un-list one.
 */
export const PRESENTATION_SWITCHES: Readonly<Record<string, string>> = {
  // The quality ladder's pins. The sim runs at one fixed step on every rung.
  quality: 'pins the quality preset, which changes pixels and not the fixed step',
  adaptive: 'turns the quality controller on or off',
  aa: 'pins MSAA',
  hz: "pins the headset's refresh rate; the sim's step is fixed whatever it is",
  // The device, and the instruments that watch it.
  xr: 'skips the OpenXR probe',
  touch: 'forces the touch controls on or off: an input device, like a pad',
  perf: 'draws the perf plate',
  trace: 'records a perf trace of the run',
  audio: 'turns the sound off',
  // Where the camera is. V does the first at any time in flight.
  camera: 'boots in third person',
  view: 'a screenshot viewpoint',
  eye: "a viewpoint's eye",
  look: "a viewpoint's target",
  cam: 'a named viewpoint',
  chase: 'which racer the chase view follows',
  chaseOffset: "the chase view's offset",
  // The route in. The race starts at the release on every one of them.
  title: 'skips the title',
  menu: 'skips the menus',
  ride: 'skips the lift ride, which a Quick Race does too (DEV-353)',
  // WHICH lap, not how it was flown: the lap records both, and a board is
  // keyed by both (`PLAYER-GHOSTS.md` §3.6).
  mission: 'which course',
  // A LOOK since D35 (DEV-452): every run flies the page's rules whatever it
  // says.
  edition: 'which look',
  // Which RULES (DEV-452's development switch): the lap records them, and is
  // keyed and raced by them, as `edition` was before D35. It never reaches a
  // board: a run under it offers no Share (`boot/app.ts`, `shareOffered`).
  rules: 'which rules; the lap records them, and a run under them offers no Share',
  // WHOSE ghost (DEV-373). A ghost is a recording and intangible: it is never
  // handed to the racers' step, which is the only door to contact (DEV-371),
  // so it cannot move your lap — and a shared link would otherwise taint
  // every lap raced from it, which is the one lap a link exists to provoke.
  ghost: 'which lap the ghost flies; a ghost is intangible, so it cannot move yours',
}

/** Is this URL switch on the allowlist? */
export const isPresentationSwitch = (name: string): boolean =>
  Object.hasOwn(PRESENTATION_SWITCHES, name)

// ── A switch that taints ON PURPOSE: `?room=` (DEV-390) ────────────────────
//
// A room lap is judged, placed and raceable as a ghost, and it never goes on a
// solo board (plan/MULTIPLAYER.md §11 call 10, accepted 2026-09-25): a room has
// no racer contact (§6.7) and, from DEV-389, a row start instead of the pad,
// which is not the world a board lap was flown in, and the lap's rules string
// knows none of that. `?room` is NOT presentation, so it would taint by the
// rule above anyway; this names it so it taints by DECISION, under a reason of
// its own (`room`, not `?room`), which the room's own "assisted" mark leaves
// out (`taintedInRoom`): in a room every lap carries it, and it says nothing
// about how the lap was flown.

/** The room switch, `?room=<id>` (`game/room-client.ts`'s `roomIdFrom`). */
export const ROOM_SWITCH = 'room'
/** The reason a room lap is off the solo boards. Not a `?switch`: a decision, not an accident. */
export const ROOM_TAINT = 'room'

/**
 * The switches in `search` that taint a run, as `?name`, sorted and once each
 * (and `?room=` as `room`, above). Empty for a clean URL.
 */
export const urlTaint = (search: string | URLSearchParams): readonly string[] => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const found = new Set<string>()
  for (const name of params.keys()) {
    if (name === ROOM_SWITCH) found.add(ROOM_TAINT)
    else if (!isPresentationSwitch(name)) found.add(`?${name}`)
  }
  return [...found].sort()
}

/**
 * The "assisted" mark a room puts beside a result (§11 call 6): tainted by
 * anything BUT being in a room. Autopilot, a gameplay switch or a preset change
 * marks it; `room` alone does not.
 */
export const taintedInRoom = (reasons: readonly string[]): boolean =>
  reasons.some((r) => r !== ROOM_TAINT)

/** Why a run is tainted. Empty means it is not. */
export interface RunTaint {
  readonly reasons: string[]
}

/** A run's taint, starting from what the URL already says. */
export const createRunTaint = (url: readonly string[]): RunTaint => ({ reasons: [...url] })

/** Another reason. A repeat is ignored, so a per-tick caller costs a scan of a short list. */
export const taintRun = (taint: RunTaint, reason: string): void => {
  if (!taint.reasons.includes(reason)) taint.reasons.push(reason)
}

/** A new run: back to what the URL says, and nothing the last run did. */
export const resetRunTaint = (taint: RunTaint, url: readonly string[]): void => {
  taint.reasons.length = 0
  taint.reasons.push(...url)
}

export const isTainted = (taint: RunTaint): boolean => taint.reasons.length > 0
