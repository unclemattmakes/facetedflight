// functions/api/room/[id]/tv.ts — GET /api/room/<code>/tv: WATCH ME. DEV-479.
//
// A shell over `src/net/room-route.ts`'s `routeToRoomTv`. A player in a room
// asks for its TV id to share a link that never carries the code: the room
// mints one at first need and keeps it for its life (plan/FF-TV.md §2.6).
// Same origin only; never cached; 404 where no such room is in use.

import type { PagesFunction } from '../../../../src/net/pages-function'
import { type RoomEnv, routeToRoomTv } from '../../../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv, 'id'> = ({ request, env, params }) =>
  routeToRoomTv(request, env, typeof params.id === 'string' ? params.id : undefined)
