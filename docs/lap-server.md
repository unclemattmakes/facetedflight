# The lap server

**What it is.** Cloudflare Pages Functions in this repository (`functions/`),
backed by D1, that take a player's shared lap, time it again from its own poses
with the game's `scoreGhost`, check that somebody could have flown it, and keep
it for racing and for a board.

| file | what it is |
|---|---|
| `functions/api/laps.ts` | `POST` submit, `GET ?id=`, `DELETE ?id=` |
| `functions/api/board/[mission]/[mode]/[edition]/[variant].ts` | `GET` a board, one per aircraft variant |
| `functions/api/admin/{laps,handles,blocks,audit}.ts` | the admin routes, behind `ADMIN_TOKEN` (DEV-374, [below](#moderation)) |
| `functions/privacy.ts` | `/privacy` |
| `src/net/lap-server.ts` | the handlers the Functions are shells over |
| `src/net/lap-admin.ts` | the admin handlers, every one through one token check |
| `src/net/lap-validate.ts` | the judgement: pure, node-tested |
| `src/net/lap-policy.ts` | every threshold, each with its reason |
| `content/lap-courses.json` | the courses, GENERATED (`node tools/net/write-lap-courses.mjs`) |
| `migrations/0001_laps.sql` | the D1 schema: `laps`, `rate` |
| `migrations/0002_moderation.sql` | `blocks`, `admin_log`, and two indexes (DEV-374) |

## Bindings

Configured in the Cloudflare dashboard (Pages › `ff-10yr` › Settings), **by
these names, on both environments**. No value and no database id is in this
repository.

| binding | kind | production (`release`) | preview (`main` and branches) |
|---|---|---|---|
| `LAPS_DB` | D1 database | `ff10yr-laps` | `ff10yr-laps-preview` |
| `IP_SALT` | secret | set by Matt | set by Matt |
| `ADMIN_TOKEN` | secret | set by Matt | set by Matt |

- `LAPS_DB` is the only store. Preview binds its own database, so a push to
  `main` never writes the real board.
- `IP_SALT` salts the address hash the rate limit counts by. **Without it the
  server refuses every submit** (503) rather than count raw addresses.
- `ADMIN_TOKEN` is read by the admin routes (DEV-374) and by nothing else. It
  must be **at least 32 characters** (`ADMIN_TOKEN_MIN_LENGTH`), or the admin
  routes answer 503 and do nothing: they are OFF, never open. Make one with
  `openssl rand -base64 32` (44 characters) and keep it in a password manager;
  it is in no file here, and is never put in a URL.

There is **no Wrangler file at the repository root, and there must not be one**
with `pages_build_output_dir` in it: Pages would take that file as the
project's configuration on the next deploy and the dashboard's bindings above
would turn read-only. `tools/net/wrangler.local.jsonc` is local-only and lives
where Pages never looks.

## Endpoints

| | request | answer |
|---|---|---|
| submit | `POST /api/laps`, JSON `{ lap, seconds, handle, owner }` | `201 { id, variant, seconds, ticks, rings, ringsTotal, score2016, board, rank, boardReason, expiresAt }` |
| a lap | `GET /api/laps?id=<id>` | `200 { id, mission, mode, edition, variant, rules, vehicle, handle, ticks, seconds, rings, ringsTotal, score2016, board, createdAt, expiresAt, lap }` |
| delete your lap | `DELETE /api/laps?id=<id>`, header `X-FF-Owner: <owner key>` | `204`, or `404` for a wrong key and a missing lap alike |
| a board | `GET /api/board/<mission>/<mode>/<edition>/<variant>[?limit=N]` | `200 { mission, mode, edition, variant, rules, entries: [{ rank, id, handle, seconds, ticks, rings, score2016, createdAt }] }`; 404 for a variant that edition does not fly |

- `lap` is base64url (no padding) of **raw deflate** (`CompressionStream('deflate-raw')`)
  of `lapToBytes(doc)` — the `ff2-ghost-2` wire from `src/sim/ghost-record.ts`.
- `seconds` is what the client's clock said. It is COMPARED with the server's
  rescore (one tick of tolerance) and never stored.
- `handle` must be one `src/net/handles.ts` can generate; `owner` is a random
  key of 22–128 base64url characters the device makes and keeps. The server
  stores its SHA-256.
- The lap names its aircraft: `vehicle` is `lapVehicle(level.vehicle, variant)`,
  `<vehicle>:<variant>`, standard included. **A board is per aircraft variant**
  (DEV-380), and the variant is checked, not trusted: it must be one the
  lap's edition flies on that course — Classic flies `standard` only — or the
  lap is refused at `course`. It is then judged by that variant's own ceiling.
- The lap's own `rules` must be `lapRules(mission, edition, variant)` from
  `src/net/lap-courses.ts`: the recorder reads it from there. Each variant's
  board has its own rules string.
- `/privacy` sends questions to an email address through ONE constant,
  `PRIVACY_CONTACT_EMAIL` in `src/net/privacy-page.ts` (linked as
  `PRIVACY_CONTACT_URL`, a `mailto:`). DEV-535 replaced this private
  repository's GitHub issues, which a stranger could not open. It delivers
  through an Email Routing rule on the Cloudflare zone, which Matt adds.
  `pnpm release:list` allows the address in that file only, reports it on
  every run, and refuses the copy if a link into the private repository
  appears anywhere.
- A refusal is `{ error, reason }`: `400` a bad body, `403` a blocked device or
  a retired handle (`error: 'blocked'`, DEV-374), `413` too big, `422` a lap
  the validator refused (`error` names the stage), `429` the hourly limit,
  `503` unconfigured or the day's cap reached.
- The game posts only on a yes (DEV-571): after every lap the results panel's
  menu asks *POST TO LEADERBOARD?*, NO until its row is pressed, with the
  name it would post under on screen first.
- The game's delete is the results panel's (DEV-374): once a lap is posted,
  the same row asks *"TAKE THIS LAP DOWN?"* (DEV-571's words), and the press
  after sends `DELETE /api/laps?id=` with the device's owner key
  (`ff2.owner.v1`). A lap posted earlier is deleted by asking (`/privacy`),
  which is an admin delete.
- A lap that misses a ring, or takes them out of order, is still stored and
  raceable from its link, but `board: false` (call 3). So is a lap slower than
  the same device's lap already on that board, and one outside the top 100.
- **Who reads a board** (DEV-431): the hangar's ghost line, on a press (DEV-373),
  and the **results panel**, which asks once each time a solo Ring Attack run
  ends on a boarded course, and again after a Share or a delete lands. Those two
  go past the browser's cache (`cache: 'no-cache'`), because the answer's
  `max-age=30` would otherwise hand back the board without the lap the panel
  had just posted. Every one is a Function request and a D1 read (see The
  bill). The request carries nothing of the player's: no handle, no key.
  Which line is the player's is decided on the device (`game/results-board.ts`).

The executable form of all of this is `tests/unit/lap-server.test.ts`, which
runs the handlers against a real SQLite with the migration applied.

## Moderation

D30: *"best-effort and moderatable. We deter casual cheating and delete the
rest."* These are the deleting. Every route below needs
`Authorization: Bearer <ADMIN_TOKEN>`, checked before anything else is read;
without it the answer is `401`, and with no token (or one under 32 characters)
configured it is `503`. `tests/unit/lap-admin.test.ts` calls every `onRequest*`
under `functions/api/admin/` without the token.

| | request | does |
|---|---|---|
| delete a lap | `DELETE /api/admin/laps?id=<id>[&reason=]` | deletes any lap, whoever posted it |
| wipe a handle | `DELETE /api/admin/handles?handle=<handle>[&reason=][&block=0]` | deletes every lap under the handle, from every device, and RETIRES it (a block on the name) unless `block=0` |
| block | `POST /api/admin/blocks`, JSON `{ kind, value \| lap, reason?, wipe? }` | `kind: 'owner'` blocks a device, named by one of its laps (`lap: <id>`) or by its owner hash (`value`, as the audit shows it); `kind: 'handle'` retires a name. `wipe: true` also deletes every lap the block covers |
| the blocks | `GET /api/admin/blocks` | every block, newest first |
| lift a block | `DELETE /api/admin/blocks?kind=<kind>&value=<value>[&reason=]` | the device or name may post again |
| audit | `GET /api/admin/audit[?id=&handle=&owner=&mission=&limit=]` | laps newest first with what no public route shows (owner hash, build, distance, expiry), totals, today's submits against the daily cap, the blocks, and the log |

- **A block is checked on every submit**, after the rate count and before the
  validator: a blocked device or a retired handle gets `403 blocked`. A device
  is its owner key, so clearing that browser's storage escapes a block; D30
  accepts that. There is no address block, because no lap holds an address.
- **Every change is logged** in `admin_log` (what was removed, its handle and
  owner hash, and the reason) and the log row is deleted `ADMIN_LOG_DAYS`
  (90) days on, at the next submit or admin request. `/privacy` says so.
- **Until `0002_moderation.sql` is applied** to a database, submits there
  work exactly as before (no table, no blocks) and the admin routes answer
  `503 unmigrated`. So the deploy and the migration can land in either order.

From a shell, with the token in an environment variable rather than on the
command line (`read -rs FF_ADMIN_TOKEN` keeps it out of the history):

```bash
export FF_BASE=https://main.ff-10yr.pages.dev     # preview; the real board is https://ff-10yr.pages.dev
read -rs FF_ADMIN_TOKEN && export FF_ADMIN_TOKEN
auth=(-H "Authorization: Bearer $FF_ADMIN_TOKEN")

curl -s "${auth[@]}" "$FF_BASE/api/admin/audit?limit=20"
curl -s "${auth[@]}" "$FF_BASE/api/admin/audit?handle=Swift%20Kestrel%2042"
curl -s "${auth[@]}" -X DELETE "$FF_BASE/api/admin/laps?id=<id>&reason=cheat"
curl -s "${auth[@]}" -X DELETE "$FF_BASE/api/admin/handles?handle=<url-encoded handle>&reason=name"
curl -s "${auth[@]}" -X POST "$FF_BASE/api/admin/blocks" -H 'content-type: application/json' \
  -d '{"kind":"owner","lap":"<id>","reason":"teleport","wipe":true}'
curl -s "${auth[@]}" "$FF_BASE/api/admin/blocks"
curl -s "${auth[@]}" -X DELETE "$FF_BASE/api/admin/blocks?kind=owner&value=<64-hex hash>"
```

A cheat at the top of a board is usually: audit the board's mission, delete
the lap and block its device in one call (`POST /api/admin/blocks` with
`lap` and `wipe: true`). A name nobody should see is: wipe the handle.

## Run it locally

A local D1 is a SQLite file under `.wrangler/state` (gitignored). Nothing here
can reach `ff10yr-laps` or `ff10yr-laps-preview`: every command is `--local`,
the config names a database id that is only a file name, and there is no
`--remote` anywhere in this section.

```bash
# 1. The schema, into a LOCAL database.
npx wrangler@4.139.0 d1 migrations apply LAPS_DB --local \
  -c tools/net/wrangler.local.jsonc --persist-to .wrangler/state

# 2. Obviously fake secrets. `.dev.vars` is gitignored; never put a real value in it.
#    The admin token must be 32 characters or more, or the admin routes stay off.
printf 'ADMIN_TOKEN=local-admin-token-not-a-secret-0000\nIP_SALT=local-salt\n' > .dev.vars

# 3. Something to serve beside the Functions: the game (`pnpm build` -> dist/),
#    or any directory with an index.html if only the API is under test.
pnpm build

# 4. The Functions, bound to that local database by its id.
npx wrangler@4.139.0 pages dev dist --d1 LAPS_DB=ff10yr-laps-local \
  --persist-to .wrangler/state --port 8788 --compatibility-date 2026-09-01

# 5. Try it.
curl -s http://127.0.0.1:8788/api/board/int_01_hoverJet/ringAttack/anniversary/standard
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/privacy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/admin/audit   # 401
curl -s -H 'Authorization: Bearer local-admin-token-not-a-secret-0000' \
  http://127.0.0.1:8788/api/admin/audit                                         # 200
```

A lap to submit is a real one: `src/game/autopilot-lap.ts` flies
`int_01` with the autopilot, and `recordedLap` → `lapToBytes` → deflate-raw →
base64url is the `lap` field. `wrangler pages dev` prints the bindings it made
on start: check `env.LAPS_DB` says `local`.

On Windows, stop `pages dev` with Ctrl+C in its own terminal. Killing the shell
that launched it from a script leaves `workerd.exe` listening on the port.

## Deploying

Pages is Git-connected: `main` deploys to preview and `release` to production,
and each deployment builds `functions/` itself. The schema must be in a
database **before** a deployment that binds it takes a submit, or the first
one fails with `no such table`.

Migrations need a Wrangler config that names the database. Write one OUTSIDE
the repository with the real id from the dashboard (D1 › the database ›
Database ID), run the migration against it, and delete it:

```bash
cat > /tmp/laps-preview.jsonc <<'JSON'
{ "name": "ff-10yr-migrate", "compatibility_date": "2026-09-01",
  "d1_databases": [{ "binding": "LAPS_DB", "database_name": "ff10yr-laps-preview",
    "database_id": "<ff10yr-laps-preview id>", "migrations_dir": "<absolute path to this repo>/migrations" }] }
JSON
npx wrangler@4.139.0 d1 migrations apply ff10yr-laps-preview --remote -c /tmp/laps-preview.jsonc
```

then the same for `ff10yr-laps` before the merge to `release`. (Both databases
have had 0001 and 0002 since v0.11.0, 2026-09-25; the next file is the next
thing to apply.)
`wrangler d1 migrations apply` records what it applied in the database's own
`d1_migrations` table, so running it twice is harmless, and it applies every
file in `migrations/` it has not recorded — `0002_moderation.sql` (DEV-374)
included, by the same command. 0002 may go before or after the deployment
that reads it (see Moderation).

What to check on the deployment afterwards: `GET /privacy` is 200 HTML, and
`GET /api/board/int_01_hoverJet/ringAttack/anniversary/standard` is 200 with the current
`rules` and an empty `entries` — a 503 there means `LAPS_DB` is not bound on
that environment. `GET /api/admin/audit` with no token is `401`; with the
token it is `200`, or `503 unmigrated` until 0002 is in.

## The bill

**Matt's step; nothing in this repository sets it, and no agent should.** The
lap server adds Pages Functions requests (Workers requests) and D1 reads,
writes and storage to the account. **The account is on the Workers Free plan**
(as of 2026-09-25), and what an overrun does
depends on that:

- **On Free, the lap server cannot bill.** Past 100,000 Workers requests a day
  (shared with multiplayer's rooms and with `/privacy`), or D1's daily row
  limits, requests FAIL until 00:00 UTC: the cost is an outage of sharing, not
  a charge. There is no budget alert to set for it; the early sign is the
  audit's `today.submits` against `cap`.
- **The day the account moves to Workers Paid**, set a **budget alert** in the
  same sitting: Dashboard › Manage Account › Billing › **Billable Usage** ›
  **Create budget alert**, with a dollar threshold (a few dollars over the $5
  subscription is a clear signal at this scale) and Matt's address. It is
  account-wide (Workers, D1 and R2 in one), and it notifies; it does not cap.
- **What can bill today is R2**, the asset bucket, outside the lap server.
  `asset-storage.md` §5 records a billing alert created with it on 2026-09-09.
  **Matt confirms** in Billable Usage that it is there and is account-wide
  rather than R2's alone (budget alerts are offered to pay-as-you-go accounts,
  so whether one can be made on this account is itself the thing to look at).

D30's hard storage cap is the server's own (`LAP_DAILY_CAP`); the alert is for
everything the cap does not bound.
