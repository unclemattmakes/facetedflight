// src/net/tv-admin.ts — Faceted Flight TV's off-air switch, behind ADMIN_TOKEN. DEV-479.
//
// plan/FF-TV.md §3.6 and old call 8 (taken as recommended): Matt can take one
// race off TV for its room's life, or put the whole list dark until a time.
// With no names and no codes on TV there is less to take off the air than a
// lap board has, so this is the whole of it:
//
//   GET    /api/admin/tv                                   the guide as it stands
//                                                          (room ids included: Matt's token)
//   POST   /api/admin/tv  { tv, reason? }                  one TV id off, for its room's life
//   POST   /api/admin/tv  { until, reason? }               the list dark until `until` (ms)
//   DELETE /api/admin/tv?tv=<id>[&reason=]                 that TV id back on
//   DELETE /api/admin/tv?dark=1[&reason=]                  the dark lifted
//
// DEV-374's door, unchanged: `adminRefusal` FIRST — before the body is read,
// the guide asked or the database touched — so a missing or short token is
// 503 (off, never open) and a wrong one 401, and
// `tests/unit/lap-admin.test.ts` calls every `onRequest*` under
// `functions/api/admin/` without the token. Each change is logged in D1's
// `admin_log` (`off-air` / `on-air`), so the database is checked BEFORE the
// guide is touched: a change that could not be logged is not made.
//
// SERVER-SAFE: web platform only. The clock comes in.

import { json, refuse } from './http'
import { adminRefusal, logged, reasonOf, unmigratedRefusal } from './lap-admin'
import type { LapEnv } from './lap-server'
import { type RoomEnv, tvGuideFor } from './room-route'
import { TV_ID_SHAPE } from './tv-protocol'

export type TvAdminEnv = LapEnv & RoomEnv

/** A TV admin route: the handler `functions/api/admin/tv.ts` is a shell over. */
export type TvAdminRoute = (request: Request, env: TvAdminEnv, now: number) => Promise<Response>

/** The token, then the guide, then the log's table; the handler gets both. */
const guarded =
  (
    handler: (
      request: Request,
      guide: NonNullable<ReturnType<typeof tvGuideFor>>,
      log: (
        action: 'off-air' | 'on-air',
        target: string,
        reason: string,
        detail: unknown,
      ) => Promise<void>,
    ) => Promise<Response>,
  ): TvAdminRoute =>
  async (request, env, now) => {
    const refused = await adminRefusal(request, env)
    if (refused) return refused
    const guide = tvGuideFor(env)
    if (!guide) return refuse(503, 'unconfigured', 'rooms are not configured here')
    const db = env.LAPS_DB
    if (!db) return refuse(503, 'unconfigured', 'the lap server has no database bound')
    try {
      await db.prepare('SELECT 1 FROM admin_log LIMIT 1').all()
    } catch (e) {
      const unmigrated = unmigratedRefusal(e)
      if (unmigrated) return unmigrated
      throw e
    }
    return handler(request, guide, async (action, target, reason, detail) => {
      await logged(db, now, { action, target, count: 0, reason, detail }).run()
    })
  }

/** The guide as it stands. */
export const adminTvState: TvAdminRoute = guarded(async (_request, guide) =>
  json(200, await guide.state()),
)

/** Off the air: one TV id, or everything until a time. */
export const adminTvOffAir: TvAdminRoute = guarded(async (request, guide, log) => {
  let body: { tv?: unknown; until?: unknown; reason?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return refuse(400, 'body', 'a JSON body: { tv } or { until }')
  }
  const reason = reasonOf(body.reason)
  if (typeof body.tv === 'string' && TV_ID_SHAPE.test(body.tv)) {
    if (!(await guide.offAir({ tv: body.tv }))) return refuse(502, 'guide', 'the guide refused')
    await log('off-air', `tv:${body.tv}`, reason, { tv: body.tv })
    return json(200, { ok: true, tv: body.tv })
  }
  if (typeof body.until === 'number' && Number.isFinite(body.until)) {
    if (!(await guide.offAir({ until: body.until }))) {
      return refuse(502, 'guide', 'the guide refused')
    }
    await log('off-air', 'tv:all', reason, { until: body.until })
    return json(200, { ok: true, until: body.until })
  }
  return refuse(400, 'body', 'a TV id (tv_ and 16 characters) or an `until` in ms')
})

/** Back on: one TV id, or the dark lifted. */
export const adminTvOnAir: TvAdminRoute = guarded(async (request, guide, log) => {
  const q = new URL(request.url).searchParams
  const reason = reasonOf(q.get('reason'))
  const tv = q.get('tv')
  if (tv !== null && TV_ID_SHAPE.test(tv)) {
    if (!(await guide.onAir({ tv }))) return refuse(502, 'guide', 'the guide refused')
    await log('on-air', `tv:${tv}`, reason, { tv })
    return json(200, { ok: true, tv })
  }
  if (q.get('dark') === '1') {
    if (!(await guide.onAir({ dark: true }))) return refuse(502, 'guide', 'the guide refused')
    await log('on-air', 'tv:all', reason, { dark: false })
    return json(200, { ok: true })
  }
  return refuse(400, 'query', '?tv=<id> or ?dark=1')
})
