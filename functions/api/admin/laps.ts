// functions/api/admin/laps.ts — delete any lap. DEV-374; `src/net/lap-admin.ts` is the whole of it.
//
//   DELETE /api/admin/laps?id=<id>[&reason=<text>]    Authorization: Bearer <ADMIN_TOKEN>
//
// A shell, so the clock is read here and nowhere else. Every export under
// `functions/api/admin/` is a `lap-admin.ts` route, and every one of those
// checks the token first (`tests/unit/lap-admin.test.ts` calls each without it).

import { adminDeleteLap } from '../../../src/net/lap-admin'
import type { LapEnv } from '../../../src/net/lap-server'
import type { PagesFunction } from '../../../src/net/pages-function'

export const onRequestDelete: PagesFunction<LapEnv> = ({ request, env }) =>
  adminDeleteLap(request, env, Date.now())
