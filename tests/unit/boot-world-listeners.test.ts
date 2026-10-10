// tests/unit/boot-world-listeners.test.ts — the mission builder registers no
// page listeners.
//
// ── The bug ──────────────────────────────────────────────────────────────
//
// `buildWorld()` runs once per `switchMission`. It used to declare the
// wireframe stage and register the L/O keydown handler inside its own body,
// and nothing ever removed the handler. After N mission switches there were N
// handlers:
//
//   - **L** called `liveLookdev?.toggle()` N times, so with an even N the
//     lookdev panel never opened at all;
//   - **O** cycled N separate stages and repainted N worlds' terrain and ocean
//     groups — every one but the newest already disposed, and kept reachable by
//     the closures, which is a leak of a whole world per switch.
//
// Nothing a single-world test could see: with one build there is one handler
// and both keys behave. The volatile-scratch trap in CLAUDE.md is the same
// shape — *step a second one and assert the first did not move.*
//
// ── Why SOURCE-LEVEL ─────────────────────────────────────────────────────
//
// Same reasoning as `boot-one-world.test.ts`: the honest test needs two built
// worlds, which needs a GLB, a level and a renderer, and CI runs `pnpm check`,
// not Playwright. So read the file and require the structure: anything that
// registers on the page belongs to `bootApp`'s closure, which runs once, and
// reaches the current world through the live handles. A builder that runs per
// mission may not register at all, because it has nowhere that undoes it.

import { describe, expect, it } from 'vitest'
import { type AppFile, appFileWith, appSource } from './helpers/app-source'

/** The whole boot tree, for counts (APP-SPLIT phase 0); spans read ONE file. */
const APP = appSource()

/** The one file of the boot tree that declares `name`. */
const fileOf = (name: string): AppFile => appFileWith(`const ${name} = async (`)

/**
 * The span of one arrow function declared as `const <name> = async (...) => {`,
 * to its matching close brace — brace counting, as `boot-one-world.test.ts`
 * explains. Returns the offsets so a caller can ask what lies OUTSIDE it.
 */
const spanOf = (name: string): { start: number; end: number } => {
  const text = fileOf(name).text
  const open = text.indexOf(`const ${name} = async (`)
  expect(open, `${name} is declared in boot/app.ts`).toBeGreaterThan(-1)
  const start = text.indexOf('{', text.indexOf('=>', open))
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { start, end: i + 1 }
    }
  }
  throw new Error(`${name}: no matching brace`)
}

const bodyOf = (name: string): string => {
  const { start, end } = spanOf(name)
  return fileOf(name).text.slice(start, end)
}

/** Every offset at which `needle` occurs in boot/app.ts. */
const offsetsOf = (needle: string): number[] => {
  const out: number[] = []
  for (let i = APP.indexOf(needle); i !== -1; i = APP.indexOf(needle, i + 1)) out.push(i)
  return out
}

describe('the mission builder registers no page listeners', () => {
  it('buildWorld adds no event listener — it runs once per mission switch', () => {
    const body = bodyOf('buildWorld')
    // A sanity floor, so a slicing bug cannot pass this by reading nothing.
    expect(body.length, 'sliced a real buildWorld').toBeGreaterThan(10_000)
    expect(body, 'buildWorld registers no listener').not.toContain('addEventListener')
  })

  it('the wireframe stage is per PAGE, not per world', () => {
    // Declared inside buildWorld, each world got its own stage and each O press
    // advanced every one of them.
    expect(bodyOf('buildWorld')).not.toMatch(/\blet wireStage\b/)
    expect(offsetsOf('let wireStage'), 'one wireStage in boot/app.ts').toHaveLength(1)
  })

  it('the O key is handled exactly once, outside every per-mission builder', () => {
    const handlers = offsetsOf("code !== 'KeyO'")
    expect(handlers, 'one O handler in boot/app.ts').toHaveLength(1)
    // Its offset in ITS file: a builder in another file cannot enclose it.
    const home = appFileWith("code !== 'KeyO'")
    const at = home.text.indexOf("code !== 'KeyO'")
    for (const name of ['buildWorld', 'teardownWorld', 'switchMission']) {
      if (fileOf(name).file !== home.file) continue
      const { start, end } = spanOf(name)
      expect(at < start || at >= end, `the O handler is not inside ${name}`).toBe(true)
    }
  })
})
