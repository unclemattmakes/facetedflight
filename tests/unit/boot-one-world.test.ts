// tests/unit/boot-one-world.test.ts — boot builds ONE world, and it is the one
// you are looking at. DEV-281.
//
// ── The bug, in Matt's words, which are the acceptance test ───────────────
//
//   "it shouldn't be loading the islands in the first place is my entire point."
//   "i see 2 different levels visibly load in one after the other — first the
//    islands, then the title screen."
//
// `buildWorld()` was one `Promise.all` over eight things, two of which were full
// 4,096 m terrains: the mission island, and the title valley. A visitor who had
// chosen nothing waited on both, under a progress line naming the one they were
// NOT looking at. DEV-280 tried to fix the symptom by releasing the curtain when
// the valley's terrain resolved and was reverted, because *"terrain ready"* and
// *"that scene is the one on screen"* are different conditions and at that
// instant the mission scene was what was being drawn.
//
// ── Why this guard is SOURCE-LEVEL, which is not the first choice ─────────
//
// The honest test is the e2e one — `title-screen.spec.ts` asks the live scene
// which terrain groups are in it and requires exactly `['title-valley']`. That
// is the real claim and it stays.
//
// This exists beside it because **CI runs `pnpm check`, not Playwright**
// (`.github/workflows/`), so an e2e regression is visible to whoever chooses to
// run that file and to nobody else — the defect `fixtures/hangar.ts`'s own
// header is about. A separation that costs a second to check here is worth
// having on the gate that actually runs.
//
// Same shape as `xr-select.test.ts` §1 and `title-placement.test.ts`'s wiring
// guards: read the file, require the structure, because the alternative needs a
// GLB, a level, two megapixel PNGs and a renderer.
//
// It asserts SEPARATION, not the contents of either function. What each builder
// loads is free to change; what must not change is that neither builds the
// other's world.

import { describe, expect, it } from 'vitest'
import { appFileThroughWith, appSourceThroughCtx } from './helpers/app-source'

/** The whole boot tree as text, wherever the split puts the code (APP-SPLIT phase 0). */
const APP = appSourceThroughCtx()

/**
 * The body of one arrow function declared as `const <name> = async (...) => {`,
 * to its matching close brace.
 *
 * Brace counting rather than a regex for the whole body: these are 300 and 1,200
 * lines with every kind of nesting in them, and a lazy regex would silently
 * match to the first `\n  }` inside a nested block — which is the shape of a
 * guard that passes because it read almost nothing.
 */
const bodyOf = (name: string): string => {
  // The ONE file that declares it, so the brace count cannot run on into the
  // next file of the tree.
  const text = appFileThroughWith(`const ${name} = async (`).text
  const open = text.indexOf(`const ${name} = async (`)
  expect(open, `${name} is declared in boot/app`).toBeGreaterThan(-1)
  const start = text.indexOf('{', text.indexOf('=>', open))
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`${name}: no matching brace`)
}

describe('boot builds one world, and the builders do not overlap', () => {
  it('keeps the TITLE valley out of the mission builder', () => {
    const mission = bodyOf('buildWorld')
    // The valley's terrain key. It was item three of `buildWorld`'s
    // `Promise.all`, which is the whole of what this row undoes.
    expect(mission, 'buildWorld does not build the title valley').not.toContain('alpine.forest')
    expect(mission).not.toContain('TITLE_VALLEY_OFFSET')
    expect(mission).not.toContain('createTitle(')
  })

  it('keeps the MISSION out of the title builder', () => {
    const title = bodyOf('buildTitleWorld')
    // The island, the sea, the course and the ship — everything a visitor who
    // has chosen nothing has no business waiting on.
    for (const mission of [
      'envTerrain',
      'loadRings(',
      'loadTurnIndicators(',
      'loadFlight(',
      'loadGhosts(',
      'loadRacers(',
      'level.spawn',
    ]) {
      expect(title, `buildTitleWorld does not load ${mission}`).not.toContain(mission)
    }
  })

  it('picks the boot world from the SCREEN, and starts exactly one builder', () => {
    // One `const booted = ...`, fed by whichever builder the screen chose. The
    // claim is that there is no path on which both run: `world` is assigned
    // only in the mission branch, and `booted` falls through to the title
    // builder only when it was not.
    //
    // DEV-471 added a third answer, `none` (`?edit=1`), which starts NEITHER:
    // the stage is the loading scene and the island is built behind it by the
    // switch, the course swap's own call below. So `none` must reach neither
    // `buildWorld` here nor the title builder.
    expect(APP).toContain(
      "const bootWorld: 'title' | 'mission' | 'none' =\n    screen === 'title' ? 'title' : EDIT_AT_BOOT ? 'none' : 'mission'",
    )
    expect(APP).toContain("if (bootWorld === 'mission') world = buildWorld()")
    expect(APP).toContain(
      "const booted: Promise<unknown> =\n    world ?? (bootWorld === 'none' ? Promise.resolve() : buildTitleWorld())",
    )
    // And `buildWorld` is called in exactly two places: that one, and the
    // course swap. A third would be a world nobody asked for — which is the
    // defect this file is named after.
    //
    // Counted over CODE, not over the file: the block comment above the
    // declaration quotes the line this row replaced, and a naive `match` over
    // the whole source counts that quotation as a third call site. Same trap as
    // *"69 sites across 16 files"* in CLAUDE.md — the count of the STRING is not
    // the count of the thing.
    const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(
      (code.match(/\bbuildWorld\(\)/g) ?? []).length,
      'boot and the swap, and nothing else',
    ).toBe(2)
    expect((code.match(/\bbuildTitleWorld\(\)/g) ?? []).length, 'boot, once').toBe(1)
  })

  it('leaves the mission world NULLABLE, which is what makes it lazy', () => {
    // The type is the guarantee. `Promise<World>` cannot express "no course has
    // been chosen", and the version of this change that kept it would have had
    // to build something to satisfy it.
    expect(APP).toContain('let world: Promise<World> | null = null')
    // And the teardown tolerates it, because the FIRST selection tears down a
    // title world with no mission behind it.
    expect(APP).toContain('const built = world === null ? null : await world.catch(() => null)')
  })

  it('keeps the title valley out of 2016 reveal, and the mission in it', () => {
    // A LODGER, and it says so: this is a DEV-225 claim, not a DEV-281 one.
    // It lived in `spawn-clearing.spec.ts`, which censused a mission scene and
    // found `menu:` keys in it because boot built both worlds. Since this row
    // it finds none — so the assertion there became `undefined` against
    // `undefined`, green and vacuous, and the claim needed somewhere it is
    // still observable rather than a rewrite that pretended to test it.
    //
    // The title valley keeps every prop on purpose: `horizontalDistance`
    // ignores ALTITUDE, DEV-041 put the title eye deliberately above
    // everything, and nobody has photographed the difference. `app.ts` says
    // that at length; what is asserted is only the wiring, because
    // `prop-lod-wiring.test.ts` already owns the behaviour (a non-finite
    // distance builds no LOD and the batch draws everything).
    expect(
      bodyOf('buildTitleWorld'),
      'the title valley keeps every prop — no reveal (DEV-225)',
    ).toContain('lodDistance: PROP_LOD ?? Number.POSITIVE_INFINITY')
    // And the mission is NOT exempt: it passes a `lodDistance` only when
    // `?propLod=` overrides one, so the environment JSON's own extracted radius
    // is what reaches `createPassLod`. An exemption leaking across would cull
    // nothing on an island, which is a frame nobody would notice was wrong.
    const mission = bodyOf('buildWorld')
    expect(mission, "the mission's reveal comes off the environment JSON").toContain(
      '...(PROP_LOD !== undefined ? { lodDistance: PROP_LOD } : {})',
    )
    expect(mission, 'and never an infinite one').not.toContain(
      'lodDistance: PROP_LOD ?? Number.POSITIVE_INFINITY',
    )
  })

  it('names what it is loading, on both paths', () => {
    // DEV-107's L1 — *"Loading Simonet Islands" tells the visitor the wait is
    // buying them something*. It was buying them the wrong thing: the line
    // named the mission environment over a title screen standing in an alpine
    // valley. Each builder now names its own.
    //
    // And since DEV-352 the title's own is the GAME, not the valley it stands
    // in — Matt: *"name the game on the card, not the environment."* The
    // mission builder still names the place, because there it is the choice.
    const title = bodyOf('buildTitleWorld')
    expect(title).toContain('loading.restart(TITLE_CARD_NAME)')
    expect(title, 'no environment name on the title card').not.toContain('environmentDisplayName')
    expect(bodyOf('buildWorld')).toContain(
      'loading.restart(environmentDisplayName(level.environment))',
    )
  })
})
