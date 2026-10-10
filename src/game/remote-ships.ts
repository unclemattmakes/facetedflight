// src/game/remote-ships.ts — the other players in a room, drawn. DEV-388.
//
// plan/MULTIPLAYER.md §6.4. A remote player is drawn, never simulated: their
// pose comes off `RoomSession`'s track for their slot, sampled on the shared
// clock `delay` behind, and lands on a hull built EXACTLY as a single-player
// racer's is (Matt, 2026-09-25: *"they should look like the other racers in our
// single player game - (different colors to signify different players - let
// players choose their color)"*):
//
//   - `dressRacerHull` — the player's own exterior, `applyLambert1`, the livery
//     painted in THAT PLAYER's colour, the anti-grav wing — with the solid look
//     on (`racerLook(…, true)`), whatever the preset's racer flag says;
//   - the racers' engine trail and wing-tip trails, tinted by the racers' rule;
//   - a name tag above the hull, on the UI layer by the only door there is
//     (`toneMapped: false`, `render/bloom.ts`'s `classify()`; never `layers.set`,
//     never 1 or 2 — those are the WebXR eyes, DEV-141).
//
// NOTHING here touches the sim: these ships are never handed to the racer field
// or to contact (§6.7 — in a room every craft is intangible, and this is the one
// place a solid hull can be flown through; `DEVIATIONS.md` DEV-388 says why).
//
// The colours are the room's palette: the player's own orange first, then the
// edition's racer palette (§6.4: six in all, one a seat). A colour index is
// what travels on the wire; the room keeps two players off one.
//
// Per frame this allocates nothing: every ship owns its `DrawnPose` and its
// audio input, and the list handed to the engines is one reused array.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import { callsignDisplay } from '@/content/callsigns'
import type { EditionRacerLivery } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'
import { ART_POSITION, ART_SCALE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { createEngineTrail, dressRacerHull, racerMaterial, trailEmitterOffset } from '@/game/racers'
import { drawnHandle } from '@/game/room-names'
import { type CraftWingTrails, createCraftWingTrails } from '@/game/wing-trails'
import { type DrawnPose, drawnPose } from '@/net/remote-track'
import type { RoomSession } from '@/net/room-session'
import type { HoverGlow } from '@/render/hover-glow'
import { type LoadedMesh, loadMesh } from '@/render/load-mesh'
import { LIVERY_PANEL_SRGB, paletteColour, type RacerLook, type Srgb } from '@/render/racer-livery'
import { UI_INK, UI_PLATE, uiFont } from '@/render/ui-tokens'
import { measureWingTips } from '@/render/wing-trails'
import type { RemoteShipReport } from './room-client'
import type { RoomDrawnRacer } from './room-results'

/** The room's colours (§6.4): the player's own orange, then the edition's racer palette. */
export const roomPalette = (livery: Pick<EditionRacerLivery, 'palette'>): Srgb[] => [
  LIVERY_PANEL_SRGB,
  ...livery.palette,
]

/** A palette colour as CSS `rgb()`: the name tag's stripe and the race map's dot (DEV-390). */
export const srgbCss = (colour: Srgb): string =>
  `rgb(${colour.map((c) => Math.round(c * 255)).join(',')})`

/** Room palette index `index` as CSS, for this edition's livery. */
export const roomColourCss = (livery: Pick<EditionRacerLivery, 'palette'>, index: number): string =>
  srgbCss(paletteColour(roomPalette(livery), index))

/**
 * DEV-389: how long after a ship's GO it may still stand on its start while no
 * pose is drawable: the render delay is at most `TRACK_DELAY_MAX_MS` (683 ms),
 * so a stream that has begun is drawn well inside this. One that has not is a
 * player who is not coming, and they go.
 */
export const START_HOLD_AFTER_GO_MS = 2000

/** The engine-audio id of a remote player: never a racer's (`racer-engines.ts` keys by id). */
export const remoteShipId = (slot: number): string => `room:${slot}`
/** DEV-391: the engine-audio id of a room's bot, drawn from its host's stream. */
export const remoteBotId = (index: number): string => `room:bot:${index}`

/**
 * DEV-391: a bot's key among the ships, clear of every slot (a room seats at
 * most `ROOM_MAX_SEATS`), and the slot its drawn place reports: negative, so
 * nothing that looks a HUMAN up by slot (the live place, the map) finds a bot.
 */
export const BOT_KEY_BASE = 1000
export const botPlaceSlot = (index: number): number => -1 - index

/** Metres above the hull's origin that its name tag floats. */
export const NAME_TAG_LIFT_M = 4
/**
 * The tag's height as an ANGLE, radians: `sizeAttenuation: false` draws a
 * sprite at `scale` units per metre of depth, so it holds one apparent size at
 * any range — about 1.4°, the HUD's small type, legible past a kilometre.
 */
export const NAME_TAG_ANGLE = 0.025

/** One engine input, reused every frame. */
interface AudioSlot {
  id: string
  position: [number, number, number]
  speed: number
  finished: boolean
}

interface Ship {
  readonly slot: number
  /** DEV-391: a bot's index in `race.bots` (its records are kind 1, from the host), or null for a player. */
  readonly bot: number | null
  readonly handle: string
  readonly colour: number
  readonly root: THREE.Group
  readonly pose: DrawnPose
  readonly audio: AudioSlot
  /** Sim-shaped, for the wing trails' fade: only its speed is read. */
  readonly body: {
    orientation: { x: number; y: number; z: number; w: number }
    velocity: { x: number; y: number; z: number }
  }
  built: {
    readonly gltf: LoadedMesh
    readonly look: RacerLook
    readonly glow: HoverGlow | null
    readonly engine: ReturnType<typeof createEngineTrail>
    readonly wings: CraftWingTrails
    readonly tag: THREE.Sprite
  } | null
  /** False once the slot has left the room: disposed when its load lands. */
  live: boolean
  /** The shared tick the last `update` drew it at. */
  drawnTick: number | null
  /** What the live place and the race map read (DEV-390), written by `update`. */
  readonly place: RoomDrawnRacer
}

export interface RemoteShips {
  readonly group: THREE.Group
  /** Build hulls for the players the session knows, drop the departed. Cheap when nothing changed. */
  sync(): void
  /** Every hull the roster names has loaded (the room's `loaded` waits for this). */
  readonly ready: boolean
  /** Place every ship at room time `roomNow`. */
  update(roomNow: number): void
  /** The two trails and the tags, after `update`, facing `eye`. `wingDt` 0 holds the vapour. */
  renderTrails(eye: THREE.Vector3, dt: number, wingDt: number): void
  /** For `audio.racerEngines.sync`: one engine a ship, the same array every frame. */
  audio(): readonly AudioSlot[]
  /** DEV-390: every ship as drawn, SIM space, for the live place and the race map. The same array every frame. */
  drawn(): readonly RoomDrawnRacer[]
  report(): RemoteShipReport[]
  /**
   * DEV-436: a viewer's director camera follows the `index`-th ship on screen
   * (wrapping): its root pose into `pos` and `quat`, and its name — or null
   * while none is drawn.
   */
  follow(index: number, pos: THREE.Vector3, quat: THREE.Quaternion): string | null
  /** The per-frame cost of `update` + `renderTrails`, ms, over the frames since `resetStats`. */
  stats(): { frames: number; meanMs: number; maxMs: number; ships: number }
  resetStats(): void
  dispose(): void
}

export interface RemoteShipsOptions {
  readonly worldOffset: readonly [number, number, number]
  readonly edition: EditionState
  readonly session: RoomSession
  /** A timing clock for `stats`: `performance.now` in the app. */
  readonly now: () => number
  /** A hull's solid materials and trail materials, once built: for the fog and shadow doors. */
  readonly dressed?: (solid: readonly THREE.Material[], trails: readonly THREE.Material[]) => void
  /**
   * DEV-389: a slot's start, THREE world space, or null — where its ship
   * stands before its GO. A pose's tick counts from GO, so until then there is
   * nothing to draw it from; every client reads the start off the same list by
   * the same index (DEV-477: `game/racer-grid.ts`'s `roomStarts`, at
   * `RoomRace.starts[slot]`), so the others stand where they really are.
   */
  readonly startOf?: (
    slot: number,
  ) => { readonly pos: readonly number[]; readonly quat: readonly number[] } | null
  /**
   * DEV-391: a bot's start (the room's start list, `race.bots[i].start`, DEV-477),
   * THREE world, where it stands before its host's GO; and its name, the tuning it
   * flies (`game/racers.ts`'s `assignTunings` over those starts, so every client
   * names it as the host does). Absent: no bots are drawn.
   */
  readonly botStartOf?: (
    index: number,
  ) => { readonly pos: readonly number[]; readonly quat: readonly number[] } | null
  readonly botName?: (index: number) => string
}

/** A name tag: the handle on a dark plate, a canvas texture, drawn as a screen-facing sprite. */
export const nameTag = (handle: string, colour: Srgb): THREE.Sprite => {
  const canvas = document.createElement('canvas')
  const h = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('remote-ships: no 2d context')
  const font = uiFont(Math.round(h * 0.62))
  ctx.font = font
  const w = Math.ceil(ctx.measureText(handle).width + h * 0.9)
  canvas.width = w
  canvas.height = h
  ctx.font = font
  // DEV-647: a flat plate with the racer's colour as its one hard edge (no pill).
  ctx.fillStyle = UI_PLATE
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = srgbCss(colour)
  ctx.fillRect(0, 0, h * 0.16, h)
  ctx.fillStyle = UI_INK
  ctx.textBaseline = 'middle'
  ctx.fillText(handle, h * 0.5, h * 0.54)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, ...NAME_TAG_MATERIAL })
  const sprite = new THREE.Sprite(material)
  sprite.name = 'room-name-tag'
  sprite.scale.set((NAME_TAG_ANGLE * w) / h, NAME_TAG_ANGLE, 1)
  // Below the HUD (10) and the results panel (11), which in a headset and on
  // Classic are drawn in the same pass as the world, by order.
  sprite.renderOrder = 9
  return sprite
}

/**
 * The tag's material: a thing IN THE WORLD, hidden by whatever stands in front
 * of it — Matt, 2026-09-27: *"hide name tags everywhere (when they should be
 * obscured)"*.
 *
 * `toneMapped: true` is what makes that true in flat Anniversary. `render/bloom.ts`
 * sends every `toneMapped: false` material to its UI pass, which draws after the
 * world with the depth buffer CLEARED — so DEV-388's tag, which was
 * `toneMapped: false` to keep its canvas off the tone curve, showed through
 * hills, props and the cockpit's frame there, while the headset and Classic,
 * which draw in one pass, already hid it. The cost is the tone curve on a
 * canvas: its white reads ~20 % dimmer under ACES, as a hull's white does. It
 * cannot bloom: the brightest texel is under the bloom's threshold of 1.
 * `tests/unit/remote-ships.test.ts` holds this against `isUiObject`, and
 * `tests/e2e/room-tag-occlusion.spec.ts` holds it on screen.
 */
export const NAME_TAG_MATERIAL = {
  transparent: true,
  toneMapped: true,
  depthTest: true,
  depthWrite: false,
  sizeAttenuation: false,
} as const

export const createRemoteShips = (opts: RemoteShipsOptions): RemoteShips => {
  const { worldOffset, edition, session, now } = opts
  const group = new THREE.Group()
  group.name = 'remote-ships'
  const hologram = racerMaterial()
  const trailLocal = trailEmitterOffset()
  const emitter = new THREE.Vector3()
  const nose = new THREE.Vector3()
  /**
   * The cosine between where the drawn hull POINTS and where it is GOING, or
   * null below 20 m/s. A mesh out of the Unity mirror noses along its local −z
   * (CLAUDE.md, trap 22), so a hull placed by the right quaternion reads near
   * 1 at speed and a mirrored or flipped one reads near −1 or 0 — the
   * orientation lesson's "test the geometry, not the rotation".
   */
  const noseAlongTrack = (ship: Ship): number | null => {
    const p = ship.pose
    const speed = Math.hypot(p.vx, p.vy, p.vz)
    if (!ship.root.visible || speed < 20) return null
    nose.set(0, 0, -1).applyQuaternion(ship.root.quaternion)
    return (nose.x * p.vx + nose.y * p.vy + nose.z * p.vz) / speed
  }
  const ships = new Map<number, Ship>()
  const audioList: AudioSlot[] = []
  const placeList: RoomDrawnRacer[] = []
  let pending = 0
  let frames = 0
  let totalMs = 0
  let maxMs = 0
  /** `update`'s own ms this frame: since DEV-612 it runs before the cameras and `renderTrails` after them. */
  let updateMs = 0
  /** The roster this last synced to: `sync` runs every frame and allocates only when it moved. */
  let syncedVersion = -1
  let syncedSlot: number | null = null

  const palette = (): Srgb[] => roomPalette(edition.current.render.racerLivery)

  const colourOf = (slot: number): number =>
    session.race?.colours[slot] ?? session.players[slot]?.colour ?? 0
  let syncedRace: unknown = null
  let syncedOwner: number | null = null

  /** A ship, not yet built: a player's by slot, or (DEV-391) a bot's by index. */
  const makeShip = (
    key: number,
    slot: number,
    bot: number | null,
    handle: string,
    colour: number,
  ) => {
    const root = new THREE.Group()
    root.name = bot === null ? `room-ship:${slot}` : `room-bot:${bot}`
    root.visible = false
    group.add(root)
    const ship: Ship = {
      slot,
      bot,
      handle,
      colour,
      root,
      pose: drawnPose(),
      audio: {
        id: bot === null ? remoteShipId(slot) : remoteBotId(bot),
        position: [0, 0, 0],
        speed: 0,
        finished: false,
      },
      body: { orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: 0 } },
      built: null,
      live: true,
      drawnTick: null,
      place: { slot, colour, tick: null, position: { x: 0, y: 0, z: 0 }, drawn: false },
    }
    ships.set(key, ship)
    void build(ship)
  }

  /** The slot whose stream a ship is drawn from: its own, or (a bot) the bot host's, the owner. */
  const sourceOf = (ship: Ship): number | null => (ship.bot === null ? ship.slot : session.owner)

  const build = async (ship: Ship): Promise<void> => {
    pending++
    try {
      const gltf = await loadMesh(assetUrl(SHIP_MESH_EXTERIOR))
      gltf.object.position.copy(ART_POSITION)
      gltf.object.rotation.y = SHIP_MODEL_YAW
      gltf.object.scale.copy(ART_SCALE)
      const tips = measureWingTips(gltf.object)
      const pal = palette()
      // The racers' recipe, in this player's colour, and solid whatever the
      // preset's racer flag says: a person is not a hologram (§6.4).
      const livery = { ...edition.current.render.racerLivery, palette: pal, enabled: true }
      const { look, glow, colour } = await dressRacerHull(
        gltf.object,
        livery,
        ship.colour,
        hologram,
        true,
      )
      const engine = createEngineTrail(colour, edition.current.fx.wingTrails)
      const wings = createCraftWingTrails(
        [{ tips, frame: ship.root, body: ship.body, livery: colour }],
        `wing-trails:room:${ship.bot === null ? ship.slot : `bot${ship.bot}`}`,
      )
      const tag = nameTag(
        ship.bot === null ? ship.handle : callsignDisplay(ship.handle),
        paletteColour(pal, ship.colour),
      )
      if (!ship.live) {
        glow?.dispose()
        gltf.dispose()
        look.dispose()
        engine.trail.dispose()
        engine.material.dispose()
        engine.base.dispose()
        wings.dispose()
        return
      }
      ship.root.add(gltf.object)
      group.add(engine.trail.object)
      group.add(wings.trails.object)
      group.add(tag)
      tag.visible = false
      ship.built = { gltf, look, glow, engine, wings, tag }
      opts.dressed?.(look.solidMaterials, [wings.trails.material as THREE.Material])
    } catch (err) {
      console.warn(`room: the hull for slot ${ship.slot} did not load`, err)
    } finally {
      pending--
    }
  }

  const drop = (ship: Ship): void => {
    ship.live = false
    group.remove(ship.root)
    const b = ship.built
    if (!b) return
    group.remove(b.engine.trail.object, b.wings.trails.object, b.tag)
    b.glow?.dispose()
    b.gltf.dispose()
    b.look.dispose()
    b.engine.trail.dispose()
    b.engine.material.dispose()
    b.engine.base.dispose()
    b.wings.dispose()
    b.tag.material.map?.dispose()
    b.tag.material.dispose()
    ship.built = null
  }

  const rebuildAudio = (): void => {
    audioList.length = 0
    placeList.length = 0
    for (const s of ships.values()) {
      audioList.push(s.audio)
      placeList.push(s.place)
    }
  }

  return {
    group,

    sync() {
      const self = session.slot
      if (
        session.rosterVersion === syncedVersion &&
        self === syncedSlot &&
        session.race === syncedRace &&
        session.owner === syncedOwner
      ) {
        return
      }
      syncedVersion = session.rosterVersion
      syncedSlot = self
      syncedRace = session.race
      syncedOwner = session.owner
      let changed = false
      for (const [key, p] of Object.entries(session.players)) {
        const slot = Number(key)
        if (slot === self || ships.has(slot)) continue
        // DEV-485: the tag, the report and the director all read this drawn name.
        makeShip(slot, slot, null, drawnHandle(p.handle, slot), colourOf(slot))
        changed = true
      }
      // DEV-391: the room's bots, drawn from the host's stream — by every page
      // but the host's, which flies them itself (`game/racers.ts`).
      const bots = opts.botName && self !== session.owner ? (session.race?.bots ?? []) : []
      for (const b of bots) {
        const key = BOT_KEY_BASE + b.index
        if (ships.has(key)) continue
        makeShip(key, botPlaceSlot(b.index), b.index, opts.botName?.(b.index) ?? 'bot', b.colour)
        changed = true
      }
      for (const [key, ship] of ships) {
        const gone =
          ship.bot === null
            ? session.players[ship.slot] === undefined || ship.slot === self
            : !bots.some((b) => b.index === ship.bot)
        if (gone) {
          drop(ship)
          ships.delete(key)
          changed = true
        }
      }
      if (changed) rebuildAudio()
    },

    get ready() {
      return pending === 0
    },

    update(roomNow) {
      const frameStart = now()
      for (const ship of ships.values()) {
        // A player's own stream, or (DEV-391) a bot's records in its host's.
        const src = sourceOf(ship)
        const kind = ship.bot === null ? 0 : 1
        const index = ship.bot ?? 0
        ship.drawnTick = src === null ? null : session.renderTick(src, kind, index, roomNow)
        if (src === null) ship.pose.mode = 'none'
        const p = src === null ? ship.pose : session.draw(src, kind, index, roomNow, ship.pose)
        // DEV-389: before its GO, a ship stands on its start, still — and for
        // the moment after it, until its first pose is due (a render delay).
        const goAt = src === null ? null : session.goAtOf(src)
        const start =
          p.mode === 'none' &&
          ship.built !== null &&
          (goAt === null || roomNow < goAt + START_HOLD_AFTER_GO_MS)
            ? ship.bot === null
              ? (opts.startOf?.(ship.slot) ?? null)
              : (opts.botStartOf?.(ship.bot) ?? null)
            : null
        if (start) {
          ship.root.position.set(
            start.pos[0] as number,
            start.pos[1] as number,
            start.pos[2] as number,
          )
          ship.root.quaternion.set(
            start.quat[0] as number,
            start.quat[1] as number,
            start.quat[2] as number,
            start.quat[3] as number,
          )
          ship.root.visible = true
          ship.place.tick = null
          ship.place.drawn = true
          ship.place.position.x = ship.root.position.x
          ship.place.position.y = ship.root.position.y
          ship.place.position.z = -ship.root.position.z
          ship.body.velocity.z = 0
          ship.audio.position[0] = ship.root.position.x
          ship.audio.position[1] = ship.root.position.y
          ship.audio.position[2] = ship.root.position.z
          ship.audio.speed = 0
          ship.audio.finished = false
          continue
        }
        const drawn = p.mode !== 'none' && ship.built !== null
        ship.root.visible = drawn
        ship.place.tick = ship.drawnTick
        ship.place.drawn = drawn
        if (!drawn) continue
        ship.root.position.set(worldOffset[0] + p.px, worldOffset[1] + p.py, worldOffset[2] + p.pz)
        // SIM space for the live place: the one z flip every mesh uses.
        ship.place.position.x = ship.root.position.x
        ship.place.position.y = ship.root.position.y
        ship.place.position.z = -ship.root.position.z
        ship.root.quaternion.set(p.qx, p.qy, p.qz, p.qw)
        const speed = Math.hypot(p.vx, p.vy, p.vz)
        ship.body.velocity.z = speed
        ship.audio.position[0] = ship.root.position.x
        ship.audio.position[1] = ship.root.position.y
        ship.audio.position[2] = ship.root.position.z
        ship.audio.speed = speed
        // A stale ship (its stream stopped past the extrapolation cap) goes
        // quiet rather than snapping anywhere (§6.4).
        ship.audio.finished = p.stale
      }
      updateMs = now() - frameStart
    },

    renderTrails(eye, dt, wingDt) {
      const trailsStart = now()
      for (const ship of ships.values()) {
        const b = ship.built
        if (!b) continue
        const shown = ship.root.visible && !ship.pose.stale
        b.tag.visible = ship.root.visible
        if (!shown) {
          b.engine.trail.reset()
          b.wings.clear()
          continue
        }
        b.tag.position.copy(ship.root.position)
        b.tag.position.y += NAME_TAG_LIFT_M
        emitter.copy(trailLocal).applyQuaternion(ship.root.quaternion).add(ship.root.position)
        b.engine.trail.update(emitter, eye, dt)
        b.wings.update(eye, wingDt, edition.current.fx.wingTrails, edition.speedFx, true)
      }
      const ms = updateMs + (now() - trailsStart)
      updateMs = 0
      frames++
      totalMs += ms
      if (ms > maxMs) maxMs = ms
    },

    audio: () => audioList,

    drawn: () => placeList,

    report() {
      const out: RemoteShipReport[] = []
      for (const ship of ships.values()) {
        const p = ship.pose
        const src = sourceOf(ship)
        const track =
          src === null ? undefined : session.track(src, ship.bot === null ? 0 : 1, ship.bot ?? 0)
        out.push({
          slot: ship.slot,
          bot: ship.bot,
          handle: ship.handle,
          colour: ship.colour,
          loaded: ship.built !== null,
          visible: ship.root.visible,
          mode: p.mode,
          stale: p.stale,
          position: ship.root.visible
            ? [ship.root.position.x, ship.root.position.y, ship.root.position.z]
            : null,
          renderTick: ship.drawnTick,
          delayMs: track?.delayMs ?? null,
          newestTick: track?.newestTick ?? null,
          noseAlongTrack: noseAlongTrack(ship),
        })
      }
      return out
    },

    follow(index, pos, quat) {
      let shown = 0
      for (const ship of ships.values()) if (ship.root.visible) shown++
      if (shown === 0) return null
      let want = ((index % shown) + shown) % shown
      for (const ship of ships.values()) {
        if (!ship.root.visible) continue
        if (want-- > 0) continue
        pos.copy(ship.root.position)
        quat.copy(ship.root.quaternion)
        return ship.handle
      }
      return null
    },

    stats: () => ({
      frames,
      meanMs: frames > 0 ? totalMs / frames : 0,
      maxMs,
      ships: ships.size,
    }),

    resetStats() {
      frames = 0
      totalMs = 0
      maxMs = 0
    },

    dispose() {
      for (const ship of ships.values()) drop(ship)
      ships.clear()
      audioList.length = 0
      hologram.dispose()
      group.clear()
    },
  }
}
