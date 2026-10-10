// functions/api/admin/audit.ts — what the server holds. DEV-374; `src/net/lap-admin.ts` is the whole of it.
//
//   GET /api/admin/audit[?id=&handle=&owner=&mission=&limit=]   Authorization: Bearer <ADMIN_TOKEN>
//
// Laps newest first with what no public route shows (the owner hash, the
// build, the distance), the totals, today's submits against the cap, every
// block, and the moderation log.

import { adminAudit } from '../../../src/net/lap-admin'
import type { LapEnv } from '../../../src/net/lap-server'
import type { PagesFunction } from '../../../src/net/pages-function'

export const onRequestGet: PagesFunction<LapEnv> = ({ request, env }) =>
  adminAudit(request, env, Date.now())
