// tools/unity/guid-index.mjs: the ONE loader for docs/research/_guid_index.tsv.
//
// The index maps a Unity asset guid to its project-relative path, one
// `guid<TAB>Assets/...` row per asset. It is gitignored, the repo has no
// builder for it, and six tools used to read it six ways (TL-2 in
// docs/plan/code-reuse/tools.md): two of them loaded it through the prototype
// `loadGuidIndex`, which returns an EMPTY map when the file is missing. With an
// empty map no MonoBehaviour matches its script, so `level.mjs` died with
// "no Level in <scene>" and a probe reported "scripts: (none)" on objects that
// plainly carry one: a false negative that read as evidence about the scene.
// DEV-681: a missing index is now an error that names the file and says how to
// get one back.
//
// Policy, written once: rows are split on CRLF or LF, both halves trimmed, a
// row without a guid before its tab is skipped, and when a PATH appears twice
// the later row wins in `pathToGuid` (plain Map.set). `tests/unit/guid-index.test.ts`
// asserts the real index has no duplicate path and no duplicate guid, so that
// policy is inert on the index the tools actually read; if a rebuilt index
// ever gains a duplicate, that test says so before the policy matters.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

/** Where the index lives. Tools accept `--guid-index <file>` to point elsewhere. */
export const DEFAULT_GUID_INDEX = path.join(REPO, 'docs', 'research', '_guid_index.tsv')

/** The error text for a missing index: the path, why it is absent, and how to get it back. */
export const missingGuidIndexMessage = (file) =>
  [
    `guid index missing: ${file}`,
    'It is gitignored and nothing in the repo builds it. In a worktree, tools/agent/hydrate.ps1 copies it from the main checkout.',
    'To rebuild it: scan every .meta file under $FF2_LEGACY/Assets for its "guid: <32 hex>" line and write one guid<TAB>path row per file (path relative to the project root, forward slashes, ".meta" stripped). The row count CLAUDE.md documents is the completeness check. Reading .meta files keeps the Unity project read-only (hard rule 1).',
    'Without the index no MonoBehaviour can be matched to its script, and the symptom reads as "no Level in <scene>" or "scripts: (none)" rather than as a missing file. That is why this is an error and not an empty map.',
  ].join('\n')

/**
 * Parse the TSV text. Exported so the policy can be tested without a file.
 * @returns {{ guidToPath: Map<string, string>, pathToGuid: Map<string, string>, rows: number }}
 */
export const parseGuidIndex = (text) => {
  const guidToPath = new Map()
  const pathToGuid = new Map()
  let rows = 0
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const guid = line.slice(0, tab).trim()
    const rel = line.slice(tab + 1).trim()
    guidToPath.set(guid, rel)
    pathToGuid.set(rel, guid)
    rows++
  }
  return { guidToPath, pathToGuid, rows }
}

const cache = new Map()

/**
 * Load the index, cached per file. Throws `missingGuidIndexMessage(file)` when
 * the file is absent: never an empty map.
 * @returns {{ guidToPath: Map<string, string>, pathToGuid: Map<string, string>, rows: number }}
 */
export const loadGuidIndex = (file = DEFAULT_GUID_INDEX) => {
  const key = path.resolve(file)
  const hit = cache.get(key)
  if (hit) return hit
  if (!fs.existsSync(key)) throw new Error(missingGuidIndexMessage(key))
  const parsed = parseGuidIndex(fs.readFileSync(key, 'utf8'))
  cache.set(key, parsed)
  return parsed
}
