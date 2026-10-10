// tools/unity/yaml.mjs: the shared Unity-text layer under every extractor and converter.
//
// WP-23 (docs/plan/CODE-REUSE-AUDIT.md), TL-1, TL-3 and TL-8 in docs/plan/code-reuse/tools.md.
// Three things lived in six to eight private copies each, and the copies differed in ways
// nobody had written down:
//
//   1. Loading `tools/prototype/*.js`. They are CommonJS under a `"type": "module"` package,
//      so four tools each carried a `new Function` wrapper (`requireCjs`, `loadUnityYaml`)
//      with a different subset of CJS semantics. One loader now: `requireCjs`.
//   2. Reading a legacy text file. Six readers disagreed on BOM and CRLF. One policy now,
//      two switches, in `readUnityText`.
//   3. The `--- !u!<class> &<fileId>[ stripped]` document header, hand-scanned eight times.
//      One scan now: `scanDocuments`.
//
// Pure reads. Nothing here writes, and nothing here touches `$FF2_LEGACY` except through the
// path a caller hands in (hard rule 1).

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const nodeRequire = createRequire(import.meta.url)

// ── the CJS prototype loader (TL-1) ────────────────────────────────────────

const cjsCache = new Map()

/**
 * Evaluate a CommonJS file from `tools/prototype/` and return its `module.exports`.
 *
 * Same semantics `level.mjs` always had, which is the fullest of the four old copies: cached
 * per resolved file, a `.js` fallback when the specifier has no extension, relative requires
 * resolved against the file's own directory and through this loader, bare requires handed to
 * node, a `require.resolve`, and `require.main === undefined` so the CLI block at the foot of
 * each prototype stays dormant. The shebang is stripped (`new Function` rejects one).
 *
 * `unity_yaml.js` has no requires at all, so the three tools that used a loader that threw on
 * any `require` (constants, wings, hangar-art) see the same module through this one.
 */
export function requireCjs(absFile) {
  let key = path.resolve(absFile)
  if (!fs.existsSync(key) && fs.existsSync(`${key}.js`)) key = `${key}.js`
  const hit = cjsCache.get(key)
  if (hit) return hit.exports
  const src = fs.readFileSync(key, 'utf8').replace(/^#![^\n]*/, '')
  const mod = { exports: {}, id: key, filename: key, loaded: false, children: [], paths: [] }
  cjsCache.set(key, mod)
  const dir = path.dirname(key)
  const localRequire = (spec) =>
    spec.startsWith('.') ? requireCjs(path.resolve(dir, spec)) : nodeRequire(spec)
  localRequire.resolve = (spec) =>
    spec.startsWith('.') ? path.resolve(dir, spec) : nodeRequire.resolve(spec)
  localRequire.cache = {}
  localRequire.main = undefined
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src)
  fn(mod.exports, localRequire, mod, key, dir)
  mod.loaded = true
  return mod.exports
}

/** `tools/prototype/<name>.js`, loaded through `requireCjs`. */
export const prototypeTool = (name) => requireCjs(path.join(REPO, 'tools', 'prototype', name))

/**
 * The prototype YAML parser: `{ parseDocuments(text) -> [{ classId, fileId, stripped, type, data }] }`.
 * `file` overrides the path (constants.mjs keeps a `--unity-yaml` default it never exposes).
 */
export function unityYaml(file) {
  const mod = file ? requireCjs(file) : prototypeTool('unity_yaml.js')
  if (typeof mod.parseDocuments !== 'function') {
    throw new Error(`${file ?? 'tools/prototype/unity_yaml.js'} did not export parseDocuments`)
  }
  return mod
}

// ── reading a legacy text file (TL-8) ──────────────────────────────────────

/**
 * Read a Unity text file (YAML, .meta, .cs, shader) as UTF-8.
 *
 * ONE policy, two switches:
 *   - A leading BOM is ALWAYS stripped. Every YAML file in the project is BOM-free (checked,
 *     read-only, 2026-10-05: no .unity/.prefab/.asset/.mat/.anim/.meta carries one); 591 .cs
 *     and 100 shader files do, and a BOM there only ever breaks a `^`-anchored match.
 *   - Line endings are KEPT by default. `constants.mjs` records LINE numbers and every one of
 *     its regexes tolerates `\r`; `ui-text.mjs` needs multi-line scalars byte-exact.
 *     `{ lf: true }` collapses CRLF to LF for the converters, whose line-anchored regexes do not.
 */
export const readUnityText = (file, { lf = false } = {}) => {
  let text = fs.readFileSync(file, 'utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return lf ? text.replace(/\r\n/g, '\n') : text
}

// ── the document header scan (TL-3) ────────────────────────────────────────

/**
 * One document header: `--- !u!<classId> &<fileId>[ stripped]`.
 * Anchored at both ends; trailing whitespace tolerated (CRLF files leave a `\r`).
 */
export const DOC_HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/

/**
 * Split a Unity YAML file into document line bounds WITHOUT parsing anything.
 *
 * `lines` is `text.split(/\r?\n/)` (or the text itself, split here). Each bound is
 * `{ classId, fileId, stripped, start, end }` with `start` the 0-based line of the header and
 * `end` the 0-based line of the NEXT header (or `lines.length`), so `lines.slice(start, end)` is
 * the whole document and `start + 1` is the header's 1-based line, which is what the generated
 * sheet records as provenance. Lines before the first header (`%YAML`, `%TAG`) belong to no
 * document. `classId` is a number and `fileId` a string, as `parseDocuments` gives them.
 */
export function scanDocuments(lines) {
  const ls = typeof lines === 'string' ? lines.split(/\r?\n/) : lines
  const bounds = []
  let cur = null
  for (let i = 0; i < ls.length; i++) {
    const m = DOC_HEADER.exec(ls[i])
    if (!m) continue
    if (cur) {
      cur.end = i
      bounds.push(cur)
    }
    cur = { classId: Number(m[1]), fileId: m[2], stripped: !!m[3], start: i, end: ls.length }
  }
  if (cur) bounds.push(cur)
  return bounds
}

/** A top-level key of a document body: two spaces of indent, a name, a colon. */
export const TOP_KEY = /^ {2}([A-Za-z_][A-Za-z0-9_ ]*):/

/**
 * The 1-based line of each top-level key inside `bound`, FIRST occurrence wins.
 * Returns `Map<key, line>`; the caller composes its own `fileId + separator + key` index.
 */
export function keyLines(lines, bound) {
  const out = new Map()
  for (let i = bound.start + 1; i < bound.end; i++) {
    const k = TOP_KEY.exec(lines[i])
    if (!k) continue
    const key = k[1].trim()
    if (!out.has(key)) out.set(key, i + 1)
  }
  return out
}
