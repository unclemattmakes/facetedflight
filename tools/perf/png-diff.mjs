// tools/perf/png-diff.mjs — mean absolute pixel difference between two folders
// of PNGs, so an A/B pair can be judged against its own NOISE FLOOR.
//
// Written for DEV-167 / W6 and kept because the trap it exists for is general.
// `tests/e2e/water-underside.spec.ts` shoots six frames of a sea whose wave is
// driven by RENDER time — *"the wave cycles every 3.14 s"*, its own comment —
// so two runs of the same build land on different phases and the PNG bytes
// never match. The first comparison of that pair reported 60 % of the zenith
// shot's pixels moving by more than 24 levels and looked like a serious
// regression. Running the SAME build twice reported the same thing.
//
// So: never read an A/B without its control. Usage —
//
//   node tools/perf/png-diff.mjs <a> <b> [<control-a> <control-b>] [--mask=<dir>]
//
// With four folders it prints the pair and the control side by side and says,
// per file, whether the pair is distinguishable from the control at all.
//
// ── `--mask=<dir>`, and why a whole-frame mean can be the wrong instrument ──
//
// DEV-182. A frame that is half sky and sea, with a change that only touches
// the land, gets its mean halved — and charged the noise of the two things
// that are NOT the subject. Measured on `int01-island-lit`: the whole frame's
// same-build control noise is **0.59 levels** and the LAND's is **0.09**, so
// six sevenths of that floor is drifting cloud and the sea's render-time wave.
// A change worth one level then reads as "inside the noise" when it is ten
// times the noise of the thing it changed.
//
// `--mask=<dir>` restricts every statistic to the pixels where `<a>` and
// `<dir>` differ by more than 24 levels on any channel. It is meant to be
// pointed at a build that changes ONLY the subject — for DEV-182 that is
// `?terrainLit=basic`, which repaints the land and touches nothing else — so
// the mask is DERIVED from a render rather than drawn by hand. Two properties
// worth stating, because a derived number needs an extracted one's provenance
// (DEV-027): it is a LOWER BOUND on the subject's extent, since a subject pixel
// whose masked colour happens to coincide is missed; and it contains nothing
// that is not the subject. The header line prints what share of the frame it
// kept, which is the sanity check that it found the right thing.
//
// Decodes 8-bit non-interlaced PNG (RGB/RGBA/grey) through tools/terrain/png.mjs, the
// repo's one dependency-free decoder (adding a package to compare two screenshots is not
// a trade this repo makes).

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { decodePngBuffer } from '../terrain/png.mjs'

/**
 * Decode an 8-bit, non-interlaced grey/RGB/RGBA PNG into `{ w, h, ch, data }`.
 *
 * The decoder is tools/terrain/png.mjs's (TL-13); this keeps the narrower contract
 * a pixel comparison needs: no 16-bit (a silent high-byte reduction would hide the
 * very noise being measured) and no grey+alpha (two channels read as "RGB" below).
 */
export const decodePng = (buf) => {
  const img = decodePngBuffer(buf, 'png-diff')
  if (img.bitDepth !== 8 || img.channels === 2) {
    throw new Error(
      `png-diff: unsupported PNG (${img.channels} channels, bitDepth ${img.bitDepth})`,
    )
  }
  return { w: img.width, h: img.height, ch: img.channels, data: img.data }
}

/**
 * Which pixels a comparison counts: every one, or the ones where `a` and the
 * mask render disagree by more than 24 levels. See `--mask=` in the header.
 *
 * Returns a `Uint8Array` of one byte per PIXEL (not per channel), and the share
 * of the frame it kept, so the caller can print it — a mask that turns out to
 * be 3 % or 99 % of the frame is a mask pointed at the wrong render.
 */
export const maskFrom = (a, m) => {
  if (a.w !== m.w || a.h !== m.h) return null
  const n = a.w * a.h
  const keep = new Uint8Array(n)
  let kept = 0
  const rgb = Math.min(3, a.ch, m.ch)
  for (let p = 0; p < n; p++) {
    for (let k = 0; k < rgb; k++) {
      if (Math.abs(a.data[p * a.ch + k] - m.data[p * m.ch + k]) > 24) {
        keep[p] = 1
        kept++
        break
      }
    }
  }
  return { keep, share: kept / n }
}

/**
 * The SPATIAL shape of a mask: how big its largest 4-connected component is,
 * and how many components are worth calling regions at all.
 *
 * ── Why a mean is not enough, and neither is a count ─────────────────────
 *
 * DEV-241's lesson, in a second form. A mean says how much moved and a share
 * says over how much of the frame, and **neither can tell a seam from
 * scattered noise**: 1 % of the frame moving can be a shadow that vanished
 * down one flank, or it can be one moved pixel in a hundred spread evenly over
 * the whole picture by a drifting cloud and a wave phase that `?snap=` does not
 * hold (`boot/snap.ts`). Those two are the same number and the opposite
 * finding — the first is visible from the seat and the second is not
 * (ART_DIRECTION: *too small, too dark, too fast or off-screen has not been
 * reviewed, it has been rendered*).
 *
 * `largestShare` separates them, and it separates them without a threshold of
 * its own: the statistic is read against the SAME statistic on a control pair,
 * so what counts as a big blob is decided by what the noise floor's biggest
 * blob is on that run rather than by a constant typed here.
 *
 * 4-connected, not 8: a diagonal chain of single pixels is exactly the
 * scattered case this exists to refuse, and 8-connectivity would join it into
 * one long "region". An explicit stack rather than recursion, because a
 * component in a 2016 x 2016 frame can be millions of pixels deep.
 *
 * `minShare` is what counts as a region for the `components` count only; it
 * never touches `largest`.
 */
export const blobStats = (keep, w, h, minShare = 0.0005) => {
  const n = w * h
  if (keep.length !== n) return null
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const floor = Math.max(1, Math.round(minShare * n))
  let moved = 0
  let largest = 0
  let components = 0
  for (let p = 0; p < n; p++) if (keep[p]) moved++
  for (let start = 0; start < n; start++) {
    if (!keep[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let size = 0
    while (top > 0) {
      const p = stack[--top]
      size++
      const x = p % w
      // 4-connectivity, with the row edges respected — a `p - 1` that wrapped
      // would join the left of one row to the right of the one above it and
      // report a single component for a frame of stripes.
      if (x > 0 && keep[p - 1] && !seen[p - 1]) {
        seen[p - 1] = 1
        stack[top++] = p - 1
      }
      if (x + 1 < w && keep[p + 1] && !seen[p + 1]) {
        seen[p + 1] = 1
        stack[top++] = p + 1
      }
      if (p >= w && keep[p - w] && !seen[p - w]) {
        seen[p - w] = 1
        stack[top++] = p - w
      }
      if (p + w < n && keep[p + w] && !seen[p + w]) {
        seen[p + w] = 1
        stack[top++] = p + w
      }
    }
    if (size > largest) largest = size
    if (size >= floor) components++
  }
  return {
    moved,
    movedShare: moved / n,
    largest,
    largestShare: largest / n,
    components,
  }
}

/**
 * Mean absolute RGB difference, the max, and the share of channels over 24
 * levels, between two ALREADY DECODED frames.
 *
 * Split out of `comparePng` for DEV-245, which takes four arms, a control and
 * a mask render off one pose and compares every pair of them: decoding is the
 * whole cost of that at 2016 x 2016, and the buffer-taking form below decodes
 * both sides again on every call. Same arithmetic, same units, one decode.
 */
export const compareDecoded = (a, b, mask = null) => {
  if (a.w !== b.w || a.h !== b.h) return null
  let sum = 0
  let max = 0
  let over = 0
  let n = 0
  // Each side indexed by ITS OWN channel count, which `maskFrom` has always
  // done and this comparison had not: an RGB frame against an RGBA one read
  // the second frame a channel further along with every pixel. Both sides come
  // out of one screenshot in every caller today, so it has never fired; it is
  // the same per-channel-versus-per-pixel trap `png-diff-mask.test.ts` opens on.
  const rgb = Math.min(3, a.ch, b.ch)
  for (let p = 0; p < a.w * a.h; p++) {
    if (mask && !mask[p]) continue
    const ia = p * a.ch
    const ib = p * b.ch
    for (let k = 0; k < rgb; k++) {
      const d = Math.abs(a.data[ia + k] - b.data[ib + k])
      sum += d
      if (d > max) max = d
      if (d > 24) over++
      n++
    }
  }
  return n === 0 ? null : { mean: sum / n, max, over: over / n }
}

/**
 * Mean absolute RGB difference, the max, and the share of channels over 24
 * levels — over the whole frame, or over `mask`'s pixels when one is given.
 *
 * The ENCODED form: decodes both sides and delegates. Where several pairs are
 * taken off the same frames, decode once and call `compareDecoded`.
 */
export const comparePng = (aBuf, bBuf, mask = null) =>
  compareDecoded(decodePng(aBuf), decodePng(bBuf), mask)

const main = () => {
  const args = process.argv.slice(2)
  const maskDir = args.find((s) => s.startsWith('--mask='))?.slice('--mask='.length) ?? null
  const [a, b, ca, cb] = args.filter((s) => !s.startsWith('--'))
  if (!a || !b) {
    console.error(
      'usage: node tools/perf/png-diff.mjs <a> <b> [<control-a> <control-b>] [--mask=<dir>]',
    )
    process.exit(2)
  }
  // Built per file, from `a` and the mask render, and shared by the pair and
  // the control so both are measured over the SAME pixels — which is the whole
  // point of having a control.
  const maskFor = (file) => {
    if (!maskDir) return null
    return maskFrom(
      decodePng(fs.readFileSync(path.join(a, file))),
      decodePng(fs.readFileSync(path.join(maskDir, file))),
    )
  }
  const readPair = (dirA, dirB, file, mask) =>
    comparePng(fs.readFileSync(path.join(dirA, file)), fs.readFileSync(path.join(dirB, file)), mask)
  const files = fs.readdirSync(a).filter((f) => f.endsWith('.png'))
  const head = ca
    ? `${'file'.padEnd(22)} ${'pair mean'.padStart(9)} ${'ctl mean'.padStart(9)}  ${'pair >24'.padStart(8)} ${'ctl >24'.padStart(8)}   verdict`
    : `${'file'.padEnd(22)} ${'mean'.padStart(9)} ${'max'.padStart(4)} ${'>24'.padStart(8)}`
  if (maskDir) console.log(`masked by --mask=${maskDir}; statistics cover those pixels only`)
  console.log(head)
  for (const f of files) {
    const mask = maskFor(f)
    if (maskDir && !mask) {
      console.log(`${f.padEnd(22)} mask size mismatch`)
      continue
    }
    const pair = readPair(a, b, f, mask?.keep ?? null)
    if (!pair) {
      console.log(`${f.padEnd(22)} size mismatch`)
      continue
    }
    const share = mask ? `  [mask ${(100 * mask.share).toFixed(1)} %]` : ''
    if (!ca || !cb) {
      console.log(
        `${f.padEnd(22)} ${pair.mean.toFixed(2).padStart(9)} ${String(pair.max).padStart(4)} ${`${(100 * pair.over).toFixed(2)}%`.padStart(8)}${share}`,
      )
      continue
    }
    const control = readPair(ca, cb, f, mask?.keep ?? null)
    // The bar: a pair is only evidence when it moves the frame further than
    // two runs of the same build do. 1.5x is deliberately generous — the point
    // is to catch the case where the control is the WHOLE signal.
    const verdict = !control ? '?' : pair.mean > control.mean * 1.5 ? 'DIFFERS' : 'inside the noise'
    console.log(
      `${f.padEnd(22)} ${pair.mean.toFixed(2).padStart(9)} ${(control?.mean ?? 0).toFixed(2).padStart(9)}  ` +
        `${`${(100 * pair.over).toFixed(2)}%`.padStart(8)} ${`${(100 * (control?.over ?? 0)).toFixed(2)}%`.padStart(8)}   ${verdict}${share}`,
    )
  }
}

// Run as a script, importable as a module. `argv[1]` is undefined under
// `node --input-type=module -e`, which is how the water A/B first read it.
//
// This compares the WHOLE path, built the way node builds the entry's own
// `import.meta.url`: realpath, then file URL. It used to be
// `import.meta.url.endsWith(path.basename(entry))`, a suffix match, so any
// importer whose name is a suffix of this one's (`diff.mjs`, `ff.mjs`, a
// `png-diff.mjs` in another folder) ran `main()` at import time, which printed
// the usage line and exited 2 underneath it. The realpath is not decoration:
// through a directory link node keeps `argv[1]` as typed and resolves
// `import.meta.url` to the real file, so a plain `pathToFileURL(entry)` says
// "not the entry" and the CLI does nothing, silently. The `catch` is for an
// `argv[1]` that names no file, which `-e` leaves there when a word follows the
// code. `tests/unit/png-diff-entry.test.ts` spawns node on every case above.
const isEntry = () => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url
  } catch {
    return false
  }
}
if (isEntry()) main()
