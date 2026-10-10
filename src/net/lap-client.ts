// src/net/lap-client.ts — the game's side of the lap server. DEV-373.
//
// DEV-372 built the server (`docs/lap-server.md`) and nothing in the game
// called it. This is the whole of what the game says to it:
//
//   POST /api/laps                                   Share, from the results panel
//   GET  /api/laps?id=<id>                           a link, `?ghost=<id>`, or a
//                                                    board entry the hangar picked
//   GET  /api/board/<mission>/<mode>/<edition>/<variant>
//                                                    the hangar's "world #1" and
//                                                    "the lap just above yours",
//                                                    and the results panel's
//                                                    board (DEV-431)
//   DELETE /api/laps?id=<id>                         take a shared lap back, from
//                                                    the results panel (DEV-374)
//   POST /api/room/<id>/lap                          a room lap, to the judge (DEV-390)
//   GET  /api/room/<id>/lap?slot=<n>                 another player's judged lap,
//                                                    to race as a ghost (DEV-390)
//
// ── What goes over the wire ───────────────────────────────────────────────
//
// A lap is `lapToBytes(doc)` — the `ff2-ghost-2` wire DEV-370 wrote — deflated
// RAW with `CompressionStream('deflate-raw')` and carried as unpadded base64url
// (`net/base64url.ts`, the server's own codec). DEV-372 §7 asked for exactly
// that, and the server inflates it with `DecompressionStream('deflate-raw')`,
// so the two sides are the one web-platform codec in two directions.
//
// A lap coming BACK is inflated through a cap (`LAP_INFLATED_MAX`, the server's
// own) before it is decoded. The server is ours, but a link is not: an id is
// the one thing a stranger hands the game, and the answer to it is decoded in
// the page.
//
// ── Nothing here decides anything ─────────────────────────────────────────
//
// Whether a lap may be shared (`game/lap-share.ts`), who posts it
// (`game/lap-identity.ts`) and which ghost a run races (`game/lap-run.ts`) are
// the game's. This file only speaks HTTP, and every call takes its `fetch` so
// the unit tests need no network and no DOM. It never throws: a refusal, a
// network failure and a body that is not what the server writes all come back
// as `{ ok: false, reason }`, because a Share press must never take a run down.
//
// Web platform only (fetch, streams): no DOM, no three, no game layer — and no
// import of the validator, whose module drags the 155 KB courses artefact in.

import { recordingHeld } from '@/game/tv/off-the-record'
import type { LapDoc } from '@/sim/ghost'
import { lapFromBytes, lapToBytes } from '@/sim/ghost-record'
import { fromBase64url, toBase64url } from './base64url'
import { fetchOrNull, readJsonObject } from './fetch-json'
import { drainCapped } from './http'
import { LAP_ID_LENGTH, LAP_INFLATED_MAX } from './lap-policy'

/** A lap id as the server mints them (`newLapId`): base62, `LAP_ID_LENGTH` characters. */
const ID_SHAPE = new RegExp(`^[0-9A-Za-z]{${LAP_ID_LENGTH}}$`)

/** Is this a lap id? The only test `?ghost=` gets before it reaches the network. */
export const isLapId = (text: unknown): text is string =>
  typeof text === 'string' && ID_SHAPE.test(text)

/** The URL switch a shared link carries. One name, read in one place (`boot/app.ts`). */
export const GHOST_SWITCH = 'ghost'

/**
 * The link to a lap, as a person reads it: the host, and `?ghost=<id>`. No
 * scheme, because it is read off a panel in a headset and typed or said, and
 * every browser adds `https://` to a bare host. `host` is `location.host`, so a
 * preview deployment's link names the preview.
 */
export const shareLink = (host: string, id: string): string => `${host}/?${GHOST_SWITCH}=${id}`

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** A refusal, a failure to reach the server, or a body that is not the server's. */
export interface LapNetFailure {
  readonly ok: false
  /** The HTTP status, or 0 when there was no response at all. */
  readonly status: number
  /** The server's `error` (its stage, for a 422), or `network` / `body`. */
  readonly error: string
  /** One line a person can read on the panel. */
  readonly reason: string
}

const failure = (status: number, error: string, reason: string): LapNetFailure => ({
  ok: false,
  status,
  error,
  reason,
})

/**
 * DEV-483: what a post answers while TV's exhibition holds the record doors
 * (`game/tv/off-the-record.ts`). Nothing is sent: no request leaves the page.
 */
const heldFailure = (): LapNetFailure =>
  failure(0, 'held', 'nothing is posted while TV is on (DEV-483)')

// ── The codec ──────────────────────────────────────────────────────────────

const through = async (
  stream: CompressionStream | DecompressionStream,
  bytes: Uint8Array,
  cap: number,
): Promise<Uint8Array | null> => {
  const writer = stream.writable.getWriter()
  // The write side settles on its own; its failure is the read side's, and is
  // reported there. Swallowed here so it is never an unhandled rejection.
  writer
    .write(new Uint8Array(bytes))
    .then(() => writer.close())
    .catch(() => {})
  return drainCapped(stream.readable, cap)
}

/** Raw deflate, the server's `deflate-raw`. */
export const deflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> =>
  (await through(new CompressionStream('deflate-raw'), bytes, Number.POSITIVE_INFINITY)) ??
  new Uint8Array(0)

/** Raw inflate through `cap` bytes; null for bytes that are not raw deflate or inflate past it. */
export const inflateRaw = async (
  bytes: Uint8Array,
  cap: number = LAP_INFLATED_MAX,
): Promise<Uint8Array | null> => {
  try {
    return await through(new DecompressionStream('deflate-raw'), bytes, cap)
  } catch {
    return null
  }
}

/** A lap as the server takes it: base64url of raw deflate of the `ff2-ghost-2` wire. */
export const lapToWire = async (doc: LapDoc): Promise<string> =>
  toBase64url(await deflateRaw(lapToBytes(doc)))

/** The inverse, or null for text that is not a lap. */
export const lapFromWire = async (text: string): Promise<LapDoc | null> => {
  const compressed = fromBase64url(text)
  if (!compressed) return null
  const raw = await inflateRaw(compressed)
  if (!raw) return null
  try {
    return lapFromBytes(raw)
  } catch {
    return null
  }
}

// ── The calls ──────────────────────────────────────────────────────────────

/** What a refusal says, as the panel prints it. The server's `reason`, else its status. */
const refusalOf = async (response: Response): Promise<LapNetFailure> => {
  const body = await readJsonObject(response)
  const error = typeof body?.error === 'string' ? body.error : 'http'
  const reason =
    typeof body?.reason === 'string' && body.reason.length > 0
      ? body.reason
      : `the server answered ${response.status}`
  return failure(response.status, error, reason)
}

const call = async (
  fetchFn: Fetch,
  url: string,
  init?: RequestInit,
): Promise<Response | LapNetFailure> => {
  return (
    (await fetchOrNull(fetchFn, url, init)) ??
    failure(0, 'network', 'the lap server could not be reached')
  )
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** What Share sends. `seconds` is the client's clock: compared by the server, never stored. */
export interface SubmitRequest {
  readonly doc: LapDoc
  readonly seconds: number
  readonly handle: string
  readonly owner: string
}

/** The server's 201, as far as the panel reads it. */
export interface SubmitAccepted {
  readonly ok: true
  readonly id: string
  readonly variant: string
  readonly seconds: number
  readonly rings: number
  readonly ringsTotal: number
  /** On the board, and where; or a shared lap only, and why not. */
  readonly board: boolean
  readonly rank: number | null
  readonly boardReason: string | null
}

/** Share: `POST /api/laps`. Never throws. */
export const submitLap = async (
  request: SubmitRequest,
  fetchFn: Fetch = fetch,
  base = '',
): Promise<SubmitAccepted | LapNetFailure> => {
  if (recordingHeld()) return heldFailure()
  let lap: string
  try {
    lap = await lapToWire(request.doc)
  } catch {
    return failure(0, 'body', 'the lap could not be packed')
  }
  const response = await call(fetchFn, `${base}/api/laps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lap,
      seconds: request.seconds,
      handle: request.handle,
      owner: request.owner,
    }),
  })
  if (!(response instanceof Response)) return response
  if (response.status !== 201) return refusalOf(response)
  const body = await readJsonObject(response)
  if (!body || !isLapId(body.id)) return failure(response.status, 'body', 'the server said nothing')
  return {
    ok: true,
    id: body.id,
    variant: typeof body.variant === 'string' ? body.variant : '',
    seconds: isNum(body.seconds) ? body.seconds : request.seconds,
    rings: isNum(body.rings) ? body.rings : 0,
    ringsTotal: isNum(body.ringsTotal) ? body.ringsTotal : 0,
    board: body.board === true,
    rank: isNum(body.rank) ? body.rank : null,
    boardReason: typeof body.boardReason === 'string' ? body.boardReason : null,
  }
}

/** A lap to race, as `GET /api/laps?id=` returns it, decoded. */
export interface SharedLap {
  readonly id: string
  readonly mission: string
  readonly mode: string
  readonly edition: string
  readonly variant: string
  readonly rules: string
  readonly handle: string
  /** The SERVER's rescore of the poses, never the poster's claim. */
  readonly seconds: number
  readonly rings: number
  readonly ringsTotal: number
  readonly board: boolean
  readonly doc: LapDoc
}

/** One lap by id: a link's, or a board entry's. Never throws. */
export const fetchLap = async (
  id: string,
  fetchFn: Fetch = fetch,
  base = '',
): Promise<{ readonly ok: true; readonly lap: SharedLap } | LapNetFailure> => {
  if (!isLapId(id)) return failure(0, 'id', 'not a lap id')
  const response = await call(fetchFn, `${base}/api/laps?id=${id}`)
  if (!(response instanceof Response)) return response
  if (response.status !== 200) return refusalOf(response)
  const body = await readJsonObject(response)
  if (!body || typeof body.lap !== 'string') {
    return failure(response.status, 'body', 'the server sent no lap')
  }
  const doc = await lapFromWire(body.lap)
  if (!doc) return failure(response.status, 'body', 'the lap would not decode')
  // The DOC says whose lap it is; the envelope is the server's reading of the
  // same doc. Where they disagree the doc wins, because the doc is what flies.
  const variant =
    typeof body.variant === 'string' ? body.variant : (doc.vehicle.split(':')[1] ?? 'standard')
  return {
    ok: true,
    lap: {
      id,
      mission: doc.mission,
      mode: doc.mode,
      edition: doc.edition,
      variant,
      rules: doc.rules,
      handle: typeof body.handle === 'string' ? body.handle : '',
      seconds: isNum(body.seconds) ? body.seconds : 0,
      rings: isNum(body.rings) ? body.rings : 0,
      ringsTotal: isNum(body.ringsTotal) ? body.ringsTotal : 0,
      board: body.board === true,
      doc,
    },
  }
}

/** One row of a board, fastest first. */
export interface BoardEntry {
  readonly rank: number
  readonly id: string
  readonly handle: string
  readonly seconds: number
  readonly rings: number
}

/** Which board: DEV-372's key, one per aircraft variant. */
export interface BoardKey {
  readonly mission: string
  readonly mode: string
  readonly edition: string
  readonly variant: string
}

/**
 * `GET /api/board/…`. Never throws; a board the server has not got is an empty list, not an error.
 *
 * `fresh` (DEV-431) asks past the browser's cache: the server answers a board
 * with `max-age=30`, so a board asked for again straight after a Share would
 * otherwise come back without the lap just posted.
 */
export const fetchBoard = async (
  key: BoardKey,
  fetchFn: Fetch = fetch,
  base = '',
  fresh = false,
): Promise<{ readonly ok: true; readonly entries: readonly BoardEntry[] } | LapNetFailure> => {
  const path = [key.mission, key.mode, key.edition, key.variant].map(encodeURIComponent).join('/')
  const response = await call(
    fetchFn,
    `${base}/api/board/${path}`,
    fresh ? { cache: 'no-cache' } : undefined,
  )
  if (!(response instanceof Response)) return response
  if (response.status === 404) return { ok: true, entries: [] }
  if (response.status !== 200) return refusalOf(response)
  const body = await readJsonObject(response)
  if (!body || !Array.isArray(body.entries)) {
    return failure(response.status, 'body', 'the server sent no board')
  }
  const entries: BoardEntry[] = []
  for (const e of body.entries as unknown[]) {
    if (e === null || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (!isLapId(r.id) || !isNum(r.seconds) || !isNum(r.rank)) continue
    entries.push({
      rank: r.rank,
      id: r.id,
      handle: typeof r.handle === 'string' ? r.handle : '',
      seconds: r.seconds,
      rings: isNum(r.rings) ? r.rings : 0,
    })
  }
  entries.sort((a, b) => a.rank - b.rank)
  return { ok: true, entries }
}

// ── DEV-374: taking a lap back ────────────────────────────────────────────

/**
 * Delete your own lap: `DELETE /api/laps?id=`, with this device's owner key in
 * `X-FF-Owner` — a header, never the URL, which access logs keep. The server
 * deletes only when the key's hash is the one the lap was posted with, and
 * answers a wrong key exactly as it answers a missing lap (404), so this
 * cannot tell the two apart and does not try. Never throws.
 */
export const deleteLap = async (
  id: string,
  owner: string,
  fetchFn: Fetch = fetch,
  base = '',
): Promise<{ readonly ok: true } | LapNetFailure> => {
  if (!isLapId(id)) return failure(0, 'id', 'not a lap id')
  const response = await call(fetchFn, `${base}/api/laps?id=${id}`, {
    method: 'DELETE',
    headers: { 'x-ff-owner': owner },
  })
  if (!(response instanceof Response)) return response
  if (response.status !== 204) return refusalOf(response)
  return { ok: true }
}

// ── DEV-390: a room's laps ────────────────────────────────────────────────

/** What a room lap sends: Share's body, with the seat that flew it instead of a handle. */
export interface RoomLapRequest {
  /** The room's id (`net/room-protocol.ts`'s `ROOM_ID_SHAPE`). */
  readonly room: string
  readonly doc: LapDoc
  /** The client's clock. The judge compares it and rescores; the room lists the rescore. */
  readonly seconds: number
  /** The seat token the room's `hello` gave this client. */
  readonly seat: string
  /** The client's own word, for the "assisted" mark (§11 call 6). */
  readonly tainted: boolean
}

/**
 * `POST /api/room/<id>/lap` (plan/MULTIPLAYER.md §6.5): the lap to the judge,
 * which hands its verdict to the room. The room's `results` message is what the
 * panel reads; the verdict returned here is for the log and the probe. A lap
 * the judge REFUSED is still `ok: true` here: the refusal is the verdict.
 * Never throws.
 */
export const submitRoomLap = async (
  request: RoomLapRequest,
  fetchFn: Fetch = fetch,
  base = '',
): Promise<{ readonly ok: true; readonly verdict: string } | LapNetFailure> => {
  if (recordingHeld()) return heldFailure()
  let lap: string
  try {
    lap = await lapToWire(request.doc)
  } catch {
    return failure(0, 'body', 'the lap could not be packed')
  }
  const response = await call(fetchFn, `${base}/api/room/${request.room}/lap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lap,
      seconds: request.seconds,
      seat: request.seat,
      tainted: request.tainted,
    }),
  })
  if (!(response instanceof Response)) return response
  if (response.status !== 200) return refusalOf(response)
  const body = await readJsonObject(response)
  const verdict = body?.verdict as Record<string, unknown> | undefined
  if (!verdict || typeof verdict.verdict !== 'string') {
    return failure(response.status, 'body', 'the judge said nothing')
  }
  return { ok: true, verdict: verdict.verdict }
}

/**
 * `GET /api/room/<id>/lap?slot=<n>`: another player's JUDGED lap, to race as a
 * ghost (§6.5's "race this lap"), decoded through the same cap as a link's.
 * Never throws.
 */
export const fetchRoomGhost = async (
  room: string,
  slot: number,
  fetchFn: Fetch = fetch,
  base = '',
): Promise<{ readonly ok: true; readonly doc: LapDoc } | LapNetFailure> => {
  const response = await call(fetchFn, `${base}/api/room/${room}/lap?slot=${slot}`)
  if (!(response instanceof Response)) return response
  if (response.status !== 200) return refusalOf(response)
  const body = await readJsonObject(response)
  if (!body || typeof body.lap !== 'string') {
    return failure(response.status, 'body', 'the room sent no lap')
  }
  const doc = await lapFromWire(body.lap)
  return doc ? { ok: true, doc } : failure(response.status, 'body', 'the lap would not decode')
}
