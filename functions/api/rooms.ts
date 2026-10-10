// functions/api/rooms.ts: GET /api/rooms, the PUBLIC rooms. DEV-633.
//
// A shell over `src/net/room-route.ts`'s `routeToRoomList`, which asks the
// directory (the rooms class under `rooms.directory`, through the `ROOMS`
// binding) for the list: each listed room's code, course, phase and seats.

import type { PagesFunction } from '../../src/net/pages-function'
import { type RoomEnv, routeToRoomList } from '../../src/net/room-route'

export const onRequest: PagesFunction<RoomEnv> = ({ request, env }) => routeToRoomList(request, env)
