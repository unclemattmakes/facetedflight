// src/boot/app/run-reset.ts: another go, out of `bootApp`. APP-SPLIT phase 3,
// slice 2 (`docs/plan/APP-SPLIT.md` §4b).
//
// `restartRun`, whole: the lap and the ghost it races, Share back to idle, the
// audio off, the trace re-armed, the mission started again, the run's record
// (`run`, `boot/app/run-state.ts`) reset field by field, the launch, the racers,
// the tanks, the gates, the lesson, the look and the snap. Every line below was
// moved verbatim from the closure; the plumbing is `ctx.x` where the code reads
// a binding the closure still owns (a getter, and a setter where this code
// writes one: the §6 rule 3 bag), and the returned object.

import type { AudioSystem } from '@/audio'
import { stats } from '@/boot/stats-beacon'
import type { GameMode, Level } from '@/content/level-schema'
import type { EditionState } from '@/game/edition'
import type { ChainWatch, GateLadder } from '@/game/gate-feel'
import { resetGateLadder } from '@/game/gate-feel'
import { ghostTagText } from '@/game/lap-run'
import { SHARE_IDLE } from '@/game/lap-share'
import { type MissionState, startMission } from '@/game/mission'
import type { OvertakeWatch } from '@/game/overtake'
import type { SplitTracker } from '@/game/split-times'
import type { RisingEdge } from '@/game/tank-feel'
import type { FreeLook } from '@/input/look'
import type { Fade } from '@/render/fade'
import type { GatePulse } from '@/render/gate-pulse'
import { createCrash } from '@/sim/crash'
import { boostAvailable, createEnergy, energySpec } from '@/sim/energy'
import { createEnergyRace, energyRaceSpec } from '@/sim/energy-race'
import type { LaunchState } from '@/sim/launch'
import { type LaunchSpec, resetLaunch } from '@/sim/launch'
import type { createLessonHost } from './flight/lesson'
import type { createPerf } from './perf'
import type { createResults } from './results'
import type { RunState } from './run-state'
import type { WorldHandles } from './world-handles'

/** What `createRunReset` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface RunResetCtx {
  readonly MODE_REQUEST: () => GameMode | undefined
  readonly accentPulse: GatePulse
  readonly audio: AudioSystem
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioCollar: number
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  audioFinishCrossed: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  boostBurning: boolean
  readonly boostPress: RisingEdge
  readonly captureLiveRun: (reason: string) => boolean
  readonly chainWatch: ChainWatch
  readonly editionState: EditionState
  readonly fade: Fade
  readonly freeLook: FreeLook
  readonly gateLadder: GateLadder
  readonly gatePulse: GatePulse
  readonly handles: WorldHandles
  readonly launch: LaunchState
  readonly lessonHost: ReturnType<typeof createLessonHost>
  readonly level: Level
  readonly mission: MissionState
  readonly overtakeWatch: OvertakeWatch
  readonly perfSys: ReturnType<typeof createPerf>
  readonly resetThirdPerson: () => void
  readonly results: ReturnType<typeof createResults>
  readonly rideSpec: LaunchSpec | null
  readonly run: RunState
  readonly splits: SplitTracker
}

export const createRunReset = (ctx: RunResetCtx) => {
  const {
    MODE_REQUEST,
    accentPulse,
    audio,
    boostPress,
    captureLiveRun,
    chainWatch,
    editionState,
    fade,
    freeLook,
    gateLadder,
    gatePulse,
    handles,
    mission,
    overtakeWatch,
    perfSys,
    resetThirdPerson,
    results,
    run,
    splits,
  } = ctx
  /**
   * Put everything back on the start platform for another go.
   *
   * The same reset the out-of-bounds path already does, plus the panel and the
   * launch — which is the difference between "the run restarted under you" and
   * "you chose to go again". The opposition is rebuilt too: a racer that
   * finished, or crashed into the sea at gate 6, would otherwise still be there
   * with its result on the board.
   */
  const restartRun = (opts: { respawn?: boolean; raceLap?: boolean } = {}): void => {
    stats.attemptEnd('restarted', 'none')
    // DEV-371: another go, so another lap, and the ghost it races — your kept
    // best by default (PLAYER-GHOSTS §8 call 8), or the lap just flown when the
    // results panel's "race this lap" asked for it.
    const racing = handles.lapRun?.newRun(editionState.rules.id, opts.raceLap === true) ?? null
    handles.livePlayerGhost?.setLap(racing?.doc ?? null, ghostTagText(racing))
    // DEV-373: and its own Share. A post still in flight answers to nobody.
    results.share = SHARE_IDLE
    // Everything off before anything starts again. A looping engine layer
    // outlives a run otherwise, because nothing else in the restart path
    // touches it.
    audio.event({ type: 'mission.end' })
    ctx.audioFinishCrossed = false
    run.lastResult = null
    splits.reset() // DEV-649: the last run's gate times are not this run's
    // A restart is another go, so `?trace=` records it (§5.6). Cleared HERE and
    // not in the arm branch: this is the one place that knows a run has been
    // replaced rather than merely ended.
    //
    // **KEEP IT FIRST, or a capture loses the run that is being replaced.**
    // The clears below are what re-arm the next go, and for `?trace=` throwing
    // the old one away is right — it overwrites one storage key either way.
    // During a CAPTURE it is not: "fly, crash, restart" is the normal shape of
    // a headset session and every one of those runs was being discarded here
    // without a word. `captureLiveRun` no-ops when no capture is recording, so
    // the `?trace=` path is untouched.
    captureLiveRun('run restarted')
    perfSys.traceArmed = false
    perfSys.traceSaved = false
    perfSys.traceFinishedAt = null
    Object.assign(mission, startMission(ctx.level, MODE_REQUEST()))
    run.elapsed = 0
    document.body.dataset.score = '0'
    document.body.dataset.rings = `0/${mission.countTotal}`
    delete document.body.dataset.finished
    delete document.body.dataset.medal
    delete document.body.dataset.finalScore
    run.award = null
    // A RETRY puts you on the respawn marker, which is 2016's reload behaviour
    // and the top of the shaft. A freshly SWAPPED mission must not: its ship was
    // just built at `level.spawn.pos`, which is where a boot leaves it and the
    // only place the lift ride starts from. Measured: respawning after a swap
    // put the ship 107 m up, at the top of a shaft it had not ridden.
    if (opts.respawn !== false) handles.flight?.respawn()
    resetLaunch(ctx.launch, ctx.rideSpec)
    ctx.audioCollar = -1
    handles.liveRacers?.reset()
    // A fresh run has no wreck in it (DEV-126). And a restart pressed during a
    // hold must lift the crash curtain, or the new run begins in the dark.
    run.crash = createCrash()
    if (run.crashCurtain) {
      run.crashCurtain = false
      fade.release()
    }
    // A fresh run starts on the edition's `startFill` and no lockout (DEV-143,
    // DEV-630: 2016's `Awake()` fills it, Anniversary starts it EMPTY). A
    // lockout carried across a restart would be a penalty for a run that no
    // longer exists. This also covers the level-select swap, which calls
    // `restartRun` on its way out. The edge starts from the tank, so an empty
    // start announces BOOST READY when it lights rather than BOOST OUT at once.
    run.energy = createEnergy(
      energySpec(editionState.current.gameplay.energy.rechargeScale),
      editionState.current.gameplay.energy.startFill,
    )
    run.boostWasAvailable = boostAvailable(run.energy)
    // And the race tank (DEV-144), which is the one that can END a run.
    run.energyRace = createEnergyRace(
      energyRaceSpec(
        editionState.current.gameplay.energyRace.drainScale,
        editionState.current.gameplay.energyRace.gatePayFraction,
      ),
    )
    // S6's pulse dies with the run that fired it (DEV-108). The window is
    // short enough that this matters in one case only, and it is the case that
    // would be noticed: the last gate of a run, then a press of A, then the
    // first frame of the launch room lit green at the edges by a gate in a
    // mission that has ended.
    gatePulse.reset()
    resetGateLadder(gateLadder)
    chainWatch.reset()
    boostPress.reset()
    overtakeWatch.reset()
    ctx.boostBurning = false
    accentPulse.reset()
    // Every gate back up (DEV-122). 2016 reloads the scene; the port rebuilds
    // the course state, and the pictures of the gates have to come with it.
    handles.liveRings?.reset()
    // A new run is a new lesson: step 0, the instructor at its start (DEV-377).
    ctx.lessonHost.liveLesson?.restart()
    // Straight ahead again. A run that begins with the head still turned from
    // the last one is a run that begins by not seeing the first gate.
    freeLook.reset()
    // And the arm forgets its lag, so a restart from behind the ship does not
    // swing in from wherever the last run ended (DEV-128).
    resetThirdPerson()
    // The snap RE-ARMS, because it is a property of the URL rather than of the
    // run. Restart and it freezes at the same mark again, which is the loop a
    // person taking A/B frames actually flies: shoot, change something, shoot
    // the same tick again. Left standing it would be a restart that puts a dead
    // ship on the platform with nothing on screen to say why.
    run.snapped = false
    console.info('another go')
  }
  return {
    restartRun,
  }
}
