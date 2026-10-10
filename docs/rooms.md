# Rooms: live multiplayer's server

**What it is.** One Cloudflare Durable Object per room, in a small Worker of its own
(`workers/rooms/`), reached from the game's own origin through a Pages Function. A room is a relay
with a lifecycle: it stamps every forwarded record with its sender's slot, holds the lobby, runs
the start barrier, schedules one GO on its own clock, and keeps the results the judge hands it.
It runs **no game code**. [servers.md](servers.md) has the short version; this is the reference.

| file | what it is |
|---|---|
| `src/net/room-protocol.ts` | the wire: every message, the close codes, the caps, `ROOM_PROTOCOL`, the pose layout, and the admission both routes share |
| `src/net/room-server.ts` | the room itself, a pure class over an injected clock, storage and connection list |
| `src/net/room-route.ts` | the Pages Function's hand-off to the binding |
| `functions/api/room/[id].ts` | `/api/room/<id>`: a shell over `room-route.ts` |
| `workers/rooms/src/index.ts` | the Durable Object (`RoomDO`, a partyserver `Server`) and the Worker's own `fetch`: a shell over `room-server.ts` |
| `workers/rooms/wrangler.jsonc` | the Worker's config: the class, its SQLite migration, the two environments. **No `pages_build_output_dir`, ever** |
| `src/net/room-lap.ts`, `functions/api/room/[id]/lap.ts` | the judge: `POST /api/room/<id>/lap` rescores a lap with the lap server's validator against the room's course and rules and hands the verdict to the room; `GET ...?slot=` serves a judged lap |
| `src/net/room-link.ts` | the judge's line to the room: `stub.fetch` to the Durable Object's internal API, which no public route reaches |
| `src/net/room-broadcast.ts`, `watch-session.ts`, `functions/api/watch/[id].ts` | the broadcaster for spectators |
| `src/net/tv-protocol.ts`, `tv-guide.ts`, `tv-anon.ts`, `tv-admin.ts`, `functions/api/tv/`, `functions/tv/` | Faceted Flight TV's server half |
| `src/game/room-client.ts`, `remote-ships.ts`, `room-lobby.ts`, `room-results.ts` | the game's side: the socket, the other players' ships, the lobby, the judged results |
| `tests/unit/room-server.test.ts`, `room-route.test.ts`, `room-lap.test.ts`, `room-broadcast.test.ts` | the room against a fake room, every close code and cap, the hand-off, the judge, the broadcast |
| `tests/e2e/fixtures/room-sidecar.ts` | a local room for the browser specs, hosting the real `RoomServer` and the real judge |

## What a room does

- **Admission.** A client connects, then sends `join` with the protocol number, its handle (which
  must be one the game's generator could have made), its color, and the course. A mismatch of
  protocol, rules or content is refused with close code 4002, which the game shows as "update
  your game". A connection is identified by a seat token the room gives it in `hello`; a
  reconnect proves itself with that token, inside a 30 second window.
- **Lobby.** Players pick colors, press ready, and the owner presses START (alone, START is the
  one press, and AI racers fill the empty starts). The owner can remove a player.
- **Start barrier.** When everyone is loaded, the room picks one GO moment on its own clock and
  tells every client, with the room clock's offset, so every client releases at the same instant.
- **Race.** Every craft in a room is intangible and each client steps only its own ship, so
  there is no contact to arbitrate. Poses pass through the room, stamped with the sender's slot.
  The room decides no result.
- **Judging.** When a client finishes, it posts its lap to the judge. The judge replays the lap's
  poses through the lap server's validator and hands the verdict, the judged time in ticks, to
  the room, which tells everyone. The results panel places the judged times, not claimed ones.
- **Forgetting.** A room keeps nothing once it is empty: its state, its laps and the codes it
  issued go after a short rejoin window.

A room is named by a seven-character code (or by a longer id in a link). `ROOM_PROTOCOL`
(currently in `src/net/room-protocol.ts`) is carried in `join`, so two builds with different
wire formats cannot share a room.

## The two routes

1. **The game's origin**: `wss://<site>/api/room/<id>`. The Pages Function checks the id, that
   the request is a WebSocket upgrade and nothing else, and that the page is same-origin, then
   hands the request to `env.ROOMS.get(env.ROOMS.idFromName(id))`. No CORS and no second
   hostname. **This is the route the game uses.**
2. **The Worker directly**: `wss://<your-worker>.workers.dev/api/room/<id>`, admitted by the
   `ROOM_ORIGINS` allowlist in `wrangler.jsonc` (WebSockets have no CORS, so the `Origin` check is
   the whole of it). A fallback, kept deployable so switching needs no redeploy of the Worker.

Both run `admitRoomUpgrade`, and the Durable Object runs it again on connect, so neither route
can skip it. Both strip partyserver's `_pk` from the URL, so a client never chooses its
connection id. Nothing but an upgrade reaches a room through either route, so the judge's verdict
can only arrive on the Durable Object's internal API, which only code holding the `ROOMS` binding
can call.

## Bindings

| | |
|---|---|
| the Worker | `ff10yr-rooms` in `wrangler.jsonc`; rename it for your account |
| its class | `RoomDO`, SQLite-backed (migration `v1`) |
| Pages binding `ROOMS` | a Durable Object namespace pointing at that Worker's `RoomDO` |
| `ROOM_ORIGINS` | a regular expression of the origins the direct route admits. **Edit it to your site's origin** |

Use one Worker per environment, so a preview deployment never shares rooms with production.

**A change to the wire needs the Worker redeployed**, because the Worker does not deploy with the
site. Bump `ROOM_PROTOCOL` and deploy the Worker again. Until you do, a new client meets the old
Worker and is refused 4002.

If the `ROOMS` binding is absent, every room path answers 503 `rooms are not configured here`,
and the game says multiplayer is not available.

## Spectators: the broadcaster

A room's broadcaster is the rooms class under another name (`watchName(id)`), so there is no new
Worker, class, migration or binding. A viewer opens `wss://<site>/api/watch/<id>` and sends
`watch`, and that is all a viewer ever sends. The first viewer makes the broadcaster open one
socket to its room on a path neither public route forwards, and the room sends down it a
`keyframe`, everything it tells its players, and their poses batched four times a second. The
broadcaster holds each item for two seconds and fans it out; a viewer who comes late gets the
broadcaster's own keyframe first. **The room's work with its players does not change with the
number watching** (a unit test counts it at 0, 1 and 50 viewers), and a race nobody watches costs
nothing: the feed closes 30 seconds after the last viewer.

The game's viewer is `?watch=<id>`: it boards the race's course, keeps its own craft hidden, and
flies a director camera behind a racer.

## Faceted Flight TV

Every room's race can air on TV, with **no room code and no handle on the wire** to a TV viewer.
It adds no Worker, class, migration or binding. The server half:

- **The guide**: the rooms class under the name `tv.guide`. It has no sockets, only an internal
  API over `stub.fetch` (announce, withdraw, resolve, list, off-air). A room announces itself
  once it has a **TV id** (`tv_` plus 16 base32 characters, never the shape of a room id), minted
  at its first race and kept for the room's life. At most 64 rooms are listed.
- **The anonymous audience**: a TV viewer's socket is admitted on an internal path that only the
  TV Function reaches, and is sent every text item with each handle replaced by "Racer N".
  Link viewers (`?watch=`) keep the names.

| route | does |
|---|---|
| `GET /api/tv` | the list of races: `{ races: [{ tv, mission, phase, racers, since }], lobbies }`, no room id; cached ten seconds; 503 if unbound |
| `wss /api/tv/<tvId>` | resolves through the guide, answers 404 for an unknown, expired or off-air id before any upgrade, then forwards same-origin sockets only |
| `GET /api/room/<code>/tv` | "watch me": returns `{ tv }`; 404 where nobody is in the room; 403 to a foreign origin |
| `GET /tv`, `/tv/<tvId>`, `/tv/lap/<lapId>` | redirect to the game's TV links |
| `GET/POST/DELETE /api/admin/tv` | take a race off the air, behind `ADMIN_TOKEN`; each change is logged |

## Close codes

| code | meaning | the client |
|---|---|---|
| 4000 | room full | stop; say so |
| 4001 | race in progress (no mid-race joins), or a reconnect past its 30 seconds | stop; say so |
| 4002 | another protocol, rules or content | stop; "update your game" |
| 4003 | over the rate or size cap | stop |
| 4004 | no such room, or an expired short code | stop |
| 4005 | this seat was taken over by a newer connection with its token | stop (the newer one is you) |
| 4006 | not understood | stop |
| 4007 | the page's Origin is not the game's | stop |
| 4008 | the owner removed this player, or this seat was removed earlier | stop; say so |

A taken color is not a close: the room sends `error { code: 'colour-taken' }`.

## Limits and cost

A Durable Object per room is cheap: a room that nobody is in costs nothing, and the relay does
little work per message. On Cloudflare's free plan the account's daily request limits are shared
with the lap server and the privacy page, and past them requests fail until the next UTC day: the
cost of overrun is an outage, not a bill. The Worker's configuration uses SQLite-backed classes,
the only kind the free plan offers.

## Run it locally

### The game, in a room, with no wrangler at all

The multiplayer specs host the real `RoomServer` in their own node process
(`tests/e2e/fixtures/room-sidecar.ts`, a minimal WebSocket server) and point Vite's `/api` at it,
so the game connects to its own origin exactly as it does on Cloudflare:

```sh
# Two browsers side by side in one room; GO together; each draws the other.
FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-two-browsers
# The lobby: title, link, colors, ready, START, a late loader, a refused join (4001).
FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-lobby
# Two browsers race to the finish, judged by the real judge.
FF2_API_PROXY=http://127.0.0.1:5398 E2E_PORT=5388 npx playwright test room-results
```

By hand: start the dev server with `FF2_API_PROXY` set, and anything on that port answering
`/api/room/<id>` is the room. On the title, choose Multiplayer, Host a Race in one window; the
address bar then carries `?room=<code>`, which is the link. Open it in a second window, or type
the code under Join with a Code. Press ready in the guest's window and START in the owner's.

### The Worker itself, in workerd

Nothing here touches Cloudflare: `wrangler dev` and `wrangler pages dev` run the same runtime
(workerd) on your machine, and the Pages binding reaches the running Worker's class through
Wrangler's dev registry.

```sh
cd workers/rooms && pnpm install --frozen-lockfile && cd ../..

# 1. The rooms Worker, preview environment (its own terminal).
cd workers/rooms
npx wrangler@4.139.0 dev --env preview --port 5386

# 2. The Pages Functions, with ROOMS bound to that Worker's class (another terminal,
#    from the repository root). Any directory with an index.html will do as the site.
npx wrangler@4.139.0 pages dev <dir with an index.html> --port 5387 \
  --do ROOMS=RoomDO@ff10yr-rooms-preview --compatibility-date 2026-09-01
```

`ws://127.0.0.1:5387/api/room/<id>` is then route 1 and `ws://127.0.0.1:5386/api/room/<id>` is
route 2. `tools/net/room-probe.mjs` is a two-client WebSocket probe for either:

```sh
node tools/net/room-probe.mjs ws://127.0.0.1:5387 http://127.0.0.1:5387
```

It checks the keep-alive, one shared GO for both clients, each other's pose with the sender's slot
stamped, the judge end to end, and that a third join is closed 4001. Add `--watch` to check three
viewers hear both racers two seconds late, and `--tv` to check the TV list and anonymization.

On Windows, stop each process with Ctrl+C in its own terminal: killing the shell that launched it
leaves `workerd.exe` listening on the port.
