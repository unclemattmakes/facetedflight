// tools/making-of/source-truth.ts: the site's numbers and code come from the
// game. DEV-508 (docs/plan/MAKING-OF.md §2.4).
//
// `data-const="derived.hoverjet.terminalSpeedCruise"` in chapter HTML is
// replaced at build by that value from `src/generated/constants.generated.json`,
// and `data-snippet="src/sim/boundary.ts#stepBoundary"` by that declaration's
// source, cut out by the TypeScript compiler by NAME. No marker comments live
// in `src/` (a marker is prose a substring guard can read), and a renamed
// function fails the build and `tests/unit/making-of-sources.test.ts` instead
// of leaving an empty <pre> on a public page.
//
// Plain node, no vite: the plugin and the unit test both call it.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

// ── numbers ────────────────────────────────────────────────────────────────

interface Provenance {
  readonly trust?: string
  readonly unit?: string | null
  readonly origin?: string
}
interface Sheet {
  readonly [k: string]: unknown
  readonly provenance: Readonly<Record<string, Provenance>>
}

const sheetCache = new Map<string, Sheet>()
const sheetAt = (root: string): Sheet => {
  let sheet = sheetCache.get(root)
  if (!sheet) {
    sheet = JSON.parse(
      readFileSync(path.join(root, 'src/generated/constants.generated.json'), 'utf8'),
    ) as Sheet
    sheetCache.set(root, sheet)
  }
  return sheet
}

export interface ConstantHit {
  readonly key: string
  readonly value: number | string | boolean
  readonly unit: string | null
  readonly trust: string | null
}

/** Look a dotted key up in the sheet. Throws a message that names the key. */
export const lookupConstant = (root: string, key: string): ConstantHit => {
  const sheet = sheetAt(root)
  // The provenance map is keyed by the extractor's dotted names, which are not always the tree's path.
  const prov = sheet.provenance[key] as (Provenance & { value?: unknown }) | undefined
  let node: unknown = sheet
  if (prov && 'value' in prov) node = prov.value
  else {
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object' || !(part in (node as object))) {
        throw new Error(`data-const "${key}" does not resolve in constants.generated.json`)
      }
      node = (node as Record<string, unknown>)[part]
    }
  }
  if (typeof node !== 'number' && typeof node !== 'string' && typeof node !== 'boolean') {
    throw new Error(`data-const "${key}" is not a number, string or boolean`)
  }
  return { key, value: node, unit: prov?.unit ?? null, trust: prov?.trust ?? null }
}

/** `data-digits` is a fixed count; absent, six significant figures with the zeros trimmed. */
export const formatConstant = (
  hit: ConstantHit,
  digits: string | null,
  unit: string | null,
): string => {
  let text: string
  if (typeof hit.value === 'number') {
    text =
      digits === null ? String(Number(hit.value.toPrecision(6))) : hit.value.toFixed(Number(digits))
  } else text = String(hit.value)
  const u = unit === 'auto' ? hit.unit : unit
  return u ? `${text} ${u}` : text
}

const attr = (attrs: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null

const CONST_TAG = /<span\b([^>]*\bdata-const="[^"]+"[^>]*)>\s*<\/span>/g
const SNIPPET_TAG = /<pre\b([^>]*\bdata-snippet="[^"]+"[^>]*)>\s*<\/pre>/g

export const constKeysIn = (html: string): string[] =>
  [...html.matchAll(CONST_TAG)].map((m) => attr(m[1] ?? '', 'data-const') ?? '')
export const snippetRefsIn = (html: string): string[] =>
  [...html.matchAll(SNIPPET_TAG)].map((m) => attr(m[1] ?? '', 'data-snippet') ?? '')

// ── code ───────────────────────────────────────────────────────────────────

/** The declared names of a top-level statement. */
const namesOf = (stmt: ts.Statement): string[] => {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    )
  }
  if (
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)
  ) {
    return stmt.name ? [stmt.name.text] : []
  }
  return []
}

export interface SnippetHit {
  readonly file: string
  readonly name: string
  /** 1-based, in the file. */
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

/** `src/sim/boundary.ts#stepBoundary`. Cut by name; the leading doc comment is left out. */
export const cutSnippet = (root: string, ref: string): SnippetHit => {
  const [file, name] = ref.split('#')
  if (!file || !name) throw new Error(`data-snippet "${ref}" must be <file>#<declaration>`)
  const abs = path.join(root, file)
  let source: string
  try {
    source = readFileSync(abs, 'utf8')
  } catch {
    throw new Error(`data-snippet "${ref}": ${file} does not exist`)
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
  const stmt = sf.statements.find((s) => namesOf(s).includes(name))
  if (!stmt)
    throw new Error(`data-snippet "${ref}": no top-level declaration named ${name} in ${file}`)
  const start = stmt.getStart(sf, false)
  const end = stmt.getEnd()
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  return {
    file,
    name,
    startLine: lineOf(start),
    endLine: lineOf(end),
    text: source.slice(start, end).replaceAll('\r\n', '\n'),
  }
}

/** Token-kind highlighting with the compiler's own scanner. Output is the text, escaped, in spans. */
export const highlight = (text: string): string => {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, text)
  let out = ''
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const piece = escapeHtml(scanner.getTokenText())
    let cls: string | null = null
    if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword) cls = 'keyword'
    else if (
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.TemplateMiddle ||
      kind === ts.SyntaxKind.TemplateTail
    )
      cls = 'string'
    else if (kind === ts.SyntaxKind.NumericLiteral) cls = 'number'
    else if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    )
      cls = 'comment'
    out += cls ? `<span class="${cls}">${piece}</span>` : piece
  }
  return out
}

// ── the HTML pass ──────────────────────────────────────────────────────────

/** Replace every `data-const` span and `data-snippet` pre in a page. Throws on one that does not resolve. */
export const resolveSources = (root: string, html: string, page: string): string => {
  const wrap = (fn: () => string): string => {
    try {
      return fn()
    } catch (e) {
      throw new Error(`${page}: ${(e as Error).message}`)
    }
  }
  return html
    .replace(CONST_TAG, (_m, attrs: string) =>
      wrap(() => {
        const key = attr(attrs, 'data-const') ?? ''
        const hit = lookupConstant(root, key)
        const text = formatConstant(hit, attr(attrs, 'data-digits'), attr(attrs, 'data-unit'))
        const tip = [key, hit.trust ? `trust: ${hit.trust}` : null].filter(Boolean).join(' · ')
        return `<span class="const" title="${escapeHtml(tip)}">${escapeHtml(text)}</span>`
      }),
    )
    .replace(SNIPPET_TAG, (_m, attrs: string) =>
      wrap(() => {
        const hit = cutSnippet(root, attr(attrs, 'data-snippet') ?? '')
        const caption = attr(attrs, 'data-caption')
        return (
          `<figure class="snippet"><pre><code>${highlight(hit.text)}</code></pre>` +
          `<figcaption>${caption ? `${escapeHtml(caption)} · ` : ''}` +
          `<code>${escapeHtml(hit.file)}:${hit.startLine}</code></figcaption></figure>`
        )
      }),
    )
}
