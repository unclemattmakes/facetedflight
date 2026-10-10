// src/net/room-protocol.ts — the wire between a room and its players. DEV-386.
//
// `plan/MULTIPLAYER.md` §7 is the design; this file is its executable form, and
// the ONLY contract between the game and the rooms Worker (§6.5): the Durable
// Object imports this and `room-server.ts`, and nothing else of the game. So:
//
//   - no game numbers. The room never learns a tick length, a speed, a course
//     or a grid. What it must enforce that content decides — how many seats,
//     how many colours, how long a countdown — the room OWNER's client reads
//     off content and sends in `configure`, and the room only bounds it;
//   - `ROOM_PROTOCOL` is bumped by ANY change to a message here or to the pose
//     layout in `pose-codec.ts`. All of preview shares one rooms Worker, so two
//     branches with different protocols meet there, and 4002 is what keeps them
//     apart (§6.8).
//
// SERVER-SAFE and pure: no DOM, no three, no clock, no randomness. Checked by
// `tests/unit/sim-purity-guard.test.ts`, which guards the room modules too.
//
// Its one import is `./validate-kit`: pure, no imports of its own, so the
// Worker still reaches nothing of the game.

import { isHandle } from './handles'
import { isRecord } from './validate-kit'

/**
 * Bumped by any wire change. A `join` carrying another value is closed 4002.
 *
 * 2 (DEV-390): `settings.timeLimit`, `RoomVerdict.variant`, the `dnf` and
 * `left` verdicts and `results.bots`. The Worker must be redeployed with it
 * (docs/rooms.md); until then a protocol-2 client meets a protocol-1 room and
 * is told to update, which is the check working.
 *
 * 3 (DEV-389): the lobby's after-race. `again` takes a settled race back to
 * the lobby, `forfeit` gives up a race at once (a `left` verdict now, not after
 * the rejoin window), and `lobby` carries the room's `phase` so a client hears
 * the race end. The Worker must be redeployed with it, as for 2.
 *
 * 4 (DEV-436): the broadcaster — the room's feed (`keyframe`, the batch) and
 * the viewer's `watch`, at the end of this file. Redeploy, as for 2 and 3.
 *
 * 5 (DEV-441b): short join codes. A room's id may be a six-character code
 * (`ROOM_CODE_SHAPE`, which `ROOM_ID_SHAPE` now admits beside the long id),
 * and `join.existing` asks for a room somebody is IN — a code typed by hand —
 * which the room refuses 4004 when nobody is. Redeploy, as for 2 to 4: the
 * Worker checks the id's shape itself (`admitRoomUpgrade`, on connect).
 *
 * 6 (DEV-458, DEV-459): codes are SEVEN characters (Matt, 2026-09-27: *"7
 * characters"*), so the id's shape changed again; and the owner's `kick`,
 * which closes a player `CLOSE.kicked` and keeps their seat token and their
 * PAGE (`join.page`) out for the life of the room. Redeploy, as for 2 to 5.
 *
 * 7 (DEV-477): where a seat STARTS. `RoomRace.row` (a place on DEV-389's human
 * row) is gone; `RoomRace.starts` hands each person an index into the course's
 * start list — single player's, the player's pad first (`game/racer-grid.ts`'s
 * `roomStarts`) — and `RoomBot.start` indexes the SAME list, so a bot never
 * shares a person's start. `RoomSeat.start` tells the judge which. A protocol-6
 * client would stand a person on the row while this room's judge expects the
 * racers' start, so the two must not meet. Redeploy, as for 2 to 6.
 *
 * 8 (DEV-633): PUBLIC rooms. `RoomSettings.listed` puts a room in the
 * directory (`room-directory.ts`, the rooms class under `ROOM_DIRECTORY_NAME`)
 * that `GET /api/rooms` lists. A protocol-7 room would drop the flag and list
 * nothing, so the two must not meet. Redeploy, as for 2 to 7.
 *
 * 9 (DEV-850): a `join`'s handle must be one the game GENERATES
 * (`handles.ts`'s `isHandle`); free text is refused as malformed. A
 * protocol-8 room admits any 40 letters, so it must not meet a build that
 * assumes it does not. Redeploy, as for 2 to 8.
 *
 * 10 (DEV-851): a room may race a PLAYER'S course. `RoomSettings.course`
 * carries its link token beside a `pc_` mission id, a `configure` that carries
 * one may run to `ROOM_CONFIGURE_TEXT_MAX`, and `RoomSeat.course` hands the
 * token to the judge, which rebuilds the course itself (`net/room-course.ts`).
 * A protocol-9 room would drop the token, so the two must not meet. Redeploy,
 * as for 2 to 9.
 */
export const ROOM_PROTOCOL = 10

// ── Close codes (§7.1). The client stops retrying on every one of them. ─────

export const CLOSE = {
  /** Every seat is taken. */
  full: 4000,
  /** The race has started: no mid-race joins (§6.9). */
  started: 4001,
  /** Another protocol, rules or content: "update your game" (§6.8). */
  mismatch: 4002,
  /** Over the rate or size cap (§6.10). */
  abuse: 4003,
  /** No such room, or an expired short code. */
  missing: 4004,
  /** This seat was taken over by a newer connection presenting its token. */
  replaced: 4005,
  /** The first message was not a `join`, or a message was not understood. */
  protocol: 4006,
  /** The page's Origin is not one of the game's (§6.10). */
  forbidden: 4007,
  /**
   * DEV-459: the room's owner removed this player (`kick`), or this page or
   * seat was removed earlier and is kept out for the life of the room.
   */
  kicked: 4008,
} as const

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE]

// ── Limits (§6.10). Abuse bounds, not game numbers. ─────────────────────────

/**
 * The most seats a room may be configured with. The GAME's number is the
 * course grid's starts (six on Anniversary, §6.3), sent by the owner in
 * `configure.seats`; this is only the ceiling a forged `configure` cannot pass.
 * Eight seats (§11 call 11) is content; sixteen would be a code change.
 */
export const ROOM_MAX_SEATS = 16
/** The most colours a palette may offer. One colour a craft, so >= seats. */
export const ROOM_MAX_COLOURS = 32
/** Sustained messages a second one connection may send: twice the pose rate. */
export const ROOM_RATE_PER_SECOND = 40
/**
 * The bucket's depth: a join's clock-sync burst plus a reconnect's replayed
 * events arrive together, and must not read as a flood.
 */
export const ROOM_RATE_BURST = 60
/** The largest text message: the lap goes to the judge by HTTP, never here. */
export const ROOM_TEXT_MAX = 4096
/** The longest course token a room carries (DEV-851): a link at its 128-prop cap measures ~4,900. */
export const ROOM_COURSE_MAX_CHARS = 8192
/**
 * DEV-851: the one text message allowed past `ROOM_TEXT_MAX`, a `configure`
 * carrying a course token. Any other message that long is still `size`.
 */
export const ROOM_CONFIGURE_TEXT_MAX = ROOM_TEXT_MAX + ROOM_COURSE_MAX_CHARS
/** How long a departed racer's seat is held for a reconnect (§6.9). */
export const ROOM_REJOIN_MS = 30_000
/** How long the start barrier waits for a straggler (king-tide's 25 s, §6.3). */
export const ROOM_LOAD_TIMEOUT_MS = 25_000
/**
 * Room-time margin between `start` leaving the room and the countdown's first
 * beat: carries the slowest link's one-way latency, so every client has
 * `goAt` before `goAt − countdown` (§6.3's "≈ countdown + 1 s").
 */
export const ROOM_START_MARGIN_MS = 1000
/** The longest countdown a room will schedule: a forged `configure` cannot park the grid. */
export const ROOM_MAX_COUNTDOWN_MS = 10_000
/**
 * A pose record whose position moved further than this since the sender's
 * last record is dropped (§6.10's coarse check). Millimetres, and generous on
 * purpose: past any course and any crash reset, so it only ever catches
 * garbage. The room does not judge positions; the judged lap is the result.
 */
export const ROOM_POSE_JUMP_MM = 10_000_000

// ── The pose message (§7.2) — the room's view of it. The codec is `pose-codec.ts`. ──

/** One pose message every this many fixed ticks: 81.967 / 4 = 20.49 Hz. THE cost lever (§6.2). */
export const POSE_SEND_TICKS = 4
/** The pose message's tag byte. A NEW tag for any change of record size (king-tide's rule). */
export const POSE_TAG_V1 = 0x10
export const POSE_HEADER_BYTES = 8
export const POSE_RECORD_BYTES = 36
/** Byte offsets the ROOM reads or writes. The rest is the codec's. */
export const POSE_AT = {
  tag: 0,
  slot: 1,
  count: 2,
  tick: 4,
  kind: 0,
  index: 1,
  position: 4,
} as const
/** A record's `kind`: the sender's own ship, or one of the bot host's bots. */
export const POSE_KIND = { own: 0, bot: 1 } as const

/** The largest pose message a room with `seats` seats will forward. */
export const poseMessageMax = (seats: number): number =>
  POSE_HEADER_BYTES + POSE_RECORD_BYTES * seats

// ── Lobby keep-alive (§6.2) ─────────────────────────────────────────────────

/**
 * A fixed request/response the PLATFORM answers without waking the Durable
 * Object (`setWebSocketAutoResponse`), so an idle lobby costs no duration and
 * no billed message wakes it. Clock sync, which needs the room's time, is a
 * `ping` and is never sent at 1 Hz in the lobby.
 */
export const ROOM_KEEPALIVE = { request: 'ka', response: 'ka!' } as const

// ── Shapes ──────────────────────────────────────────────────────────────────

/** A mission, edition or variant id: what `content/` names things by. */
export const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/
/** A lap rules string, `lapRules()`'s output (`1.28a93c83`). */
export const RULES_SHAPE = /^[0-9a-z.]{1,32}$/
/** The content digest: hex of the generated-content manifest's SHA-256, or a prefix of it. */
export const CONTENT_SHAPE = /^[0-9a-f]{8,64}$/
/**
 * DEV-441b: a room's SHORT code — what a player reads off a friend's plate and
 * types on a letter plate in a headset. It IS the room's id, so the Durable
 * Object's name, and there is no directory to map it to anything.
 *
 * The alphabet has no look-alikes (no 0/O, 1/I/L) and NO VOWELS (A, E, U go
 * too, so no code spells a word on a friend's screen): 8 digits and 20
 * consonants. SEVEN of them since DEV-458 (Matt: *"7 characters"*; DEV-441b
 * had six): 28^7 = 13,492,928,512 codes. `DEVIATIONS.md` DEV-458 has what
 * that means for guessing a live room.
 */
export const ROOM_CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ'
/** Characters in a room code. */
export const ROOM_CODE_LENGTH = 7
/** A room code, canonical: capitals, no separator. `ROOM_CODE_ALPHABET`, spelled as a class. */
export const ROOM_CODE_SHAPE = /^[2-9BCDFGHJKMNPQRSTVWXYZ]{7}$/
/**
 * A room id: >= 10 base32 characters (§6.9, the long id every room had until
 * DEV-441b, and which a link made before it still carries), or a short code.
 * A SIX-character code (DEV-441b's) is not one any more: a room lives only
 * while somebody is in it, and every client that could be in one speaks
 * protocol 5, which a protocol-6 room refuses anyway (DEV-458).
 */
export const ROOM_ID_SHAPE = /^(?:[a-z2-7]{10,32}|[2-9BCDFGHJKMNPQRSTVWXYZ]{7})$/
/**
 * DEV-851: a player course's mission id is `pc_` and twelve hex digits
 * (`content/player-course.ts`'s `playerCourseId`), and its course arrives as a
 * LINK token (`ffc1.` and base64url, `player-course-wire.ts`). The room checks
 * these shapes and nothing more: whether the token IS that course is the
 * judge's question and every client's, never the room's.
 */
export const PLAYER_COURSE_MISSION = /^pc_[0-9a-f]{12}$/
export const ROOM_COURSE_SHAPE = /^ffc1\.[A-Za-z0-9_-]+$/
/** A seat token: base64url, 128 bits or more. */
export const SEAT_SHAPE = /^[A-Za-z0-9_-]{22,64}$/

// ── The room's state ────────────────────────────────────────────────────────

export type RoomPhase = 'lobby' | 'loading' | 'countdown' | 'racing' | 'results'

/** What the owner configures, frozen at `start` (§6.8). */
export interface RoomSettings {
  readonly mission: string
  readonly edition: string
  /** Fill the empty starts with bots (§6.6). */
  readonly bots: boolean
  /** The course grid's starts, read off content by the owner (§6.3). */
  readonly seats: number
  /** The palette's size including the player's orange (§6.4). */
  readonly colours: number
  /** The launch countdown in ms: `(countdownSteps + 1) × countdownStepSeconds` (four beats). */
  readonly countdown: number
  /**
   * The course's own time limit in ms (`level.timer.timeLimit`), or 0 for none.
   * A racer with no judged lap when it runs out (plus `ROOM_JUDGE_GRACE_MS`
   * for the lap to reach the judge) is DNF (§6.5).
   */
  readonly timeLimit: number
  /**
   * `lapRules(mission, edition, variant)` for every variant the owner's build
   * flies on this course. A player's `ready` must carry the same string for
   * ITS variant, or it flew other rules (4002).
   */
  readonly rules: Readonly<Record<string, string>>
  /**
   * DEV-633: the room is PUBLIC: listed in the hangar's OPEN ROOMS
   * (`room-directory.ts`). Absent or false is PRIVATE, its code and link the
   * only ways in. The one setting a change of which readies nobody down.
   */
  readonly listed?: boolean
  /**
   * DEV-851: the course's link token when `mission` is a player course's `pc_`
   * id, and absent otherwise. Every client builds the course from it, and the
   * judge rebuilds it to time each lap.
   */
  readonly course?: string
}

/** A player as every client sees them. */
export interface RoomPlayerView {
  readonly handle: string
  readonly variant: string
  readonly colour: number
  readonly ready: boolean
  readonly joinSeq: number
  /** False while a racer's seat is held for a reconnect. */
  readonly present: boolean
}

/** A bot filling an empty start (§6.6): its start (an index into the course's start list) and its colour. */
export interface RoomBot {
  readonly index: number
  /** DEV-477: an index into the course's start list, as `RoomRace.starts` is; never a person's. */
  readonly start: number
  readonly colour: number
}

/** The race as frozen by the owner's START. */
export interface RoomRace {
  readonly mission: string
  readonly edition: string
  /**
   * DEV-477: slot -> its START, an index into the course's start list (the
   * player's pad, then the racers' own: `game/racer-grid.ts`'s `roomStarts`).
   * The people hold the first ones, one each, in a seeded shuffle; the bots
   * the rest. Every racing slot is a key: this is also the race's cohort.
   */
  readonly starts: Readonly<Record<number, number>>
  readonly bots: readonly RoomBot[]
  /** slot -> colour, as frozen. */
  readonly colours: Readonly<Record<number, number>>
}

/** The judge's verdict on one lap, or the room's own DNF (§6.5). */
export interface RoomVerdict {
  readonly slot: number
  /**
   * `ok`; the `validateLap` stage that refused it (`room` for a lap of another
   * race); or the room's `dnf` (the time limit ran out first) or `left` (the
   * seat was not reclaimed within `ROOM_REJOIN_MS`).
   */
  readonly verdict: string
  readonly ticks: number | null
  readonly seconds: number | null
  readonly rings: number
  readonly ringsTotal: number
  readonly score2016: number | null
  /** The client's own word: autopilot or a gameplay switch touched the run (§11 call 6). */
  readonly tainted: boolean
  /** The aircraft variant the lap was judged in (§11 call 7). */
  readonly variant: string
}

/** What the room says about a seat token: the race a lap from that seat must have been flown in. */
export interface RoomSeat {
  readonly slot: number
  readonly mission: string
  readonly edition: string
  readonly variant: string
  /** `settings.rules[variant]`: the rules string the lap must carry. */
  readonly rules: string
  /**
   * DEV-477: where this seat STARTED — its index into the course's start list
   * (`RoomRace.starts[slot]`) — so the judge accepts a lap whose first pose is
   * on that start, and on no other (`net/room-lap.ts`'s `roomSeatStart`).
   */
  readonly start?: number
  /** DEV-851: the race's course token when its mission is a player course. */
  readonly course?: string
}

/** A bot's finish, as the bot host reported it (§6.6: not judged, marked as a bot). */
export interface RoomBotFinish {
  readonly bot: number
  readonly tick: number
}

/** After the time limit, how long the room still waits for a lap to reach the judge, ms. */
export const ROOM_JUDGE_GRACE_MS = 15_000
/** The longest time limit a room will take, ms: an hour; a forged one cannot park the room. */
export const ROOM_MAX_TIME_LIMIT_MS = 3_600_000

// ── Client -> room (§7.1) ───────────────────────────────────────────────────

export interface JoinMessage {
  readonly type: 'join'
  readonly protocol: number
  readonly handle: string
  readonly variant: string
  readonly colour: number
  /** The generated-content digest this build was made from (§6.7). */
  readonly content: string
  /** A seat token from an earlier `hello`, to take that seat back (§6.9). */
  readonly seat?: string
  /**
   * DEV-441b: join only a room somebody is in. Sent for a code TYPED by hand,
   * so a typo is told "no room with that code" (4004) rather than seated alone
   * in a new room of that name. A link, which is the room, leaves it out.
   */
  readonly existing?: boolean
  /**
   * DEV-459: this PAGE's own token (a tab's, kept across its reloads), sent
   * on every join. A page the owner removed is refused by it (`CLOSE.kicked`)
   * even when it comes back with no seat token, as a fresh join.
   */
  readonly page?: string
}
export interface PingMessage {
  readonly type: 'ping'
  readonly t0: number
}
export interface ReadyMessage {
  readonly type: 'ready'
  readonly ready: boolean
  readonly colour?: number
  readonly variant?: string
  /** `lapRules` for the room's course and edition and this player's variant. */
  readonly rules?: string
}
export interface ConfigureMessage {
  readonly type: 'configure'
  readonly settings: RoomSettings
}
export interface StartMessage {
  readonly type: 'start'
}
export interface LoadedMessage {
  readonly type: 'loaded'
}
export interface RingMessage {
  readonly type: 'ring'
  readonly gate: number
  readonly tick: number
}
export interface ResetMessage {
  readonly type: 'reset'
  readonly tick: number
  readonly kind: string
}
export interface PropMessage {
  readonly type: 'prop'
  readonly id: string
  readonly tick: number
}
export interface FinishMessage {
  readonly type: 'finish'
  readonly tick: number
  readonly bot?: number
}
/**
 * DEV-389: back to the lobby. Heard only once the race is SETTLED (every racer
 * in the race has a verdict, phase `results`); the first one takes the whole
 * room back, keeping its players, settings and colours, with nobody ready.
 */
export interface AgainMessage {
  readonly type: 'again'
}
/**
 * DEV-459: the OWNER removes the player in `slot` from the room — in the
 * lobby only. The room closes them `CLOSE.kicked`, frees their seat, and keeps
 * their seat token and their page out for the life of the room. From anyone
 * else, or during a race, it is an `error` and nothing moves.
 */
export interface KickMessage {
  readonly type: 'kick'
  readonly slot: number
}
/**
 * DEV-389: this racer gives up the race it is in (the pause plate's EXIT, or
 * LEAVE): a `left` verdict at once, so nobody waits out the rejoin window for a
 * player who said they were going.
 */
export interface ForfeitMessage {
  readonly type: 'forfeit'
}

export type ClientMessage =
  | JoinMessage
  | PingMessage
  | ReadyMessage
  | ConfigureMessage
  | StartMessage
  | LoadedMessage
  | RingMessage
  | ResetMessage
  | PropMessage
  | FinishMessage
  | AgainMessage
  | ForfeitMessage
  | KickMessage

// ── Room -> client ──────────────────────────────────────────────────────────

export interface HelloMessage {
  readonly type: 'hello'
  readonly protocol: number
  readonly slot: number
  readonly joinSeq: number
  /** This player's secret: proves a lap POST and a reconnect come from this seat. */
  readonly seat: string
  readonly owner: number | null
  readonly phase: RoomPhase
  readonly settings: RoomSettings | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly race: RoomRace | null
  /** The field's GO in room ms, once released. */
  readonly goAt: number | null
  /** Per-slot GO for any racer released late (§6.3). */
  readonly goAts: Readonly<Record<number, number>>
  readonly results: readonly RoomVerdict[]
  readonly bots: readonly RoomBotFinish[]
}
export interface PongMessage {
  readonly type: 'pong'
  readonly t0: number
  readonly room: number
}
export interface PlayerJoinedMessage {
  readonly type: 'player-joined'
  readonly slot: number
  readonly player: RoomPlayerView
  readonly owner: number | null
}
export interface PlayerLeftMessage {
  readonly type: 'player-left'
  readonly slot: number
  /** Present when ownership moved (§7.1). */
  readonly owner: number | null
  /** True when the seat is held for a reconnect rather than freed. */
  readonly held: boolean
}
export interface LobbyMessage {
  readonly type: 'lobby'
  readonly owner: number | null
  readonly settings: RoomSettings | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  /** DEV-389: the room's phase; `lobby` after a race is the race over (`again`). */
  readonly phase: RoomPhase
}
/**
 * The owner pressed START: board the course (§6.3 beat 1), then the roll call
 * as each player sends `loaded` (beat 2). Carries the frozen race, because a
 * client needs its start (DEV-477) BEFORE `start` arrives: it is standing on it.
 */
export interface LoadingMessage {
  readonly type: 'loading'
  readonly race: RoomRace
  readonly loaded: readonly number[]
  /** Room ms after which the barrier stops waiting. */
  readonly deadline: number
}
export interface RoomStartMessage {
  readonly type: 'start'
  /** THIS client's GO, in room ms. Its countdown begins at `goAt − settings.countdown`. */
  readonly goAt: number
  /**
   * The field's GO. Equal to `goAt` except for a racer released late (§6.3),
   * who needs the field's to place everyone else's ticks on the shared clock.
   */
  readonly field: number
  /** Per-slot GO for every racer released late, the one exception to `field`. */
  readonly goAts: Readonly<Record<number, number>>
  readonly race: RoomRace
}
/** A racer who loaded after the field was released got their own GO (§6.3). */
export interface LateMessage {
  readonly type: 'late'
  readonly slot: number
  readonly goAt: number
}
export interface RelayedRing extends RingMessage {
  readonly slot: number
}
export interface RelayedReset extends ResetMessage {
  readonly slot: number
}
export interface RelayedProp extends PropMessage {
  readonly slot: number
}
export interface RelayedFinish extends FinishMessage {
  readonly slot: number
}
export interface ResultsMessage {
  readonly type: 'results'
  readonly results: readonly RoomVerdict[]
  readonly bots: readonly RoomBotFinish[]
}
export interface ErrorMessage {
  readonly type: 'error'
  readonly code: string
  readonly reason: string
}

export type ServerMessage =
  | HelloMessage
  | PongMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | LobbyMessage
  | LoadingMessage
  | RoomStartMessage
  | LateMessage
  | RelayedRing
  | RelayedReset
  | RelayedProp
  | RelayedFinish
  | ResultsMessage
  | ErrorMessage

// ── Parsing a client's text (the room trusts nothing) ───────────────────────

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
const isStr = (v: unknown, shape: RegExp): v is string => typeof v === 'string' && shape.test(v)

/** The largest tick an event may carry: a day at 82 Hz, far past any time limit. */
const TICK_MAX = 0xffffffff
/** A prop id is `<pass>:<index>` (§6.7). */
const PROP_SHAPE = /^[0-9]{1,4}:[0-9]{1,7}$/
/** A reset's kind: `crash`, `boundary`, `restart`, or a later one. */
const RESET_SHAPE = /^[a-z]{1,16}$/

const parseSettings = (v: unknown): RoomSettings | null => {
  if (!isRecord(v)) return null
  const { mission, edition, bots, seats, colours, countdown, timeLimit, rules, listed, course } = v
  if (!isStr(mission, ID_SHAPE) || !isStr(edition, ID_SHAPE)) return null
  // DEV-851: a player course's id comes with its token, and only its id does.
  const player = PLAYER_COURSE_MISSION.test(mission)
  const token =
    typeof course === 'string' &&
    course.length <= ROOM_COURSE_MAX_CHARS &&
    ROOM_COURSE_SHAPE.test(course)
      ? course
      : null
  if (player ? token === null : course !== undefined) return null
  if (typeof bots !== 'boolean') return null
  if (!isInt(seats, 1, ROOM_MAX_SEATS)) return null
  if (!isInt(colours, seats, ROOM_MAX_COLOURS)) return null
  if (!isInt(countdown, 0, ROOM_MAX_COUNTDOWN_MS)) return null
  if (!isInt(timeLimit, 0, ROOM_MAX_TIME_LIMIT_MS)) return null
  if (!isRecord(rules)) return null
  const entries = Object.entries(rules)
  if (entries.length === 0 || entries.length > 16) return null
  const out: Record<string, string> = {}
  for (const [variant, r] of entries) {
    if (!ID_SHAPE.test(variant) || !isStr(r, RULES_SHAPE)) return null
    out[variant] = r
  }
  if (listed !== undefined && typeof listed !== 'boolean') return null
  const settings = { mission, edition, bots, seats, colours, countdown, timeLimit, rules: out }
  const withListed = listed === undefined ? settings : { ...settings, listed }
  return token === null ? withListed : { ...withListed, course: token }
}

/**
 * A client's text message, or null. Only the types a CLIENT may send are
 * accepted: a `results` or a verdict arriving on a socket is not a message
 * (§6.5 — a verdict counts only through the binding, `RoomServer.verdict`).
 */
export const parseClientMessage = (text: string): ClientMessage | null => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  switch (v.type) {
    case 'join': {
      const { protocol, handle, variant, colour, content, seat, existing, page } = v
      if (!isInt(protocol, 0, 0xffff)) return null
      // DEV-850 (S-07): a name is generated, never typed. The room checks the
      // game's own lists, so a modified client cannot put text in a room.
      if (!isHandle(handle) || !isStr(variant, ID_SHAPE)) return null
      if (!isInt(colour, 0, ROOM_MAX_COLOURS - 1) || !isStr(content, CONTENT_SHAPE)) return null
      if (seat !== undefined && !isStr(seat, SEAT_SHAPE)) return null
      if (existing !== undefined && typeof existing !== 'boolean') return null
      if (page !== undefined && !isStr(page, SEAT_SHAPE)) return null
      return {
        type: 'join',
        protocol,
        handle,
        variant,
        colour,
        content,
        ...(seat === undefined ? {} : { seat }),
        ...(existing === true ? { existing } : {}),
        ...(page === undefined ? {} : { page }),
      }
    }
    case 'ping':
      return typeof v.t0 === 'number' && Number.isFinite(v.t0) ? { type: 'ping', t0: v.t0 } : null
    case 'ready': {
      const { ready, colour, variant, rules } = v
      if (typeof ready !== 'boolean') return null
      if (colour !== undefined && !isInt(colour, 0, ROOM_MAX_COLOURS - 1)) return null
      if (variant !== undefined && !isStr(variant, ID_SHAPE)) return null
      if (rules !== undefined && !isStr(rules, RULES_SHAPE)) return null
      return {
        type: 'ready',
        ready,
        ...(colour === undefined ? {} : { colour }),
        ...(variant === undefined ? {} : { variant }),
        ...(rules === undefined ? {} : { rules }),
      }
    }
    case 'configure': {
      const settings = parseSettings(v.settings)
      return settings ? { type: 'configure', settings } : null
    }
    case 'start':
      return { type: 'start' }
    case 'loaded':
      return { type: 'loaded' }
    case 'again':
      return { type: 'again' }
    case 'forfeit':
      return { type: 'forfeit' }
    case 'kick':
      return isInt(v.slot, 0, ROOM_MAX_SEATS - 1) ? { type: 'kick', slot: v.slot } : null
    case 'ring':
      return isInt(v.gate, 0, 0xffff) && isInt(v.tick, 0, TICK_MAX)
        ? { type: 'ring', gate: v.gate, tick: v.tick }
        : null
    case 'reset':
      return isInt(v.tick, 0, TICK_MAX) && isStr(v.kind, RESET_SHAPE)
        ? { type: 'reset', tick: v.tick, kind: v.kind }
        : null
    case 'prop':
      return isStr(v.id, PROP_SHAPE) && isInt(v.tick, 0, TICK_MAX)
        ? { type: 'prop', id: v.id, tick: v.tick }
        : null
    case 'finish': {
      if (!isInt(v.tick, 0, TICK_MAX)) return null
      if (v.bot === undefined) return { type: 'finish', tick: v.tick }
      return isInt(v.bot, 0, ROOM_MAX_SEATS - 1)
        ? { type: 'finish', tick: v.tick, bot: v.bot }
        : null
    }
    default:
      return null
  }
}

// ── Admission: the Origin check both routes share (§6.2, §6.10) ─────────────

/**
 * Whether a WebSocket upgrade from `origin` may reach a room served at
 * `requestUrl`. WebSockets have no CORS, so this is the whole of it. A page
 * connects to its OWN origin through the Pages Function (§6.2), so
 * same-origin is always admitted; `allowed` is the extra list the Worker's
 * direct `workers.dev` route needs (a regex source, from the Worker's
 * `ROOM_ORIGINS` var). A missing Origin is refused: every browser sends one.
 */
export const originAdmitted = (
  origin: string | null,
  requestUrl: string,
  allowed: string | undefined,
): boolean => {
  if (!origin) return false
  let self: string
  try {
    self = new URL(requestUrl).origin
  } catch {
    return false
  }
  if (origin === self) return true
  if (!allowed) return false
  try {
    return new RegExp(allowed).test(origin)
  } catch {
    return false
  }
}

/**
 * The room id out of `/api/room/<id>`, or null. The same path on both routes,
 * so the client reads the room URL from one function (§6.2).
 */
export const roomIdFromPath = (pathname: string): string | null => {
  const m = /^\/api\/room\/([^/]+)\/?$/.exec(pathname)
  const id = m?.[1]
  return id !== undefined && ROOM_ID_SHAPE.test(id) ? id : null
}

/** What both routes decide before a request may reach a room. */
export type RoomAdmission =
  | { readonly ok: true; readonly id: string; readonly url: string }
  | { readonly ok: false; readonly status: number; readonly reason: string }

/**
 * The gate both routes share — the Pages Function (`functions/api/room/[id].ts`)
 * and the Worker's own `fetch` (the `workers.dev` fallback, §6.2): a room id of
 * the right shape, a WebSocket upgrade and nothing else (so no HTTP request
 * from outside ever reaches the object's `onRequest`), and an admitted Origin.
 *
 * `url` is the request's URL with partyserver's `_pk` removed: a client may
 * NOT choose its connection id, so no client can name another's socket. A
 * reconnect proves itself with its seat token instead (§6.9).
 */
export const admitRoomUpgrade = (request: Request, allowed: string | undefined): RoomAdmission => {
  const url = new URL(request.url)
  const id = roomIdFromPath(url.pathname)
  if (!id) return { ok: false, status: 404, reason: 'no such room' }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return { ok: false, status: 426, reason: 'a room speaks WebSocket only' }
  }
  if (!originAdmitted(request.headers.get('Origin'), request.url, allowed)) {
    return { ok: false, status: 403, reason: 'origin' }
  }
  url.searchParams.delete('_pk')
  return { ok: true, id, url: url.toString() }
}

// ── The broadcaster (DEV-436, plan/MULTIPLAYER.md §13) ──────────────────────
//
// SourceTV on Durable Objects. A room's broadcaster is the SAME object class
// under another name (`watchName`), so there is no new Worker, class,
// migration or binding. It holds the viewers; the room never sees one. When
// the first viewer asks, the broadcaster opens ONE socket to the room on
// `ROOM_FEED_PATH` — a path no public route forwards — and the room sends
// down it a `keyframe`, every message it broadcasts to its players, and its
// players' pose frames batched every `BROADCAST_FLUSH_MS`. So the room's work
// with its players is the same whoever watches, and its work for the
// broadcaster is the same however many do. The broadcaster holds every item
// `BROADCAST_DELAY_MS`, then fans it out: a viewer watches the race as it was.

/** Room ms between the room's pose batches to its broadcaster: 4 a second (§13.2's lever). */
export const BROADCAST_FLUSH_MS = 250
/** How far behind the race a viewer watches, ms (§13.1; Matt's call 1 proposes 2 s). */
export const BROADCAST_DELAY_MS = 2000
/** With no viewer left, the broadcaster drops its feed this long after the last one. */
export const BROADCAST_IDLE_MS = 30_000
/** Viewers one broadcaster holds before it refuses more (a relay tree is §13.1's, if ever). */
export const BROADCAST_MAX_VIEWERS = 200
/** The internal path the broadcaster's feed asks the room on. No public route forwards it. */
export const ROOM_FEED_PATH = '/internal/feed'
/** A batch's tag byte: consecutive §7.2 frames behind one header. */
export const BATCH_TAG_V1 = 0x20
/** Tag, a zero, the frame count (u16), the room's time at the flush (f64 ms). */
export const BATCH_HEADER_BYTES = 12

/** Room `id`'s broadcaster: the rooms class, under this name. Not a room id's shape. */
export const watchName = (id: string): string => `watch.${id}`

/** The room id out of `/api/watch/<id>`, or null. */
export const watchIdFromPath = (pathname: string): string | null => {
  const m = /^\/api\/watch\/([^/]+)\/?$/.exec(pathname)
  const id = m?.[1]
  return id !== undefined && ROOM_ID_SHAPE.test(id) ? id : null
}

/**
 * `admitRoomUpgrade`'s twin for a viewer: `/api/watch/<id>`, a WebSocket
 * upgrade and nothing else, an admitted Origin. `name` is the broadcaster's.
 */
export const admitWatchUpgrade = (
  request: Request,
  allowed: string | undefined,
):
  | (RoomAdmission & { readonly ok: true; readonly name: string })
  | Exclude<RoomAdmission, { ok: true }> => {
  const url = new URL(request.url)
  const id = watchIdFromPath(url.pathname)
  if (!id) return { ok: false, status: 404, reason: 'no such room' }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return { ok: false, status: 426, reason: 'a room speaks WebSocket only' }
  }
  if (!originAdmitted(request.headers.get('Origin'), request.url, allowed)) {
    return { ok: false, status: 403, reason: 'origin' }
  }
  url.searchParams.delete('_pk')
  return { ok: true, id, name: watchName(id), url: url.toString() }
}

/** Viewer -> broadcaster: the one message a viewer ever sends (§13.4). */
export interface WatchMessage {
  readonly type: 'watch'
  readonly protocol: number
}

export const parseWatchMessage = (text: string): WatchMessage | null => {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v) || v.type !== 'watch' || !isInt(v.protocol, 0, 0xffff)) return null
  return { type: 'watch', protocol: v.protocol }
}

/**
 * Room -> broadcaster -> viewer: the race as it stands, so a viewer who comes
 * late draws the field at once (§13.1). The room sends one when the feed opens;
 * the broadcaster keeps its own, as of the last item it let go, for every
 * viewer after. `now` is the room's time it stands for.
 */
export interface KeyframeMessage {
  readonly type: 'keyframe'
  readonly protocol: number
  readonly now: number
  readonly phase: RoomPhase
  readonly owner: number | null
  readonly settings: RoomSettings | null
  readonly players: Readonly<Record<number, RoomPlayerView>>
  readonly race: RoomRace | null
  /** The field's GO, and late racers' own, room ms. */
  readonly field: number | null
  readonly goAts: Readonly<Record<number, number>>
  readonly results: readonly RoomVerdict[]
  readonly bots: readonly RoomBotFinish[]
  /** How far behind the race the viewer is shown it, ms. */
  readonly delay: number
}

/** Frames and a room time into one batch (the room's side). */
export const encodeBatch = (frames: readonly Uint8Array[], roomTime: number): Uint8Array => {
  let size = BATCH_HEADER_BYTES
  for (const f of frames) size += 2 + f.byteLength
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  out[0] = BATCH_TAG_V1
  view.setUint16(2, frames.length, true)
  view.setFloat64(4, roomTime, true)
  let at = BATCH_HEADER_BYTES
  for (const f of frames) {
    view.setUint16(at, f.byteLength, true)
    out.set(f, at + 2)
    at += 2 + f.byteLength
  }
  return out
}

/**
 * A batch's room time, handing each frame to `onFrame` as a view (valid only
 * inside the call), or null for bytes that are not a batch — whole: a
 * truncated batch hands over nothing.
 */
export const decodeBatch = (
  bytes: Uint8Array,
  onFrame: (frame: Uint8Array) => void,
): number | null => {
  if (bytes.byteLength < BATCH_HEADER_BYTES || bytes[0] !== BATCH_TAG_V1) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint16(2, true)
  const roomTime = view.getFloat64(4, true)
  const spans: [number, number][] = []
  let at = BATCH_HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (at + 2 > bytes.byteLength) return null
    const len = view.getUint16(at, true)
    if (at + 2 + len > bytes.byteLength) return null
    spans.push([at + 2, len])
    at += 2 + len
  }
  if (at !== bytes.byteLength) return null
  for (const [start, len] of spans) onFrame(bytes.subarray(start, start + len))
  return roomTime
}
