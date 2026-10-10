// functions/api/admin/handles.ts — wipe a handle. DEV-374; `src/net/lap-admin.ts` is the whole of it.
//
//   DELETE /api/admin/handles?handle=<handle>[&reason=<text>][&block=0]
//                                                    Authorization: Bearer <ADMIN_TOKEN>
//
// Deletes every lap posted under the handle and retires it (unless `block=0`).

import { adminWipeHandle } from '../../../src/net/lap-admin'
import type { LapEnv } from '../../../src/net/lap-server'
import type { PagesFunction } from '../../../src/net/pages-function'

export const onRequestDelete: PagesFunction<LapEnv> = ({ request, env }) =>
  adminWipeHandle(request, env, Date.now())
