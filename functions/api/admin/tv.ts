// functions/api/admin/tv.ts — Faceted Flight TV's off-air switch. DEV-479; `src/net/tv-admin.ts` is the whole of it.
//
//   GET    /api/admin/tv                              the guide as it stands
//   POST   /api/admin/tv  { tv, reason? }             one TV id off, for its room's life
//   POST   /api/admin/tv  { until, reason? }          the whole list dark until `until` (ms)
//   DELETE /api/admin/tv?tv=<id> | ?dark=1[&reason=]  back on
//
// All of them: Authorization: Bearer <ADMIN_TOKEN>, checked first (DEV-374's
// `adminRefusal`); each change logged in `admin_log`.

import type { PagesFunction } from '../../../src/net/pages-function'
import {
  adminTvOffAir,
  adminTvOnAir,
  adminTvState,
  type TvAdminEnv,
} from '../../../src/net/tv-admin'

export const onRequestGet: PagesFunction<TvAdminEnv> = ({ request, env }) =>
  adminTvState(request, env, Date.now())

export const onRequestPost: PagesFunction<TvAdminEnv> = ({ request, env }) =>
  adminTvOffAir(request, env, Date.now())

export const onRequestDelete: PagesFunction<TvAdminEnv> = ({ request, env }) =>
  adminTvOnAir(request, env, Date.now())
