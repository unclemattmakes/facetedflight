// functions/api/admin/blocks.ts — who may not post. DEV-374; `src/net/lap-admin.ts` is the whole of it.
//
//   GET    /api/admin/blocks                                      every block
//   POST   /api/admin/blocks  { kind, value | lap, reason?, wipe? }   block a device or a handle
//   DELETE /api/admin/blocks?kind=<kind>&value=<value>[&reason=]  lift one
//
// All three: Authorization: Bearer <ADMIN_TOKEN>.

import { adminBlock, adminListBlocks, adminUnblock } from '../../../src/net/lap-admin'
import type { LapEnv } from '../../../src/net/lap-server'
import type { PagesFunction } from '../../../src/net/pages-function'

export const onRequestGet: PagesFunction<LapEnv> = ({ request, env }) =>
  adminListBlocks(request, env, Date.now())

export const onRequestPost: PagesFunction<LapEnv> = ({ request, env }) =>
  adminBlock(request, env, Date.now())

export const onRequestDelete: PagesFunction<LapEnv> = ({ request, env }) =>
  adminUnblock(request, env, Date.now())
