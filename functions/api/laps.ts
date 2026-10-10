// functions/api/laps.ts — /api/laps. DEV-372; `src/net/lap-server.ts` is the whole of it.
//
//   POST   /api/laps           submit a lap: { lap, seconds, handle, owner }
//   GET    /api/laps?id=<id>   one lap, to race against
//   DELETE /api/laps?id=<id>   your own lap, with its owner key in `X-FF-Owner`
//
// A shell, so the clock is read here and nowhere else.

import { deleteLap, getLap, type LapEnv, submitLap } from '../../src/net/lap-server'
import type { PagesFunction } from '../../src/net/pages-function'

export const onRequestPost: PagesFunction<LapEnv> = ({ request, env }) =>
  submitLap(request, env, Date.now())

export const onRequestGet: PagesFunction<LapEnv> = ({ request, env }) =>
  getLap(request, env, Date.now())

export const onRequestDelete: PagesFunction<LapEnv> = ({ request, env }) => deleteLap(request, env)
