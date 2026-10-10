// tests/unit/variant-sheet-reads.test.ts — every read of the generated sheet
// under `src/sim/` goes through the variant path, or says why it cannot vary.
// DEV-380.
//
// docs/plan/AIRCRAFT-VARIANTS.md §1.3 and §2.3. An aircraft variant is a VIEW
// of the sheet handed to the vehicle's constructor. A sim module that reads a
// vehicle number straight off the generated module instead is a HIDDEN
// STANDARD: the player flies the speed variant and that one number is 2016's
// (the plan's example was the racers' `SEED_SPEED`, which would have put a
// speed racer on its line at the standard's cruise; DEV-382 routed it, with the
// instructor's throttle ceiling, through `sim/hoverjet.ts`'s `cruiseSpeed` over
// the racer's own sheet). CLAUDE.md's "ask what READS this default", made
// structural.
//
// **The finding this test was written on.** CLAUDE.md hard rule 3 says
// `src/sim/constants.ts` is "the sim's ONLY door to the sheet". It is not, and
// was not before DEV-380: at f08e12e, `hoverjet.ts`, `jumpseat.ts`,
// `jumpseat-legs.ts`, `energy.ts`, `energy-race.ts`, `terrain-collision.ts`,
// `craft-contact.ts` and `ai-racer.ts` all imported `HOVERJET`, `JUMPSEAT` or
// `DERIVED` from `@/generated/constants.generated` directly. `constants.ts` is
// the WORLD's door (dt and gravity). The sweep below is what that sentence
// should have been: every direct import is found, and each use is either the
// variant path or a row in DIRECT_READS with its reason.
//
// The rule, per occurrence of an imported sheet name in a sim file (comments
// stripped by a scanner — `stripComments` below says why not by regex):
//
//   - `typeof NAME`                    a type, not a read;
//   - `: SomeSheet = NAME` as a default  THE VARIANT PATH: the function takes a
//                                        sheet and 2016's is only the default;
//   - `scaleSheet<…>(NAME,`             THE VARIANT PATH: the view builder;
//   - anything else                     a DIRECT read, which must be a row in
//                                        DIRECT_READS naming the file, the
//                                        member path, and why it cannot vary.
//
// A row that no longer matches anything fails too, so the table cannot rot
// into a list of reads that were routed long ago.
//
// Proved red twice: by restoring `energySpec`'s `HOVERJET.energy.maxEnergy`
// read (an unlisted direct read), and by adding a row for a read that does not
// exist (a stale row).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTs } from './helpers/source-tree'

const SIM = 'src/sim'

interface DirectRead {
  readonly file: string
  /** The member path as written, from the imported name: `HOVERJET.shipCollisionColliders`. */
  readonly read: string
  readonly why: string
}

/**
 * Every direct read of the sheet under `src/sim/` that does NOT go through a
 * variant's view, and why. Keep the reasons honest: "fixed" means no variant
 * may ever move it; "DEFERRED" means it should, and names who routes it.
 */
const DIRECT_READS: readonly DirectRead[] = [
  {
    file: 'src/sim/constants.ts',
    read: 'WORLD.fixedDeltaTime',
    why: "Fixed: the world's tick (hard rule 5). No variant key is ever `world.*`.",
  },
  {
    file: 'src/sim/constants.ts',
    read: 'WORLD.gravity',
    why:
      "Fixed: the world's gravity. A JumpSeat that falls faster is DEV-384's per-seat " +
      '`gravityScale` MECHANIC, not an edit of the world: `sim/jumpseat.ts` builds the ' +
      "seat's own from this, and the GRAVITY sweep at the end of this file holds the rest.",
  },
  {
    file: 'src/sim/terrain-collision.ts',
    read: 'HOVERJET.hoverMotor.hoverForce',
    why:
      "Fixed: `HOVERJET_GROUND`, the racers' ground contact. The HoverJet's cushion is " +
      'not a variant key; the PLAYER reads it off its own view (`game/flight.ts`).',
  },
  {
    file: 'src/sim/terrain-collision.ts',
    read: 'HOVERJET.hoverMotor.hoverHeight',
    why: 'Fixed: as `hoverForce` above.',
  },
  {
    file: 'src/sim/terrain-collision.ts',
    read: 'HOVERJET.shipCollisionColliders',
    why: 'Fixed: the hull. Every variant is the same airframe (AIRCRAFT-VARIANTS §6.2).',
  },
  {
    file: 'src/sim/craft-contact.ts',
    read: 'HOVERJET.shipCollisionColliders',
    why: "Fixed: the craft volume DEV-364's contact pushes. Same airframe, same hull.",
  },
  {
    file: 'src/sim/jumpseat-legs.ts',
    read: 'JUMPSEAT.legs.map',
    why:
      "Fixed: the landing gear's geometry. Same legs on every variant, and " +
      '`rigidbody.mass`, the one number they share with the seat, is outside every whitelist.',
  },
  {
    file: 'src/sim/jumpseat-legs.ts',
    read: 'JUMPSEAT.colliders.find',
    why:
      "Fixed: as above — the leg capsules' radius, height and composed frame, which the " +
      'strut, hinge and foot are built from (DEV-530).',
  },
  {
    file: 'src/sim/ai-racer.ts',
    read: 'HOVERJET',
    why:
      "Fixed ON PURPOSE (DEV-382 follow-up): `RING_APPROACH_ENVELOPE`, 2016's boosted terminal, " +
      'the speed every racer tuning, the lane rule and the cross-track gain were measured at. ' +
      "It bounds the racers' CONTROLLER, not the jet: only a view that can exceed it (the speed " +
      'jet) is held to it, and only closing on a ring. The racer still flies its own view.',
  },
]

/**
 * Comments out, strings kept. A scanner rather than the two regexes
 * `sim-purity-guard.test.ts` uses, because those run the block-comment pattern
 * first, so a LINE comment holding a glob — `jumpseat.ts:67` names
 * `content/levels/` followed by a star-prefixed file pattern — opens a "block
 * comment" that runs to the next JSDoc's close and eats the code between:
 * there, the file's whole import block. The first draft of this test used
 * those regexes and could not see the JumpSeat's sheet import at all. (The
 * same hole is in the purity guard: four sim files have such a line.)
 */
const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

const IMPORT_RE =
  /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@\/generated\/constants\.generated['"]/g

/** Value names a file imports from the generated sheet (type-only imports are not reads). */
const importedNames = (code: string): string[] => {
  const names: string[] = []
  for (const m of code.matchAll(IMPORT_RE)) {
    if (m[1]) continue
    for (const raw of (m[2] as string).split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) continue
      names.push((part.split(/\s+as\s+/).pop() as string).trim())
    }
  }
  return names
}

interface Use {
  readonly file: string
  readonly read: string
  readonly kind: 'type' | 'default-parameter' | 'view-builder' | 'direct'
}

const classify = (file: string, code: string): Use[] => {
  const body = code.replace(IMPORT_RE, '')
  const uses: Use[] = []
  for (const name of importedNames(code)) {
    const re = new RegExp(`\\b${name}\\b((?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)`, 'g')
    for (const m of body.matchAll(re)) {
      const at = m.index as number
      const before = body.slice(Math.max(0, at - 80), at)
      const after = body.slice(at + m[0].length, at + m[0].length + 4)
      const read = `${name}${(m[1] as string).replace(/\s+/g, '')}`
      let kind: Use['kind'] = 'direct'
      if (/\btypeof\s+$/.test(before)) kind = 'type'
      else if (/:\s*[\w.<>[\]]+\s*=\s*$/.test(before) && /^\s*[,)]/.test(after)) {
        kind = 'default-parameter'
      } else if (/\bscaleSheet\s*(?:<[^>]*>)?\(\s*$/.test(before)) kind = 'view-builder'
      uses.push({ file, read, kind })
    }
  }
  return uses
}

const files = listTs(SIM)
const uses = files.flatMap((f) =>
  classify(f.split(path.sep).join('/'), stripComments(fs.readFileSync(f, 'utf8'))),
)

describe('every sheet read under src/sim goes through the variant path, or says why not', () => {
  it('finds the sim and the reads it is sweeping (never pass on an empty walk)', () => {
    expect(files.length).toBeGreaterThan(20)
    // The two constructors ARE the variant path; if the sweep cannot see them,
    // it cannot see anything.
    const paths = uses.filter((u) => u.kind === 'default-parameter').map((u) => u.file)
    expect(paths).toContain('src/sim/hoverjet.ts')
    expect(paths).toContain('src/sim/jumpseat.ts')
    expect(paths).toContain('src/sim/energy.ts')
    expect(paths).toContain('src/sim/energy-race.ts')
    expect(
      uses
        .filter((u) => u.kind === 'view-builder')
        .map((u) => u.file)
        .sort(),
    ).toEqual(['src/sim/hoverjet.ts', 'src/sim/jumpseat.ts'])
  })

  it('has no direct read that is not a DIRECT_READS row', () => {
    const listed = new Set(DIRECT_READS.map((r) => `${r.file} ${r.read}`))
    const unlisted = uses
      .filter((u) => u.kind === 'direct' && !listed.has(`${u.file} ${u.read}`))
      .map((u) => `${u.file}: ${u.read}`)
    expect(
      unlisted,
      'A sim module reads the generated sheet directly. Take the vehicle sheet as a ' +
        'parameter defaulting to the sheet (the variant path), or add a DIRECT_READS row ' +
        'saying why no variant may move it:\n' +
        unlisted.join('\n'),
    ).toEqual([])
  })

  it('has no DIRECT_READS row that no longer matches a read (the table cannot rot)', () => {
    const found = new Set(uses.filter((u) => u.kind === 'direct').map((u) => `${u.file} ${u.read}`))
    const stale = DIRECT_READS.filter((r) => !found.has(`${r.file} ${r.read}`)).map(
      (r) => `${r.file}: ${r.read}`,
    )
    expect(stale, `rows for reads that are gone — delete them:\n${stale.join('\n')}`).toEqual([])
  })

  it('reads PROVENANCE nowhere in the sim but the two re-exports', () => {
    // `constants.ts` re-exports the provenance table and `index.ts` passes it
    // on. It carries values, so it is a door too; nothing may read through it.
    const reads = files.filter((f) => {
      const code = stripComments(fs.readFileSync(f, 'utf8')).replace(
        /export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g,
        '',
      )
      return /\bPROVENANCE\b/.test(code)
    })
    expect(reads).toEqual([])
  })

  it('imports the sheet only from the generated module or the constants door', () => {
    // Any other generated module a sim file reached into would be a door this
    // sweep does not look through.
    const others = files.filter((f) =>
      /from\s*['"]@\/generated\/(?!constants\.generated['"])/.test(
        stripComments(fs.readFileSync(f, 'utf8')),
      ),
    )
    expect(others).toEqual([])
  })
})

// ── DEV-384: the seat's gravity is a variant read too ─────────────────────
//
// `GRAVITY` reaches the sim through `constants.ts`, not the generated module,
// so the sweep above cannot see it. Until DEV-384 that did not matter: the
// world's gravity was every body's. Now a JumpSeat variant scales its OWN
// (`mechanics.gravityScale`, overclocked's *"falls faster"*), and a JumpSeat
// module that reads the world's `GRAVITY` where it means the seat's is a hidden
// standard of exactly the `SEED_SPEED` kind: the legs would float in an
// overclocked seat's free fall, and the autopilot would feed forward 32 m/s²
// against a seat that weighs 44.8.
//
// So the same rule, for `GRAVITY`: per occurrence in a sim file that imports it
// from the constants door, `typeof` is a type, `: T = GRAVITY` as a default
// parameter is the variant path (the caller passes the seat's), and anything
// else is a row below with its reason. A row that matches nothing fails.
//
// Proved red by restoring `jumpseat-autopilot.ts`'s `Math.abs(GRAVITY.y)` in
// the feed-forward: an unlisted direct read.

const GRAVITY_IMPORT_RE =
  /import\s+\{([^}]*)\}\s*from\s*['"](?:\.\/constants|@\/sim\/constants)['"]/g

const WORLD_GRAVITY_READS: readonly DirectRead[] = [
  {
    file: 'src/sim/hoverjet.ts',
    read: 'GRAVITY',
    why:
      'The HoverJet integrates the world: gravity is OFF once launched, and no HoverJet ' +
      'variant has a mechanic to scale it (`VARIANT_MECHANICS.hoverjet` is empty).',
  },
  {
    file: 'src/sim/glider.ts',
    read: 'GRAVITY',
    why:
      "The glider prototype (DEV-145): no variants file yet. Its variants are AIRCRAFT-VARIANTS §5's " +
      'G5, written as design targets, and would route this when they land.',
  },
  {
    file: 'src/sim/jumpseat.ts',
    read: 'GRAVITY',
    why:
      "`seatGravity`: a seat with no `gravityScale` gets the world's vector itself. The ONE place " +
      "the seat's gravity is built; everything else in the seat reads `seat.gravity`.",
  },
  {
    file: 'src/sim/jumpseat.ts',
    read: 'GRAVITY.x',
    why: "`seatGravity`, scaling the world by the variant's `gravityScale` (DEV-384).",
  },
  {
    file: 'src/sim/jumpseat.ts',
    read: 'GRAVITY.y',
    why: '`seatGravity`, as above.',
  },
  {
    file: 'src/sim/jumpseat.ts',
    read: 'GRAVITY.z',
    why: '`seatGravity`, as above.',
  },
  {
    file: 'src/sim/jumpseat-legs.ts',
    read: 'GRAVITY.y',
    why:
      "`legStaticSag`'s default `g`: a closed form the legs tests compare against, called by no " +
      "flight. `stepJumpSeatLegs` takes the seat's gravity as a parameter.",
  },
]

const gravityUses = (file: string, code: string): Use[] => {
  const uses: Use[] = []
  const imports = [...code.matchAll(GRAVITY_IMPORT_RE)]
  if (!imports.some((m) => /\bGRAVITY\b/.test(m[1] as string))) return uses
  const body = code.replace(GRAVITY_IMPORT_RE, '')
  for (const m of body.matchAll(/\bGRAVITY\b((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g)) {
    const at = m.index as number
    const before = body.slice(Math.max(0, at - 80), at)
    const after = body.slice(at + m[0].length, at + m[0].length + 4)
    const read = `GRAVITY${(m[1] as string).replace(/\s+/g, '')}`
    let kind: Use['kind'] = 'direct'
    if (/\btypeof\s+$/.test(before)) kind = 'type'
    else if (/:\s*[\w.<>[\]]+\s*=\s*$/.test(before) && /^\s*[,)]/.test(after)) {
      kind = 'default-parameter'
    }
    uses.push({ file, read, kind })
  }
  return uses
}

const gravity = files.flatMap((f) =>
  gravityUses(f.split(path.sep).join('/'), stripComments(fs.readFileSync(f, 'utf8'))),
)

describe("every read of the world's GRAVITY under src/sim is the world's on purpose (DEV-384)", () => {
  it('finds the reads it is sweeping, and the seat-gravity paths (never pass on an empty walk)', () => {
    const seen = new Set(gravity.map((u) => u.file))
    expect(seen).toContain('src/sim/hoverjet.ts')
    expect(seen).toContain('src/sim/jumpseat.ts')
    // The legs take the seat's gravity as a parameter defaulting to the world's.
    expect(gravity.filter((u) => u.kind === 'default-parameter').map((u) => u.file)).toContain(
      'src/sim/jumpseat-legs.ts',
    )
  })

  it('has no direct read that is not a WORLD_GRAVITY_READS row', () => {
    const listed = new Set(WORLD_GRAVITY_READS.map((r) => `${r.file} ${r.read}`))
    const unlisted = gravity
      .filter((u) => u.kind === 'direct' && !listed.has(`${u.file} ${u.read}`))
      .map((u) => `${u.file}: ${u.read}`)
    expect(
      unlisted,
      "A sim module reads the world's GRAVITY directly. If it is asking about a JumpSeat, " +
        'read `seat.gravity` (a variant may scale it); otherwise add a row saying why the ' +
        `world's is right:\n${unlisted.join('\n')}`,
    ).toEqual([])
  })

  it('has no WORLD_GRAVITY_READS row that no longer matches a read', () => {
    const found = new Set(
      gravity.filter((u) => u.kind === 'direct').map((u) => `${u.file} ${u.read}`),
    )
    const stale = WORLD_GRAVITY_READS.filter((r) => !found.has(`${r.file} ${r.read}`)).map(
      (r) => `${r.file}: ${r.read}`,
    )
    expect(stale, `rows for reads that are gone — delete them:\n${stale.join('\n')}`).toEqual([])
  })
})
