// src/game/tv/exhibition-view.ts — the exhibition's three-side parts. DEV-483.
//
// `exhibition.ts` is renderer-free so a unit test drives the same machine the
// game does; what it needs from the scene is here, so `boot/app.ts`'s block
// stays a handful of lines (and inside biome's 1 MiB `files.maxSize`, which
// that file is ~7 KB short of on `main`: past it, biome stops checking it).
//
//   · `exhibitionFieldOf` — the racers on screen as an `ExhibitionField`: their
//     sim state, their DRAWN poses (`LoadedRacers.ships`, interpolated and
//     flipped by `render`), and the step the host hands in.
//   · `exhibitionGhostOf` — a lap's ghost (`loadPlayerGhost`) as an
//     `ExhibitionGhost`, flown on the race's clock, always released.
//   · the CAMERA is not here: `ExhibitionStage.view` hands each frame's
//     exhibition to TV's camera (DEV-481, `boot/tv-watch-camera.ts`), which
//     reads `exhibition.craft()` as it reads a room's ships: one camera path
//     for live and exhibition. (DEV-483 shipped a stand-in here: the leader
//     chased flat, one still view per race in a headset.)
//   · `exhibitionReport` — what `__ff2.exhibition.probe()` returns.

import type * as THREE from 'three'
import type { PlayerGhost } from '@/game/ghosts'
import type { LoadedRacers } from '@/game/racers'
import {
  createExhibition,
  type Exhibition,
  type ExhibitionDriver,
  type ExhibitionField,
  type ExhibitionGhost,
  type ExhibitionHost,
  type ExhibitionOptions,
  type ExhibitionResult,
} from './exhibition'
import { recordingHeldBy } from './off-the-record'

/** The racers on screen, as the exhibition reads them. */
export const exhibitionFieldOf = (
  racers: LoadedRacers,
  timeLimit: number,
  step: (dt: number) => void,
): ExhibitionField => ({
  racers: racers.racers,
  line: racers.guide,
  timeLimit,
  step,
  pose: (i, p, q) => {
    const ship = racers.ships[i]
    if (!ship) return
    p.x = ship.position.x
    p.y = ship.position.y
    p.z = ship.position.z
    q.x = ship.quaternion.x
    q.y = ship.quaternion.y
    q.z = ship.quaternion.z
    q.w = ship.quaternion.w
  },
})

/** A lap's ghost in `scene`, on the race's clock. `dispose` takes it out again. */
export const exhibitionGhostOf = (g: PlayerGhost, scene: THREE.Object3D): ExhibitionGhost => {
  scene.add(g.group)
  return {
    update: (clock) => g.update(clock, true, null),
    pose: (p, q) => {
      if (!g.active) return false
      p.x = g.object.position.x
      p.y = g.object.position.y
      p.z = g.object.position.z
      q.x = g.object.quaternion.x
      q.y = g.object.quaternion.y
      q.z = g.object.quaternion.z
      q.w = g.object.quaternion.w
      return true
    },
    dispose: () => {
      scene.remove(g.group)
      g.dispose()
    },
  }
}

/** What `__ff2.exhibition.probe()` returns. */
export const exhibitionReport = (
  ex: Exhibition | null,
  results: readonly ExhibitionResult[],
  held: readonly string[],
  localCraftVisible: boolean | null,
) => ({
  phase: ex?.phase ?? 'stopped',
  course: ex?.course ?? null,
  raceSeconds: ex?.raceSeconds ?? 0,
  races: ex?.races ?? 0,
  held: [...held],
  localCraftVisible,
  craft: (ex?.craft() ?? []).map((c) => ({
    kind: c.kind,
    name: c.name,
    place: c.place,
    status: c.status,
    seconds: c.seconds,
    at: [c.position.x, c.position.y, c.position.z],
  })),
  results: results.map((r) => ({
    course: r.course,
    raceSeconds: r.raceSeconds,
    lapId: r.lapId,
    standings: r.standings.map((s) => ({ ...s })),
  })),
})

export type ExhibitionReport = ReturnType<typeof exhibitionReport>

/** What the control reads off the running game, each frame. */
export interface ExhibitionStage {
  screen(): string
  switching(): boolean
  /** The local craft's node, hidden while the exhibition is on. */
  craft(): THREE.Object3D | null
  /** Once a frame after the mission's camera, racing: TV's camera over `ex.craft()` (DEV-481). */
  view(ex: Exhibition, dt: number): void
}

/**
 * The exhibition as `boot/app.ts` holds it: `start` (§9.1's `startExhibition`),
 * the fixed step's `tick`, the frame's `frame`, and `__ff2.exhibition`.
 */
export const createExhibitionControl = (host: ExhibitionHost, stage: ExhibitionStage) => {
  let live: ExhibitionDriver | null = null
  const results: ExhibitionResult[] = []
  const start = (options: ExhibitionOptions = {}): Exhibition => {
    live?.stop()
    results.length = 0
    const ex = createExhibition(host, options)
    ex.onFinish((result) => results.push(result))
    live = ex
    return ex
  }
  const probe = (): ExhibitionReport =>
    exhibitionReport(live, results, recordingHeldBy(), stage.craft()?.visible ?? null)
  return {
    start,
    /** An exhibition is running (boarding, racing or its results): TV's camera has the screen. */
    running: (): boolean => live !== null && live.phase !== 'stopped',
    /** `stepFixed`'s hook: true while the exhibition owns the tick. */
    tick: (dt: number): boolean => live?.tick(dt) ?? false,
    /**
     * Once a frame, after the mission's camera: boarding, the ghost, TV's
     * camera. `alpha` is `stepFixed`'s, for the ghost (DEV-612).
     */
    frame(dt: number, alpha = 1): void {
      const ex = live
      if (!ex) return
      const craft = stage.craft()
      if (ex.phase === 'stopped') {
        live = null
        if (craft) craft.visible = true
        return
      }
      const onMission = stage.screen() === 'mission'
      // Left by the viewer (the pause plate's Exit) rather than by a board.
      if (ex.phase !== 'boarding' && !onMission && !stage.switching()) {
        ex.stop()
        return
      }
      ex.frame(dt, alpha)
      if (!onMission) return
      if (craft) craft.visible = false
      if (ex.phase === 'boarding') return
      stage.view(ex, dt)
    },
    debug: {
      start: (options?: ExhibitionOptions): ExhibitionReport => {
        start(options)
        return probe()
      },
      stop: (): void => live?.stop(),
      probe,
    },
  }
}
