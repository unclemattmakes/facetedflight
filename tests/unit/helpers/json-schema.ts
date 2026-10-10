// tests/unit/helpers/json-schema.ts — the hand-rolled JSON Schema subset the
// content gates run on.
//
// Lifted out of `level-schema-validates.test.ts` the day a second content
// schema arrived (`content/editions/_schema.json`), so both gates run the SAME
// validator — two copies would drift, and a keyword one of them silently
// skipped is exactly the failure this code exists to refuse.
//
// ── Why written here rather than installed ───────────────────────────────
//
// There is no JSON Schema library in this repo and adding one is a dependency
// decision that lands alone with a measured result (CLAUDE.md, process). The
// schemas use a dozen keywords — counted, not guessed — and every one of them
// is a few lines. `unsupported keyword` is itself an assertion: the day a
// schema grows a keyword this does not know, the test says so instead of
// quietly passing it. A validator that silently ignores what it does not
// understand is worse than none, because it reports green over the thing it
// cannot see.

export interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: SchemaNode
  enum?: unknown[]
  const?: unknown
  oneOf?: SchemaNode[]
  $ref?: string
  pattern?: string
  minItems?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  $defs?: Record<string, SchemaNode>
  // Annotations, carried by every node and meaningless to validation.
  $schema?: string
  $id?: string
  title?: string
  description?: string
}

/** Keywords this validator implements. Anything else is a failure, not a skip. */
const KNOWN = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  '$ref',
  'pattern',
  'minItems',
  'maxItems',
  // Numeric bounds, taught when the edition schema grew the haze's tuning
  // (DEV-082). `exclusiveMinimum` earns its place on one key: the haze's
  // `range` is handed to the shader as its reciprocal, so a zero there is an
  // infinity multiplied by a zero strength — which is a NaN, and a NaN in
  // `outgoingLight` is a black frame with nothing in the console.
  'minimum',
  'maximum',
  'exclusiveMinimum',
  // And its mirror, taught for the next-gate arrow's cone (DEV-124): a cone of
  // 90 degrees or more is an arrow that never shows, and `maximum: 89.99` would
  // be a number pretending to be a bound.
  'exclusiveMaximum',
  '$defs',
  '$schema',
  '$id',
  'title',
  'description',
])

const typeOf = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (Number.isInteger(v)) return 'integer'
  return typeof v
}

const typeMatches = (want: string, v: unknown): boolean => {
  const got = typeOf(v)
  if (want === 'number') return got === 'number' || got === 'integer'
  if (want === 'object') return got === 'object'
  return want === got
}

export type Validate = (node: SchemaNode, value: unknown, at: string, errs: string[]) => void

/**
 * A validator bound to one ROOT schema — `$ref` resolves into its `$defs`.
 * Call the result with the root itself to validate a whole document; the
 * returned list of problems is empty when it is valid.
 */
export const createValidator = (root: SchemaNode): Validate => {
  const deref = (node: SchemaNode): SchemaNode => {
    if (!node.$ref) return node
    const m = /^#\/\$defs\/(.+)$/.exec(node.$ref)
    if (!m) throw new Error(`unsupported $ref "${node.$ref}"`)
    const target = root.$defs?.[m[1] as string]
    if (!target) throw new Error(`$ref "${node.$ref}" does not resolve`)
    return target
  }

  const validate: Validate = (node, value, at, errs) => {
    for (const k of Object.keys(node)) {
      if (!KNOWN.has(k)) errs.push(`${at}: unsupported keyword "${k}" — teach the validator`)
    }
    const s = deref(node)
    if (s !== node) {
      validate(s, value, at, errs)
      return
    }

    if (s.type !== undefined) {
      const want = Array.isArray(s.type) ? s.type : [s.type]
      if (!want.some((t) => typeMatches(t, value))) {
        errs.push(`${at}: expected ${want.join('|')}, got ${typeOf(value)}`)
        return
      }
    }
    if (s.enum && !s.enum.includes(value as never)) {
      errs.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`)
    }
    if (s.const !== undefined && value !== s.const) {
      errs.push(`${at}: expected the constant ${JSON.stringify(s.const)}`)
    }
    if (s.pattern && typeof value === 'string' && !new RegExp(s.pattern).test(value)) {
      errs.push(`${at}: "${value}" does not match /${s.pattern}/`)
    }
    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) {
        errs.push(`${at}: ${value} is below the minimum ${s.minimum}`)
      }
      if (s.maximum !== undefined && value > s.maximum) {
        errs.push(`${at}: ${value} is above the maximum ${s.maximum}`)
      }
      if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) {
        errs.push(`${at}: ${value} is not greater than ${s.exclusiveMinimum}`)
      }
      if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) {
        errs.push(`${at}: ${value} is not less than ${s.exclusiveMaximum}`)
      }
    }
    if (s.oneOf) {
      const hits = s.oneOf.filter((alt) => {
        const sub: string[] = []
        validate(alt, value, at, sub)
        return sub.length === 0
      })
      if (hits.length !== 1) {
        errs.push(
          `${at}: matched ${hits.length} of ${s.oneOf.length} oneOf branches, wanted exactly 1`,
        )
      }
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) {
        errs.push(`${at}: ${value.length} items, minimum ${s.minItems}`)
      }
      if (s.maxItems !== undefined && value.length > s.maxItems) {
        errs.push(`${at}: ${value.length} items, maximum ${s.maxItems}`)
      }
      if (s.items) {
        for (const [i, v] of value.entries()) validate(s.items, v, `${at}[${i}]`, errs)
      }
    }
    if (value !== null && typeOf(value) === 'object') {
      const obj = value as Record<string, unknown>
      for (const r of s.required ?? []) {
        if (!(r in obj)) errs.push(`${at}: missing required "${r}"`)
      }
      for (const [k, v] of Object.entries(obj)) {
        const child = s.properties?.[k]
        if (child) validate(child, v, `${at}.${k}`, errs)
        else if (s.additionalProperties === false) {
          errs.push(`${at}: "${k}" is not in the schema, and additionalProperties is false`)
        }
      }
    }
  }

  return validate
}
