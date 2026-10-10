/**
 * tests/e2e/fixtures/label-contrast.ts — how well one canvas label reads against
 * the room it floats in (DEV-437 addendum).
 *
 * Pure: three decoded frames in, numbers out, so `tests/unit/label-contrast.test.ts`
 * can hold the arithmetic against WCAG's own fixed points. The frames are of ONE
 * label, taken by `hangar-art.spec.ts`:
 *
 *   shown    the label alone, as the game draws it;
 *   tinted   the label alone with its material's colour set to magenta (1, 0, 1),
 *            which zeroes the GREEN of every texel it draws — so the green it
 *            takes away, `shown - tinted`, is where the label's ink is, and how
 *            much of it;
 *   hidden   no label at all: the room behind.
 *
 * Every ink the room paints has plenty of green (the dimmest, the dead plate's
 * `#4f5a65`, has 90), and a dark halo has almost none, so the mask finds the
 * letters and not their backing.
 *
 * Two ratios, WCAG 2's `(L1 + 0.05) / (L2 + 0.05)` on relative luminance:
 *
 *   vsBehind    the letters against the room behind them — the question as it
 *               stood before the labels had a backing;
 *   vsSurround  the letters against the pixels immediately round them in the
 *               frame the player sees, halo and all — which is what the eye
 *               actually separates. This is the one `hangar-art.spec.ts` floors.
 */

/** A decoded 8-bit frame, `ch` samples per pixel, row-major (`tools/perf/png-diff.mjs`). */
export interface Frame {
  readonly w: number
  readonly h: number
  readonly ch: number
  readonly data: Uint8Array | Buffer
}

/** WCAG 2 relative luminance of an 8-bit sRGB colour. */
export const relativeLuminance = (r: number, g: number, b: number): number => {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2 contrast ratio of two relative luminances, 1 to 21. */
export const contrastRatio = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

export interface LabelContrast {
  /** Pixels counted as the label's letters. */
  readonly glyphs: number
  /** Pixels counted as their immediate surround. */
  readonly ring: number
  /** Median relative luminance of the letters, of the room behind them, and of the surround. */
  readonly text: number
  readonly behind: number
  readonly surround: number
  readonly vsBehind: number
  readonly vsSurround: number
}

/** Share of the strongest ink a pixel must carry to count as a letter. */
const GLYPH = 0.6
/** Share of it below which a pixel carries no ink at all. */
const CLEAR = 0.1
/** How far round a letter, in pixels, its surround reaches. */
const RING = 3
/** Less green than this taken away anywhere, and the label is not on screen. */
const VISIBLE = 40

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? Number.NaN
}

/**
 * The contrast of the label inside `box` (screen pixels, x0 y0 x1 y1), or null
 * when the box holds no visible ink.
 */
export const labelContrast = (
  shown: Frame,
  tinted: Frame,
  hidden: Frame,
  box: readonly [number, number, number, number],
): LabelContrast | null => {
  for (const f of [tinted, hidden]) {
    if (f.w !== shown.w || f.h !== shown.h || f.ch !== shown.ch) {
      throw new Error('label-contrast: the three frames are not the same size')
    }
  }
  const x0 = Math.max(0, Math.floor(box[0]))
  const y0 = Math.max(0, Math.floor(box[1]))
  const x1 = Math.min(shown.w, Math.ceil(box[2]))
  const y1 = Math.min(shown.h, Math.ceil(box[3]))
  const bw = x1 - x0
  const bh = y1 - y0
  if (bw <= 0 || bh <= 0) return null
  const at = (x: number, y: number) => (y * shown.w + x) * shown.ch
  const ink = new Float32Array(bw * bh)
  let most = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = at(x, y) + 1
      const v = Math.max(0, (shown.data[k] as number) - (tinted.data[k] as number))
      ink[(y - y0) * bw + (x - x0)] = v
      most = Math.max(most, v)
    }
  }
  if (most < VISIBLE) return null
  const glyph = new Uint8Array(bw * bh)
  for (let i = 0; i < ink.length; i++) glyph[i] = (ink[i] as number) >= GLYPH * most ? 1 : 0
  const lum = (f: Frame, x: number, y: number) => {
    const k = at(x, y)
    return relativeLuminance(f.data[k] as number, f.data[k + 1] as number, f.data[k + 2] as number)
  }
  const text: number[] = []
  const behind: number[] = []
  const ring: number[] = []
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x
      if (glyph[i]) {
        text.push(lum(shown, x + x0, y + y0))
        behind.push(lum(hidden, x + x0, y + y0))
        continue
      }
      if ((ink[i] as number) >= CLEAR * most) continue
      let near = false
      for (let dy = -RING; dy <= RING && !near; dy++) {
        for (let dx = -RING; dx <= RING; dx++) {
          const u = x + dx
          const v = y + dy
          if (u >= 0 && v >= 0 && u < bw && v < bh && glyph[v * bw + u]) {
            near = true
            break
          }
        }
      }
      if (near) ring.push(lum(shown, x + x0, y + y0))
    }
  }
  if (text.length === 0 || ring.length === 0) return null
  const t = median(text)
  const b = median(behind)
  const s = median(ring)
  return {
    glyphs: text.length,
    ring: ring.length,
    text: t,
    behind: b,
    surround: s,
    vsBehind: contrastRatio(t, b),
    vsSurround: contrastRatio(t, s),
  }
}
