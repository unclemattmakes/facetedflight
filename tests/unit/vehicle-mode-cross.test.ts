/**
 * tests/unit/vehicle-mode-cross.test.ts — DEV-230. The crossing is a single
 * variable, and the sweep refuses an arm list that is not.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Wave 3 §3 fitted a **2.07 ms term that separates the HoverJet missions from
 * the JumpSeat ones**, and said in the same paragraph that it must not be
 * called "the vehicle": every HoverJet mission is `ringAttack` and every
 * JumpSeat mission is `targetPractice`, so the shipped thirteen cannot separate
 * vehicle from mode. `tools/perf/vehicle-mode-sweep.mjs` separates them by
 * flying two authored crossing levels next to two shipped ones.
 *
 * That sweep costs half an hour on a quiet box with a SteamVR compositor up —
 * the most expensive test conditions this project has. Everything it depends on
 * that is DATA rather than a millisecond is checked here instead, for free:
 *
 *  1. **each authored level differs from its source in exactly `id` and
 *     `vehicle`.** A copy that drifted in any other key would read as a vehicle
 *     effect, and the sweep could not tell the difference. Asserted as a
 *     RELATIONSHIP between the two files and never against a stored value —
 *     trap 24, and the same shape as `refRoot()` being a PREFIX of
 *     `legacyRoot()` rather than equal to a re-derived slice.
 *  2. **the runner's `runningModeOf` agrees with the game's `runningMode`.**
 *     The runner is `.mjs` and cannot import the TypeScript module, so the rule
 *     is written twice; this is what stops the two drifting apart in silence.
 *  3. **the pre-flight DETECTS**, not merely passes. A guard that has only ever
 *     been seen to say "ok" is `assets:check` reporting `0/0 ready verified`
 *     while the HoverJet flew backwards.
 *  4. **the rejected arms stay rejected.** Four were thrown out by the free-cut
 *     test and each would report a free cut that reads like a result.
 *
 * None of it needs a headset, a browser or a GPU.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GameMode, Level } from '../../src/content/level-schema'
import { validateLevel } from '../../src/content/level-schema'
import { MODES, runningMode } from '../../src/game/modes'
import type { Arm, ArmReading, ArmRow } from '../../tools/perf/vehicle-mode-sweep.mjs'
import {
  armQuery,
  BASELINE,
  DEFAULT_ARMS,
  expectedCockpitMs,
  FLIGHT_PATH_TOLERANCE_M,
  FLIGHT_SPAN_TOLERANCE_S,
  flightAgreement,
  PIN_QUERY,
  preflight,
  preflightAll,
  readTrace,
  report,
  runningModeOf,
  SCALE_TOLERANCE,
  TEACHING_MODES,
  WAVE3_COCKPIT_MS,
  WAVE3_RIG_PX,
} from '../../tools/perf/vehicle-mode-sweep.mjs'

const REPO = path.join(__dirname, '..', '..')

/**
 * The crossings, as the sweep's arm list relies on them.
 *
 * `source` is the SHIPPED level each authored one was copied from. The test
 * derives the whole expectation from that pair, so adding a third crossing is
 * one row here and no new assertion.
 */
const CROSSINGS = [
  {
    authored: 'dev230_int01_jumpSeat',
    source: 'int_01_hoverJet',
    vehicle: 'jumpseat',
    why: 'block A — the JumpSeat on the HoverJet course, launch rig and turn indicators intact',
  },
  {
    authored: 'dev230_adv02_hoverJet',
    source: 'adv_02_jumpSeat',
    vehicle: 'hoverjet',
    why: 'block B — the HoverJet on a course with no launch rig and no turn indicators',
  },
] as const

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')) as Record<string, unknown>

const levelIdsOnDisk = (): string[] =>
  fs
    .readdirSync(path.join(REPO, 'content', 'levels'))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.slice(0, -'.json'.length))

describe('the authored crossing levels', () => {
  for (const cross of CROSSINGS) {
    describe(cross.authored, () => {
      it('exists in content/authored, NOT beside the generated thirteen', () => {
        // `check-content.mjs`'s `inventory()` hashes every `*.json` under
        // `content/levels`, so an authored file there fails `extract:check`
        // with `+ content/levels/<id>.json (not in the manifest)` — and adding
        // it to the manifest would make the manifest mean something other than
        // what its own header says. `load-level.ts:32` reads both trees.
        expect(
          fs.existsSync(path.join(REPO, 'content', 'authored', `${cross.authored}.json`)),
          `${cross.authored}.json is missing from content/authored/`,
        ).toBe(true)
        expect(
          fs.existsSync(path.join(REPO, 'content', 'levels', `${cross.authored}.json`)),
          'an authored level under content/levels/ breaks the generated-tree manifest',
        ).toBe(false)
      })

      it('differs from its source in EXACTLY id and vehicle', () => {
        const source = readJson(`content/levels/${cross.source}.json`)
        const authored = readJson(`content/authored/${cross.authored}.json`)

        // The relationship, not a stored value. Re-serialise both with the two
        // crossing fields normalised away: what is left must be byte-identical,
        // which is true of any correct copy and false for every kind of drift —
        // a re-extraction, a hand edit, a source that moved underneath it.
        const strip = (o: Record<string, unknown>): string => {
          const { id: _id, vehicle: _vehicle, ...rest } = o
          return JSON.stringify(rest)
        }
        expect(
          strip(authored),
          `${cross.authored} has drifted from ${cross.source} in some key other than ` +
            'id/vehicle. Every such difference would read as a vehicle effect in the ' +
            'sweep, and nothing downstream could tell them apart. Re-derive it.',
        ).toBe(strip(source))

        expect(authored.id).toBe(cross.authored)
        expect(authored.vehicle).toBe(cross.vehicle)
        expect(source.vehicle).not.toBe(cross.vehicle)
      })

      it('validates, and its id matches the filename loadLevel keys on', () => {
        const authored = readJson(`content/authored/${cross.authored}.json`)
        expect(() => validateLevel(authored as unknown as Level)).not.toThrow()
        // `loadLevel` finds the file by NAME and never reads `id`, so a
        // mismatch is invisible at load and wrong everywhere afterwards — the
        // personal-best key, the ghost lookup and the sweep's own output stem
        // all use one or the other.
        expect(authored.id).toBe(cross.authored)
      })

      it('keeps a forcing out of the way, so ?mode= can cross the mode', () => {
        const authored = readJson(`content/authored/${cross.authored}.json`) as unknown as Level
        // `runningMode` lets the level's own forcing beat the request
        // (`modes.ts:506`). A crossing level that forced a mode would silently
        // ignore `?mode=` and collapse two cells of the 2x2 into one.
        expect(authored.forcedMode).toBeNull()
        expect(authored.forcedModeFf2).toBeNull()
        expect(runningMode(authored, 'ringAttack')).toBe('ringAttack')
        expect(runningMode(authored, 'targetPractice')).toBe('targetPractice')
      })
    })
  }

  it('between them they cover both vehicles', () => {
    expect(new Set(CROSSINGS.map((c) => c.vehicle))).toEqual(new Set(['hoverjet', 'jumpseat']))
  })
})

describe("runningModeOf — the runner's copy of the game's rule", () => {
  /**
   * The rule is written twice, in two languages, and a test that re-derived it
   * a third time would prove nothing (trap 24). So: assert the two
   * IMPLEMENTATIONS agree, over every shipped level crossed with every mode and
   * with no request at all. That is true of any correct pair and false the
   * moment either one changes.
   */
  it('agrees with game/modes.ts on every shipped level and every request', () => {
    const requests: (GameMode | null)[] = [null, ...(Object.keys(MODES) as GameMode[])]
    const ids = [...levelIdsOnDisk(), ...CROSSINGS.map((c) => c.authored)]
    expect(ids.length).toBeGreaterThanOrEqual(13)
    for (const id of ids) {
      const tree = levelIdsOnDisk().includes(id) ? 'levels' : 'authored'
      const level = readJson(`content/${tree}/${id}.json`)
      for (const requested of requests) {
        expect(runningModeOf(level, requested), `${id} with ?mode=${requested ?? '(none)'}`).toBe(
          runningMode(level as unknown as Level, requested ?? undefined),
        )
      }
    }
  })

  it('agrees on a LESSON course too, where a request that stops it teaching is refused (DEV-377)', () => {
    // No lesson file is on disk yet (DEV-378's), so the case the teaching rule
    // exists for is built here: a shipped course carrying a lesson block and
    // running in the row that teaches. Every request, both implementations.
    const teaching = (Object.keys(MODES) as GameMode[]).filter((m) => MODES[m].teaches)
    expect(teaching.length).toBeGreaterThan(0)
    const base = readJson('content/levels/int_01_hoverJet.json')
    const lesson = { ...base, mode: teaching[0], lesson: { steps: [] } }
    const requests: (GameMode | null)[] = [null, ...(Object.keys(MODES) as GameMode[])]
    for (const requested of requests) {
      expect(runningModeOf(lesson, requested), `lesson with ?mode=${requested}`).toBe(
        runningMode(lesson as unknown as Level, requested ?? undefined),
      )
      // And on the course without it, where a teaching request is the refused one.
      expect(runningModeOf(base, requested), `course with ?mode=${requested}`).toBe(
        runningMode(base as unknown as Level, requested ?? undefined),
      )
    }
    // Neither side lets a request cross the line, in either direction.
    for (const m of teaching) expect(runningModeOf(base, m)).toBe(base.mode)
    expect(runningModeOf(lesson, 'ringAttack')).toBe(teaching[0])
  })

  it("carries the game's teaching rows, and no others", () => {
    const teaching = (Object.keys(MODES) as GameMode[]).filter((m) => MODES[m].teaches)
    expect([...TEACHING_MODES].sort()).toEqual(teaching.sort())
  })

  it('lets a level forcing beat the request, which is the rule that can collapse a cell', () => {
    const kauai = readJson('content/levels/hoverJet_kauai_beg.json')
    expect(kauai.forcedMode).toBe('freeFlight')
    expect(runningModeOf(kauai, 'ringAttack')).toBe('freeFlight')
  })
})

describe('preflight — it must DETECT, not merely pass', () => {
  const arm = (over: Partial<Arm>): Arm =>
    ({
      name: 'probe',
      kind: 'cell',
      mechanism: 'content',
      why: '',
      block: 'A',
      ...over,
    }) as Arm

  it('passes the real arm list, all cells distinct', () => {
    const { problems } = preflightAll([BASELINE, ...DEFAULT_ARMS], REPO)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('catches a level that FORCES a mode against the request', () => {
    const r = preflight(
      arm({
        mission: 'hoverJet_kauai_beg',
        query: 'mode=ringAttack',
        vehicle: 'hoverjet',
        mode: 'ringAttack',
      }),
      REPO,
    )
    expect(r.ok).toBe(false)
    expect(r.note).toMatch(/FORCES freeFlight/)
  })

  it('catches an arm claiming the wrong vehicle', () => {
    const r = preflight(
      arm({ mission: 'adv_02_jumpSeat', vehicle: 'hoverjet', mode: 'targetPractice' }),
      REPO,
    )
    expect(r.ok).toBe(false)
    expect(r.note).toMatch(/vehicle is jumpseat/)
  })

  it('catches a level that is on neither tree', () => {
    const r = preflight(arm({ mission: 'no_such_level', vehicle: 'jumpseat' }), REPO)
    expect(r.ok).toBe(false)
    expect(r.note).toMatch(/no such level/)
  })

  it('catches a COLLAPSED 2x2 — two cells at the same (vehicle, mode)', () => {
    // The failure no single row can see: each of these passes its own check
    // while the two of them measure the same thing, and the block's main
    // effects would then be differences between one cell and itself.
    const { problems } = preflightAll(
      [
        arm({ name: 'one', mission: 'int_01_hoverJet', vehicle: 'hoverjet', mode: 'ringAttack' }),
        arm({ name: 'two', mission: 'int_01_hoverJet', vehicle: 'hoverjet', mode: 'ringAttack' }),
      ],
      REPO,
    )
    expect(problems.some((p) => /2 cells at hoverjet\/ringAttack/.test(p))).toBe(true)
  })

  it('catches a block that does not cover all four pairs', () => {
    const { problems } = preflightAll(
      [
        arm({
          name: 'lonely',
          mission: 'int_01_hoverJet',
          vehicle: 'hoverjet',
          mode: 'ringAttack',
        }),
      ],
      REPO,
    )
    expect(problems.some((p) => /covers 1 of the 4/.test(p))).toBe(true)
  })

  it('does NOT read the bracket as a collapse', () => {
    // The runner puts the baseline at both ends and the baseline is also a
    // cell, so the arm list really does contain that arm twice. Two runs of ONE
    // arm are the bracket; two ARMS at one (vehicle, mode) are the collapse.
    // The first version of this check could not tell them apart and refused the
    // runner's own default list — caught by `--dry-run`.
    const { problems } = preflightAll([BASELINE, ...DEFAULT_ARMS, BASELINE], REPO)
    expect(problems, problems.join('\n')).toEqual([])
  })
})

describe('DEFAULT_ARMS', () => {
  it('lays out two complete 2x2 blocks, each on ONE course', () => {
    const cells = [BASELINE, ...DEFAULT_ARMS].filter((a) => a.kind === 'cell')
    for (const block of ['A', 'B']) {
      const inBlock = cells.filter((a) => a.block === block)
      const pairs = new Set(inBlock.map((a) => `${a.vehicle}/${a.mode}`))
      expect(pairs.size, `block ${block} does not cover all four cells`).toBe(4)
      // ONE course per block is what makes a cell-to-cell difference a single
      // variable. Two courses in a block and the "vehicle effect" is a
      // difference between two levels.
      const missions = new Set(inBlock.map((a) => a.mission ?? BASELINE.mission))
      expect(missions.size, `block ${block} spans ${[...missions].join(', ')}`).toBe(2)
    }
  })

  it('never crosses a block boundary in one arm', () => {
    for (const a of DEFAULT_ARMS) {
      if (a.kind !== 'cell') continue
      expect(['A', 'B']).toContain(a.block)
      expect(a.vehicle, `${a.name} must claim a vehicle`).toBeTruthy()
      expect(a.mode, `${a.name} must claim a mode`).toBeTruthy()
    }
  })

  it('carries the calibration arm, whose answer is already known', () => {
    // Wave 3 §5 measured `cockpit.body + cockpit.lighting` at -0.48 ms against
    // a 0.02 ms bracket. It is the only arm in the sweep with a prior, and the
    // report treats it as the licence to read every other row.
    const cal = DEFAULT_ARMS.find((a) => a.name === 'no-cockpit-all')
    expect(cal, 'the calibration arm is gone — nothing else in the run can be checked').toBeTruthy()
    expect([...(cal?.flagsOff ?? [])].sort()).toEqual(['cockpit.body', 'cockpit.lighting'])
  })

  it('carries BOTH racer arms, because the pair is the internal control', () => {
    // `?mode=targetPractice` and `hide racers` remove the same thing by two
    // mechanisms — `opponents` is the only render-side difference between
    // ringAttack and targetPractice, since their `live` sets are identical.
    expect(MODES.ringAttack.live).toEqual(MODES.targetPractice.live)
    expect(MODES.ringAttack.opponents).toBe(true)
    expect(MODES.targetPractice.opponents).toBe(false)
    expect(DEFAULT_ARMS.map((a) => a.name)).toContain('no-racers')
    expect(DEFAULT_ARMS.map((a) => a.name)).toContain('no-racers-built')
  })

  it('keeps the free-cut rejects OUT', () => {
    /**
     * Each of these would report a free cut, which is indistinguishable from a
     * result — the shape of all three retractions in `VR-PERF-WAVE-2-WORK.md`
     * §7. The runner's header carries the measurement or the file:line for
     * each; this is what stops one being added back without reading it.
     *
     *   turn-indicators  2 calls over 684 tri, the order DEV-226 rejected
     *                    `only-horizon-geo` at.
     *   fx.speedLines    stored census delta `calls 0, tri -24`, and
     *                    `particle-fx.ts:293` builds the fields on BOTH vehicles.
     *   render.bloom     post over the whole eye buffer, so resolution-DEPENDENT
     *                    — and the term is not.
     *
     * **`launch-anchor` was on this list until DEV-233 and is not any more** —
     * see the next test, which is the half that keeps the removal honest.
     */
    const REJECTED_HIDES = ['turn-indicators']
    const REJECTED_FLAGS = ['fx.speedLines', 'render.bloom']
    for (const a of DEFAULT_ARMS) {
      for (const g of a.hide ?? [])
        expect(REJECTED_HIDES, `${a.name} hides ${g}, which removes no work`).not.toContain(g)
      for (const f of a.flagsOff ?? [])
        expect(REJECTED_FLAGS, `${a.name} switches off ${f}, which removes no work`).not.toContain(
          f,
        )
    }
  })

  it('carries `launch-anchor` again, and as a DRAWS arm so the run can refute it', () => {
    /**
     * DEV-230 rejected this arm on the claim that the launch rig *"draws
     * NOTHING during the flight: `perf-out/census-all/` has no `launch-anchor`
     * or `launch-room` row in ANY of the thirteen"*. The sweep then ran and its
     * own census — `perf-out/vehicle-mode/01-baseline/*.census.json` — carries
     * `launch-anchor`, 9 objects, 1272 triangles, at 60 s.
     *
     * Those are two different walks, so the rejection is **unproven** rather
     * than refuted, and that distinction is the whole reason the arm is back:
     * an argument about which census to believe costs more than one flight.
     *
     * The mechanism must be `draws`, because that is what makes the arm able to
     * say DEV-230 was right: a `draws` row with no fall in `calls` prints
     * `ARM DID NOT FIRE`, which is exactly the finding *"the launch rig was
     * already not drawn"*. An arm that cannot report its own refutation is not
     * an experiment.
     */
    const arm = DEFAULT_ARMS.find((a) => a.name === 'no-launch-anchor')
    expect(
      arm,
      'DEV-233 put this arm back — removing it needs an argument, not a delete',
    ).toBeTruthy()
    expect(arm?.hide).toEqual(['launch-anchor'])
    expect(arm?.mechanism, 'a hide arm proves itself by the call count falling').toBe('draws')
    expect(arm?.kind, 'it is subtractive on the baseline, where the flight reproduces').toBe(
      'suspect',
    )
  })

  it('prices the particle fields, which a triangle count could never see', () => {
    // `fx.speedLines` was rejected partly on `calls 0, triangles -24` — a
    // measurement of GEOMETRY about a system whose entire cost is transparent
    // additive overdraw. The group hide is a different instrument from the
    // flag, and it is the one that can answer the question.
    const arm = DEFAULT_ARMS.find((a) => a.name === 'no-particle-fx')
    expect(arm?.hide).toEqual(['particle-fx'])
    expect(arm?.mechanism).toBe('draws')
  })

  it('marks the light arm as `lights`, because a PointLight issues no draw call', () => {
    /**
     * The first run printed `no-cockpit-light` as **ARM DID NOT FIRE** — its
     * calls came back 395 against the bracket's 394 — while the flag had worked
     * perfectly. A `build` arm is proved by the call count falling and a light
     * has no call to lose, so the proof could not apply. A proof that cannot
     * apply is not a failed proof, and printing it in capitals beside a real
     * 0.54 ms is how a good row gets thrown away.
     */
    const arm = DEFAULT_ARMS.find((a) => a.name === 'no-cockpit-light')
    expect(arm?.mechanism).toBe('lights')
    // And the mechanism that DOES have a call signature keeps it.
    expect(DEFAULT_ARMS.find((a) => a.name === 'no-cockpit-body')?.mechanism).toBe('build')
  })

  it('gives every arm a mechanism and a reason', () => {
    for (const a of [BASELINE, ...DEFAULT_ARMS]) {
      expect(a.mechanism, `${a.name} has no mechanism`).toBeTruthy()
      expect(a.why.length, `${a.name} has no reason`).toBeGreaterThan(20)
    }
  })
})

describe('report — what it refuses, and what it renders', () => {
  /**
   * The report runs ONCE, at the end of a half-hour sweep on a box that had to
   * be quiet to produce the numbers. An exception there, or a table that reads
   * a missing cell as a zero, costs the whole sitting — so every branch is
   * driven here on synthetic rows instead. `echo` exists for exactly this.
   */
  /**
   * A healthy arm: one flight, one resolution, one rig.
   *
   * The flight and the scale are the SAME on every synthetic row on purpose —
   * that is what a sweep looks like when it works, and it means every
   * pre-DEV-233 assertion in this block still tests what it always tested. The
   * arms that fly differently are built by name, below.
   *
   * `rig` is wave 3's own 1512 px so the calibration's derived expectation is
   * exactly `WAVE3_COCKPIT_MS` — the fixture asserts the relationship rather
   * than carrying a second copy of the number (trap 24).
   */
  const reading = (
    p50: number,
    calls: number,
    flight: { path?: number; span?: number; scale?: number } = {},
  ): ArmReading => ({
    gpu: { p50, p95: p50 + 1.5 },
    dt: null,
    render: null,
    frames: 4000,
    gpuFrames: 3900,
    hitches: 2,
    tierFraction: 0.1,
    trace: {
      calls,
      triangles: 4.4e6,
      rows: 4000,
      path: flight.path ?? 7873,
      span: flight.span ?? 60,
      scale: flight.scale ?? 0.6,
      bbox: { x: 2282, z: 3859 },
    },
    rig: { w: WAVE3_RIG_PX, h: WAVE3_RIG_PX },
  })

  const OPTS = { mission: BASELINE.mission, edition: 'anniversary', seconds: 60 }

  /** A world where the VEHICLE carries 2 ms and the mode carries nothing. */
  const vehicleWorld = (arm: Arm): number => {
    if (arm.kind === 'suspect') {
      const cut: Record<string, number> = {
        'no-cockpit-all': 0.48,
        'no-cockpit-body': 0.3,
        'no-cockpit-light': 0.18,
      }
      return 5.7 - (cut[arm.name] ?? 0.01)
    }
    return (arm.block === 'B' ? 3.7 : 5.7) + (arm.vehicle === 'hoverjet' ? 0 : -2.0)
  }

  const rowsFor = (gpu: (arm: Arm) => number, arms: readonly Arm[] = DEFAULT_ARMS): ArmRow[] =>
    [BASELINE, ...arms, BASELINE].map((arm, i) => ({
      arm,
      dir: `x/${i}`,
      mission: arm.mission ?? BASELINE.mission,
      status: 0,
      read: reading(arm.name === BASELINE.name ? 5.7 : gpu(arm), 400 - i),
    }))

  const run = (rows: ArmRow[]): string[] => {
    const lines: string[] = []
    report(rows, OPTS, (l = '') => lines.push(l))
    return lines
  }

  it('renders every section without throwing', () => {
    const text = run(rowsFor(vehicleWorld)).join('\n')
    expect(text).toContain('BRACKET')
    expect(text).toContain('BLOCK A')
    expect(text).toContain('BLOCK B')
    expect(text).toContain('VEHICLE effect')
    expect(text).toContain('SUSPECTS')
    expect(text).toContain('CALIBRATION')
  })

  it('names a block as ONE course flown by two files, never as two courses', () => {
    // A reader who takes `a + b` as two courses has misread the whole design.
    const text = run(rowsFor(vehicleWorld)).join('\n')
    expect(text).toMatch(/BLOCK A — the int_01_hoverJet course — flown as/)
    expect(text).not.toContain('this is not one course')
  })

  it('reaches THE VEHICLE when the ship carries it and the mode does not', () => {
    const text = run(rowsFor(vehicleWorld)).join('\n')
    expect(text).toContain('THE VEHICLE.')
  })

  it('reaches THE MODE when the mode carries it and the ship does not', () => {
    const modeWorld = (arm: Arm): number =>
      arm.kind === 'suspect'
        ? 5.7 - (arm.name === 'no-racers' ? 2.0 : 0.01)
        : (arm.block === 'B' ? 3.7 : 5.7) + (arm.mode === 'ringAttack' ? 0 : -2.0)
    const text = run(rowsFor(modeWorld)).join('\n')
    expect(text).toContain('THE MODE.')
    // ...and the internal control must then AGREE, because `hide racers` was
    // given the same 2.0 ms. Two mechanisms, one quantity.
    expect(text).toContain('They AGREE')
  })

  it('says so when the mode effect and `hide racers` disagree', () => {
    // The finding worth more than either number: something else is mode-gated.
    const text = run(rowsFor(vehicleWorld)).join('\n')
    expect(text).toContain('They DISAGREE')
    expect(text).toContain('the enumeration missed it')
  })

  it('refuses everything when there is no bracket', () => {
    const rows = rowsFor(vehicleWorld).slice(0, -1)
    const text = run(rows).join('\n')
    expect(text).toContain('NO BRACKET')
    expect(text).not.toContain('VEHICLE effect')
  })

  it('refuses a main effect below the bracket rather than reporting it', () => {
    // Everything flat, and the bracket drifts 0.4 — so no cell difference can
    // be told from the drift. The 2.07 ms simply did not reproduce, which is a
    // result about the course and must not read as one about the vehicle.
    const flat = (arm: Arm): number => (arm.block === 'B' ? 3.7 : 5.7)
    const rows = rowsFor(flat)
    rows[rows.length - 1] = { ...rows[rows.length - 1], read: reading(6.1, 380) } as ArmRow
    const text = run(rows).join('\n')
    expect(text).toContain('NEITHER clears the bracket')
  })

  it('refuses an incomplete block instead of filling it from the other one', () => {
    // A diagonal across two courses is not a variable, and a half-finished
    // sweep tempts you into exactly that.
    const arms = DEFAULT_ARMS.filter((a) => a.name !== 'A-js-target')
    const text = run(rowsFor(vehicleWorld, arms)).join('\n')
    expect(text).toContain('Block A is incomplete')
    expect(text).toContain('is NOT filled')
    // Block B is untouched and must still be read.
    expect(text).toMatch(/BLOCK B/)
  })

  it('prints DID NOT RUN for an arm that left nothing on disk', () => {
    const rows = rowsFor(vehicleWorld).map((r) =>
      r.arm.name === 'no-rings' ? ({ ...r, read: null } as ArmRow) : r,
    )
    const text = run(rows).join('\n')
    expect(text).toContain('DID NOT RUN')
  })

  it('flags a failed calibration rather than letting the run be filed', () => {
    const broken = (arm: Arm): number =>
      arm.kind === 'suspect' && arm.name === 'no-cockpit-all' ? 5.69 : vehicleWorld(arm)
    const text = run(rowsFor(broken)).join('\n')
    expect(text).toContain('IT DID NOT REPRODUCE')
  })

  // ── DEV-233: the two refusals the first run needed ────────────────────

  /** The same rows, with one arm's flight or resolution moved by name. */
  const rowsWith = (
    moved: Record<string, { path?: number; span?: number; scale?: number }>,
  ): ArmRow[] =>
    rowsFor(vehicleWorld).map((r) =>
      moved[r.arm.name]
        ? ({
            ...r,
            read: reading(r.read?.gpu?.p50 ?? 5.7, r.read?.trace?.calls ?? 400, moved[r.arm.name]),
          } as ArmRow)
        : r,
    )

  it('refuses a block whose cells did not fly the same course', () => {
    /**
     * The real shape, from `perf-out/vehicle-mode/`: the baseline flew 7873 m
     * and block A's two JumpSeat cells sat at their spawn for sixty seconds.
     * A bracket cannot see this — it says the INSTRUMENT held still, not that
     * the arms measured one world — and the 0.88 ms "mode effect" it produced
     * was the difference between crossing an island and not moving.
     */
    const text = run(rowsWith({ 'A-js-ring': { path: 0 }, 'A-js-target': { path: 0 } })).join('\n')
    expect(text).toContain("BLOCK A'S CELLS DID NOT FLY THE SAME COURSE")
    expect(text).toContain('mission.ts:594')
    // ...and it must NOT then print a main effect for that block.
    const blockA = text.slice(text.indexOf('BLOCK A'), text.indexOf('BLOCK B'))
    expect(blockA).not.toContain('VEHICLE effect')
    // Block B is untouched and is still read, so one bad block does not void
    // the other — the same posture as the incomplete-block refusal above.
    expect(text.slice(text.indexOf('BLOCK B'))).toContain('VEHICLE effect')
  })

  it('refuses a block on DURATION even when every path matches', () => {
    // Block B's real failure: two cells flew 3233 m apiece, identical to the
    // metre, and recorded 27.4 s of a 60 s arm because the run ended.
    const text = run(rowsWith({ 'B-hj-ring': { span: 27.4 }, 'B-hj-target': { span: 27.4 } })).join(
      '\n',
    )
    expect(text).toContain("BLOCK B'S CELLS DID NOT FLY THE SAME COURSE")
    expect(text).toContain('27.4')
  })

  it('refuses a suspect whose render scale moved, and prints the pixel ratio', () => {
    // `no-cockpit-all` ran at 1.000 against a bracket at 0.600 on the first
    // run: 2.78x the pixels, inside one subtraction. The row is not a bad
    // measurement of the cockpit, it is a subtraction between two pictures.
    const text = run(rowsWith({ 'no-cockpit-all': { scale: 1 } })).join('\n')
    expect(text).toContain('SCALE MOVED')
    expect(text).toContain('2.78x the pixels')
    expect(text).toContain('NOT COMPARED')
  })

  it('does not refuse a scale that only wobbled inside the tolerance', () => {
    // The relationship, not a pair of literals (trap 24). `ADAPTIVE_STEPS` is a
    // five-rung ladder, so the smallest REAL move is 0.6 -> 0.7; the tolerance
    // exists to let a median that landed between two rungs through while still
    // catching a rung. A guard that fired on rounding is a guard people mute.
    const inside = run(rowsWith({ 'no-rings': { scale: 0.6 + SCALE_TOLERANCE / 2 } })).find((l) =>
      l.includes('no-rings'),
    )
    expect(inside).not.toContain('SCALE MOVED')
    const outside = run(rowsWith({ 'no-rings': { scale: 0.6 + SCALE_TOLERANCE * 2 } })).find((l) =>
      l.includes('no-rings'),
    )
    expect(outside).toContain('SCALE MOVED')
  })

  it('does not call a light arm ARM DID NOT FIRE', () => {
    /**
     * `no-cockpit-light` removes two `PointLight`s and three issues no draw for
     * a light, so its `calls` cannot fall. The first run printed the capitals
     * beside a real 0.54 ms. A proof that cannot apply is not a failed proof.
     */
    const rows = rowsFor(vehicleWorld).map((r) =>
      r.arm.name === 'no-cockpit-light'
        ? ({ ...r, read: reading(5.52, 401) } as ArmRow) // calls UP, as they were
        : r,
    )
    const line = run(rows).find((l) => l.includes('no-cockpit-light')) ?? ''
    expect(line).not.toContain('ARM DID NOT FIRE')
    expect(line).toContain('light COUNT')
  })

  it('still calls a DRAWS arm out when its call count did not fall', () => {
    // The other half of the same rule — relaxing the light case must not
    // relax the case the column exists for. `no-launch-anchor` is the arm
    // whose whole value is being able to report this.
    const rows = rowsFor(vehicleWorld).map((r) =>
      r.arm.name === 'no-launch-anchor' ? ({ ...r, read: reading(5.6, 999) } as ArmRow) : r,
    )
    const line = run(rows).find((l) => l.includes('no-launch-anchor')) ?? ''
    expect(line).toContain('ARM DID NOT FIRE')
  })
})

// ── DEV-233 ──────────────────────────────────────────────────────────────
//
// The sweep ran once and the crossing half of it was void, for two reasons
// neither the bracket nor the pre-flight could see. Everything below is the
// half of the fix that is arithmetic, so it is checked here for free rather
// than on a quiet box with a compositor up.

describe('the render scale is PINNED on every arm', () => {
  it('appends ?adaptive=0 to every arm in the list', () => {
    // The first run did not pass it and the adaptive controller moved under
    // three rows, including the calibration arm — 0.600 on the bracket against
    // 1.000 on `no-cockpit-all`, which is 2.78x the pixels inside one
    // subtraction. `quality-pin.ts`'s own header, written months earlier, says
    // exactly why the switch exists.
    for (const arm of [BASELINE, ...DEFAULT_ARMS]) {
      expect(armQuery(arm), `${arm.name} would run with the controller free`).toContain(PIN_QUERY)
    }
  })

  it('keeps the arm’s own query as well as the pin', () => {
    const modeArm = DEFAULT_ARMS.find((a) => a.name === 'A-hj-target') as Arm
    expect(modeArm.query).toBe('mode=targetPractice')
    const q = armQuery(modeArm)
    expect(q).toContain('mode=targetPractice')
    expect(q).toContain(PIN_QUERY)
    expect(q.startsWith('&')).toBe(false)
    expect(armQuery(BASELINE)).toBe(PIN_QUERY)
  })

  it('lets an arm that spells `adaptive=` itself win', () => {
    // The pin is a default, not a clamp. An arm whose whole subject was the
    // controller would otherwise be silently overruled by a global — the shape
    // of bug that makes a harness measure a build nobody runs.
    const own = {
      name: 'x',
      kind: 'suspect',
      mechanism: 'content',
      why: '',
      query: 'adaptive=1',
    } as unknown as Arm
    expect(armQuery(own)).toBe('adaptive=1')
  })

  it('--no-pin gives back exactly what the arm asked for', () => {
    expect(armQuery(BASELINE, false)).toBe('')
    expect(armQuery(DEFAULT_ARMS.find((a) => a.name === 'A-hj-target') as Arm, false)).toBe(
      'mode=targetPractice',
    )
  })
})

describe('flightAgreement — the refusal the first run needed', () => {
  const at = (p: number | null, span: number | null): ArmRow =>
    ({
      arm: BASELINE,
      read: {
        trace: { calls: 1, triangles: 1, rows: 1, path: p, span, scale: 0.6, bbox: null },
      },
    }) as unknown as ArmRow

  it('accepts the spread a real reproducible sweep actually produced', () => {
    // The eight suspect arms of the first run — same mission, same mode, same
    // autopilot — flew 7871, 7873, 7873, 7873, 7873, 7875 and 7831 m. That is
    // what "the same flight" looks like on this route, and the tolerance has to
    // be a floor under absurdity rather than a bound on noise.
    const real = [7871, 7873, 7873, 7873, 7873, 7875, 7831]
    expect(flightAgreement(real.map((p) => at(p, 60))).ok).toBe(true)
  })

  it('refuses block A’s shape — one cell flew nothing at all', () => {
    const got = flightAgreement([at(7873, 60), at(1538, 60), at(0, 60), at(0, 60)])
    expect(got.ok).toBe(false)
    expect(got.note).toContain('7873')
  })

  it('refuses block B’s shape, where the PATHS agree and the durations do not', () => {
    /**
     * This is the case that makes the two halves worth having separately. Block
     * B's two HoverJet cells flew 3233 m EACH — identical to the metre, which
     * passes any path test — and recorded 27.4 s of a 60 s arm, because a
     * HoverJet on a JumpSeat course has no rings, aims at the finish volume
     * from the first tick and reaches it. A path-only guard waves this through.
     */
    const got = flightAgreement([at(3233, 27.4), at(3233, 27.4), at(3233, 59.2), at(3233, 59.2)])
    expect(got.ok).toBe(false)
    expect(got.note).toContain('27.4')
    expect(got.note).not.toContain('m, a spread')
  })

  it('does not fail closed on a trace that carries no ship track', () => {
    // A guard that refused on missing data would refuse every historical run
    // rather than the arms that deserve it, and a refusal everybody learns to
    // ignore is worse than none. It says it could not check instead.
    const got = flightAgreement([at(null, null), at(null, null)])
    expect(got.ok).toBe(true)
    expect(got.reason).toBe('no flight data')
  })

  it('is decided by the tolerances, not by a hard-coded pair', () => {
    // Assert the RELATIONSHIP the implementation is built on rather than a
    // number the implementation also holds (trap 24): one metre inside the
    // tolerance passes, one metre outside it does not.
    expect(flightAgreement([at(1000, 60), at(1000 + FLIGHT_PATH_TOLERANCE_M - 1, 60)]).ok).toBe(
      true,
    )
    expect(flightAgreement([at(1000, 60), at(1000 + FLIGHT_PATH_TOLERANCE_M + 1, 60)]).ok).toBe(
      false,
    )
    expect(flightAgreement([at(1000, 60), at(1000, 60 - FLIGHT_SPAN_TOLERANCE_S - 0.1)]).ok).toBe(
      false,
    )
  })
})

describe('expectedCockpitMs — the calibration stops crying wolf', () => {
  it('is wave 3’s own number on wave 3’s own rig', () => {
    expect(expectedCockpitMs(WAVE3_RIG_PX)).toBeCloseTo(WAVE3_COCKPIT_MS, 10)
  })

  it('scales with AREA, which is the claim being made about the cockpit', () => {
    // The relationship, not the value: doubling the per-eye width is four times
    // the pixels and therefore four times a pure fill cost. True whatever
    // either constant is later re-measured to be.
    const one = expectedCockpitMs(WAVE3_RIG_PX) as number
    expect(expectedCockpitMs(2 * WAVE3_RIG_PX) as number).toBeCloseTo(4 * one, 10)
    expect(expectedCockpitMs(WAVE3_RIG_PX / 2) as number).toBeCloseTo(one / 4, 10)
  })

  it('reproduces the brief’s arithmetic for the rig this sweep actually ran on', () => {
    // 1512 -> 2016 px/eye: 0.48 x (2016/1512)^2 = 0.853, against 0.85 measured.
    // The arm looked broken and its PREMISE was stale, not its reading.
    expect(expectedCockpitMs(2016) as number).toBeCloseTo(0.853, 2)
  })

  it('refuses to guess when the rig is unknown', () => {
    // A pre-DEV-227 trace, or the flat path. A calibration against an unknown
    // rig is not a calibration, and `null` is what makes the report say so.
    expect(expectedCockpitMs(null)).toBeNull()
    expect(expectedCockpitMs(0)).toBeNull()
    expect(expectedCockpitMs(Number.NaN)).toBeNull()
  })

  it('does NOT take a render-scale factor, deliberately', () => {
    // The tempting fix, and the wrong one: the arm's millisecond is
    // `baseline - arm`, so a resolution change moves the WHOLE frame and
    // correcting the expectation for it would quietly claim everything else in
    // the picture cost the same at 2.78x the pixels. The scale is a REFUSAL in
    // `report()`, not a correction here. This pins the arity so the factor
    // cannot come back without somebody reading that argument.
    expect(expectedCockpitMs.length).toBe(1)
  })
})

describe('readTrace reads the flight, by column name', () => {
  const csv = (columns: string[], rows: number[][]): string =>
    [
      JSON.stringify({ columns, projection: [{ viewport: { x: 0, y: 0, w: 2016, h: 2016 } }] }),
      columns.join(','),
      ...rows.map((r) => r.join(',')),
    ].join('\n')

  const write = (text: string): string => {
    const p = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-trace-')),
      'x-anniversary-60s-vrto3d.trace.csv',
    )
    fs.writeFileSync(p, text)
    return p
  }

  it('sums the path, spans the clock and medians the scale', () => {
    // A 3-4-5 triangle so the distance is exact and not a rounding claim.
    const p = write(
      csv(
        ['calls', 'tris', 'ship_x', 'ship_z', 'elapsed_s', 'scale'],
        [
          [10, 100, 0, 0, 0, 1],
          [10, 100, 3, 4, 5, 0.6],
          [10, 100, 3, 4, 9, 0.6],
        ],
      ),
    )
    const got = readTrace(p)
    expect(got?.path).toBeCloseTo(5, 10)
    expect(got?.span).toBeCloseTo(9, 10)
    expect(got?.scale).toBeCloseTo(0.6, 10)
    expect(got?.bbox).toEqual({ x: 3, z: 4 })
  })

  it('survives a wire format that does not carry the ship at all', () => {
    // perf-protocol §5a: the column list is APPENDED to, so reading by index is
    // right until it is not — and an OLD trace is the mirror of that hazard.
    const p = write(csv(['calls', 'tris'], [[10, 100]]))
    const got = readTrace(p)
    expect(got?.calls).toBe(10)
    expect(got?.path).toBeNull()
    expect(got?.span).toBeNull()
    expect(got?.scale).toBeNull()
  })

  it('finds the columns wherever they are, not where they were', () => {
    // The same three numbers with the columns in a different order.
    const p = write(
      csv(
        ['scale', 'ship_z', 'calls', 'elapsed_s', 'ship_x', 'tris'],
        [
          [1, 0, 10, 0, 0, 100],
          [0.6, 4, 10, 5, 3, 100],
        ],
      ),
    )
    const got = readTrace(p)
    expect(got?.path).toBeCloseTo(5, 10)
    expect(got?.span).toBeCloseTo(5, 10)
  })
})
