// functions/tv/[[path]].ts — the short TV links: /tv/<tvId>, /tv/lap/<lapId>. DEV-479.
//
// A 302 to the query form the game reads (`/?tv=…`), so the address a person
// types or reads aloud is the short one (plan/FF-TV.md §2.6). `/tv` itself is
// `functions/tv/index.ts`, the same handler. A Function rather than a
// `_redirects` file because `public/` is not in git. Looks nothing up.

import type { PagesFunction } from '../../src/net/pages-function'
import { routeTvShortLink } from '../../src/net/room-route'

export const onRequest: PagesFunction<unknown, 'path'> = ({ request }) => routeTvShortLink(request)
