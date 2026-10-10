// functions/tv/index.ts — /tv: Faceted Flight TV on a random live race. DEV-479.
//
// The 302 to `/?tv`, beside `functions/tv/[[path]].ts`'s deeper links, so the
// bare short link resolves whether or not a catch-all matches a path with no
// segment after it (plan/FF-TV.md §2.6).

import type { PagesFunction } from '../../src/net/pages-function'
import { routeTvShortLink } from '../../src/net/room-route'

export const onRequest: PagesFunction = ({ request }) => routeTvShortLink(request)
