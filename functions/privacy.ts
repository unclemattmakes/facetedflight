// functions/privacy.ts: /privacy. DEV-372; D30's privacy page.
//
// A Function rather than a static file so it ships with the server it
// describes and needs no second Vite entry: the page is `src/net/privacy-page.ts`,
// whose numbers are the server's own constants.
//
// HEAD as well as GET (S-11, docs/SECURITY-AUDIT.md): with GET alone, a HEAD
// fell through to the static 404 page, which is what a link checker saw.

import type { PagesFunction } from '../src/net/pages-function'
import { privacyPage } from '../src/net/privacy-page'

const PAGE = privacyPage()

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=3600',
  'x-content-type-options': 'nosniff',
}

export const onRequestGet: PagesFunction = () => new Response(PAGE, { headers: HEADERS })

export const onRequestHead: PagesFunction = () => new Response(null, { headers: HEADERS })
