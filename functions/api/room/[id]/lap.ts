// functions/api/room/[id]/lap.ts — a room lap, judged; and a judged lap, to race. DEV-390.
//
//   POST /api/room/<id>/lap              { lap, seconds, seat, tainted }
//   GET  /api/room/<id>/lap?slot=<n>     a judged lap's wire text
//
// A shell over `src/net/room-lap.ts`. The judge runs HERE, in the build that
// served the client, and hands its verdict to the room over the binding
// (plan/MULTIPLAYER.md §6.5; docs/rooms.md).

import type { PagesFunction } from '../../../../src/net/pages-function'
import { fetchRoomLap, judgeRoomLap } from '../../../../src/net/room-lap'
import { type RoomEnv, roomLinkFor } from '../../../../src/net/room-route'

const idOf = (params: Readonly<Record<'id', string | string[]>>): string | undefined =>
  typeof params.id === 'string' ? params.id : undefined

export const onRequestPost: PagesFunction<RoomEnv, 'id'> = ({ request, env, params }) =>
  judgeRoomLap(request, roomLinkFor(env, idOf(params)))

export const onRequestGet: PagesFunction<RoomEnv, 'id'> = ({ request, env, params }) =>
  fetchRoomLap(request, roomLinkFor(env, idOf(params)))
