// tools/test/gen-test-indexes.mjs: write the two INDEXES that used to be edited by hand
// (DEV-966), from the tags and calls in tests/e2e:
//   - the spec/tier table in docs/testing/TIERS.md, whose TIER column is the `@measure` tag
//     in each spec's top-level titles;
//   - the "where the calls are" table in docs/testing/KNOWN-RED.md, whose spec:line and test
//     title come from each `knownRed('KR-nn')` call.
// The PROSE stays by hand: the reason column of the tier table is read back from the file
// (a new spec gets its first top-level title until somebody writes better), and the known-red
// rows' first error, owner and dates are not touched at all.
//
//   node tools/test/gen-test-indexes.mjs          rewrite both files
//   node tools/test/gen-test-indexes.mjs --check  exit 1 if either is stale (tests/unit/test-indexes.test.ts does this)
//
// Only the text between the BEGIN and END marker lines is owned by this script.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const E2E = path.join(REPO, 'tests', 'e2e')
const TIERS = path.join(REPO, 'docs', 'testing', 'TIERS.md')
const KNOWN_RED = path.join(REPO, 'docs', 'testing', 'KNOWN-RED.md')
// Built from parts so this file's own text is not mistaken for a tagged title.
const TAG = `@${'measure'}`

export const tiersMarkers = {
  begin:
    '<!-- BEGIN GENERATED tier-table: tools/test/gen-test-indexes.mjs rewrites these lines; edit the reason cells only -->',
  end: '<!-- END GENERATED tier-table -->',
}
export const knownRedMarkers = {
  begin:
    '<!-- BEGIN GENERATED known-red-calls: tools/test/gen-test-indexes.mjs rewrites these lines -->',
  end: '<!-- END GENERATED known-red-calls -->',
}

const TOP_TITLE = /^test(?:\.describe)?\((['"`])(.*?)\1/gm

/** BEHAVIOUR, MEASURE, or MIXED, from the tags in a spec's top-level titles. */
export const tierOf = (src) => {
  const tops = [...src.matchAll(TOP_TITLE)].map((m) => m[2] ?? '')
  const tagged = tops.filter((t) => t.includes(TAG)).length
  if (tagged === 0) return 'BEHAVIOUR'
  return tagged === tops.length ? 'MEASURE' : 'MIXED'
}

const firstTitle = (src) => {
  const m = [...src.matchAll(TOP_TITLE)][0]
  return (m?.[2] ?? '').replace(TAG, '').trim()
}

const specNames = () =>
  fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => f.replace('.spec.ts', ''))
    .sort()

/** Reasons already written in a tier table block, keyed by spec name. */
export const readReasons = (block) => {
  const reasons = new Map()
  for (const m of block.matchAll(
    /^\| `([a-z0-9-]+)` \| (?:BEHAVIOUR|MEASURE|MIXED) \| (.*) \|$/gm,
  )) {
    reasons.set(m[1], m[2])
  }
  return reasons
}

export const renderTierTable = (reasons) => {
  const lines = ['| spec | tier | reason |', '|---|---|---|']
  for (const name of specNames()) {
    const src = fs.readFileSync(path.join(E2E, `${name}.spec.ts`), 'utf8')
    const reason = reasons.get(name) ?? firstTitle(src)
    lines.push(`| \`${name}\` | ${tierOf(src)} | ${reason} |`)
  }
  return lines.join('\n')
}

/** Every knownRed('KR-nn') call: id, spec file, line, and the nearest title above it. */
export const knownRedCalls = () => {
  const calls = []
  for (const name of specNames()) {
    const file = `${name}.spec.ts`
    const src = fs.readFileSync(path.join(E2E, file), 'utf8')
    for (const m of src.matchAll(/knownRed\(\s*'(KR-\d{2})'/g)) {
      const before = src.slice(0, m.index)
      const line = before.split('\n').length
      const titles = [
        ...before.matchAll(/\b(?:test|it)(?:\.describe)?(?:\.[a-z]+)?\(\s*(['"`])(.*?)\1/g),
      ]
      calls.push({ id: m[1], file, line, title: titles.at(-1)?.[2] ?? '(no title found)' })
    }
  }
  return calls.sort((a, b) => a.id.localeCompare(b.id))
}

export const renderKnownRedCalls = () => {
  const lines = ['| id | call site | test |', '|---|---|---|']
  // The id is in backticks so the registry test, which reads rows that BEGIN with the id, skips these.
  for (const c of knownRedCalls())
    lines.push(`| \`${c.id}\` | \`${c.file}:${c.line}\` | ${c.title.replaceAll('|', '/')} |`)
  return lines.join('\n')
}

/** Replace what lies between the markers; throws if either marker is missing. */
export const spliceBlock = (doc, markers, body) => {
  const a = doc.indexOf(markers.begin)
  const b = doc.indexOf(markers.end)
  if (a < 0 || b < a) throw new Error(`markers missing or out of order: ${markers.begin}`)
  return `${doc.slice(0, a + markers.begin.length)}\n${body}\n${doc.slice(b)}`
}

const blockOf = (doc, markers) => {
  const a = doc.indexOf(markers.begin)
  const b = doc.indexOf(markers.end)
  return a < 0 || b < a ? '' : doc.slice(a + markers.begin.length, b)
}

/** The two files as they should read now. */
export const expected = () => {
  const tiers = fs.readFileSync(TIERS, 'utf8')
  const red = fs.readFileSync(KNOWN_RED, 'utf8')
  return {
    [TIERS]: spliceBlock(
      tiers,
      tiersMarkers,
      renderTierTable(readReasons(blockOf(tiers, tiersMarkers))),
    ),
    [KNOWN_RED]: spliceBlock(red, knownRedMarkers, renderKnownRedCalls()),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let stale = 0
  for (const [file, text] of Object.entries(expected())) {
    if (fs.readFileSync(file, 'utf8') === text) continue
    stale++
    if (check)
      console.error(
        `stale: ${path.relative(REPO, file)} (run: node tools/test/gen-test-indexes.mjs)`,
      )
    else fs.writeFileSync(file, text)
  }
  process.exit(check && stale ? 1 : 0)
}
