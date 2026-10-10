// src/render/hangar-doors.ts: the hangar's FIRST step. DEV-558.
//
// Matt, 2026-10-01, after a short play of 0.14.0:
//
//   *"Title Screen: Start, Enter VR. Clicking either should take us to the
//   Hangar, where the first set of choices are: Single Player / Multiplayer /
//   FFTV. Clicking Single Player should: Aircraft selection then mode
//   selection."*
//
// So the choices the title's plate used to hold (DEV-441's two doors, and
// DEV-480's TV row) are holotables now, on a step of their own in front of the
// aircraft. In a headset the hangar is the whole UI, and a table is the thing
// every device there already aims: the head, a laser, the stick, a finger, the
// cursor. This file is WHAT stands on those tables, as plain values; the room
// (`render/hangar.ts`) stands them, and `boot/app.ts` decides which.
//
// Two steps, and only the first is in Matt's words:
//
//   DOORS        SINGLE PLAYER (descends to the aircraft), QUICK RACE (a race,
//                DEV-565), MULTIPLAYER (descends to the room choices), FF-TV
//                (boards TV). MULTIPLAYER stands where the build has rooms,
//                FF-TV where it has TV (both read off the MENUS' preset, D35;
//                since DEV-578 both ship, so every build's first step is four
//                tables).
//   MULTIPLAYER  HOST A RACE, JOIN WITH A CODE, and JOIN ROOM where a link named
//                one: the title's Multiplayer page (DEV-441), moved. A press of
//                one does what the row did; the lobby is the hangar's, as it
//                always was (DEV-389).
//
// The ids are the title rows' own (`room`, `room-code`, `room-join`,
// `single-player`, `multiplayer`, `tv`, `quick-race`), so a spec or a log that
// named a row names the same thing here.
//
// **DEV-565: QUICK RACE is a fourth table** (Matt, 2026-10-02: *"add quick race
// as a 4th table"*). DEV-558 took Quick Race off the title and kept its route
// for a shared lap; this table takes that route again (`startQuickRace` in
// `boot/app.ts`): a random HoverJet Ring Attack course (`game/quick-race.ts`),
// the AI racers on the grid, no lift ride, the countdown by itself. It stands
// beside SINGLE PLAYER, the other way to fly alone, on every build: nothing in
// it is `PREVIEW_ONLY`.
//
// **DEV-575: the first step's pictures and words** (Matt, 2026-10-02, on
// 0.17.0: *"icons: 'quick race' - use the ring; multipayer - show 3 scaled
// down hoverjet's in a triangle formation to symbolize; TV - take a stab at a
// TV icon"*, *"change Quick Race subtitle text - 'Ring Attack on random
// course'. remove 'a random course, no lift ride'"*, *"change Single Player to
// 'HoverJet or JumpSeat'"*). QUICK RACE stands 2016's gate (MULTIPLAYER's
// until now) and reads *Ring Attack on random course*; MULTIPLAYER stands
// three HoverJets in a vic, each in one AI racer's livery; FF-TV a set on a
// stand (`render/door-marks.ts` for both); SINGLE PLAYER reads *HoverJet or
// JumpSeat* under its name.
//
// **DEV-832: the left-end table is OPTIONS now** (Matt, 2026-10-08: *"remove
// the credits panel and the start panel from the hangar. add an options table;
// the credits go there."*). It stands where CREDITS stood and opens an OPTIONS
// step whose one table is CREDITS, which opens the roll as below. The step
// header that read START over the doors is gone with it.
//
// **DEV-620: CREDITS, off the left end** (Matt, 2026-10-03: *"add a credits
// table in the hangar"*). A fifth door, first in the list, standing 80
// degrees left of the resting pointer (`CREDITS_DOOR_OFF` in `hangar.ts`),
// outside a flat frame and a phone's at rest, so the four doors keep the
// frame to themselves and a turn to the left finds it.
// It stands a scroll (`render/door-marks.ts`) and descends to a third door
// step, `credits`: since DEV-623 ONE table, centred where the player looks,
// standing the credits roll (`creditsRollCard`), BACK to the doors.

/**
 * What a door table stands: the aircraft, 2016's gate, MULTIPLAYER's formation
 * of three jets, FF-TV's set (DEV-575), or nothing.
 */
export type DoorPicture =
  | 'aircraft'
  | 'ring'
  | 'formation'
  | 'tv'
  | 'scroll'
  | 'options'
  | 'editor'
  | 'roll'
  | null

/** One door table: its words, and what stands on it. */
export interface DoorCard {
  readonly id: string
  /** The headline: the table's name. */
  readonly name: string
  /** The second line: where it goes. */
  readonly detail: string
  /** The third line, or `''`. */
  readonly note: string
  /** The note in the room's accent: something to act on (a first visit, a link). */
  readonly accent?: boolean
  readonly picture: DoorPicture
  /** The aircraft an `aircraft` or `formation` picture stands. */
  readonly vehicle?: string
  /**
   * A `formation` picture's three liveries, `#rrggbb`, leader first (DEV-575);
   * without any the table stands nothing rather than an invented paint.
   */
  readonly liveries?: readonly string[]
}

/** The door ids. The title rows' own, where a row had one. */
export const DOOR = {
  single: 'single-player',
  multiplayer: 'multiplayer',
  tv: 'tv',
  /** DEV-565. The title's Quick Race row's id (`QUICK_RACE_ROW_ID`), as it was. */
  quickRace: 'quick-race',
  host: 'room',
  joinCode: 'room-code',
  joinLink: 'room-join',
  /** DEV-879: the COURSE EDITOR, the first step's second table. */
  editor: 'course-editor',
  /** DEV-832: OPTIONS, off the first step's left end (DEV-620's CREDITS, moved one step in). */
  options: 'options',
  /** DEV-620: the credits, now a table on the OPTIONS step. */
  credits: 'credits',
} as const

/**
 * DEV-633: a PUBLIC room's table on the Multiplayer step: `OPEN_ROOM_DOOR` and
 * the room's code. `openRoomOfDoor` reads the code back.
 */
export const OPEN_ROOM_DOOR = 'room-open:'
/** DEV-633: the table that stands when no public room is open. */
export const NO_OPEN_ROOMS_DOOR = 'room-open-none'
/** DEV-633: the most public rooms the Multiplayer step stands at once. */
export const OPEN_ROOM_TABLES = 3

/** DEV-633: the room code behind door `id`, or null when it is not an open room's table. */
export const openRoomOfDoor = (id: string): string | null =>
  id.startsWith(OPEN_ROOM_DOOR) ? id.slice(OPEN_ROOM_DOOR.length) : null

/** DEV-633: a public room, as its table says it. Nothing typed by anybody: the course is the page's own name for it. */
export interface OpenRoomDoor {
  /** The room's code, canonical. */
  readonly code: string
  /** How a plate says the code (`roomCodeText`). */
  readonly spoken: string
  /** The course's name, or null when this page does not know it. */
  readonly course: string | null
  readonly players: number
  readonly seats: number
  readonly racing: boolean
}

/**
 * The steps a door table stands on: the first, Multiplayer's, OPTIONS (DEV-832)
 * and the credits (DEV-620), which are a branch of OPTIONS.
 */
export type DoorStep = 'doors' | 'multiplayer' | 'options' | 'credits'

/** The note a first visit reads (FLIGHT-INSTRUCTOR §7, call 9): DEV-379's words, one table up. */
export const FIRST_VISIT_NOTE = 'new here? start here'

/** What decides the doors, as plain values: `app.ts` reads them off the menus' preset and the page. */
export interface DoorInput {
  /** The build has rooms: `gameplay.rooms` on the menus' preset. */
  readonly rooms: boolean
  /** The build has Faceted Flight TV: `gameplay.tv` on the menus' preset. */
  readonly tv: boolean
  /** A browser that has never finished a run (`hasAnyBest`). */
  readonly firstVisit: boolean
  /** The room a LINK named, as its code reads (`roomCodeText`), or null. */
  readonly linkRoom: string | null
  /** Why the room or race a link named could not be reached (DEV-470), or null. */
  readonly roomNotice: string | null
  /**
   * DEV-633: the public rooms, from `GET /api/rooms`, or null while unknown
   * (not asked yet, or this site has no rooms): the step then stands none.
   */
  readonly openRooms?: readonly OpenRoomDoor[] | null
  /**
   * DEV-565: the HoverJet variant a Quick Race will fly, by name, where the
   * aircraft has more than one (DEV-382's value on the title's row); null or
   * absent says nothing.
   */
  readonly quickRaceVariant?: string | null
  /**
   * DEV-575: the first three AI racers' liveries, `#rrggbb`, off the menus'
   * preset, for MULTIPLAYER's formation.
   */
  readonly racerLiveries?: readonly string[] | null
  /** DEV-620: the build's version (`BUILD_VERSION`), for the CREDITS door and its step. */
  readonly version?: string
  /**
   * DEV-879: the course editor is offered here: the menus' `gameplay.editor` on
   * a desktop (the shelf's MAKE A COURSE gate, `shelfActions`). Absent is no table.
   */
  readonly editor?: boolean
}

/** The aircraft a SINGLE PLAYER table stands: the first public release's. */
export const SINGLE_PLAYER_AIRCRAFT = 'hoverjet'

/** DEV-575: the aircraft MULTIPLAYER's formation flies: the first public release's, three times. */
export const FORMATION_AIRCRAFT = 'hoverjet'

/**
 * DEV-565: QUICK RACE's table. The race it boards is `game/quick-race.ts`'s.
 *
 * DEV-575: Matt's subtitle, and his *"remove 'a random course, no lift ride'"*.
 * On a preview build that note named the HoverJet variant the race flies
 * (DEV-382's value, *"a random course, Standard jet"*); the variant stays, as
 * the whole note (*"Standard jet"*), because a race in a jet you did not pick
 * should say which. The detail already says *random course*. Where the
 * aircraft has one variant (every release build: variants are
 * `PREVIEW_ONLY`), there is no note.
 */
export const quickRaceCard = (input: DoorInput): DoorCard => ({
  id: DOOR.quickRace,
  name: 'Quick Race',
  detail: 'Ring Attack on random course',
  note: input.quickRaceVariant ? `${input.quickRaceVariant} jet` : '',
  picture: 'ring',
})

/**
 * DEV-832: the OPTIONS door, first on the first step, off the left end. Matt,
 * 2026-10-08: *"remove the credits panel and the start panel from the hangar.
 * add an options table; the credits go there."* It stands a panel of
 * sliders; the step it opens holds the CREDITS table.
 */
export const optionsDoorCard = (): DoorCard => ({
  id: DOOR.options,
  name: 'Options',
  detail: 'credits and more',
  note: '',
  picture: 'options',
})

/**
 * DEV-879 (Matt, 2026-10-08: *"add a Course Editor table to the first hangar
 * menu"*): the table that opens the editor, the shelf's MAKE A COURSE moved up
 * to the first step. Its picture is a map with a route and a pencil.
 */
export const editorDoorCard = (): DoorCard => ({
  id: DOOR.editor,
  name: 'Course Editor',
  detail: 'lay rings over an island',
  note: 'fly them, share them',
  picture: 'editor',
})

/**
 * DEV-620: the CREDITS table, since DEV-832 the OPTIONS step's. Its note is the
 * version, which the title's foot also says; the step it opens has the rest.
 */
export const creditsDoorCard = (input: DoorInput): DoorCard => ({
  id: DOOR.credits,
  name: 'Credits',
  detail: 'who made it, and whose work is in it',
  note: input.version ?? '',
  picture: 'scroll',
})

/**
 * DEV-623: the CREDITS step's one table. Matt, 2026-10-04: *"show this same
 * panel in the hangar on a centered table, instead of a table per credit"*.
 * It stands the roll (`door-marks.ts`'s `createRollMark`), the pause plate's
 * CREDITS text; its note is the version, which the roll reads.
 */
export const creditsRollCard = (input: DoorInput): DoorCard => ({
  id: 'credits-roll',
  name: 'Credits',
  detail: 'Faceted Flight, then and now',
  note: input.version ?? '',
  picture: 'roll',
})

/**
 * The first step's tables, left to right: OPTIONS (DEV-832, off the left end,
 * see `stepBearings`), QUICK RACE, SINGLE PLAYER, then MULTIPLAYER and FF-TV
 * where the build has them.
 *
 * SINGLE PLAYER stands under the resting pointer (Matt, 2026-10-02: *"single
 * player under the pointer"*). The doors are laid by `tableBearings` (at
 * DEV-578's narrower `DOORS_BEARING_STEP`, so four fit a flat frame), whose
 * home is the second of three or four, so QUICK RACE goes to its left. With
 * only two tables (no rooms and no TV) the home is the first, so SINGLE PLAYER
 * leads and QUICK RACE stands to its right.
 */
export const doorCards = (input: DoorInput): readonly DoorCard[] => {
  const room = input.roomNotice ?? (input.linkRoom ? `room ${input.linkRoom}, from your link` : '')
  const single: DoorCard = {
    id: DOOR.single,
    // Flow A (UX-PASS 2026-10-08): the table says FLY; its id stays `single-player`.
    name: 'Fly',
    // DEV-575, Matt: *"change Single Player to 'HoverJet or JumpSeat'"*. Read
    // as the subtitle; the name is his own step's from DEV-558.
    detail: 'HoverJet or JumpSeat',
    note: input.firstVisit ? FIRST_VISIT_NOTE : '',
    accent: input.firstVisit,
    picture: 'aircraft',
    vehicle: SINGLE_PLAYER_AIRCRAFT,
  }
  const rest: DoorCard[] = [
    ...(input.rooms
      ? [
          {
            id: DOOR.multiplayer,
            name: 'Multiplayer',
            detail: 'race friends in a room',
            note: room,
            accent: room !== '',
            picture: 'formation' as const,
            vehicle: FORMATION_AIRCRAFT,
            ...(input.racerLiveries && input.racerLiveries.length > 0
              ? { liveries: input.racerLiveries.slice(0, 3) }
              : {}),
          },
        ]
      : []),
    ...(input.tv
      ? [
          {
            id: DOOR.tv,
            name: 'FF-TV',
            detail: 'watch live races',
            note: 'or the AI racers',
            picture: 'tv' as const,
          },
        ]
      : []),
  ]
  const quick = quickRaceCard(input)
  // DEV-879: the editor is the second table, so the arc is OPTIONS, EDITOR, QUICK RACE,
  // FLY, MULTIPLAYER, FF-TV: six, with FLY the right-middle one the resting look takes.
  return [
    optionsDoorCard(),
    ...(input.editor === true ? [editorDoorCard()] : []),
    ...(rest.length > 0 ? [quick, single, ...rest] : [single, quick]),
  ]
}

/**
 * The MULTIPLAYER step's tables: a link's JOIN ROOM first where there is one
 * (the press the link was sent for), then HOST A RACE and JOIN WITH A CODE.
 */
export const multiplayerCards = (input: DoorInput): readonly DoorCard[] => [
  ...(input.linkRoom === null
    ? []
    : [
        {
          id: DOOR.joinLink,
          name: 'Join Room',
          detail: `room ${input.linkRoom}`,
          note: input.roomNotice ?? 'from your link',
          accent: true,
          picture: 'ring' as const,
        },
      ]),
  {
    id: DOOR.host,
    name: 'Host a Race',
    detail: 'make a room',
    note: 'then send its code or link',
    picture: 'ring',
  },
  {
    id: DOOR.joinCode,
    name: 'Join with a Code',
    detail: 'the code a friend reads you',
    note: '',
    picture: null,
  },
  ...openRoomCards(input.openRooms ?? null),
]

/**
 * DEV-633: OPEN ROOMS, on the Multiplayer step after its own tables: a table
 * per public room (at most `OPEN_ROOM_TABLES`, lobbies first as the list
 * comes), pressed to join it; one table saying there are none; nothing while
 * the list is unknown. A racing room says so, and a full one: a press is then
 * refused by the room, and the lobby says why.
 */
export const openRoomCards = (rooms: readonly OpenRoomDoor[] | null): DoorCard[] => {
  if (rooms === null) return []
  if (rooms.length === 0) {
    return [
      {
        id: NO_OPEN_ROOMS_DOOR,
        name: 'Open Rooms',
        detail: 'none open right now',
        note: 'host one and make it public',
        picture: null,
      },
    ]
  }
  return rooms.slice(0, OPEN_ROOM_TABLES).map((r) => ({
    id: `${OPEN_ROOM_DOOR}${r.code}`,
    name: r.course ?? 'Open Room',
    detail: `${r.players} of ${r.seats} · room ${r.spoken}`,
    note: r.racing
      ? 'racing: join when it ends'
      : r.players >= r.seats
        ? 'full'
        : 'open: press to join',
    accent: !r.racing && r.players < r.seats,
    picture: 'ring' as const,
  }))
}

/** The tables of a door step. */
export const doorStepCards = (step: DoorStep, input: DoorInput): readonly DoorCard[] =>
  step === 'doors'
    ? doorCards(input)
    : step === 'options'
      ? [creditsDoorCard(input)]
      : step === 'credits'
        ? [creditsRollCard(input)]
        : multiplayerCards(input)

/**
 * What a press of door `id` does in the ROOM: descend to a step, or nothing
 * (the app acts on it: TV, a room, the letter plate, and since DEV-857 the
 * OPTIONS plate: OPTIONS no longer descends to a step of its own).
 */
export const doorDescends = (id: string): 'vehicles' | 'multiplayer' | 'credits' | null =>
  id === DOOR.single
    ? 'vehicles'
    : id === DOOR.multiplayer
      ? 'multiplayer'
      : id === DOOR.credits
        ? 'credits'
        : null
