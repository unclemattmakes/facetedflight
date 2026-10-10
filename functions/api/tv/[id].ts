// functions/api/tv/[id].ts — wss /api/tv/<tvId>: a TV viewer's socket. DEV-479.
//
// A shell over `src/net/room-route.ts`'s `routeToTvWatch`: the guide resolves
// the TV id to its room (404 before any upgrade when it cannot), and the
// upgrade goes to that room's broadcaster on `TV_WATCH_PATH`, which marks the
// socket anonymous — every handle it hears is *Racer N* (plan/FF-TV.md §2.2–2.3).

import type { PagesFunction } from '../../../src/net/pages-function'
import { type RoomEnv, routeToTvWatch } from '../../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv, 'id'> = ({ request, env }) =>
  routeToTvWatch(request, env)
