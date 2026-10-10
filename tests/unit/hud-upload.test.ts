// tests/unit/hud-upload.test.ts — DEV-244's upload lever, the arithmetic behind
// it, and the shipped texture it must not disturb.
//
// ── What is being defended ───────────────────────────────────────────────
//
// `VR-PERF-WAVE-4.md` §3.8 measured DEV-243's redraw budget at **−1.95 of p50
// and −0.61 of p95** on `int_01_hoverJet`: 95 % of everything freezing the
// panel buys, and 46 % of it. The asymmetry is structural — at 9.2 Hz on a
// 70 fps flight 13 % of frames still carry an upload and the 95th-percentile
// frame is by definition one of them — and the pass rule is on p95. So this
// lever makes the upload that remains cheap, where the budget made it rarer.
//
// Four jobs, and the third is the one that would otherwise rot:
//
//  1. **The arithmetic.** `mipBytes` is what `?hudUpload=nomip` removes and
//     `bytes` is what it does not, and conflating the two is how a 150 KB
//     saving gets quoted as 600 (DEV-027 — say what the number is the bytes
//     OF).
//  2. **The arm fires, and the probe can tell.** `upload` is the intent and
//     `liveUpload` is classified off the texture's own fields; a probe that
//     echoed the intent could not tell a pin that landed from one that never
//     reached the panel, which is DEV-232's 0.025 ms and DEV-231's fourteen
//     withdrawn rows.
//  3. **three's own anisotropy rule, read out of three's own build.**
//     `setTextureParameters` refuses `TEXTURE_MAX_ANISOTROPY_EXT` for any
//     `minFilter` that is not mipmap-linear, so `LinearFilter` loses the chain
//     AND the panel's `anisotropy = 4`. That is the pixel cost of this change
//     and the reason `hudTextureState` sets anisotropy to 1 rather than
//     leaving a 4 the GPU never sees. If three relaxes that rule, or somebody
//     puts the 4 back, the decision has to be re-read — and this is the thing
//     that says so out loud. CLAUDE.md: compare against something outside the
//     port; `xr-eye-layers.test.ts` reads three's build for exactly this.
//  4. **What one repaint asks of the CANVAS**, and the hypothesis that
//     number is there to kill. Freezing this panel costs `int_01_hoverJet`
//     ten times what it costs `adv_02_jumpSeat` (Δp50 −2.13 against −0.21)
//     for 2.4× the repaints, so ~4.2× of it is per-upload cost. One candidate
//     is that an upload must resolve the 2-D backend's pending commands, in
//     which case the cost tracks canvas OPERATIONS per repaint — and the
//     last-but-one `describe` shows the two vehicles differ by a couple of
//     calls in the mid twenties, not by a factor of four.
//
// ── The assertions that fail on the unfixed code ─────────────────────────
//
// Every `describe` but the last fails on `main`: `parseHudUpload`,
// `hudTextureState`, `mipChainBytes`, `hudCanvasOps`, `setUpload` and the
// report's new fields do not exist there. The last one is the guard in the
// other direction — it pins the SHIPPED texture state against three's own
// constructor defaults and the one literal that was in `createHud` before this
// row, and it is written so that it would have been green on the unfixed code
// too.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BYTES_PER_TEXEL,
  classifyHudTexture,
  createHud,
  describeHudRedraw,
  describeHudUpload,
  HUD_ANISOTROPY,
  HUD_REDRAW_DEFAULT,
  HUD_UPLOAD_MIP,
  type Hud,
  type HudState,
  hudCanvasOps,
  hudTextureState,
  hudUploadBytes,
  mipChainBytes,
  mipChainLevels,
  parseHudUpload,
} from '@/render/hud'
import { REPO as ROOT } from './helpers/repo-root'

// ── The canvas stub ────────────────────────────────────────────────────────
//
// `createHud` needs a 2-D canvas and this suite is `environment: 'node'`, so
// the same shape `hud-redraw.test.ts` installs — with a fuller recorder. That
// one counts `clearRect` and `fillText` because it is asking *did a repaint
// happen*; this one counts EVERY context method, because it is asking *how
// much did one repaint ask of the backend*, which is the quantity the
// per-upload-cost hypothesis is about. The texture behind it is a real
// `THREE.CanvasTexture` with this element as its image.

interface OpCount {
  /** Every context METHOD call. Property assignments are not calls. */
  total: number
  texts: number
  measures: number
}

/**
 * The stub, and it COUNTS — which is the whole of how `hudCanvasOps` is kept
 * honest.
 *
 * `hudCanvasOps` mirrors `draw()` branch for branch and is therefore exactly
 * the kind of prediction that drifts from the thing it predicts. So the suite
 * drives the REAL `draw()` through this and asserts the prediction matched.
 * CLAUDE.md trap 24, applied to a function whose whole job is to agree with
 * another one: the expectation is a measurement of the code, not a second
 * reading of it.
 */
const installCanvas = (): OpCount => {
  const ops: OpCount = { total: 0, texts: 0, measures: 0 }
  const call = () => {
    ops.total += 1
  }
  const context = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    clearRect: call,
    fillRect: call,
    beginPath: call,
    roundRect: call,
    fill: call,
    stroke: call,
    fillText: () => {
      ops.total += 1
      ops.texts += 1
    },
    // A width proportional to the string, so any layout dividing by it cannot
    // produce a NaN and take a test down for the wrong reason.
    measureText: (s: string) => {
      ops.total += 1
      ops.measures += 1
      return { width: s.length * 8 }
    },
  }
  const element = { width: 0, height: 0, getContext: () => context }
  vi.stubGlobal('document', { createElement: () => element })
  return ops
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

/** The texture behind a panel, typed, so the assertions read as themselves. */
const textureOf = (hud: Hud): THREE.Texture => {
  const mesh = hud.object as THREE.Mesh
  const material = mesh.material as THREE.MeshBasicMaterial
  const map = material.map
  if (!map) throw new Error('hud-upload: the panel has no map')
  return map
}

/** A mid-run panel, so `update()` has something to draw. */
const state = (over: Partial<HudState> = {}): HudState => ({
  ringsPassed: 7,
  ringsTotal: 21,
  score: 700,
  elapsed: 42.3,
  timeLimit: 180,
  speed: 170,
  medal: '',
  finished: false,
  countLabel: 'GATES',
  timeLabel: 'TIME',
  speedLabel: 'SPEED',
  banner: null,
  autopilot: true,
  ...over,
})

// ───────────────────────────────────────────────────────────────────────────

describe('parseHudUpload — and the alias it must REFUSE', () => {
  it('reads every spelling a shell command plausibly carries', () => {
    for (const raw of ['mip', 'MIP', ' mips ', 'mipmap', 'mipmaps', 'Mip-Maps']) {
      expect(parseHudUpload(raw), raw).toEqual({ kind: 'mip' })
    }
    for (const raw of ['nomip', 'NOMIP', ' no-mip ', 'no_mips', 'nomipmaps', 'noChain']) {
      expect(parseHudUpload(raw), raw).toEqual({ kind: 'nomip' })
    }
  })

  it('round-trips through describeHudUpload, which is what makes the e2e check comparable', () => {
    // The mechanism check compares an ASK against a READING by string. If any
    // accepted spelling failed to land on its canonical token the arm would
    // refuse itself on a spelling — DEV-243's `10` / `10hz` lesson, in the
    // shape it takes here.
    for (const raw of ['mip', 'mipmaps', 'nomip', 'no-mips', 'NOCHAIN']) {
      const parsed = parseHudUpload(raw)
      expect(parsed, raw).not.toBeNull()
      const spelled = describeHudUpload(parsed as NonNullable<typeof parsed>)
      expect(parseHudUpload(spelled), `${raw} -> ${spelled}`).toEqual(parsed)
      expect(['mip', 'nomip']).toContain(spelled)
    }
  })

  it('REFUSES on/off/live/freeze by name — one word, two pins, opposite meanings', () => {
    // This is the deliberate half. `?hudRedraw=off` means a FREEZE: no repaints
    // at all. `?hudUpload=off` would read to a person as "no uploads" and to a
    // lenient parser as "the optimisation is off", i.e. the SHIPPED path — the
    // two readings are opposites, on two pins of one panel, and the mistake
    // would be invisible in a trace because both produce a plausible number.
    //
    // Asserted by NAME rather than left to fall out of "not in the list", so
    // that adding the alias later as a kindness turns this red and sends the
    // reader here.
    for (const raw of ['on', 'off', 'live', 'freeze', '0', '1', 'true', 'false']) {
      expect(parseHudUpload(raw), `'${raw}' must not be an alias of either mode`).toBeNull()
    }
  })

  it('returns null rather than throwing for nothing and for nonsense', () => {
    for (const raw of [null, undefined, '', '   ', 'linear', 'anisotropy', '4x']) {
      expect(parseHudUpload(raw), String(raw)).toBeNull()
    }
  })
})

describe('the byte accounting — what nomip removes, and what it does not', () => {
  /**
   * Two algorithms, one answer. `mipChainLevels` halves; three's own
   * `getMipLevels` (`three.module.js:11301`) is the closed form
   * `Math.log2(max(w, h)) + 1`, truncated to a `GLsizei` by WebIDL.
   *
   * CLAUDE.md trap 24: a test that re-derives its expectation the way the code
   * does has not tested the code. So the expectation here is the OTHER
   * algorithm, over sizes chosen to break a naive one — non-power-of-two, very
   * wide, and 1-pixel.
   */
  it('counts the same levels by halving as three counts by log2', () => {
    for (const [w, h] of [
      [560, 203], // the shipped panel
      [504, 336], // the perf plate
      [1, 1],
      [2, 1],
      [3, 3],
      [1024, 1024],
      [1025, 7],
      [4096, 1],
    ] as const) {
      const closedForm = Math.floor(Math.log2(Math.max(w, h))) + 1
      expect(mipChainLevels(w, h), `${w}x${h}`).toBe(closedForm)
    }
  })

  it('a 1x1 texture has one level and no chain', () => {
    expect(mipChainLevels(1, 1)).toBe(1)
    expect(mipChainBytes(1, 1)).toBe(0)
  })

  it('the chain is under a third of level 0, and converges towards it', () => {
    // The limit of a 2-D chain is 1/3 of the base, approached from below;
    // floor-halving on a non-square makes it a little less. This is the
    // relationship, not a value — a size-by-size table would just be the
    // implementation written twice.
    for (const [w, h] of [
      [560, 203],
      [504, 336],
      [1024, 1024],
      [256, 256],
    ] as const) {
      const base = w * h * BYTES_PER_TEXEL
      const ratio = mipChainBytes(w, h) / base
      expect(ratio, `${w}x${h}`).toBeGreaterThan(0.24)
      expect(ratio, `${w}x${h}`).toBeLessThan(1 / 3)
    }
  })

  it('the shipped panel: 454,720 B of level 0 and 150,332 B of chain', () => {
    // The two numbers the ledger row and the DEV-244 block both quote, written
    // down once so a change to `PIXELS_PER_METRE` or to the panel's size lands
    // here rather than in a stale comment.
    const [w, h] = [560, 203]
    expect(w * h * BYTES_PER_TEXEL).toBe(454_720)
    expect(mipChainBytes(w, h)).toBe(150_332)
    expect(mipChainLevels(w, h)).toBe(10)
    expect(hudUploadBytes(w, h, { kind: 'mip' })).toBe(605_052)
    // What `nomip` moves: level 0, and not one byte less.
    expect(hudUploadBytes(w, h, { kind: 'nomip' })).toBe(454_720)
    expect(
      hudUploadBytes(w, h, { kind: 'mip' }) - hudUploadBytes(w, h, { kind: 'nomip' }),
      'the saving is the CHAIN and nothing else — it is not a reduction in the upload',
    ).toBe(150_332)
  })
})

describe("three's own anisotropy rule, read out of three's own build", () => {
  /**
   * THE FINDING THIS ROW TURNS ON, and the reason it is read rather than
   * remembered.
   *
   * `setTextureParameters` returns before `texParameterf(
   * TEXTURE_MAX_ANISOTROPY_EXT, …)` unless the minification filter is one of
   * the two mipmap-LINEAR ones. So a `minFilter` of `LinearFilter` does not
   * merely lose the chain — it loses `anisotropy = 4` as well, silently, on a
   * panel raked at dz/dy 1.08 that a player reads while flying.
   *
   * Asserted against three's build rather than against a comment, because the
   * whole decision to set `anisotropy: 1` under `nomip` rests on it and
   * `three` is pinned exact but not pinned forever.
   */
  const guard = (): string => {
    const build = fs.readFileSync(
      path.join(ROOT, 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    const line = build
      .split('\n')
      .find((l) => l.includes('texture.minFilter !== NearestMipmapLinearFilter'))
    if (line === undefined) {
      throw new Error(
        'three no longer guards anisotropy on the minFilter — re-read ' +
          'setTextureParameters and DEV-244 §2 before touching hudTextureState',
      )
    }
    return line
  }

  it('three refuses anisotropy for any minFilter that is not mipmap-linear', () => {
    const line = guard()
    // The guard admits exactly two filters. Both named, so a third one
    // appearing is a change this test reports rather than absorbs.
    expect(line).toContain('NearestMipmapLinearFilter')
    expect(line).toContain('LinearMipmapLinearFilter')
    expect(line.trim().endsWith('return;')).toBe(true)
  })

  it("nomip's minFilter is one three refuses anisotropy for, so its anisotropy MUST be 1", () => {
    const line = guard()
    const admits = (filter: number): boolean =>
      (filter === THREE.NearestMipmapLinearFilter && line.includes('NearestMipmapLinearFilter')) ||
      (filter === THREE.LinearMipmapLinearFilter && line.includes('LinearMipmapLinearFilter'))

    const mip = hudTextureState(HUD_UPLOAD_MIP)
    const nomip = hudTextureState({ kind: 'nomip' })

    // The shipped mode is inside the rule, so its 4 reaches the sampler.
    expect(admits(mip.minFilter as number), 'the shipped minFilter must keep anisotropy').toBe(true)
    expect(mip.anisotropy).toBe(HUD_ANISOTROPY)

    // The arm is outside it, so a 4 there would be a number the GPU never sees
    // — CLAUDE.md's "a configured constant no code path reads is documentation,
    // not a guard", one layer down (DEV-069).
    expect(admits(nomip.minFilter as number), 'nomip is outside three’s rule').toBe(false)
    expect(
      nomip.anisotropy,
      'three will not call texParameterf for this minFilter, so a 4 here would be a lie',
    ).toBe(1)
  })
})

describe('the arm fires, and the probe reads the TEXTURE rather than the intent', () => {
  it('nomip reaches the texture, and mip puts it back exactly', () => {
    installCanvas()
    const hud = createHud()
    const texture = textureOf(hud)
    const shipped = {
      generateMipmaps: texture.generateMipmaps,
      minFilter: texture.minFilter,
      anisotropy: texture.anisotropy,
    }

    hud.setUpload({ kind: 'nomip' })
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.minFilter).toBe(THREE.LinearFilter)
    expect(texture.anisotropy).toBe(1)

    hud.setUpload(HUD_UPLOAD_MIP)
    expect(
      {
        generateMipmaps: texture.generateMipmaps,
        minFilter: texture.minFilter,
        anisotropy: texture.anisotropy,
      },
      'a flip back must restore all three fields — three hashes every one of them ' +
        'into the texture cache key, so a partial restore is a different texture',
    ).toEqual(shipped)
  })

  it('the report separates what was asked for from what the texture is doing', () => {
    installCanvas()
    const hud = createHud()
    hud.update(state())

    const before = hud.report()
    expect(before.upload).toBe('mip')
    expect(before.liveUpload).toBe('mip')
    expect(before.mipLevels).toBe(10)
    expect(before.mipBytes).toBe(150_332)
    expect(before.uploadBytes).toBe(before.bytes + before.mipBytes)

    hud.setUpload({ kind: 'nomip' })
    const after = hud.report()
    expect(after.upload).toBe('nomip')
    expect(after.liveUpload).toBe('nomip')
    expect(after.mipLevels).toBe(1)
    expect(after.mipBytes).toBe(0)
    expect(after.uploadBytes).toBe(after.bytes)
    // Level 0 does NOT move. This is the assertion that stops the row being
    // written up as "the upload got smaller".
    expect(after.bytes).toBe(before.bytes)
  })

  it('liveUpload goes NULL when something outside the module touches the texture', () => {
    // The whole reason `liveUpload` is classified rather than echoed. A probe
    // that reported the intent would say `mip` here and be wrong, and the
    // e2e mechanism check would pass a run measuring a texture nobody
    // configured.
    installCanvas()
    const hud = createHud()
    textureOf(hud).anisotropy = 2

    const r = hud.report()
    expect(r.upload).toBe('mip')
    expect(r.liveUpload).toBeNull()
    expect(
      classifyHudTexture({ generateMipmaps: true, minFilter: THREE.LinearFilter, anisotropy: 4 }),
    ).toBeNull()
  })

  it('switching the mode does not itself upload — the arm must not contaminate the count', () => {
    installCanvas()
    const hud = createHud()
    const texture = textureOf(hud)
    hud.update(state())
    const version = texture.version
    const repaints = hud.report().repaints

    hud.setUpload({ kind: 'nomip' })
    hud.setUpload(HUD_UPLOAD_MIP)
    hud.setUpload(HUD_UPLOAD_MIP)

    // `texture.version` is three's own counter (`Texture.needsUpdate`'s
    // setter), which is the oracle DEV-243 chose for exactly this kind of
    // claim. Changing filter state is not a new frame of pixels.
    expect(texture.version).toBe(version)
    expect(hud.report().repaints).toBe(repaints)
  })

  it('re-asserting the mode in force is a no-op, which is why the frame loop may call it', () => {
    // `boot/app.ts` calls `setUpload` every frame. Every field it writes is in
    // three's texture CACHE KEY (`three.module.js:11533`), so an unguarded
    // write would reallocate the whole `WebGLTexture` ninety times a second.
    // The observable half of "no-op" in node is that nothing on the texture
    // moves and no object identity changes.
    installCanvas()
    const hud = createHud()
    const texture = textureOf(hud)
    for (let i = 0; i < 90; i++) hud.setUpload(HUD_UPLOAD_MIP)
    expect(textureOf(hud)).toBe(texture)
    expect(texture.generateMipmaps).toBe(true)
    expect(texture.anisotropy).toBe(HUD_ANISOTROPY)
  })
})

describe('what one repaint asks of the canvas — and the hypothesis it kills', () => {
  /**
   * THE MEASUREMENT BEHIND THE PREDICTION.
   *
   * `hudCanvasOps` mirrors `draw()`, so it is checked against the real thing
   * through a counting canvas rather than trusted. Nine states, chosen to walk
   * every branch `draw()` has: the banner's early return, the bare panel, each
   * optional bar alone and together, the corner's three badges, and the event
   * line — which repaints the count row's plate and calls `drawCorner` and
   * `drawProximity` a SECOND time, the one place a naive count goes wrong.
   * (DEV-615 took the proximity meter off the panel; the gate combo's bar has
   * its count row now, with a track while a combo is live.)
   */
  const cases: [string, HudState][] = [
    ['the launch banner (early return)', state({ banner: 'press A' })],
    ['a bare panel', state()],
    ['+ a gate combo run out: the track alone', state({ chain: { stacks: 1, fraction: 0 } })],
    ['+ the boost tank', state({ energy: { fraction: 0.4, available: true } })],
    ['+ an empty tank', state({ energy: { fraction: 0, available: false } })],
    ['+ a speed chain', state({ chain: { stacks: 3, fraction: 0.6 } })],
    ['+ a multiplier and no autopilot', state({ multiplier: 4, autopilot: false })],
    [
      'the event line, which repaints the row and puts the corner back',
      state({ award: 'GOLD', multiplier: 2, chain: { stacks: 3, fraction: 0.6 } }),
    ],
    [
      'a finished run with no medal — draws nothing extra',
      state({ finished: true, medal: 'none' }),
    ],
  ]

  for (const [why, s] of cases) {
    it(`predicts the real draw: ${why}`, () => {
      const ops = installCanvas()
      const hud = createHud()
      hud.update(s)
      expect(hud.report().repaints, 'the state did not paint, so nothing was counted').toBe(1)
      expect({ total: ops.total, texts: ops.texts, measures: ops.measures }).toEqual(
        hudCanvasOps(s),
      )
      // And the panel reports the same numbers the counter saw.
      expect(hud.report().canvasOps).toEqual(hudCanvasOps(s))
    })
  }

  it('reports zeroes before the first repaint, which repaints:0 says as well', () => {
    installCanvas()
    const hud = createHud()
    const r = hud.report()
    expect(r.repaints).toBe(0)
    expect(r.canvasOps).toEqual({ total: 0, texts: 0, measures: 0 })
  })

  /**
   * THE PREDICTION, AND IT IS THE POINT OF THE WHOLE describe.
   *
   * Freezing this panel costs `int_01_hoverJet` ten times what it costs
   * `adv_02_jumpSeat` (Δp50 −2.13 against −0.21) for 2.4× the repaints, so
   * **~4.2× of it is per-upload cost.** One candidate is that an upload must
   * first resolve the 2-D backend's pending commands, in which case the cost
   * would track canvas operations per repaint.
   *
   * **This is the arithmetic that kills it, and it costs nothing to run.** A
   * HoverJet panel in flight and a JumpSeat one differ by a couple of calls in
   * the mid twenties — nothing like a factor of four. Asserted as a RATIO with
   * a generous bound rather than as two totals, because the exact totals depend
   * on which optional fields each mission has live, which is an assumption, and
   * the ratio is the quantity the hypothesis is about (DEV-027: say what the
   * number is the ratio OF).
   *
   * Note what is NOT the difference: the TIME row. `formatTime` returns `--`
   * where there is no clock and the row is still DRAWN, with a label and a
   * value, so DEV-201 buys an entry that never MOVES — a fact about the repaint
   * RATE, which DEV-243 already priced, and not about the work inside one.
   */
  it('a HoverJet repaint and a JumpSeat repaint cost about the same, so ops are NOT the 4.2x', () => {
    // `int_01_hoverJet`, Ring Attack, Anniversary, mid-flight under the
    // autopilot: a clock, the gate combo (the G1 meter until DEV-615, the
    // same two rects), the boost tank.
    const hoverJet = state({
      timeLimit: 180,
      timeCountsDown: true,
      chain: { stacks: 2, fraction: 0.5 },
      energy: { fraction: 0.7, available: true },
      autopilot: true,
    })
    // `adv_02_jumpSeat`, Target Practice: no clock (the row draws `--`), no
    // gate combo, and 2016's own fuel gauge, which is on BOTH presets.
    const jumpSeat = state({
      timeLimit: 0,
      countLabel: 'PADS',
      energy: { fraction: 0.7, available: true },
      autopilot: true,
    })

    const a = hudCanvasOps(hoverJet)
    const b = hudCanvasOps(jumpSeat)
    // The totals, written down, because these two are FACTS ABOUT THESE STATES
    // rather than about the missions — the states above are this test's model
    // of each cockpit and the assumption lives there, not here. Pinned so a
    // reader of the ledger row does not have to run the suite to see the
    // numbers, and so a change to the panel that moves either one lands here.
    // DEV-397 moved AUTO onto the time row, measured against the clock and its
    // label: one more read on each (25/23 before).
    // 27, not 26, since DEV-410's follow-up: the tank's BOOST word. Still
    // about the same as the JumpSeat, which is the point of this test.
    expect({ hoverJet: a.total, jumpSeat: b.total }).toEqual({ hoverJet: 27, jumpSeat: 25 })
    const ratio = a.total / b.total
    expect(
      ratio,
      `a HoverJet repaint is ${a.total} context calls and a JumpSeat one is ${b.total}, a ratio ` +
        `of ${ratio.toFixed(2)}. The per-upload cost ratio the freeze arms measured is ~4.2, so ` +
        'canvas work per repaint cannot be the mechanism unless this ratio is near it. If this ' +
        'assertion ever fails UPWARD, re-open the hypothesis — the panel has gained a branch ' +
        'that one vehicle takes and the other does not.',
    ).toBeLessThan(1.5)
    // Both vehicles draw all three rows. The one that would be a real
    // difference — a row present on one and absent on the other — is not there.
    expect(a.texts, 'the HoverJet draws six row strings plus its corner').toBeGreaterThanOrEqual(6)
    expect(b.texts, 'so does the JumpSeat: the TIME row is drawn as `--`').toBeGreaterThanOrEqual(6)
  })
})

describe('the shipped texture is untouched', () => {
  /**
   * THE REGRESSION GUARD, written to be true of the unfixed code.
   *
   * Before DEV-244 the panel's texture was a bare `CanvasTexture` with one line
   * of configuration on it — `texture.anisotropy = 4` — and everything else at
   * three's own constructor defaults. So the default mode is correct if and
   * only if it reproduces exactly that, and the expectation is taken from
   * three's constructor rather than written out, because a literal here would
   * be this test agreeing with `hudTextureState` about a number neither of
   * them got from anywhere.
   */
  it('mip is three’s own CanvasTexture defaults plus the one line that was there', () => {
    const stock = new THREE.CanvasTexture(undefined as unknown as HTMLCanvasElement)
    const mip = hudTextureState(HUD_UPLOAD_MIP)
    expect(mip.generateMipmaps).toBe(stock.generateMipmaps)
    expect(mip.minFilter).toBe(stock.minFilter)
    expect(mip.anisotropy).toBe(HUD_ANISOTROPY)
    expect(HUD_ANISOTROPY).toBe(4)
    stock.dispose()
  })

  it('an unpinned panel uploads exactly as it always did — at DEV-248’s cadence', () => {
    installCanvas()
    const hud = createHud()
    const texture = textureOf(hud)
    // The shipped state, asserted on the live object and not on the record.
    // **This half is untouched by DEV-248**: the budget changes how OFTEN the
    // texture is uploaded and nothing about what it is, which is exactly the
    // separation that makes `?hudRedraw=` and `?hudUpload=` two levers.
    expect(texture.generateMipmaps).toBe(true)
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter)
    expect(texture.anisotropy).toBe(4)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)

    // ── The cadence half, RESTATED for DEV-248 ─────────────────────────
    //
    // This used to read `repaints` 2 and `cadence` 'live', and it was written
    // as a cross-guard: a change to the UPLOAD lever must not quietly move
    // the REDRAW one. **Matt enabled the budget on 2026-09-20**, so the
    // expectation moves with the default rather than the guard being dropped
    // — and it is still the same cross-guard, now pointing at 10 Hz.
    //
    // Three frames at 11 ms apart is 22 ms, well inside the 100 ms interval,
    // so the first paints and the transition at frame 3 is withheld and owed.
    // `repaints` 2 here would mean the default had gone back to `live`.
    hud.update(state({ speed: 40.2 }), 0)
    hud.update(state({ speed: 40.4 }), 11) // rounds to 40 as well — not a transition
    hud.update(state({ speed: 41.6 }), 22)
    expect(hud.report().repaints).toBe(1)
    expect(hud.report().skipped).toBe(1)
    expect(hud.report().cadence).toBe(describeHudRedraw(HUD_REDRAW_DEFAULT))
    expect(hud.report().cadence).toBe('10hz')
    expect(hud.report().upload).toBe('mip')

    // And it is not lost: past the interval, the owed paint lands.
    hud.update(state({ speed: 41.6 }), 100)
    expect(hud.report().repaints).toBe(2)
  })

  it('the panel is still 560 x 203, which every byte figure above rests on', () => {
    installCanvas()
    const hud = createHud()
    const r = hud.report()
    expect(r.pixels).toEqual({ width: 560, height: 203 })
    expect(r.bytes).toBe(454_720)
  })
})
