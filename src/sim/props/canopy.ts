// src/sim/props/canopy.ts — how much sky the forest takes away, per ground texel.
//
// ── What this is for ──────────────────────────────────────────────────────
//
// Matt, wishlist #13: *"i was hoping for something like it colors the verts
// under the terrain once, at 'bake time' and never again. so not 'real'
// shadows, more like baking implied shadows. simplified example: on alpine, the
// grass under thick forests is the same color as an open field. my goal is to
// make it darker under the thick forest."*
//
// ── It is a RESTORATION, and that is the strongest thing about it ─────────
//
// The report is exact, and the reason the ground under a forest is the same
// colour as an open field is written down: **DEV-224 took the scatter out of
// the shadow map**, and `content/editions/anniversary.json` says so in as many
// words — *"a tree, a cactus or a bush casts nothing on the ground it stands
// on."* It was worth it (the scatter is 88-93 % of desert's and alpine's
// world pass) and it is `false` on BOTH presets.
//
// Two things follow, and they decide the whole design:
//
//  1. **Nothing else darkens that ground, so there is no double-darkening to
//     fear.** A baked term is not competing with a real shadow; it is standing
//     where one used to be. That is why this may multiply the DIRECT sun as
//     well as the ambient — under a canopy both are occluded — where a feature
//     landing beside a live shadow map could only have touched the ambient.
//  2. **The thing to restore is not a shadow, it is the DIFFERENCE between a
//     forest floor and a field.** So the term is a function of LOCAL DENSITY
//     rather than of the nearest tree: one palm on an open beach should barely
//     register, and Matt's *"thick forest"* should be unmistakable. A distance
//     to the nearest prop cannot tell those apart — a lone tree and a tree in a
//     thicket are both zero metres from a tree.
//
// ── The model: Beer-Lambert over a splatted CONTACT PATCH ────────────────
//
// Each prop lays down a compact kernel on the ground grid, `1 - (d/r)^2` out to
// its own canopy radius, peaking at a FULL unit under its trunk. Those sum into
// a DENSITY that has no upper bound — twenty overlapping trees really are
// twenty times one tree — and the density becomes occlusion through
//
//     occlusion = 1 - exp( -density / saturation )
//
// which is the transmittance of a uniform medium, and is the right shape for
// the wrong-looking alternatives' reasons rather than for its own: it is
// monotonic, it approaches 1 without ever clamping (so a dense stand has no
// flat spot where more trees stop counting), and it has ONE parameter with a
// meaning — `saturation` is the coverage at which 63 % of the sky is gone.
// `min(1, density / k)` was the first draft and it produces a visible plateau
// edge across a forest, which is a contour line nobody authored.
//
// **The peak is the quantity, and area-preservation was a wrong turn** —
// DEV-297, and the most useful thing in this file's history.
//
// The first kernel peaked at 1 whatever `r` was, so a 1 m shrub that landed on
// a grid point wrote exactly what a 40 m oak wrote. The fix was to normalise
// it to lay down `pi * r^2` of coverage however it was sampled, which made
// DENSITY a meaningful quantity — and made a LONE prop's patch impossible.
// Spreading a fixed integral over a wider disc LOWERS its peak, so turning the
// radius up made every tree's shade broader and fainter, and Matt circled two
// isolated trees on an open slope and said the ground under them should be
// darker. It could not be, by construction.
//
// So the cap does the job the normalisation was brought in for, and does it
// without destroying the peak: `min(1, pi * r^2)` is the canopy's area when it
// is smaller than a texel and 1 when it is larger, which is exactly *a texel
// cannot be more than covered by one canopy*. The shrub contributes 0.03 and
// the tree 1, and the tree under nothing at all still darkens the ground it
// stands on.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// Not ray-traced AO, not a shadow, and not a function of the sun. It does not
// know where the sun is and must not: a baked sun term already exists one file
// over (`sim/terrain/sun-height.ts`, DEV-116) and is exact, and a second
// sun-dependent term would be two things claiming the same pixel. This one is
// the canopy's own contact darkening and is the same at noon and at 4 degrees,
// which is also what makes it correct to bake.
//
// SIM LAYER: no three, no DOM, no wall clock, no `Math.random`.

/** What a prop needs to look like to cast a canopy. A `PropPlacementInput` is one. */
export interface CanopyProp {
  /** Mesh-space metres, the same frame and origin as the height field's grid. */
  readonly x: number
  readonly y: number
  readonly z: number
  /** The instance's uniform scale. */
  readonly scale: number
  /** The drawn bounds at scale 1: `width` sets the canopy, `height` its top. */
  readonly dims: { readonly width: number; readonly height: number }
}

/** The grid to sweep onto: the LAND's collision field, or anything shaped like it. */
export interface CanopyGrid {
  /** Samples per side. */
  readonly vertPerSide: number
  /** Metres per grid step, mesh space. */
  readonly step: number
  /**
   * The grid's world y, added to a placement's own to get the CEILING.
   *
   * The placements arrive in the terrain's mesh frame and the shader compares
   * against a world height, so the one offset between them lives here — the
   * same `originY` `buildPropColliders` adds for exactly the same reason.
   */
  readonly originY?: number
}

/** The tuning, as a preset carries it. `render.canopyShade`. */
export interface CanopySpec {
  /**
   * Canopy radius as a multiple of the prop's drawn HALF-width.
   *
   * 1 is "the canopy darkens exactly the ground it covers". Above 1 spreads the
   * term past the silhouette, which is what contact darkening under a real
   * canopy looks like — the light that reaches the edge has come a long way
   * sideways.
   */
  readonly radiusScale: number
  /**
   * The coverage at which 63 % of the sky is gone. Lower is a darker forest.
   *
   * Since DEV-297 the units are simple: **one canopy overhead is 1**. So this
   * is read directly — at 1, a lone tree takes `1 - 1/e` = 63 % of `strength`
   * from the ground under it, and three overlapping take 95 %. Lower makes a
   * single tree darker; higher needs a thicket before anything shows.
   *
   * Two behaviours worth carrying, because both are counter-intuitive and both
   * are CORRECT:
   *
   *  * **A 40 m oak and a 12 m tree put the same coverage on the texel under
   *    them.** A texel cannot be more than covered by one canopy; the oak
   *    covers more TEXELS, not more sky per texel.
   *  * **Adding trees outside the kernel's radius changes nothing.** The term
   *    is local by construction and that is the point of it.
   */
  readonly saturation: number
  /**
   * How dark the most occluded ground is allowed to get, 0..1.
   *
   * **0 is the exact current image**, which is the shape every Anniversary
   * number takes and the reason this is safe to land before anyone has looked
   * at it.
   */
  readonly strength: number
}

export interface CanopyField {
  readonly vertPerSide: number
  /**
   * 0..1 per texel, `[z * vertPerSide + x]` — the same indexing as
   * `HeightField.heights` and `SunHeightField.tops`, deliberately, so the three
   * ride one texture and one UV.
   *
   * **0 is open ground and 1 is the darkest the preset allows**, i.e. the
   * `strength` is already folded in. The shader multiplies by `1 - occlusion`
   * and needs no second uniform, and a preset at `strength: 0` produces a field
   * of exact zeroes that the caller can skip uploading entirely.
   */
  readonly occlusion: Float32Array
  /**
   * WORLD y of the highest canopy over each texel, `[z * vertPerSide + x]`.
   *
   * What a prop's own fragments have to rise above to see the sky again, and
   * therefore the whole of DEV-296: without it a lone tree is uniformly
   * darkened by its OWN canopy, crown included, which reads as "the trees got
   * darker" rather than as shade.
   *
   * MAX rather than a mean: the highest canopy over you is the one you must
   * clear. It also makes the tallest tree in a stand light its own crown, for
   * free — its top IS the max there.
   *
   * Meaningless where `occlusion` is 0, and safely so: the shader multiplies
   * the two, so a texel with no canopy contributes nothing whatever this says.
   */
  readonly ceiling: Float32Array
  /** Props that landed on the grid. A receipt: zero means the FRAME is wrong. */
  readonly counted: number
  /** Props whose centre fell outside the grid. Expected to be small, not zero. */
  readonly offGrid: number
  /** The peak raw density, before the exponential. For the console line. */
  readonly maxDensity: number
  /**
   * Mean occlusion over EVERY texel, including the open sea.
   *
   * Near useless on its own and kept only as a non-zero check: alpine's forest
   * is a small part of a 4 km island, so a working sweep reads 0.0145 here and
   * a reader cannot tell that from a broken one. `p50Occluded` and
   * `p95Occluded` are the numbers to tune against.
   */
  readonly meanOcclusion: number
  /**
   * Median occlusion over the texels that have ANY canopy over them.
   *
   * *"How dark is a typical bit of forest floor"* — the question the feature is
   * about, and the one the mean cannot answer because it is diluted by every
   * texel of open sea and bare rock on the map.
   */
  readonly p50Occluded: number
  /** The same at the 95th percentile: how dark the thickest stands get. */
  readonly p95Occluded: number
  /** Fraction of the grid with any canopy at all. */
  readonly occludedFraction: number
  /** Mean height of a swept prop's canopy top above its own foot, metres. */
  readonly meanCanopyMetres: number
}

/** A spec that does nothing, for a preset with the feature off. */
export const CANOPY_OFF: CanopySpec = Object.freeze({
  radiusScale: 1,
  saturation: 1,
  strength: 0,
})

/**
 * Sweep the placements onto the grid, once.
 *
 * `props` are in MESH space — the frame `load-props.ts` calls
 * `colliderInputs` — which is the same 0..terrainSize frame the height field's
 * grid runs over, so a texel is `(x / step, z / step)` with no transform. That
 * shared frame is the whole reason this is cheap, and it is the one thing a
 * caller can get wrong silently: `counted` is the receipt.
 *
 * Cost is `props x (2r/step + 1)^2` writes. On alpine — the densest
 * environment, 6,069 live colliders of 6,069 by DEV-214's census — with an 8 m
 * step and canopy radii in the single-digit metres, that is a few texels each
 * and the sweep is milliseconds.
 */
export const buildCanopyField = (
  grid: CanopyGrid,
  props: Iterable<CanopyProp>,
  spec: CanopySpec,
): CanopyField => {
  const n = grid.vertPerSide
  const density = new Float32Array(n * n)
  const ceiling = new Float32Array(n * n)
  const originY = grid.originY ?? 0
  let counted = 0
  let offGrid = 0
  let canopySum = 0

  for (const p of props) {
    // The canopy's radius in metres. `width` is the DRAWN width at scale 1 and
    // the placement sits at its centre, so half of it is the silhouette.
    const radius = ((p.dims.width * p.scale) / 2) * spec.radiusScale
    if (!(radius > 0)) continue
    const cx = p.x / grid.step
    const cz = p.z / grid.step
    if (cx < 0 || cz < 0 || cx > n - 1 || cz > n - 1) {
      offGrid++
      continue
    }
    counted++
    // The world y this prop's canopy reaches. `dims` is at scale 1 and the
    // instance carries the rest; `originY` carries the mesh frame to the world
    // the shader compares against.
    const top = p.y + p.dims.height * p.scale + originY
    canopySum += p.dims.height * p.scale
    const r = radius / grid.step
    const x0 = Math.max(0, Math.ceil(cx - r))
    const x1 = Math.min(n - 1, Math.floor(cx + r))
    const z0 = Math.max(0, Math.ceil(cz - r))
    const z1 = Math.min(n - 1, Math.floor(cz + r))
    const rr = r * r

    // ── the kernel is a CONTACT PATCH, and area-preserving was wrong ──────
    //
    // Matt, DEV-297, circling two isolated trees on an open slope: *"i'd
    // expect the ground in areas like where i've circled to be darker."*
    //
    // It could not be, by construction. The kernel was normalised to lay down
    // `pi * r^2` of coverage however it was sampled, which makes DENSITY a
    // meaningful quantity and makes a LONE prop's patch impossible: spreading
    // a fixed integral over a wider disc lowers its peak, so widening the
    // radius made every tree's shade broader and FAINTER. Turning the radius
    // up 2.5x and the ceiling up did not fix the thing being asked about,
    // because neither touches the peak under one tree.
    //
    // So the peak is the quantity now, and the integral is not. A canopy that
    // covers at least a texel puts a FULL unit of coverage on the ground under
    // its trunk, falling to zero at its rim — a contact patch the size of the
    // thing casting it. Overlapping canopies still add, so a thicket is still
    // darker than a lone tree; it is the lone tree that stopped being free.
    //
    // **The shrub/oak bug the normalisation was introduced for stays fixed**,
    // by the cap rather than by the normalisation: a canopy smaller than a
    // texel covers `pi * r^2` OF one, so that is its peak, and a 1 m shrub
    // contributes 0.03 where a 12 m tree contributes 1. The cap is what makes
    // the two regimes one formula — `min(1, area)` is the area for a small
    // canopy and 1 for a large one, which is exactly "a texel cannot be more
    // than covered by one canopy".
    const area = Math.PI * rr
    const peak = area < 1 ? area : 1
    if (x1 < x0 || z1 < z0) {
      // No grid point inside the canopy at all. The nearest takes the peak,
      // which for a sub-texel canopy IS its area — the same rule as below.
      const i = Math.round(cz) * n + Math.round(cx)
      density[i] = (density[i] as number) + peak
      if (top > (ceiling[i] as number)) ceiling[i] = top
      continue
    }
    for (let z = z0; z <= z1; z++) {
      const dz = z - cz
      const row = z * n
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx
        const d2 = dx * dx + dz * dz
        if (d2 >= rr) continue
        density[row + x] = (density[row + x] as number) + (1 - d2 / rr) * peak
        if (top > (ceiling[row + x] as number)) ceiling[row + x] = top
      }
    }
  }

  const occlusion = new Float32Array(n * n)
  let maxDensity = 0
  let sum = 0
  if (spec.strength > 0 && spec.saturation > 0) {
    const inv = 1 / spec.saturation
    for (let i = 0; i < density.length; i++) {
      const d = density[i] as number
      if (d > maxDensity) maxDensity = d
      const o = (1 - Math.exp(-d * inv)) * spec.strength
      occlusion[i] = o
      sum += o
    }
  } else {
    for (let i = 0; i < density.length; i++) {
      const d = density[i] as number
      if (d > maxDensity) maxDensity = d
    }
  }

  // The percentiles over OCCLUDED texels only. Sorted rather than bucketed
  // because the array is a few hundred thousand floats once and never again,
  // and an exact median is one less thing to argue with when tuning.
  const occluded: number[] = []
  for (const v of occlusion) if (v > 0) occluded.push(v)
  occluded.sort((a, b) => a - b)
  const pick = (q: number): number =>
    occluded.length === 0
      ? 0
      : (occluded[Math.min(occluded.length - 1, Math.floor(q * occluded.length))] as number)

  return {
    vertPerSide: n,
    occlusion,
    ceiling,
    counted,
    offGrid,
    maxDensity,
    meanOcclusion: sum / (n * n),
    p50Occluded: pick(0.5),
    p95Occluded: pick(0.95),
    occludedFraction: occluded.length / (n * n),
    meanCanopyMetres: counted === 0 ? 0 : canopySum / counted,
  }
}
