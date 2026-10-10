// functions/api/stats.ts: /api/stats. DEV-589; `src/net/stats-server.ts` is the whole of it.
//
//   POST /api/stats   { rows: [...] }, gameplay statistics, always answered 204
//
// docs/stats.md is the operating manual; docs/plan/ANALYTICS.md the why.

import type { PagesFunction } from '../../src/net/pages-function'
import { postStats, type StatsEnv } from '../../src/net/stats-server'

export const onRequestPost: PagesFunction<StatsEnv> = ({ request, env }) => postStats(request, env)
