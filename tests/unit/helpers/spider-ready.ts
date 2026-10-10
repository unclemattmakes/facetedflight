// tests/unit/helpers/spider-ready.ts — is the jumping spider ready to ship?
//
// NOT a `.test.ts`, so vitest does not collect it.
//
// Matt, 2026-09-25, late (DEV-403): the spider is NOT READY TO SHIP, and its
// tests do not need to run while it is not. `content/aircraft/jumpseat.json`
// marks it `listed: false`, which is the whole of "not ready": the hangar does
// not offer it (`listedVariants`), and `?variant=spider` still flies it.
//
// Every spider-only test skips on `SPIDER_READY`, off that one flag, so the day
// the flag goes they all come back without anybody having to remember which
// they were. The loud counterpart is `variant-listed.test.ts`, which pins the
// flag's value and fails when it changes, on purpose.
//
// Read with `fs` rather than through `content/load-aircraft.ts`: that module's
// `import.meta.glob` is Vite's, and one import edge reaching it empties a
// Playwright collection, so this stays usable from `tests/e2e/` too.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILE = fileURLToPath(new URL('../../../content/aircraft/jumpseat.json', import.meta.url))

interface VariantListing {
  readonly id: string
  readonly listed?: boolean
}

const spider = (
  JSON.parse(fs.readFileSync(FILE, 'utf8')) as { readonly variants: readonly VariantListing[] }
).variants.find((v) => v.id === 'spider')

/** The spider is in the file and not marked `listed: false`. */
export const SPIDER_READY: boolean = spider !== undefined && spider.listed !== false
