// tests/unit/level-schema-validates.test.ts — the schema becomes a GATE.
//
// `content/levels/_schema.json` has existed since the extractor was written and
// `tools/extract/level.mjs`'s own header says the levels are *"validated by
// _schema.json"*. Nothing validated them. It declared `additionalProperties:
// false` and then omitted `turnIndicators`, `medalsFf2` and `lighting` — three
// keys that every one of the thirteen shipped levels carries — which is the
// exact failure the keyword exists to catch, sitting undetected inside the
// mechanism that was supposed to catch it.
//
// **A schema nothing checks is a document pretending to be a gate**, and the
// dangerous half is not the three missing keys: it is that the file reads like
// a contract, so the next person to add a level field will reasonably believe
// that leaving the schema alone would fail something.
//
// ── The validator lives in `helpers/json-schema.ts` ─────────────────────
//
// It was written out in this file — there is no JSON Schema library in this
// repo, and adding one is a dependency decision that lands alone with a
// measured result — and moved the day a second content schema arrived
// (`content/editions/_schema.json`, `edition-content.test.ts`), so both gates
// run the SAME validator. Its header carries the argument for why a hand-rolled
// validator must refuse a keyword it does not know rather than skip it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createValidator, type SchemaNode } from './helpers/json-schema'

const DIR = 'content/levels'
const schema = JSON.parse(fs.readFileSync(path.join(DIR, '_schema.json'), 'utf8')) as SchemaNode

/** Bound to this schema, so `$ref` resolves into its `$defs`. */
const validate = createValidator(schema)

const levelFiles = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()

describe('every shipped level validates against _schema.json', () => {
  it('finds the thirteen shipped missions', () => {
    // If this drops, a level stopped being checked rather than the suite
    // getting smaller — and a level nobody checks is the whole failure mode.
    expect(levelFiles.length).toBe(13)
  })

  for (const f of levelFiles) {
    it(`${f} validates`, () => {
      const level = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as unknown
      const errs: string[] = []
      validate(schema, level, f.replace('.json', ''), errs)
      expect(errs, errs.join('\n')).toEqual([])
    })
  }
})

describe('the schema is a gate, not a description', () => {
  it('rejects a level with a key it has never heard of', () => {
    // The guard on the guard. `additionalProperties: false` was already there
    // and three real keys sailed past it for the life of the extractor, because
    // nothing ran it — so what needs asserting is that running it REFUSES
    // something, not that it passes the files it was written from.
    const level = JSON.parse(
      fs.readFileSync(path.join(DIR, 'int_01_hoverJet.json'), 'utf8'),
    ) as Record<string, unknown>
    level.somethingNobodyDeclared = 1
    const errs: string[] = []
    validate(schema, level, 'int_01_hoverJet', errs)
    expect(errs.join('\n')).toContain('somethingNobodyDeclared')
  })

  it('rejects a level missing a required field', () => {
    const level = JSON.parse(
      fs.readFileSync(path.join(DIR, 'int_01_hoverJet.json'), 'utf8'),
    ) as Record<string, unknown>
    delete level.scoring
    const errs: string[] = []
    validate(schema, level, 'int_01_hoverJet', errs)
    expect(errs.join('\n')).toContain('missing required "scoring"')
  })

  it('rejects a wrong type and a wrong enum member', () => {
    const level = JSON.parse(
      fs.readFileSync(path.join(DIR, 'int_01_hoverJet.json'), 'utf8'),
    ) as Record<string, unknown>
    level.vehicle = 'unet'
    level.worldOffset = 'nope'
    const errs: string[] = []
    validate(schema, level, 'int_01_hoverJet', errs)
    expect(errs.join('\n')).toContain('"unet" is not one of')
    expect(errs.join('\n')).toContain('expected array')
  })
})
