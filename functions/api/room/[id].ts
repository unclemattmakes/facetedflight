// functions/api/room/[id].ts — /api/room/<id>: a WebSocket to that room. DEV-386.
//
// A shell over `src/net/room-route.ts`, which hands the upgrade to the room's
// Durable Object through the `ROOMS` binding (docs/rooms.md).

import type { PagesFunction } from '../../../src/net/pages-function'
import { type RoomEnv, routeToRoom } from '../../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv, 'id'> = ({ request, env }) =>
  routeToRoom(request, env)
