# The servers

The game is a static site plus two small pieces of server code, both running on Cloudflare. There
are no accounts. This page says what each piece does, how to run or host your own, and what it
knows about players. The full references are [lap-server.md](lap-server.md),
[rooms.md](rooms.md) and [stats.md](stats.md).

**About production.** The live site at facetedflight.net is deployed from the author's own
working repository, not from this one. This repository carries the server code so that you can
read it, check the privacy page against it, run it locally and host your own. Nothing in this
repository deploys anything on its own.

## What is where

| Piece | Folder | Pure logic (node-testable) |
|---|---|---|
| The lap server: shared laps and leaderboards | `functions/api/laps.ts`, `board/`, `admin/`; `migrations/` | `src/net/lap-server.ts`, `lap-validate.ts`, `lap-policy.ts`, `lap-admin.ts` |
| Rooms: live multiplayer | `functions/api/room/`, `watch/`, `rooms.ts`; `workers/rooms/` | `src/net/room-server.ts`, `room-protocol.ts`, `room-broadcast.ts`, `room-lap.ts` |
| Faceted Flight TV: watching live races | `functions/api/tv/`, `functions/tv/` | `src/net/tv-guide.ts`, `tv-anon.ts`, `tv-protocol.ts` |
| Gameplay statistics | `functions/api/stats.ts` | `src/net/stats-schema.ts`, `stats-server.ts` |
| The privacy page | `functions/privacy.ts` | `src/net/privacy-page.ts` |

The `functions/` files are thin shells: each reads its bindings and calls into `src/net/`. All
the decisions are in `src/net/`, which imports no browser API and is tested in node.

## The lap server

**What it does.** When a player chooses to share a lap, the game posts the recorded flight (the
aircraft's pose over time, compressed). The server does not trust anything the client claims.
It re-times the lap from its own poses with the game's scoring function, checks that someone
could have flown it (speed limits, start and finish positions, ring order, resets on the course
line), and stores the result. A board is kept per course, mode, edition and aircraft variant, top
100. A lap that misses a ring or goes out of order is still stored and raceable from its link,
but is not ranked.

Players are not accounts. A player has a **handle** picked from a generated list and a random
**owner key** their device creates and keeps; the server stores only the key's hash. Deleting
your own lap needs that key.

**Run it locally** (no Cloudflare account; everything is `--local`, so nothing can reach a real
database):

```sh
npx wrangler@4.139.0 d1 migrations apply LAPS_DB --local \
  -c tools/net/wrangler.local.jsonc --persist-to .wrangler/state

printf 'ADMIN_TOKEN=local-admin-token-not-a-secret-0000\nIP_SALT=local-salt\n' > .dev.vars

pnpm build
npx wrangler@4.139.0 pages dev dist --d1 LAPS_DB=ff10yr-laps-local \
  --persist-to .wrangler/state --port 8788 --compatibility-date 2026-09-01

curl -s http://127.0.0.1:8788/api/board/int_01_hoverJet/ringAttack/anniversary/standard
```

`.dev.vars` is gitignored; put only fake values in it. The admin token must be 32 characters or
longer or the admin routes stay off. [lap-server.md](lap-server.md) has every endpoint, the error
codes and the moderation routes.

**Host your own.** Create a Cloudflare Pages project from your fork, then in its settings add:

| Binding | Kind | Notes |
|---|---|---|
| `LAPS_DB` | D1 database | Apply `migrations/0001_laps.sql` and `0002_moderation.sql` before the first deploy that binds it |
| `IP_SALT` | secret | Salts the hashed address the hourly limit counts by. Without it, every submit is refused |
| `ADMIN_TOKEN` | secret | 32 characters or more. Without a valid one, the admin routes answer 503: they are off, never open |
| `STATS` | Analytics Engine dataset | Optional. Without it, the stats endpoint accepts and drops rows |
| `ROOMS` | Durable Object namespace | Optional; see below. Without it, every room path answers 503 and the game says multiplayer is unavailable |

Do not commit a root `wrangler.toml` or `wrangler.jsonc` that has `pages_build_output_dir`: Pages
would take it as the project's configuration and make the dashboard's bindings read-only.

## Rooms

**What it does.** A room is one Cloudflare Durable Object, in a small Worker of its own
(`workers/rooms/`, built on `partyserver`). The game reaches it through a Pages Function on its own
origin, so there is no second hostname and no CORS. A room is a **relay with a clock**: it holds
the lobby, runs the start barrier, picks one GO moment on its own clock, and
passes each player's pose to the others. It runs no game code and decides no result. Every craft
in a room is intangible and each client steps only its own ship, so there is no contact to
arbitrate. Each finished lap is judged by the lap server's validator, and the results panel ranks
the judged times, not the claimed ones. A room that has been empty for a short while forgets
everything.

Rooms also have **watchers**: a viewer who opens a watch link gets a delayed fan-out of the
room's poses, which costs the room almost nothing per viewer. **Faceted Flight TV** is a list of
races currently running and an exhibition race for when none is, and it never shows a player's
handle or a room's code.

**Run it locally.** The easiest route is the test sidecar the browser specs use
(`tests/e2e/fixtures/room-sidecar.ts`, see [rooms.md](rooms.md)): two browsers in one room, with no
wrangler at all. To run the real Worker in workerd, [rooms.md](rooms.md) has the two-terminal
recipe (`wrangler dev` for the Worker, `wrangler pages dev` with the `ROOMS` binding for the
site).

**Host your own.**

1. In `workers/rooms/wrangler.jsonc`, change `ROOM_ORIGINS` to a pattern matching your site's
   origin. This is the allowlist for the Worker's direct route (WebSockets have no CORS, so the
   `Origin` check is all there is). The route through Pages is same-origin and needs none.
2. From `workers/rooms`, deploy with `npx wrangler@4.139.0 deploy`.
3. In your Pages project, add the `ROOMS` binding pointing at that Worker's `RoomDO` class.

If you change the wire format, bump `ROOM_PROTOCOL` in `src/net/room-protocol.ts` and redeploy the
Worker: it does not deploy with the site, and a client meeting an old Worker is refused with
close code 4002, which is that check working.

## Privacy

The game states exactly what it collects on its `/privacy` page, and that page is **generated
from the code's own constants** (`src/net/privacy-page.ts` imports the retention periods from the
server's policy), so it cannot claim "30 days" while the server keeps laps for 31. In summary:

- **No accounts, no advertising, no cookies.**
- **Laps**: the flight, the server's computed time, the rings taken, your handle and the hash of
  your owner key. A shared lap is served for 30 days if it is not on a board, and is never
  served after that. You can delete your own lap from the results panel.
- **Rate limiting** counts a salted hash of your address, held in a table that contains no laps
  and cleared when it is a day old. The address itself is never stored.
- **Moderation** (deleting a cheat, retiring a name) is logged with the lap's handle and owner
  hash and the reason, and the log entry is deleted after 90 days.
- **Rooms** hold the lobby while it exists: your handle, color and readiness, and any laps
  judged in it, for as long as the room lasts. A room keeps nothing once empty beyond a short
  rejoin window.
- **Statistics** answer "how is the game played" without being about anyone. Every row stands
  alone: no user, session or device id, no address, no cookie, no text a player typed. Rows are
  kept for three months and only totals are read, never a total under a minimum count. A
  switch on `/privacy` turns your own reports off. [stats.md](stats.md) lists every field.
- **What stays on your device**: settings, best times, your handle and owner key, courses you
  made. The page lists each storage key.

Questions about privacy go to the address on the live `/privacy` page, which is the single
constant `PRIVACY_CONTACT_EMAIL` in `src/net/privacy-page.ts`.

If you host your own copy, you are the operator of it. Read `src/net/privacy-page.ts`, change the
contact address to yours, and make sure the page still describes what your deployment does.
