// src/game/watch-client.ts — the game's side of watching a room: one socket. DEV-436.
//
// plan/MULTIPLAYER.md §13.3. `net/watch-session.ts` turns what the room's
// broadcaster sends into a race a `RoomSession` can draw; this is the socket
// around it — to `/api/watch/<id>` on the page's own origin, `watch` once on
// open, the keep-alive the platform answers, and a reconnect with backoff
// that stops on the room's own close codes (a viewer is told why, in one
// line, as a player is: `roomNotice`).
//
// DEV-470: and, as a player's socket does, a handshake that never opened is
// diagnosed once with a plain GET (`diagnoseStatus`: a site with no rooms, the
// day's quota, or unreachable) and given up after `ROOM_RETRY_GIVE_UP_MS`
// rather than retried for ever. Until then a watch link on a site with no
// rooms retried every four seconds, silently, for as long as the page stayed
// open.
//
// THREE-free and DOM-free: the socket, the clock and the timers come in.

import { CLOSE, ROOM_KEEPALIVE } from '@/net/room-protocol'
import { WatchSession } from '@/net/watch-session'
import {
  diagnoseStatus,
  type RemoteShipReport,
  ROOM_KEEPALIVE_MS,
  ROOM_RETRY_GIVE_UP_MS,
  ROOM_RETRY_MS,
  ROOM_UNREACHABLE,
  type RoomSocket,
  type RoomStatus,
  type RoomTimers,
  roomNotice,
} from './room-client'

/** THE watch URL: the page's own origin, `/api/watch/<id>`, as `roomUrl` is for a player. */
export const watchUrl = (
  id: string,
  location: { readonly protocol: string; readonly host: string },
): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/watch/${id}`

export interface WatchClientOptions {
  readonly url: string
  readonly now: () => number
  readonly socket?: (url: string) => RoomSocket
  readonly timers?: RoomTimers
  /** A plain GET of `url`'s http(s) twin after a failed handshake (DEV-470). Absent: no diagnosis. */
  readonly probe?: (httpUrl: string) => Promise<number>
  readonly onStatus?: (status: RoomStatus, notice: string | null) => void
}

const OPEN = 1

export class WatchClient {
  readonly watch = new WatchSession()
  status: RoomStatus = 'closed'
  closeCode: number | null = null
  connects = 0
  readonly #opts: WatchClientOptions
  readonly #timers: RoomTimers
  #socket: RoomSocket | null = null
  #attempt = 0
  #leaving = false
  #lastSent = 0
  /** DEV-470: the handshake opened at least once. */
  #everOpened = false
  /** DEV-470: when the socket went down without having opened, local ms. */
  #downSince: number | null = null
  /** DEV-470: the one diagnosis a never-opened socket gets has been asked. */
  #probed = false

  constructor(opts: WatchClientOptions) {
    this.#opts = opts
    this.#timers = opts.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    }
  }

  get notice(): string | null {
    return roomNotice(this.closeCode)
  }

  connect(): void {
    if (this.#socket !== null) return
    this.#leaving = false
    this.#open()
  }

  leave(): void {
    this.#leaving = true
    this.#socket?.close(1000, 'left')
    this.#socket = null
    this.#set('closed')
  }

  /** Every frame: the keep-alive, which the platform answers without waking anything. */
  update(): void {
    const ws = this.#socket
    const now = this.#opts.now()
    if (ws && ws.readyState === OPEN && now - this.#lastSent >= ROOM_KEEPALIVE_MS) {
      ws.send(ROOM_KEEPALIVE.request)
      this.#lastSent = now
    }
  }

  #open(): void {
    const make = this.#opts.socket ?? ((url: string) => new WebSocket(url) as unknown as RoomSocket)
    const ws = make(this.#opts.url)
    ws.binaryType = 'arraybuffer'
    this.#socket = ws
    this.connects++
    this.#set(this.connects > 1 ? 'retrying' : 'connecting')
    ws.onopen = () => {
      if (this.#socket !== ws) return
      this.#attempt = 0
      this.#everOpened = true
      this.#downSince = null
      this.#set('open')
      ws.send(WatchSession.hello())
      this.#lastSent = this.#opts.now()
    }
    ws.onmessage = (event) => {
      if (this.#socket !== ws) return
      const data = event.data
      if (data === ROOM_KEEPALIVE.response) return
      if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Uint8Array) {
        this.watch.receive(data, this.#opts.now())
      }
    }
    ws.onerror = () => {}
    ws.onclose = (event) => {
      if (this.#socket !== ws) return
      this.#socket = null
      if (this.#leaving) return
      if (event.code >= 4000 && event.code < 5000) {
        this.closeCode = event.code
        this.#set('closed')
        return
      }
      if (!this.#everOpened) {
        // DEV-470: never opened. Past the rejoin window it never will: say so.
        const now = this.#opts.now()
        this.#downSince ??= now
        if (now - this.#downSince >= ROOM_RETRY_GIVE_UP_MS) {
          this.closeCode = ROOM_UNREACHABLE
          this.#set('closed')
          return
        }
        // Once: is it the site (no rooms), the day's quota, or the room?
        if (!this.#probed && this.#opts.probe) {
          this.#probed = true
          void this.#opts.probe(this.#opts.url.replace(/^ws/, 'http')).then(
            (status) => {
              if (status === 426) this.#schedule()
              else if (!this.#leaving) {
                this.closeCode = diagnoseStatus(status)
                this.#set('closed')
              }
            },
            () => this.#schedule(),
          )
          return
        }
      }
      this.#schedule()
    }
  }

  #schedule(): void {
    if (this.#leaving || this.status === 'closed') return
    const wait = ROOM_RETRY_MS[Math.min(this.#attempt, ROOM_RETRY_MS.length - 1)] as number
    this.#attempt++
    this.#set('retrying')
    this.#timers.set(() => {
      if (!this.#leaving) this.#open()
    }, wait)
  }

  #set(status: RoomStatus): void {
    if (this.status === status) return
    this.status = status
    this.#opts.onStatus?.(status, this.notice)
  }
}

/** A viewer's page as the probe reports it (`__ff2.watch()`), for the specs and the console. */
export interface WatchProbe {
  readonly status: RoomStatus
  readonly notice: string | null
  readonly keyframes: number
  readonly batches: number
  readonly delay: number | null
  readonly phase: string | null
  readonly players: number
  /** The racer the director camera follows, or null while none is drawn. */
  readonly following: string | null
  readonly ships: readonly RemoteShipReport[]
}

/** The close codes a viewer can meet: the room's, a protocol mismatch above all. */
export const WATCH_CLOSES = [CLOSE.mismatch, CLOSE.full, CLOSE.forbidden] as const
