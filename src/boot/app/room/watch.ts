// src/boot/app/room/watch.ts: watching a room, out of `bootApp`. APP-SPLIT
// phase 4, slice 3 (room; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-436's block, whole: a `?watch=<id>` page's connection to the room's
// broadcaster, boarding the race's course, and the frame's watch step. TV's
// camera (DEV-481) follows it in the closure. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns (a getter, and a setter where this code
// writes one: the §6 rule 3 bag), and the returned object.

import type { Level } from '@/content/level-schema'
import { loadLevel } from '@/content/load-level'
import type { Flight } from '@/game/flight'
import type { RemoteShips } from '@/game/remote-ships'
import type { WatchClient } from '@/game/watch-client'
import { openWatch } from '@/game/watch-open'
import type { RoomSettings } from '@/net/room-protocol'

/** What `createRoomWatch` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
import type { World } from '../world/switch'

export interface RoomWatchCtx {
  readonly beginLoadingTarget: (target: Level) => void
  readonly cardLifted: boolean
  readonly flight: Flight | null
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly level: Level
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  loadingScenePending: boolean
  /** DEV-851: a player's course, built from the room's token; null for a shipped one. */
  readonly roomRaceLevel: (settings: RoomSettings | null) => Promise<Level | null>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  roomShips: RemoteShips | null
  readonly roomWorldBuilt: (_variant: string) => void
  readonly screen: 'title' | 'menu' | 'mission'
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly switching: boolean
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  watch: WatchClient | null
  readonly world: Promise<World> | null
}

export const createRoomWatch = (ctx: RoomWatchCtx) => {
  // ── DEV-436: watching a room (plan/MULTIPLAYER.md §13.3) ───────────────
  //
  // A `?watch=<id>` page connects to the room's broadcaster (`game/watch-client.ts`),
  // boards the race's course when there is a race — no ride, no ship of its
  // own: the local craft stays on its pad, hidden, never launched — and flies
  // a director camera behind the racers. A press moves it to the next.
  // DEV-480: in-page, for TV; a watch begun on a built world gets its ships.
  let watchBoarded = false
  let watchShipsDue = false
  const watchStart = (url: string, label: string, probed = (_: number) => {}) => {
    watchStop()
    ctx.watch = openWatch(url, label, probed, (c) => ctx.watch === c)
    watchShipsDue = true
  }
  const watchStop = (): void => {
    if (!ctx.watch) return
    ctx.watch.leave()
    ctx.watch = null
    ctx.roomShips?.dispose()
    ctx.roomShips = null
    watchBoarded = watchShipsDue = false
    watchTargetName = null
  }
  /** No ride; from the title by Quick Race's one fade (`startQuickRace`). */
  const watchBoardCourse = async (id: string, settings: RoomSettings | null): Promise<void> => {
    // DEV-851: a player's course comes from the room's token, not the loader.
    const built = await ctx.roomRaceLevel(settings)
    if (ctx.screen !== 'title')
      void ctx.switchMission(id, { skipRide: true, ...(built ? { level: built } : {}) })
    else
      void (built ? Promise.resolve(built) : loadLevel(id)).then((next) =>
        ctx.goToScreen('menu', {
          act: () => {
            ctx.beginLoadingTarget(next)
            ctx.loadingScenePending = true
            void ctx.switchMission(id, { skipRide: true, inLoadingScene: next })
          },
        }),
      )
  }
  /** Presses, counted by the confirm handler; the camera block takes each (DEV-481). */
  let watchTarget = 0
  let watchTargetName: string | null = null
  let watchEyeSet = true

  /** Every frame, before the fixed step: the stream, the ships, the boarding. */
  /**
   * DEV-557: a `?watch=` link's race is waiting for the page's first press to
   * board it (`watchFrame` below), which is the press the title then spends.
   */
  const watchLinkWaiting = (): boolean => {
    if (!ctx.watch || watchBoarded) return false
    const s = ctx.watch.watch.session
    return s.roomPhase !== null && s.roomPhase !== 'lobby' && s.race !== null
  }
  const watchFrame = (): void => {
    if (!ctx.watch) return
    ctx.watch.update()
    if (watchShipsDue && ctx.flight && ctx.world && !ctx.switching) ctx.roomWorldBuilt('') // DEV-480
    ctx.roomShips?.sync()
    const s = ctx.watch.watch.session
    if (s.roomPhase === null || s.roomPhase === 'lobby') {
      watchBoarded = false
      return
    }
    // A race: board its course, once. Already on it — a `?mission=` boot — is
    // enough; otherwise once the page has had its first press (`cardLifted`,
    // DEV-557: the landing card's Start until then).
    if (watchBoarded || s.race === null || ctx.switching) return
    const onIt = ctx.screen === 'mission' && ctx.world !== null && ctx.level.id === s.race.mission
    if (!onIt && !ctx.cardLifted) return
    watchBoarded = true
    console.info(`watch: the race on ${s.race.mission}${onIt ? ' (already here)' : ''}`)
    if (!onIt) void watchBoardCourse(s.race.mission, s.settings)
  }
  return {
    watchStart,
    watchStop,
    watchLinkWaiting,
    watchFrame,
    get watchShipsDue() {
      return watchShipsDue
    },
    set watchShipsDue(v: boolean) {
      watchShipsDue = v
    },
    get watchEyeSet() {
      return watchEyeSet
    },
    set watchEyeSet(v: boolean) {
      watchEyeSet = v
    },
    get watchTarget() {
      return watchTarget
    },
    set watchTarget(v: number) {
      watchTarget = v
    },
    get watchTargetName() {
      return watchTargetName
    },
    set watchTargetName(v: string | null) {
      watchTargetName = v
    },
  }
}
