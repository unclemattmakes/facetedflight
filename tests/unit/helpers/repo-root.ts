// tests/unit/helpers/repo-root.ts: where the repository is, in ONE spelling.
//
// A test used to re-derive this in its own words (five of them, in 130 files).
// `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter comes
// back as `/C:/Users/...` and every join produces `C:\C:\Users\...`. This file
// imports nothing from `src/`, so a guard that only reads text can use it
// without pulling the game in.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root: absolute, no trailing separator. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
