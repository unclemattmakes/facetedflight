// workers/rooms/src/index.ts — the rooms Worker: one Durable Object per room. DEV-386.
//
// A SHELL. The room is `src/net/room-server.ts`, a pure class tested in node
// (`tests/unit/room-server.test.ts`); this file only binds it to the platform:
// partyserver's `Server` for the socket lifecycle and hibernation, the
// object's storage and alarm, `Date.now()` for the room clock and
// `crypto.getRandomValues` for seats and the row shuffle. It imports NO game
// code (plan/MULTIPLAYER.md §6.5): its whole contract with the game is
// `room-protocol.ts` and `ROOM_PROTOCOL`, so a Worker deployed without the
// site, or the site without the Worker, meets a 4002 rather than drift.
//
// Two routes reach a room, both through `admitRoomUpgrade`:
//
//   - the game's own origin: `wss://<site>/api/room/<id>`, the Pages Function
//     `functions/api/room/[id].ts` handing the upgrade to `env.ROOMS` (§6.2);
//   - this Worker's `fetch`, on `workers.dev`: the fallback if the Pages
//     hand-off does not work, admitted by the `ROOM_ORIGINS` allowlist.
//
// DEV-436: the same class is also a room's BROADCASTER, under `watchName(id)`
// (`src/net/room-broadcast.ts`): viewers reach it on `/api/watch/<id>`, and it
// opens ONE socket to its room on `ROOM_FEED_PATH` — a path no public route
// forwards, so only this Worker's own code can reach a room's feed. No new
// class, migration or binding.
//
// The judge's verdict (DEV-390) arrives on the object's internal API
// (`onRequest`, `src/net/room-link.ts`), which no socket can reach and no public
// route forwards to: both routes above admit a WebSocket upgrade and nothing
// else, so only code holding the binding can make a plain request land there.
//
// DEV-479 (plan/FF-TV.md §2–§3), Faceted Flight TV, with no new class,
// migration or binding either:
//
//   - the same class is TV's GUIDE under `TV_GUIDE_NAME` (`src/net/tv-guide.ts`):
//     no sockets, only its internal API, which rooms announce to over
//     `stub.fetch` and the TV Functions read. A name with a dot is never a
//     room's id, so no public route can reach it;
//   - a room tells the guide what it is doing through the `announce` host hook,
//     with its own name added here (the room never learns its id);
//   - a broadcaster admits a socket on `TV_WATCH_PATH` WITHOUT an Origin check
//     (the TV Function did that) and marks it anonymous. This Worker's own
//     `fetch` forwards only the URL it admitted — `/api/watch/<id>` or
//     `/api/room/<id>` — so no public request can arrive on that path.
//
// DEV-633, PUBLIC rooms, with no new class, migration or binding either: the
// same class is the DIRECTORY of listed rooms under `ROOM_DIRECTORY_NAME`
// (`src/net/room-directory.ts`), on the guide's pattern: no sockets, only its
// internal API, which a listed room posts to over `stub.fetch` (the `list`
// host hook, its own name added here) and `functions/api/rooms.ts` reads.
//
// Deployed by hand, per environment (`docs/rooms.md`):
//   npx wrangler@4.139.0 deploy --env preview   ->  ff10yr-rooms-preview
//   npx wrangler@4.139.0 deploy                 ->  ff10yr-rooms

import { type Connection, type ConnectionContext, Server, type WSMessage } from 'partyserver'
import { type BroadcastConnection, BroadcastServer } from '../../../src/net/room-broadcast'
import {
  answerRoomDirectory,
  ROOM_DIRECTORY_NAME,
  RoomDirectory,
  type RoomListingState,
  roomDirectoryOverFetch,
} from '../../../src/net/room-directory'
import { answerRoomLink } from '../../../src/net/room-link'
import {
  admitRoomUpgrade,
  admitWatchUpgrade,
  CLOSE,
  ROOM_FEED_PATH,
  ROOM_KEEPALIVE,
  watchName,
} from '../../../src/net/room-protocol'
import { PARTYKIT_ROOM_HEADER } from '../../../src/net/room-route'
import { type RoomConnection, type RoomHost, RoomServer } from '../../../src/net/room-server'
import { answerTvGuide, TvGuide, tvGuideOverFetch } from '../../../src/net/tv-guide'
import { TV_GUIDE_NAME, TV_WATCH_PATH, type TvRoomState } from '../../../src/net/tv-protocol'

export interface Env {
  readonly ROOMS: DurableObjectNamespace<RoomDO>
  /** A regex source: the origins the direct `workers.dev` route admits. */
  readonly ROOM_ORIGINS?: string
}

export class RoomDO extends Server<Env> {
  // Hibernation: a lobby where nobody moves costs no duration (§6.2).
  static override options = { hibernate: true }

  #room: Promise<RoomServer> | null = null
  /** DEV-436: this object is a room's broadcaster, not a room (its name says which). */
  #watch: BroadcastServer | null = null
  #feed: WebSocket | null = null
  /** DEV-479: this object is TV's guide (its name says so). */
  #guide: Promise<TvGuide> | null = null
  /** DEV-479: a room's announces, one after another, so the guide hears them in order. */
  #told: Promise<void> = Promise.resolve()
  /** DEV-633: this object is the directory of public rooms (its name says so). */
  #directory: Promise<RoomDirectory> | null = null
  /** DEV-633: a room's posts to the directory, in order. */
  #listed: Promise<void> = Promise.resolve()

  #isDirectory(): boolean {
    return this.name === ROOM_DIRECTORY_NAME
  }

  #roomDirectory(): Promise<RoomDirectory> {
    const storage = this.ctx.storage
    this.#directory ??= RoomDirectory.load({
      now: () => Date.now(),
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
      },
      setAlarm: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)),
    })
    return this.#directory
  }

  /** DEV-633: tell the directory, with this room's own name added; `null` takes it off. */
  #list(state: RoomListingState | null): void {
    const room = this.name
    const directory = roomDirectoryOverFetch((request) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(ROOM_DIRECTORY_NAME))
      const r = new Request(request)
      r.headers.set(PARTYKIT_ROOM_HEADER, ROOM_DIRECTORY_NAME)
      return stub.fetch(r)
    })
    this.#listed = this.#listed
      .then(async () => {
        if (state === null) await directory.drop(room)
        else if (!(await directory.post({ ...state, room }))) {
          console.warn(`room ${room}: the directory is full; this room is not listed`)
        }
      })
      .catch((err: unknown) => console.warn(`room ${room}: the directory was not told`, err))
    this.ctx.waitUntil(this.#listed)
  }

  #isWatch(): boolean {
    return this.name.startsWith(watchName(''))
  }

  #isGuide(): boolean {
    return this.name === TV_GUIDE_NAME
  }

  #tvGuide(): Promise<TvGuide> {
    const storage = this.ctx.storage
    this.#guide ??= TvGuide.load({
      now: () => Date.now(),
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
      },
      setAlarm: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)),
    })
    return this.#guide
  }

  /** DEV-479: tell the guide, with this room's own name added; `null` withdraws (the room cleared). */
  #announce(tv: string, state: TvRoomState | null): void {
    const room = this.name
    const guide = tvGuideOverFetch((request) => {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(TV_GUIDE_NAME))
      const r = new Request(request)
      r.headers.set(PARTYKIT_ROOM_HEADER, TV_GUIDE_NAME)
      return stub.fetch(r)
    })
    this.#told = this.#told
      .then(async () => {
        if (state === null) await guide.withdraw(tv, true)
        else if (!(await guide.announce({ ...state, room }))) {
          console.warn(`room ${room}: the guide is full; this room is not on TV`)
        }
      })
      .catch((err: unknown) => console.warn(`room ${room}: the guide was not told`, err))
    this.ctx.waitUntil(this.#told)
  }

  #broadcaster(): BroadcastServer {
    this.#watch ??= new BroadcastServer({
      now: () => Date.now(),
      connections: () => this.getConnections() as Iterable<BroadcastConnection>,
      openFeed: () => {
        void this.#openFeed()
      },
      closeFeed: () => {
        this.#feed?.close(1000, 'nobody watching')
        this.#feed = null
      },
      // In memory: the feed's outbound socket keeps this object awake while it
      // feeds, and an alarm per release would bill a request each (§13.2).
      timers: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    })
    return this.#watch
  }

  /** ONE socket to the room this broadcasts, on its internal feed path. */
  async #openFeed(): Promise<void> {
    const b = this.#broadcaster()
    const room = this.name.slice(watchName('').length)
    try {
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(room))
      const res = await stub.fetch(
        new Request(`https://rooms.internal${ROOM_FEED_PATH}`, {
          headers: { Upgrade: 'websocket', [PARTYKIT_ROOM_HEADER]: room },
        }),
      )
      const ws = res.webSocket
      if (!ws) throw new Error(`the room answered ${res.status}`)
      // Bytes, not Blobs: from `websocket_standard_binary_type` (on from
      // 2026-03-17, and this Worker is dated after it) a WebSocket's binary
      // frames default to Blob, and every batch was thrown away in the
      // listener while the keyframe, text, got through (2026-09-27). Set before
      // `accept`, as Cloudflare's own example does; `onFeedMessage` still takes
      // a Blob, in order, should this ever be ignored.
      ws.binaryType = 'arraybuffer'
      ws.accept()
      this.#feed = ws
      b.onFeedOpen()
      ws.addEventListener('message', (e) => {
        try {
          b.onFeedMessage(e.data as string | ArrayBuffer | Blob)
        } catch (err) {
          // Say so: an exception in this listener is otherwise the runtime's alone.
          console.error(`watch ${room}: a feed message was dropped`, err)
        }
      })
      ws.addEventListener('close', () => {
        if (this.#feed !== ws) return
        this.#feed = null
        b.onFeedClose()
      })
    } catch (err) {
      console.warn(`watch ${room}: no feed`, err)
      b.onFeedClose()
    }
  }

  #server(): Promise<RoomServer> {
    this.#room ??= RoomServer.load(this.#host())
    return this.#room
  }

  #host(): RoomHost {
    const storage = this.ctx.storage
    return {
      now: () => Date.now(),
      connections: () => this.getConnections() as Iterable<RoomConnection>,
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key),
      },
      setAlarm: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)),
      random: (bytes) => {
        crypto.getRandomValues(bytes)
      },
      announce: (tv, state) => this.#announce(tv, state),
      list: (state) => this.#list(state),
    }
  }

  override async onStart(): Promise<void> {
    // The lobby keep-alive, answered by the platform without waking the object.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(ROOM_KEEPALIVE.request, ROOM_KEEPALIVE.response),
    )
    // DEV-436: a broadcaster that woke with viewers asks for its feed again.
    if (this.#isWatch()) {
      this.#broadcaster().start()
      return
    }
    // DEV-479: TV's guide holds no sockets and no room.
    if (this.#isGuide()) {
      await this.#tvGuide()
      return
    }
    // DEV-633: nor does the directory.
    if (this.#isDirectory()) {
      await this.#roomDirectory()
      return
    }
    await this.#server()
  }

  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    // DEV-479: the guide answers its internal API only; a socket is a mistake.
    if (this.#isGuide() || this.#isDirectory()) {
      conn.close(CLOSE.forbidden, 'the guide takes no sockets')
      return
    }
    // DEV-436: a viewer, at a broadcaster.
    if (this.#isWatch()) {
      // DEV-479: a TV viewer, forwarded by the TV Function (which checked the
      // Origin) on the path no public route forwards: anonymous from here on.
      if (new URL(ctx.request.url).pathname === TV_WATCH_PATH) {
        this.#broadcaster().onConnect(conn, true)
        return
      }
      const watching = admitWatchUpgrade(ctx.request, this.env.ROOM_ORIGINS)
      if (!watching.ok) conn.close(CLOSE.forbidden, watching.reason)
      else this.#broadcaster().onConnect(conn)
      return
    }
    // DEV-436: the room's broadcaster, on the path no public route forwards.
    if (new URL(ctx.request.url).pathname === ROOM_FEED_PATH) {
      await (await this.#server()).onFeed(conn)
      return
    }
    // Checked again here, so neither route can skip it.
    const admitted = admitRoomUpgrade(ctx.request, this.env.ROOM_ORIGINS)
    if (!admitted.ok) {
      conn.close(CLOSE.forbidden, admitted.reason)
      return
    }
    await (await this.#server()).onConnect(conn)
  }

  override async onMessage(conn: Connection, message: WSMessage): Promise<void> {
    if (this.#isGuide() || this.#isDirectory()) return
    if (this.#isWatch()) {
      this.#broadcaster().onMessage(conn, message)
      return
    }
    await (await this.#server()).onMessage(conn, message)
  }

  override async onClose(conn: Connection): Promise<void> {
    if (this.#isGuide() || this.#isDirectory()) return
    if (this.#isWatch()) {
      this.#broadcaster().onClose(conn)
      return
    }
    await (await this.#server()).onClose(conn)
  }

  override async onError(conn: Connection): Promise<void> {
    await this.onClose(conn)
  }

  override async onAlarm(): Promise<void> {
    if (this.#isWatch()) return
    // DEV-479: the guide's expiry.
    if (this.#isGuide()) {
      await (await this.#tvGuide()).onAlarm()
      return
    }
    // DEV-633: the directory's expiry.
    if (this.#isDirectory()) {
      await (await this.#roomDirectory()).onAlarm()
      return
    }
    await (await this.#server()).onAlarm()
  }

  /**
   * The judge's internal API (DEV-390, `src/net/room-link.ts`), and since
   * DEV-479 WATCH ME's `tv` request on a room and the whole of TV's guide.
   * Reachable only through the binding: both public routes forward an upgrade
   * and nothing else, so any plain request that arrives here came from a
   * Function or another object of this Worker.
   */
  override async onRequest(request: Request): Promise<Response> {
    if (this.#isGuide()) return answerTvGuide(await this.#tvGuide(), request)
    // DEV-633: the directory's post, drop and list.
    if (this.#isDirectory()) return answerRoomDirectory(await this.#roomDirectory(), request)
    if (this.#isWatch()) return new Response('a broadcaster has no internal API', { status: 404 })
    const server = await this.#server()
    return answerRoomLink(server, request)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // DEV-436: a viewer, for the room's broadcaster.
    const watching = admitWatchUpgrade(request, env.ROOM_ORIGINS)
    if (watching.ok) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(watching.name))
      const forwarded = new Request(watching.url, request)
      forwarded.headers.set(PARTYKIT_ROOM_HEADER, watching.name)
      return stub.fetch(forwarded)
    }
    const admitted = admitRoomUpgrade(request, env.ROOM_ORIGINS)
    if (!admitted.ok) return new Response(admitted.reason, { status: admitted.status })
    const stub = env.ROOMS.get(env.ROOMS.idFromName(admitted.id))
    const forwarded = new Request(admitted.url, request)
    forwarded.headers.set(PARTYKIT_ROOM_HEADER, admitted.id)
    return stub.fetch(forwarded)
  },
} satisfies ExportedHandler<Env>
