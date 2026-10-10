#!/usr/bin/env node
// ghost.mjs — pack a decimated ghost recording into git-shippable integers.
//
// WHY THIS EXISTS AT ALL
//
// A ghost is a 2016 recording and it belongs in git, not on R2: it is small,
// first-party, and it versions with the level that references it (D12,
// content/MANIFEST.md §3/§5). The obstacle was format. The float32 stream the
// sim samples is `.f32`, and `.f32` is on the denylist under "opaque binaries
// and archives — a human cannot licence-review these in a diff". That rule is
// about REVIEWABILITY, not about licence, so the honest way past it is to stop
// shipping an opaque blob rather than to ask for an exception to the rule about
// opaque blobs. MANIFEST §3 recommended exactly this: "change the format, don't
// punch a hole in the denylist".
//
// So a clip ships as plain integers under `content/ghosts/`, beside
// `content/levels/*.json`, which the denylist already recognises as "Matt's own
// level design as plain numbers". It needs no allowlist entry of any kind:
// `.json` is not a denied extension and a clip lands well under the 256 KiB
// size ceiling. Nothing to maintain, and nothing to maintain twenty-four more
// times when the other twelve missions land.
//
// THE PACKING
//
// One integer per component, absolute — NOT delta-encoded. Delta would roughly
// halve the file, and it is the wrong trade here: the entire reason this format
// is text is so a human can read it in a diff, and a delta stream is unreadable
// without decoding it first. Absolute integers mean a changed key is one
// changed number, and a position can be read straight off the page.
//
// Measured against the source floats for both int_01 clips, not estimated:
//
//   time      ms        (x1000)   <= 0.500 ms   vs a 16.7 ms recording period
//   position  mm        (x1000)   <= 0.500 mm   vs the 25 mm decimation epsilon
//   rotation  int16     (x32767)  <= 0.034 deg  angular, after renormalising
//
// The rotation figure is the ANGLE between the source and decoded quaternions,
// which is what a viewer sees; per-component error is ~8x smaller and would be
// the flattering number to quote. Every bound is far below the 0.025 m
// decimation that was already applied to this data in 2016, so quantisation is
// not what limits fidelity here -- decimation is, and that predates this tool.
// `tests/unit/ghost.test.ts` asserts these bounds rather than trusting this
// comment.
//
// INPUT is the decimated `.f32` in the staging dir, which is where
// `tools/prototype/unity_anim_to_json.js --binary` left it. This tool does NOT
// read the Unity project: it re-packs bytes that were already extracted, so the
// recording is preserved exactly as decimated rather than re-derived.
//
// ── NOT part of `pnpm extract`, deliberately (2026-09-16) ─────────────────
//
// `pnpm extract` means "regenerate from the read-only Unity project", and this
// tool does not read it. Its input is a staging dir that a one-off prototype
// produced, and that dir is on no machine today — neither `tools/prototype/out`
// nor `../ff2-scratch/out`. So in the chain it was a guaranteed exit 1 partway
// through, which also stopped `extract:palettes` running behind it, and the
// whole command could not complete on any host.
//
// Nothing is lost by the removal. Both recordings are committed under
// `content/ghosts/` and hash-guarded by `content/_generated.sha256`, so
// `pnpm extract:check` still refuses a hand-edit — the guard never depended on
// this tool being runnable. To re-derive them: `unity_anim_to_json.js --binary`
// against `$FF2_LEGACY` to rebuild the staging dir, then run this by hand.
//
// Note the asymmetry before wiring `--check` into anything: with nothing staged
// it exits **0** ("nothing staged, skipping") while the write path exits 1. A
// check that passes when it verified nothing is the `0/0 ready verified` shape,
// which is why `extract:check` guards these files by hash instead.
//
// Usage:
//   node tools/extract/ghost.mjs --all
//   node tools/extract/ghost.mjs int_01_leftSpawn_fast_01
//   node tools/extract/ghost.mjs --all --check    # fail if the output would change
//
// Env:
//   FF2_STAGE_DIR   where the `.clip.f32` files live
//                   (default: first of tools/prototype/out, ../ff2-scratch/out)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const OUT_DIR = join(REPO_ROOT, 'content', 'ghosts')

/** Floats per key in the source stream: [t, px,py,pz, qx,qy,qz,qw]. */
const STRIDE = 8

/** Quantisation scales. Also written into every file, so a decoder never guesses. */
export const QUANT = { time: 1000, pos: 1000, rot: 32767 }

const argv = process.argv.slice(2)
const CHECK = argv.includes('--check')
const ALL = argv.includes('--all')

/**
 * `--mission <id>` (repeatable) is the normal way to run this, and package.json
 * passes the shipped slice. Scope is deliberately NOT inferred: the encoder ships
 * what a playable mission references, and which missions are playable is a
 * project decision that belongs somewhere a human can read it, not in a glob.
 */
const missions = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--mission') {
    const id = argv[i + 1]
    if (!id || id.startsWith('--')) {
      console.error('extract:ghosts: --mission needs a level id, e.g. --mission int_01_hoverJet')
      process.exit(2)
    }
    missions.push(id)
    i++
  }
}
const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--mission')

function stageDir() {
  if (process.env.FF2_STAGE_DIR) return resolve(process.env.FF2_STAGE_DIR)
  const candidates = [
    join(REPO_ROOT, 'tools', 'prototype', 'out'),
    resolve(REPO_ROOT, '..', 'ff2-scratch', 'out'),
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/**
 * Provenance for a clip. The Unity asset name IS the clip name -- it is what
 * `readGhosts` in level.mjs matches on to attribute a ghost to a mission, and
 * what the level JSON's `clip` field carries. Keep the two spellings identical.
 */
const sourceOf = (name) => `Assets/OMS_Animation/Resources/${name}.anim`

/** Pack one float32 stream into the shipped integer document. */
export function packGhost(name, floats) {
  if (floats.length === 0 || floats.length % STRIDE !== 0) {
    throw new Error(
      `${name}: ${floats.length} floats is not a whole number of ${STRIDE}-float keys`,
    )
  }
  const keyCount = floats.length / STRIDE
  const t = new Array(keyCount)
  const p = new Array(keyCount * 3)
  const q = new Array(keyCount * 4)

  for (let i = 0; i < keyCount; i++) {
    const o = i * STRIDE
    t[i] = Math.round(floats[o] * QUANT.time)
    for (let c = 0; c < 3; c++) p[i * 3 + c] = Math.round(floats[o + 1 + c] * QUANT.pos)
    for (let c = 0; c < 4; c++) {
      // Clamp: a recorded quaternion can sit a hair outside [-1,1] after the
      // float32 round-trip, and int16 has no room to spare at the ends.
      const v = Math.max(-1, Math.min(1, floats[o + 4 + c]))
      q[i * 4 + c] = Math.round(v * QUANT.rot)
    }
  }

  return {
    $schema: 'ff2-ghost-1',
    name,
    source: sourceOf(name),
    space: 'THREE, positions relative to the level worldOffset',
    note: 'Absolute quantised integers, not deltas, so a diff stays readable. See tools/extract/ghost.mjs.',
    keyCount,
    duration: t[keyCount - 1] / QUANT.time,
    /**
     * Seconds of the clip before the ghost moves. DEV-025 skips it so all
     * three ships leave together — see `launchAtSeconds`.
     */
    launchAt: launchAtSeconds(name, floats, STRIDE),
    quant: QUANT,
    t,
    p,
    q,
  }
}

/**
 * When the ghost actually LEAVES THE LINE, in clip seconds.
 *
 * Matt: *"i didn't see those ghost racers at all"* — and the reason was that
 * both `int_01` recordings sit on their pad for about seven seconds before
 * moving, while FF2 releases the player at mission t = 0. A free seven-second
 * head start on both opponents, which is not a race. DEV-025 skips the hold.
 *
 * ── Measured by DISPLACEMENT, after speed failed twice ────────────────────
 *
 * Speed was the obvious test and it does not work. Key to key at the raw 60 Hz
 * the parked ship reads **8.2 m/s**, and averaged over a third of a second it
 * still reads **9.2** — against a first racing key of 11.5. Those are not far
 * enough apart to put a threshold between, and the guard below caught both
 * attempts rather than letting a plausible number through.
 *
 * It is not jitter, it is real drift: a hovering ship wanders. But it wanders
 * around a POINT, so displacement from where it started does not accumulate:
 *
 *     t = 0.00   0.0 m      t = 7.48    3.2 m
 *     t = 1.12   0.7 m      t = 7.96   14.4 m
 *     t = 5.98   1.0 m      t = 8.59   43.5 m
 *
 * Under a metre for six seconds, then fourteen metres in half a second. Any
 * threshold between about 2 and 12 gives the same answer, and the assert below
 * is what keeps that true rather than assumed.
 */
const LAUNCH_DISPLACEMENT = 10
/** The hold must stay well under the threshold, or it is not a clean step. */
const HOLD_DISPLACEMENT_MAX = 4
/** How far before the launch to read the hold, in seconds. */
const HOLD_LOOKBACK = 1

function launchAtSeconds(name, floats, stride) {
  const keyCount = floats.length / stride
  const x0 = floats[1]
  const y0 = floats[2]
  const z0 = floats[3]
  const displacementAt = (i) =>
    Math.hypot(
      floats[i * stride + 1] - x0,
      floats[i * stride + 2] - y0,
      floats[i * stride + 3] - z0,
    )
  let launch = null
  for (let i = 1; i < keyCount; i++) {
    if (displacementAt(i) > LAUNCH_DISPLACEMENT) {
      launch = floats[i * stride]
      break
    }
  }
  if (launch === null) {
    throw new Error(
      `extract:ghosts: ${name} never travels ${LAUNCH_DISPLACEMENT} m from its start — ` +
        'it is not a racing recording',
    )
  }
  // The hold is what the ship was doing a clear second BEFORE it left. Measuring
  // right up to the threshold instead reads the acceleration — the first version
  // of this reported a 10.0 m "wander" against a 10 m threshold, which is a
  // launch in progress, not a ship on its pad.
  let holdMax = 0
  for (let i = 1; i < keyCount; i++) {
    if (floats[i * stride] > launch - HOLD_LOOKBACK) break
    const d = displacementAt(i)
    if (d > holdMax) holdMax = d
  }
  if (holdMax > HOLD_DISPLACEMENT_MAX) {
    throw new Error(
      `extract:ghosts: ${name}'s launch is not a clean step — it is ${holdMax.toFixed(1)} m ` +
        `from its start a full ${HOLD_LOOKBACK} s before crossing the ` +
        `${LAUNCH_DISPLACEMENT} m threshold. Pick the threshold from the data, not from habit.`,
    )
  }
  return Math.round(launch * 1e6) / 1e6
}

/**
 * One key per line for `t`, three numbers per line for `p`, four for `q`.
 * `JSON.stringify(doc, null, 2)` would put every integer on its own line and
 * turn a 1,400-key clip into 17,000 lines; a single line per array would be one
 * unreadable 30 KB line. Rows keyed to the natural stride are the readable
 * middle, and they make a diff point at the key that moved.
 */
function render(doc) {
  const rows = (arr, per) => {
    const out = []
    for (let i = 0; i < arr.length; i += per) out.push(`    ${arr.slice(i, i + per).join(', ')}`)
    return `[\n${out.join(',\n')}\n  ]`
  }
  const scalar = (v) => JSON.stringify(v)
  return (
    '{\n' +
    `  "$schema": ${scalar(doc.$schema)},\n` +
    `  "name": ${scalar(doc.name)},\n` +
    `  "source": ${scalar(doc.source)},\n` +
    `  "space": ${scalar(doc.space)},\n` +
    `  "note": ${scalar(doc.note)},\n` +
    `  "keyCount": ${doc.keyCount},\n` +
    `  "duration": ${doc.duration},\n` +
    `  "launchAt": ${doc.launchAt},\n` +
    `  "quant": ${JSON.stringify(doc.quant)},\n` +
    `  "t": ${rows(doc.t, 1)},\n` +
    `  "p": ${rows(doc.p, 3)},\n` +
    `  "q": ${rows(doc.q, 4)}\n` +
    '}\n'
  )
}

/**
 * The staged bytes for a clip, or null. `.eps025.clip.f32` is the decimated
 * stream and wins whenever it exists; `.clip.f32` is decimated for some clips
 * and RAW for others, which is why nothing here trusts the name alone --
 * see `assertDecimated`.
 */
function stagedPathFor(name) {
  for (const suffix of ['.eps025.clip.f32', '.clip.f32']) {
    const p = join(STAGE, `${name}${suffix}`)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Refuse a stream that is still at recording rate.
 *
 * 2016 recorded at 60 Hz and shipping that is a 20x waste, but the reason this
 * is an ERROR rather than a warning is that the raw and decimated files differ
 * only by an `.eps025` infix in a scratch directory. Shipping the raw one
 * produces a clip that plays back perfectly and is seven times the size ceiling
 * -- a mistake that passes every visual check. Decimated clips run ~16 keys/s;
 * raw ones ~60. Anything at or above 40 is not decimated.
 */
function assertDecimated(name, keyCount, duration) {
  const rate = duration > 0 ? keyCount / duration : 0
  if (rate >= 40) {
    console.error(
      `extract:ghosts: ${name} looks UNDECIMATED -- ${keyCount} keys over ` +
        `${duration.toFixed(1)} s is ${rate.toFixed(0)} keys/s, near the 60 Hz recording rate.
` +
        '  Ship the decimated stream (`<name>.eps025.clip.f32`), not the raw capture.',
    )
    process.exit(1)
  }
  return rate
}

// ── Drive ─────────────────────────────────────────────────────────────────
const STAGE = stageDir()
if (!existsSync(STAGE)) {
  // Asymmetric on purpose. `--all` on a machine with no scratch dir has nothing
  // to do, and should not break `pnpm extract` for someone who has the Unity
  // project mounted but not the intermediates. Naming a clip explicitly and not
  // getting it is a real failure.
  if (ALL && names.length === 0) {
    console.log(`extract:ghosts: no staging dir at ${STAGE} - nothing staged, skipping.`)
    console.log('  (set FF2_STAGE_DIR if the decimated .clip.f32 files live elsewhere)')
    process.exit(0)
  }
  console.error(`extract:ghosts: staging dir not found: ${STAGE}\n  set FF2_STAGE_DIR`)
  process.exit(1)
}

let wanted = names
if (ALL || missions.length > 0) {
  // Drive the list from the LEVELS, not from a glob of the staging dir. The
  // staging dir holds intermediates nobody ships -- it has a raw
  // `adv_01_leftSpawn_fast_01.clip.f32` (321 KB, 60 Hz) sitting beside the
  // decimated `.eps025` one, and a glob happily picked the raw file. What the
  // game can actually reference is exactly the set of `clip` names in
  // content/levels/*.json, so that is the set.
  const levelDir = join(REPO_ROOT, 'content', 'levels')
  const files =
    missions.length > 0
      ? missions.map((id) => `${id}.json`)
      : readdirSync(levelDir).filter((x) => x.endsWith('.json'))
  const referenced = new Set()
  for (const f of files) {
    const full = join(levelDir, f)
    if (!existsSync(full)) {
      console.error(`extract:ghosts: no such level: content/levels/${f}`)
      process.exit(1)
    }
    const lvl = JSON.parse(readFileSync(full, 'utf8'))
    for (const g of lvl.ghosts ?? []) if (g.clip) referenced.add(g.clip)
  }
  const staged = [...referenced].sort().filter((n) => stagedPathFor(n))
  const missing = [...referenced].sort().filter((n) => !stagedPathFor(n))
  if (missing.length > 0) {
    console.log(`  (${missing.length} clip(s) referenced by a level with no staged bytes yet:`)
    for (const m of missing) console.log(`     ${m}`)
    console.log('   they stay unshipped until someone extracts them.)')
  }
  wanted = staged
}
if (wanted.length === 0) {
  console.error('extract:ghosts: nothing to do. Pass clip names, or --all.')
  console.error('usage: ghost.mjs [--all] [--check] [<clip> ...]')
  process.exit(2)
}

mkdirSync(OUT_DIR, { recursive: true })
let changed = 0

for (const name of wanted) {
  const src = stagedPathFor(name)
  if (!src) {
    console.error(`extract:ghosts: no staged bytes for ${name} under ${STAGE}`)
    process.exit(1)
  }
  const bytes = readFileSync(src)
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const doc = packGhost(name, floats)
  assertDecimated(name, doc.keyCount, doc.duration)
  const text = render(doc)
  const dest = join(OUT_DIR, `${name}.json`)
  const prior = existsSync(dest) ? readFileSync(dest, 'utf8') : null

  if (prior === text) {
    console.log(`  =  ${name}.json  (${text.length.toLocaleString()} B, unchanged)`)
    continue
  }
  changed += 1
  if (CHECK) {
    console.error(`extract:ghosts: ${name}.json would change. Run \`pnpm extract:ghosts\`.`)
    continue
  }
  writeFileSync(dest, text, 'utf8')
  const ratio = ((text.length / bytes.byteLength) * 100).toFixed(0)
  console.log(
    `  ->  ${name}.json  ${bytes.byteLength.toLocaleString()} B binary ` +
      `-> ${text.length.toLocaleString()} B text (${ratio}%)`,
  )
}

// Anything in content/ghosts/ that nothing in scope references. Narrowing the
// scope is how adv_01 got dropped, and a generated tree that silently keeps a
// file nobody asked for is the shape of bug this whole session started with:
// a shipped artefact whose name looks right and whose presence nobody rechecked.
// Reported, never auto-deleted -- these are committed files.
if (wanted.length > 0) {
  const inScope = new Set(wanted.map((n) => `${n}.json`))
  const orphans = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.json') && !inScope.has(f))
    .sort()
  if (orphans.length > 0) {
    console.log('')
    console.log(`  ${orphans.length} clip(s) in content/ghosts/ that nothing in scope references:`)
    for (const o of orphans) console.log(`     ${o}`)
    console.log('   delete them, or widen the scope with another --mission.')
    if (CHECK) process.exit(1)
  }
}

if (CHECK && changed > 0) process.exit(1)
console.log(`extract:ghosts: ${wanted.length} clip(s) in ${OUT_DIR}`)
