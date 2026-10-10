-- migrations/0001_laps.sql — the lap server's tables. DEV-372.
--
-- D1 (SQLite). Applied by `wrangler d1 migrations apply`, which records it in
-- its own `d1_migrations` table so it runs once per database. The binding is
-- LAPS_DB on both environments (docs/lap-server.md); this file never names a
-- database.
--
-- Two tables, and the line between them is the privacy promise on /privacy:
-- `laps` never holds an address, and `rate` never holds a lap.

-- One row per lap the server accepted. Everything a board shows was RECOMPUTED
-- from the poses (src/net/lap-validate.ts); nothing the client claimed is kept.
CREATE TABLE laps (
  id          TEXT    PRIMARY KEY,          -- 10 base62 characters: the share link
  mission     TEXT    NOT NULL,
  mode        TEXT    NOT NULL,
  edition     TEXT    NOT NULL,
  variant     TEXT    NOT NULL,             -- the aircraft variant (DEV-380): a board each
  rules       TEXT    NOT NULL,             -- content/lap-courses.json's rules string
  vehicle     TEXT    NOT NULL,
  build       TEXT    NOT NULL,             -- the client's build id, as it said
  handle      TEXT    NOT NULL,             -- from the generated list (src/net/handles.ts)
  owner_hash  TEXT    NOT NULL,             -- SHA-256 of the device's owner key; the key is never stored
  ticks       INTEGER NOT NULL,             -- the finish tick, recomputed
  seconds     REAL    NOT NULL,             -- the finish time, recomputed
  rings       INTEGER NOT NULL,
  rings_total INTEGER NOT NULL,
  distance    REAL    NOT NULL,             -- metres flown to the finish
  score2016   INTEGER NOT NULL,             -- 2016's leaderboard number, for display
  board       INTEGER NOT NULL,             -- 1 while it holds a place on its board
  created_at  INTEGER NOT NULL,             -- ms since the epoch
  expires_at  INTEGER,                      -- ms; NULL while on a board, which keeps it
  lap         TEXT    NOT NULL              -- base64url of the deflated ff2-ghost-2 wire
);

-- A board: its key (mission, mode, edition, aircraft variant, rules), then the
-- order it is read in.
CREATE INDEX laps_board ON laps (mission, mode, edition, variant, rules, board, seconds, created_at);

-- The expiry sweep reads only laps that can expire.
CREATE INDEX laps_expiry ON laps (expires_at) WHERE expires_at IS NOT NULL;

-- Submits counted per salted address hash per hour, and one global row per
-- day ('*'). The hash is SHA-256 of IP_SALT and the address: the salt is a
-- secret, so the table cannot be reversed by hashing every address. A row is
-- deleted a day after the hour it starts at, as submits arrive, so no hash is
-- kept for more than two days.
CREATE TABLE rate (
  bucket TEXT    PRIMARY KEY,               -- '<hash>:<hour>' or '*:<day>'
  win    INTEGER NOT NULL,                  -- the HOUR it starts at (a day row: its first hour)
  count  INTEGER NOT NULL
);

CREATE INDEX rate_win ON rate (win);
