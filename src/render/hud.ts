// src/render/hud.ts — the run readout, on a panel in the cockpit.
//
// ── Why this is not a DOM overlay ─────────────────────────────────────────
//
// Because a DOM overlay is invisible in an immersive session. `dom-overlay` is
// not reliably granted on Quest (CLAUDE.md), and even where it is, it composites
// as a flat layer that fights the stereo image. A HUD the headset cannot show is
// not a HUD for a game whose first release is "in a headset".
//
// 2016 came to the same conclusion by a different route: its readout is a
// world-space panel under `art_pivot/Art/FirstPerson/FirstPersonHUDRoot`, inside
// the cockpit, not a screen overlay.
//
// ── Why it is parented to the SHIP, not the rig ───────────────────────────
//
// A panel parented to the camera rig is head-locked: it follows your eyes and
// never moves relative to them. That is the single most reliable way to make
// someone ill in VR, because it removes the fixed reference the vestibular
// system is trying to agree with. Bolted to the cockpit it stays where the
// instrument panel is, and you look at it — which is what an instrument does.
//
// ── Canvas texture ────────────────────────────────────────────────────────
//
// Text in three means either an SDF font pipeline or a 2D canvas uploaded as a
// texture. For six short numbers that change a few times a second, the canvas is
// the right size of solution: no font assets, no shader, and legible at the
// distance a dashboard sits.
//
// It redraws ONLY when a displayed value actually changes. The clock ticks about
// 80 times a second and the panel needs a tenth of that.

import * as THREE from 'three'
// TYPE ONLY, and deliberately: the panel stays a pure consumer of `HudState` —
// it never reads a preset, never asks which edition is live, and has no runtime
// dependency on `content/`. What it borrows is the ENUM, because two copies of
// `'ms' | 'kmh'` in two files is how the schema and the code come to disagree
// about what a legal value is, which is the drift `level-schema.ts`'s header
// already carries a warning about.
import type { SpeedUnitId } from '@/content/edition-schema'
import {
  chainRects,
  createDashGeometry,
  type DashContent,
  dashCanvasOps,
  dashSideInsetPx,
  dashSidePlateX,
  drawDash,
  type HudMount,
  paintChain,
  paintTank,
  type TankReading,
  tankRects,
} from './hud-dash'
import { hudFace, whenHudFontSettles } from './hud-font'
import { drawFuelDome, FUEL_DOME, fuelCanvasOps, fuelSignature, type HudLayout } from './hud-fuel'
import {
  createHudGauges,
  describeHudGauges,
  HUD_GAUGE_SPEED_FULL_SCALE,
  HUD_GAUGES_OFF,
  type HudGaugeMesh,
  type HudGaugePalette,
  type HudGauges,
  hudGaugeCoarsenSpeed,
  hudGaugesKeepDigits,
  hudGaugesOn,
  hudPanelLayout,
  sameHudGauges,
} from './hud-gauges'
import { UI_ACCENT, UI_ALERT, UI_CYAN, UI_INK, UI_LOSS } from './ui-tokens'

/** Metres per second to kilometres per hour. A unit conversion, not a tuning number. */
const MS_TO_KMH = 3.6

/**
 * `03/11`, the way the shipped HUD pads its counts — and `09`, the way
 * `Timer_Race.GetRemainingTime()`'s `.ToString("00")` pads the clock.
 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The speed row's text, in the unit asked for.
 *
 * **`ms` must be byte-identical to what the panel printed before S8 existed** —
 * `String(Math.round(speed))`, no unit, because Classic is the ledger and a unit
 * appearing on a Classic panel is a deviation nobody wrote a row for. `kmh`
 * converts and appends: 170 m/s is 612 km/h, which is a number a person can
 * feel (ANNIVERSARY.md §2.5 S8).
 *
 * Exported because it is also the REDRAW SIGNATURE's entry for this row. The
 * signature has to hold what is drawn rather than what it is drawn from:
 * `Math.round(speed)` tracked the text exactly while the text was the rounded
 * m/s, and stops tracking it the moment a factor of 3.6 sits in between.
 */
export const formatSpeed = (speed: number, unit: SpeedUnitId = 'ms'): string =>
  unit === 'kmh' ? `${Math.round(speed * MS_TO_KMH)} km/h` : String(Math.round(speed))

/**
 * What the SPEED row prints — or `null` where a gauge has replaced it.
 *
 * DEV-257, and it is one function rather than a branch in `draw()` because it
 * is also this row's entry in `hudSignature`. That identity is the whole of why
 * the two cannot drift: the signature holds *what is drawn*, and here the thing
 * that draws it and the thing that hashes it are literally the same call.
 * `formatSpeed`'s own doc comment is the older half of this lesson —
 * `Math.round(speed)` tracked the text exactly until a factor of 3.6 sat in
 * between, and a panel then goes stale with every value it reads correct.
 *
 * Three answers, and each is a different claim about the panel:
 *
 *  · gauges OFF — the shipped text, byte for byte. Nothing here runs.
 *  · gauges on, digits KEPT — the same text at `HUD_GAUGE_DIGIT_STEP`
 *    granularity. The gauge carries the continuous reading, so the digits no
 *    longer have to, and every step they do not take is a canvas raster the
 *    frame does not pay for.
 *  · gauges on, digits DROPPED — `null`. The label stays and the gauge is the
 *    reading, which is the variant that takes the repaint rate to the clock.
 */
export const hudSpeedText = (
  state: HudState,
  gauges: HudGauges = HUD_GAUGES_OFF,
): string | null => {
  if (!hudGaugesOn(gauges)) return formatSpeed(state.speed, state.speedUnit)
  if (!hudGaugesKeepDigits(gauges)) return null
  // Coarsened in the unit the row PRINTS, so "five" means five of what the
  // player is reading rather than five m/s converted into an untidy number of
  // km/h. `formatSpeed` rounds again afterwards, which is what absorbs the
  // 1e-13 the round trip through 3.6 leaves behind.
  return formatSpeed(
    hudGaugeCoarsenSpeed(state.speed, state.speedUnit === 'kmh' ? MS_TO_KMH : 1),
    state.speedUnit,
  )
}

/**
 * The TIME row's text. **2016 counts DOWN.** (DEV-200.)
 *
 * `HUD_Ship.cs:112-121` writes `raceTimer.GetRemainingTime()` into this row, and
 * `Timer_Race.cs:38-43` is `(maxRaceTime - currentRaceTime).ToString("00")` —
 * seconds REMAINING, rounded, padded to a minimum of two digits. The port had
 * been printing `Math.floor(elapsed)` since the panel was written, which is the
 * same row saying the opposite thing on every frame of every race. The 2016
 * gameplay capture (youtu.be/1-Sf7TiHPsg) shows it directly: `TIME: 110` at
 * 125 s with five gates down, `TIME: 22` at 215 s with sixteen — 88 displayed
 * seconds lost over 90 real ones.
 *
 * `--` where there is no clock at all, which is `RaceTimer.cs:30` disabling
 * itself in Free Flight; the same capture shows `ORBS: 00/36 · TIME: --`.
 *
 * **`countDown` is a MODE fact, not a preset one**, so it arrives on the state
 * rather than being asked for here: `rulesFor(mode).clockEnds`. A countdown only
 * means something where running out ENDS the run. It does in Ring Attack (every
 * HoverJet scene has the `Trigger_FinishLine` the timeout calls) and it does not
 * in Target Practice (no JumpSeat scene has one, DEV-056) — and 2016 drew no
 * TIME row on a JumpSeat at all (DEV-201), so a Target Practice clock counting
 * up is FF2's own row and stays FF2's own row. `adv_01_jumpSeat` finishes at
 * 229.5 s against a 180 s limit, so a countdown there would sit on `00` for
 * fifty seconds and tell the player nothing.
 *
 * Exported for the same reason `formatSpeed` is: it IS this row's entry in the
 * redraw signature. `Math.floor(elapsed)` tracked the text exactly while the
 * text was the floored elapsed seconds, and stops tracking it the moment a
 * subtraction and a rounding sit in between.
 */
export const formatTime = (elapsed: number, timeLimit: number, countDown = false): string => {
  if (timeLimit <= 0) return '--'
  if (!countDown) return String(Math.floor(elapsed))
  // `.ToString("00")` ROUNDS and pads to two digits; it does not truncate. The
  // clamp is ours — 2016 ends the run at zero and can never print a negative,
  // and a row that went to `-3` would be reporting a state the game is not in.
  return pad2(Math.round(Math.max(0, timeLimit - elapsed)))
}

export interface HudState {
  readonly ringsPassed: number
  readonly ringsTotal: number
  readonly score: number
  /** Seconds. */
  readonly elapsed: number
  readonly timeLimit: number
  /**
   * Does the TIME row count DOWN? 2016 does, wherever there is a clock that ends
   * the run. See `formatTime` — DEV-200.
   *
   * Optional, and absent means `false`, which is the row exactly as it was
   * drawn before this existed: every test and every screenshot builder that says
   * nothing keeps the old reading, and only the caller that knows the MODE opts
   * in. The panel never learns what a mode is, for the same reason it never
   * learns what an edition is.
   */
  readonly timeCountsDown?: boolean
  /** Metres per second. ALWAYS — the unit below is a display choice, not a change of input. */
  readonly speed: number
  /**
   * What to print `speed` in. Absent means `'ms'`, which is what 2016 printed.
   *
   * The preset decides (`edition.hud.speedUnit`) and `boot/app.ts` passes it,
   * but it arrives here as a plain enum on the state rather than as a preset
   * object, so this panel never learns that editions exist. Optional so that
   * every other caller — the tests, and anything that builds a `HudState` for a
   * screenshot — keeps the shipped behaviour by saying nothing.
   */
  readonly speedUnit?: SpeedUnitId
  /**
   * The medal this run has earned, shown once it is over.
   *
   * **Empty or `'none'` draws NOTHING, and that is load-bearing.** 2016 awards no
   * medal at all in a JumpSeat mission — three independent reasons, and
   * `rookie_01_jumpSeat` has no thresholds of any kind because it has no
   * `finale_logic` instance (`_modes-spec.md` §5.1). A panel that printed "NONE"
   * would turn "this mode has no medal" into "you failed to earn one", which are
   * different games. `game/mission.ts`'s `medalFor` returns null for the first
   * case and `'none'` for the second; both come through here as nothing drawn.
   */
  readonly medal: string
  readonly finished: boolean
  /**
   * A medal crossed MID-RUN, as 2016's own banner text, or null.
   *
   * Free Flight awards in the air, the instant the orb count reaches a threshold
   * (`LevelEnd.cs:202-243`, `AwardMedal()` -> `panel_medalAwarded`, hidden again
   * after 2.5 s). It is the only part of the two unimplemented modes that shipped
   * working, and it is the one thing on this panel that is an EVENT rather than a
   * reading — the caller is responsible for clearing it when its time is up.
   */
  readonly award?: string | null
  /**
   * How to colour `award`. `'gain'` (the default) is the panel's accent; `'loss'`
   * is muted.
   *
   * Target Practice's accuracy streak puts a SECOND kind of thing through this
   * field — a pad hit rather than a medal — and a bullseye has to read
   * differently from a graze at a glance, in peripheral vision, on a panel 0.4 m
   * across. Different words are not enough on their own: CLAUDE.md's own lesson
   * is that a thing too small or too dark has not been reviewed, it has been
   * rendered. Colour is the channel that survives being glanced at.
   */
  readonly awardTone?: 'gain' | 'loss'
  /**
   * The scoring streak, or 1 when there is none. Drawn only above 1.
   *
   * It is a READING, not an event: it is what the next plate will be paid at, so
   * it has to be on the panel continuously or the player is guessing. `1` draws
   * nothing, because "x1" is the absence of a streak rather than a streak of one.
   */
  readonly multiplier?: number
  /**
   * G2's speed chain, or absent to draw nothing (DEV-110).
   *
   * `stacks` is gates banked and `fraction` is how much of the 5.5 s cooldown is
   * left, 1 at the moment of a gate and 0 as it expires. Both come straight off
   * `sim/speed-chain.ts` — §4.1 asks for *"the loop made legible"*, and a bar
   * that carried numbers of its own could disagree with the mechanic it reports.
   *
   * DEV-615: the cooldown is the GATES line's bar, the gate combo's countdown,
   * and the only reading bar on the panel beside the tank. G1's proximity meter
   * had that line until Matt asked for *"just boost and gates"*; the field went
   * with its bar, and G1 still announces itself on the event line (`LOW +N`).
   */
  readonly chain?: { readonly stacks: number; readonly fraction: number } | undefined
  /**
   * THE TANK, or absent to draw nothing.
   *
   * Absent is not zero, exactly as it is for the chain above: a vehicle with
   * no tank draws no gauge at all, and an empty gauge for a mechanic that is not
   * running is worse than no gauge. `fraction` is 0..1 of the tank; `available`
   * is false while the engine will not light, which is a DIFFERENT state from an
   * empty tank, and the two look identical unless the panel inks them apart.
   *
   * THREE mechanics reach this field and `app.ts` picks; they are never live
   * together. **One of them is on Classic**, so "Classic has no tank" — which
   * this comment used to say — was true only of the one it was written for:
   *
   *  · DEV-143's HoverJet boost tank. Anniversary only, flagged, and `available`
   *    is `sim/energy.ts`'s `boostAvailable` — false during the lockout.
   *  · DEV-144's energy race. `available` is `powered`.
   *  · **DEV-201's JumpSeat fuel, on BOTH PRESETS**, because it is 2016's own —
   *    and the only instrument 2016 drew on that vehicle at all. `available` is
   *    the thruster latch, and the tank goes negative underneath it. Since
   *    DEV-360 it is drawn as 2016 drew it — the `fuel` layout's dome, in
   *    `render/hud-fuel.ts` — and not as a bar on the TIME row.
   *
   * **This one is the whole mechanic.** The chain above is a reading, how long
   * the gate combo has left. This is a resource the player spends with the
   * trigger they are already holding, so if it is not legible the change is
   * invisible and the player only learns the rule by the boost going away.
   */
  readonly energy?: TankReading | undefined
  /**
   * DEV-399. THE GLIDER'S STALL, or absent to draw nothing — and absent on
   * every aircraft whose wing cannot let go, by the rule the bars above
   * keep: an instrument for a mechanic that is not running is worse than none.
   *
   * With the rocket (which comes through `energy` — the glider's tank burns
   * while held and refills once released) it is G1's HUD row. `margin` is 0 at
   * the stall speed and 1 at trim, so the bar drains on the way to the cliff;
   * `stalling` is the wing short of full lift, which inks the bar as a loss and
   * puts `STALL` on the badge line. The BAR is the dash's only: the lens rows
   * (the chase camera) do not draw it and `hudCanvasOps` does not predict it;
   * the badge is `hudBadges`', so both mounts carry it.
   */
  readonly stall?: { readonly margin: number; readonly stalling: boolean } | undefined
  /** `GATES` in Ring Attack, `ORBS` in the modes that count orbs. */
  readonly countLabel: string
  /**
   * The other two instrument labels, from `level.ui.strings` via
   * `content/ui-strings.ts`.
   *
   * Here rather than hard-coded for the same reason `countLabel` is: they are
   * 2016's copy and this module draws a panel. `uiLabel` upper-cases and drops
   * the trailing colon — the row below appends its own — which on `Speed :` also
   * removes the space 2016 put before it, on that one label and no other, and
   * disagrees with itself about (the third-person console says `SpeeD :`).
   */
  readonly timeLabel: string
  readonly speedLabel: string
  /**
   * DEV-360. The JumpSeat dome's label — `text_fuel`'s `Fuel :` out of
   * `level.ui.strings`, through `uiLabel` like the two above. Read only by the
   * `fuel` layout; absent draws `FUEL`, which is the same word.
   */
  readonly fuelLabel?: string
  /**
   * DEV-383. The jumping spider's charge, 0..1, while one is building — the
   * seam's `flight.jump.charge`, which drops to 0 on release. Absent on every
   * other seat and on the HoverJet. Read only by the `fuel` layout, which draws
   * it as a thin ring inside the tank's (AIRCRAFT-VARIANTS §4.5: a launch the
   * player watched fill never surprises).
   */
  readonly jumpCharge?: number | undefined
  /**
   * The launch banner, or null once the run is under way.
   *
   * Three states, in order: an invitation to press A, the elevator riding, then
   * the countdown. The panel is the only surface the player is looking at during
   * all of it, so it is the only sensible place to say what is happening — in a
   * headset there is nowhere else to put a prompt.
   */
  readonly banner: string | null
  /** Flying itself. Worth saying on the panel, or a demo looks like a bug. */
  readonly autopilot: boolean
}

// ── DEV-243: the redraw budget ─────────────────────────────────────────────
//
// **The per-frame cost of this panel is the TEXTURE UPLOAD, not the quad.**
//
// `draw()` ends with `texture.needsUpdate = true` (twice — the banner's early
// return and the bottom of the function). three's setter is
// `Texture.js:754-762`: `this.version ++; this.source.needsUpdate = true`. The
// bytes then move at the next `setTexture2D`, which happens while three binds
// this material's uniforms — that is, INSIDE `renderer.render`, which is inside
// `boot/app.ts`'s `gpu.begin() … gpu.end()` bracket. So a repaint is charged to
// the frame's GPU time, and `hudSignature` carries the rounded speed in m/s,
// which on a flight changes on most frames.
//
// What the upload is, in three's own build (0.185.1):
// `three.module.js:11919` takes the branch on `source.version`, `:11932` sets
// `UNPACK_FLIP_Y_WEBGL` (a `CanvasTexture` keeps `flipY: true`, so the driver
// cannot take a straight blit), `:12382` is
// `texSubImage2D( TEXTURE_2D, 0, 0, 0, glFormat, glType, <the canvas> )`, and
// `:12396` then regenerates the WHOLE MIP CHAIN, unconditionally, because a
// `CanvasTexture` keeps `generateMipmaps: true` and `LinearMipmapLinearFilter`.
// 560 × 203 px is 454,720 bytes at RGBA8 and about a third as much again for
// the chain — moved, and mipped, while the frame is being timed. And the canvas
// was WRITTEN THIS FRAME, so the upload must first resolve the 2D backend's
// pending commands: a sync point whose duration is the driver's to decide,
// which is the shape of a residual that is white rather than proportional.
//
// ── What a budget can and cannot touch ─────────────────────────────────
//
// It touches the UPLOAD and nothing else. The panel is still in the scene,
// still two transparent triangles at `renderOrder` 10 with `depthTest: false`,
// still drawn once per eye, on every frame, at every cadence — so a budget can
// never account for more than `?hudRedraw=freeze` does, and the gap between
// `freeze` and hiding `jumpseat/hud` outright is the panel's own presence.
// It also touches nothing in `render/bloom.ts`: in a session `bloom.render`
// returns false at `bloom.ts:436` before it builds anything, so `UI_LAYER` is
// one bit in a camera mask and not a pass. (DEV-141 is about WHICH layer, not
// about a cost.)
//
// ── DEV-248: the budget is now the DEFAULT, and `live` is the A/B arm ──────
//
// **Matt, 2026-09-20: *"sounds like we should enable the redraw budget."*** The
// default below was `live` from DEV-243 until then; it is `HUD_REDRAW_DEFAULT`
// now, which is `10hz`. Wave 4 §3.10, all on `int_01_hoverJet`, the release
// mission, against a pass rule of GPU p95 <= 7.78 ms:
//
//   today's default (~48 Hz)  p95 7.75-8.10 across six baselines   p50 6.15-6.34
//   `?hudRedraw=10` (9.2 Hz)  p95 7.09 · 7.16 · 7.20               p50 4.20 · 4.22 · 4.22
//   `?hudRedraw=freeze`       p95 6.44                             p50 4.11   (the floor)
//
// The old default STRADDLES the rule and the budget clears it in three separate
// runs, which is the whole of the decision.
//
// **10 is the only rate that has ever been measured, so 10 is what ships.** The
// floor says the remaining headroom between 10 Hz and never painting at all is
// 0.65 ms of p95, so a slower rate buys a fraction of that and costs visible
// smoothness on every row at once. A faster one has no reading behind it.
//
// `live` is still exactly the panel DEV-243 left — it is the arm the change is
// measured against, and a default that cannot be turned off is a default nobody
// can price. `freeze` is unchanged and still not shippable.
//
// **Not gated by edition, and the argument is in DEV-248's row.** The short
// version: `ANNIVERSARY.md` §0.2 puts the quality presets outside the preset
// system ("they are the player's"), a repaint budget is that category, and
// `tests/e2e/xr-vrto3d-trace.spec.ts`'s DEV-243 block already ruled that a
// cadence is a DEV switch that "must not become an edition block".

/**
 * How often the panel is allowed to repaint.
 *
 * `live` repaints whenever `hudSignature` changes, which is what 2016 did and
 * what shipped until DEV-248. `freeze` paints once, ever, for this panel's
 * whole life. `budget` checks the signature every frame and paints at most `hz`
 * times a second — and `HUD_REDRAW_DEFAULT` is one of those.
 */
export type HudRedraw =
  | { readonly kind: 'live' }
  | { readonly kind: 'freeze' }
  | { readonly kind: 'budget'; readonly hz: number }

/**
 * Repaint on every change of what is drawn. 2016's cadence, and this port's
 * until DEV-248 — now reached by `?hudRedraw=live`, which is the A/B arm the
 * default is measured against.
 */
export const HUD_REDRAW_LIVE: HudRedraw = { kind: 'live' }

/**
 * **The shipped cadence, DEV-248.** Ten repaints a second, at most.
 *
 * A separate exported number rather than a literal inside
 * `HUD_REDRAW_DEFAULT`, because it is a MEASURED value and the test that
 * defends it has to be able to say which number it is defending. Wave 4 §3.10
 * is the reading; the block above is the arithmetic.
 *
 * On a ~72 fps flight this admits a paint on roughly one frame in eight, and
 * the guarantee it carries is the strong one `HudRedrawBudget.admit` states:
 * **no two paints are closer together than 100 ms.** So a value that moves can
 * be at most one interval plus one frame stale — ~111 ms at 90 fps, ~114 at 72
 * — and it is never LOST, because `createHud`'s `owed` flag pays a refusal at
 * the next admission. DEV-248's row walks every row of the panel against that.
 */
export const HUD_REDRAW_DEFAULT_HZ = 10
export const HUD_REDRAW_DEFAULT: HudRedraw = { kind: 'budget', hz: HUD_REDRAW_DEFAULT_HZ }

/**
 * The fastest and slowest budgets `?hudRedraw=<n>` will accept.
 *
 * The ceiling is above any display this game runs on, so a budget at the cap is
 * indistinguishable from `live` rather than being a silent third behaviour. The
 * floor is a tenth of a hertz because below that a "budget" is a freeze with
 * extra arithmetic, and `freeze` is spelled.
 */
export const HUD_REDRAW_MIN_HZ = 0.1
export const HUD_REDRAW_MAX_HZ = 240

/**
 * `?hudRedraw=` / `__ff2.hud(...)`, parsed. `null` for anything unrecognised.
 *
 * Returns rather than throws, and the caller warns and drops — house style for
 * a DEV switch (`?propLod=`, `?propCells=`): a typo in an env var on a 60-second
 * measurement run should cost a console line, not the run.
 *
 * `live` was accepted and spelled while it was still the default, so a sweep
 * could pass all three arms through one parameter instead of omitting it for
 * one of them — an arm expressed by ABSENCE is the one nobody can check
 * afterwards. DEV-248 makes that foresight load-bearing: `live` is now the arm
 * the shipped default is measured against, and it was already spelled.
 */
export const parseHudRedraw = (raw: string | null | undefined): HudRedraw | null => {
  if (raw === null || raw === undefined) return null
  const text = raw.trim().toLowerCase()
  if (text === '') return null
  if (text === 'live' || text === 'on') return HUD_REDRAW_LIVE
  // The unit comes off FIRST — `10hz` as well as `10`, because the arm reads as
  // a cadence in a shell command and in a trace log and the unit is the half a
  // reader supplies anyway. Before the keyword tests and not after, so that `0`
  // and `0hz` are one answer: a rate of nought taken literally is an interval
  // of Infinity, i.e. a freeze that reports itself as `0hz` — one behaviour
  // under two names, and the e2e mechanism check compares names.
  const bare = text.endsWith('hz') ? text.slice(0, -2).trim() : text
  if (bare === 'freeze' || bare === 'off' || bare === '0') return { kind: 'freeze' }
  // `Number('')` is 0, so a bare `hz` must not fall through as a rate.
  if (bare === '') return null
  const hz = Number(bare)
  if (!Number.isFinite(hz)) return null
  if (hz < HUD_REDRAW_MIN_HZ || hz > HUD_REDRAW_MAX_HZ) return null
  return { kind: 'budget', hz }
}

/**
 * The cadence as one short token — `live`, `freeze`, `10hz`.
 *
 * It is what the probe prints and what the e2e mechanism check compares
 * against, so it round-trips through `parseHudRedraw`: an arm that asked for
 * `10` and reads back `10hz` has to be recognisably the same arm, and a string
 * built ad hoc at each call site is how two spellings of one cadence appear.
 */
export const describeHudRedraw = (redraw: HudRedraw): string =>
  redraw.kind === 'budget' ? `${redraw.hz}hz` : redraw.kind

/** Two policies are the same policy. */
export const sameHudRedraw = (a: HudRedraw, b: HudRedraw): boolean => {
  if (a.kind !== b.kind) return false
  // Narrowed on both sides rather than cast on one: a cast here would keep
  // compiling if a fourth kind with a different payload ever arrives, and
  // would then report two different policies as the same one — which reads as
  // `setRedraw` doing nothing, i.e. an arm that silently never fired.
  if (a.kind !== 'budget' || b.kind !== 'budget') return true
  return a.hz === b.hz
}

/**
 * The gate between "what is drawn changed" and "paint it".
 *
 * Pure, and exported, for the reason `hudSignature` and `plateRows` are:
 * `createHud` needs a 2-D canvas and the unit suite is `environment: 'node'`,
 * so arithmetic that lives inside the factory is arithmetic no node test can
 * reach. `tests/unit/hud-redraw.test.ts` drives this directly.
 */
export interface HudRedrawBudget {
  /** The cadence in force. */
  readonly policy: HudRedraw
  /** Paints admitted so far. */
  readonly repaints: number
  /**
   * Switch cadence. A no-op when the policy is unchanged — `boot/app.ts` calls
   * this every frame so that a course swap and a live `__ff2.hud()` flip both
   * land without a hook, and a no-op is what keeps the pacing state intact
   * across those calls rather than restarting the cadence 90 times a second.
   */
  set(next: HudRedraw): void
  /**
   * Should `draw()` run? `changed` is whether the signature moved; `nowMs` is a
   * monotonic clock in milliseconds.
   *
   * Passed in rather than read here so the budget stays testable without a
   * fake-timer harness, and so that one clock drives the panel and the trace
   * column: two `performance.now()` calls in one frame are two different
   * numbers, and a cadence that paced itself off one while the trace recorded
   * the other would be a rate nobody could reproduce.
   */
  admit(changed: boolean, nowMs: number): boolean
}

export const createHudRedrawBudget = (
  // DEV-248. `HUD_REDRAW_DEFAULT`, not `HUD_REDRAW_LIVE`: the two production
  // call sites (`game/flight.ts`, `game/jumpseat-flight.ts`) both build their
  // panel through `createHud()` with no argument, so this default IS the
  // game's cadence. `boot/app.ts` re-asserts `HUD_REDRAW_PIN` on every frame
  // and the two agree, but the panel must be right on the frame before the
  // first `setRedraw` too — a default of `live` here would make the first
  // frames of every run repaint at the old rate and nothing would say so.
  initial: HudRedraw = HUD_REDRAW_DEFAULT,
): HudRedrawBudget => {
  let policy = initial
  let repaints = 0
  // Not 0 and not `-Infinity`: the first admitted paint must happen whatever
  // the clock reads, and a sentinel that is a NUMBER would make the first
  // decision depend on how long boot took. `null` is "nothing has been painted
  // yet", which is the question the first frame actually asks.
  let lastPaintMs: number | null = null

  const paint = (nowMs: number): boolean => {
    repaints += 1
    lastPaintMs = nowMs
    return true
  }

  return {
    get policy() {
      return policy
    },
    get repaints() {
      return repaints
    },
    set(next) {
      if (sameHudRedraw(policy, next)) return
      policy = next
      // A cadence that has just been switched on paints at the next change
      // rather than waiting out the old one's interval — an arm flipped on a
      // live page must show its first frame immediately or the operator cannot
      // tell "applied" from "applied and idle".
      lastPaintMs = null
    },
    admit(changed, nowMs) {
      // **The signature is checked every frame, at every cadence.** The budget
      // gates the PAINT, never the comparison: a panel that skipped the compare
      // would hold whatever value happened to be current at the tick and could
      // sit a whole interval behind a number that had already moved twice.
      if (!changed) return false
      if (policy.kind === 'freeze') return repaints === 0 ? paint(nowMs) : false
      if (policy.kind === 'live') return paint(nowMs)
      if (lastPaintMs === null) return paint(nowMs)
      // `>=`, so a cadence that lands exactly on its interval is admitted. The
      // guarantee this gives is the one worth asserting: **no two paints are
      // closer together than `1000 / hz` ms**, which implies "at most `hz` a
      // second" and is true of every frame stream rather than of a tidy one.
      return nowMs - lastPaintMs >= 1000 / policy.hz ? paint(nowMs) : false
    },
  }
}

// ── DEV-244: the uploads that REMAIN, made cheap ───────────────────────────
//
// **DEV-243's budget is the MEDIAN lever; this is the TAIL lever**, and wave 4
// §3.8 measured the difference rather than arguing it. On `int_01_hoverJet`,
// `?hudRedraw=10` takes GPU p50 from 6.17 to 4.22 — 95 % of everything
// `?hudRedraw=freeze` buys — and p95 from 7.77 to only 7.16, which is 46 %.
//
// **That asymmetry is structural and not a defect in the budget.** At 9.2 Hz on
// a 70 fps flight, 13 % of frames still carry an upload, and the 95th-percentile
// frame is BY DEFINITION one of the frames that did the expensive thing.
// Rate-limiting makes the cost rarer; it cannot make the rare frame cheap — and
// the pass rule is on p95. So the two halves of this fix attack two different
// statistics and both are wanted.
//
// ── The four candidates, priced in BYTES and in three's own calls ─────────
//
// The steady state of a `CanvasTexture` upload in three 0.185.1, read out of
// `node_modules/three/build/three.module.js` rather than remembered:
// `:11919` takes the branch on `source.version`; `:11952` `useTexStorage` is
// true for anything that is not a `VideoTexture`; **`:11953` `allocateMemory`
// is `sourceProperties.__version === undefined || forceUpload`, so
// `texStorage2D` happens ONCE** and every later frame is `:11931`'s
// `pixelStorei(UNPACK_FLIP_Y_WEBGL, …)`, `:12382`'s
// `texSubImage2D(TEXTURE_2D, 0, 0, 0, glFormat, glType, <the canvas>)` and
// `:12396`'s unconditional `generateMipmap`. Two GL calls and one pixel store.
//
// 560 x 203 at RGBA8 is **454,720 B** of level 0, and the chain levels 1..9
// (280x101 down to 1x1) are **150,332 B**, which is 33.06 % of it — the 1/3
// limit a 2-D mip chain converges to, and the "about a third as much again"
// DEV-243 wrote down.
//
//  (a) `generateMipmaps = false` + `LinearFilter` — removes **one driver call
//      per upload** (`generateMipmap`) and the nine dependent filter passes
//      behind it, which write **150,332 B** and read four times that. It also
//      takes the one-off `texStorage2D` from 10 levels to 1, so **-150,332 B of
//      VRAM**. It removes NONE of the 454,720 B that cross per upload. BUILT.
//  (b) a smaller canvas — the only candidate that removes level-0 bytes, and it
//      removes them proportionally: 1400 px/m -> 700 would be 280 x 102 =
//      114,240 B, a **74.9 % cut** of the upload and of the chain together. It
//      is also the most direct pixel cost on this page — the text loses half its
//      resolution at EVERY pose, where (a) can only matter where the panel is
//      minified. NOT BUILT; see the row's §6.
//  (c) `texSubImage2D` of the dirty rows — the speed row is y 140..203 of 203,
//      so 63 rows x 560 = **141,120 B, 31 % of level 0**. But three has no
//      partial-canvas path: `:12382` is the 7-argument DOM-source overload,
//      which uploads the whole element, and `:12396`'s `generateMipmap` is
//      unconditional, so a sub-rectangle saves the smaller half and leaves the
//      chain. It also means owning `__version` and issuing raw GL. NOT BUILT.
//  (d) `UNPACK_FLIP_Y` avoidance — **removes zero bytes.** `:11931` is a
//      `pixelStorei` on the same call, not a pass of its own; the same 454,720 B
//      cross either way, and whether the driver's flip is free is a claim about
//      Chromium that cannot be read out of three. Nothing to price. NOT BUILT.
//
// ── And the bytes are not the cost, which is why (a) goes first ───────────
//
// 454,720 B in the 2.06 ms §3.8 measured is **216 MB/s** — two orders of
// magnitude under any bus. So the upload is not bandwidth-bound, and DEV-243
// already named what it is: the canvas was written THIS FRAME, so the upload
// has to resolve the 2-D backend's pending commands first, and `generateMipmap`
// then adds nine more GPU passes that depend on the level 0 that just landed.
// (a) is the candidate that removes a whole driver-scheduled operation rather
// than a few hundred kilobytes, which is the term that can plausibly be 0.7 ms.
//
// ── THE THING THE BRIEF HAD WRONG: `LinearFilter` kills the anisotropy TOO ─
//
// `three.module.js:11701`, inside `setTextureParameters`:
//
//     if ( texture.minFilter !== NearestMipmapLinearFilter &&
//          texture.minFilter !== LinearMipmapLinearFilter ) return;
//
// three returns from that function BEFORE `:11707`'s
// `texParameterf(TEXTURE_MAX_ANISOTROPY_EXT, …)`. So anisotropic filtering in
// three is available only with a mipmap-LINEAR minification filter, and
// `minFilter = LinearFilter` does not merely lose the chain — **it silently
// loses `anisotropy = 4` as well.** This panel is raked and read at a glance,
// and those are the two filters that were paying for that.
//
// Which is why `hudTextureState` sets `anisotropy: 1` under `nomip` rather than
// leaving the 4 in place. A field that says 4 on a texture three will never
// call `texParameterf` for is a claim the GPU does not honour, and this repo's
// own lesson is that a configured-looking value nothing reads is documentation
// and not a guard (CLAUDE.md, DEV-069). `tests/unit/hud-upload.test.ts` reads
// that guard out of three's own build and fails if the rule moves or if somebody
// puts the 4 back.
//
// ── A live flip is SAFE, and that is also read out of three ───────────────
//
// `getTextureCacheKey` (`:11533`) hashes `minFilter`, `anisotropy`,
// `generateMipmaps` and `flipY` among others, so changing any of them makes
// `textureCacheKey !== __cacheKey`, which creates a NEW `WebGLTexture`, sets
// `forceUpload = true`, and therefore `allocateMemory = true` — a fresh
// `texStorage2D` at the new level count, with the old texture deleted once its
// `usedTimes` reaches zero. Immutable storage is not a barrier to an arm that
// flips on a live page, which is what `perf-protocol.md` §3a-ter needs.
//
// Off by default: `mip` is the shipped panel, byte for byte and pixel for pixel.

/**
 * How the panel's texture is uploaded. `mip` is what shipped.
 *
 * `nomip` drops the mip chain — and, because three ties the two together
 * (`:11701`), the anisotropy with it. See the block above.
 */
export type HudUpload = { readonly kind: 'mip' } | { readonly kind: 'nomip' }

/** The shipped upload: a full chain, regenerated on every upload, 4x aniso. */
export const HUD_UPLOAD_MIP: HudUpload = { kind: 'mip' }

/**
 * The shipped anisotropy. Exported so the test that reads three's rule can name
 * the value it is arguing about instead of writing `4` a third time.
 */
export const HUD_ANISOTROPY = 4

/** RGBA8. Named because every byte figure in this file is derived from it. */
export const BYTES_PER_TEXEL = 4

/**
 * `?hudUpload=` / `__ff2.hudUpload(...)`, parsed. `null` for anything
 * unrecognised, which the caller warns about and drops — house style for a DEV
 * switch, and the same contract `parseHudRedraw` has.
 *
 * **`on`, `off`, `live` and `freeze` are REFUSED, deliberately.** There are now
 * two pins on this one panel and the other one already spells `off`, where it
 * means a FREEZE — no repaints at all. `?hudUpload=off` would read to a person
 * as "no uploads" and to this parser as "the optimisation is off", i.e. the
 * SHIPPED path: one word, two pins, opposite meanings. DEV-243's parse has the
 * mirror image of this lesson written into it (`0` and `0hz` must be one
 * answer); this is the case where two spellings must NOT be made one, and
 * `tests/unit/hud-upload.test.ts` asserts the refusal by name so that nobody
 * later adds the alias as a kindness.
 *
 * `mip` is accepted and spelled even though it is the default, for
 * `parseHudRedraw`'s reason: an arm expressed by ABSENCE is the one nobody can
 * check afterwards.
 */
export const parseHudUpload = (raw: string | null | undefined): HudUpload | null => {
  if (raw === null || raw === undefined) return null
  // Hyphens and the plural come off first, so `no-mips`, `nomip` and `noMipMaps`
  // are one answer — the same reason `parseHudRedraw` takes the unit off before
  // the keyword tests. A spelling a shell command can plausibly carry has to
  // compare equal to what the probe prints, or the mechanism check refuses its
  // own arm.
  const text = raw.trim().toLowerCase().replaceAll('-', '').replaceAll('_', '')
  if (text === '') return null
  if (text === 'mip' || text === 'mips' || text === 'mipmap' || text === 'mipmaps') {
    return HUD_UPLOAD_MIP
  }
  if (
    text === 'nomip' ||
    text === 'nomips' ||
    text === 'nomipmap' ||
    text === 'nomipmaps' ||
    text === 'nochain'
  ) {
    return { kind: 'nomip' }
  }
  return null
}

/**
 * The mode as one short token — `mip`, `nomip`.
 *
 * Round-trips through `parseHudUpload`, so the e2e mechanism check can compare
 * an ask against a reading by STRING and an arm that asked for `no-mips` is
 * recognisably the arm that reports `nomip`.
 */
export const describeHudUpload = (upload: HudUpload): string => upload.kind

/** Two upload modes are the same mode. */
export const sameHudUpload = (a: HudUpload, b: HudUpload): boolean => a.kind === b.kind

/**
 * The three texture fields the mode sets, as a plain record.
 *
 * Pure and exported for the reason `hudSignature` and `createHudRedrawBudget`
 * are: `createHud` needs a 2-D canvas and the unit suite is
 * `environment: 'node'`, so state that lives inside the factory is state no node
 * test can reach. The suite asserts the DEFAULT here is byte-for-byte the panel
 * that shipped, and that `nomip`'s anisotropy is 1 for the reason three's own
 * `:11701` gives.
 */
export interface HudTextureState {
  readonly generateMipmaps: boolean
  readonly minFilter: THREE.MinificationTextureFilter
  readonly anisotropy: number
}

export const hudTextureState = (upload: HudUpload): HudTextureState =>
  upload.kind === 'nomip'
    ? // `anisotropy: 1`, not 4 — three refuses to set TEXTURE_MAX_ANISOTROPY_EXT
      // for a minFilter that is not one of the two mipmap-linear ones
      // (`:11701`), so a 4 here would be a number on the object that never
      // reaches the sampler.
      { generateMipmaps: false, minFilter: THREE.LinearFilter, anisotropy: 1 }
    : {
        generateMipmaps: true,
        // three's own `CanvasTexture` default, written out rather than left
        // implicit: this is the state the mode RESTORES on a flip back, and a
        // restore that relies on a constructor default restores whatever three
        // changes that default to.
        minFilter: THREE.LinearMipmapLinearFilter,
        anisotropy: HUD_ANISOTROPY,
      }

/**
 * Which mode a LIVE texture is in, read off its own fields, or null if it is in
 * neither.
 *
 * DEV-232 and DEV-237's discipline: the probe reports the INTENT and this,
 * separately, so a pin that never reached the panel reads as a disagreement
 * rather than as an echo. Null is the honest third answer — it means something
 * outside this module has set a combination no mode produces, which is a
 * finding and not a pass.
 */
export const classifyHudTexture = (live: HudTextureState): HudUpload | null => {
  for (const mode of [HUD_UPLOAD_MIP, { kind: 'nomip' } as const]) {
    const want = hudTextureState(mode)
    if (
      want.generateMipmaps === live.generateMipmaps &&
      want.minFilter === live.minFilter &&
      want.anisotropy === live.anisotropy
    ) {
      return mode
    }
  }
  return null
}

/**
 * How many mip levels a `width x height` texture has — counted by HALVING,
 * because that is what the driver does.
 *
 * Deliberately NOT `Math.floor(Math.log2(Math.max(w, h))) + 1`, which is three's
 * own closed form at `:11301`. A test that re-derives its expectation the way
 * the code does has not tested the code (CLAUDE.md, trap 24), so the suite
 * computes the closed form and asserts the two agree — two algorithms, one
 * answer, and a disagreement is a real finding about a non-power-of-two panel.
 */
export const mipChainLevels = (width: number, height: number): number => {
  let w = Math.max(1, Math.floor(width))
  let h = Math.max(1, Math.floor(height))
  let levels = 1
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
    levels += 1
  }
  return levels
}

/**
 * Bytes in levels 1..n — what `generateMipmap` writes on top of level 0, and
 * what `nomip` removes.
 *
 * Not the level-0 bytes: those cross the bus either way, and conflating the two
 * is how a saving gets quoted as 600 KB when it is 150 (DEV-027 — say what the
 * number is the bytes OF).
 */
export const mipChainBytes = (width: number, height: number): number => {
  let w = Math.max(1, Math.floor(width))
  let h = Math.max(1, Math.floor(height))
  let bytes = 0
  while (w > 1 || h > 1) {
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
    bytes += w * h * BYTES_PER_TEXEL
  }
  return bytes
}

/** Everything one upload moves in this mode: level 0, plus the chain if there is one. */
export const hudUploadBytes = (width: number, height: number, upload: HudUpload): number =>
  Math.max(1, Math.floor(width)) * Math.max(1, Math.floor(height)) * BYTES_PER_TEXEL +
  (upload.kind === 'mip' ? mipChainBytes(width, height) : 0)

// ── DEV-250: the FIRST raster at the flight layout, paid under the curtain ─
//
// **The frame the player is released into flight costs ~25 ms that is not
// rendering.** Measured on `rookie_01_hoverJet`: the release frame is dt
// 27.7 ms of which 2.00 ms is inside `renderer.render`, and a Chrome trace
// with GPU categories names the rest — `RasterDecoderImpl::DoEndRasterCHROMIUM
// ::Flush`, 26.75 ms, **in the GPU process**, while the renderer's main thread
// runs an ordinary 9 ms frame. `?hudRedraw=freeze` takes that frame to 11.1 ms
// and the longest raster slice from 27.05 to 16.45, so it is this canvas.
// `docs/plan/HUD-REWORK.md` has the trace and the A/B; §4 candidate 1 is this.
//
// ── Why the RELEASE frame and not any other ───────────────────────────────
//
// Because it is the first raster of a materially different picture, and the
// arithmetic says which part of it is new. Every font size in `draw()` is
// derived from `h`, the canvas HEIGHT, which is a constant 203:
//
//     gap  = h * 0.035              =   7.105
//     rowH = (h - gap * 2) / 3      =  62.93
//
//     the launch banner   font(h * 0.7)      = 142 px   (a 1-2 char countdown)
//                         font(h * 0.3)      =  61 px   (a phrase)
//     the three rows      font(rowH * 0.62)  =  39 px
//     the corner badges   font(rowH * 0.34)  =  21 px
//     the event line      font(rowH * 0.50)  =  31 px   (<= 12 chars)
//                         font(rowH * 0.34)  =  21 px   (longer)
//
// **The whole lift ride paints 142 px and 61 px, and nothing else.** Skia keys
// a rasterised glyph on face + size + style, so the ride warms two strikes the
// flight never uses and none of the two it does. At release the panel switches
// to the three-row layout and asks the backend, for the first time in the run,
// for 39 px and 21 px Segoe UI italic 700 — a new strike, new glyph images and
// the atlas pages behind them, inside the flush the upload is waiting on.
//
// That is a claim about a mechanism and not a measurement, so it is stated as
// one. What is NOT a hypothesis is the part the arithmetic settles: the ride's
// sizes and the flight's sizes are different numbers, they are different
// numbers on every host because `h` is a constant, and therefore **nothing the
// ride paints can warm what the flight paints.** Whatever the first flight
// raster has to build — the strike, an atlas page, a path program, or all
// three — a draw at the flight layout is the thing that builds it.
//
// ── What `warm()` is, and the two things it must NOT do ───────────────────
//
// `render/warm-up.ts`'s `warmWorld` already draws the world once, for real,
// behind the loading curtain, so the first live frame pays nothing for a
// shader compile. This is the same move for the same reason: paint the panel
// at its flight layout, and let the warm draw upload it, while the frame is
// black. `Hud.warm` is the paint half; `warmWorld`'s `show` option is what
// puts the panel in that draw.
//
//  1. **It does not go through the redraw budget.** `HUD_REDRAW_DEFAULT` is
//     10 Hz and `createHudRedrawBudget().admit` refuses any paint inside
//     100 ms of the last one. A warm paint that recorded itself as a paint
//     would push the first LIVE paint — the launch banner — into `owed` and
//     hold it for up to an interval. `warm()` calls `draw()` directly and
//     never touches `lastPaintMs`, so the budget still admits the banner on
//     the frame it first arrives, exactly as it does today.
//  2. **It does not advance the signature.** `update()`'s first call must see
//     `changed === true` and repaint, or the panel would sit at the warm
//     picture for the whole ride. `warm()` leaves `signature` alone, so the
//     first live `update()` compares a flight layout against `''` and paints.
//
// The panel is therefore behind the curtain twice over: the canvas carries the
// warm picture only until the first `update()`, and that update happens on a
// frame the loading fade is still covering. **No pixel changes at rest.**

/**
 * The state to warm with — three rows, every optional branch on, and digits
 * that between them cover every glyph a flight row can print.
 *
 * `labels` and nothing else, because this panel is a pure consumer of
 * `HudState` and stays one (see the module header): the caller knows which
 * mission is loading and hands over its copy; this function knows what
 * `draw()` branches on and fills in the rest. Neither half is guessable from
 * the other, which is why it is a parameter rather than a constant.
 *
 * **Every field is chosen to make `draw()` take a branch, not to look
 * plausible.** `banner` is null or the early return warms the ride's layout
 * again; `chain`, `energy`, `autopilot`, `multiplier` and `award`
 * are all present so the bars, the corner and the event line are drawn. That
 * makes this the state with the LARGEST `hudCanvasOps` the function can
 * return, which is the property `tests/unit/hud-warm.test.ts` asserts against
 * a battery of real flight states — a warm that asked for less than the flight
 * does would warm the wrong thing and still report success.
 *
 * The numbers carry the digits: `12/34` on the count row, `567` on the clock
 * and `890` on the speed, so all ten digits and the `/` are rasterised at
 * 39 px. A glyph the warm misses costs its own rasterisation on first sight,
 * which is one glyph rather than a strike — small, and free to avoid.
 */
export interface HudWarmLabels {
  readonly countLabel: string
  readonly timeLabel: string
  readonly speedLabel: string
  /** The live preset's unit — `km/h` puts four more glyphs on the speed row. */
  readonly speedUnit?: SpeedUnitId
}

export const warmHudState = (labels: HudWarmLabels): HudState => ({
  // `12/34` — four digits and the slash, through `pad2`, which can only add a
  // leading `0` and never remove a digit.
  ringsPassed: 12,
  ringsTotal: 34,
  score: 0,
  // `formatTime(567.4, 890, false)` is `'567'`. `timeLimit` is positive so the
  // row is a NUMBER and not `--`, and `countDown` is false so it is the floor
  // rather than the remainder: the two branches print the same glyph set at
  // the same size, and only the size is what a strike is keyed on.
  elapsed: 567.4,
  timeLimit: 890,
  timeCountsDown: false,
  // `890` in m/s, `3205 km/h` in the other unit — which also warms the space,
  // the slash and the lowercase k, m and h that Anniversary's row carries.
  speed: 890.4,
  // `?? 'ms'` rather than a conditional spread: `formatSpeed`'s own default is
  // `'ms'`, so a present `'ms'` and an absent field draw the same row, and
  // `exactOptionalPropertyTypes` makes the explicit `undefined` illegal anyway.
  speedUnit: labels.speedUnit ?? 'ms',
  medal: '',
  finished: false,
  // Short enough (<= 12) to take the event line's 31 px branch, and it carries
  // the ten digits again at that size. `finished` stays false: the medal path
  // and the award path draw the same line and only one can be warmed here.
  award: '+1234567890',
  awardTone: 'gain',
  // > 1, or the corner draws nothing.
  multiplier: 2,
  // Mid-range rather than 0 or 1: a zero fraction draws the chain's track and
  // not its fill.
  chain: { stacks: 2, fraction: 0.5 },
  energy: { fraction: 0.5, available: true },
  countLabel: labels.countLabel,
  timeLabel: labels.timeLabel,
  speedLabel: labels.speedLabel,
  // THE ONE FIELD THAT DECIDES WHETHER THIS WARMS ANYTHING AT ALL. A banner
  // takes `draw()`'s early return and repaints the ride's own layout.
  banner: null,
  autopilot: true,
})

/**
 * `?hudWarm=on` / `?hudWarm=off`, parsed. `null` for anything unrecognised,
 * which the caller warns about and drops — the contract `parseHudUpload` and
 * `parseHudRedraw` both have.
 *
 * **Default OFF**, and it stays off until both arms have been measured on a
 * quiet box. DEV-248 is the precedent: it moved the redraw default only once
 * the arms had been run, and verified it "with the arms reversed so the
 * shipped path is the one that was measured".
 *
 * `off` is accepted and spelled even though it is the default, for
 * `parseHudRedraw`'s reason — an arm expressed by ABSENCE is the one nobody
 * can check afterwards. Unlike `?hudUpload=`, `on` and `off` are safe here:
 * this pin is a boolean and there is only one reading of either word.
 */
/**
 * DEV-250 SHIPS ON, 2026-09-20 — Matt: *"default settings should = super fast
 * framerate"*, on the measurement below.
 *
 * Twelve bracketed rows, `rookie_01_hoverJet`, serial on a quiet box. The
 * statistic is **the worst frame in the release window** (the first `flying`
 * frame and the forty after it), which is the one number in this programme
 * that repeats: three runs of an arm land within about a millisecond, where
 * the whole-trace MAXIMUM spanned 27.60–34.05 on one arm and had to be
 * abandoned.
 *
 *     live, shipped          32.1 · 33.4 · 33.3 ms
 *     ?hudWarm=on            11.2 · 11.2
 *     ?hudRedraw=freeze      11.0 · 11.1 · 11.1      <- the floor
 *
 * **The warm draw reaches the floor exactly.** It takes the frame the player
 * is released into flight from ~33 ms to 11.2 — which is the hitch Matt
 * reported as *"the app locks to 45 Hz just after the lift reaches the top"* —
 * and it does it by paying that raster under the loading curtain instead.
 *
 * It **costs no pixel** (`tests/e2e/hud-warm-pixels.spec.ts` photographs it)
 * and **no program** — the DEV-117 guard runs with the arm on and reports
 * `94 -> 94`, with geometries 38 against the control's 37, because `show` adds
 * a draw and not a material.
 *
 * `?hudWarm=off` is the arm that goes back, and it is spelled rather than
 * expressed by absence for `parseHudRedraw`'s reason.
 *
 * **What this does NOT fix**, so nobody reads it as more than it is: the warm
 * draw removes the ONE expensive first raster and leaves the thirteen cheap
 * ones — the slice count is unchanged at 14 and the median slice is unchanged
 * at ~0.5 ms. The steady-state cost is `?hudRaster=cpu`'s subject (DEV-256,
 * built, measured, still OFF) and it cannot be measured on this box at all,
 * because the flat frame is vsync-capped with ~3.5 ms of slack for it to hide
 * in. That is a headset question — DEV-254.
 */
export const HUD_WARM_DEFAULT = true

export const parseHudWarm = (raw: string | null | undefined): boolean | null => {
  if (raw === null || raw === undefined) return null
  const text = raw.trim().toLowerCase()
  if (text === '') return null
  if (text === 'on' || text === '1' || text === 'true' || text === 'yes') return true
  if (text === 'off' || text === '0' || text === 'false' || text === 'no') return false
  return null
}

/** The pin as one short token, so an ask and a reading compare by string. */
export const describeHudWarm = (warm: boolean): string => (warm ? 'on' : 'off')

// ── DEV-244: what ONE repaint asks of the 2-D backend ──────────────────────
//
// **The hypothesis this exists to test, and it is a hypothesis.** Freezing the
// same panel on two missions, same build, same session (wave 4, after §3.8):
//
//   int_01_hoverJet   freeze Δp50 −2.13   0.65 repaints/frame
//   adv_02_jumpSeat   freeze Δp50 −0.21   0.27 repaints/frame
//
// Ten times the median cost for 2.4 times the repaints, on an identical
// 560 × 203 panel — so **~4.2× of it is in what ONE upload costs**, which is
// the quantity DEV-243's budget cannot touch and DEV-244's whole subject.
//
// One candidate mechanism: an upload must first resolve the 2-D backend's
// pending commands, so a repaint that asked more of the canvas would cost more
// to upload even though the same bytes move. If that is it, the per-upload cost
// tracks CANVAS OPERATIONS per repaint rather than pixels, and removing
// `generateMipmap` would be additive with it rather than a substitute for it.
//
// **And this function's own arithmetic probably kills that candidate**, which
// is why it is worth having before anyone measures. See the ledger row's
// hypothesis section: a HoverJet panel in flight and a JumpSeat one differ by
// about two calls in twenty-five, not by a factor of four. The TIME row is not
// the difference some readings of DEV-201 suggest — `formatTime` returns `--`
// where there is no clock and the row is still DRAWN, so what DEV-201 buys is
// an entry that never MOVES, which is a fact about the repaint RATE and not
// about the work inside a repaint.
//
// So: pure, exported, and checked against a real `draw()` through a counting
// canvas rather than trusted. `tests/unit/hud-upload.test.ts` drives the actual
// panel through a stub that counts every context call and asserts this function
// predicted it, for states covering both vehicles — because a prediction of
// what `draw()` does, written beside `draw()`, is exactly the thing that drifts.

/**
 * A repaint's demand on the 2-D context, in CALLS. Never a duration.
 *
 * `total` counts every context METHOD call — properties like `fillStyle` and
 * `font` are assignments and are not in it. `texts` and `measures` are called
 * out because they are the two that make the backend lay text out, and
 * `measureText` is a READ, which is the kind of call that can force the
 * backend to resolve what it has queued.
 */
export interface HudCanvasOps {
  readonly total: number
  readonly texts: number
  readonly measures: number
}

/**
 * What `draw()` will ask of the canvas for this state, without drawing it.
 *
 * Mirrors `draw()` branch for branch. That mirroring is a liability and it is
 * held by a test that counts the real thing (see the block above) rather than
 * by care.
 */
export const hudCanvasOps = (state: HudState, gauges: HudGauges = HUD_GAUGES_OFF): HudCanvasOps => {
  // DEV-257. The three bars leave the canvas when the gauges are on, and this
  // prediction has to leave with them or the test that holds the two together
  // starts reporting a drift that is really its own.
  const bars = !hudGaugesOn(gauges)
  let total = 1 // clearRect, at the top of every draw
  let texts = 0
  let measures = 0
  /** `beginPath` + `roundRect` + `fill` + `stroke` — one rounded plate. */
  const plate = () => {
    total += 4
  }
  const text = () => {
    total += 1
    texts += 1
  }
  const measure = () => {
    total += 1
    measures += 1
  }

  // The launch banner REPLACES the panel and returns early.
  if (state.banner) {
    plate()
    text()
    return { total, texts, measures }
  }

  // Three stacked rows, each a plate with a label and a value — except that
  // the SPEED row loses its value under `bar-only` / `needle-only`, where the
  // gauge IS the reading (DEV-257).
  const digits = !hudGaugesOn(gauges) || hudGaugesKeepDigits(gauges)
  // DEV-397: an event takes the count row's LABEL slot, measured against the
  // count (one read) and fitted (another), and repaints nothing.
  const shown = state.award ?? (state.finished ? state.medal : '')
  const event = Boolean(shown) && shown.toLowerCase() !== 'none'
  for (let i = 0; i < 3; i++) {
    plate()
    if (i === 0 && event) {
      measure()
      measure()
    }
    text()
    if (i !== 2 || digits) text()
  }

  // DEV-615: the gate combo's countdown on the count row, `paintChain`'s count.
  if (bars && state.chain && state.chain.stacks > 0) total += chainRects(state.chain.fraction)
  if (bars && state.energy) {
    // The track, the fill, and DEV-567's threshold mark: `paintTank`'s own count.
    total += tankRects(state.energy)
    text() // DEV-410 follow-up: the tank's word, inside the track
  }

  // The badges, as one run on the time row: the clock and its label are
  // measured so the run starts and ends in the room between them (DEV-397).
  if (hudBadges(state).length > 0) {
    measure()
    measure()
    text()
  }
  return { total, texts, measures }
}

/** Nothing drawn yet — what `report()` says before the first repaint. */
const NO_CANVAS_OPS: HudCanvasOps = { total: 0, texts: 0, measures: 0 }

// ── DEV-256: which PROCESS rasterises the panel ────────────────────────────
//
// DEV-243 made the uploads rarer and DEV-244 made each one carry less. This is
// the third lever and it is the only one that questions the PIPELINE: what if
// neither the rate nor the bytes is the cost?
//
// ── The arithmetic that says the panel's own work is a rounding error ─────
//
// From `docs/plan/HUD-REDESIGN.md` §3.1, which re-derives it rather than
// quoting DEV-244:
//
//   * NOT bandwidth. 454,720 B in the 2.06 ms wave 4 measured is **216 MB/s**,
//     two orders of magnitude under any bus. (DEV-244's block says this too.)
//   * NOT the drawing. `hudCanvasOps` above predicts **19 to 26 context calls**
//     per repaint, on a 560 x 203 = **113,680-pixel** surface. Call it 22 calls
//     in 2.1 ms and that is **~95 microseconds per call**. A rounded-rect fill
//     on a postage stamp does not cost 95 us anywhere; Skia rasterises this
//     whole canvas in software in well under a millisecond.
//
// So essentially all of the 2.1 ms is OVERHEAD, and the lever is which pipeline
// the pixels travel through — not how many there are.
//
// ── The hypothesis, and what would falsify it ────────────────────────────
//
// **H: the cost is a SYNCHRONISATION with work already queued in the GPU
// process, so it scales with how much GPU work the frame has queued ahead of
// it — not with the panel's pixels, bytes, or draw calls.**
//
// `canvas.getContext('2d')` gives a GPU-ACCELERATED canvas in Chromium: the 2-D
// commands are recorded and rasterised out of process, and `texSubImage2D(<the
// canvas>)` cannot proceed until that raster has landed. The Chrome trace names
// the slice `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`, **in the GPU
// process**, at 26.75 ms on the release frame while the renderer's main thread
// runs an ordinary 9 ms. A `Flush` is what waiting looks like.
//
// H also explains the one thing wave 4 flagged as unexplained: the same panel
// with the same bytes costs **ten times more on `int_01_hoverJet` than on
// `adv_02_jumpSeat` for 2.4x the repaints** (§3.8, and DEV-244's block above
// reads that same pair as a per-upload cost). Under H it is not a property of
// the panel at all — it is a property of how much GPU work each mission has in
// flight when the upload asks to sync.
//
// The alternative is *"the raster is intrinsically expensive"*, and **both
// explain every reading taken so far** — which is exactly the situation
// DEVIATIONS.md's agreement lesson says has not been tested. DEV-255 is the arm
// that separates them by varying the frame's queued work; THIS row is the
// remedy H implies, and it is built as an arm rather than as a default because
// it is a candidate and not a conclusion.
//
// ── What `willReadFrequently` actually asks for ──────────────────────────
//
// It is a HINT that means *do not use the GPU for this canvas*: keep the
// backing store in CPU memory so that `getImageData` does not have to read back
// across the process boundary. Its documented use is readback, and we do not
// read this canvas back at all — but the side effect is the whole point here,
// because a CPU-backed canvas has **no cross-process raster to wait for**.
// `texSubImage2D` from it is an ordinary upload out of system memory.
//
// **And the reported risk is real and points the other way.** Practitioners
// measuring the hint on large, heavily drawn canvases report the readback
// getting faster (~3 ms to ~1 ms) while **the draw side pays a much larger
// penalty**. Those reports are about canvases nothing like this one: ours is
// 113,680 pixels and ~22 calls, where a software raster should be a fraction of
// a millisecond. So the published penalty is a reason to MEASURE this rather
// than a reason to skip it — and it is the reason `gpu` stays the default until
// a number says otherwise. **No duration in this row has been measured.**
//
// ── Why this could not be a per-frame setter like `setUpload` ────────────
//
// `getContext` options are honoured **only on the first call for a given
// canvas**: every later `getContext('2d', ...)` returns the SAME context object
// and silently ignores the arguments. So unlike DEV-244's three texture fields,
// this is not a property of a live object that can be written — the mode is
// baked into the canvas at the moment it is created. Two consequences, and both
// shape the code below:
//
//   1. `createHud` has to take the mode as an ARGUMENT, which is why it now
//      does. The default keeps every existing caller and every screenshot
//      builder working unchanged, the same courtesy `update(state, nowMs =
//      performance.now())` pays.
//   2. A LIVE flip means building a NEW canvas and a NEW `CanvasTexture`,
//      pointing the material at it and disposing the old one — see
//      `setRaster`, which is where the care is.

/**
 * Which backend rasterises the panel's 2-D canvas.
 *
 * `cpu` asks Chromium for a software canvas via
 * `getContext('2d', { willReadFrequently: true })`, and **`cpu` is what
 * ships** — DEV-256 since 2026-09-20. `gpu` shipped before it and is the way
 * back. This line said "`gpu` is what shipped" for a day after it stopped
 * being true; the answer is `HUD_RASTER_SHIPPED` below, not prose here.
 */
export type HudRaster = { readonly kind: 'gpu' } | { readonly kind: 'cpu' }

/** A GPU-accelerated 2-D canvas, rastered out of process. Shipped until DEV-256. */
export const HUD_RASTER_GPU: HudRaster = { kind: 'gpu' }

/** `willReadFrequently`, which asks Chromium not to use the GPU. Shipped since DEV-256. */
export const HUD_RASTER_CPU: HudRaster = { kind: 'cpu' }

/**
 * **WHICH RASTER SHIPS — and this line is the ONLY place that says so.**
 * DEV-266, and it exists because the alternative was measured in a red gate.
 *
 * DEV-256 shipped `cpu` on 2026-09-20 (`07bf549`; the argument is the block on
 * `HUD_RASTER_PIN` in `boot/app.ts` — the app is 9 % over the 90 Hz GPU budget
 * and a software canvas trades GPU for main thread). That commit moved the
 * default by editing ONE `??` in `boot/app.ts`, and three other places went on
 * saying `gpu`: the sentence under `createHud` below, the unit describe that
 * called itself *"the SHIPPED panel, pinned"*, and
 * `tests/e2e/hud-upload-pixels.spec.ts`, which asserted the shipped arm as a
 * string literal and **had been red on `main` ever since**.
 *
 * So the default is a NAMED EXPORT rather than a literal at each site:
 *
 *   * `createHud()` with no `raster` falls back to it, so the library default
 *     and the boot default cannot be two different answers;
 *   * `boot/app.ts`'s pin falls back to it, so `?hudRaster=` unset IS this;
 *   * the e2e spec IMPORTS it instead of spelling an arm, so a spec cannot
 *     encode a default that has moved;
 *   * `tests/unit/hud-raster.test.ts` pins its VALUE against the ledger.
 *
 * That last one is the point and it is CLAUDE.md's rule about derivable
 * numbers in its other form: everything that can be derived from this
 * constant is, and the ONE place that cannot be — what it should be — is
 * asserted somewhere a person has to edit on purpose. Flipping the default is
 * then this line plus one unit assertion, and every other site follows.
 *
 * `?hudRaster=gpu` remains the way back at runtime.
 */
export const HUD_RASTER_SHIPPED: HudRaster = HUD_RASTER_CPU

/**
 * The context options each mode asks `getContext('2d', ...)` for.
 *
 * Pure and exported for the reason `hudTextureState` is: `createHud` needs a
 * 2-D canvas and the unit suite is `environment: 'node'`, so a decision made
 * inside the factory is a decision no node test can reach. The suite asserts
 * that `gpu` passes the hint as FALSE rather than omitting it — see below.
 *
 * **`gpu` spells the option out rather than passing `undefined`.** Omitting it
 * and passing `{ willReadFrequently: false }` are the same thing to the spec,
 * and writing it makes the shipped arm a thing `getContextAttributes()` can
 * report on: an arm expressed by absence is the one nobody can check
 * afterwards, which is DEV-244's own reason for accepting `?hudUpload=mip`.
 */
export const hudContextOptions = (raster: HudRaster): CanvasRenderingContext2DSettings => ({
  willReadFrequently: raster.kind === 'cpu',
})

/**
 * `?hudRaster=` / `__ff2.hudRaster(...)`, parsed. `null` for anything
 * unrecognised, which the caller warns about and drops — house style for a DEV
 * switch, and the contract `parseHudRedraw` and `parseHudUpload` both have.
 *
 * **`on`, `off`, `live` and `freeze` are REFUSED, for DEV-244's reason and now
 * with a third pin on the same panel making it sharper.** `?hudRedraw=off`
 * already means a freeze — no repaints at all — so `?hudRaster=off` would read
 * to a person as "no raster" and to a parser as "the arm is off", i.e. the
 * SHIPPED path. One word meaning opposite things on three pins of one panel is
 * a trap rather than a convenience, and `tests/unit/hud-raster.test.ts` asserts
 * the refusal by name so nobody later adds the alias as a kindness.
 *
 * `gpu` is accepted and spelled even though it is the default, for the same
 * reason `mip` and `live` are.
 */
export const parseHudRaster = (raw: string | null | undefined): HudRaster | null => {
  if (raw === null || raw === undefined) return null
  // Hyphens and underscores come off first, so `will-read-frequently` and
  // `willreadfrequently` are one answer — `parseHudUpload`'s reason: a spelling
  // a shell command can plausibly carry has to compare equal to what the probe
  // prints, or the mechanism check refuses its own arm.
  const text = raw.trim().toLowerCase().replaceAll('-', '').replaceAll('_', '')
  if (text === '') return null
  if (text === 'gpu' || text === 'accelerated' || text === 'hardware') return HUD_RASTER_GPU
  if (
    text === 'cpu' ||
    text === 'software' ||
    text === 'willreadfrequently' ||
    text === 'readfrequently'
  ) {
    return HUD_RASTER_CPU
  }
  return null
}

/**
 * The mode as one short token — `gpu`, `cpu`.
 *
 * Round-trips through `parseHudRaster`, so an e2e mechanism check can compare
 * an ask against a reading by STRING and an arm that asked for `software` is
 * recognisably the arm that reports `cpu`.
 */
export const describeHudRaster = (raster: HudRaster): string => raster.kind

/** Two raster modes are the same mode. */
export const sameHudRaster = (a: HudRaster, b: HudRaster): boolean => a.kind === b.kind

/**
 * Which mode a LIVE 2-D context is in, read off its own
 * `getContextAttributes()`, or `null` where that cannot be answered.
 *
 * DEV-244's `classifyHudTexture` discipline: the probe reports the INTENT and
 * this, separately, so a pin that never reached the canvas reads as a
 * disagreement rather than as an echo. This panel is rebuilt on every course
 * swap, and `boot/app.ts` holds the intent across that — so "the intent says
 * cpu" and "the live canvas is cpu" are two different facts and the report
 * carries both.
 *
 * **What this can and cannot see, stated plainly, because the difference
 * matters to anyone reading the report.** `getContextAttributes()` returns the
 * settings the context was CREATED with. So it catches the failure this repo
 * has actually had — a value configured and threaded and never reaching the
 * thing that acts on it (DEV-069, the control scheme that said `"a"` for four
 * sessions while the code shipped something else). It does **not** prove that
 * Chromium honoured the hint with a software backing store; nothing reachable
 * from script does. **That half is settled by the Chrome trace** — the presence
 * or absence of `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush` — which is the
 * coordinator's measurement and not this module's claim.
 *
 * `null` where the context does not implement `getContextAttributes` at all,
 * which is every node stub and some older engines. Null is the honest third
 * answer: it means *nobody here can tell*, which is a different thing from
 * *it is in neither mode*.
 */
export const classifyHudRaster = (ctx: {
  getContextAttributes?: () => CanvasRenderingContext2DSettings | null
}): HudRaster | null => {
  const attrs = ctx.getContextAttributes?.()
  if (!attrs) return null
  const live = attrs.willReadFrequently
  // Not `!!live`: `undefined` here means the engine answered without the field,
  // which is "cannot tell" and must not be collapsed into "false". A boolean
  // coercion would report the SHIPPED arm on an engine that simply does not
  // report, and a probe that cannot fail is not a probe.
  if (live === undefined) return null
  return live ? HUD_RASTER_CPU : HUD_RASTER_GPU
}

/** What `createHud` takes. One field today; an object so the next one is additive. */
export interface HudOptions {
  /** DEV-256. Which backend rasterises the canvas. Default `gpu` — what ships. */
  readonly raster?: HudRaster
  /**
   * DEV-257. Which continuous readings are geometry. Defaults to OFF, which is
   * the shipped panel with nothing extra constructed.
   *
   * `boot/app.ts` re-asserts the pin every frame through `setGauges`, exactly
   * as it does the cadence and the upload mode, so this is here for the tests
   * and the screenshot builders rather than for the game.
   */
  readonly gauges?: HudGauges
  /**
   * DEV-257. Full scale for the speed gauge, m/s. Defaults to the HoverJet's
   * boosted terminal out of the generated sheet — see
   * `HUD_GAUGE_SPEED_FULL_SCALE`, which also says why the JumpSeat has no
   * number of its own yet.
   */
  readonly speedFullScale?: number
  /**
   * DEV-360. Which drawing the panel carries, fixed for its life because it
   * decides the canvas's size. `rows` — the HoverJet's plates, and the default,
   * so every caller that says nothing gets the panel that shipped. `fuel` —
   * 2016's JumpSeat dome (`render/hud-fuel.ts`), which `game/jumpseat-flight.ts`
   * asks for through `HUD_LAYOUT_JUMPSEAT`.
   */
  readonly layout?: HudLayout
}

/**
 * What a canvas panel in the cockpit costs the frame, as COUNTS (DEV-243).
 *
 * Shared by the HUD and by `render/perf-plate.ts`, and shared on purpose:
 * **two panels with the same mechanism at two different rates is a much
 * stronger row than one panel.** They are the same kind of object — a
 * `CanvasTexture` on the flight object, `toneMapped: false`, on `UI_LAYER`,
 * one transparent quad — and they differ in exactly two measurable ways, the
 * canvas SIZE and the repaint RATE. One shape for both is what lets a reader
 * put those two numbers side by side without re-deriving either.
 *
 * Never a duration. Every millisecond in this wave is the coordinator's,
 * taken on a quiet box; what a probe may report is how many and how big.
 */
export interface CanvasPanelReport {
  /** Which panel, so two reports in one probe are tellable apart. */
  readonly panel: string
  /** `update()` calls that ran the draw. */
  readonly repaints: number
  /**
   * Seconds this panel has been alive and counting — first `update()` to most
   * recent.
   *
   * Reported beside `rateHz` so a reader can see what window the rate is over,
   * and that window is the PANEL's life, which starts under the loading
   * curtain and includes the launch banner and the lift. **The in-flight rate
   * is the trace's `hud_paints` / `plate_paints` differenced over the recorded
   * rows**, because those rows are the flight and nothing else. The two
   * disagree by however long the run spent not flying, and the trace is the
   * one to quote.
   */
  readonly seconds: number
  /** Repaints per second over `seconds`. 0 before the second `update()`. */
  readonly rateHz: number
  /**
   * What LEVEL 0 of one upload moves, RGBA8 — the `texSubImage2D` at
   * `three.module.js:12382` and nothing else.
   *
   * **Unchanged by DEV-244 on purpose.** `nomip` does not remove a byte of
   * this; it removes the chain, which is `mipBytes`. DEV-243's two-panel
   * comparison turns on `bytesPerSecond`, which is built from this field, so
   * quietly widening its meaning would re-define the number that row rests on.
   */
  readonly bytes: number
  /**
   * How many levels the chain has, counted by halving (DEV-244).
   *
   * 1 under `nomip`, which is the panel with no chain at all: three's
   * `getMipLevels` (`:11301`) returns 1 when `generateMipmaps` is false, so
   * `texStorage2D` allocates one level and `:12396`'s `generateMipmap` never
   * runs.
   */
  readonly mipLevels: number
  /**
   * Bytes in levels 1..n — what `generateMipmap` writes ON TOP of `bytes`
   * every upload, and the whole of what `?hudUpload=nomip` removes (DEV-244).
   *
   * Zero when there is no chain. For the shipped 560 x 203 panel it is
   * 150,332 B, i.e. 33.06 % of level 0 — the limit a 2-D chain converges to.
   */
  readonly mipBytes: number
  /** `bytes + mipBytes`. Everything one upload moves in the mode in force. */
  readonly uploadBytes: number
  /**
   * `bytes × rateHz` — the panel's traffic into the GPU, per second.
   *
   * THE number the two-panel comparison turns on, because it is the one that
   * folds the size and the rate together: the perf plate is 49 % more canvas
   * than the HUD and moves a small fraction of the bytes, which is the whole
   * argument that the cost is the rate rather than the panel.
   */
  readonly bytesPerSecond: number
  /** The canvas, in device pixels. */
  readonly pixels: { readonly width: number; readonly height: number }
  /**
   * Canvas uploads asked of three, read off **three's own counter**.
   *
   * `texture.version`, which `Texture.needsUpdate`'s setter increments
   * (`Texture.js:754-762`) and nothing else touches. Deliberately not a
   * counter of ours: CLAUDE.md's rule is to compare against something outside
   * the port, and a second counter beside `repaints` would agree with it by
   * construction and prove nothing. If a draw path ever forgets a
   * `needsUpdate` — or sets two — this is the number that disagrees.
   *
   * **It is `repaints + 1`, and the extra one is real.** `CanvasTexture`'s
   * constructor sets `needsUpdate = true` itself, so three uploads the blank
   * canvas the first time the material binds, before anything has been drawn
   * into it. That is an upload the GPU really does; hiding it to make two
   * counters match would be the port lying about three's behaviour, which is
   * the exact thing reading three's own counter is for.
   *
   * **DEV-250 adds a second term for the HUD**: a `warm()` paint is an upload
   * three really does and it is not a repaint, so on that panel this is
   * `repaints + warmPaints + 1`. `HudReport.warmPaints` is the half that makes
   * the sum reconcilable; the perf plate has no warm and is unchanged.
   */
  readonly uploads: number
}

/** What `__ff2.hud()` answers for the HUD itself — the panel, plus its levers. */
export interface HudReport extends CanvasPanelReport {
  /** The cadence in force, as `describeHudRedraw` spells it. */
  readonly cadence: string
  /**
   * DEV-244. The upload mode that was ASKED for, as `describeHudUpload` spells
   * it.
   */
  readonly upload: string
  /**
   * DEV-244. The upload mode the LIVE texture is actually in, classified from
   * its own `generateMipmaps` / `minFilter` / `anisotropy`.
   *
   * Separate from `upload` for DEV-232 and DEV-237's reason: a probe that
   * echoes the intent cannot tell a pin that landed from a pin that never
   * reached the panel, and this panel is re-created on every course swap.
   * `null` means the texture is in a combination no mode produces — which is a
   * finding about something outside this module, not a pass.
   */
  readonly liveUpload: string | null
  /**
   * DEV-256. Which raster backend was ASKED for, as `describeHudRaster` spells
   * it — `gpu` or `cpu`.
   */
  readonly raster: string
  /**
   * DEV-256. What the LIVE 2-D context says it was created with, read off
   * `getContextAttributes().willReadFrequently`.
   *
   * Separate from `raster` for `liveUpload`'s reason, and the separation earns
   * its keep harder here: the mode cannot be written to a live canvas at all
   * (`getContext` options are honoured once), so a pin that missed the
   * construction is silently the other arm and there is no field on the object
   * that would disagree. This is the disagreement.
   *
   * `null` where the context cannot answer — see `classifyHudRaster`, which
   * also says exactly which half of the question this settles and which half
   * only the Chrome trace can.
   */
  readonly liveRaster: string | null
  /**
   * DEV-256. How many times the canvas has been REBUILT under a live raster
   * flip — 0 for a panel that has only ever been the mode it was born in.
   *
   * A flip throws the canvas and the `CanvasTexture` away and makes new ones
   * (`setRaster`), which is a real allocation and a fresh `texStorage2D`, not a
   * field assignment. That is a thing a measurement wants to be able to see:
   * an arm flipped mid-run has paid for a rebuild and a first upload that an
   * arm pinned at load has not.
   */
  readonly rasterRebuilds: number
  /**
   * DEV-244. What the LAST repaint asked of the 2-D context, in calls.
   *
   * The instrument for the per-upload-cost hypothesis: freezing this panel
   * costs `int_01_hoverJet` ten times what it costs `adv_02_jumpSeat` for 2.4
   * times the repaints, so ~4.2x of the difference is in one upload, and the
   * candidate mechanism is that an upload must resolve whatever the 2-D
   * backend has queued. This is that quantity, per vehicle, as a count.
   *
   * Zeroes before the first repaint, which `repaints: 0` says as well.
   */
  readonly canvasOps: HudCanvasOps
  /** `update()` calls where the signature had not moved. */
  readonly unchanged: number
  /**
   * DEV-257. Which continuous readings are geometry, as `describeHudGauges`
   * spells it — `off`, `bar`, `needle`, `bar-only`, `needle-only`.
   */
  readonly gauges: string
  /**
   * DEV-257. Quads carrying a non-zero area on the last frame, or 0 with the
   * arm down.
   *
   * A COUNT, never a duration — every millisecond in this wave is the
   * coordinator's, taken serially on a quiet box. This is the number that says
   * the geometry is actually being drawn: an arm reporting `gaugeQuads: 0`
   * with a non-`off` mode never fired, which is the same refusal `skipped: 0`
   * offers for the cadence.
   */
  readonly gaugeQuads: number
  /**
   * DEV-362. Where the panel is: `dash` — the two screens set into the
   * cockpit's recess — or `lens`, the flat plate on the chase camera (and the
   * JumpSeat's, which has no recess).
   */
  readonly mount: HudMount
  /**
   * `update()` calls where the panel had something new to draw and the budget
   * withheld it.
   *
   * **An arm reporting `skipped: 0` never fired.** That is the one number here
   * a mechanism check can refuse on, because `repaints` alone cannot tell a
   * budget doing its job from a flight where nothing moved.
   */
  readonly skipped: number
  /**
   * DEV-250. Paints made by `warm()` — the flight layout's first raster, under
   * the loading curtain. 0 unless `?hudWarm=on`.
   *
   * Separate from `repaints` because it is a different fact and folding it in
   * would corrupt two numbers at once: `rateHz` is repaints per second of the
   * panel's life, and `skipped: 0` is the mechanism check for the CADENCE. It
   * is reported rather than hidden because `uploads` — three's own
   * `texture.version`, which is the counter this module deliberately does not
   * own — counts it, and a probe whose two counters cannot be reconciled is
   * how a draw path that forgot a `needsUpdate` would go unnoticed.
   *
   * **`uploads` is `repaints + warmPaints + 1`**, the extra one being the
   * blank canvas `CanvasTexture`'s constructor asks for. See `uploads`.
   */
  readonly warmPaints: number
  /** DEV-360. Which drawing this panel carries — `rows` or `fuel`. */
  readonly layout: HudLayout
}

/**
 * The counters behind a `CanvasPanelReport`, so the HUD and the perf plate
 * keep ONE of them rather than two that drift.
 *
 * Both panels are the same kind of object and the row DEV-243 rests on
 * compares them directly — a second, subtly different definition of "repaints
 * per second" on the other panel is exactly how a comparison between two
 * instruments comes to be a comparison of two definitions.
 */
export interface PanelCounter {
  /** Call on every admitted draw, with the caller's clock. */
  painted(nowMs: number): void
  /** Call on every `update()`, admitted or not, so `seconds` spans the life. */
  seen(nowMs: number): void
  readonly repaints: number
  /**
   * `generateMipmaps` is the LIVE flag off the caller's own texture, not a
   * default — DEV-244. Required rather than defaulted to `true` because a
   * default here would be this shape ASSERTING that a panel has a chain, on
   * behalf of a caller that might have turned it off, and `mipBytes` would then
   * report a saving the GPU never made.
   */
  report(
    panel: string,
    width: number,
    height: number,
    uploads: number,
    generateMipmaps: boolean,
  ): CanvasPanelReport
}

export const createPanelCounter = (): PanelCounter => {
  let repaints = 0
  // `null` and not 0: the window is first-`update()`-to-latest, and a numeric
  // sentinel would make the first window's length a function of how long boot
  // took rather than of how long the panel has been running.
  let firstMs: number | null = null
  let lastMs = 0
  return {
    painted() {
      repaints += 1
    },
    seen(nowMs) {
      if (firstMs === null) firstMs = nowMs
      lastMs = nowMs
    },
    get repaints() {
      return repaints
    },
    report(panel, width, height, uploads, generateMipmaps) {
      const seconds = firstMs === null ? 0 : Math.max(0, (lastMs - firstMs) / 1000)
      // Zero rather than Infinity on a zero window. A rate over no time is not
      // a large rate, it is an unanswered question, and `Infinity` in a probe
      // line is the kind of thing that gets pasted into a report.
      const rateHz = seconds > 0 ? repaints / seconds : 0
      const bytes = width * height * BYTES_PER_TEXEL
      // DEV-244. Both derived from the LIVE flag rather than from the mode, so
      // a panel whose texture somebody else touched reports what it is doing.
      const mipBytes = generateMipmaps ? mipChainBytes(width, height) : 0
      const mipLevels = generateMipmaps ? mipChainLevels(width, height) : 1
      return {
        panel,
        repaints,
        seconds,
        rateHz,
        bytes,
        mipLevels,
        mipBytes,
        uploadBytes: bytes + mipBytes,
        // Level 0 only, and unchanged by DEV-244 — see `bytes`. The comparison
        // DEV-243 rests on is built from this number and must keep meaning what
        // it meant when that row was written.
        bytesPerSecond: bytes * rateHz,
        pixels: { width, height },
        uploads,
      }
    },
  }
}

export interface Hud {
  readonly object: THREE.Object3D
  /**
   * `nowMs` is the caller's frame clock. Optional, and omitting it reads
   * `performance.now()` — every caller written before DEV-243, and every
   * screenshot builder, keeps working unchanged.
   */
  update(state: HudState, nowMs?: number): void
  /**
   * DEV-250. Paint ONCE, now, outside the cadence — the flight layout's first
   * raster, paid under the loading curtain.
   *
   * Returns what the draw asked of the 2-D context, so the caller can print it
   * beside `warmWorld`'s own line and a mechanism check can refuse a warm that
   * took the banner's early return (4 calls) instead of the flight layout's
   * ~30. See the DEV-250 block above for why this bypasses the budget and
   * leaves the signature alone.
   *
   * It does NOT upload on its own: `draw()` sets `texture.needsUpdate` and the
   * bytes move at the next `setTexture2D`, which is inside a real
   * `renderer.render` that draws this panel. `warmWorld`'s `show` option is
   * what guarantees that render includes it.
   */
  warm(state: HudState): HudCanvasOps
  /** DEV-243. Switch the redraw cadence; a no-op when it is already in force. */
  setRedraw(next: HudRedraw): void
  /**
   * DEV-244. Switch how the texture is uploaded; a no-op when it is already in
   * force, so `boot/app.ts` can re-assert it every frame the way it re-asserts
   * the cadence.
   *
   * The no-op matters more here than it does for the cadence: every change to
   * these three fields moves three's texture CACHE KEY (`:11533`), which
   * reallocates the whole `WebGLTexture`. Re-asserting the same mode 90 times a
   * second without the guard would rebuild the texture 90 times a second.
   */
  setUpload(next: HudUpload): void
  /**
   * DEV-256. Switch which backend rasterises the canvas; a no-op when it is
   * already in force, so `boot/app.ts` can re-assert it every frame the way it
   * re-asserts the other two.
   *
   * **The no-op matters more here than anywhere else on this object**, and for
   * a harder reason than DEV-244's. There is no field to write: `getContext`
   * options are honoured only on a canvas's FIRST context, so a real change
   * builds a new `HTMLCanvasElement`, a new `CanvasTexture`, points
   * `material.map` at it and disposes the old one. Re-asserting the same mode
   * 90 times a second without the guard would do that 90 times a second.
   *
   * **The panel does not go blank across a flip.** The old canvas's pixels are
   * carried onto the new one with a single `drawImage`, and the panel is then
   * marked as OWING a paint so the next admitted `update()` redraws it natively
   * through the new backend. Under `?hudRedraw=freeze` no paint is ever
   * admitted, so the carried pixels stand for the rest of the run — which is
   * what freeze means, and which is also why a live flip under freeze is
   * measurement-useless: with no repaints there is no raster to price. **Pin
   * the arm at load for a frozen comparison.**
   */
  setRaster(next: HudRaster): void
  /**
   * DEV-257. Switch which continuous readings are geometry; a no-op when the
   * mode is already in force, so `boot/app.ts` can re-assert it every frame
   * the way it re-asserts the other two pins.
   *
   * The no-op matters most here: a switch rebuilds the geometry and the
   * material, and with the pin at `off` the guard is the thing that means
   * nothing is ever allocated at all.
   */
  setGauges(next: HudGauges): void
  /**
   * DEV-362. Set the panel into the dash (`dash`: 2016's two screens, depth
   * tested, drawn in 2016's layout) or onto the lens (`lens`: one flat quad,
   * `depthTest: false`, the three plates — the panel as it was before this
   * row). A no-op when already there; `boot/app.ts` asserts it every frame the
   * view can change. The panel is BORN on the lens, so every caller that says
   * nothing — the JumpSeat, the tests, the screenshot builders — keeps it.
   */
  setMount(next: HudMount): void
  /**
   * DEV-362. A plate that rides the panel on its right — DEV-361's race map —
   * or null when there is none. On the lens it keeps its own place beside the
   * panel; in the dash it moves INSIDE the upper screen, against its right
   * edge, and the text column narrows to clear it. Guarded; call every frame.
   */
  setSidePlate(plate: THREE.Object3D | null, widthMetres: number): void
  /** DEV-362. Where the panel is now. */
  readonly mount: HudMount
  /**
   * DEV-243. Repaints so far — the trace column, WITHOUT `report()`'s
   * allocation.
   *
   * `report()` builds a fresh object with a nested one inside it, and the
   * trace reads this every frame of a 60-second run. A number the loop can
   * read is a number the loop does not have to allocate for, in a file whose
   * whole subject is per-frame cost.
   */
  readonly paints: number
  /** DEV-243. Counts and sizes, for `__ff2.hud()`. Allocates; call it per ARM. */
  report(): HudReport
  dispose(): void
}

/**
 * Panel size in metres, and its texture resolution.
 *
 * The LENS panel's size — the flat plate the chase camera carries, and the
 * JumpSeat's. In the HoverJet's cockpit the same canvas is set into the dash on
 * 2016's own two screens (`render/hud-dash.ts`, DEV-362). This comment used to
 * say the panel was inset into "the dark console face" at z 0.94: those 46
 * vertices are the console's back between the pilot's knees, and the panel
 * floated in front of the dash nose, 0.146 m from the recess 2016 used.
 *
 * `WIDTH` and `PIXELS_PER_METRE` are EXPORTED because `render/perf-plate.ts`
 * sits beside this panel, at the same pixel density (DEV-160): its offset is
 * `WIDTH / 2 + gap + PLATE_W / 2`, which is only the right number while it is
 * this panel's ACTUAL width. A second copy of `0.4` over there would be a plate
 * that slides into the HUD the first time this one is resized.
 */
export const WIDTH = 0.4
/**
 * Exported for DEV-257's sake: the gauge geometry lives in the panel's own
 * local metres, and a test that read back a vertex would otherwise have to
 * keep a second copy of this number to say where it should be.
 */
export const HEIGHT = 0.145
export const PIXELS_PER_METRE = 1400

// Matched to the 2016 shots: white type on dark teal plates, one plate per row.
const INK = UI_INK
const PLATE = 'rgba(38, 92, 100, 0.86)'
const PLATE_EDGE = 'rgba(150, 214, 220, 0.55)'
const ACCENT = UI_ACCENT
/**
 * The "you just lost the streak" ink. Cool where `ACCENT` is warm, and dimmer
 * than `INK` so a broken streak reads as a thing going away rather than as
 * another award. Deliberately not red: the panel is an instrument, and the
 * player has lost a multiplier, not crashed.
 */
const MUTED = UI_LOSS
/**
 * DEV-143's boost tank, and its empty track.
 *
 * Cool and bright where `ACCENT` is warm, because the panel already spends warm
 * on the two scoring readings and a third amber bar would read as a fourth
 * helping of the same thing. This one is not a score — it is the charge in the
 * engine — and it needs to be identifiable at a glance in peripheral vision,
 * which is a HUE difference, not a brightness one.
 *
 * The track is the plate's own ink darkened rather than a fourth colour: it is
 * the ABSENCE of charge and should look like a hole in the gauge.
 */
const CHARGE = '#7fe3ff'
const TANK_TRACK = 'rgba(8, 28, 34, 0.7)'
/**
 * DEV-567: the tank while boost is OUT, the refill and its track. Warm, so the
 * gauge's two states are a HUE apart (cool: you have boost; warm: you do not),
 * by the rule above that a gauge read in peripheral vision needs one. Before
 * this the out state wore `MUTED`, a pale cyan beside `CHARGE`'s, and at the
 * dash's size in a headset the two were one colour.
 *
 * Coral, not the scores' amber (`ACCENT`, the combo's bar just above it)
 * and not red: boost is out for a second and a half, the ship is not hurt.
 * The track is the same coral darkened, so the whole gauge goes warm even at
 * an empty tank, where there is no refill yet to colour.
 */
const BOOST_OUT = UI_ALERT
const BOOST_OUT_TRACK = 'rgba(120, 40, 20, 0.75)'

/**
 * DEV-257. The same five inks the canvas uses, handed to the geometry.
 *
 * **Not a sixth colour anywhere**, which is the point: the three readings that
 * were already bars keep their exact ink, so a frame with the arm up should be
 * indistinguishable from one with it down for those three, and any difference
 * is a bug rather than a design. `render/instrument-colour.ts`'s
 * `INSTRUMENT_ACCENT` is the one the NEW gauge wears — the colour the launch
 * room, the elevator shaft's lit bars and the hangar's flown holotable rim
 * already share, so a new instrument joining that family is not a new colour
 * at all. It is spelled here as CSS rather than imported as a hex number so
 * that one palette object carries one kind of thing; the test asserts the two
 * are the same colour.
 */
const INSTRUMENT_ACCENT_CSS = UI_CYAN
export const HUD_GAUGE_PALETTE: HudGaugePalette = {
  ink: INK,
  accent: ACCENT,
  charge: CHARGE,
  muted: MUTED,
  tankTrack: TANK_TRACK,
  plateEdge: PLATE_EDGE,
  instrument: INSTRUMENT_ACCENT_CSS,
  boostOut: BOOST_OUT,
  boostOutTrack: BOOST_OUT_TRACK,
} as const

// ── DEV-362: what the dash draws, formatted by the lens panel's own rules ───

/** The inks the dash layout borrows — the lens panel's, so no colour is new but 2016's two plates. */
const DASH_INKS = {
  ink: INK,
  accent: ACCENT,
  muted: MUTED,
  charge: CHARGE,
  tankTrack: TANK_TRACK,
  plateEdge: PLATE_EDGE,
  boostOut: BOOST_OUT,
  boostOutTrack: BOOST_OUT_TRACK,
} as const

/**
 * The small badges, right to left: `AUTO`, the streak `x3`, the chain `+4`.
 * One list for both mounts. `x1` and `+1` are absences, so they draw nothing.
 *
 * DEV-397: none once the run is over. They are readings of a run still going,
 * and they stayed up under the medal after every finish (`+4 AUTO`) because
 * nothing asked whether the run they described was still running.
 */
export const hudBadges = (state: HudState): string[] => {
  if (state.finished) return []
  const badges: string[] = []
  if (state.autopilot) badges.push('AUTO')
  const multiplier = state.multiplier ?? 1
  if (multiplier > 1) badges.push(`x${multiplier}`)
  const stacks = state.chain?.stacks ?? 0
  if (stacks > 1) badges.push(`+${stacks}`)
  // DEV-399. Words as well as a colour: a stall has to be read in peripheral
  // vision, and a bar that changed hue is the second cue, not the first. On
  // both mounts, as every badge is — the bar itself is the dash's alone.
  if (state.stall?.stalling) badges.push('STALL')
  return badges
}

/**
 * The dash's content for `state`, through the SAME formatters and the same
 * gauge rules the lens panel's `draw()` uses — `formatTime`, `hudSpeedText`,
 * the corner's `x1 draws nothing` rule, the event line's `'none'` rule — so a
 * reading cannot say one thing in the cockpit and another on the chase camera.
 * Every field it reads is already in `hudSignature`, which is what keeps the
 * dash repainting on exactly the changes the lens panel repaints on.
 */
export const dashContent = (state: HudState, gauges: HudGauges = HUD_GAUGES_OFF): DashContent => {
  const gaugesOn = hudGaugesOn(gauges)
  const shown = state.award ?? (state.finished ? state.medal : '')
  const badges = hudBadges(state)
  return {
    banner: state.banner,
    countLabel: `${state.countLabel}:`,
    countValue: `${pad2(state.ringsPassed)}/${pad2(state.ringsTotal)}`,
    timeLabel: `${state.timeLabel}:`,
    timeValue: formatTime(state.elapsed, state.timeLimit, state.timeCountsDown),
    urgent: state.timeLimit > 0 && Math.max(0, state.timeLimit - state.elapsed) < 20,
    speedLabel: `${state.speedLabel}:`,
    speedValue: hudSpeedText(state, gauges),
    event:
      shown && shown.toLowerCase() !== 'none'
        ? {
            text: shown.toUpperCase(),
            tone: state.award && state.awardTone === 'loss' ? 'loss' : 'gain',
          }
        : null,
    energy: gaugesOn ? undefined : state.energy,
    chain: !gaugesOn && state.chain && state.chain.stacks > 0 ? state.chain.fraction : undefined,
    // DEV-399. Not a DEV-257 gauge — nothing builds it as geometry — so the
    // arm does not take it off the canvas.
    stall: state.stall,
    badges,
  }
}

/**
 * DEV-361. The panel's own plate and type ink, for the race map that sits
 * beside it (`render/race-map.ts`). Exported for `HUD_GAUGE_PALETTE`'s reason:
 * a plate beside this one that typed its own teal would be a sixth colour, and
 * one that copied this one would drift the first time this one moved.
 */
export const HUD_PLATE_INKS = { plate: PLATE, ink: INK } as const

/**
 * DEV-360. The inks and the typeface the JumpSeat's dome borrows, for
 * `HUD_GAUGE_PALETTE`'s reason: its own layer (the event line, the badges)
 * must be the same colours as the rows', and its text the same face. The
 * face is the rows' own string, spelled once more here rather than moved, so
 * that the rows' `draw()` is not touched by a change for the other vehicle.
 *
 * DEV-362 follow-up: the dome's `text_fuel` is CRYSTAL in 2016, and CRYSTAL can
 * ship, so the dome draws in it once it has loaded (`render/hud-font.ts`). The
 * rows' italic stack is what it falls back to, as before.
 */
const FUEL_INKS = { ink: INK, accent: ACCENT, muted: MUTED } as const
const hudFallbackFont = (px: number): string =>
  `italic 700 ${Math.round(px)}px "Segoe UI", ui-sans-serif, system-ui, sans-serif`
const hudFont = (px: number): string => hudFace(px, hudFallbackFont)

export const createHud = (options: HudOptions = {}): Hud => {
  // DEV-256. The mode the canvas is BORN in, because `getContext` options are
  // honoured only on a canvas's first context — see the DEV-256 block.
  //
  // DEV-266: the fallback is `HUD_RASTER_SHIPPED`, not a literal. This line
  // used to say `gpu` and claim that `createHud()` with no argument "is byte
  // for byte the shipped panel", which stopped being true the day DEV-256
  // shipped `cpu` and went on reading as if it were. The two production call
  // sites (`game/flight.ts`, `game/jumpseat-flight.ts`) both build through
  // this factory, and `boot/app.ts` passes the pin explicitly on every course
  // swap — so today the fallback is reached only by a caller that omits the
  // option, and the safe thing for such a caller to get is the panel that
  // ships. Same argument as `createHudRedrawBudget`'s `HUD_REDRAW_DEFAULT`.
  let raster: HudRaster = options.raster ?? HUD_RASTER_SHIPPED
  // DEV-244. The shipped state, applied through the same function the arm uses
  // rather than written out here — so `mip` really is what shipped, and so
  // there is exactly one place the three fields are decided. `texture.anisotropy
  // = 4` and three's own `LinearMipmapLinearFilter` default are what this
  // produces for `HUD_UPLOAD_MIP`, which `tests/unit/hud-upload.test.ts` holds.
  let upload: HudUpload = HUD_UPLOAD_MIP
  // DEV-360. Fixed for the panel's life: it decides the quad and the canvas.
  // `rows` is `WIDTH` × `HEIGHT`, exactly as before; `fuel` is 2016's dome's
  // own bounding box, at the same pixel density.
  const layout: HudLayout = options.layout ?? 'rows'
  const panelW = layout === 'fuel' ? FUEL_DOME.widthM : WIDTH
  const panelH = layout === 'fuel' ? FUEL_DOME.heightM : HEIGHT

  /** One canvas, its context and the texture that carries it — DEV-256. */
  interface Surface {
    readonly canvas: HTMLCanvasElement
    readonly ctx: CanvasRenderingContext2D
    readonly texture: THREE.CanvasTexture
  }

  /**
   * Build a surface in `mode`. Called once at construction and again by every
   * live flip, so the two paths cannot drift — the flip really does produce the
   * panel the pinned arm produces, which is the claim the e2e check makes.
   */
  const buildSurface = (mode: HudRaster): Surface => {
    const element = document.createElement('canvas')
    element.width = Math.round(panelW * PIXELS_PER_METRE)
    element.height = Math.round(panelH * PIXELS_PER_METRE)
    const context = element.getContext('2d', hudContextOptions(mode))
    if (!context) throw new Error('hud: no 2d context')
    const canvasTexture = new THREE.CanvasTexture(element)
    // The panel is authored in sRGB, like any image.
    canvasTexture.colorSpace = THREE.SRGBColorSpace
    const want = hudTextureState(upload)
    canvasTexture.generateMipmaps = want.generateMipmaps
    canvasTexture.minFilter = want.minFilter
    canvasTexture.anisotropy = want.anisotropy
    return { canvas: element, ctx: context, texture: canvasTexture }
  }

  let surface = buildSurface(raster)
  let canvas = surface.canvas
  let ctx = surface.ctx
  let texture = surface.texture
  /** DEV-256. Live raster flips so far. Zero on a panel that was only pinned. */
  let rasterRebuilds = 0
  /**
   * DEV-256. `texture.version` from every texture this panel has RETIRED.
   *
   * Not a second counter — it is a sum of three's own counter across the
   * textures the panel has owned, which is what `uploads` has to be once a
   * flip can throw one away. Without it a rebuild would restart `uploads` at 1
   * and the report would say `uploads < repaints`, which reads exactly like a
   * draw path that forgot a `needsUpdate`: a FALSE finding, and the only
   * finding that field exists to make. With it, `uploads` is
   * `repaints + 1 + rasterRebuilds` and both terms are in the report.
   */
  let retiredUploads = 0

  const applyUpload = () => {
    const want = hudTextureState(upload)
    texture.generateMipmaps = want.generateMipmaps
    texture.minFilter = want.minFilter
    texture.anisotropy = want.anisotropy
  }

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    // NOT tone-mapped. The Anniversary preset puts a tone curve on the renderer
    // (DEV-081) and a curve is for scene radiance; this is a canvas somebody
    // drew in sRGB, and running it through ACES would grey the instrument down
    // and shift its colours on a preset flip. See `render/tone.ts` for the line
    // — a surface showing a canvas-drawn UI texture is not tone-mapped.
    toneMapped: false,
    // Unlit: an instrument panel is emissive, and a lit one goes unreadable in
    // exactly the situation you need it — flying into shadow at speed.
    depthWrite: false,
    // ALWAYS legible. The panel sits among cockpit geometry that will happily
    // occlude its bottom edge, and chasing a position that clears every strut
    // is fragile — the mesh is a fixed asset and the placement is not. An
    // instrument you can always read is also just correct: this is the layer
    // that tells you how long you have left.
    //
    // Safe only because the camera lives INSIDE the cockpit. If a third-person
    // view lands (the prefab has a `panel_changeCam` control, so 2016 had one),
    // this needs to become depth-tested or move to that camera's own rig.
    depthTest: false,
  })

  const object = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), material)
  object.name = 'hud'
  // Drawn after the cockpit so it is never z-fought by the panel it sits on.
  object.renderOrder = 10

  // ── DEV-257: the gauges ────────────────────────────────────────────────
  //
  // Built LAZILY, and only when a mode that wants them arrives. With the arm
  // down — which is the default and therefore the shipped panel — `mesh` stays
  // null, `createHudGauges` is never called, and nothing is added to this
  // object. That is stricter than "the flag is off" and it is what makes this
  // an arm: `tests/e2e/hud-gauges-pixels.spec.ts` photographs the flag-off
  // build against an unmodified one and the diff has to be zero.
  const speedFullScale = options.speedFullScale ?? HUD_GAUGE_SPEED_FULL_SCALE
  let gauges: HudGauges = options.gauges ?? HUD_GAUGES_OFF
  let mesh: HudGaugeMesh | null = null
  const applyGauges = () => {
    // Disposed and rebuilt rather than mutated, because the form decides the
    // geometry's contents and a `needle` pretending to be a `bar` would be two
    // shapes sharing one buffer. It happens at most once per arm, at boot.
    if (mesh) {
      object.remove(mesh.object)
      mesh.dispose()
      mesh = null
    }
    // DEV-360. The dome IS a gauge, and it carries no speed, proximity or
    // chain reading for these to replace — so on the `fuel` layout nothing is
    // ever built, whatever the pin says.
    if (layout === 'fuel') return
    const built = createHudGauges(gauges, {
      width: WIDTH,
      height: HEIGHT,
      pixelsPerMetre: PIXELS_PER_METRE,
      palette: HUD_GAUGE_PALETTE,
      speedFullScale,
    })
    if (!built) return
    mesh = built
    // A CHILD of the panel, so it inherits the preset's placement (DEV-129),
    // the third-person re-parenting `app.ts` does, and — the one that would
    // otherwise be a bug — `flight.hud.object.visible = inCockpit && !paused`.
    // A sibling would need all three copied, and the pause menu would have a
    // set of gauges floating over it.
    object.add(mesh.object)
  }
  applyGauges()

  // ── DEV-362: the mount — set into the dash, or on the lens ──────────────
  //
  // Born on the LENS: the flat quad, `depthTest: false`, the three plates —
  // the panel exactly as it was before this row, which is what the JumpSeat,
  // every unit test and every screenshot builder that says nothing still get.
  // `game/flight.ts` sets the HoverJet's panel into the dash; `boot/app.ts`
  // puts it back on the lens while the chase camera carries it (DEV-128).
  //
  // In the dash the SAME canvas, texture and material go on a three-quad
  // geometry (`render/hud-dash.ts`), so the draw count, the raster, the
  // upload and the cadence are all what they were. What changes:
  //
  //  · depth: TESTED. The recess's hood, walls and sill are what make the
  //    screens read as set into the dash, and in a headset — one pass, no
  //    depth clear — the depth test is the only mechanism that can put the
  //    bezel's lip in front of a screen's edge. The material still writes no
  //    depth and still draws at `renderOrder` 10, after the cockpit.
  //  · the drawing: 2016's two screens (`drawDash`), not the three plates.
  //  · a side plate (the race map) moves INSIDE the upper screen.
  //
  // A change of mount is a repaint the panel OWES — the `setGauges` pattern:
  // the signature is cleared and the next admitted `update()` draws the new
  // layout. At the shipped 10 Hz that is at most one interval of the old
  // picture on the new geometry, on the frame the view changes.
  let mount: HudMount = 'lens'
  const lensGeometry = object.geometry
  /** Built on the first `setMount('dash')`, never for a panel that stays on the lens. */
  let dashGeometry: THREE.BufferGeometry | null = null
  let sidePlate: THREE.Object3D | null = null
  let sidePlateWidth = 0
  /** Where the side plate put ITSELF, beside the lens panel — restored on the way back. */
  let sidePlateLensX = 0
  /** Canvas px the dash's text keeps clear for the side plate. */
  let sideInsetPx = 0
  const applyMount = () => {
    const inDash = mount === 'dash'
    if (inDash && !dashGeometry) dashGeometry = createDashGeometry(canvas.height)
    // Widened on purpose: the mesh is BORN a plane, and in the dash it is not
    // one — `createDashGeometry` says what its `parameters` carry instead.
    const panel: THREE.Mesh = object
    panel.geometry = inDash && dashGeometry ? dashGeometry : lensGeometry
    material.depthTest = inDash
    sideInsetPx = inDash ? dashSideInsetPx(sidePlateWidth, canvas.width) : 0
    if (sidePlate) {
      sidePlate.position.x = inDash ? dashSidePlateX(sidePlateWidth) : sidePlateLensX
      // Just proud of the screen, so it is never coplanar with the plate it
      // sits on; on the lens it goes back to the panel's own plane.
      sidePlate.position.z = inDash ? 0.001 : 0
      // The plate follows the panel's depth rule, as its own material's
      // comment says it does: tested in the recess, not on the lens.
      sidePlate.traverse((node) => {
        const m = (node as THREE.Mesh).material
        if (!m) return
        for (const each of Array.isArray(m) ? m : [m]) each.depthTest = inDash
      })
    }
  }

  let signature = ''
  // DEV-243. `update()` calls where the signature had NOT moved, and calls
  // where it had and the budget refused. Separate, because they are different
  // facts: the first says the panel had nothing to say, the second says the
  // panel had something to say and the arm withheld it. An arm reporting
  // `skipped: 0` never fired.
  let unchanged = 0
  let skipped = 0
  /** DEV-244. What the last admitted `draw()` asked of the canvas. */
  let lastCanvasOps: HudCanvasOps = NO_CANVAS_OPS
  /** DEV-250. Paints made by `warm()`, which are outside the cadence entirely. */
  let warmPaints = 0
  /** The panel is behind the state and owes a paint. See `update`. */
  let owed = false
  // DEV-362 follow-up. A panel built while CRYSTAL is still loading has painted
  // (or will paint) in the fallback face, and a canvas never redraws itself
  // when a font lands. So it owes one repaint when the load settles — the
  // `setGauges` pattern: the signature is cleared, and the next admitted
  // `update()` draws the same readings in the right face.
  whenHudFontSettles(() => {
    signature = ''
    owed = true
  })
  const budget = createHudRedrawBudget()
  // The same counter the perf plate keeps, so `rateHz` means one thing across
  // both panels. `budget.repaints` and this one are the same number by
  // construction; the counter exists for the CLOCK, which the budget has no
  // business holding.
  const counter = createPanelCounter()

  const draw = (state: HudState) => {
    // DEV-360. The JumpSeat's dome is a different drawing on the same panel:
    // same canvas path, same cadence, same upload, its own prediction.
    if (layout === 'fuel') {
      lastCanvasOps = fuelCanvasOps(state)
      drawFuelDome(ctx, canvas.width, canvas.height, state, FUEL_INKS, hudFont)
      texture.needsUpdate = true
      return
    }
    // DEV-244. Recorded per REPAINT, not per frame, and it sits beside ~25
    // context calls and a 444 KiB upload: fifteen integer adds against the two
    // things this whole row exists because they are expensive. A stored
    // REFERENCE to `state` would have been cheaper still and is the thing with
    // a trap attached (DEV-032 — never keep a caller's object past the call),
    // so the integer wins on both counts.
    lastCanvasOps = hudCanvasOps(state, gauges)
    // DEV-257. Read ONCE at the top of the draw rather than at each of the
    // four sites: `applyGauges` can only run between frames, but a flag read
    // four times is a flag that can be read four ways by the next edit.
    const gaugesOn = hudGaugesOn(gauges)
    // DEV-362. In the dash it is 2016's two screens, from the same content
    // the rows below format, with its own prediction of what it asked.
    if (mount === 'dash') {
      const content = dashContent(state, gauges)
      lastCanvasOps = dashCanvasOps(content)
      drawDash(ctx, canvas.width, canvas.height, content, DASH_INKS, sideInsetPx)
      texture.needsUpdate = true
      return
    }
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // Panel metrics, shared by the banner and the instrument rows below.
    const gap = h * 0.035
    const rowH = (h - gap * 2) / 3
    const radius = rowH * 0.22
    const padX = rowH * 0.22
    const font = (px: number) =>
      `italic 700 ${Math.round(px)}px "Segoe UI", ui-sans-serif, system-ui, sans-serif`

    // The launch banner REPLACES the panel, and has to be drawn before the rows
    // rather than over them: the plates are 86% opaque, so an overlay let
    // "GATES: 00/21" and "SPEED: 0" show through the banner behind the text.
    //
    // During the ride and the countdown those rows are all zeros anyway, so
    // this is not hiding information — it is using the space for the only
    // thing that matters yet.
    if (state.banner) {
      ctx.fillStyle = PLATE
      ctx.beginPath()
      ctx.roundRect(0, 0, w, h, radius)
      ctx.fill()
      ctx.strokeStyle = PLATE_EDGE
      ctx.lineWidth = Math.max(1, rowH * 0.035)
      ctx.stroke()
      // A single digit gets the full height; a phrase has to fit the width.
      const big = state.banner.length <= 2
      ctx.fillStyle = big ? ACCENT : INK
      ctx.font = font(big ? h * 0.7 : h * 0.3)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(state.banner, w / 2, h * 0.54, w * 0.9)
      texture.needsUpdate = true
      return
    }

    // ── Three stacked rows, matching 2016 ────────────────────────────────
    //
    // The shipped HUD is GATES / TIME / SPEED, each on its own plate. There is
    // no score line — score was an end-of-run screen, not an instrument — and
    // the count label changes with the mode: GATES in Ring Attack, ORBS where
    // orbs are what you are collecting.
    //
    // TIME is whole seconds and reads `--` where a mission has no clock. Not
    // m:ss: the original shows `110`. It counts DOWN where the clock ends the
    // run, which is what 2016 does and what this port did not — see
    // `formatTime`, DEV-200.
    const rows: [string, string | null][] = [
      [`${state.countLabel}:`, `${pad2(state.ringsPassed)}/${pad2(state.ringsTotal)}`],
      [`${state.timeLabel}:`, formatTime(state.elapsed, state.timeLimit, state.timeCountsDown)],
      // The unit goes on the VALUE, never on the label: `speedLabel` is 2016's
      // own copy out of `level.ui` (`Speed :` -> `SPEED`) and it is not ours to
      // rewrite. On Classic this is `String(Math.round(state.speed))` and the
      // row is pixel-identical to the one that shipped.
      //
      // DEV-257. With a gauge carrying the speed, this row is either COARSENED
      // — so the digits stop being the thing that rasters the panel on every
      // frame — or absent entirely, which is the variant that takes the
      // canvas's repaint rate all the way down to the clock. `null` is the
      // second: the label stays and the gauge is the reading.
      [`${state.speedLabel}:`, hudSpeedText(state, gauges)],
    ]

    const remaining = Math.max(0, state.timeLimit - state.elapsed)
    const urgent = state.timeLimit > 0 && remaining < 20
    // ── The event line, in the count row's LABEL slot (DEV-397) ──────────
    //
    // THREE things reach it and the live one always wins, because all three
    // are short-lived and the caller owns the clock: a medal crossed mid-run
    // (Free Flight, 2.5 s, `LevelEnd`'s own wait), a gate or a pad (1.6 s),
    // and the end-of-run medal once `finished`. `'none'` and the empty string
    // draw nothing: a mode that awards no medal must not look like a failed run.
    //
    // It used to REPAINT the count row's plate and centre itself on it, on the
    // argument that the count it covered was the one thing the hit had just
    // changed. That was survivable while it fired once a run. Under G1/G2 it
    // fires on every gate and every 0.8 s of a low pass, so the number was
    // covered for most of a lap — and the plates are 86 % opaque, so the
    // repainted number still showed through UNDER the banner, which is the
    // "bonus text over the numerator" of `docs/BUGS.md`. The label is the one
    // thing on that row a player already knows, so it is the part that yields.
    const shown = state.award ?? (state.finished ? state.medal : '')
    const event = shown && shown.toLowerCase() !== 'none' ? shown.toUpperCase() : ''

    rows.forEach(([label, value], i) => {
      const y = i * (rowH + gap)

      ctx.fillStyle = PLATE
      ctx.beginPath()
      ctx.roundRect(0, y, w, rowH, radius)
      ctx.fill()
      ctx.strokeStyle = PLATE_EDGE
      ctx.lineWidth = Math.max(1, rowH * 0.035)
      ctx.stroke()

      const baseline = y + rowH * 0.74
      ctx.font = font(rowH * 0.62)
      ctx.textBaseline = 'alphabetic'

      ctx.fillStyle = i === 1 && urgent ? ACCENT : INK
      ctx.textAlign = 'left'
      if (i === 0 && event) {
        // Fitted to the room the count leaves, measured, and never over it.
        const room = Math.max(1, w - padX * 3 - (value === null ? 0 : ctx.measureText(value).width))
        // A pad hit that broke the streak is the one thing on this panel that
        // is not good news, and it says so in colour as well as in words.
        ctx.fillStyle = state.award && state.awardTone === 'loss' ? MUTED : ACCENT
        const most = rowH * 0.5
        ctx.font = font(most)
        const natural = ctx.measureText(event).width
        ctx.font = font(natural > room ? (most * room) / natural : most)
        ctx.fillText(event, padX, baseline, room)
        ctx.font = font(rowH * 0.62)
        ctx.fillStyle = INK
      } else {
        ctx.fillText(label, padX, baseline)
      }
      // `null` is DEV-257's digit-free speed row. Not an empty string: an
      // empty `fillText` is still a call, and the whole subject of this row is
      // what one repaint asks of the 2-D backend.
      if (value !== null) {
        ctx.textAlign = 'right'
        ctx.fillText(value, w - padX, baseline)
      }
    })

    // ── The gate combo's countdown (DEV-110, DEV-615) ─────────────────────
    //
    // Drawn INSIDE the plate it belongs to, along its bottom edge, rather than
    // as a row of its own: the panel is three rows in 2016 and a fourth would
    // change its silhouette. A 6 %-height strip is the smallest thing that
    // still reads at 0.4 m.
    //
    // ABSENT draws nothing at all, which is not the same as zero: a run with
    // no combo banked has nothing to count down, and an instrument for a
    // mechanic that is not running is worse than no instrument.
    const barH = rowH * 0.06
    /** Where a row's bar sits, along the bottom edge of its plate. */
    const barY = (row: number) => row * (rowH + gap) + rowH - barH * 1.6
    // THE SPEED CHAIN's cooldown, on the COUNT row: how long is left to take
    // the next gate before the combo (`+N` on the time row) and its 18 m/s a
    // gate fall back at once, which is the part the player can still act on.
    // DEV-615: it was on the SPEED row, the number it moves, under G1's
    // proximity meter on this one; Matt, 2026-10-03, *"remove the bars from
    // speed and time. just boost and gates. (to show the gate combo
    // countdown)"*. On a track while a combo is live, so the fill reads as a
    // share of the cooldown; `paintChain` is the dash's drawing too.
    if (!gaugesOn && state.chain && state.chain.stacks > 0) {
      paintChain(ctx, padX, barY(0), w - padX * 2, barH, state.chain.fraction, {
        track: PLATE_EDGE,
        fill: ACCENT,
      })
    }

    // ── DEV-143: THE BOOST TANK, on the TIME row ─────────────────────────
    //
    // Row 1 had the only plate with no bar on it, and it is the right one by
    // meaning as well as by vacancy: this row is about how long you have, and
    // the tank is how long you can keep boosting.
    //
    // Three things make it different from the combo's bar above, and every one
    // of them is because this is the only bar that reports a resource the
    // player SPENDS rather than a reading of the run:
    //
    //  · It is ALWAYS on a track. The combo's bar has one only while a combo
    //    is live, because no combo is no bar at all. This gauge is absent or
    //    present at the BLOCK level (`state.energy` is undefined on Classic), so a track
    //    is free, and it is what makes an EMPTY tank read as empty rather than
    //    as a bar that has gone away.
    //  · It is TALLER: twice the readings' height at DEV-143, and DEV-567 made
    //    it 0.18 of the row (`hudPanelLayout`). A 6 %-height strip is the
    //    smallest thing that still reads, and "still reads" is not the bar for
    //    the one gauge a player has to act on. CLAUDE.md: a thing too small has
    //    been rendered, not reviewed.
    //  · It has its OWN colour, cool while boost is there and WARM while it is
    //    out (DEV-567; it was a second pale cyan, and Matt could not tell). A
    //    low tank and a tank that will not light look alike and are not.
    //    `sim/energy.ts`'s `boostAvailable` is the distinction; this is where a
    //    player can see it.
    //
    // The moment of CHANGE is not here. It is the event line, which `app.ts`
    // fires on the lockout latching and clearing — the same channel as G2's
    // gate bonus, which is the feedback Matt singled out as working.
    if (!gaugesOn && state.energy) {
      // DEV-567: the rect is `hudPanelLayout`'s, the one the gauges arm reads,
      // and the bar (track, fill, threshold mark) is `hud-dash.ts`'s
      // `paintTank`, the one the dash paints with.
      const { tankY: y, tankH } = hudPanelLayout(w, h)
      const t = paintTank(ctx, padX, y, w - padX * 2, tankH, state.energy, DASH_INKS)
      // DEV-410 follow-up. Matt, 2026-09-26: *"not realizing the boost bar is
      // filling / emptying (there are 3 bars, not sure which is which)"*. So
      // the tank names itself, inside its own track at the left end. The word
      // and its ink are `paintTank`'s, which the dash draws from too (DEV-555).
      ctx.font = font(tankH * 0.9)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = t.ink
      ctx.fillText(t.word, padX + t.pad, y + tankH / 2, t.reach)
    }

    // ── The badges: AUTO, the streak, the chain — on the TIME row (DEV-397) ─
    //
    // Small, accent, and never a banner: the instruments still matter while the
    // autopilot flies. `x1` and `+1` draw nothing — the absence of a streak or a
    // chain, and a panel permanently reading them trains the eye past the spot
    // (DEV-044). None once the run is over: each is a reading of a run still
    // going, and `+4 AUTO` stayed under the medal after every finish.
    //
    // They used to share the COUNT row's top corner, placed by measuring each
    // other and nothing else, and the count is right-aligned under that corner,
    // so they sat on its digits: `+3 AUTO` over the numerator. They now sit
    // where the dash puts them (DEV-362), on the time row, in the room the
    // clock LEAVES — its width measured, their reach bounded by `maxWidth`, so
    // nothing can put them on a number. `hudBadges` is the dash's list too.
    const badges = hudBadges(state)
    if (badges.length > 0) {
      const baseline = rowH + gap + rowH * 0.74
      ctx.font = font(rowH * 0.62)
      const clock = ctx.measureText(rows[1]?.[1] ?? '').width
      const label = ctx.measureText(rows[1]?.[0] ?? '').width
      const right = w - padX * 2 - clock
      const left = padX * 2 + label
      ctx.font = font(rowH * 0.34)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = ACCENT
      ctx.fillText([...badges].reverse().join('  '), right, baseline, Math.max(1, right - left))
    }

    texture.needsUpdate = true
  }

  return {
    object,
    /**
     * `nowMs` is the caller's frame clock, defaulted so that every existing
     * caller and every screenshot builder keeps working unchanged.
     *
     * `boot/app.ts` passes its own `frameT0`. Two `performance.now()` calls in
     * one frame are two different numbers, and a cadence pacing itself off one
     * while the trace column recorded the other would be a rate nobody could
     * reproduce from the CSV.
     */
    update(state: HudState, nowMs: number = performance.now()) {
      // Every call, admitted or not: `seconds` is the panel's LIFE, so that
      // `rateHz` is repaints per second of running and not per second of
      // painting, which would be 1/interval by construction and say nothing.
      counter.seen(nowMs)
      // ── DEV-257: the gauges move at FRAME RATE, ahead of every gate ─────
      //
      // Before the signature, before `owed`, and before the budget — because
      // the whole argument for moving these four readings onto geometry is
      // that a matrix is not a canvas raster and therefore does not need
      // rationing. DEV-248 budgets the panel at 10 Hz and the visible cost of
      // that is a speed readout stepping nine times a second; under this arm
      // the gauge is smooth at frame rate and the numbers that remain
      // genuinely only change once a second. **Better on both axes, not a
      // trade** — and it stops being true the moment this call sits below one
      // of the returns beneath it.
      mesh?.update(state)
      // DEV-360. The dome's signature holds only what the dome draws — no
      // speed, no clock, no count — so a JumpSeat hovering on a steady throttle
      // does not repaint at all.
      const next = layout === 'fuel' ? fuelSignature(state) : hudSignature(state, gauges)
      const changed = next !== signature
      // THE SIGNATURE IS COMPARED ON EVERY FRAME AT EVERY CADENCE, and
      // `signature` advances whether or not the paint is admitted, so the
      // comparison always answers *"has the state moved since I last looked"*
      // rather than *"since I last painted"*.
      signature = next
      if (!changed) unchanged += 1
      // ── `owed`, and why a budget without one silently loses an update ────
      //
      // A signature that moves once and then holds — a gate passed, a banner
      // raised, a medal awarded, the panel sitting at `SPEED: 0` on the pad —
      // changes on exactly ONE frame. If that frame is inside the budget's
      // interval the paint is refused, and every frame afterwards compares
      // equal and returns: the panel would show the PREVIOUS reading for the
      // rest of the run, with every number it holds correct and stale. So a
      // refusal is remembered, and the next frame the budget admits repaints
      // whether or not anything moved on that particular frame.
      //
      // It draws the CURRENT state, not the one that was owed. What the player
      // wants is the latest reading; what they must never get is no reading.
      if (!changed && !owed) return
      if (!budget.admit(true, nowMs)) {
        skipped += 1
        owed = true
        return
      }
      owed = false
      counter.painted(nowMs)
      draw(state)
    },
    /**
     * DEV-250. The flight layout's first raster, under the curtain.
     *
     * Three deliberate omissions, and each one is a way this could have gone
     * wrong quietly:
     *
     *  · no `budget.admit` and no `lastPaintMs` — the launch banner must still
     *    paint on the frame it arrives, and a warm that paced the budget would
     *    hold it for up to an interval;
     *  · no `signature` write — the first live `update()` must see a change,
     *    or the panel keeps the warm picture for the whole ride;
     *  · no `counter.painted` / `counter.seen` — `rateHz` is repaints per
     *    second of a panel's LIFE and a boot-time paint is not a repaint.
     *    `warmPaints` is reported separately so nothing is hidden, and
     *    `uploads` (three's own counter) is the number that would disagree if
     *    it were.
     *
     * `lastCanvasOps` is put back for the same reason: `report().canvasOps`
     * means "what the last REPAINT asked for", and a warm answering that
     * question would make `repaints: 0` and a non-zero `canvasOps` appear
     * together, which is the shape of a draw path that forgot to count itself.
     */
    warm(state: HudState): HudCanvasOps {
      const previousOps = lastCanvasOps
      draw(state)
      const ops = lastCanvasOps
      lastCanvasOps = previousOps
      warmPaints += 1
      return ops
    },
    setRedraw(next: HudRedraw) {
      budget.set(next)
    },
    setGauges(next: HudGauges) {
      // DEV-257. Guarded for `setUpload`'s reason and a heavier one: an
      // unguarded call would dispose and rebuild a `BufferGeometry` and a
      // `Material` ninety times a second, and each rebuild is a fresh program
      // compile the first time it binds. `app.ts` calls this every frame.
      //
      // The guard is also what keeps the arm an ARM: with the pin at `off` and
      // the mode already `off`, this returns before `applyGauges` can allocate
      // anything, on every frame of every run that does not ask for gauges.
      if (sameHudGauges(gauges, next)) return
      gauges = next
      applyGauges()
      // The signature's SHAPE changes with the mode — four entries freeze —
      // so the string cached from the old mode is not comparable to the new
      // one. Cleared rather than recomputed: the next `update` must repaint,
      // because the canvas has to lose or regain three bars and a row.
      signature = ''
      owed = true
    },
    setMount(next: HudMount) {
      // DEV-362. Guarded, because `boot/app.ts` asserts it every frame and a
      // real change swaps the geometry and repaints the canvas.
      //
      // The dash is the HoverJet's rows on 2016's two screens. DEV-360's fuel
      // dome has no dash to be set into — 2016's JumpSeat gauge stood free in
      // front of the shell — so that panel stays on the lens whatever it is
      // asked, and its own geometry, canvas and drawing are never touched here.
      if (layout === 'fuel') return
      if (next === mount) return
      mount = next
      applyMount()
      signature = ''
      owed = true
    },
    setSidePlate(plate: THREE.Object3D | null, widthMetres: number) {
      const width = plate ? widthMetres : 0
      if (plate === sidePlate && width === sidePlateWidth) return
      // A NEW plate put itself beside the lens panel when it was built
      // (`render/race-map.ts`); that is the place it goes back to.
      if (plate && plate !== sidePlate) sidePlateLensX = plate.position.x
      sidePlate = plate
      sidePlateWidth = width
      applyMount()
      // Only the dash's text column moves for a plate; the lens panel's
      // canvas does not know it is there, so a repaint there would be a paint
      // of the same pixels.
      if (mount === 'dash') {
        signature = ''
        owed = true
      }
    },
    get mount() {
      return mount
    },
    setUpload(next: HudUpload) {
      // Guarded, because every one of these three fields is in three's texture
      // cache key (`:11533`) and a write that changes one reallocates the whole
      // `WebGLTexture` on the next bind. `app.ts` calls this every frame.
      if (sameHudUpload(upload, next)) return
      upload = next
      applyUpload()
    },
    setRaster(next: HudRaster) {
      // Guarded for a harder reason than `setUpload`'s: this one does not write
      // a field, it REBUILDS the surface. `app.ts` calls it every frame.
      if (sameHudRaster(raster, next)) return
      const previous = surface
      raster = next
      surface = buildSurface(raster)
      canvas = surface.canvas
      ctx = surface.ctx
      texture = surface.texture
      rasterRebuilds += 1
      // Three's own counter on the texture we are about to throw away, banked
      // so `uploads` keeps meaning "uploads this PANEL has caused". See
      // `retiredUploads`.
      retiredUploads += previous.texture.version
      // Carry the pixels, so the panel never blinks out mid-flight. One
      // `drawImage` of the old element onto the new context — no state is kept
      // and none is replayed, which is DEV-032's rule (never hold a caller's
      // object past the call) honoured by having nothing to hold.
      //
      // Guarded on the method rather than on an environment check because the
      // node stub in the unit suite implements the calls it counts and not the
      // whole 2-D API, and a panel that throws in a headless test is a panel
      // nobody can test.
      if (typeof ctx.drawImage === 'function') ctx.drawImage(previous.canvas, 0, 0)
      // AND NO `texture.needsUpdate = true` HERE, deliberately. `CanvasTexture`'s
      // constructor already set it (which is the extra upload
      // `CanvasPanelReport.uploads` documents), nothing has rendered between
      // that and the `drawImage` above, so the carried pixels are in the
      // element before three ever looks at it. A second `needsUpdate` would
      // upload nothing extra and would bump `texture.version` to 2 — and that
      // counter IS the report's `uploads`, so the panel would report an upload
      // the GPU never made. The unit suite holds the exact relation
      // (`uploads === repaints + 1 + rasterRebuilds`), which is how this was
      // found rather than reasoned.
      material.map = texture
      // `needsUpdate` on the MATERIAL as well, and it is not superstition:
      // three caches the bound texture per program and a swapped `map` must be
      // re-uniformed. The map is the same size, colour space and filter set, so
      // this does not move the PROGRAM cache key (`render/program-cache-key.ts`
      // / DEV-194) — it refreshes the uniform.
      material.needsUpdate = true
      // Three deletes the old `WebGLTexture` on the next render:
      // `dispose()` fires `onTextureDispose` (`three.module.js:11329`), which
      // calls `deallocateTexture` (`:11363`), which decrements the source's
      // `usedTimes` and calls `deleteTexture` at zero — and then drops the
      // whole `_sources` entry, because the retired CANVAS is a retired
      // `Source` no other texture shares.
      previous.texture.dispose()
      // The new canvas is blank behind the carried pixels' alpha, so the panel
      // OWES a native repaint through the new backend. `owed` is the existing
      // mechanism for exactly this — a paint the panel is behind on — and the
      // next admitted `update()` pays it whether or not the signature moved.
      owed = true
    },
    get paints() {
      return budget.repaints
    },
    report(): HudReport {
      // DEV-244. Read back off the TEXTURE, not off `upload` — an echo of the
      // intent cannot tell a pin that landed from one that never reached the
      // panel, which is the whole job of the e2e mechanism check that consumes
      // this.
      const live = classifyHudTexture({
        generateMipmaps: texture.generateMipmaps,
        minFilter: texture.minFilter,
        anisotropy: texture.anisotropy,
      })
      // DEV-256. Read back off the live CONTEXT for `liveUpload`'s reason, and
      // it is the only read available: the mode is not a field on anything this
      // module owns after construction. `classifyHudRaster` says which half of
      // the question this settles.
      const liveRaster = classifyHudRaster(ctx)
      return {
        // `texture.version` is three's own counter, not a second one of ours.
        // See `CanvasPanelReport.uploads`. `texture.generateMipmaps` is read
        // the same way, so `mipBytes` says what the GPU is doing rather than
        // what this module asked for.
        ...counter.report(
          'hud',
          canvas.width,
          canvas.height,
          texture.version + retiredUploads,
          texture.generateMipmaps,
        ),
        cadence: describeHudRedraw(budget.policy),
        upload: describeHudUpload(upload),
        liveUpload: live === null ? null : describeHudUpload(live),
        raster: describeHudRaster(raster),
        liveRaster: liveRaster === null ? null : describeHudRaster(liveRaster),
        rasterRebuilds,
        canvasOps: lastCanvasOps,
        // DEV-257. The MODE and the live quad count, separately, for
        // `liveUpload`'s reason: an echo of the intent cannot tell a pin that
        // landed from one that never reached the panel, and this panel is
        // re-created on every course swap.
        gauges: describeHudGauges(gauges),
        gaugeQuads: mesh?.live ?? 0,
        mount,
        unchanged,
        skipped,
        warmPaints,
        layout,
      }
    },
    dispose() {
      // DEV-362. Both geometries, whichever is on the mesh right now.
      lensGeometry.dispose()
      dashGeometry?.dispose()
      material.dispose()
      texture.dispose()
      // DEV-257. Null with the arm down, which is the whole of what "nothing
      // is constructed" buys on the way out too.
      mesh?.dispose()
    },
  }
}

/**
 * Everything the panel DRAWS, as one string. Redraw when it changes.
 *
 * The clock ticks ~80 times a second and the panel shows whole seconds, so this
 * is the difference between a canvas upload per frame and one every so often.
 *
 * **Exported so that it can be tested at all.** It lived inside `createHud`,
 * which needs a 2-D canvas, which means no unit test in an `environment: 'node'`
 * suite could reach it — so the rule "the signature holds what is drawn, not
 * what it is drawn from" was enforced by nothing. Adding a unit to the speed row
 * is exactly the change that breaks it: `Math.round(state.speed)` tracks the
 * text until a factor of 3.6 sits in between, and then a panel can go stale
 * while every value it reads is correct.
 */
export const hudSignature = (state: HudState, gauges: HudGauges = HUD_GAUGES_OFF): string => {
  // DEV-257. The four continuous readings leave the canvas AND leave this
  // string, together. **Both or neither**: dropping them from the draw alone
  // leaves the panel rastering itself for bars it no longer carries — the cost
  // with none of the benefit — and dropping them from the signature alone
  // leaves a stale panel, which is the worse of the two because it looks
  // right. `tests/unit/hud-gauges.test.ts` drives the real `draw()` and asserts
  // the pairing directly, because a rule enforced by two edits in two places is
  // exactly the thing this repo has watched drift.
  //
  // A constant rather than a removed entry: the join's SHAPE stays the same
  // across the arm, so an off/on diff of two signatures reads as which fields
  // moved rather than as everything shifting one place left.
  const still = hudGaugesOn(gauges)
  const frozen = '='
  return [
    state.ringsPassed,
    // The TEXT, not the number it came from — and this row is the reason that
    // rule is written down twice. `Math.floor(state.elapsed)` tracked the text
    // exactly while the text WAS the floored elapsed seconds; the moment
    // `formatTime` put a subtraction and a rounding in between, a clock that
    // rounds 110.5 up to `111` while the floor still says `110` would have gone
    // a whole second stale with every value it reads correct. (DEV-200.)
    formatTime(state.elapsed, state.timeLimit, state.timeCountsDown),
    // The TEXT, not the number it came from — see above. One entry covers both
    // the value and the unit because one entry IS the row. DEV-257 routes it
    // through the SAME call `draw()` makes, so a coarsened row and a row that
    // is not drawn at all are both tracked by construction rather than by a
    // second reading of the rule.
    hudSpeedText(state, gauges) ?? frozen,
    state.medal,
    state.finished,
    state.award ?? '',
    // The tone is part of what is DRAWN, so a hit and a broken streak with the
    // same text but different colours must not be collapsed into one redraw.
    // (Today they never share text; tomorrow is not today.)
    state.awardTone ?? '',
    state.multiplier ?? 1,
    state.banner ?? '',
    state.autopilot,
    // The label changes with the mode, and a run that changed mode without
    // redrawing would keep the old word on a panel nobody else touches.
    state.countLabel,
    // Same argument, one level up: these come from the level's own data now, so
    // a mission whose copy differs must repaint. Drawn and not in the signature
    // is how a label goes stale until something else moves it.
    state.timeLabel,
    state.speedLabel,
    state.ringsTotal,
    // THE COMBO'S BAR (DEV-110; the GATES line since DEV-615). Quantised to
    // what a 6 %-height strip can actually show, because the chain's cooldown
    // counts down EVERY TICK, so the raw float would put this panel back to
    // repainting 82 times a second and undo the whole reason a signature
    // exists. Twenty steps is half a pixel on the bar at the panel's texture
    // width. (G1's proximity meter was the second bar here until DEV-615 took
    // it off the panel, and its entry went with it.)
    //
    // DEV-257 freezes the FRACTION and leaves `stacks` alone, and the split is
    // exact rather than convenient: the fraction is the bar, which is geometry
    // under the arm, and `stacks` is the `+N` badge, which is still text on
    // this canvas, and whether the track is drawn at all. A signature that
    // froze `stacks` too would leave that badge a gate behind.
    state.chain === undefined ? '-' : state.chain.stacks,
    still ? frozen : state.chain === undefined ? '-' : Math.round(state.chain.fraction * 20),
    // DEV-143's tank. Same argument and the same quantisation: it moves every
    // tick while boost is held (16 % of the bar a second at the Anniversary
    // rate), so the raw float would repaint the canvas 82 times a second. Forty
    // steps rather than twenty because this bar is twice as tall and half a
    // pixel of it is half as many units.
    //
    // `available` is in the signature and MUST be: an empty tank and a
    // locked-out tank have the same `fraction` at the instant the lockout
    // latches, so a signature without it would leave the bar amber-coloured
    // through a lockout that had already started.
    // Both halves of the tank go, and `available` has to go WITH `fraction`:
    // it is a colour on the same geometry now, so leaving it here would be the
    // canvas repainting because a bar it does not draw changed hue.
    still ? frozen : state.energy === undefined ? '-' : Math.round(state.energy.fraction * 40),
    still ? frozen : state.energy === undefined ? '-' : state.energy.available,
    // DEV-567: READY and BOOST are one `available` and two words, and the
    // threshold mark sits at `reengage`. Both are drawn, so both are here.
    still ? frozen : state.energy === undefined ? '-' : (state.energy.burning ?? '-'),
    still ? frozen : state.energy === undefined ? '-' : (state.energy.reengage ?? '-'),
    // DEV-399: the glider's stall bar, and its warning. Twenty steps, the two
    // bars' quantisation, because it moves with the airspeed every tick; and
    // NOT frozen by the gauge arm, which never takes it off the canvas.
    // `stalling` must go with it: it is the bar's colour AND the STALL badge.
    state.stall === undefined ? '-' : Math.round(state.stall.margin * 20),
    state.stall === undefined ? '-' : state.stall.stalling,
  ].join('|')
}
