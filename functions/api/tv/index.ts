// functions/api/tv/index.ts — GET /api/tv: the races on Faceted Flight TV. DEV-479.
//
// A shell over `src/net/room-route.ts`'s `routeToTvList`, which asks the guide
// (the rooms class under `tv.guide`, through the `ROOMS` binding) for the list:
// each race under its TV id, never its room's code (plan/FF-TV.md §3.3).

import type { PagesFunction } from '../../../src/net/pages-function'
import { type RoomEnv, routeToTvList } from '../../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv> = ({ request, env }) => routeToTvList(request, env)
