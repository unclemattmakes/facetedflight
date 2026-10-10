// src/boot/app/hangar/room.ts: the hangar, built, out of `bootApp`. APP-SPLIT
// phase 4, slice 6 (hangar and menus; `docs/plan/APP-SPLIT.md` §5).
//
// The room's seed and its doors, the course cards' words, the formation's
// liveries, `createHangar` itself, YOUR COURSES on a holotable (DEV-488), the
// room's own shadows (DEV-440) and the jet parked beside the chair. The menu SCENE, its sun and
// `shellChildren` stay in the closure above the call: they must be captured
// before the first world's light, and the call keeps this block after them.
// Every line below was moved verbatim from the closure; the plumbing is
// `ctx.x` where the code reads a binding the closure still owns (a getter,
// and a setter where this code writes one: `hangar`, the §6
// rule 3 bag), and the returned object, which hands the closure what it calls.

import type * as THREE from 'three'
import { fleetOf, STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { assetUrl } from '@/content/asset-url'
import type { Edition } from '@/content/edition-schema'
import type { GameMode, Level } from '@/content/level-schema'
import { loadPlayerCourse } from '@/content/load-player-course'
import type { PlayerCourse } from '@/content/player-course'
import { bestRule } from '@/game/best-medal'
import type { EditionState } from '@/game/edition'
import { SHIP_MESH_EXTERIOR } from '@/game/flight'
import { loadJumpSeatArt } from '@/game/jumpseat-art'
import type { MissionCard } from '@/game/mission-index'
import { ORB_MESH } from '@/game/orb-art'
import { hasAnyBest, readBest } from '@/game/personal-best'
import { QUICK_RACE } from '@/game/quick-race'
import { RING_MESH } from '@/game/rings'
import type { RoomClient } from '@/game/room-client'
import { roomCodeText } from '@/game/room-lobby'
import { attachShipWings } from '@/game/ship-wings'
import type { CustomGround } from '@/game/terrain/custom-ground'
import type { VariantStep } from '@/game/variant-stats'
import type { WatchClient } from '@/game/watch-client'
import type { ShelfAction } from '@/render/course-shelf'
import {
  MAKE_A_COURSE_ACTION,
  OPEN_COURSE_FILE_ACTION,
  withYourCourses,
} from '@/render/course-shelf'
import {
  createHangar,
  HANGAR_SPIN,
  type HangarArt,
  seatEyeLocal,
  seatYawLocal,
} from '@/render/hangar'
import { type DoorInput, doorStepCards, type OpenRoomDoor } from '@/render/hangar-doors'
import { createRoomShadows } from '@/render/hangar-light'
import { applyLambert1 } from '@/render/lambert1'
import { loadMesh } from '@/render/load-mesh'
import { shrinkParkedNoseGlow } from '@/render/parked-glow'
import { paletteColour, srgbHex } from '@/render/racer-livery'
import { hangarSpecFor } from '@/sim/hangar'
import { BUILD_VERSION } from '../../version'
import { WORLD_UP } from '../chase-camera'
import type { createPlayerCourses } from '../title/player-courses'

/** What `createHangarRoom` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface HangarRoomCtx {
  readonly RUNNING_MODE: GameMode
  readonly doorPress: (id: string) => void
  readonly editionState: EditionState
  readonly editorOn: () => boolean
  readonly ghostLineFor: (card: MissionCard) => string | null
  readonly groundOfCourse: (
    course: PlayerCourse,
    map?: Uint8Array<ArrayBufferLike> | null,
  ) => Promise<CustomGround | null>
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  hangar: HangarArt | null
  readonly hangarVariants: VariantStep
  readonly level: Level
  readonly makeCourse: () => void
  readonly menuEdition: Edition | null
  readonly menuEditionLoad: Promise<Edition>
  readonly menuScene: THREE.Scene<THREE.Object3DEventMap>
  readonly openCourseFilePicker: () => void
  readonly openRooms: readonly OpenRoomDoor[] | null
  readonly playerCourseHost: ReturnType<typeof createPlayerCourses>
  readonly playerCourses: Map<string, PlayerCourse>
  readonly room: RoomClient | null
  readonly roomId: string | null
  readonly seatQuaternion: THREE.Quaternion
  readonly seatWorld: THREE.Vector3
  readonly shelfActions: () => readonly ShelfAction[]
  readonly titleLinkRoom: string | null
  readonly tvActive: () => boolean
  readonly tvOn: () => boolean
  readonly watch: WatchClient | null
}

export const createHangarRoom = (ctx: HangarRoomCtx) => {
  /** One room, one seed, every load and every machine. `sim/hangar.ts` is pure. */
  const HANGAR_SEED = 0x48414e47

  // The room you CHOOSE in. Built here rather than inside the terrain block,
  // because it no longer needs anything the mission has: no platform to size it,
  // no anchor to hang it on, no height field for the table that used to stand in
  // while the index loaded. It is up before the world is, which is also the door
  // to building the world only once a course has been picked.
  // Keyed by mission AND running mode since DEV-204. `RUNNING_MODE` rather than
  // `level.mode`, so the key matches the rules the run is actually scored under
  // — a level's own forcing, and `?mode=` where the preset honours it.
  // Read under today's rule (DEV-393): an old best keeps no time bonus its missed
  // rings no longer earn.
  const storedBest = readBest(
    ctx.level.id,
    ctx.RUNNING_MODE,
    undefined,
    undefined,
    bestRule(ctx.level, ctx.RUNNING_MODE),
    // DEV-538: an overridden course's own record (absent on 2016's course).
    ctx.level.courseKey ?? null,
  )
  // ── DEV-558: the hangar's first step, SINGLE PLAYER · MULTIPLAYER · FF-TV ──
  //
  // Matt, 2026-10-01: *"Clicking either should take us to the Hangar, where
  // the first set of choices are: Single Player / Multiplayer / FFTV"*. The
  // room opens on them (`render/hangar-doors.ts` says what stands there).
  // Every decision reads the MENU's edition, Anniversary (`menuEdition`: *"our
  // menus should only ever be anniversary"*, D35), never the edition the
  // player chose; the build channel is the one thing that may hide a table (a
  // `PREVIEW_ONLY` block is off on a release build; since DEV-578 TV ships, so
  // every build's first step is the same four tables).
  // (`titleLinkRoom`, the room a link named, is declared beside `roomId`.)
  /** DEV-379's first visit, read once: a browser that has never finished a run. */
  const titleFirstVisit = !hasAnyBest()
  /** The menu's flags: Anniversary's, as this build ships it. "No" until its preset has landed. */
  const menuFlags = (): { readonly variants: boolean; readonly rooms: boolean } => ({
    variants: ctx.menuEdition?.gameplay.variants.enabled ?? false,
    rooms: ctx.menuEdition?.gameplay.rooms.enabled ?? false,
  })
  /**
   * DEV-470: why the room or the race this page's LINK named could not be
   * reached, or null — a `?watch=` whose broadcaster refused it or never
   * answered (on a site with no rooms, at once), or the `?room=` link's room,
   * closed. The MULTIPLAYER table says it (DEV-558; the title's door did), and
   * so does the title's START.
   */
  const titleRoomNotice = (): string | null => {
    // DEV-480: a `?watch=` link's, never TV's
    if (ctx.watch?.status === 'closed' && !ctx.tvActive()) return ctx.watch.notice
    if (ctx.titleLinkRoom !== null && ctx.room !== null && ctx.roomId === ctx.titleLinkRoom) {
      return ctx.room.status === 'closed' ? ctx.room.notice : null
    }
    return null
  }
  /**
   * DEV-879: is the Course Editor table offered: wherever the shelf's MAKE A COURSE
   * is (`shelfActions`). The room is built, and its first layout asked for, before
   * `playerCourseHost` exists in the closure (a read of it then is a TDZ error that
   * stopped boot), so until it does the answer is no; the menus' preset landing
   * re-lays the doors (`refresh` below), and the answer is read again.
   */
  const editorDoorOffered = (): boolean => {
    try {
      return ctx.playerCourseHost.shelfActions().some((a) => a.id === MAKE_A_COURSE_ACTION.id)
    } catch {
      return false
    }
  }
  /** What the door tables are a function of (`render/hangar-doors.ts`). */
  const doorInput = (): DoorInput => ({
    rooms: menuFlags().rooms,
    tv: ctx.tvOn(),
    firstVisit: titleFirstVisit,
    linkRoom: ctx.titleLinkRoom === null ? null : roomCodeText(ctx.titleLinkRoom),
    roomNotice: titleRoomNotice(),
    openRooms: ctx.openRooms, // DEV-633
    quickRaceVariant: quickRaceVariantName(),
    racerLiveries: formationLiveries(),
    // DEV-879: the editor's table, wherever the shelf's MAKE A COURSE is offered.
    editor: editorDoorOffered(),
    // DEV-620: the CREDITS table's note, and its step's first table.
    version: BUILD_VERSION,
  })
  /**
   * DEV-565: the HoverJet variant QUICK RACE will fly, by name, as DEV-382's
   * title row named it: where the aircraft has more than one, the last flown,
   * and Standard before any. The flight reads the same store (`flightVariantFor`).
   */
  const quickRaceVariantName = (): string | null => {
    const cards = menuFlags().variants ? ctx.hangarVariants.cardsFor(QUICK_RACE.vehicle) : []
    if (cards.length < 2) return null
    const last = ctx.hangarVariants.lastFlown(QUICK_RACE.vehicle) ?? STANDARD_VARIANT_ID
    return cards.find((c) => c.id === last)?.name ?? null
  }
  /**
   * DEV-575: MULTIPLAYER's three jets wear the first three racers' liveries off
   * the MENUS' preset (D35), as the title's flypast jets take the first two.
   * (DEV-565's QUICK RACE racer wore the first; QUICK RACE stands the gate now.)
   */
  const formationLiveries = (): string[] | null => {
    const palette = ctx.menuEdition?.render.racerLivery.palette ?? []
    return palette.length > 0 ? [0, 1, 2].map((i) => srgbHex(paletteColour(palette, i))) : null
  }
  ctx.hangar = createHangar({
    spec: hangarSpecFor(),
    seed: HANGAR_SEED,
    // DEV-558: the first step, and Multiplayer's; a press of FF-TV or a room
    // choice is `doorPress`'s (the title block, below).
    doors: (step) => doorStepCards(step, doorInput()),
    onDoor: (id) => ctx.doorPress(id),
    // Which PLACE sits under the resting pointer on the maps step, and which
    // course does once you are inside it. Matched by ID rather than by title,
    // because two missions can share one — `int_01_hoverJet` and
    // `hoverJet_kauai_beg` are the same course authored twice.
    currentId: ctx.level.id,
    title: ctx.level.title,
    subtitle: storedBest
      ? `best ${storedBest.score} · ${storedBest.timeSeconds.toFixed(1)}s`
      : 'no time set',
    // No stand-in diorama: every table builds its own from `missionShape`, and
    // the one this used to pass was the only reason the room had to wait for
    // terrain.
    level: null,
    // The islands wear the terrain's own colours in both presets; how much of
    // a hologram is made of them is the live preset's (DEV-140).
    holoLook: () => ctx.editionState.current.menu.holoTerrainColours,
    medalOutline: () => ctx.editionState.current.menu.medalOutline,
    // DEV-382: the variant step, off the live edition, the aircraft files and
    // the variant each aircraft last flew.
    variants: ctx.hangarVariants,
    // DEV-399: which aircraft the live edition flies — the glider's table and
    // course on Anniversary, never on Classic.
    fleet: fleetOf(() => ctx.editionState.current),
    // DEV-373: the ghost each course card races, which the race button moves on.
    ghostLine: ctx.ghostLineFor,
    firstVisit: titleFirstVisit,
  })
  // ══ DEV-488: YOUR COURSES on a holotable ═════════════════════════════════
  //
  // The course library (DEV-467) in the room: a door table on the aircraft
  // step, and a shelf of the player's courses, each a diorama, that a press
  // boards through the room's own switch — so it is waited out in the room
  // (DEV-465). `render/course-shelf.ts` wraps the room; everything below reads
  // `hangar` and gets the wrapped one. Gated on the MENUS' `gameplay.editor`
  // (D35). The library, its entries and `playerCourses` are DEV-467's block's,
  // read lazily (they are declared further down). `switchMission` asks
  // `yourCourses.levelOf` before `loadLevel`, which cannot resolve a `pc_` id.
  const yourCourses = withYourCourses(ctx.hangar, {
    spec: hangarSpecFor(),
    enabled: () => ctx.editorOn(),
    entries: () => ctx.playerCourseHost.courseEntries,
    // DEV-490: a course on an imported island is built over it, its map from the library.
    levelFor: async (entry) =>
      loadPlayerCourse(entry.course, { ground: await ctx.groundOfCourse(entry.course) }),
    holoLook: () => ctx.editionState.current.menu.holoTerrainColours,
    // DEV-558: the title's COURSES hub, moved onto the shelf: OPEN A COURSE
    // FILE and MAKE A COURSE (`shelfActions`, DEV-467's block).
    actions: () => ctx.shelfActions(),
    onAction: (id) => {
      if (id === OPEN_COURSE_FILE_ACTION.id) ctx.openCourseFilePicker()
      else if (id === MAKE_A_COURSE_ACTION.id) ctx.makeCourse()
    },
    onBoard: (entry, next) => {
      // What the results panel's COPY LINK and SAVE FILE share (`coursePanel`).
      ctx.playerCourses.set(next.id, entry.course)
      document.body.dataset.playerCourse = next.id
      console.info(`courses: flying ${next.id} (${next.title}, from the shelf)`)
    },
  })
  ctx.hangar = yourCourses.hangar
  // ══ end DEV-488 ══════════════════════════════════════════════════════════
  ctx.menuScene.add(ctx.hangar.object)
  // A preset flip re-lays the page, so the tables pick up the new look; the
  // dioramas are rebuilt on every layout anyway.
  ctx.editionState.subscribe(() => ctx.hangar?.refresh())
  // DEV-558: and the doors wait on the MENUS' preset (rooms, TV), which lands
  // after the room is built.
  void ctx.menuEditionLoad.then(() => ctx.hangar?.refresh())
  // DEV-440: 2016's key light casts in the room, under the same switch as the
  // mission sun's map. Set NOW, before the room's first frame, because a
  // light's shadow count is in every lit program's key (`render/hangar-light.ts`).
  const menuKey = ctx.hangar.object.getObjectByName('hangar-2016-key') as
    | THREE.DirectionalLight
    | undefined
  const roomShadows = menuKey
    ? createRoomShadows(ctx.hangar.object, menuKey, ctx.editionState)
    : null

  // The jet parked beside the chair — 2016 instances `hoverJet_exterior_orange`
  // twice in `setGameplayOptions`, and the port used to get one for free by
  // wrapping the room around the mission's own launch platform. Which is why the
  // six missions without a platform had an empty room. Async and unawaited: a
  // room with no jet in it yet is a room, and a boot that blocks on a mesh is
  // not.
  void loadMesh(assetUrl(SHIP_MESH_EXTERIOR))
    .then(async (loaded) => {
      // DEV-531: `lambert1.mat`'s colour, as the flown jet gets it (DEV-088),
      // for the generated room's light. In 2016's the room re-dresses it in the
      // deck's own material (`render/hangar-art.ts`).
      applyLambert1(loaded.object)
      // DEV-546: and 2016's anti-grav wing under it — f0030's glowing blue
      // orbs. `Environment_Hangar.prefab` hangs the same two combined meshes
      // beside `hoverJet_exterior_orange` under one parent, at identity, as
      // the racer prefab the flown wing was converted from does, so it is the
      // flown jet's wing as a plain child (`game/ship-wings.ts`). A wing that
      // will not load warns and parks the hull alone; it never throws.
      await attachShipWings(loaded.object)
      // DEV-562: its nose glow, on THIS jet only, scaled down so it stops
      // cutting through the chin (`render/parked-glow.ts`).
      shrinkParkedNoseGlow(loaded.object)
      ctx.hangar?.park(loaded.object)
    })
    .catch((error: unknown) => {
      console.warn('hangar: no parked jet —', error)
    })

  // The aircraft standing on the two AIRCRAFT tables (DEV-142). Matt, in a
  // headset: *"menu ui showing ship selection should show the ships, not
  // terrain, on the holo table."*
  //
  // A SECOND load of the HoverJet exterior, not the parked jet above reused:
  // `loadMesh` caches nothing, so these are independent geometries, and that is
  // what is wanted. `parkShip` disposes the geometry of whatever it replaces,
  // so a prototype shared with the parked jet would have every table's clone
  // emptied out from under it by the next `park()` — trap 19's shape, one
  // object two owners, and the symptom would be a menu that works until
  // something unrelated changes the room.
  //
  // `allSettled`, not `all`: one aircraft's mesh 404ing must cost that
  // aircraft's table and not the other's. Unawaited, like the jet and the
  // medals — a boot that blocks on a mesh is a boot that waits.
  void Promise.allSettled([loadMesh(assetUrl(SHIP_MESH_EXTERIOR)), loadJumpSeatArt()]).then(
    ([hoverjet, jumpseat]) => {
      const models: Record<string, THREE.Object3D> = {}
      if (hoverjet.status === 'fulfilled') {
        models.hoverjet = hoverjet.value.object
        // DEV-399: the glider stands on its table in the HoverJet's hull, the
        // hull it flies in, until it has art of its own (G3, Matt's call). One
        // prototype on several tables is what the variant step already does.
        models.glider = hoverjet.value.object
      } else console.warn('hangar: no HoverJet on its table —', hoverjet.reason)
      if (jumpseat.status === 'fulfilled') models.jumpseat = jumpseat.value.object
      else console.warn('hangar: no JumpSeat on its table —', jumpseat.reason)
      ctx.hangar?.ships(models)
    },
  )

  // The medals over finished courses (DEV-113). They are the title emblem in a
  // tinted material — 2016's `medal_<Tier>.prefab` is `logo_polys` under a
  // different .mat — so the room gets the same glTF the title screen stands in
  // the valley, loaded on its own so the menu does not wait on the title and a
  // missing logo costs the medals and nothing else. Same shape as the jet above.
  void loadMesh(assetUrl('assets/props/title-logo.glb'))
    .then((loaded) => {
      ctx.hangar?.medals(loaded.object)
    })
    .catch((error: unknown) => {
      console.warn('hangar: no medals, the logo mesh is unavailable —', error)
    })

  // The gate on the Ring Attack flight-plan table is 2016's own frame (DEV-326;
  // one large turning gate on the plan step since DEV-354) — the same
  // `checkpoint-ring.glb` the course draws, loaded on its own so the menu does
  // not wait on a mission. The room copies what it needs, so the load is freed
  // straight after. A missing gate costs that table its mark and nothing else.
  void loadMesh(assetUrl(RING_MESH))
    .then((loaded) => {
      ctx.hangar?.gates(loaded.object)
      loaded.dispose()
    })
    .catch((error: unknown) => {
      console.warn(
        'hangar: no gate on the flight-plan table, the ring mesh is unavailable —',
        error,
      )
    })

  // The orb on the Free Flight flight-plan table is 2016's own ball (DEV-327,
  // DEV-354), the gate block's shape exactly: the room copies what it needs,
  // the load is freed, and a missing orb costs that table its mark and nothing
  // else.
  void loadMesh(assetUrl(ORB_MESH))
    .then((loaded) => {
      ctx.hangar?.orbs(loaded.object)
      loaded.dispose()
    })
    .catch((error: unknown) => {
      console.warn('hangar: no orb on the flight-plan table, the orb mesh is unavailable —', error)
    })

  // The chair, in the MENU world. Composed once: the room does not move.
  //
  // It used to be composed inside the terrain block against the launch anchor's
  // quaternion, because the room hung off the anchor and inherited the mission
  // ship's spawn rotation. The room has its own scene and its own origin now, so
  // the anchor is gone from this and `HANGAR_SPIN` is the whole rotation —
  // which is what DEV-040's sweep measured in the first place.
  {
    const local = seatEyeLocal(hangarSpecFor())
    ctx.hangar.object.updateWorldMatrix(true, false)
    ctx.seatWorld.set(local.x, local.y, local.z).applyMatrix4(ctx.hangar.object.matrixWorld)
    ctx.seatQuaternion.setFromAxisAngle(WORLD_UP, HANGAR_SPIN + seatYawLocal())
  }

  return {
    titleRoomNotice,
    menuFlags,
    HANGAR_SEED,
    yourCourses,
    roomShadows,
  }
}
