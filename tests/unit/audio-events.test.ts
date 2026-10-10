// tests/unit/audio-events.test.ts — the map, which IS the audio port.
//
// D13 resolved: the SFX are synthesized, so the samples are new by definition
// and the only fidelity available is what fires, when, at what gain. That is
// this map. A cue the map can never reach is dead weight; an event the map does
// not answer is a silent moment; a looping cue with no owner is a bed nobody
// turns off. All three are checked here, mechanically, because none of them is
// visible from a call site.

import { describe, expect, it } from 'vitest'
import { CUE_IDS, CUES, type CueId } from '@/audio/cues'
import type { CueAction } from '@/audio/engine'
import {
  ENGINE_LOOPS,
  engineAudioWithCurves,
  gateWhooshActions,
  SHIPPED_ENGINE_AUDIO,
} from '@/audio/engine'
import {
  AMBIENT_LOOPS,
  AUDIO_EVENT_TYPES,
  type AudioEvent,
  type AudioEventType,
  actionsForEvent,
  ELEVATOR_STOP_SECONDS,
} from '@/audio/events'
import { createJumpChargeAudio, stepJumpChargeAudio } from '@/audio/jump-charge'
import { createLiftAudio, LIFT_LOOPS, stepLiftAudio } from '@/audio/lift'
import type { EditionLiftSound } from '@/content/edition-schema'
import { WORLD } from '@/generated/constants.generated'
import { FIXTURE_CURVES } from './helpers/speed-curves'

/**
 * DEV-424: the lift's voice run over a platform that moves one step at 10 m/s
 * and then stops — the shortest ride that produces all four of its actions.
 */
const liftRideCues = (): CueId[] => {
  const spec: EditionLiftSound = {
    enabled: true,
    rateBySpeed: [
      [0, 1],
      [10, 2],
    ],
    gainBySpeed: [
      [0, 0],
      [10, 1],
    ],
    stoppedBelow: 0.5,
    arriveGain: 1,
  }
  const state = createLiftAudio()
  const out: CueAction[] = []
  const step = 10 * WORLD.fixedDeltaTime
  for (const rise of [0, step, step]) stepLiftAudio(state, rise, spec, out)
  return out.map((a) => a.cue)
}

/** One representative of every event shape. */
const SAMPLES: Readonly<Record<AudioEventType, AudioEvent>> = {
  'ui.focus': { type: 'ui.focus' },
  'ui.confirm': { type: 'ui.confirm' },
  'ui.back': { type: 'ui.back' },
  'launch.start': { type: 'launch.start' },
  // One of the eight shaft collars, at a world point. `at` is a position, so
  // the sample carries one — an event whose payload IS the fidelity cannot be
  // represented by a bare type tag.
  'shaft.pass': { type: 'shaft.pass', at: [10, 40, -5] },
  'launch.topped': { type: 'launch.topped' },
  'countdown.beat': { type: 'countdown.beat', n: 3 },
  'countdown.go': { type: 'countdown.go' },
  'mission.begin': { type: 'mission.begin' },
  'mission.end': { type: 'mission.end' },
  'gate.passed': { type: 'gate.passed', index: 0 },
  'gate.loss': { type: 'gate.loss', loss: 'streak' },
  // A hard strike, so the sample reaches the DEV-643 sub layer too.
  'ship.struck': { type: 'ship.struck', impact: 100 },
  'ship.nearMiss': { type: 'ship.nearMiss', at: [-8, 0, 0] },
  'ship.hit': { type: 'ship.hit' },
  'boundary.warning': { type: 'boundary.warning', secondsLeft: 13 },
  'ship.respawn': { type: 'ship.respawn' },
  'run.finish': { type: 'run.finish' },
  'run.medal': { type: 'run.medal', medal: 'gold' },
  'lesson.prompt': { type: 'lesson.prompt' },
  'lesson.done': { type: 'lesson.done' },
  'tv.ident': { type: 'tv.ident' },
  'tank.fill': { type: 'tank.fill' },
  'tank.empty': { type: 'tank.empty' },
  'tank.dry': { type: 'tank.dry' },
  'race.position': { type: 'race.position', gained: true },
  'ship.flyby': { type: 'ship.flyby', at: [30, 5, -12], gain: 0.7 },
}

const actions = (event: AudioEvent): CueAction[] => actionsForEvent(event, [])
const played = (event: AudioEvent): CueId[] =>
  actions(event)
    .filter((a) => a.kind === 'play')
    .map((a) => a.cue)

describe('the map answers every event', () => {
  it('lists exactly the event types the union declares', () => {
    // `AUDIO_EVENT_TYPES` is hand-written, so it can drift from the union. The
    // sample table is keyed by `AudioEventType`, which the compiler makes
    // total, so comparing the two catches a drift in either direction.
    expect([...AUDIO_EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('resolves every event to at least one action', () => {
    for (const type of AUDIO_EVENT_TYPES) {
      const event = SAMPLES[type]
      expect(actions(event).length, type).toBeGreaterThan(0)
    }
  })

  it('only ever names a cue the catalogue actually holds', () => {
    for (const type of AUDIO_EVENT_TYPES) {
      for (const action of actions(SAMPLES[type])) {
        expect(CUE_IDS, `${type} -> ${action.cue}`).toContain(action.cue)
      }
    }
  })

  it('throws loudly on an event it has never heard of', () => {
    // The `never` at the bottom of the switch makes this a compile error for a
    // new member of the union. This is the runtime half, for an event that
    // arrives across a boundary the compiler cannot see.
    const bogus = { type: 'ui.explode' } as unknown as AudioEvent
    expect(() => actions(bogus)).toThrow(/unmapped audio event/)
  })

  it('appends to the caller array rather than replacing it', () => {
    // The caller owns the buffer (trap 19), so the map must not hand back a new
    // one and must not clear what is already there.
    const out: CueAction[] = [{ kind: 'stop', cue: 'ui.hover', fadeSeconds: 0 }]
    const returned = actionsForEvent({ type: 'ui.confirm' }, out)
    expect(returned).toBe(out)
    expect(out.length).toBe(2)
  })
})

describe('the moments 2016 gives two sounds, FF2 gives two sounds', () => {
  it('a scoring gate plays BOTH the ring and the boost', () => {
    // `TriggerCheckpoint.cs:90` plays CollectRing, and on the same ring
    // `EnergySystem_Ship.AddGate()` :274 plays PowerupBoost because
    // `playerShip.orbEffects` is non-null on the shipped prefab. Doc 06 filed
    // the second as a separate "boost powerup collected" event. It is not.
    expect(played({ type: 'gate.passed', index: 4 })).toEqual(['ring.pass', 'ring.boost'])
  })

  it('calling the lift plays the servo and starts the loop', () => {
    // AUD-1. The loop is FF2's — 2016's `elevator_moving` group is isMuted: 1
    // and plays nothing. Deleting it from the map is how that is reverted, so
    // this test is also the switch's documentation.
    // DEV-424: and the island's bed, because `mission.begin` is sent on one
    // route in five and a retry stops it.
    expect(played({ type: 'launch.start' })).toEqual([
      'elevator.start',
      'elevator.loop',
      'ambient.island',
    ])
  })

  it('DEV-424: the ambience starts off the RIDE, on every route, not only off `mission.begin`', () => {
    // `switchMission` (the first course of a session, every change of course,
    // Quick Race, Learn to Fly) sends no `mission.begin`, and `restartRun`'s
    // `mission.end` stops both beds. Between them, the two events of a ride
    // must start both — the island at the press, the water at the top, which
    // is where `ScriptedAudio_elevator.cs:21` puts it.
    const ride = [...played({ type: 'launch.start' }), ...played({ type: 'launch.topped' })]
    for (const id of AMBIENT_LOOPS) expect(ride, id).toContain(id)
    expect(played({ type: 'launch.topped' })).toEqual(['ambient.water'])
  })

  it('topping out fades the lift loop over 2016 own 1.7 s', () => {
    // `ScriptedAudio_elevator.cs:24` FadeOutAllOfSound("elevator_moving", 1.7f).
    const [action] = actions({ type: 'launch.topped' })
    expect(action).toEqual({
      kind: 'stop',
      cue: 'elevator.loop',
      fadeSeconds: ELEVATOR_STOP_SECONDS,
    })
    expect(ELEVATOR_STOP_SECONDS).toBe(1.7)
  })

  it('the countdown is three numbered beats and one GO', () => {
    // Faithful, not invented: `Timer_Race` serialises countdownTime 3 and
    // delayBetweenCountdown 1 in int_01, reached through
    // `Trigger_EnableShip.cs:66-68` which ignores `useCountdown`.
    expect(played({ type: 'countdown.beat', n: 3 })).toEqual(['countdown.beat'])
    expect(played({ type: 'countdown.go' })).toEqual(['countdown.go'])
  })

  it('crossing the line and taking the medal are two moments', () => {
    // `Trigger_FinishLine.cs:72` then `LevelEnd.cs:254`, and in FF2 the panel
    // does not appear on the same tick the gate is crossed.
    expect(played({ type: 'run.finish' })).toEqual(['run.finish'])
    expect(played({ type: 'run.medal', medal: 'platinum' })).toEqual(['medal.platinum'])
  })

  it('DEV-644: each medal tier has its own phrase, and a grade that is none of them gets the 2016 cue', () => {
    // `AwardMedal()` plays one group in 2016, whatever the string. The per-grade
    // flourish was left as a content decision; DEV-644 made it.
    const tiers = ['bronze', 'silver', 'gold', 'platinum'] as const
    for (const medal of tiers) {
      expect(played({ type: 'run.medal', medal })).toEqual([`medal.${medal}`])
    }
    expect(new Set(tiers.map((medal) => played({ type: 'run.medal', medal })[0])).size).toBe(4)
    for (const medal of ['none', 'diamond', '']) {
      expect(played({ type: 'run.medal', medal })).toEqual(['run.medal'])
    }
  })

  it('a later tier is a longer, bigger phrase than the one below it', () => {
    const tail = (medal: string): number => {
      const id = played({ type: 'run.medal', medal })[0] as CueId
      return CUES[id].layers.length
    }
    expect(tail('silver')).toBeGreaterThan(tail('bronze'))
    expect(tail('gold')).toBeGreaterThan(tail('silver'))
    expect(tail('platinum')).toBeGreaterThan(tail('gold'))
  })
})

describe('every looping cue has exactly one owner', () => {
  // A bed that nobody turns off is the only way this module can leave the game
  // making a noise forever. `engine.ts` owns five loops, the map owns the two
  // ambience beds, and the lift loop is owned by the launch pair. Nothing else
  // in the catalogue may loop.
  const owners: Readonly<Record<string, readonly CueId[]>> = {
    engine: ENGINE_LOOPS,
    ambient: AMBIENT_LOOPS,
    launch: ['elevator.loop'],
    // The one loop that is NOT a cue id to the mixer: `racer.engine` is started
    // as a per-racer handle, so `backend.stop(id)` cannot reach it and the map
    // deliberately never names it. `racer-engines.ts` is its owner and
    // `mission.end` / `stopAll` / `dispose` all go through that owner.
    racers: ['racer.engine'],
    // DEV-383: the jumping spider's charge tone. `jump-charge.ts` starts and
    // stops it off the charge, and `index.ts` stops it on `mission.end` and
    // forgets it on `stopAll` / `dispose` (`audio-jump-charge.test.ts`).
    jump: ['jump.charge'],
    // DEV-424: the lift's motor. `lift.ts` starts and stops it off the
    // platform's speed, and `index.ts` stops it on `launch.start` and
    // `mission.end` (`audio-lift.test.ts`).
    lift: LIFT_LOOPS,
  }

  it('assigns every loop to one and only one owner', () => {
    const loops = CUE_IDS.filter((id) => CUES[id].loop)
    for (const id of loops) {
      const claims = Object.entries(owners).filter(([, list]) => list.includes(id))
      expect(
        claims.map(([name]) => name),
        id,
      ).toHaveLength(1)
    }
  })

  it('claims no cue that does not loop', () => {
    for (const [name, list] of Object.entries(owners)) {
      for (const id of list) expect(CUES[id].loop, `${name}: ${id}`).toBe(true)
    }
  })

  it('mission.end stops every loop the map owns', () => {
    const stopped = actions({ type: 'mission.end' })
      .filter((a) => a.kind === 'stop')
      .map((a) => a.cue)
    for (const id of AMBIENT_LOOPS) expect(stopped).toContain(id)
    expect(stopped).toContain('elevator.loop')
  })

  it('mission.begin starts the ambience the mission.end stops', () => {
    // Symmetry, checked rather than assumed: a bed that is started by one
    // branch and torn down by another is how a loop outlives its mission.
    expect(new Set(played({ type: 'mission.begin' }))).toEqual(new Set(AMBIENT_LOOPS))
  })
})

describe('no cue in the catalogue is unreachable', () => {
  it('every cue is either mapped to an event or owned by the engine', () => {
    const reachable = new Set<CueId>(ENGINE_LOOPS)
    // `racer.engine` never reaches the event map: it is started per racer by
    // `racer-engines.ts` and addressed by handle. Named here rather than left
    // out, so it is reachable-by-declaration and a third such cue appearing
    // silently is still an orphan.
    reachable.add('racer.engine')
    // `gate.whoosh` does not reach the map either, and for a reason of the same
    // shape: it is S4's, it fires only when the Anniversary preset's curves are
    // installed, and the map is pure over the event alone — it has no spec to
    // read a preset out of. `index.ts` appends it beside the map's own actions.
    //
    // **Reachable by CALL, not by claim.** `racer.engine` above is a name in a
    // set and that is the weaker form of this assertion; this one is checked
    // against the function that actually produces it, two tests down. DEV-084.
    reachable.add('gate.whoosh')
    // DEV-383, and reachable by CALL: the charge step, run on half a charge.
    for (const a of stepJumpChargeAudio(createJumpChargeAudio(), 0.5, [])) reachable.add(a.cue)
    // DEV-424, by CALL as well: the lift's step over a move and a stop.
    for (const id of liftRideCues()) reachable.add(id)
    for (const type of AUDIO_EVENT_TYPES) {
      for (const action of actions(SAMPLES[type])) reachable.add(action.cue)
    }
    // One sample per TYPE leaves the branches inside a type unseen: the four
    // medal tiers, the grade that is none of them, and a place lost (DEV-641/644).
    for (const medal of ['bronze', 'silver', 'gold', 'platinum', 'none']) {
      for (const id of played({ type: 'run.medal', medal })) reachable.add(id)
    }
    for (const id of played({ type: 'race.position', gained: false })) reachable.add(id)
    const orphans = CUE_IDS.filter((id) => !reachable.has(id))
    // A cue nobody can hear is either a missing wire or dead weight, and both
    // want noticing at the moment they are introduced rather than in a mix
    // session six months later.
    expect(orphans).toEqual([])
  })

  it('and the one named above really is produced, not just declared', () => {
    // The guard on the guard. `reachable.add('gate.whoosh')` is a sentence I
    // wrote; this is the function running. Without it, deleting
    // `gateWhooshActions` would leave the orphan test green over a cue nothing
    // can play — which is the exact failure mode the orphan test exists for.
    const out = gateWhooshActions(200, engineAudioWithCurves(FIXTURE_CURVES), [])
    expect(out.map((a) => a.cue)).toEqual(['gate.whoosh'])
  })

  it('and it is silent on Classic, where the map is the whole of the port', () => {
    expect(gateWhooshActions(200, SHIPPED_ENGINE_AUDIO, [])).toEqual([])
  })

  it('DEV-424: the lift step really produces both lift cues — motor, then arrival', () => {
    expect(liftRideCues()).toEqual([
      'elevator.motor',
      'elevator.motor',
      'elevator.motor',
      'elevator.arrive',
    ])
  })
})
