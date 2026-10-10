// tests/e2e/fixtures/rooms-off-sidecar.ts — a site with no rooms bound. DEV-470.
//
// Production before its rooms Worker and `ROOMS` binding exist (docs/rooms.md
// § Releasing rooms), where a release build offers rooms since D36. This
// serves the REAL Pages Functions' handlers — `routeToRoom` and `routeToWatch`
// (`src/net/room-route.ts`, what `functions/api/room/[id].ts` and
// `functions/api/watch/[id].ts` are shells over) — handed an environment with
// no `ROOMS`, on the port Vite's `/api` proxy is pointed at (`FF2_API_PROXY`,
// `vite.config.ts`). So the browser meets exactly what those Functions answer
// there, to the WebSocket upgrade and to the game's diagnosis GET alike. The
// game's own code path is untouched: only the dev server knows where `/api` is.
//
// A readiness probe a stale process cannot pass, as `room-sidecar.ts`'s:
// `GET /api/room-sidecar` answers this process's own random nonce.

import crypto from 'node:crypto'
import http from 'node:http'
import {
  routeToRoom,
  routeToTvList,
  routeToTvWatch,
  routeToWatch,
} from '../../../src/net/room-route'

/** One request the handlers answered: what was asked, and the status given. */
export interface RoomsOffRequest {
  readonly method: string
  readonly path: string
  readonly upgrade: boolean
  readonly status: number
}

export interface RoomsOffSidecar {
  readonly port: number
  readonly nonce: string
  readonly requests: readonly RoomsOffRequest[]
  close(): Promise<void>
}

export const startRoomsOffSidecar = async (port: number): Promise<RoomsOffSidecar> => {
  const nonce = crypto.randomUUID()
  const requests: RoomsOffRequest[] = []
  const origin = `http://127.0.0.1:${port}`

  /** The Functions' answer, from the request as the proxy forwarded it. */
  const answer = (req: http.IncomingMessage): Promise<Response> => {
    const url = `${origin}${req.url ?? '/'}`
    const headers = new Headers()
    for (const name of ['upgrade', 'origin']) {
      const v = req.headers[name]
      if (typeof v === 'string') headers.set(name, v)
    }
    const request = new Request(url, { method: req.method ?? 'GET', headers })
    const path = new URL(url).pathname
    // DEV-480: and TV's two routes (DEV-479's handlers), as Faceted Flight TV meets them.
    const route =
      path === '/api/tv'
        ? routeToTvList
        : path.startsWith('/api/tv/')
          ? routeToTvWatch
          : path.startsWith('/api/watch/')
            ? routeToWatch
            : routeToRoom
    // No `ROOMS`: the environment this fixture exists to be.
    return route(request, {})
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/api/room-sidecar') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(nonce)
      return
    }
    answer(req)
      .then(async (r) => {
        requests.push({
          method: req.method ?? 'GET',
          path: req.url ?? '',
          upgrade: false,
          status: r.status,
        })
        res.writeHead(r.status, { 'content-type': 'text/plain' })
        res.end(await r.text())
      })
      .catch((err: unknown) => {
        console.error('rooms-off-sidecar:', err)
        res.writeHead(500)
        res.end()
      })
  })

  // An upgrade gets the Function's HTTP answer in place of a 101: the browser's
  // handshake fails, as it does on Cloudflare.
  server.on('upgrade', (req, socket) => {
    answer(req)
      .then(async (r) => {
        requests.push({
          method: req.method ?? 'GET',
          path: req.url ?? '',
          upgrade: true,
          status: r.status,
        })
        const body = await r.text()
        socket.end(
          `HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] ?? ''}\r\n` +
            `content-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
            `connection: close\r\n\r\n${body}`,
        )
      })
      .catch(() => socket.destroy())
  })

  // The port Vite's proxy names, shared with the room specs' sidecar: wait for
  // a previous one to let go rather than failing EADDRINUSE (room-sidecar.ts).
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
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
