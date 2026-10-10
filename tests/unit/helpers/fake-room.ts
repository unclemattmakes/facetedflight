// tests/unit/helpers/fake-room.ts — a `RoomServer` over a fake host. DEV-386.
//
// king-tide's relay tests' pattern (`relay-start-barrier.test.ts`): the REAL
// room class, a hand-rolled connection list, storage and clock. Two things
// the fake must NOT be generous about, or the tier proves the fake:
//
//   - storage CLONES on put and get, as a Durable Object serialises. Aliased
//     objects would make "resumes from storage" pass with the state only ever
//     in memory;
//   - a closed socket leaves the connection list, and the room hears
//     `onClose` only when the test says the platform delivered it.

import type { RoomListingState } from '@/net/room-directory'
import { type RoomConnection, type RoomHost, RoomServer } from '@/net/room-server'

export type Sent = string | Uint8Array

export class FakeConn implements RoomConnection {
  state: unknown = null
  readonly sent: Sent[] = []
  closed: { code: number | undefined; reason: string | undefined } | null = null
  constructor(readonly id: string) {}
  setState(state: unknown): unknown {
    this.state = state === null ? null : structuredClone(state)
    return this.state
  }
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closed) return
    if (typeof message === 'string') this.sent.push(message)
    else if (message instanceof ArrayBuffer) this.sent.push(new Uint8Array(message.slice(0)))
    else {
      const v = new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
      this.sent.push(new Uint8Array(v))
    }
  }
  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason }
  }
  /** Every JSON message received, parsed. */
  json(): Array<Record<string, unknown> & { type: string }> {
    return this.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m))
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.json().filter((m) => m.type === type)
  }
  last(type: string): Record<string, unknown> | undefined {
    return this.ofType(type).at(-1)
  }
  binary(): Uint8Array[] {
    return this.sent.filter((m): m is Uint8Array => typeof m !== 'string')
  }
}

export class FakeRoom {
  now = 1_000_000
  alarm: number | null = null
  readonly conns: FakeConn[] = []
  readonly stored = new Map<string, unknown>()
  #randomCounter = 1
  /** When false, `put` is dropped: the in-memory-only room a gate proves red against. */
  persist = true
  server!: RoomServer
  /** DEV-633: what the room told the directory, in order (`null` is off the list). */
  readonly listed: (RoomListingState | null)[] = []

  readonly host: RoomHost = {
    now: () => this.now,
    connections: () => this.conns.filter((c) => !c.closed),
    storage: {
      get: async <T>(key: string) => {
        const v = this.stored.get(key)
        return v === undefined ? undefined : (structuredClone(v) as T)
      },
      put: async <T>(key: string, value: T) => {
        if (this.persist) this.stored.set(key, structuredClone(value))
      },
      delete: async (key: string) => this.stored.delete(key),
    },
    setAlarm: async (at: number | null) => {
      this.alarm = at
    },
    // Deterministic "random" bytes: a counter, so seats differ and runs repeat.
    random: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = (this.#randomCounter++ * 131 + i) & 0xff
    },
    list: (state) => {
      this.listed.push(state)
    },
  }

  static async open(): Promise<FakeRoom> {
    const room = new FakeRoom()
    room.server = await RoomServer.load(room.host)
    return room
  }

  /** A new instance over the same storage and sockets: eviction, or waking from hibernation. */
  async evict(): Promise<void> {
    this.server = await RoomServer.load(this.host)
  }

  async connect(id: string): Promise<FakeConn> {
    const c = new FakeConn(id)
    this.conns.push(c)
    await this.server.onConnect(c)
    return c
  }

  async send(conn: FakeConn, msg: object | string): Promise<void> {
    await this.server.onMessage(conn, typeof msg === 'string' ? msg : JSON.stringify(msg))
  }

  async sendBinary(conn: FakeConn, bytes: Uint8Array): Promise<void> {
    // A socket delivers a COPY: the sender's buffer is its own again at once.
    await this.server.onMessage(conn, new Uint8Array(bytes).buffer)
  }

  /** The platform delivers a close: the socket leaves the list, then `onClose`. */
  async disconnect(conn: FakeConn): Promise<void> {
    conn.close(1000, 'bye')
    await this.server.onClose(conn)
  }

  /** Close codes the room sent, by connection id. */
  closes(): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {}
    for (const c of this.conns) if (c.closed) out[c.id] = c.closed.code
    return out
  }

  async fireAlarm(): Promise<void> {
    await this.server.onAlarm()
  }
}
