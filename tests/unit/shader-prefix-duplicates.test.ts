// tests/unit/shader-prefix-duplicates.test.ts
//
// **three's program prefix already declares some chunks for every material, so
// a hand-written shader that includes one of them declares it TWICE and does
// not compile.** This file is the gate for that class.
//
// It has cost this project two bugs in one file. `render/diorama.ts` hit it
// with `<colorspace_pars_fragment>` when it was written, fixed it, and wrote
// the reason down — and left `<tonemapping_pars_fragment>` in place, because
// that one is only a duplicate SOME of the time:
//
//     WebGLProgram.js:772
//     ( parameters.toneMapping !== NoToneMapping ) ? ShaderChunk[ 'tonemapping_pars_fragment' ] : ''
//
// On the flat Anniversary build the scene renders into the composer's target
// and three applies no tone mapping, so the prefix is empty and the include is
// REQUIRED. Classic is `toneMapping: "none"` and the same. **In a headset the
// destination is an XR target, three applies ACES, and the include becomes a
// second body of eleven functions** — `VALIDATE_STATUS false`, then
// `useProgram: program not valid` two hundred times a frame.
//
// Found by Matt in the first Frame session, out of a console log. Invisible to
// every flat test, every screenshot and both presets: DEV-141's shape one layer
// down, where a monocular harness cannot see a stereo bug and a composer
// harness cannot see a direct-to-target one.
//
// The oracle is three's OWN BUILD rather than a list written here, for the
// reason `xr-eye-layers.test.ts` gives: these are three's internals, the pin
// moves the day `three-mesh-bvh`'s ceiling is accepted, and a copy of a fact
// goes stale where the fact does not.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDER_DIR = path.join(process.cwd(), 'src', 'render')
const THREE_PROGRAM = path.join(
  process.cwd(),
  'node_modules',
  'three',
  'src',
  'renderers',
  'webgl',
  'WebGLProgram.js',
)

/**
 * Chunks three's fragment PREFIX inserts itself. Including one in a
 * hand-written shader is a redefinition.
 *
 * Read out of three's source below rather than asserted from this list — the
 * list is what the scan uses, the source is what proves the list is right.
 */
const PREFIX_CHUNKS = ['tonemapping_pars_fragment', 'colorspace_pars_fragment'] as const

const sources = (): { file: string; text: string }[] =>
  fs
    .readdirSync(RENDER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(RENDER_DIR, f), 'utf8') }))

describe("three's fragment prefix declares these, so our shaders must not", () => {
  it('every chunk in the list really is in the prefix — three as the oracle', () => {
    // Without this, the scan below is a rule with no provenance: it would keep
    // passing after three stopped inserting one of these and started needing
    // the include instead, which is the same failure in the other direction.
    const program = fs.readFileSync(THREE_PROGRAM, 'utf8')
    for (const chunk of PREFIX_CHUNKS) {
      expect(
        program.includes(`ShaderChunk[ '${chunk}' ]`),
        `three's WebGLProgram no longer inserts ${chunk} into the prefix — re-read it ` +
          'before trusting this gate',
      ).toBe(true)
    }
  })

  it('no shader under src/render includes one of them', () => {
    const offenders: string[] = []
    for (const { file, text } of sources()) {
      for (const chunk of PREFIX_CHUNKS) {
        // The include as it would appear in a template literal. Comments
        // naming the chunk are fine and are how the reason gets recorded, so
        // match the DIRECTIVE rather than the word.
        const directive = `#include <${chunk}>`
        for (const line of text.split('\n')) {
          if (!line.includes(directive)) continue
          if (line.trimStart().startsWith('//')) continue
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(
      offenders,
      "three's prefix already declares these, so a second include is a redefinition — and it " +
        'only fails where tone mapping is ON, which is a headset and not a flat screen',
    ).toEqual([])
  })

  it('leaves `tonemapping_fragment` alone, which is a different chunk', () => {
    // The guarded one in main() is correct and must not be swept up by a
    // future tightening of the rule: `#if defined( TONE_MAPPING )` makes it a
    // no-op when three has not declared the functions.
    const diorama = fs.readFileSync(path.join(RENDER_DIR, 'diorama.ts'), 'utf8')
    expect(diorama).toContain('#include <tonemapping_fragment>')
    expect(diorama).not.toContain('#include <tonemapping_pars_fragment>')
  })
})
