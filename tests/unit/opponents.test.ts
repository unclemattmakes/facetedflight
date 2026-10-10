// tests/unit/opponents.test.ts — who else is flying, and why nobody is in five
// of the thirteen missions.
//
// ── The bug this exists for ──────────────────────────────────────────────
//
// `boot/app.ts` loaded two AI racers unconditionally, so every JumpSeat mission
// had a pair of HoverJets racing a ring course the mode does not score. It went
// unnoticed because nobody had ever loaded a JumpSeat mission and looked.
//
// ── And why the obvious counter-evidence is not evidence ─────────────────
//
// Three JumpSeat scenes DO carry a `GhostRacer` — `adv_01_jumpSeat` and
// `rookie_02_jumpSeat` two each, `adv_02_jumpSeat` four. Read naively, 2016
// therefore has opponents in Target Practice and the gate below is a deviation
// from the shipped game.
//
// It is not, and the reason is the measurement in the second test: every one of
// those ghosts points at a course in a DIFFERENT ENVIRONMENT. That is the whole
// argument, so it is a test rather than a paragraph — if someone later decides
// the gate is over-zealous and deletes it, this is what says why it was there.
//
// The agreement lesson (`docs/DEVIATIONS.md`) is the shape of it: "the JumpSeat
// scenes have no ghosts" and "the JumpSeat scenes have ghosts that mean nothing"
// agree on what to DO and disagree completely about what is true, and only the
// second one survives looking.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { MODES, rulesFor, runningMode } from '@/game/modes'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS = path.join(ROOT, 'content', 'levels')

const levels = (): Level[] =>
  fs
    .readdirSync(LEVELS)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(LEVELS, f), 'utf8')) as Level)

/** `int_01_leftSpawn_fast_01` -> `int_01`. The clip's home course. */
const homeCourse = (clip: string): string => clip.replace(/_(left|right)Spawn.*$/, '')

describe('only a race has opponents', () => {
  it('is a row per mode, not a condition', () => {
    expect(MODES.ringAttack.opponents).toBe(true)
    expect(MODES.targetPractice.opponents).toBe(false)
    expect(MODES.freeFlight.opponents).toBe(false)
  })

  it('gives six missions opponents and seven none', () => {
    // Six HoverJet Ring Attack missions race. All six JumpSeat missions are
    // Target Practice and do not (`int_02_jumpSeat` was 2016-forced into Free
    // Flight until DEV-061, and neither mode races), and neither does
    // `hoverJet_kauai_beg`, whose forcing to Free Flight FF2 keeps.
    const racing = levels().filter((l) => rulesFor(runningMode(l)).opponents)
    expect(racing.map((l) => l.id).sort()).toEqual([
      'adv_01_hoverJet',
      'adv_02_hoverJet',
      'int_01_hoverJet',
      'int_02_hoverJet',
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
    ])
    // Six race, seven do not. `hoverJet_kauai_beg` is the HoverJet mission that
    // does not, which is the whole reason this reads `runningMode` and not
    // `level.vehicle` — the mode decides, not the ship.
    expect(levels().length - racing.length).toBe(7)
  })
})

describe('every JumpSeat ghost is pointed at the wrong world', () => {
  it('separates the two vehicles completely, in opposite directions', () => {
    const byEnv = new Map(levels().map((l) => [l.id, l.environment]))
    let ownCourse = 0
    let otherWorld = 0
    const mismatches: string[] = []

    for (const l of levels()) {
      for (const g of l.ghosts) {
        // The clip's home mission is always a HOVERJET one — 2016 recorded no
        // JumpSeat runs at all, which is itself part of the argument.
        const home = `${homeCourse(g.clip)}_hoverJet`
        const homeEnv = byEnv.get(home)
        expect(homeEnv, `${g.clip} has no home mission`).toBeTruthy()
        if (homeEnv === l.environment) ownCourse += 1
        else {
          otherWorld += 1
          mismatches.push(`${l.id} (${l.environment}) <- ${g.clip} (${homeEnv})`)
        }
      }
    }

    // The measurement, and it is the whole case. Not "most" — ALL of each.
    // Twelve on the HoverJet side (six missions, two ghosts each) and eight on
    // the JumpSeat side: `adv_01` two, `adv_02` four, `rookie_02` two.
    expect(ownCourse, 'ghosts flying their own course').toBe(12)
    expect(otherWorld, `ghosts flying another world:\n${mismatches.join('\n')}`).toBe(8)
  })

  it('puts every correct ghost on a HoverJet mission and every wrong one on a JumpSeat', () => {
    // Stated the other way round, because "12 and 8" would also be satisfied by
    // a split that ran through the middle of each vehicle — which would mean
    // something quite different and would not justify a per-MODE gate.
    const byEnv = new Map(levels().map((l) => [l.id, l.environment]))
    for (const l of levels()) {
      for (const g of l.ghosts) {
        const homeEnv = byEnv.get(`${homeCourse(g.clip)}_hoverJet`)
        const correct = homeEnv === l.environment
        expect(correct, `${l.id} / ${g.clip}`).toBe(l.vehicle === 'hoverjet')
      }
    }
  })

  it('finds every JumpSeat ghost pointing at the SAME alpine clip', () => {
    // One `GhostRacer` object, dragged between three scenes with its clip pool
    // still attached. A per-scene mistake would not land on one clip.
    const jumpSeatClips = new Set(
      levels()
        .filter((l) => l.vehicle === 'jumpseat')
        .flatMap((l) => l.ghosts.map((g) => g.clip)),
    )
    expect([...jumpSeatClips]).toEqual(['rookie_01_leftSpawn_fast_01'])
    expect(levels().find((l) => l.id === 'rookie_01_hoverJet')?.environment).toBe('alpine')
  })
})
