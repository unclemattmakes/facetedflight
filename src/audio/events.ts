// src/audio/events.ts — the event map. PURE. This file IS the audio port.
//
// ── Why a map and not a pile of `play()` calls ────────────────────────────
//
// D13, resolved: the SFX are synthesized, so the samples are new by definition
// and the only fidelity left to preserve is **what fires, when, at what gain,
// routed where**. That is a mapping from game moments to cues, and a mapping is
// data — so it is testable in node with no `AudioContext`, and so a reviewer
// can read the whole port in one screen instead of grepping call sites.
//
// The moments are FF2's, taken from the shipped flow in `src/boot/app.ts`:
// title -> hangar chair -> holotable -> lift -> 3-2-1-GO -> 21 gates against
// two AI racers -> results -> back to the chair. Each one names the 2016 call
// site it is a port of, or says plainly that it is ours.
//
// ── What is deliberately NOT here ─────────────────────────────────────────
//
// A cue for pausing. `Input_Ship.Pause()` (`:524`) and `Unpause()` (`:540`)
// play **nothing** — the only `MasterAudio.PlaySound` calls in that whole file
// are `Thrusters` and `AfterBurner`. The `notification`-on-pause and
// `CoundownGo`-on-unpause pair that doc 06 attributes to the HoverJet lives in
// `Input_Manager.cs:350`/`:369`, and that script's guid appears in exactly
// three files — `JumpSeat_Photon.prefab` and two experiment scenes. It is the
// JUMPSEAT's input script. So FF2's pause panel is silent except for its rows,
// which use 2016's own menu cues. (AUD-6.)

import type { CueId } from './cues'
import type { CueAction } from './engine'
import { GATE_LOSS_VOICE, type GateLossKind, ladderPitch } from './ladder'
import type { Vec3Tuple } from './spatial'

/**
 * A moment in the game, as the app's state machine sees it.
 *
 * Named for what HAPPENED, never for what should be heard — `'gate.passed'`,
 * not `'play ring ding'`. That is what lets the map change without the caller
 * changing, which is the same reason `content/levels/*.json` exists.
 */
export type AudioEvent =
  /** The nose pointer / gaze crossed onto a selectable thing. */
  | { readonly type: 'ui.focus' }
  /** A commit: title A, the holotable, RESUME, RESTART. */
  | { readonly type: 'ui.confirm' }
  /** A retreat: pause EXIT. FF2 — 2016's menu has no back. */
  | { readonly type: 'ui.back' }
  /** `startLaunch()`. The lift is called and the ride begins. */
  | { readonly type: 'launch.start' }
  /**
   * The platform has risen past one of the shaft's collars.
   *
   * `at` is the WORLD point of the collar — 2016's `Trigger_PlaySound` box. The
   * caller supplies it because only the render layer knows where the shaft is
   * standing; this module never learns about `three`. AUD-5.
   */
  | { readonly type: 'shaft.pass'; readonly at: Vec3Tuple }
  /** `'rising' -> 'countdown'`: the platform has topped out. */
  | { readonly type: 'launch.topped' }
  /** One numbered beat of the 3-2-1. `n` is 3, 2 or 1. */
  | { readonly type: 'countdown.beat'; readonly n: number }
  /** GO. The ship is released and the clock starts. */
  | { readonly type: 'countdown.go' }
  /** The ambience for a mission that has just become audible. */
  | { readonly type: 'mission.begin' }
  /** Leaving the cockpit for the chair, or restarting the run. */
  | { readonly type: 'mission.end' }
  /**
   * A scoring gate, `index` in `[0, ringsTotal)`.
   *
   * `kind` is what was crossed, and it exists for exactly one consumer: S4's
   * gate whoosh, which fires on a RING and on nothing else. A ring is a
   * 24 x 35 m hole you fly through; a pad plate is a target you shoot past and
   * an orb is a thing you touch, and neither has any air in it.
   *
   * **Optional, because the two callers that are not rings deliberately carry
   * nothing.** 2016 plays the same `CollectRing` cue for all three
   * (`TriggerCheckpoint.cs:90` and `Trigger_JumpTarget.cs:66`), so the map below
   * does not branch on it and an absent `kind` is the faithful default. The
   * guard against it being silently forgotten is
   * `tests/unit/audio-engine.test.ts`, which asserts both directions rather than
   * only the one that works. DEV-084.
   */
  | {
      readonly type: 'gate.passed'
      readonly index: number
      readonly kind?: 'ring' | 'pad' | 'orb'
      /**
       * DEV-638: the sim's verdict on this gate (`MissionEvent.gateClean`), and the
       * ladder's count AFTER it (`game/gate-feel.ts`). Both absent where the rules
       * have no clean gate (Classic, a pad, an orb), and then the gate sounds as it
       * always did. Present and `clean` true, `ring.pass` climbs one semitone per
       * consecutive clean gate, capped at an octave.
       */
      readonly clean?: boolean
      readonly streak?: number
    }
  /**
   * DEV-639: something was LOST. A gate flown off the middle (`miss`), a clean
   * streak broken (`streak`), or the speed chain run out (`chain`). One cue, three
   * pitches and three levels: a soft descending fall, so a gain means something.
   */
  | { readonly type: 'gate.loss'; readonly loss: GateLossKind }
  /**
   * Terrain contact. `impact` is the speed INTO the surface in m/s when the
   * caller has it (DEV-643): the crash's gain and low end scale with it. Absent
   * is 2016's cue at its authored level, as it always was.
   */
  | { readonly type: 'ship.struck'; readonly impact?: number }
  /**
   * A near miss with terrain (DEV-642). `at` is the WORLD point (three space) the
   * whoosh is emitted from, toward the terrain that was nearly hit.
   */
  | { readonly type: 'ship.nearMiss'; readonly at?: Vec3Tuple }
  /**
   * A racer struck the player hard enough to be a HIT, not a lean
   * (`sim/craft-hit.ts`, `gameplay.racers.hit`). FF2's: the DEV-364 follow-up.
   */
  | { readonly type: 'ship.hit' }
  /** Out of bounds: the reset countdown is running. Fired once a second. */
  | { readonly type: 'boundary.warning'; readonly secondsLeft: number }
  /** The ship has been put back at the respawn marker. */
  | { readonly type: 'ship.respawn' }
  /** The finish gate. `Trigger_FinishLine.TriggerFinale()`. */
  | { readonly type: 'run.finish' }
  /** The results panel is up and the medal is decided. */
  | { readonly type: 'run.medal'; readonly medal: string }
  /** A lesson prompt went up: look at the plate. DEV-377. */
  | { readonly type: 'lesson.prompt' }
  /** A lesson step was done. DEV-377. */
  | { readonly type: 'lesson.done' }
  /** FF TV's ident came up: a new show. DEV-482. */
  | { readonly type: 'tv.ident' }
  /** DEV-640: a ring put fuel back in the boost tank. */
  | { readonly type: 'tank.fill' }
  /** DEV-640: the boost tank just ran dry. */
  | { readonly type: 'tank.empty' }
  /** DEV-640: boost was pressed with nothing in the tank. */
  | { readonly type: 'tank.dry' }
  /** DEV-641: the player's place in the race changed. `gained` is true for a better place. */
  | { readonly type: 'race.position'; readonly gained: boolean }
  /**
   * DEV-641: a ship went by close. `at` is WORLD, where it was at the closest
   * approach, so the whoosh is panned to the side it passed on; `gain` is the
   * pass's strength, 0..1 (`game/flyby.ts`'s trauma is the measure).
   */
  | { readonly type: 'ship.flyby'; readonly at: Vec3Tuple; readonly gain: number }

export type AudioEventType = AudioEvent['type']

/** DEV-644: which cue each medal tier plays. A grade not named here gets `run.medal`. */
export const MEDAL_CUES: Readonly<Record<string, CueId>> = {
  bronze: 'medal.bronze',
  silver: 'medal.silver',
  gold: 'medal.gold',
  platinum: 'medal.platinum',
}

/** Impact speed (m/s) at and below which a terrain strike is 2016's cue, unscaled. A graze. */
export const CRASH_WEIGHT_FROM = 20
/** Impact speed (m/s) at and above which a strike is at full weight (a boosted nose-in). */
export const CRASH_WEIGHT_FULL = 140
/** Extra gain on `ship.crash` at full weight (so 2.4x at the top). */
export const CRASH_GAIN_BOOST = 1.4
/** The pitch `ship.crash` loses at full weight (down to 0.72 of its own). */
export const CRASH_PITCH_DROP = 0.28

/**
 * How heavy a strike was, 0..1, from the speed into the surface: 0 up to
 * `CRASH_WEIGHT_FROM` (and for no speed at all), linear to 1 at
 * `CRASH_WEIGHT_FULL`. Pure. DEV-643.
 */
export const crashWeight = (impact: number | undefined): number => {
  if (impact === undefined || !(impact > CRASH_WEIGHT_FROM)) return 0
  const t = (impact - CRASH_WEIGHT_FROM) / (CRASH_WEIGHT_FULL - CRASH_WEIGHT_FROM)
  return t > 1 ? 1 : t
}

/** 2016's `FadeOutAllOfSound("elevator_moving", 1.7f)` — `ScriptedAudio_elevator.cs:24`. */
export const ELEVATOR_STOP_SECONDS = 1.7

/** What a mission-wide teardown fades over. Long enough not to click. */
export const MISSION_END_FADE_SECONDS = 0.6

/**
 * Loops that belong to the mission rather than to the engine.
 *
 * `engine.ts` owns its own five; these are the two ambience beds plus the lift,
 * and between the two lists every looping cue in the catalogue has exactly one
 * owner. `tests/unit/audio-events.test.ts` asserts that.
 */
export const AMBIENT_LOOPS: readonly CueId[] = ['ambient.island', 'ambient.water']

/**
 * The map, as a function, appending to the caller's array.
 *
 * Returns `out`. Every branch is exhaustive over `AudioEvent['type']`, which
 * `noFallthroughCasesInSwitch` and the `never` at the bottom enforce: adding an
 * event without mapping it is a type error, not a silent no-op.
 */
export const actionsForEvent = (event: AudioEvent, out: CueAction[]): CueAction[] => {
  switch (event.type) {
    // ── the menu language ─────────────────────────────────────────────
    //
    // `FF_GearVR/Scripts/Input_Look.cs:149` plays `button_hover` when the gaze
    // crosses a button and `:168` plays `button_click` when it is taken. FF2's
    // nose pointer is that mechanism, so this is a port.
    case 'ui.focus':
      out.push({ kind: 'play', cue: 'ui.hover' })
      return out
    case 'ui.confirm':
      out.push({ kind: 'play', cue: 'ui.confirm' })
      return out
    case 'ui.back':
      out.push({ kind: 'play', cue: 'ui.back' })
      return out

    // ── the launch shaft ──────────────────────────────────────────────
    //
    // `ScriptedAudio_elevator.cs:15` and `:17` are 0.1 s and 0.3 s into a
    // coroutine whose clock starts when the ship is INSTANTIATED. FF2 anchors
    // them to `LaunchState` instead, which is the only frame where they mean
    // something: the ride is the thing they are the sound of, and 2016's own
    // offsets measure from a different origin (see `docs/audio-event-map.md`
    // §4.1). The 0.2 s between the servo and the loop survives as the loop's
    // own 0.25 s fade-in.
    case 'launch.start':
      out.push({ kind: 'play', cue: 'elevator.start' })
      // AUD-1: 2016's `elevator_moving` group is `isMuted: 1`, so the ride has
      // nothing under it. FF2 plays it — Matt, 2026-09-12, and the deviation is
      // settled rather than provisional now. Delete this line to revert.
      out.push({ kind: 'play', cue: 'elevator.loop' })
      // DEV-424: the island's bed, here as well as on `mission.begin`. That
      // event is sent on ONE route — boarding the course that is already
      // loaded — and every other way onto a pad goes through `switchMission`,
      // which sends none: the first course of a session, every change of
      // course, Quick Race, Learn to Fly. And a retry's `mission.end` stops the
      // bed. So the island was silent on nearly every run anyone flew. A loop
      // refuses to restart itself (`retrigger: 'ignore'`), so where
      // `mission.begin` did start it this is a no-op.
      out.push({ kind: 'play', cue: 'ambient.island' })
      return out

    // ── the eight collars, and they are POSITIONAL in 2016 ────────────
    //
    // `Trigger_PlaySound.cs:12` is `PlaySound3DAtVector3(soundName,
    // this.transform.position)`, and `PlayerStart_ElevatorShaft_Photon.prefab`
    // carries EIGHT of those boxes, all live, all `soundName: whoosh`, spaced
    // exactly 12 m apart up the shaft — the level schema's own
    // `shaft.segmentSpacing` over its `segmentsAuthored`. Each one fires once
    // as the lift passes it and then `Destroy(gameObject, 0.25f)`.
    //
    // The port had this cue missing entirely, not merely flattened. AUD-5.
    case 'shaft.pass':
      out.push({ kind: 'play', cue: 'shaft.whoosh', at: event.at })
      return out

    case 'launch.topped':
      out.push({ kind: 'stop', cue: 'elevator.loop', fadeSeconds: ELEVATOR_STOP_SECONDS })
      // DEV-424: the water, at the top of the shaft. This is where 2016 puts
      // it: `ScriptedAudio_elevator.cs:21` plays `ambient_water` at t+14.3 s of
      // the lift coroutine, beside `:24`'s fade of the loop above, which is
      // this same moment. `mission.begin` still starts it early on the one
      // route that sends it, and then this is a no-op (see `launch.start`).
      out.push({ kind: 'play', cue: 'ambient.water' })
      return out

    // ── 3-2-1-GO, and it is FAITHFUL ──────────────────────────────────
    //
    // `Timer_Race.cs:83` `PlaySound3DAtTransform("CountdownNumber", ...)` per
    // numbered beat and `:72` `CoundownGo` on the last. The coroutine is
    // reached through `Trigger_EnableShip.cs:66-68`, which calls the public
    // `StartCountdown()` regardless of `useCountdown` — see `cues.ts`. Three
    // beats and a GO, one second apart, off `countdownTime: 3` /
    // `delayBetweenCountdown: 1` in `int_01_hoverJet.unity:259951-259952`.
    case 'countdown.beat':
      out.push({ kind: 'play', cue: 'countdown.beat' })
      return out
    case 'countdown.go':
      out.push({ kind: 'play', cue: 'countdown.go' })
      return out

    // ── mission ambience ──────────────────────────────────────────────
    //
    // `Ambient_Island` is per-ENVIRONMENT data on `LevelArt_SimonetIslands.prefab`
    // played by `Level_Audio.cs:17`, with a 1 s fade-in that the variation
    // really does apply. `ambient_water` is the elevator coroutine's t+14.3 s
    // call (`ScriptedAudio_elevator.cs:21`) — in FF2 it comes in with the rest
    // of the mission rather than on a clock with a different origin.
    case 'mission.begin':
      out.push({ kind: 'play', cue: 'ambient.island' })
      out.push({ kind: 'play', cue: 'ambient.water' })
      return out
    case 'mission.end':
      for (const id of AMBIENT_LOOPS) {
        out.push({ kind: 'stop', cue: id, fadeSeconds: MISSION_END_FADE_SECONDS })
      }
      out.push({ kind: 'stop', cue: 'elevator.loop', fadeSeconds: MISSION_END_FADE_SECONDS })
      return out

    // ── a gate: TWO sounds, not one ───────────────────────────────────
    //
    // `TriggerCheckpoint.cs:90` plays `CollectRing` and, on the same ring,
    // `EnergySystem_Ship.AddGate()` :274 plays `PowerupBoost` because
    // `playerShip.orbEffects` is non-null on the shipped prefab. Doc 06 filed
    // the second as a separate "boost powerup collected" event; it is not, it
    // is the other half of every scoring ring. 21 of them a lap in `int_01`.
    case 'gate.passed':
      // DEV-638: a CLEAN gate sits on the ladder (one semitone per consecutive
      // clean gate, the variations skipped so every rung is where it says); every
      // other gate is the cue 2016 plays, six variations and all.
      if (event.clean === true) {
        out.push({
          kind: 'play',
          cue: 'ring.pass',
          pitch: ladderPitch(event.streak ?? 1),
          exact: true,
        })
      } else {
        out.push({ kind: 'play', cue: 'ring.pass' })
      }
      out.push({ kind: 'play', cue: 'ring.boost' })
      return out

    // ── a loss, said (DEV-639) ────────────────────────────────────────
    //
    // FF2's. The sim already knows (`recordGate` returned false; the chain's
    // stacks went to zero); a loss with feedback is what makes a gain mean
    // something. One cue at three pitches and three levels (`ladder.ts`).
    case 'gate.loss': {
      const voice = GATE_LOSS_VOICE[event.loss]
      out.push({ kind: 'play', cue: 'gate.dud', gain: voice.gain, pitch: voice.pitch })
      return out
    }

    // ── damage ────────────────────────────────────────────────────────
    //
    // `Ship_HoverShip.Flash()` :397. Note what else that coroutine does at
    // :408-409 — `BoostReleased()` then `GasReleased()` — so a crash CUTS both
    // engine loops. FF2 gets that for free: `app.ts` does not clear the stick
    // on a strike, so `stepEngineAudio` keeps them running, which is the more
    // defensible behaviour and is what a terrain scrape (as against 2016's
    // scripted flash) should sound like. The 2.3 s re-arm at :412/:421/:424 is
    // a gameplay cooldown, not an audio one.
    case 'ship.struck': {
      // DEV-643: the weight of it. A graze stays 2016's cue at its authored level;
      // a hard hit is louder, lower, and carries a sub layer under it.
      const w = crashWeight(event.impact)
      if (w <= 0) {
        out.push({ kind: 'play', cue: 'ship.crash' })
        return out
      }
      out.push({
        kind: 'play',
        cue: 'ship.crash',
        gain: 1 + CRASH_GAIN_BOOST * w,
        pitch: 1 - CRASH_PITCH_DROP * w,
      })
      out.push({ kind: 'play', cue: 'ship.crash.sub', gain: w })
      return out
    }

    // DEV-642: ANNIVERSARY S4's other half. A whoosh from the side of the terrain
    // that was nearly hit.
    case 'ship.nearMiss':
      out.push({ kind: 'play', cue: 'terrain.whoosh', at: event.at ?? null })
      return out

    // ── a racer's hit (the DEV-364 follow-up) ─────────────────────────
    //
    // FF2's moment — 2016's opposition was a recording nothing could touch —
    // on 2016's sound for it: the mission bank's `hit` group, configured and
    // never called (AUD-4's shape). Only on Anniversary, because only there
    // can a racer touch you (`gameplay.racers.contact`), and only past the
    // hit's `minSpeed`: two ships leaning together make no sound.
    case 'ship.hit':
      out.push({ kind: 'play', cue: 'ship.hit' })
      return out

    // ── out of bounds ─────────────────────────────────────────────────
    //
    // AUD-4, and it is FF2's. `Scripts/PlayerBoundary.cs` makes no audio call
    // of any kind — 2016's out-of-bounds death is silent, with only the HUD
    // banner. FF2's `resetDelay` is 13 s (the shipped value in all thirteen
    // missions, against the C# initialiser's 10), and in a headset a silent
    // thirteen-second countdown to a run reset is one you do not notice. The
    // cue is `CockpitAlarm2`, a mission-bank group 2016 configured and never
    // called from anywhere.
    case 'boundary.warning':
      out.push({ kind: 'play', cue: 'boundary.warn' })
      return out
    case 'ship.respawn':
      out.push({ kind: 'play', cue: 'ship.reboot' })
      return out

    // ── the end of a run ──────────────────────────────────────────────
    //
    // `Trigger_FinishLine.cs:72` on the gate that ends the run, then
    // `LevelEnd.cs:254` 0.1 s after `UpdateEndUI()` — i.e. as the panel
    // appears. Two separate moments in 2016 and two in FF2: crossing the line
    // is not the same instant as the medal landing.
    case 'run.finish':
      out.push({ kind: 'play', cue: 'run.finish' })
      return out
    case 'run.medal':
      // 2016's `AwardMedal()` plays the same `awardMedal` group whatever the
      // string is. The grade was carried on the event for "a future platinum
      // gets its own flourish", and DEV-644 is that: a phrase per tier. A string
      // that is no tier (a medal id from some future course) still gets 2016's
      // one cue, so a new grade is never silent.
      out.push({ kind: 'play', cue: MEDAL_CUES[event.medal] ?? 'run.medal' })
      return out

    // ── the tank (DEV-640) and the field (DEV-641): FF2's, both editions ──
    case 'tank.fill':
      out.push({ kind: 'play', cue: 'tank.fill' })
      return out
    case 'tank.empty':
      out.push({ kind: 'play', cue: 'tank.sputter' })
      return out
    case 'tank.dry':
      out.push({ kind: 'play', cue: 'tank.dry' })
      return out
    case 'race.position':
      out.push({ kind: 'play', cue: event.gained ? 'race.gain' : 'race.loss' })
      return out
    case 'ship.flyby':
      out.push({ kind: 'play', cue: 'flyby.whoosh', at: event.at, gain: event.gain })
      return out

    // ── the flight instructor (DEV-377) ───────────────────────────────
    //
    // FF2's two chirps, one each, and both editions: a lesson is a new
    // mission, not a change to a 2016 behaviour.
    case 'lesson.prompt':
      out.push({ kind: 'play', cue: 'lesson.prompt' })
      return out
    case 'lesson.done':
      out.push({ kind: 'play', cue: 'lesson.done' })
      return out

    // ── FF TV (DEV-482): the ident's sting, plan/FF-TV.md §5.4 ─────────
    case 'tv.ident':
      out.push({ kind: 'play', cue: 'tv.ident' })
      return out

    default: {
      const never: never = event
      throw new Error(`unmapped audio event: ${JSON.stringify(never)}`)
    }
  }
}

/** Every event type the map handles, for the coverage test. */
export const AUDIO_EVENT_TYPES: readonly AudioEventType[] = [
  'ui.focus',
  'ui.confirm',
  'ui.back',
  'launch.start',
  'shaft.pass',
  'launch.topped',
  'countdown.beat',
  'countdown.go',
  'mission.begin',
  'mission.end',
  'gate.passed',
  'gate.loss',
  'ship.struck',
  'ship.nearMiss',
  'ship.hit',
  'boundary.warning',
  'ship.respawn',
  'run.finish',
  'run.medal',
  'lesson.prompt',
  'lesson.done',
  'tv.ident',
  'tank.fill',
  'tank.empty',
  'tank.dry',
  'race.position',
  'ship.flyby',
]
