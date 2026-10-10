// tests/e2e/fixtures/room-sidecar.ts — a local room server for the multiplayer specs. DEV-388.
//
// plan/MULTIPLAYER.md §9.3: "a room sidecar per Playwright worker ... with a
// readiness probe a stale process cannot satisfy". This one hosts the REAL
// `RoomServer` (`src/net/room-server.ts`, the class the Durable Object is a
// shell over) behind a minimal RFC 6455 server in this worker's own node
// process, on the port Vite's `/api` proxy is pointed at (`FF2_API_PROXY`,
// `vite.config.ts`). The game connects to its own origin exactly as it does on
// Cloudflare (`game/room-client.ts`'s `roomUrl`); only the dev server knows the
// room is here.
//
// Why not `wrangler dev`: the Cloudflare rules for this project allow wrangler
// only for the preview deploy (AGENT-NOTES §7), and a workerd process on
// Windows outlives a killed shell (docs/lap-server.md). The DO shell and the
// Pages hand-off are proved on Cloudflare itself by `tools/net/room-probe.mjs`
// (docs/rooms.md); what the browsers test here is the client and the room.
//
// A readiness probe a stale sidecar cannot pass: `GET /api/room-sidecar`
// answers this process's own random nonce, which the spec checks.

import crypto from 'node:crypto'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { BroadcastServer } from '../../../src/net/room-broadcast'
import {
  answerRoomDirectory,
  ROOM_DIRECTORY_NAME,
  RoomDirectory,
  type RoomListingState,
} from '../../../src/net/room-directory'
import type * as RoomLap from '../../../src/net/room-lap'
import { answerRoomLink, roomLinkOverFetch } from '../../../src/net/room-link'
import { ROOM_ID_SHAPE, roomIdFromPath, watchIdFromPath } from '../../../src/net/room-protocol'
import {
  type RoomNamespace,
  routeToRoomList,
  routeToRoomTv,
  routeToTvList,
  routeTvShortLink,
} from '../../../src/net/room-route'
import { type RoomConnection, type RoomHost, RoomServer } from '../../../src/net/room-server'
import { answerTvGuide, TvGuide } from '../../../src/net/tv-guide'
import { TV_GUIDE_NAME, type TvRoomState, tvIdFromPath } from '../../../src/net/tv-protocol'
import { closeSsr, ssrImport } from './ssr-import'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11' // RFC 6455 §1.3

/** One accepted socket: a `RoomConnection` over raw frames. */
class SidecarConn implements RoomConnection {
  state: unknown = null
  closed = false
  #dead = false
  #buffer = Buffer.alloc(0)
  constructor(
    readonly id: string,
    readonly socket: Duplex,
    readonly onText: (text: string) => void,
    readonly onBinary: (bytes: Uint8Array) => void,
    readonly onGone: () => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.#read(chunk))
    socket.on('close', () => this.#gone())
    socket.on('error', () => this.#gone())
  }
  setState(state: unknown): unknown {
    this.state = state === null ? null : structuredClone(state)
    return this.state
  }
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return
    if (typeof message === 'string') this.#frame(0x1, Buffer.from(message, 'utf8'))
    else if (message instanceof ArrayBuffer) this.#frame(0x2, Buffer.from(message))
    else this.#frame(0x2, Buffer.from(message.buffer, message.byteOffset, message.byteLength))
  }
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    // DEV-852: a room closing a page itself (4xxx) is said, with its reason: a
    // 2026-10-08 run lost both sockets mid-race once and nothing recorded why.
    if (code >= 4000) console.log(`room-sidecar: closed a page ${code} ${reason}`)
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.#frame(0x8, body)
    this.closed = true
    this.socket.end()
  }
  #frame(opcode: number, payload: Buffer): void {
    const n = payload.length
    const head =
      n < 126
        ? Buffer.from([0x80 | opcode, n])
        : n < 65536
          ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
          : (() => {
              const h = Buffer.alloc(10)
              h[0] = 0x80 | opcode
              h[1] = 127
              h.writeBigUInt64BE(BigInt(n), 2)
              return h
            })()
    this.socket.write(Buffer.concat([head, payload]))
  }
  #read(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const b = this.#buffer
      if (b.length < 2) return
      const opcode = (b[0] as number) & 0x0f
      const masked = ((b[1] as number) & 0x80) !== 0
      let len = (b[1] as number) & 0x7f
      let at = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        at = 10
      }
      const maskAt = at
      if (masked) at += 4
      if (b.length < at + len) return
      const payload = Buffer.from(b.subarray(at, at + len))
      if (masked) {
        for (let i = 0; i < len; i++)
          payload[i] = (payload[i] as number) ^ (b[maskAt + (i % 4)] as number)
      }
      this.#buffer = b.subarray(at + len)
      if (opcode === 0x1) this.onText(payload.toString('utf8'))
      else if (opcode === 0x2) this.onBinary(new Uint8Array(payload))
      else if (opcode === 0x9) this.#frame(0xa, payload)
      else if (opcode === 0x8) {
        if (!this.closed) this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000)
        this.#gone()
        return
      }
    }
  }
  #gone(): void {
    if (this.#dead) return
    this.#dead = true
    this.closed = true
    this.onGone()
  }
}

/**
 * DEV-436: the broadcaster's feed, inside this process: a `RoomConnection` the
 * room sends to, whose every send is handed to the broadcaster (after the
 * sidecar's latency, as a socket would carry it). The Durable Object's feed is
 * a real socket on `ROOM_FEED_PATH`; the room cannot tell the difference.
 */
class FeedLink implements RoomConnection {
  state: unknown = null
  closed = false
  constructor(
    readonly id: string,
    readonly deliver: (data: string | Uint8Array) => void,
  ) {}
  setState(state: unknown): unknown {
    this.state = state === null ? null : structuredClone(state)
    return this.state
  }
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return
    if (typeof message === 'string') this.deliver(message)
    else if (message instanceof ArrayBuffer) this.deliver(new Uint8Array(message.slice(0)))
    else
      this.deliver(
        new Uint8Array(
          message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength),
        ),
      )
  }
  close(): void {
    this.closed = true
  }
}

interface HostedRoom {
  readonly server: Promise<RoomServer>
  readonly conns: (RoomConnection & { closed: boolean })[]
  /**
   * One event at a time, in arrival order: a Durable Object's input gate
   * delivers nothing new while a handler awaits storage, and the room is
   * written against that. Without this a `join` still awaiting its save
   * lets the next message in ahead of it.
   */
  run(fn: (s: RoomServer) => Promise<unknown> | unknown): void
}

export interface RoomSidecar {
  readonly port: number
  readonly nonce: string
  /** Delay, ms, before the room hears each message (§9.3: latency lives in the sidecar, never the game). */
  latencyMs: number
  /**
   * DEV-389: extra delay, ms, before a room hears the k-th `loaded` message
   * this sidecar receives (any room, any client). A client whose `loaded` is
   * heard 5 s late is a client that loaded 5 s late, as far as the room and
   * everyone else can tell; the game's own code path is untouched (§9.3).
   */
  loadedDelayMs: number[]
  /** The room with this id, once somebody has joined it. */
  room(id: string): Promise<RoomServer> | null
  /** DEV-479: Faceted Flight TV's guide, the REAL `TvGuide` the rooms here announce to. */
  readonly guide: Promise<TvGuide>
  /** DEV-390: every lap request the judge answered, in order. */
  readonly laps: readonly { readonly id: string; readonly status: number }[]
  close(): Promise<void>
}

export const startRoomSidecar = async (port: number): Promise<RoomSidecar> => {
  const rooms = new Map<string, HostedRoom>()
  const nonce = crypto.randomUUID()
  let latencyMs = 0
  let loadedDelayMs: number[] = []
  let loadedSeen = 0
  let nextConn = 0

  // ── DEV-479: Faceted Flight TV — the guide, as the Durable Object hosts it ──
  //
  // The REAL `TvGuide` on in-memory storage; every room here announces to it
  // (`RoomHost.announce`), in order, as the Worker's shell does over
  // `stub.fetch`. The TV Functions' REAL handlers answer `/api/tv`,
  // `/api/room/<id>/tv` and `/tv…` over a namespace that serves the guide and
  // the rooms' internal APIs; `/api/tv/<tvId>` resolves through the guide and
  // hands the socket to the room's broadcaster as ANONYMOUS, which is what
  // `TV_WATCH_PATH` means on Cloudflare.
  const guideStore = new Map<string, unknown>()
  let guideAlarm: ReturnType<typeof setTimeout> | null = null
  const guide = TvGuide.load({
    now: () => Date.now(),
    storage: {
      get: async <T>(k: string) => structuredClone(guideStore.get(k)) as T | undefined,
      put: async <T>(k: string, v: T) => {
        guideStore.set(k, structuredClone(v))
      },
      delete: async (k: string) => guideStore.delete(k),
    },
    setAlarm: async (at) => {
      if (guideAlarm) clearTimeout(guideAlarm)
      guideAlarm =
        at === null
          ? null
          : setTimeout(() => void guide.then((g) => g.onAlarm()), Math.max(0, at - Date.now()))
    },
  })
  let told: Promise<unknown> = Promise.resolve()
  const tell = (room: string, tv: string, state: TvRoomState | null) => {
    told = told
      .then(() => guide)
      .then(async (g) => {
        if (state === null) await g.withdraw(tv, true)
        else await g.announce({ ...state, room })
      })
      .catch((err: unknown) => console.error('room-sidecar: tv guide', err))
  }
  // ── DEV-633: the directory of public rooms, as the Durable Object hosts it ──
  const directoryStore = new Map<string, unknown>()
  let directoryAlarm: ReturnType<typeof setTimeout> | null = null
  const directory = RoomDirectory.load({
    now: () => Date.now(),
    storage: {
      get: async <T>(k: string) => structuredClone(directoryStore.get(k)) as T | undefined,
      put: async <T>(k: string, v: T) => {
        directoryStore.set(k, structuredClone(v))
      },
      delete: async (k: string) => directoryStore.delete(k),
    },
    setAlarm: async (at) => {
      if (directoryAlarm) clearTimeout(directoryAlarm)
      directoryAlarm =
        at === null
          ? null
          : setTimeout(
              () => void directory.then((d) => d.onAlarm()),
              Math.min(2 ** 31 - 1, Math.max(0, at - Date.now())),
            )
    },
  })
  let posted: Promise<unknown> = Promise.resolve()
  const listRoom = (room: string, state: RoomListingState | null) => {
    posted = posted
      .then(() => directory)
      .then(async (d) => {
        if (state === null) await d.drop(room)
        else await d.post({ ...state, room })
      })
      .catch((err: unknown) => console.error('room-sidecar: directory', err))
  }
  /** The binding, as the TV Functions use it: the guide by name, a room's internal API by id. */
  const namespace: RoomNamespace = {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (request) => {
        const n = name as unknown as string
        if (n === TV_GUIDE_NAME) return answerTvGuide(await guide, request)
        if (n === ROOM_DIRECTORY_NAME) return answerRoomDirectory(await directory, request)
        const room = rooms.get(n)
        if (!room) return new Response(null, { status: 404 })
        return new Promise<Response>((resolve) => {
          room.run(async (s) => resolve(await answerRoomLink(s, request)))
        })
      },
    }),
  }
  /** A node request as a Fetch one, on the page's origin when it sent one (Vite proxies the site's). */
  const asRequest = (req: http.IncomingMessage): Request => {
    let base = 'http://room-sidecar'
    try {
      if (typeof req.headers.origin === 'string') base = new URL(req.headers.origin).origin
    } catch {}
    const headers = new Headers()
    for (const k of ['origin', 'sec-fetch-site', 'upgrade']) {
      const v = req.headers[k]
      if (typeof v === 'string') headers.set(k, v)
    }
    return new Request(`${base}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers })
  }
  const tvRoute = (path: string): ((r: Request) => Promise<Response>) | null => {
    if (path === '/api/tv') return (r) => routeToTvList(r, { ROOMS: namespace })
    // DEV-633: the public rooms, by the Function's own handler.
    if (path === '/api/rooms') return (r) => routeToRoomList(r, { ROOMS: namespace })
    const code = /^\/api\/room\/([^/]+)\/tv$/.exec(path)?.[1]
    if (code !== undefined) return (r) => routeToRoomTv(r, { ROOMS: namespace }, code)
    if (path === '/tv' || path.startsWith('/tv/')) return async (r) => routeTvShortLink(r)
    return null
  }

  const hosted = (id: string): HostedRoom => {
    let r = rooms.get(id)
    if (r) return r
    const conns: (RoomConnection & { closed: boolean })[] = []
    const stored = new Map<string, unknown>()
    let alarm: ReturnType<typeof setTimeout> | null = null
    const holder: { server: Promise<RoomServer> | null } = { server: null }
    const host: RoomHost = {
      now: () => Date.now(),
      connections: () => conns.filter((c) => !c.closed),
      storage: {
        get: async <T>(k: string) => structuredClone(stored.get(k)) as T | undefined,
        put: async <T>(k: string, v: T) => {
          stored.set(k, structuredClone(v))
        },
        delete: async (k: string) => stored.delete(k),
      },
      setAlarm: async (at) => {
        if (alarm) clearTimeout(alarm)
        alarm = null
        if (at !== null) {
          alarm = setTimeout(
            () => {
              rooms.get(id)?.run((s) => s.onAlarm())
            },
            Math.max(0, at - Date.now()),
          )
        }
      },
      random: (bytes) => {
        crypto.getRandomValues(bytes)
      },
      // DEV-479: tell TV's guide, with this room's id added, as the Worker's shell does.
      announce: (tv, state) => tell(id, tv, state),
      // DEV-633: tell the directory, with this room's id added, as the Worker's shell does.
      list: (state) => listRoom(id, state),
    }
    holder.server = RoomServer.load(host)
    let queue: Promise<unknown> = holder.server
    const server = holder.server
    r = {
      server,
      conns,
      run: (fn) => {
        queue = queue
          .then(() => server.then(fn))
          .catch((err: unknown) => console.error('room-sidecar:', err))
      },
    }
    rooms.set(id, r)
    return r
  }

  /** Delay, ms, a socket adds (§9.3: latency lives here, never in the game). */
  const carried = (fn: () => void) => (latencyMs > 0 ? setTimeout(fn, latencyMs) : fn())

  /**
   * DEV-436: room `id`'s broadcaster — the REAL `BroadcastServer`, its viewers on
   * real sockets (`/api/watch/<id>`), its feed a `FeedLink` into the hosted room.
   */
  const watchers = new Map<
    string,
    { broadcaster: BroadcastServer; viewers: SidecarConn[]; feed: FeedLink | null }
  >()
  const watched = (id: string) => {
    const known = watchers.get(id)
    if (known) return known
    const viewers: SidecarConn[] = []
    const entry: { broadcaster: BroadcastServer; viewers: SidecarConn[]; feed: FeedLink | null } = {
      broadcaster: null as unknown as BroadcastServer,
      viewers,
      feed: null,
    }
    entry.broadcaster = new BroadcastServer({
      now: () => Date.now(),
      connections: () => viewers.filter((c) => !c.closed),
      openFeed: () => {
        const room = hosted(id)
        const link = new FeedLink(`feed${nextConn++}`, (data) =>
          carried(() => entry.broadcaster.onFeedMessage(data)),
        )
        entry.feed = link
        room.conns.push(link)
        entry.broadcaster.onFeedOpen()
        room.run((s) => s.onFeed(link))
      },
      closeFeed: () => {
        const link = entry.feed
        entry.feed = null
        if (!link) return
        link.closed = true
        hosted(id).run((s) => s.onClose(link))
      },
      timers: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    })
    watchers.set(id, entry)
    return entry
  }

  /**
   * DEV-390: `/api/room/<id>/lap`, answered by the REAL lap Function's handlers
   * (`src/net/room-lap.ts`, what `functions/api/room/[id]/lap.ts` is a shell
   * over), with the judge's link into this room served the way the Durable
   * Object serves it (`answerRoomLink`), inside the room's event queue.
   */
  const lapRoute = async (req: http.IncomingMessage, res: http.ServerResponse, id: string) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const request = new Request(`http://room-sidecar${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') },
      ...(req.method === 'POST' ? { body } : {}),
    })
    const room = rooms.get(id)
    const link = room
      ? roomLinkOverFetch(
          (inner) =>
            new Promise<Response>((resolve) => {
              room.run(async (s) => resolve(await answerRoomLink(s, inner)))
            }),
        )
      : null
    // Through Vite: the judge's graph holds a bare JSON import (`ssr-import.ts`).
    const { fetchRoomLap, judgeRoomLap } = await ssrImport<typeof RoomLap>('/src/net/room-lap.ts')
    const answer =
      req.method === 'POST' ? await judgeRoomLap(request, link) : await fetchRoomLap(request, link)
    lapsJudged.push({ id, status: answer.status })
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(Buffer.from(await answer.arrayBuffer()))
  }
  const lapsJudged: { id: string; status: number }[] = []

  const server = http.createServer((req, res) => {
    if (req.url === '/api/room-sidecar') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(nonce)
      return
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const lap = /^\/api\/room\/([^/]+)\/lap$/.exec(path)?.[1]
    if (lap !== undefined && ROOM_ID_SHAPE.test(lap)) {
      lapRoute(req, res, lap).catch((err: unknown) => {
        console.error('room-sidecar: lap', err)
        res.writeHead(500)
        res.end()
      })
      return
    }
    // DEV-479: TV's plain routes, by the Functions' own handlers.
    const tv = tvRoute(path)
    if (tv) {
      tv(asRequest(req))
        .then(async (answer) => {
          const headers: Record<string, string> = {}
          answer.headers.forEach((v, k) => {
            headers[k] = v
          })
          res.writeHead(answer.status, headers)
          res.end(Buffer.from(await answer.arrayBuffer()))
        })
        .catch((err: unknown) => {
          console.error('room-sidecar: tv', err)
          res.writeHead(500)
          res.end()
        })
      return
    }
    // DEV-479: a TV id the guide does not know is 404 before any upgrade; a known one, 426.
    const tvId = tvIdFromPath(path)
    if (tvId) {
      void guide.then((g) => {
        res.writeHead(g.resolve(tvId) === null ? 404 : 426)
        res.end()
      })
      return
    }
    res.writeHead(roomIdFromPath(path) || watchIdFromPath(path) ? 426 : 404)
    res.end()
  })

  server.on('upgrade', (req, socket) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    // DEV-479: a TV viewer. Resolved through the guide BEFORE the 101, and handed
    // to the room's broadcaster as anonymous: every handle it hears is Racer N.
    const tvId = tvIdFromPath(pathname)
    if (tvId) {
      const tvKey = req.headers['sec-websocket-key']
      void guide.then((g) => {
        const room = g.resolve(tvId)
        if (room === null || typeof tvKey !== 'string') {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
          return
        }
        const tvAccept = crypto
          .createHash('sha1')
          .update(tvKey + GUID)
          .digest('base64')
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${tvAccept}\r\n\r\n`,
        )
        const w = watched(room)
        const viewer: SidecarConn = new SidecarConn(
          `t${nextConn++}`,
          socket,
          (text) => carried(() => w.broadcaster.onMessage(viewer, text)),
          () => {},
          () => w.broadcaster.onClose(viewer),
        )
        w.viewers.push(viewer)
        w.broadcaster.onConnect(viewer, true)
      })
      return
    }
    const id = roomIdFromPath(pathname)
    const watchId = watchIdFromPath(pathname)
    const key = req.headers['sec-websocket-key']
    if ((!id && !watchId) || typeof key !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    // DEV-436: a viewer, for the room's broadcaster.
    if (watchId) {
      const w = watched(watchId)
      const viewer: SidecarConn = new SidecarConn(
        `v${nextConn++}`,
        socket,
        (text) => carried(() => w.broadcaster.onMessage(viewer, text)),
        () => {},
        () => w.broadcaster.onClose(viewer),
      )
      w.viewers.push(viewer)
      w.broadcaster.onConnect(viewer)
      return
    }
    const room = hosted(id as string)
    const later = carried
    const conn: SidecarConn = new SidecarConn(
      `c${nextConn++}`,
      socket,
      (text) => {
        const extra = /"type":"loaded"/.test(text) ? (loadedDelayMs[loadedSeen++] ?? 0) : 0
        const hear = () => later(() => room.run((s) => s.onMessage(conn, text)))
        if (extra > 0) setTimeout(hear, extra)
        else hear()
      },
      (bytes) =>
        later(() =>
          room.run((s) => s.onMessage(conn, new Uint8Array(bytes).buffer as ArrayBuffer)),
        ),
      () => room.run((s) => s.onClose(conn)),
    )
    room.conns.push(conn)
    room.run((s) => s.onConnect(conn))
  })

  // One port, because Vite's proxy names it (`FF2_API_PROXY`): two room specs
  // in two Playwright workers would both want it. The second WAITS for the
  // first's `close()` rather than failing EADDRINUSE, so a full run serialises
  // them by itself (up to five minutes, inside the specs' own timeouts).
  const listenBy = Date.now() + 300_000
  for (;;) {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', resolve)
        resolve(null)
      })
    })
    if (!err) break
    if (err.code !== 'EADDRINUSE' || Date.now() > listenBy) throw err
    await new Promise((r) => setTimeout(r, 1000))
  }
  return {
    port,
    nonce,
    get latencyMs() {
      return latencyMs
    },
    set latencyMs(v: number) {
      latencyMs = v
    },
    get loadedDelayMs() {
      return loadedDelayMs
    },
    set loadedDelayMs(v: number[]) {
      loadedDelayMs = v
      loadedSeen = 0
    },
    room: (id) => rooms.get(id)?.server ?? null,
    guide,
    laps: lapsJudged,
    close: async () => {
      if (guideAlarm) clearTimeout(guideAlarm)
      if (directoryAlarm) clearTimeout(directoryAlarm)
      await new Promise<void>((resolve) => {
        for (const r of rooms.values()) {
          for (const c of r.conns) if (c instanceof SidecarConn) c.socket.destroy()
        }
        for (const w of watchers.values()) for (const v of w.viewers) v.socket.destroy()
        server.close(() => resolve())
        // Kept-alive HTTP connections (the spec's readiness fetch, the proxy's
        // lap posts) would hold the port past this spec and into the next one's
        // `listen` (EADDRINUSE when two room specs share a run).
        server.closeAllConnections()
      })
      await closeSsr()
    },
  }
}
