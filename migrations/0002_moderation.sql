-- migrations/0002_moderation.sql — the lap server's moderation tables. DEV-374.
--
-- D30: "best-effort and moderatable. We deter casual cheating and delete the
-- rest." 0001 is the deterring; this is what the deleting needs: a list of
-- what may no longer post, and a log of what was removed and why. Read and
-- written only by `src/net/lap-admin.ts`'s routes, behind ADMIN_TOKEN, and by
-- one read on the submit path (`blockOf` in `src/net/lap-server.ts`).
--
-- SAFE TO DEPLOY BEFORE IT IS APPLIED. The submit path reads a missing table
-- as "no blocks" (there can be none without it) and keeps taking laps; the
-- admin routes answer 503 `unmigrated` until it is in. So the order of a
-- deploy and this migration cannot break a submit. Apply it the way 0001 was
-- (docs/lap-server.md, "Deploying").
--
-- Nothing here holds an address, and nothing holds an owner key: a block on a
-- device is the SHA-256 `laps.owner_hash` already holds. `/privacy` says how
-- long each row lives.

-- What may not post. `owner` is a device (the hash of its owner key, as
-- `laps.owner_hash`); `handle` is a name retired from the generated list. There
-- is no address block, on purpose: a lap never holds an address (0001), so
-- there is nothing that could link a lap to one. Kept until it is lifted.
CREATE TABLE blocks (
  kind       TEXT    NOT NULL CHECK (kind IN ('owner', 'handle')),
  value      TEXT    NOT NULL,              -- owner: 64 hex characters; handle: as generated
  reason     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,              -- ms since the epoch
  PRIMARY KEY (kind, value)
);

-- One row per admin action that changed something. Deleted `ADMIN_LOG_DAYS`
-- (`src/net/lap-policy.ts`) after it was written, at the next submit or admin
-- request, whichever comes first.
CREATE TABLE admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,                 -- ms since the epoch
  action  TEXT    NOT NULL,                 -- delete-lap | wipe-handle | block | unblock
  target  TEXT    NOT NULL,                 -- a lap id, a handle, or '<kind>:<value>'
  count   INTEGER NOT NULL,                 -- laps the action deleted
  reason  TEXT    NOT NULL,
  detail  TEXT    NOT NULL                  -- JSON: what was removed, as the audit showed it
);

CREATE INDEX admin_log_at ON admin_log (at);

-- A device's laps and a handle's laps, found without reading the whole table:
-- the block check on every submit, a block that also wipes, and the audit.
CREATE INDEX laps_owner ON laps (owner_hash);
CREATE INDEX laps_handle ON laps (handle);
