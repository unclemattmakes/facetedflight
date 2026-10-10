// src/boot/tv-watch-camera.ts: TV's camera, wired to the game. DEV-481.
//
// `game/tv/tv-camera.ts` is pure: a list of craft in, a rig pose out. This is
// the half that knows the game: the boot's handles, handed in as functions so
// nothing here reaches into `boot/app.ts`'s closure:
//
//   * the CRAFT: today a room's remote ships (`?watch=`, and TV's live races),
//     or any list a caller hands `craft` (DEV-483's exhibition `craft()`);
//   * the GROUND: the higher of the rendered surface (`editor/desk/ground.ts`'s
//     `deskGround`, the jittered vertex grid, land and the sea's high water)
//     and the collision surface (`surfaceHeightAt`); CLAUDE.md's
//     heightField trap: they differ by up to 21.8 m on steep desert;
//   * the PROPS: the live colliders (`propPenetrationAt`, a sphere, SIM space);
//   * the DEVICES: `tv-camera-input.ts`, and the app's confirm as `press()`;
//   * the HEADSET's aim: the laser's own ray and beam (`render/xr-pointer.ts`).
//
// `boot/app.ts`'s camera block calls `frame(dt)` once a frame after the
// mission's own camera code (which writes the rig first; see `tv-camera.ts`),
// `press()` on the confirm, and lays `black()` over the frame.
//
// The camera is rebuilt when the course or the world under it changes: a
// vantage list belongs to one course over one terrain.

import * as THREE from 'three'
import type { Level } from '@/content/level-schema'
import type { RemoteShips } from '@/game/remote-ships'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import { deskGround } from '@/game/terrain/render-ground'
import type { ExhibitionCraft } from '@/game/tv/exhibition'
import {
  createTvCamera,
  type TvCamera,
  type TvCameraMode,
  type TvCameraReport,
  type TvCraft,
  type TvMapView,
} from '@/game/tv/tv-camera'
import { teleportTarget } from '@/game/tv/tv-teleport'
import { tvBoundsOf, tvCourseOf } from '@/game/tv/tv-vantage'
import type { PointerHand } from '@/input/pointer-hand'
import { createTvMarker } from '@/render/tv-marker'
import { tvCraftName, tvOrdinal } from '@/render/tv-panel-layout'
import { type PropColliders, propPenetrationAt } from '@/sim/props/collision'
import { attachTvCameraInput, type TvCameraInputSource } from './tv-camera-input'

export interface TvWatchHandles {
  readonly canvas: HTMLElement
  readonly rig: THREE.Object3D
  readonly camera: THREE.Object3D
  readonly presenting: () => boolean
  readonly session: () => XRSession | null
  /** The course on screen. */
  readonly level: () => Level
  /** The world it is built over, or null while none is. Its identity changing rebuilds the camera. */
  readonly terrain: () => {
    readonly terrain: LoadedTerrain
    readonly ocean: LoadedTerrain | null
  } | null
  /** The collision surface, THREE world (`surfaceHeightAt`); −∞ off it. */
  readonly collisionHeightAt: (x: number, z: number) => number
  readonly props: () => PropColliders | null
  /** The craft: a room's ships, unless a caller sets `craftSource`. */
  readonly ships: () => RemoteShips | null
  /** The pointing hand's world ray, or null with no hand (`xrPointer.ray` through the arbiter). */
  readonly aim: (origin: THREE.Vector3, direction: THREE.Vector3) => PointerHand | null
  /** Draw `hand`'s beam `distance` metres out (or dimmed at null). */
  readonly beam: (hand: PointerHand, distance: number | null) => void
  /** A `?follow=<n>` the link carried, or null. */
  readonly followAtBoot: number | null
  /**
   * The headset comfort cuts (`gameplay.tv.headsetCuts`): trackside vantages,
   * teleport and snap turn. Off at launch, when a headset gets the flat camera
   * (Matt, 2026-10-01).
   */
  readonly headsetCuts: () => boolean
  /** The head's WORLD pose through `render/head-pose.ts` (the one door), into `q`. */
  readonly gaze: (q: THREE.Quaternion) => void
  /** Lay the headset cut's black over this frame (0..1; the vignette's fade, at least what it already has). */
  readonly curtain: (black: number) => void
  /**
   * DEV-628: may a plain click or tap on the canvas follow the next racer now?
   * False while a plate is up (the tap is the plate's). Absent: always.
   */
  readonly tapsFollow?: () => boolean
  /**
   * DEV-653: the scene the marker over the followed racer stands in, and an AI
   * racer's hull colour by the name the board calls it (CSS, or null). Absent:
   * no marker.
   */
  readonly scene?: THREE.Object3D
  readonly colourOf?: (name: string) => string | null
}

/** DEV-654: one line for TV's lower third, and which kind it is. */
export interface TvAnnouncement {
  readonly line: string
  readonly kind: 'overtake' | 'winner'
}

export interface TvWatchCamera {
  /** The camera for the course on screen, or null before one is built. */
  readonly camera: TvCamera | null
  /** A different craft list; null goes back to the room's ships. */
  craftSource(source: (() => readonly TvCraft[]) | null): void
  /**
   * DEV-483's exhibition, this frame: its `craft()` is the list, then `frame(dt)`.
   * The exhibition's stand-in camera is gone: one camera for live and exhibition.
   */
  exhibition(ex: { craft(): readonly ExhibitionCraft[] }, dt: number): void
  /** The app's confirm: the next racer, or (in a headset's Free) a teleport. */
  press(): void
  /**
   * DEV-628: the lower third's pick of Racer `n` (DEV-482). The click that
   * picked it is also a canvas tap; this spends that tap, so one press is
   * one racer.
   */
  pick(n: number): void
  /** After the mission's own camera code: read the devices, place the rig. */
  frame(dt: number): void
  /**
   * DEV-654: a line for the lower third, once: `CUTTER takes P1` on an overtake
   * among the racers still racing (the camera's own `game/tv/tv-standings.ts`
   * signal), `CUTTER wins` as the winner's shot begins. Null when nothing is new.
   */
  takeAnnouncement(): TvAnnouncement | null
  /** DEV-866: the course and the field for the broadcast's mini-map; null before a camera is built. */
  mapView(): TvMapView | null
  /** 0..1 black, the headset cut's curtain: lay it over the frame. */
  black(): number
  report(): TvCameraReport | null
  dispose(): void
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }

/** DEV-653: the marker over the followed racer hides when the eye is within this many metres of it. */
const MARKER_HIDDEN_WITHIN = 16

export const createTvWatchCamera = (h: TvWatchHandles): TvWatchCamera => {
  const input: TvCameraInputSource = attachTvCameraInput(h.canvas)
  // DEV-653: the marker over the racer the camera is on, in the world.
  const marker = h.scene ? createTvMarker() : null
  if (marker && h.scene) h.scene.add(marker.object)
  /** The craft the camera saw last frame, for the marker to find its racer in. */
  let lastCraft: readonly TvCraft[] = []
  // DEV-654: what the camera has already said, so each overtake and each winner is one line.
  let overtakeSeen = 0
  let winnerSaid = false
  let finishSeen = 0
  let pending: TvAnnouncement | null = null
  /** The followed craft's gate count last frame, and whose it was: a rise on the same craft is a pass. */
  let gatesLast = 0
  let gatesFor: string | null = null
  let cam: TvCamera | null = null
  let builtFor: { level: string; terrain: unknown } | null = null
  let source: (() => readonly TvCraft[]) | null = null
  let pressed = false
  /** DEV-628: the lower third picked a racer since the last read: that press's tap is spent. */
  let picked = false
  let mode: TvCameraMode = 'director'
  let follow = h.followAtBoot
  /** The camera's ground, kept for the beam's preview so the two agree on where a teleport lands. */
  let groundNow: (x: number, z: number) => number = h.collisionHeightAt

  // The room's ships as a craft list: the same objects every frame.
  const slots: {
    id: string
    name: string
    racer: number | null
    position: THREE.Vector3
    quaternion: THREE.Quaternion
  }[] = []
  const list: TvCraft[] = []
  const shipCraft = (): readonly TvCraft[] => {
    list.length = 0
    const ships = h.ships()
    if (!ships) return list
    // `report()` and `follow(i)` walk the ships in one order, `follow` counting only
    // the visible ones: so the i-th visible report row is `follow(i)`.
    let i = 0
    for (const r of ships.report()) {
      if (!r.visible) continue
      let s = slots[i]
      if (!s) {
        s = {
          id: '',
          name: '',
          racer: null,
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
        }
        slots[i] = s
      }
      if (ships.follow(i, s.position, s.quaternion) === null) break
      s.id = r.bot === null ? `slot:${r.slot}` : `bot:${r.bot}`
      s.name = r.handle
      s.racer = r.bot === null ? r.slot + 1 : null
      list.push(s)
      i++
    }
    return list
  }

  const rebuild = (): void => {
    const level = h.level()
    const world = h.terrain()
    // No camera before the world: a vantage list built over no ground would stand anywhere.
    if (!world) return
    if (builtFor && builtFor.level === level.id && builtFor.terrain === world) return
    if (cam) {
      // A new course or world keeps the viewer's mode, and the racer they were following.
      mode = cam.mode()
      const r = cam.report()
      if (mode === 'follow' && follow === null && r.racer !== null) follow = r.racer
    }
    const render = deskGround({ land: world.terrain, ocean: world.ocean })
    const heightAt = (x: number, z: number): number =>
      Math.max(h.collisionHeightAt(x, z), render.surfaceAt(x, z))
    groundNow = heightAt
    cam = createTvCamera({
      craft: () => {
        lastCraft = source ? source() : shipCraft()
        return lastCraft
      },
      presenting: h.presenting,
      heightAt,
      bounds: tvBoundsOf(level),
      course: tvCourseOf(level),
      headsetCuts: h.headsetCuts,
      // DEV-652: the subject-size floor reads the flat camera's own field.
      fovDeg: () => (h.camera as THREE.PerspectiveCamera).fov ?? 60,
      obstructed: (x, y, z, r) => {
        const props = h.props()
        return props
          ? propPenetrationAt({ x, y, z: -z }, IDENTITY, [{ x: 0, y: 0, z: 0, radius: r }], props) >
              0
          : false
      },
      mode,
    })
    if (follow !== null) {
      cam.follow(follow)
      follow = null
    }
    builtFor = { level: level.id, terrain: world }
    const r = cam.report()
    console.info(
      `tv camera: ${level.id}, ${r.vantages} trackside vantages (${r.liftedVantages} above everything), ${r.mode} (DEV-481)`,
    )
  }

  const _q = new THREE.Quaternion()
  const _o = new THREE.Vector3()
  const _d = new THREE.Vector3()

  return {
    get camera() {
      return cam
    },
    craftSource(next) {
      source = next
    },
    press() {
      pressed = true
    },
    pick(n) {
      picked = true
      cam?.follow(n)
    },
    frame(dt) {
      rebuild()
      if (!cam) return
      const presenting = h.presenting()
      const inFree = cam.mode() === 'free'
      const cuts = h.headsetCuts()
      const raw = input.read(presenting, h.session(), inFree, !cuts)
      if (raw.cycle) cam.cycleMode()
      if (raw.next) cam.next()
      if (raw.previous) cam.previous()
      // DEV-628 (QUESTIONS item 10): a plain click or tap follows the next
      // racer, flat and on a phone. Not one the lower third already spent on
      // a name, nor one meant for a plate.
      if (raw.tap && !picked && !presenting && (h.tapsFollow?.() ?? true)) cam.next()
      picked = false
      let teleport = false
      let aim: { origin: [number, number, number]; direction: [number, number, number] } | null =
        null
      let gaze: [number, number, number, number] | null = null
      if (presenting && !cuts) {
        h.gaze(_q)
        gaze = [_q.x, _q.y, _q.z, _q.w]
      }
      if (presenting && cuts && cam.mode() === 'free') {
        const hand = h.aim(_o, _d)
        if (hand !== null) {
          aim = { origin: [_o.x, _o.y, _o.z], direction: [_d.x, _d.y, _d.z] }
          // The beam ends where the teleport would land, so the wearer sees the spot before they pull.
          const target = teleportTarget(aim.origin, aim.direction, {
            heightAt: groundNow,
            bounds: tvBoundsOf(h.level()),
          })
          h.beam(hand, target ? target.distance : null)
        }
        teleport = pressed
      } else if (pressed) {
        cam.next()
      }
      pressed = false
      // A free mouse under pointer lock looks only in Free; a deliberate drag is a Free control anywhere.
      const looks = cam.mode() === 'free' || raw.deliberateLook
      cam.frame(dt, h.rig, h.camera, {
        ...raw,
        lookDx: looks ? (raw.lookDx ?? 0) : 0,
        lookDy: looks ? (raw.lookDy ?? 0) : 0,
        aim,
        teleport,
        gaze,
      })
      const black = cam.black()
      if (black > 0) h.curtain(black)
      // For specs, beside the pose it describes (as `render/xr-pointer.ts` publishes its beam).
      const report = cam.report()
      h.rig.userData.tvCamera = report
      // DEV-654: the lower third's lines, and the followed racer's gate-pass flash.
      if (report.lastOvertake && report.lastOvertake.n !== overtakeSeen) {
        overtakeSeen = report.lastOvertake.n
        const who = lastCraft.find((c) => c.id === report.lastOvertake?.id)
        if (who) {
          pending = {
            line: `${tvCraftName(who).toUpperCase()} takes #${report.lastOvertake.to}`,
            kind: 'overtake',
          }
        }
      }
      // DEV-871: a racer that crosses is called at the place it crossed in. The winner has its
      // own line below; a later finisher is `CUTTER finishes 2ND`, never a `takes #1` again.
      if (report.lastFinish && report.lastFinish.n !== finishSeen) {
        finishSeen = report.lastFinish.n
        if (report.lastFinish.place > 1) {
          const who = lastCraft.find((c) => c.id === report.lastFinish?.id)
          if (who) {
            pending = {
              line: `${tvCraftName(who).toUpperCase()} finishes ${tvOrdinal(report.lastFinish.place)}`,
              kind: 'overtake',
            }
          }
        }
      }
      if (report.winnerShot && !winnerSaid && report.following !== null) {
        winnerSaid = true
        const who = lastCraft.find((c) => c.name === report.following)
        if (who) pending = { line: `${tvCraftName(who).toUpperCase()} wins`, kind: 'winner' }
      }
      if (!report.winnerShot && report.shot !== 'finish') winnerSaid = false
      if (marker && report.following === gatesFor && report.followedGates > gatesLast)
        marker.flash()
      gatesFor = report.following
      gatesLast = report.followedGates
      // DEV-653 (a): the marker stands over the followed racer in Director and
      // Follow, not in Free (which follows nobody), saying what the board would.
      if (marker) {
        const target =
          report.mode !== 'free' && report.following !== null
            ? lastCraft.find((c) => c.name === report.following)
            : undefined
        // Not when the eye is on top of its racer (the shoulder, a close chase): the
        // hull says who it is, and a plate over it would only crowd the picture.
        const near =
          target !== undefined &&
          h.rig.position.distanceTo(
            _o.set(target.position.x, target.position.y, target.position.z),
          ) < MARKER_HIDDEN_WITHIN
        marker.update(
          target && !near
            ? {
                position: target.position,
                // DEV-654: the winner's shot names the winner, in the accent's gold.
                label: report.winnerShot ? `WINNER  ${tvCraftName(target)}` : tvCraftName(target),
                colour: target.colour ?? h.colourOf?.(target.name) ?? null,
                winner: report.winnerShot,
              }
            : null,
        )
      }
    },
    exhibition(ex, dt) {
      const before = source
      // An AI racer has a name and a place, no slot: its id is its name, and
      // `follow(n)` (no `racer` number) is the n-th on the list.
      source = () =>
        ex.craft().map((c) => ({
          id: `${c.kind}:${c.name}`,
          name: c.name,
          position: c.position,
          quaternion: c.quaternion,
          place: c.place,
        }))
      this.frame(dt)
      source = before
    },
    takeAnnouncement() {
      const line = pending
      pending = null
      return line
    },
    mapView() {
      const v = cam?.mapView()
      if (!v) return null
      // A craft with no colour of its own wears the one the board gives its name.
      return {
        ...v,
        dots: v.dots.map((d) => ({ ...d, colour: d.colour ?? h.colourOf?.(d.name) ?? null })),
      }
    },
    black: () => cam?.black() ?? 0,
    report: () => cam?.report() ?? null,
    dispose() {
      marker?.dispose()
      input.dispose()
    },
  }
}
