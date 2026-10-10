// tests/unit/extract-ui-strings.test.ts — 2016's UI strings, and the literals
// in `src/` that are standing in for them.
//
// ── What this is guarding ────────────────────────────────────────────────
//
// Until now every UI string the port showed was a literal in `src/render/**` or
// `src/boot/app.ts`, copied out of a Unity prefab by eye with the prefab line in
// the comment above it. That is hand-typing a constant, and CLAUDE.md rule 3
// exists because hand-typed constants are wrong: the briefing's apostrophe had
// been normalised from U+0027 to U+2019 and its trailing newline dropped, and
// `SPEED:` is neither of the two things 2016 writes.
//
// `tools/extract/ui-text.mjs` now reads them, so `level.ui` carries the real
// bytes. The swap is landing piece by piece — the HUD's count label already
// comes from `level.ui.strings` through `countLabel()` in `src/game/modes.ts`,
// and the rest are still literals. For each one, landed or not, this file pins
// the RELATIONSHIP between the two:
//
//     transform(extracted) === the literal currently in the source
//
// where `transform` is written out per string and IS the deviation. `identity`
// means the port already shows 2016's exact bytes; anything else is a change the
// port is making on purpose, in one place, in public. The assertion fails if
// either side moves — so the extracted value cannot silently drift, and neither
// can the literal, and when the render swap happens the transforms are the list
// of decisions it has to make.
//
// Nothing here hard-codes a 2016 string. The expected value on one side is read
// out of `content/levels/*.json`, the expected value on the other is read out of
// the `.ts` source, and the only thing this file contributes is the rule between
// them.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { uiBriefing, uiLabel, uiLabelWord, uiString } from '@/content/ui-strings'
import { countLabel } from '@/game/modes'
import { decodeScalar } from '../../tools/extract/ui-text.mjs'
import { levelJson as level, shippedLevelIds as levelIds } from './helpers/content'
import { REPO as ROOT } from './helpers/repo-root'

/**
 * The first capture of `re` in a source file.
 *
 * Throws rather than returning undefined: a regex that stops matching because
 * the line was reformatted must fail loudly, or this whole file quietly stops
 * testing anything. That has happened in this repo before — see
 * `tests/unit/source-bytes.test.ts` for the backspace-in-a-regex story.
 */
const literalIn = (file: string, re: RegExp): string => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const m = re.exec(text)
  if (!m || m[1] === undefined) {
    throw new Error(`${file}: no match for ${re} — the literal moved, or the line was reformatted`)
  }
  return m[1]
}

const identity = (s: string): string => s

/**
 * Every place `src/` still hard-codes a string 2016 owns, and what the port
 * does to it on the way.
 *
 * `where` is the handover note: file and what to replace. `transform` is the
 * deviation, stated so that "the port upper-cases the HUD labels" is a decision
 * on the record rather than an accident nobody can see.
 */
const HARD_CODED = [
  {
    id: 'gatesLabel',
    // The swap already happened for this one: `countLabel()` in
    // `src/game/modes.ts` reads `level.ui.strings.gatesLabel` and only falls
    // back to the literal when a mission has no such string. What is pinned
    // here is the FALLBACK, which is still 2016's word written out by hand —
    // so if the extracted string ever changed, this would catch the fallback
    // drifting away from it.
    vehicle: 'hoverjet',
    where: 'src/game/modes.ts — `ringAttack.countFallback`, used when level.ui has no gatesLabel',
    read: () => literalIn('src/game/modes.ts', /countFallback: '(GATES)'/),
    // `Gates:` -> `GATES`. hud.ts appends its own colon, so the colon goes.
    transform: (s: string) => s.replace(/:$/, '').toUpperCase(),
  },
  {
    id: 'orbsFound',
    vehicle: 'hoverjet',
    where: 'src/game/modes.ts — `freeFlight.countFallback`, used when level.ui has no orbsFound',
    read: () => literalIn('src/game/modes.ts', /countFallback: '(ORBS)'/),
    // `Orbs FounD:` -> `ORBS`. The port drops 2016's stray capital D with the
    // rest of the word; it is a label, not a sentence.
    transform: (s: string) => (s.split(' ')[0] ?? '').replace(/:$/, '').toUpperCase(),
  },
] as const

/**
 * The strings the render swap has ALREADY taken, and what FF2 draws for each.
 *
 * These rows no longer have a literal in `src/` to compare against, which is the
 * point of them: the value on screen is read from `level.ui.strings` through
 * `src/content/ui-strings.ts`. So the relationship pinned here is the one that
 * is left — **the accessor the app actually calls, against the transform this
 * file states** — and it goes through the same function `src/boot/app.ts` does
 * rather than a regex over its source.
 *
 * A row moves from `HARD_CODED` to here when its literal goes. `transform` is
 * unchanged by the move: it is still the deviation, stated once, in public.
 */
const SWAPPED = [
  {
    id: 'pauseTitle',
    where: 'src/render/pause.ts heading, via PauseState.title',
    draws: (l: Level) => uiString(l, 'pauseTitle', '<fallback>'),
    transform: identity,
  },
  {
    id: 'pauseResume',
    where: 'src/boot/app.ts — PAUSE_OPTIONS',
    draws: (l: Level) => uiString(l, 'pauseResume', '<fallback>'),
    transform: identity,
  },
  {
    id: 'pauseRestart',
    where: 'src/boot/app.ts — PAUSE_OPTIONS',
    draws: (l: Level) => uiString(l, 'pauseRestart', '<fallback>'),
    transform: identity,
  },
  {
    id: 'pauseExit',
    where: 'src/boot/app.ts — PAUSE_OPTIONS',
    draws: (l: Level) => uiString(l, 'pauseExit', '<fallback>'),
    transform: identity,
  },
  {
    id: 'launchPrompt',
    where: 'src/boot/app.ts — launchBanner(), the `waiting` phase',
    draws: (l: Level) => uiString(l, 'launchPrompt', '<fallback>'),
    transform: identity,
  },
  {
    id: 'launching',
    where: 'src/boot/app.ts — launchBanner(), the `rising` phase',
    draws: (l: Level) => uiString(l, 'launching', '<fallback>'),
    transform: identity,
  },
  {
    id: 'timeLabel',
    where: 'src/render/hud.ts — the second instrument row, via HudState.timeLabel',
    draws: (l: Level) => uiLabel(l, 'timeLabel', '<fallback>'),
    transform: (s: string) => s.replace(/\s*:$/, '').toUpperCase(),
  },
  {
    id: 'speedLabel',
    where: 'src/render/hud.ts — the third instrument row, via HudState.speedLabel',
    draws: (l: Level) => uiLabel(l, 'speedLabel', '<fallback>'),
    // TWO deviations in one short string: the space before the colon goes with
    // the colon, and the case changes.
    transform: (s: string) => s.replace(/\s*:$/, '').toUpperCase(),
  },
  {
    id: 'gatesCleared',
    where: 'src/render/results.ts — the gate count line, via ResultsState.countLabel',
    draws: (l: Level) => uiLabelWord(l, 'gatesCleared', '<fallback>'),
    // `Gates cleared:` -> `GATES`. The panel has room for one word.
    transform: (s: string) => (s.split(' ')[0] ?? '').replace(/:$/, '').toUpperCase(),
  },
] as const

describe("2016's UI strings, as extracted", () => {
  it('reaches every level, with a briefing and a non-empty label set', () => {
    for (const id of levelIds()) {
      const L = level(id)
      expect(L.ui, id).toBeTruthy()
      expect(L.ui.briefing.length, id).toBeGreaterThan(0)
      expect(Object.keys(L.ui.strings).length, id).toBeGreaterThan(0)
      for (const [k, v] of Object.entries(L.ui.strings)) {
        expect(typeof v, `${id}.${k}`).toBe('string')
        expect(v.length, `${id}.${k}`).toBeGreaterThan(0)
      }
    }
  })

  it('gives every mission of a vehicle the same set, because the HUD is on the ship', () => {
    // A mission's UI comes from the prefab `Level.ShipPrefab` names, so the
    // seven HoverJet missions must agree exactly and the six JumpSeat ones must
    // agree exactly. A per-mission difference would mean the reader is picking
    // something up from the mission scene by accident — the same failure the
    // clouds test guards from the other side.
    const byVehicle = new Map<string, string[]>()
    for (const id of levelIds()) {
      const L = level(id)
      const list = byVehicle.get(L.vehicle) ?? []
      list.push(JSON.stringify([L.ui.briefing, L.ui.strings]))
      byVehicle.set(L.vehicle, list)
    }
    expect([...byVehicle.keys()].sort()).toEqual(['hoverjet', 'jumpseat'])
    for (const [vehicle, list] of byVehicle) {
      expect(new Set(list).size, `${vehicle} missions disagree about their UI strings`).toBe(1)
    }
    // And the two vehicles must NOT agree: the JumpSeat HUD has a fuel gauge
    // and no gate counter. If they matched, the vehicle resolution is broken.
    expect(byVehicle.get('hoverjet')?.[0]).not.toEqual(byVehicle.get('jumpseat')?.[0])
  })

  it('keeps 2016 exactly as it was typed, warts included', () => {
    const hover = level('int_01_hoverJet').ui
    const jump = level('int_01_jumpSeat').ui

    // Sentence case with a space before the colon on the speed label only —
    // the reason this is worth an assertion is that it is the kind of thing a
    // careful port tidies without noticing.
    expect(hover.strings.speedLabel).toMatch(/\s:$/)
    expect(hover.strings.timeLabel).not.toMatch(/\s:$/)
    expect(jump.strings.fuelLabel).toMatch(/\s:$/)

    // The stray capital D that runs through 2016's HUD copy.
    expect(hover.strings.orbsFound).toMatch(/D:$/)
    expect(hover.strings.explorationEnding).toMatch(/EnDing/)
    expect(hover.strings.medalAwarded).toMatch(/AwarDeD!$/)
    // `_CORRECTIONS.md` quotes the medal banner as "<medal> Medal AwarDeD!".
    // The bytes say eight underscores and a LOWER-CASE `medal`.
    expect((hover.strings.medalAwarded ?? '').startsWith('________ medal ')).toBe(true)

    // The out-of-bounds warning is three lines, not one. A reader that folds
    // YAML wrongly returns `Warning!` alone and looks entirely plausible.
    expect((hover.strings.outOfBounds ?? '').split('\n')).toHaveLength(3)

    // A straight apostrophe (U+0027) and a trailing newline — both in the
    // shipped bytes, both lost by the hand-carried copy.
    expect(hover.briefing).toContain("Don't")
    expect(hover.briefing).not.toContain('’')
    expect(hover.briefing.endsWith('\n')).toBe(true)
  })
})

/**
 * The scalar decoder on its own, against synthetic YAML.
 *
 * This is the half of the job that can be wrong in a way no 2016 string would
 * reveal: `tools/prototype/unity_yaml.js` returns a multi-line single-quoted
 * scalar as its FIRST LINE, opening quote attached — a value that is present,
 * plausible and truncated. Every case below is a shape that appears in
 * `PlayerShip_SR14_Photon.prefab`, written out here rather than read from it,
 * so a change to the prefab cannot make a broken decoder look correct.
 *
 * FLOW FOLDING is the rule being pinned: one line break folds to a SPACE, and a
 * break followed by N empty lines produces N newlines.
 */
describe('the YAML scalar decoder', () => {
  const decode = (...lines: string[]): string => {
    const first = (lines[0] ?? '').replace(/^m_Text: ?/, '')
    return (decodeScalar as (f: string, l: string[], i: number) => { value: string })(
      first,
      lines,
      0,
    ).value
  }

  it('reads a plain scalar and strips its trailing whitespace', () => {
    expect(decode('m_Text: RACE COMPLETE!  ')).toBe('RACE COMPLETE!')
  })

  it('reads an empty value as an empty string', () => {
    expect(decode('m_Text:')).toBe('')
  })

  it("undoubles '' inside a single-quoted scalar", () => {
    expect(decode("m_Text: 'Don''t CRASH!!'")).toBe("Don't CRASH!!")
  })

  it('folds a bare line break to a space', () => {
    expect(decode("m_Text: 'one", "    two'")).toBe('one two')
  })

  it('turns a break plus ONE empty line into one newline, and drops the indent', () => {
    // This is the out-of-bounds warning's shape: three lines of copy separated
    // by blank lines, which is a three-line string and not a five-line one.
    expect(decode("m_Text: 'Warning!", '', '    Leaving airspace', '', "    Turn back!'")).toBe(
      'Warning!\nLeaving airspace\nTurn back!',
    )
  })

  it('ends with exactly one newline when the closing quote is two lines down', () => {
    // The briefing's shape. Counting the closing-quote line as another empty
    // line gives two newlines, which nothing on screen would show.
    expect(decode("m_Text: 'body", '', "'")).toBe('body\n')
  })

  it('decodes a double-quoted escape', () => {
    expect(decode('m_Text: "\\uF023"')).toBe('\uf023')
  })
})

describe('the literals in src/ that these replace', () => {
  const ui = level('int_01_hoverJet').ui

  it.each(HARD_CODED.map((h) => [h.id, h] as const))(
    '%s — transform(extracted) is exactly what the source still hard-codes',
    (_id, spec) => {
      const extracted = ui.strings[spec.id]
      expect(extracted, `${spec.id} missing from level.ui.strings`).toBeTruthy()
      expect(spec.transform(extracted ?? ''), spec.where).toBe(spec.read())
    },
  )

  it.each(SWAPPED.map((h) => [h.id, h] as const))(
    '%s — the swap landed: what the app draws IS transform(extracted)',
    (_id, spec) => {
      const int01 = level('int_01_hoverJet')
      const extracted = int01.ui.strings[spec.id]
      expect(extracted, `${spec.id} missing from level.ui.strings`).toBeTruthy()
      // The fallback must NOT be what comes back — that would mean the data is
      // not arriving and the port is quietly drawing its own word.
      expect(spec.draws(int01), spec.where).not.toBe('<fallback>')
      expect(spec.draws(int01), spec.where).toBe(spec.transform(extracted ?? ''))
    },
  )

  it('draws every swapped string on every mission of both vehicles', () => {
    // The seven above are HoverJet rows checked on one mission. This is the
    // sweep: a string that exists on one mission and not another would make the
    // panel fall back to FF2's own word on that mission alone, which is exactly
    // the kind of per-mission difference nobody would notice.
    for (const id of levelIds()) {
      const L = level(id)
      if (L.vehicle !== 'hoverjet') continue
      for (const spec of SWAPPED) {
        expect(spec.draws(L), `${id}.${spec.id}`).not.toBe('<fallback>')
      }
    }
  })

  it('the HUD count label is now READ from the extracted strings, not hard-coded', () => {
    // The first render swap to land. `countLabel()` takes the level's own 2016
    // string and applies the transform this file documents; the fallback above
    // is only reached by a mission whose vehicle has no such label. This is the
    // end-to-end check that the data actually arrives — it goes through the
    // same function `src/boot/app.ts` calls.
    const int01 = level('int_01_hoverJet')
    expect(countLabel(int01, 'ringAttack')).toBe(
      (ui.strings.gatesLabel ?? '').replace(/:$/, '').toUpperCase(),
    )
    expect(countLabel(int01, 'freeFlight')).toBe(
      (ui.strings.orbsFound ?? '').split(' ')[0]?.replace(/:$/, '').toUpperCase(),
    )
    // The JumpSeat set carries neither label, so Target Practice falls back to
    // the port's own word — which is a deviation, and is on the record in
    // `src/game/modes.ts` rather than hidden in a branch.
    const jump = level('int_01_jumpSeat')
    expect(jump.ui.strings.gatesLabel).toBeUndefined()
    expect(jump.ui.strings.orbsFound).toBeUndefined()
    expect(countLabel(jump, 'targetPractice')).toBe('PADS')
  })

  it('draws the briefing 2016 shipped, not the one the port had retyped', () => {
    // The literal this replaces was wrong in exactly two ways, and both are the
    // signature of a string copied by eye: the apostrophe had been normalised
    // from U+0027 to U+2019, and the trailing newline was dropped.
    //
    // The assertion is on `uiBriefing`, the function `src/boot/app.ts` calls —
    // not on a regex over its source — so it fails if the data stops arriving
    // as well as if the transform changes.
    const int01 = level('int_01_hoverJet')
    const drawn = uiBriefing(int01, '<fallback>')
    expect(drawn).toBe(int01.ui.briefing)
    expect(drawn).not.toBe('<fallback>')
    // The two things the old literal got wrong, asserted on what we now draw.
    expect(drawn.endsWith('\n')).toBe(true)
    expect(drawn).toContain("Don't")
    expect(drawn).not.toContain('’')
    // Every HoverJet mission, because a briefing is per-ship-prefab and a
    // mission that lost it would fall back silently.
    for (const id of levelIds()) {
      const L = level(id)
      expect(uiBriefing(L, '<fallback>'), id).not.toBe('<fallback>')
    }
  })
})
