// tests/unit/e2e-photo-pin-debt.test.ts — every e2e spec that both loads the
// page and takes a screenshot, and whether it pins the quality tier.
//
// ── Why this is a TEST and not a sweep of edits ──────────────────────────
//
// DEV-245. `render/quality.ts` drops a tier when the CPU is starved and a tier
// drop moves MSAA, the framebuffer scale, the shadow map and the prop LOD —
// all of which are visible in a screenshot (perf-protocol §3f). **On
// 2026-09-20 not one spec in this suite pinned the tier**, and the count of
// specs that photograph the page is derived below rather than written here,
// because a count copied into prose is the one thing this project is certain
// goes stale.
//
// The specs a LOOK DECISION is made from were pinned by hand and run: the
// three the coordinator's sweep named (`baked-rung-photos`,
// `hud-upload-pixels`, `draw-order-pixels`), `scoring-feedback-photos`, which
// the sweep missed and where the pin matters most of anywhere — DEV-153's
// question is at what range a thin reticle mark stops reading, and MSAA is
// exactly that — and DEV-245's own seat spec.
//
// The rest were NOT pinned, deliberately. A pin changes what is rendered,
// several of those specs assert on pixels, and CLAUDE.md's rule is that a
// command nobody ran did not succeed. Editing every one of them without
// running any and calling the class closed is the shape of failure this repo
// has paid for before.
//
// So the class is closed the way `xr-eye-layers.test.ts` closes its class:
// **the debt is written down as a set, and the set is asserted.** A new photo
// spec without the pin goes red here, with the message telling its author what
// to add. Pinning one of the debtors goes red too, telling them to strike a
// line — which is a deliberate edit rather than a silent drift, and that is
// the whole point.
//
// **This file is a LEDGER, not a bar.** It does not say the listed specs are
// fine. It says exactly which frames in this project were taken on a tier
// nobody held, so the next reader of any of them knows.
//
// ── A gitignored scratch spec is not a COMMITTED spec ────────────────────
//
// The invariant is *no **committed** photo spec is unpinned*, and the ledger is
// how that invariant is stated — a list of file names, in git, that a future
// session edits. `.gitignore` makes `_`- and `zz-`-prefixed specs uncommittable
// on purpose, and its own block says why: a probe reads the session scratchpad
// by absolute path and dies with the session, so committing one leaves a
// permanently broken test that also names a home directory.
//
// A scratch spec is therefore outside the set this ledger can be about, and
// sweeping it in asked for something that cannot be done: the message says
// *strike its line from `UNPINNED_ON_2026_09_20`*, and a line naming a file git
// refuses to take cannot be committed either way — leave it out and the guard
// is red, put it in and the ledger names a file nobody else will ever have.
// Observed 2026-09-21 with a throwaway `tests/e2e/_noprop-shots.spec.ts`, which
// turned `pnpm check` red for a file that had no business in the ledger.
//
// The exemption is the CLASS `.gitignore` names rather than the spelling that
// was just seen: **both prefixes**, and `.gitignore` covers both extensions
// while the sweep below is already narrowed to `.spec.ts`. That gitignore block
// records what the other choice costs — four spellings turned up in two days
// and the rule was widened to each one in turn, missing the next one three
// times.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const E2E = path.join(process.cwd(), 'tests', 'e2e')

interface Spec {
  readonly file: string
  readonly source: string
}

/**
 * A spec name git will not take: throwaway scratch, ignored by `.gitignore`.
 *
 * Both prefixes, because the gitignore block that owns this class was widened
 * to the one just seen three times and missed the next one each time. The
 * loud counterpart below reads `.gitignore` and pins all four of its patterns,
 * so if that class is ever narrowed, this exemption stops being an exemption
 * and becomes a hole — and somebody finds out here.
 */
const SCRATCH = /^(?:_|zz-)/

/**
 * Fixtures that load the page THEMSELVES and carry the tier pin themselves.
 *
 * A spec that enters through one never spells the page load or the pin in its
 * own text, so reading only its own text would drop it from this ledger the
 * day it moved its preamble into the fixture. It is a page-loading spec, and
 * it is pinned, because the fixture is. An explicit list rather than "every
 * fixture that loads a page", so a fixture that loads a page WITHOUT the pin
 * can never quietly vouch for the specs that use it; the loud counterpart
 * below reads each named fixture and says it still does both jobs.
 */
const PINNING_LOADERS: readonly string[] = ['editor-boot']

const importsPinningLoader = (source: string): boolean =>
  PINNING_LOADERS.some((name) => source.includes(`fixtures/${name}'`))

/**
 * Fixtures that take the picture THEMSELVES (TS-6): a spec that imports one
 * never spells the capture call in its own text, so reading only its own text
 * would drop it from this ledger the day it moved its helper into the fixture.
 * Unlike a loader this vouches for nothing about the pin: the spec still loads
 * the page itself, and the pin is still read off the spec. The loud counterpart
 * below reads each named fixture and says it still takes the picture.
 */
const PHOTOGRAPHERS: readonly string[] = ['photo']

const importsPhotographer = (source: string): boolean =>
  PHOTOGRAPHERS.some((name) => source.includes(`fixtures/${name}'`))

/**
 * A spec that loads the page AND photographs it.
 *
 * A spec that only reads the accessibility tree or a census is not a photo
 * spec, and a helper under `fixtures/` is not a spec.
 */
const isPhotoSpec = (source: string): boolean =>
  (source.includes('.screenshot(') || importsPhotographer(source)) &&
  (source.includes('.goto(') || importsPinningLoader(source))

const isPinned = (source: string): boolean =>
  source.includes('PINNED') || importsPinningLoader(source)

/**
 * The committed photo specs — derived, never listed.
 *
 * A function of a LIST rather than of the directory, so the classification can
 * be driven by fixtures that are right and wrong on purpose. `deviations-
 * ledger.test.ts` is the pattern: a guard's only real claim is that it goes
 * red, and a green run against a healthy tree is exactly the thing that cannot
 * show you that.
 */
const photoSpecsIn = (specs: readonly Spec[]): string[] =>
  specs
    .filter((s) => !SCRATCH.test(s.file) && isPhotoSpec(s.source))
    .map((s) => s.file)
    .sort()

/**
 * The debt: committed photo specs without the pin.
 *
 * Defined THROUGH `photoSpecsIn`, so the scratch exemption cannot apply to the
 * sanity check and not to the ledger — one filter, one class, one place to be
 * wrong.
 */
const unpinnedIn = (specs: readonly Spec[]): string[] =>
  photoSpecsIn(specs.filter((s) => !isPinned(s.source)))

let onDisk: Spec[] | null = null

/** `tests/e2e`, read once and lazily — no disk work at collection time. */
const e2eSpecs = (): readonly Spec[] =>
  (onDisk ??= fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(E2E, f), 'utf8') })))

const sourceOf = (file: string): string => {
  const spec = e2eSpecs().find((s) => s.file === file)
  if (!spec) throw new Error(`${file} is not a spec under tests/e2e`)
  return spec.source
}

/**
 * The specs whose frames are taken on an UNPINNED tier, as of DEV-245.
 *
 * Every line here is a set of pictures in `perf-out/` or `test-results/` that
 * could have been shot across a tier change and does not know it. Strike a
 * line when you pin that spec **and run it** — not when you mean to.
 *
 * Sorted, so a diff to this list is one line rather than a reshuffle.
 */
const UNPINNED_ON_2026_09_20: readonly string[] = [
  'ambient-traffic.spec.ts',
  'anniversary-ab.spec.ts',
  'boundary-fuzz.spec.ts',
  'controls-page.spec.ts',
  'gates-photos.spec.ts',
  'holotable-medal.spec.ts',
  'lod-pop.spec.ts',
  'lookdev.spec.ts',
  'route-sweep.spec.ts',
  'snap.spec.ts',
  'spawn-clearing.spec.ts',
  'spec-sweep.spec.ts',
  'terrain-look-frames.spec.ts',
  'terrain-screenshot.spec.ts',
  'third-person.spec.ts',
  'title-frames.spec.ts',
  'viewpoints.spec.ts',
  'water-underside.spec.ts',
]

describe('the quality pin across the photo specs (DEV-245)', () => {
  it('finds the photo specs by what they DO, so a rename cannot hide one', () => {
    // The derivation itself, asserted: if this ever comes back empty the two
    // tests below pass vacuously and the ledger is silently switched off. Same
    // shape as `png-diff.mjs`'s mask share — a derived set needs a sanity
    // check that it found the right thing.
    const specs = photoSpecsIn(e2eSpecs())
    expect(specs.length).toBeGreaterThan(20)
    expect(specs).toContain('baked-rung-seat-photos.spec.ts')
  })

  it('the specs a look decision is made from carry the pin', () => {
    // Named, because these are the ones that were pinned AND run. The others
    // are the ledger below.
    for (const f of [
      'baked-rung-photos.spec.ts',
      'baked-rung-seat-photos.spec.ts',
      'draw-order-pixels.spec.ts',
      'hud-upload-pixels.spec.ts',
      'scoring-feedback-photos.spec.ts',
    ]) {
      expect(
        photoSpecsIn(e2eSpecs()),
        `${f} is no longer a photo spec — has it been renamed?`,
      ).toContain(f)
      expect(isPinned(sourceOf(f)), `${f} has lost its quality pin`).toBe(true)
    }
  })

  it('no COMMITTED photo spec is unpinned except the ones the ledger names', () => {
    expect(
      unpinnedIn(e2eSpecs()),
      'A photo spec loads the page, takes a screenshot, and does not carry ' +
        '`PINNED` from `tests/e2e/fixtures/quality-pin.ts`.\n\n' +
        'If this spec is NEW: add `&${PINNED}` to its `page.goto` — a starved ' +
        'frame drops a quality tier, and a tier drop moves MSAA, the ' +
        'framebuffer scale, the shadow map and the prop LOD, all of which are ' +
        'in the picture (perf-protocol §3f).\n\n' +
        'If you have just PINNED one of the listed specs: run it, then strike ' +
        'its line from `UNPINNED_ON_2026_09_20` above. The list is a ledger of ' +
        'frames taken on a tier nobody held, and shortening it is the point.',
    ).toEqual([...UNPINNED_ON_2026_09_20])
  })

  it('still has a gitignore that makes a scratch spec uncommittable', () => {
    // The loud counterpart for `SCRATCH`. The exemption above is sound only
    // while those names really cannot be committed; if that block is ever
    // narrowed, an unpinned photo spec COULD land in git unwatched, and this
    // is where that is noticed rather than in a screenshot six months later.
    const ignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')
    for (const pattern of [
      'tests/**/_*.test.ts',
      'tests/**/_*.spec.ts',
      'tests/**/zz-*.test.ts',
      'tests/**/zz-*.spec.ts',
    ]) {
      expect(
        ignore,
        `${pattern} is what makes such a file scratch rather than a spec this ledger owns`,
      ).toContain(pattern)
    }
  })
})

/**
 * The guard fires on the committed case and not on the scratch one.
 *
 * Fixtures rather than files on disk, for `deviations-ledger.test.ts`'s reason:
 * nothing reads disk at collection, so there is nothing to throw in an
 * environment that lacks something. The two sources below are byte-identical —
 * **the only variable is the file NAME** — which is the claim the exemption
 * actually makes.
 *
 * Each must-NOT-fire case catches one narrowing of `SCRATCH`, so neither is
 * redundant with the other:
 *
 *   `/^(?:_|zz-)/` -> `/^zz-/`   caught by → the `_` case (the one observed)
 *   `/^(?:_|zz-)/` -> `/^_/`     caught by → the `zz-` case (the next one)
 */
describe('the scratch exemption (2026-09-21)', () => {
  const PHOTO = ["await page.goto('/?mission=int_01_hoverJet')", 'await page.screenshot({})'].join(
    '\n',
  )
  const PHOTO_PINNED = ["import { PINNED } from './fixtures/quality-pin'", PHOTO].join('\n')

  it('is quiet on a healthy set, or the cases below prove nothing', () => {
    expect(
      unpinnedIn([
        { file: 'shots.spec.ts', source: PHOTO_PINNED },
        { file: 'census.spec.ts', source: "await page.goto('/')" },
      ]),
    ).toEqual([])
  })

  it('STILL CATCHES a committed photo spec with no pin', () => {
    expect(unpinnedIn([{ file: 'noprop-shots.spec.ts', source: PHOTO }])).toEqual([
      'noprop-shots.spec.ts',
    ])
  })

  it('IGNORES the same spec under a `_` name — the file that turned check red', () => {
    // `tests/e2e/_noprop-shots.spec.ts`, 2026-09-21: same bytes as the case
    // above, and `git check-ignore` resolves it to `.gitignore`'s
    // `tests/**/_*.spec.ts`.
    expect(unpinnedIn([{ file: '_noprop-shots.spec.ts', source: PHOTO }])).toEqual([])
  })

  it('IGNORES a `zz-` name too, which is the same class and the next spelling', () => {
    expect(unpinnedIn([{ file: 'zz-noprop-shots.spec.ts', source: PHOTO }])).toEqual([])
  })

  it('keeps a scratch spec out of the derived set as well as out of the debt', () => {
    // Not just the ledger comparison: a scratch spec must not be able to
    // satisfy the sanity check either, or a throwaway file could hold the
    // count above 20 while the real specs quietly went away.
    expect(photoSpecsIn([{ file: '_shots.spec.ts', source: PHOTO_PINNED }])).toEqual([])
  })
})

/**
 * A spec that enters through a loader fixture is still a photo spec, and is
 * pinned by the fixture (the editor specs moved their preamble into one).
 *
 * The three cases are the three ways this could be wrong, and each is a
 * different direction: the spec drops out of the ledger (photo spec not
 * found), an unpinned loader vouches for its users (pinned by mere import), or
 * a loader that rotted loses its pin or its page load without anyone noticing.
 */
describe('a loader fixture that carries the pin', () => {
  // The screenshot call stays in the spec; the page load moved to the fixture.
  const VIA_LOADER = [
    "import { openEditor } from './fixtures/editor-boot'",
    'await page.screenshot({})',
  ].join('\n')

  it('keeps its users in the photo-spec set, so a spec cannot slip out of the ledger', () => {
    expect(photoSpecsIn([{ file: 'editor-shots.spec.ts', source: VIA_LOADER }])).toEqual([
      'editor-shots.spec.ts',
    ])
  })

  it('counts them pinned, and does not do the same for an unrelated fixture', () => {
    expect(unpinnedIn([{ file: 'editor-shots.spec.ts', source: VIA_LOADER }])).toEqual([])
    // A fixture that is not on the list neither loads the page for the spec nor
    // pins it: this one has no page load of its own, so it is not a photo spec
    // at all, and with one it would be a photo spec with no pin.
    const other = VIA_LOADER.replace('editor-boot', 'landing')
    expect(photoSpecsIn([{ file: 'x.spec.ts', source: other }])).toEqual([])
    expect(unpinnedIn([{ file: 'x.spec.ts', source: `${other}\nawait page.goto('/')` }])).toEqual([
      'x.spec.ts',
    ])
  })

  it('names only fixtures that still load the page and still carry the pin', () => {
    for (const name of PINNING_LOADERS) {
      const text = fs.readFileSync(path.join(E2E, 'fixtures', `${name}.ts`), 'utf8')
      expect(text.includes('.goto('), `${name} no longer loads the page`).toBe(true)
      expect(text.includes('PINNED'), `${name} no longer carries the pin`).toBe(true)
    }
  })
})

/**
 * A spec that takes its pictures through a photographer fixture is still a
 * photo spec (TS-6). Three ways to be wrong, one case each: the spec drops out
 * of the ledger (not found), an import of an unrelated fixture makes a spec a
 * photo spec by mistake, or the fixture rots and stops taking pictures while
 * the specs keep vouching for it.
 */
describe('a photographer fixture that takes the picture', () => {
  // The capture call moved to the fixture; the page load stayed in the spec.
  const VIA_PHOTOGRAPHER = [
    "import { photographer } from './fixtures/photo'",
    "await page.goto('/?mission=int_01_hoverJet')",
  ].join('\n')

  it('keeps its users in the photo-spec set, so a spec cannot slip out of the ledger', () => {
    expect(photoSpecsIn([{ file: 'shots.spec.ts', source: VIA_PHOTOGRAPHER }])).toEqual([
      'shots.spec.ts',
    ])
  })

  it('does not vouch for the pin: the spec must still carry it', () => {
    expect(unpinnedIn([{ file: 'shots.spec.ts', source: VIA_PHOTOGRAPHER }])).toEqual([
      'shots.spec.ts',
    ])
    const pinned = `import { PINNED } from './fixtures/quality-pin'\n${VIA_PHOTOGRAPHER}`
    expect(unpinnedIn([{ file: 'shots.spec.ts', source: pinned }])).toEqual([])
  })

  it('does not make a photo spec out of an unrelated fixture, or an import with no page', () => {
    const other = VIA_PHOTOGRAPHER.replace('fixtures/photo', 'fixtures/landing')
    expect(photoSpecsIn([{ file: 'x.spec.ts', source: other }])).toEqual([])
    const noPage = "import { photographer } from './fixtures/photo'"
    expect(photoSpecsIn([{ file: 'x.spec.ts', source: noPage }])).toEqual([])
  })

  it('names only fixtures that still take the picture', () => {
    for (const name of PHOTOGRAPHERS) {
      const text = fs.readFileSync(path.join(E2E, 'fixtures', `${name}.ts`), 'utf8')
      expect(text.includes('.screenshot('), `${name} no longer takes the picture`).toBe(true)
    }
  })
})
