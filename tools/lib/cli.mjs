// tools/lib/cli.mjs: the two things every hand-rolled CLI in tools/ re-wrote (TL-14, TL-15, TL-18).

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * True when the module at `importMetaUrl` is the script node was started with.
 *
 * Never a module-NAME test: that is always true, so importing the file ran the
 * runner and read `process.argv[2]` (the word `test`) as a queue path
 * (measure-queue.mjs's own guard says what that cost).
 */
export const isMain = (importMetaUrl) =>
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl)

/** The value after `--name` on the command line, or `fallback` when the flag is absent or last. */
export const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}
