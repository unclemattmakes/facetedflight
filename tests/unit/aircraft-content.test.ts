// tests/unit/aircraft-content.test.ts — the aircraft variant files are a gate.
// DEV-380.
//
// `edition-content.test.ts`'s shape for `content/aircraft/`: every file
// validates against `_schema.json` (additionalProperties false at every
// level) AND passes the runtime check the loader runs, there is one file per
// aircraft, and the schema's per-aircraft list of scalable keys is the SAME
// list `src/content/aircraft-schema.ts` holds — two copies of a whitelist that
// could drift are one copy and a test.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Aircraft, VARIANT_SCALE_KEYS, validateAircraft } from '@/content/aircraft-schema'
import { aircraftFileIds, aircraftFor } from '@/content/load-aircraft'
import { createValidator, type SchemaNode } from './helpers/json-schema'

const DIR = 'content/aircraft'
const schema = JSON.parse(fs.readFileSync(path.join(DIR, '_schema.json'), 'utf8')) as SchemaNode
const validate = createValidator(schema)
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
const read = (f: string): Aircraft =>
  JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Aircraft

describe('every aircraft file validates', () => {
  it('there is one file per aircraft, and the loader sees the same set', () => {
    const ids = Object.keys(VARIANT_SCALE_KEYS).sort()
    expect(files.map((f) => f.replace('.json', ''))).toEqual(ids)
    expect(aircraftFileIds()).toEqual(ids)
  })

  for (const f of files) {
    it(`${f} validates against the schema`, () => {
      const errs: string[] = []
      validate(schema, read(f), f, errs)
      expect(errs, errs.join('\n')).toEqual([])
    })

    it(`${f} passes the runtime check the loader runs, and names its own aircraft`, () => {
      const a = validateAircraft(read(f), f)
      expect(a.vehicle).toBe(f.replace('.json', ''))
      expect(aircraftFor(a.vehicle).variants.map((v) => v.id)).toEqual(a.variants.map((v) => v.id))
    })
  }
})

describe('the schema is a gate, and it agrees with the code', () => {
  const defs = (schema as { $defs: Record<string, SchemaNode> }).$defs

  it("each aircraft's scalable keys in the schema are exactly VARIANT_SCALE_KEYS", () => {
    for (const [vehicle, keys] of Object.entries(VARIANT_SCALE_KEYS)) {
      const scale = defs[`${vehicle}Scale`]
      expect(scale, `$defs.${vehicle}Scale`).toBeDefined()
      expect(Object.keys(scale?.properties ?? {}).sort(), vehicle).toEqual([...keys].sort())
    }
  })

  it('rejects rigidbody.mass in a scale, and a variant field nobody declared', () => {
    const a = read('hoverjet.json') as unknown as {
      variants: { scale: Record<string, number>; [k: string]: unknown }[]
    }
    const first = a.variants[0] as { scale: Record<string, number>; [k: string]: unknown }
    first.scale = { 'rigidbody.mass': 1.1 }
    first.colour = 'orange'
    const errs: string[] = []
    validate(schema, a, 'hoverjet.json', errs)
    expect(errs.join('\n')).toContain('oneOf')
    // Checked branch by branch, so the reason is visible and not just "no branch".
    const branch: string[] = []
    validate(defs.hoverjetFile as SchemaNode, a, 'hoverjet.json', branch)
    expect(branch.join('\n')).toContain('"rigidbody.mass" is not in the schema')
    expect(branch.join('\n')).toContain('"colour" is not in the schema')
  })

  it('rejects a factor of zero', () => {
    const a = read('jumpseat.json') as unknown as { variants: { scale: Record<string, number> }[] }
    ;(a.variants[0] as { scale: Record<string, number> }).scale = { 'thruster.thrustForce': 0 }
    const branch: string[] = []
    validate(defs.jumpseatFile as SchemaNode, a, 'jumpseat.json', branch)
    expect(branch.join('\n')).toContain('is not greater than 0')
  })
})
