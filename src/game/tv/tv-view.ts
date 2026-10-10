// src/game/tv/tv-view.ts, Faceted Flight TV's screen: the boarding, the hand-offs, the plate. DEV-480.
//
// docs/plan/FF-TV.md §5.1, §5.2, §2.6 and §9.1. Matt, 2026-09-30: *"i want it
// to go out with 1.0 and be easy to share links to view self, others, or
// random rooms. viewer control (spectate each racer, a director auto-cam, and
// a free-mode). if no replays exist - it should just show AI racers"*.
//
// TV is a front end on DEV-436's watch. The hangar's FF-TV table (the first
// step's third, DEV-558; the title's fourth row until then, call 1) or a
// `?tv` link boards it; `tv-client.ts` chooses what is on (a live race at
// random, never cutting away mid-race, the AI racers when nothing is live,
// never a spin); this does what the client says, the watch in-page
// (`boot/app.ts`'s `watchStart`), the exhibition (DEV-483), the camera
// (DEV-481), and owns the plate: CAMERA · NEXT RACE · SHARE THIS VIEW · LEAVE
// TV, four rows, the menus' cap.
//
// Here and not in `boot/app.ts` because that file sits at biome's 1 MiB
// `maxSize`, past which the linter SKIPS it, silently ("provided but
// ignored"): `app.ts` holds one small block that hands this its closures, and
// one-line hooks where the frame loop reads the menu button, the stick, the
// confirm, a tap and the camera.
//
// The exhibition is DEV-483's (`exhibition.ts`; `boot/app.ts`'s control is
// `startExhibition`). The camera is DEV-481's (`boot/tv-watch-camera.ts`, one
// camera for a live race and the exhibition): the plate's Camera row cycles
// it, a press with the plate down is its next racer, and a link's `follow=<n>`
// is its `follow(n)`. TV holds `off-the-record.ts`'s hold for its whole
// session, live races included: nothing a TV page does records a run.

import type * as THREE from 'three'
import { createEdge } from '@/input/edge'
import { clampAim, createRowStepper } from '@/input/menu-step'
import { answerOf } from '@/net/fetch-json'
import { createPause, type Pause, type PauseOption } from '@/render/pause'
import { placeTitleMenu } from '@/render/title-menu'
import type { WatchClient } from '../watch-client'
import type { Exhibition, ExhibitionOptions } from './exhibition'
import { holdRecording } from './off-the-record'
import type { TvCamera, TvCameraMode, TvCameraReport } from './tv-camera'
import { TvClient, type TvProbe, type TvShow, tvListUrl, tvWatchUrl } from './tv-client'
import { parseTvLink, type TvLink, tvShortLink, withoutTv } from './tv-link'
import { tvLiveOver } from './tv-live-feed'
import { nextExhibitionSlot, tvSlotAt } from './tv-schedule'

/** What the screen needs from the boot: plain closures over its own state. */
export interface TvViewDeps {
  /** The build has TV: `gameplay.tv` on the menus' preset (D35). */
  readonly on: () => boolean
  /** The page has had its first press (DEV-557) and the menus' preset is in hand: a link may board. */
  readonly ready: () => boolean
  readonly screen: () => 'title' | 'menu' | 'mission'
  /** DEV-483's `startExhibition` (§9.1): the AI racers, on the clock's course or `course`. */
  readonly startExhibition: (options: ExhibitionOptions) => Exhibition
  /** The courses the exhibition flies (its schedule's list), for NEXT RACE's next course. */
  readonly courses: () => Promise<readonly string[]>
  /** The renderer, its rig (which carries the reference space) and its camera. */
  readonly render: {
    readonly rig: THREE.Object3D
    readonly camera: THREE.Camera
    readonly renderer: { readonly xr: { readonly isPresenting: boolean } }
  }
  /** Watch the broadcaster at `url`; `probed` hears the DEV-470 diagnosis GET's status. */
  readonly watchStart: (url: string, label: string, probed: (status: number) => void) => void
  readonly watchStop: () => void
  /** The page's watch now, or null. */
  readonly watch: () => WatchClient | null
  /** DEV-481's camera for the course on screen, or null before one is built. */
  readonly camera: () => TvCamera | null
  readonly cameraReport: () => TvCameraReport | null
  /** The confirm with the plate down: the watch's press (the camera's next racer). */
  readonly press: () => void
  /** Out of any room this page is in. */
  readonly leaveRoom: () => void
  /** The local craft hidden (TV flies none) or shown again. */
  readonly hideFlight: (hidden: boolean) => void
  /** To the hangar's first step, behind a fade (Leave TV in a headset; DEV-558). */
  readonly toHangar: () => void
  /** The head's or a laser's pick of a plate (`pick` is the plate's own), and the beam shown. */
  readonly aim: (
    plate: THREE.Object3D,
    pick: (o: THREE.Vector3, d: THREE.Vector3) => number,
  ) => number
  /** The ray through a point on the glass, CSS pixels, or null. */
  readonly rayAt: (x: number, y: number) => THREE.Ray | null
  /**
   * DEV-482's panel, each frame: a live race's head count and link hint (the
   * boot builds the feed from the watch, `tv-live-feed.ts`), or null for the
   * exhibition (the panel builds its own); and the list's rooms getting ready.
   */
  readonly panel: (
    live: { readonly racers: number | null; readonly linkFollows: number | null } | null,
    lobbies: number | null,
  ) => void
}

export interface TvView {
  /** TV is on: choosing, or showing something. */
  active(): boolean
  plateUp(): boolean
  /** The FF-TV table was pressed: that door is open, and a second press is spent. */
  asked(): boolean
  /** The hangar's FF-TV table (DEV-558; the title's TV row until then). */
  boardFromHangar(): void
  /**
   * DEV-571: a shared lap's WATCH THIS LAP on the title: `/tv/lap/<id>`'s show
   * (the lap among the AI racers, TV's camera), from the `?ghost=` link the
   * page already holds. The door is spent, as the hangar's is.
   */
  boardLap(lapId: string): void
  /**
   * DEV-557: the page's TV link has not boarded yet. It boards on the page's
   * first press (`ready`), and that press is spent on it rather than on a row.
   */
  linkWaiting(): boolean
  /** Every frame, beside `watchFrame`: a link boards after the first press; the client runs. */
  frame(): void
  /** The plate shown, aimed and painted. */
  plateFrame(): void
  /** The menu button. */
  toggle(): void
  /** The confirm press: the plate's row, or the next racer. */
  confirm(): void
  /**
   * The stick, keys or D-pad (`menuNudge`'s step), and back (B, Backspace, a
   * free Escape). Back puts the plate away; with the plate down it leaves TV
   * (DEV-628: Matt, "no way to exit a broadcast").
   */
  nudge(step: number, back: boolean): void
  /** DEV-628: LEAVE TV, from the flat and phone EXIT button: back to the hangar. */
  leave(): void
  /** A tap or a cursor click on the plate: aims its row; true when it hit one. */
  tap(x: number, y: number): boolean
  probe(): TvProbe | null
}

const CAMERA_WORD: Readonly<Record<TvCameraMode, string>> = {
  director: 'Director',
  follow: 'Follow',
  free: 'Free',
}

/** The heading the plate wears; "Faceted Flight TV" is also the ident's (DEV-482). */
export const TV_PLATE_HEADING = '- FACETED FLIGHT TV -'

export const createTvView = (d: TvViewDeps): TvView => {
  /** The page's TV link (`?tv…`, or a `/tv…` path the 302 did not rewrite), read once. */
  const link = parseTvLink(globalThis.location)
  let linkTaken = false
  let asked = false
  let tv: TvClient | null = null
  let exhibition: Exhibition | null = null
  let shown: TvShow | null = null
  let probed: number | null = null
  let followHint: number | null = null
  /** The racer a link's `follow=<n>` named, for its room: the panel marks it. */
  let linkFollow: { tv: string; n: number } | null = null
  let plate: Pause | null = null
  let up = false
  let aim = 0
  /** One row per push of the stick, keys or D-pad (`input/menu-step.ts`). */
  const steps = createRowStepper()
  /** B, Backspace or a free Escape, as a press. */
  const backEdge = createEdge()
  let shared: string | null = null
  let copied = false
  /** The record hold (`off-the-record.ts`) for this TV session, or null. */
  let release: (() => void) | null = null

  const active = (): boolean => tv !== null && tv.mode !== 'off'
  const presenting = (): boolean => d.render.renderer.xr.isPresenting

  /** The exhibition for show `s`; NEXT RACE's is the schedule's course after `was`. */
  const startExhibition = async (s: TvShow & { kind: 'exhibition' }, was: string | null) => {
    let course: string | null = null
    if (s.next && was !== null) {
      const now = Date.now()
      const slot = { slot: tvSlotAt(now), course: was }
      course = nextExhibitionSlot(now, await d.courses(), slot)?.course ?? null
      if (shown !== s) return
    }
    const ex = d.startExhibition({
      ...(course !== null ? { course } : {}),
      ...(s.lapId !== null ? { lapId: s.lapId } : {}),
    })
    ex.onFinish(() => {
      if (exhibition === ex) tv?.exhibitionFinished()
    })
    exhibition = ex
  }

  /** The client's word: a room's race, or the exhibition. */
  const show = (s: TvShow): void => {
    shown = s
    document.body.dataset.tv = s.kind
    if (s.kind === 'live') {
      exhibition?.stop()
      exhibition = null
      probed = null
      d.watchStart(tvWatchUrl(s.tv, globalThis.location), s.tv, (status) => {
        probed = status
      })
      return
    }
    d.watchStop()
    if (exhibition === null || s.next || s.lapId !== null) {
      const was = exhibition?.course ?? null
      exhibition?.stop()
      exhibition = null
      void startExhibition(s, was)
    }
  }

  const board = (to: TvLink, refused: string | null, from: string): void => {
    if (active()) return
    // Watching is not racing: out of any room, and off a `?watch=` link's broadcaster.
    d.leaveRoom()
    d.watchStop()
    followHint = to.kind === 'race' ? to.follow : null
    linkFollow = to.kind === 'race' && to.follow !== null ? { tv: to.tv, n: to.follow } : null
    shared = null
    release ??= holdRecording('tv')
    tv = new TvClient({
      now: () => performance.now(),
      random: Math.random,
      list: () => fetch(tvListUrl(globalThis.location), { cache: 'no-store' }).then(answerOf),
      watchState: () => {
        const w = d.watch()
        if (!w) return null
        // A `results` message moves no session's phase: over is the room's own
        // rule, a verdict for every racer (`RoomServer.phase`).
        const s = w.watch.session
        const over = s.roomPhase === 'racing' && tvLiveOver(s)
        const phase = over ? 'results' : s.roomPhase
        return { status: w.status, closeCode: w.closeCode, probed, phase }
      },
      onShow: show,
      onChange: (c) => {
        document.body.dataset.tvMode = c.mode
        console.info(`tv: ${c.mode}${c.tv ? ` ${c.tv}` : ''}${c.note ? `, ${c.note}` : ''}`)
      },
    })
    console.info(`tv: boarding from ${from}`)
    tv.start(to, refused)
  }

  /** The view on screen as a link: the race (and the racer, in Follow), the lap, or `/tv`. */
  const viewLink = (): TvLink => {
    if (tv?.mode === 'live' && tv.tv !== null) {
      const r = d.cameraReport()
      const racer = r?.mode === 'follow' ? r.racer : null
      return { kind: 'race', tv: tv.tv, follow: racer }
    }
    if (shown?.kind === 'exhibition' && shown.lapId !== null)
      return { kind: 'lap', lap: shown.lapId }
    return { kind: 'random' }
  }

  /** The plate's four rows (§5.1). Picking a racer is the standings', not a row. */
  const rows = (): PauseOption[] => {
    const xr = presenting()
    return [
      {
        id: 'tv-camera',
        label: 'Camera',
        value: CAMERA_WORD[d.camera()?.mode() ?? 'director'],
        note: 'the director, follow a racer, or fly free',
      },
      {
        id: 'tv-next',
        label: 'Next Race',
        note: tv?.waiting
          ? 'a live race is on: watch it'
          : tv?.mode === 'live'
            ? 'the next race on now, if there is one'
            : 'another course for the AI racers',
      },
      {
        id: 'tv-share',
        label: 'Share This View',
        ...(shared !== null && copied && !xr ? { value: 'copied' } : {}),
        // A headset pastes nothing: the link itself, to read off the plate.
        note:
          xr || shared !== null
            ? tvShortLink(globalThis.location.host, viewLink())
            : 'copy a link to what you are watching',
      },
      {
        id: 'tv-leave',
        label: 'Leave TV',
        note: 'back to the hangar',
      },
    ]
  }

  /**
   * LEAVE TV: everything TV started stops, and the page goes back to the
   * hangar's first step, where FF-TV's table stands (DEV-558), on every
   * device. DEV-628: flat used to reload the page onto the title, which is
   * one screen further from where the viewer came in.
   */
  const leave = (): void => {
    tv?.stop()
    tv = null
    d.watchStop()
    exhibition?.stop()
    exhibition = null
    shown = null
    up = false
    asked = false
    release?.()
    release = null
    linkFollow = null
    d.panel(null, null)
    document.body.dataset.tv = 'left'
    // The link that boarded TV is spent: a reload from the hangar is the
    // hangar's page, not another broadcast.
    const search = withoutTv(globalThis.location.search)
    if (link !== null || globalThis.location.search !== search) {
      globalThis.history.replaceState(globalThis.history.state, '', `/${search}`)
    }
    // In a headset a page load would end the session; flat it would land on
    // the title. The hangar's FIRST step (DEV-558: FF-TV's table, beside
    // Single Player) is in-page for both.
    console.info('tv: left for the hangar')
    d.hideFlight(false)
    d.toHangar()
  }

  const press = (id: string | undefined): void => {
    switch (id) {
      case 'tv-camera':
        d.camera()?.cycleMode()
        return
      case 'tv-next':
        up = false
        tv?.next()
        return
      case 'tv-share': {
        const made = tvShortLink(globalThis.location.host, viewLink())
        shared = made
        copied = false
        console.info(`tv: share ${made}`)
        // Flat, the press is the gesture the clipboard needs (§2.6).
        if (!presenting()) {
          void navigator.clipboard?.writeText(`${globalThis.location.protocol}//${made}`).then(
            () => {
              if (shared === made) copied = true
            },
            (err: unknown) => console.warn(`tv: could not copy the link (${made})`, err),
          )
        }
        return
      }
      case 'tv-leave':
        leave()
        return
    }
  }

  return {
    active,
    plateUp: () => up && active(),
    asked: () => asked,
    linkWaiting: () => link !== null && !linkTaken,
    boardFromHangar() {
      asked = true
      board({ kind: 'random' }, null, 'the hangar')
    },
    boardLap(lapId) {
      if (!d.on()) return
      asked = true
      board({ kind: 'lap', lap: lapId }, null, 'a shared lap')
    },
    frame() {
      if (link !== null && !linkTaken && d.ready()) {
        linkTaken = true
        if (d.on()) board(link.link, link.refused, 'a link')
        else console.warn('tv: this build has no TV; ignoring the link')
      }
      // A link's `follow=<n>`, once its course has a camera (DEV-481 also reads it at boot).
      const cam = followHint === null ? null : d.camera()
      if (cam && followHint !== null) {
        cam.follow(followHint)
        followHint = null
      }
      tv?.update()
      if (tv && active()) {
        const on = tv.mode === 'live' && tv.tv !== null ? tv.tv : null
        const entry = on === null ? null : tv.listing?.races.find((r) => r.tv === on)
        d.panel(
          on === null
            ? null
            : {
                racers: entry?.racers ?? null,
                linkFollows: linkFollow?.tv === on ? linkFollow.n : null,
              },
          tv.listing?.lobbies ?? null,
        )
      }
    },
    plateFrame() {
      if (!(active() && up && d.screen() === 'mission')) {
        plate?.setVisible(false)
        return
      }
      if (plate === null) {
        plate = createPause()
        placeTitleMenu(plate.object)
        plate.object.name = 'tv-plate'
        d.render.rig.add(plate.object)
      }
      const p = plate
      p.setVisible(true)
      const list = rows()
      const looked = d.aim(p.object, (o, dir) => p.pick(o, dir, list.length))
      if (looked >= 0) aim = looked
      p.update({ options: list, selected: aim, title: TV_PLATE_HEADING })
    },
    toggle() {
      up = !up
      if (up) aim = 0
    },
    confirm() {
      if (up) press(rows()[aim]?.id)
      else d.press()
    },
    nudge(step, back) {
      // Both latches move on every call, plate up or not, as they always did.
      const taken = steps.take(step)
      if (up && taken !== 0) aim = clampAim(aim, taken, rows().length)
      if (backEdge.step(back)) {
        if (up) up = false
        else if (active()) leave()
      }
    },
    leave() {
      if (active()) leave()
    },
    tap(x, y) {
      const ray = plate === null || !up ? null : d.rayAt(x, y)
      const hit =
        ray === null || plate === null ? -1 : plate.pick(ray.origin, ray.direction, rows().length)
      if (hit >= 0) aim = hit
      return hit >= 0
    },
    probe() {
      if (!tv) return null
      const on = d.cameraReport()
      return {
        mode: tv.mode,
        tv: tv.tv,
        mission: tv.mission,
        note: tv.note,
        reads: tv.reads,
        waiting: tv.waiting?.tv ?? null,
        lapId: shown?.kind === 'exhibition' ? shown.lapId : null,
        camera: on?.mode ?? null,
        following: on?.following ?? null,
        followingRacer: on?.racer ?? null,
        plate: {
          up,
          selected: aim,
          rows: rows().map((r) => ({
            id: r.id,
            label: r.label,
            value: r.value ?? null,
            note: r.note ?? '',
          })),
        },
        shared,
      }
    },
  }
}
