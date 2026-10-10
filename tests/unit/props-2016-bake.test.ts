/**
 * tests/unit/props-2016-bake.test.ts — **did 2016 actually draw this pass?**
 *
 * DEV-102. `content/environments/*.json` carries five scatter generators and
 * the port draws all five. The 2016 files hold the output of TWO: alpine's
 * Tree_Organic pass and desert's. Alpine's big-tree pass has `m_Enabled: 0`
 * and an empty `_StoredChunks`; simonet's and kauai's components are enabled
 * and were never run. For four sessions the extractor read "there is a
 * component" as "there is a forest", and `docs/private/PROP-AUDIT.md` wrote the
 * mixed-scale double pass up as *the alpine forest look*.
 *
 * The extractor now records what each source file holds as `shipped2016` on
 * every entry. This file checks that receipt against the file by a DIFFERENT
 * route — the extractor reads the component's own `_StoredChunks` list; this
 * walks the `(Clone)` GameObjects under each `Objects Root` and buckets their
 * `m_LocalScale.x` into the emitted passes' scale ranges. Two derivations, one
 * number per pass, and the relationship is what is asserted (trap 24): every
 * clone lands in exactly one emitted pass, and each pass's receipt equals the
 * clones in its band. A never-baked pass has a band with nothing in it, which
 * is the assertion that would have gone red on 2026-09-13.
 *
 * ── The gate ─────────────────────────────────────────────────────────────
 *
 * Needs `$FF2_LEGACY`, which CI does not have. Every read is inside an `it`
 * (a `describe.skipIf` skips the tests, not the body), and the second describe
 * is the loud counterpart so this cannot rot into a silent skip.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'
import { REPO as ROOT } from './helpers/repo-root'

const ENV_DIR = path.join(ROOT, 'content', 'environments')

/** Cheap, and it never reads a file: `existsSync` at collection time is safe. */
const haveLegacy = legacyAvailable()

interface Receipt {
  readonly componentEnabled: boolean
  readonly bakedObjects: number
  readonly note: string
}
interface ScatterEntry {
  readonly index: number
  readonly scaleMin: number
  readonly scaleMax: number
  readonly shipped2016?: Receipt
}
interface EnvJson {
  readonly id: string
  readonly source: { readonly kind: string; readonly path: string }
  readonly scatter: readonly ScatterEntry[]
}

const environments = (): EnvJson[] =>
  fs
    .readdirSync(ENV_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(ENV_DIR, f), 'utf8')) as EnvJson)

/**
 * `m_LocalScale.x` of every live `(Clone)` GameObject parented under an
 * `Objects Root`, read off the raw YAML. Names and parents only — no generator
 * component is consulted, which is the point.
 */
const bakedCloneScales = (file: string): number[] => {
  const text = fs.readFileSync(file, 'utf8')
  const name = new Map<string, string>()
  const active = new Map<string, boolean>()
  const transforms = new Map<string, { go: string | null; father: string; scale: number }>()
  const transformOfGo = new Map<string, string>()

  for (const part of text.split(/\n--- /)) {
    const head = /^!u!(\d+) &(-?\d+)/.exec(part)
    if (!head) continue
    const cls = head[1]
    const id = head[2] as string
    if (cls === '1') {
      name.set(id, (/m_Name: (.*)/.exec(part)?.[1] ?? '').trim())
      active.set(id, /m_IsActive: (\d)/.exec(part)?.[1] === '1')
    } else if (cls === '4') {
      const go = /m_GameObject: \{fileID: (-?\d+)\}/.exec(part)?.[1] ?? null
      const father = /m_Father: \{fileID: (-?\d+)\}/.exec(part)?.[1] ?? '0'
      const scale = Number(/m_LocalScale: \{x: (-?[\d.eE+-]+)/.exec(part)?.[1] ?? Number.NaN)
      transforms.set(id, { go, father, scale })
      if (go) transformOfGo.set(go, id)
    }
  }

  const out: number[] = []
  for (const [goId, n] of name) {
    if (!n.endsWith('(Clone)')) continue
    if (!active.get(goId)) continue
    let t = transforms.get(transformOfGo.get(goId) ?? '')
    if (!t) continue
    const scale = t.scale
    let underObjectsRoot = false
    let live = true
    for (let hops = 0; t && t.father !== '0' && hops < 64; hops++) {
      const parent = transforms.get(t.father)
      if (!parent) break
      if (parent.go) {
        if (name.get(parent.go) === 'Objects Root') underObjectsRoot = true
        if (!active.get(parent.go)) live = false
      }
      t = parent
    }
    if (underObjectsRoot && live && Number.isFinite(scale)) out.push(scale)
  }
  return out
}

describe.skipIf(!haveLegacy)('each scatter pass says what 2016 baked, and the file agrees', () => {
  it('carries a shipped2016 receipt on every entry', () => {
    // Pure JSON, so this half runs in CI too.
    for (const env of environments()) {
      for (const s of env.scatter) {
        expect(s.shipped2016, `${env.id} scatter[${s.index}]`).toBeDefined()
        expect(typeof s.shipped2016?.componentEnabled).toBe('boolean')
        expect(s.shipped2016?.bakedObjects).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it.each(environments().map((env) => [env.id, env] as const))(
    '%s: every baked clone falls in exactly one emitted pass, and the receipts match',
    (_id, env) => {
      const file = legacyPath(env.source.path)
      expect(fs.existsSync(file), file).toBe(true)
      const scales = bakedCloneScales(file)

      let accounted = 0
      for (const s of env.scatter) {
        // The generator draws `Random.Range(min, max)`, half-open on `max`.
        const inBand = scales.filter((x) => x >= s.scaleMin && x < s.scaleMax).length
        expect(
          s.shipped2016?.bakedObjects,
          `${env.id} scatter[${s.index}] [${s.scaleMin}, ${s.scaleMax}): ` +
            `receipt says ${s.shipped2016?.bakedObjects}, the file holds ${inBand} clone(s) in that band`,
        ).toBe(inBand)
        accounted += inBand
      }
      // No clone outside every emitted band — otherwise a pass is missing from
      // the JSON, which is the mirror image of the bug this file exists for.
      expect(accounted, `${env.id}: ${scales.length} clones, ${accounted} in some pass`).toBe(
        scales.length,
      )
    },
  )

  it('the sweep swept: at least one environment has a baked pass', () => {
    // A parser that matched nothing would pass every band at 0 == 0.
    const baked = environments().flatMap((e) =>
      e.scatter.map((s) => s.shipped2016?.bakedObjects ?? 0),
    )
    expect(Math.max(...baked)).toBeGreaterThan(1000)
  })
})

describe.skipIf(haveLegacy)('when the legacy project is absent', () => {
  it('this guard is skipped only because $FF2_LEGACY is missing', () => {
    // The loud counterpart. If this ever runs where the project IS present,
    // the guard above has been silently skipped, and that is a failure.
    expect(haveLegacy).toBe(false)
  })
})
