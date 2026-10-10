// src/game/room-lobby.ts — a room's lobby and its start, as words and choices. DEV-389.
//
// plan/MULTIPLAYER.md §6.3 and §6.9. What a player reads and presses between
// joining a room and flying in it: the pad's banner while the room holds the
// start, and the lobby plates' rows (the seats, your colour, ready, the owner's
// course and START). Pure: the room session's plain values in, strings and
// row lists out, so every rule here is a node test. `render/room-lobby.ts`
// says where the plates stand; `boot/app.ts` presses the rows.

import { drawnHandle } from '@/game/room-names'
import {
  ROOM_CODE_SHAPE,
  type RoomPhase,
  type RoomPlayerView,
  type RoomRace,
  type RoomSettings,
  type RoomVerdict,
} from '@/net/room-protocol'
import type { PauseOption } from '@/render/pause'
import type { Srgb } from '@/render/racer-livery'

/**
 * The pad's banner while a room holds the start (§6.3 beat 2).
 *
 * WAITING FOR PLAYERS n/m while the room waits for everyone on the grid to be
 * loaded; GET READY once it has released the field (`goAt` known) and until
 * the countdown takes over the banner; null with no race (the plate then
 * says what it always says).
 */
export const roomWaitingText = (
  race: RoomRace | null,
  loaded: readonly number[],
  goAt: number | null,
): string | null => {
  if (!race) return null
  if (goAt !== null) return 'GET READY'
  const grid = Object.keys(race.starts).map(Number)
  const here = grid.filter((slot) => loaded.includes(slot)).length
  return `WAITING FOR PLAYERS ${here}/${grid.length}`
}

/**
 * §6.3 beat 3, asked on EVERY fixed step while the ship waits on its start:
 * does the room's countdown begin at this step, and how far into it is it?
 *
 * `stepRoom` is the room time this step stands for — the frame's room time
 * less what the fixed stepper has not spent yet (`clock.accumulator`, which
 * `stepFixed` has already taken this step out of). Null before the countdown's
 * first step. Otherwise the countdown's elapsed seconds BEFORE this step's own
 * `dt`, which `stepLaunch` adds in the same step: so the release is the first
 * step whose room time is at or past `goAt`, whatever the frame's timing —
 * within one fixed step of the room's GO on every client.
 *
 * Why per step and not per frame: a frame's steps stand for the time since the
 * LAST frame, so a countdown started at the frame (with the frame's lateness as
 * its spill) counted that stretch twice and let go up to a frame and a step
 * early (`room-lobby.test.ts` measures both).
 */
export const roomCountdownStep = (
  stepRoom: number,
  goAt: number,
  countdownMs: number,
  dt: number,
): number | null => {
  const begin = goAt - countdownMs
  return stepRoom >= begin ? (stepRoom - begin) / 1000 - dt : null
}

// ── Colours (§6.4): one a player, said in words ─────────────────────────────

/**
 * A palette colour's name, from its hue: the plates are text, so the colour a
 * player is choosing is said rather than shown. Read off the colour, never
 * listed beside the palette (hard rule 6: a palette edit renames itself).
 * Bands are the ordinary words' — orange 15–45°, yellow to 75°, green to 165°,
 * cyan to 200°, blue to 255°, violet to 330°, red either side of 0 — and a
 * colour with no saturation is white or grey.
 */
export const colourName = (c: Srgb): string => {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min
  if (chroma < 0.08) return max > 0.8 ? 'white' : 'grey'
  let hue: number
  if (max === r) hue = 60 * (((g - b) / chroma + 6) % 6)
  else if (max === g) hue = 60 * ((b - r) / chroma + 2)
  else hue = 60 * ((r - g) / chroma + 4)
  if (hue < 15 || hue >= 330) return 'red'
  if (hue < 45) return 'orange'
  if (hue < 75) return 'yellow'
  if (hue < 165) return 'green'
  if (hue < 200) return 'cyan'
  if (hue < 255) return 'blue'
  return 'violet'
}

/** The colours other PRESENT players hold (the room refuses them, §7.1 `colour-taken`). */
export const takenColours = (
  players: Readonly<Record<number, RoomPlayerView>>,
  self: number | null,
): Set<number> => {
  const out = new Set<number>()
  for (const [slot, p] of Object.entries(players)) {
    if (Number(slot) !== self && p.present) out.add(p.colour)
  }
  return out
}

/** The next colour after `current` that nobody else holds, wrapping; `current` when none is. */
export const nextFreeColour = (current: number, count: number, taken: ReadonlySet<number>) => {
  for (let step = 1; step < count; step++) {
    const c = (current + step) % count
    if (!taken.has(c)) return c
  }
  return current
}

/**
 * DEV-851: an Open Rooms card's course when the room races a stranger's own
 * course. Its two-word name rides only in the room's token, which the
 * directory does not list, so the card says what kind of course it is.
 */
export const PLAYER_COURSE_ROOM_LABEL = 'Player course'

/**
 * A course's name as the COURSE row says it: 2016's title less a trailing
 * vehicle ("Intermediate 1 - HoverJet" is "Intermediate 1"): every room course
 * is a HoverJet's, and the value column is narrow. Read off the card's own
 * vehicle, never a word typed here.
 */
export const courseName = (title: string, vehicle: string): string => {
  const parts = title.split(' - ')
  const last = parts.at(-1)?.trim().toLowerCase()
  return parts.length > 1 && last === vehicle.toLowerCase() ? parts.slice(0, -1).join(' - ') : title
}

/**
 * A room id as a plate says it: a short code (DEV-441b; seven characters since
 * DEV-458) as a three and a four, as a phone number is grouped, the way
 * one is read aloud (`K7Q X4MN`); a long id from an older link in capital fours.
 */
export const roomCodeText = (id: string): string =>
  ROOM_CODE_SHAPE.test(id)
    ? `${id.slice(0, 3)} ${id.slice(3)}`
    : (id.toUpperCase().match(/.{1,4}/g) ?? [id.toUpperCase()]).join(' ')

// ── The plates' rows ────────────────────────────────────────────────────────

/** What a press on the action plate can mean. `boot/app.ts` switches on these. */
export const LOBBY_ACTION = {
  course: 'course',
  /** DEV-391: the owner's Fill empty starts with bots (§6.6). */
  bots: 'bots',
  colour: 'colour',
  ready: 'ready',
  start: 'start',
  invite: 'invite',
  /** DEV-633: the owner's PUBLIC or PRIVATE. */
  listed: 'listed',
  /** DEV-436: a link to WATCH the room, through its broadcaster (§13.3). */
  spectate: 'spectate',
  /** DEV-480: WATCH ME, a Faceted Flight TV link that follows this player (no code, no names). */
  watchMe: 'watch-me',
  /** DEV-459: the owner's REMOVE A PLAYER, which turns the plate to one row per other player. */
  kick: 'kick',
  /** DEV-459: that page's way back to the room's rows. */
  kickBack: 'kick-back',
  leave: 'leave',
  /** The race is on; nothing to do but wait (or leave). */
  wait: 'wait',
} as const

export type LobbyActionId = (typeof LOBBY_ACTION)[keyof typeof LOBBY_ACTION]

/** Everything the plates say, as plain values off the session and the page. */
export interface LobbyInput {
  /** The socket: `game/room-client.ts`'s `RoomStatus`. */
  readonly status: string
  /** Why the room closed on this player, or null (`roomNotice`). */
  readonly notice: string | null
  readonly slot: number | null
  readonly owner: number | null
  readonly phase: RoomPhase | null
  readonly settings: RoomSettings | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly race: RoomRace | null
  readonly results: readonly RoomVerdict[]
  /** The course's name, or null while it is being read. */
  readonly courseName: string | null
  /** The palette's names, by index (`colourName` of each). */
  readonly colourNames: readonly string[]
  /** Why this page cannot be ready for the room's course, or null when it can. */
  readonly cannotRace: string | null
  /** The invite link was copied a moment ago. */
  readonly copied: boolean
  /** DEV-436: the watch link was copied a moment ago. */
  readonly copiedWatch?: boolean
  /**
   * DEV-480: the build has Faceted Flight TV (`gameplay.tv` on the menus'
   * preset): the WATCH ME row, under Spectators. Absent reads as no.
   */
  readonly tv?: boolean
  /**
   * DEV-480: WATCH ME's link as made a moment ago, the short form, the row
   * says it was copied (flat) or shows it (a headset, where nothing pastes),
   * or a reason it could not be made. Absent or null: nothing pressed lately.
   */
  readonly watchMe?: { readonly link: string | null; readonly shown: boolean } | null
  /**
   * DEV-441b: the room's short code, when its id is one: shown large on the
   * INVITE row, beside the link it copies, so a friend in a headset can type
   * it. Absent for a room joined by a long id from an older link.
   */
  readonly code?: string | null
  /**
   * DEV-632: what the invite row's press does with the link, by device: a
   * phone's SHARE (the system share sheet), a computer's COPY LINK. Absent:
   * INVITE, as before (a headset, where the link is copied for a browser
   * outside it and the code is the thing read aloud).
   */
  readonly invite?: 'share' | 'copy' | undefined
  /** DEV-632: the share sheet took the link a moment ago (`copied` is the clipboard's). */
  readonly shared?: boolean
  /**
   * DEV-634: the beat START pulses on once everyone is ready: true lights its
   * note in the accent, false dims it. The page's clock (`boot/app.ts`), so
   * this file stays pure. Absent reads as lit.
   */
  readonly pulse?: boolean
}

/** DEV-634: the words START says once every other player is ready. */
export const EVERYONE_READY_NOTE = 'Everyone is ready: press START'

/**
 * DEV-634: the owner's room is waiting on nobody but the owner's START: at
 * least one other player present, every one of them ready, and a press would
 * start (the owner's own ready included, DEV-587). Matt, 2026-10-04: *"i had a
 * hard time finding the button to start the match once everybody was ready."*
 */
export const lobbyEveryoneReady = (input: LobbyInput): boolean =>
  lobbyStartPress(input) !== null &&
  Object.values(input.players).filter((p) => p.present).length > 1

/**
 * DEV-633: whether a NEW room is listed in OPEN ROOMS. Private: a room is
 * found by its code or its link unless its owner says otherwise (the lead's
 * recommendation, and a call for Matt in `QUESTIONS-FOR-MATT.md`).
 */
export const ROOM_LISTED_DEFAULT = false

/** DEV-633: the owner's PUBLIC or PRIVATE row. */
export const lobbyListedRow = (listed: boolean): PauseOption => ({
  id: LOBBY_ACTION.listed,
  label: 'Room',
  value: listed ? 'public' : 'private',
  note: listed
    ? 'anyone can join from Open Rooms: press for private'
    : 'only your code or link gets in: press for public',
})

/** DEV-632: the invite row's label, by what its press does. */
export const inviteLabel = (invite: LobbyInput['invite']): string =>
  invite === 'share' ? 'Share' : invite === 'copy' ? 'Copy Link' : 'Invite'

/** DEV-632: the invite row's note, as the last press left it. */
export const inviteNote = (input: LobbyInput): string => {
  const read = input.code ? ', or read them the code' : ''
  if (input.shared) return 'link sent'
  if (input.copied) {
    return input.code
      ? 'link copied: send it, or read them the code'
      : 'link copied: send it to a friend'
  }
  if (input.invite === 'share') return `press to send the link${read}`
  if (input.invite === 'copy') return `press to copy the link${read}`
  return input.code ? 'read them the code, or press to copy the link' : 'press to copy the link'
}

/** The roster's footer: the room's code, which is also what the link carries. */
export const lobbyRosterFooter = (id: string): string => `room ${roomCodeText(id)}`

/**
 * The roster row the plate highlights: this player's own. The pause plate paints
 * its footer only while a row is selected ("look at an option" otherwise), so
 * the roster, which nobody presses, selects YOU, and its footer is the room's code.
 */
export const lobbyRosterSelected = (rows: readonly { id: string }[], slot: number | null) =>
  slot === null ? -1 : rows.findIndex((r) => r.id === `seat-${slot}`)

/** Seats before the owner has chosen a course: the Anniversary grid's six (§6.3). */
export const LOBBY_DEFAULT_SEATS = 6

const mine = (input: LobbyInput): RoomPlayerView | null =>
  input.slot === null ? null : (input.players[input.slot] ?? null)

/** The race is under way (or loading) rather than the room being in its lobby. */
export const lobbyRaceOn = (input: LobbyInput): boolean =>
  input.phase !== null && input.phase !== 'lobby'

/** Present players not ready yet. */
export const notReadyCount = (players: Readonly<Record<number, RoomPlayerView>>): number =>
  Object.values(players).filter((p) => p.present && !p.ready).length

/**
 * DEV-587: the OTHER present players not ready yet: what the owner's START
 * waits for. The owner is not counted, because START is the owner's ready.
 */
export const othersNotReady = (
  players: Readonly<Record<number, RoomPlayerView>>,
  slot: number | null,
): number =>
  Object.entries(players).filter(([key, p]) => Number(key) !== slot && p.present && !p.ready).length

/**
 * DEV-587: how many of the course's starts nobody in the room is on: the ones
 * AI racers fill when Bots is on (the room hands them out at START,
 * `net/room-server.ts`'s `#start`, by the same count).
 */
export const lobbyEmptyStarts = (input: LobbyInput): number => {
  const seats = input.settings?.seats ?? LOBBY_DEFAULT_SEATS
  const present = Object.values(input.players).filter((p) => p.present).length
  return Math.max(0, seats - present)
}

/**
 * DEV-587: what the owner's START press does now. Matt, 2026-10-03: *"can't
 * start the multiplayer room and have it fill empty seats with bots"*. Alone
 * in a room the owner was the one player START waited for, and the press did
 * nothing. Now a press by an owner who is not ready yet readies them and
 * starts (`'ready-and-start'`: the room is told READY, and START once it has
 * heard it), so one press races a room of one against AI racers. Null where
 * the press would start nothing: a guest, no course yet, another player not
 * ready, or a reason this page cannot be ready for the course.
 */
export const lobbyStartPress = (input: LobbyInput): 'start' | 'ready-and-start' | null => {
  if (input.status !== 'open' || lobbyRaceOn(input)) return null
  const me = mine(input)
  if (!me || input.slot !== input.owner || !input.settings) return null
  if (othersNotReady(input.players, input.slot) > 0) return null
  if (me.ready) return 'start'
  return input.cannotRace === null ? 'ready-and-start' : null
}

/** DEV-587: who flies the empty starts, as START's note ends it; null when nobody does. */
const fillWords = (input: LobbyInput): string | null => {
  const n = lobbyEmptyStarts(input)
  if (!input.settings?.bots || n === 0) return null
  return n === 1 ? 'an AI racer fills 1 start' : `AI racers fill ${n} starts`
}

/** The owner's START row's note: what a press does, or what it waits for. */
const startNote = (input: LobbyInput): string => {
  if (!input.settings) return 'choose a course first'
  const waiting = othersNotReady(input.players, input.slot)
  if (waiting > 0) return `waiting for ${waiting} to be ready`
  const me = mine(input)
  if (me && !me.ready && input.cannotRace !== null) return input.cannotRace
  const alone = Object.values(input.players).filter((p) => p.present).length <= 1
  const n = lobbyEmptyStarts(input)
  if (alone) {
    if (n === 0) return 'press to race'
    if (!input.settings.bots) return 'press to race on your own (Bots is off)'
    return n === 1
      ? 'press to race: an AI racer fills the empty start'
      : `press to race: AI racers fill the ${n} empty starts`
  }
  // DEV-634: the plain words, whether or not the owner had pressed READY,
  // and who fills the empty starts (DEV-587).
  const fill = fillWords(input)
  return fill ? `${EVERYONE_READY_NOTE}, ${fill}` : EVERYONE_READY_NOTE
}

/** The action plate's heading. */
export const lobbyHeading = (input: LobbyInput): string => {
  if (input.status === 'closed') return '- ROOM CLOSED -'
  if (lobbyRaceOn(input)) return '- RACE ON -'
  return '- ROOM -'
}

/** The action plate's rows, for whoever this player is in the room. */
export const lobbyActionRows = (input: LobbyInput): PauseOption[] => {
  const leave: PauseOption = {
    id: LOBBY_ACTION.leave,
    label: 'Leave',
    note: 'back to the hangar on your own',
  }
  if (input.status === 'closed') {
    return [{ ...leave, note: input.notice ?? 'the room closed' }]
  }
  const me = mine(input)
  if (!me || input.status !== 'open') {
    return [{ ...leave, note: input.status === 'retrying' ? 'reconnecting…' : 'connecting…' }]
  }
  if (lobbyRaceOn(input)) {
    const slots = input.race ? Object.keys(input.race.starts).map(Number) : []
    const out = slots.filter((s) => !input.results.some((r) => r.slot === s)).length
    return [
      {
        id: LOBBY_ACTION.wait,
        label: 'Waiting',
        note: out > 0 ? `${out} still flying` : 'the room is coming back',
      },
      { ...leave, note: 'leave the room' },
    ]
  }
  const owner = input.slot === input.owner
  const colour = input.colourNames[me.colour] ?? `colour ${me.colour + 1}`
  const rows: PauseOption[] = [
    {
      id: LOBBY_ACTION.course,
      label: 'Course',
      value:
        input.courseName !== null && input.settings?.course !== undefined
          ? `${input.courseName} · CUSTOM`
          : (input.courseName ?? (input.settings ? '…' : 'none yet')),
      note: owner ? 'press for the next course' : 'the owner chooses',
    },
    // DEV-633: the owner's PUBLIC or PRIVATE, under the course it lists.
    ...(owner ? [lobbyListedRow(input.settings?.listed === true)] : []),
    {
      id: LOBBY_ACTION.bots,
      label: 'Bots',
      value: input.settings?.bots ? 'on' : 'off',
      // DEV-587: what it does, in words, rather than the switch's name again.
      note: !owner
        ? 'the owner chooses'
        : input.settings?.bots
          ? 'AI racers fill the empty starts: press for none'
          : 'the empty starts stay empty: press for AI racers',
    },
    {
      id: LOBBY_ACTION.colour,
      label: 'Colour',
      value: colour,
      note: 'press for the next free colour',
    },
    {
      id: LOBBY_ACTION.ready,
      label: 'Ready',
      value: me.ready ? 'yes' : 'no',
      note:
        input.cannotRace ?? (me.ready ? 'press to stand down' : 'press when you are set to race'),
    },
  ]
  if (owner) {
    rows.push({
      id: LOBBY_ACTION.start,
      label: 'Start',
      note: startNote(input),
      // Lit when a press would start the race (DEV-587: the owner's own ready
      // included); once everyone is ready it PULSES on the page's beat (DEV-634).
      accentNote:
        lobbyStartPress(input) !== null && (!lobbyEveryoneReady(input) || input.pulse !== false),
    })
  }
  // DEV-459: the owner's way to remove a player, where there is one to remove.
  if (lobbyKickOffered(input)) {
    rows.push({
      id: LOBBY_ACTION.kick,
      label: 'Remove a Player',
      note: 'someone holding the room up? take them out of it',
    })
  }
  rows.push(
    input.code
      ? {
          id: LOBBY_ACTION.invite,
          label: inviteLabel(input.invite),
          // The code in the value column: label-sized, in the accent, the
          // thing a friend types (Multiplayer, Join with a Code).
          value: roomCodeText(input.code),
          note: inviteNote(input),
        }
      : {
          id: LOBBY_ACTION.invite,
          label: inviteLabel(input.invite),
          note: inviteNote(input),
        },
    {
      id: LOBBY_ACTION.spectate,
      label: 'Spectators',
      note: input.copiedWatch
        ? 'watch link copied: they see the race 2 s late'
        : 'press to copy a link to watch',
    },
    // DEV-480 (§2.1, §2.6): races here are on TV too, without names or the
    // code, said where the players read about spectators, and WATCH ME is
    // the link to send to anyone else.
    ...(input.tv ? [watchMeRow(input.watchMe ?? null)] : []),
    leave,
  )
  return rows
}

/** DEV-480: the WATCH ME row, as the last press left it. */
const watchMeRow = (made: LobbyInput['watchMe']): PauseOption => ({
  id: LOBBY_ACTION.watchMe,
  label: 'Watch Me',
  note:
    made === null || made === undefined
      ? 'on TV too, no names or code: press for your link'
      : made.link === null
        ? 'TV could not be reached for a link'
        : made.shown
          ? made.link
          : 'TV link copied: it follows you, no names',
})

// ── DEV-459: REMOVE A PLAYER (the owner's; the room enforces it) ────────────
//
// Matt, 2026-09-27: *"add a kick row"*. A page of the action plate, not a row
// per player on it: the owner's plate is eight rows without it, and five more
// would shrink every row past what a head can hold (`render/pause.ts`'s
// `rowBand`). So one row opens a page with a row per other player and Back.
// A press ARMS a row (*"press again to remove them"*), and a second press on
// the same row removes: a kick cannot be taken back, and the arrow that moves
// past a row on the way down must not fire it.

/** The page's heading. */
export const LOBBY_KICK_HEADING = '- REMOVE A PLAYER -'

/** The row that removes the player in `slot`. */
export const kickRowId = (slot: number): string => `kick-${slot}`

/** The slot a kick row names, or null for any other row. */
export const kickSlotOf = (id: string | undefined): number | null => {
  const m = /^kick-(\d+)$/.exec(id ?? '')
  return m ? Number(m[1]) : null
}

/** The other players present in the room, by slot. */
const others = (input: LobbyInput): Array<[number, RoomPlayerView]> =>
  Object.entries(input.players)
    .map(([key, p]) => [Number(key), p] as [number, RoomPlayerView])
    .filter(([slot, p]) => slot !== input.slot && p.present)
    .sort((a, b) => a[0] - b[0])

/**
 * Is REMOVE A PLAYER offered? To the owner, in the lobby (not in a race: the
 * room refuses one there, `room-server.ts`'s `#kick`), with somebody to remove.
 */
export const lobbyKickOffered = (input: LobbyInput): boolean =>
  input.status === 'open' &&
  input.slot !== null &&
  input.slot === input.owner &&
  !lobbyRaceOn(input) &&
  others(input).length > 0

/** The page's rows: one per other player, `armed` asking for its second press, then Back. */
export const lobbyKickRows = (input: LobbyInput, armed: number | null): PauseOption[] => [
  ...others(input).map(([slot, p]) => ({
    id: kickRowId(slot),
    label: drawnHandle(p.handle, slot),
    ...(armed === slot ? { value: 'sure?' } : {}),
    note: armed === slot ? 'press again to remove them' : 'press twice to remove them',
    accentNote: armed === slot,
  })),
  { id: LOBBY_ACTION.kickBack, label: 'Back', note: 'to the room' },
]

/** The roster's heading: how full the room is. */
export const lobbyRosterHeading = (input: LobbyInput): string => {
  const seats = input.settings?.seats ?? LOBBY_DEFAULT_SEATS
  const present = Object.values(input.players).filter((p) => p.present).length
  return `- PLAYERS ${present}/${seats} -`
}

/** A verdict as the roster says it in the race: a time, or why there is none. */
const standingWord = (input: LobbyInput, slot: number): string => {
  const r = input.results.find((x) => x.slot === slot)
  if (!r) return input.race && input.race.starts[slot] !== undefined ? 'flying' : ''
  if (r.verdict === 'ok' && r.seconds !== null) return `${r.seconds.toFixed(2)}s`
  return r.verdict === 'left' ? 'left' : 'dnf'
}

/**
 * The roster's rows: every seat of the room's grid, players first by slot,
 * then the open seats. Read, not pressed.
 */
export const lobbyRosterRows = (input: LobbyInput): PauseOption[] => {
  const seats = input.settings?.seats ?? LOBBY_DEFAULT_SEATS
  const raceOn = lobbyRaceOn(input)
  const rows: PauseOption[] = Object.entries(input.players)
    .map(([key, p]) => [Number(key), p] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([slot, p]) => ({
      id: `seat-${slot}`,
      label: drawnHandle(p.handle, slot),
      value: raceOn ? standingWord(input, slot) : p.ready ? 'ready' : '',
      note: [
        input.colourNames[p.colour] ?? `colour ${p.colour + 1}`,
        p.variant !== 'standard' ? p.variant : null,
        slot === input.owner ? 'owner' : null,
        slot === input.slot ? 'you' : null,
        p.present ? null : 'reconnecting',
      ]
        .filter((w): w is string => w !== null)
        .join(' · '),
      accentNote: slot === input.slot,
    }))
  for (let i = rows.length; i < seats; i++) {
    rows.push({
      id: `open-${i}`,
      label: 'Open seat',
      note: input.settings?.bots ? 'an AI racer flies it' : 'send the invite to fill it',
    })
  }
  return rows
}
