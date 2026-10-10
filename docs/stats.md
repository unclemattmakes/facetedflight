# Gameplay statistics

The operating manual for `/api/stats`, beside [`lap-server.md`](lap-server.md).
What is deliberately NOT collected is stated in the line below.

**The line, in one sentence:** every row answers its question alone, so no row
holds anything that joins it to another row, another visit or another device.
No user, session or device id, no address, no cookie, no text a player typed.

## What is where

| piece | file |
|---|---|
| what a row may hold: the four kinds, every field, every bucket | `src/net/stats-schema.ts` |
| the handler: validate, write, answer 204 | `src/net/stats-server.ts` |
| the Function | `functions/api/stats.ts` |
| the tests, including what is never written | `tests/unit/stats-server.test.ts` |
| the game's half: what a row says, and when a page sends nothing | `src/game/stats-tally.ts` |
| the page's half: listeners, sampling, the send | `src/boot/stats-beacon.ts` (`stats.*` one-liners in `boot/app.ts`, `startStats()` in `main.ts`) |
| the report: canned queries, the small-cell rule | `tools/stats/stats.mjs` (`pnpm stats`), `tools/stats/columns.mjs` |
| the off switch on /privacy | `src/net/privacy-script.ts` (inlined by the page: a build ships no `public/`), key `ff2.stats.off.v1` |

## Bindings

| binding | kind | production (`release`) | preview (`main` and branches) |
|---|---|---|---|
| `STATS` | Analytics Engine dataset | `ff10yr_stats` | `ff10yr_stats_preview` |

**First, once per Cloudflare account: enable Analytics Engine** (Storage &
databases, Analytics Engine, Enable). The binding form saves without it, and
then every deploy FAILS at its last step with *"Failed to publish your
Function ... You need to enable Analytics Engine"*: the build passes, the assets
upload, and the site keeps serving the previous deploy. 0.19.0's first two
deploys failed exactly so on 2026-10-03; it was enabled the same day.

Then the binding, in the dashboard, as `LAPS_DB` is: Workers & Pages, the
`ff-10yr` project, Settings, Bindings, Add, Analytics engine; variable name
`STATS`, and the dataset name per environment. A dataset is created by its
first write; there is no step after that. **Never commit a root wrangler config** to do this
(`lap-server.md`: it takes over the dashboard's bindings).

With no binding the endpoint validates, writes nothing and still answers 204,
so a deploy before the binding exists is safe, and the game cannot tell.

## The endpoint

`POST /api/stats`, body `{ "rows": [ ... ] }` (any content type: the game sends
it with `navigator.sendBeacon`). At most 32 rows and 16 KB. Each row is
`{ "k": "<kind>", <every field of that kind by name> }`.

A row is dropped WHOLE if its kind is unknown, if it names a field its kind does
not list, if it omits one, if an enum value is off its list, if a text field
fails its shape, or if a number is not finite (a flag must be 0 or 1). Counts
are clamped and rounded. A request from another site's page (a foreign
`Origin`) is refused whole. The answer is always 204 with no body.

A **bug report** (DEV-622, kind `bug`) is the one row a player sends on
purpose, from REPORT BUG's SEND, and the one answered with a body: `200
{ "id": "K7QX4M" }`, a short id the server makes (`newBugId`) that names the
report and nothing else. It is sent even where passive statistics are off,
because the press is the asking (`/privacy` says so).

What the server adds, and nothing else: blob1, the kind; blob2, the schema
version (`STATS_SCHEMA`); on a visit row only, the request's country as
Cloudflare gives it (`XX` if none); and the index (`visit`, the mission id, or
for an error a hash of its cleaned message and frame).

## Columns

Analytics Engine names columns by position: `blob1` to `blob20`, `double1` to
`double20`, `index1`. For every kind, blob1 is the kind, blob2 the schema
version, then the kind's TEXT fields in the order `stats-schema.ts` lists them;
the kind's NUMBER fields fill `double1` upward in the same order. A visit's
country is the last blob. **Reordering a list renames history**: append, or bump
`STATS_SCHEMA`. `pnpm stats` (DEV-594) reads the lists to name the columns.

## When a page sends nothing

`statsAllowed` (`game/stats-tally.ts`): a build that is not production, a host
that is this machine or a LAN address, any URL switch that is not a player's
(a room, TV, ghost, mission or look link, or a referrer's `utm_*` tag),
Global Privacy Control, Do Not Track, or the /privacy button's key. So `pnpm
dev`, `vite preview`, the e2e suite, a LAN headset and every `?perf=1`
measurement send nothing, by the rule a player's browser follows too.

## Reading

**`pnpm stats`** (DEV-594, `tools/stats/stats.mjs`) runs the canned queries
and writes one HTML report to a gitignored folder under `docs/` (the tool prints the path):

```bash
CF_ACCOUNT_ID=<account id> CF_STATS_TOKEN=<token> pnpm stats --days 7
```

The token is an account API token with **Account Analytics: Read** and
nothing else, made by Matt in the dashboard (My Profile, API Tokens); neither
value goes in the repository. `--preview` reads `ff10yr_stats_preview`. The
script names every column from the schema (`tools/stats/columns.mjs`, held to
the server's layout by `tests/unit/stats-columns.test.ts`), applies the
small-cell rule to everything but bug reports, and says how many groups it hid.

Underneath, it is SQL over Cloudflare's API. Rows are kept three months. At volume
Analytics Engine samples: weight every count by `_sample_interval`. **Show no
cell under ten rows** (the line above): a rare device on a rare course in a
rare country is one person.

```sql
SELECT blob7 AS stage, SUM(_sample_interval) AS visits
FROM ff10yr_stats
WHERE blob1 = 'visit' AND double1 = 0 AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY stage HAVING visits >= 10
```

That is where visits stood at their FIRST send. A visit that is hidden and
comes back sends again, and each row carries `stageBefore` (double1) and
`xrBefore` (double2): where the previous send stood, as index + 1 in the list,
0 on a first row. So "visits that reached stage S" is the rows where
`stageBefore < index(S) + 1 <= index(stage) + 1`, summed over every row: each
visit counted once per stage, and no key between its rows.

## Try it

```bash
pnpm vitest run tests/unit/stats-server.test.ts
```
