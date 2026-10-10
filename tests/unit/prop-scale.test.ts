/**
 * tests/unit/prop-scale.test.ts — **how big is a tree, actually?**
 *
 * DEV-099. Alpine's scattered trees rendered between 3.4 and 11.2 km tall and
 * desert's bushes up to 3.1 km, and every test in this repo stayed green,
 * because nothing anywhere asked a prop how big it was. The symptom reached
 * Matt as *"our mesa canyon and alpine forest maps don't seem to load"*: at
 * 500 m altitude the camera was inside a tree, and even the cockpit — geometry
 * one metre from the eye — was hidden behind it.
 *
 * Two independent causes, both of which this file would have caught:
 *
 *  1. **The unit scale.** `Tree Pack` and `AxeyWorks Low Poly` are authored in
 *     CENTIMETRES, and `convert-fbx.py` discards Blender's centimetre
 *     compensation — correct for the ship meshes, whose FBX vertices really are
 *     metres, and a factor of 100 everywhere else.
 *  2. **The container.** `trees_03.fbx` holds twenty trees at three LODs. All
 *     ten `Tree*.prefab` resolved to the whole file, and `load-props.ts`
 *     instances every mesh it finds — so each scatter point drew all sixty, at
 *     the spacing the artist laid them out in.
 *
 * ── Why a SIZE and not a mesh count ──────────────────────────────────────
 *
 * A mesh count would have caught cause 2 and been blind to cause 1, which was
 * the larger factor and hit an environment that has no container in it at all.
 * The size is the thing that was actually wrong, it is one number per entry,
 * and it is true independently of how the asset came to be that size — the
 * orientation lesson's rule, applied to a length.
 *
 * ── The ceiling ──────────────────────────────────────────────────────────
 *
 * 150 m. The largest prop in the game after the fix is alpine's `Tree10` at
 * 3.888 m x `scaleMax` 20 = 77.8 m, so this is roughly double the real maximum
 * — loose enough that art direction can move without tripping it, and tight
 * enough that both bugs miss it by more than an order of magnitude (the bushes
 * were 1,077 m and 3,078 m; the trees 11,174 m). It is a SMOKE CEILING, not a
 * specification: the per-tree exactness is checked elsewhere, against Unity's
 * own `LODGroup.m_Size`, at conversion time.
 *
 * ── Why the gate is shaped like this ─────────────────────────────────────
 *
 * The GLBs are gitignored, so CI has none of them. CLAUDE.md's trap: a
 * `describe.skipIf` skips the TESTS, not the describe BODY, so any disk work
 * outside an `it` runs during COLLECTION and throws `ENOENT` exactly where the
 * assets are absent — which is CI, and only CI. Every read below is inside an
 * `it`. The second describe is the loud counterpart: without it this file can
 * quietly stop running for months and still look green.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAINTAINER_CHECKOUT } from './helpers/checkout'
import { REPO as ROOT } from './helpers/repo-root'

const ENV_DIR = path.join(ROOT, 'content', 'environments')
const PUBLIC = path.join(ROOT, 'public')

/** Cheap, and it never reads: `existsSync` at collection time is safe. */
const haveProps = fs.existsSync(path.join(PUBLIC, 'assets', 'props'))

/** The loosest bound that both shapes of DEV-099 miss by an order of magnitude. */
const CEILING_M = 150

interface Palette {
  prefab: string
  meshAsset?: string | null
  meshNode?: string | null
  meshTransform?: { scale: number[] } | null
}
interface Scatter {
  index: number
  scaleMin: number
  scaleMax: number
  palette: Palette[]
}

const environments = (): { id: string; scatter: Scatter[] }[] =>
  fs
    .readdirSync(ENV_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(ENV_DIR, f), 'utf8')))

/**
 * The longest edge of a glTF's geometry, in the units its vertices carry.
 *
 * Read off the ACCESSOR bounds, which glTF requires on POSITION, so this needs
 * no glTF loader and no GPU. It deliberately ignores node transforms: every
 * prop is a single mesh baked at the root, and `load-props.ts` only ever
 * applies a mesh's own local matrix — so a scale hiding on a parent node would
 * be dropped at load time and must not be counted here either.
 */
const longestEdge = (file: string): { metres: number; meshes: number } => {
  const buf = fs.readFileSync(file)
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
    meshes?: { primitives: { attributes: { POSITION: number } }[] }[]
    accessors: { min?: number[]; max?: number[] }[]
  }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const a = json.accessors[prim.attributes.POSITION]
      if (!a?.min || !a.max) continue
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i] as number, a.min[i] as number)
        hi[i] = Math.max(hi[i] as number, a.max[i] as number)
      }
    }
  }
  return {
    metres: Math.max(...[0, 1, 2].map((i) => (hi[i] as number) - (lo[i] as number))),
    meshes: (json.meshes ?? []).length,
  }
}

describe('every scattered prop is a plausible size', () => {
  it('names a mesh asset for every palette entry', () => {
    // Pure JSON, so this one runs in CI too — and an entry with no mesh is a
    // prop that silently does not draw, which is the quiet half of DEV-099.
    for (const env of environments()) {
      for (const s of env.scatter) {
        for (const p of s.palette) {
          expect(p.meshAsset, `${env.id} scatter[${s.index}] ${p.prefab}`).toBeTruthy()
        }
      }
    }
  })

  describe.skipIf(!haveProps)('against the published geometry', () => {
    it('is under the ceiling at its own scaleMax, in every environment', () => {
      const oversized: string[] = []
      const tallest: { what: string; metres: number } = { what: '-', metres: 0 }
      for (const env of environments()) {
        for (const s of env.scatter) {
          for (const p of s.palette) {
            const file = path.join(PUBLIC, p.meshAsset as string)
            // Inside the `it`, deliberately. See the header.
            if (!fs.existsSync(file)) {
              // The public clone's content pack carries only the first-party props; the
              // bought ones are absent there by design. In the maintainer tree it is a fault.
              if (MAINTAINER_CHECKOUT) oversized.push(`${env.id}: ${p.meshAsset} is not on disk`)
              continue
            }
            const { metres, meshes } = longestEdge(file)
            const world = metres * (p.meshTransform?.scale?.[0] ?? 1) * s.scaleMax
            if (world > tallest.metres) {
              tallest.metres = world
              tallest.what = `${env.id} ${path.basename(p.prefab)}`
            }
            if (world > CEILING_M) {
              oversized.push(
                `${env.id} scatter[${s.index}] ${path.basename(p.prefab)} -> ` +
                  `${p.meshAsset} is ${world.toFixed(0)} m at scaleMax ${s.scaleMax} ` +
                  `(${meshes} mesh${meshes === 1 ? '' : 'es'} in the file)`,
              )
            }
          }
        }
      }
      expect(oversized, `tallest was ${tallest.what} at ${tallest.metres.toFixed(1)} m`).toEqual([])
      // And the sweep really swept: a bug that made every asset resolve to
      // nothing would otherwise pass with an empty list. The public clone's pack
      // holds no scatter prop (they are all bought), so there it has nothing to sweep.
      if (MAINTAINER_CHECKOUT) expect(tallest.metres).toBeGreaterThan(1)
    })

    it('resolves a CONTAINER file down to one prefab, one mesh', () => {
      // The second half of DEV-099, stated directly. `trees_03.fbx` is twenty
      // trees at three LODs and ten prefabs pointed at all sixty; the extractor
      // now carries Unity's own sub-mesh name (`meshNode`) so each prefab gets
      // its own asset. `load-props.ts` instances EVERY mesh it finds, so a
      // multi-mesh prop draws all of them at every scatter point.
      const multi: string[] = []
      for (const env of environments()) {
        for (const s of env.scatter) {
          for (const p of s.palette) {
            const file = path.join(PUBLIC, p.meshAsset as string)
            if (!fs.existsSync(file)) continue
            const { meshes } = longestEdge(file)
            if (meshes > 1)
              multi.push(`${env.id} ${path.basename(p.prefab)} -> ${p.meshAsset} has ${meshes}`)
          }
        }
      }
      expect(multi).toEqual([])
    })
  })

  describe.skipIf(haveProps)('the loud counterpart', () => {
    it('says out loud that the geometry checks did NOT run', () => {
      // If this ever runs somewhere the props ARE hydrated, the guard above is
      // being skipped for the wrong reason and both halves would be green.
      expect(haveProps, 'public/assets/props is absent, so the size sweep was skipped').toBe(false)
    })
  })
})
