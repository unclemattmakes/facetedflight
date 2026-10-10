// functions/api/watch/[id].ts — /api/watch/<id>: a viewer's WebSocket to that room's broadcaster. DEV-436.
//
// A shell over `src/net/room-route.ts`'s `routeToWatch`, which hands the upgrade
// to the room's broadcaster — the rooms class under another name, through the
// same `ROOMS` binding (docs/rooms.md, plan/MULTIPLAYER.md §13).

import type { PagesFunction } from '../../../src/net/pages-function'
import { type RoomEnv, routeToWatch } from '../../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv, 'id'> = ({ request, env }) =>
  routeToWatch(request, env)
