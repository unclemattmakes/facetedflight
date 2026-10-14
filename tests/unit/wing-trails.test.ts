// tests/unit/wing-trails.test.ts — wing-tip trails at speed, on the player and
// the racers (DEV-358), and Classic draws none.
//
// **What this file can claim.** That the fade is nothing at rest and at half
// the HoverJet's unboosted terminal speed, whole AT that terminal speed (so a
// player who never boosts sees them — the follow-up's finding), rises and
// never falls between, and starts and ends with no corner; that both of its
// speeds come off the generated sheet; that the comfort slider's 0 is off and
// every other setting multiplies; that Classic's preset draws nothing at any
// speed or slider; that the forward speed is the sim's own; that the tip rule
// finds the trailing corner of a tip on a planform built by hand; that each
// craft's tint is mostly white and takes its livery's HUE and never its
// darkness (charcoal stays white); that the core is bright enough for the flat
// bloom at the default slider while the halo is not; and that a batch of
// several craft is ONE mesh, five vertices across, whose vapour is born at the
// strength of its moment, fades with age and near the eye, is never wider than
// its angle at the eye, holds on a frame with no time, is dropped on a
// teleport, and draws nothing when nothing is strong enough to see.
//
// **What it cannot claim.** Where the tips are on the SHIPPED hull — that is
// `hover-glow.test.ts`, which already guards the hull GLB — or that the trails
// READ. That is a burst of frames through an acceleration, and then Matt on a
// lap (the DEVIATIONS row has the frames).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { EditionWingTrails } from '@/content/edition-schema'
import { SPEED_FX_SCALE, speedFxScale } from '@/game/edition'
import {
  bodyForwardSpeed,
  hoverJetWingTrailFade,
  type TintSrgb,
  trailTint,
  wingTrailScale,
  wingTrailSpeedFactor,
  wingTrailStrength,
} from '@/game/wing-trail-fade'
import { createCraftWingTrails } from '@/game/wing-trails'
import { PROVENANCE } from '@/generated/constants.generated'
import { LIVERY_PANEL_SRGB, rgbToHsl } from '@/render/racer-livery'
import { srgbToLinear } from '@/render/unity-space'
import {
  createWingTrails,
  measureWingTips,
  WING_TRAIL_ACROSS,
  type WingTrailLook,
} from '@/render/wing-trails'
import { normalizeQ, quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const ANNIVERSARY = anniversary.fx.wingTrails as EditionWingTrails
const CLASSIC = classic.fx.wingTrails as EditionWingTrails
/** DEV-350's racer palette, sRGB, in racer order. */
const PALETTE = anniversary.render.racerLivery.palette as unknown as TintSrgb[]
/** The flat bloom's threshold: linear luminance, white = 1.0 (`render/bloom.ts`). */
const BLOOM_THRESHOLD = anniversary.render.bloom.threshold
const FADE = hoverJetWingTrailFade()

/** A sweep past the top of the envelope, fine enough that a step cannot hide. */
const sweep = (): number[] => Array.from({ length: 4501 }, (_, i) => i * 0.1)

describe('the fade: "a decent speed" is the speed the engine holds on its own', () => {
  it('is whole at the unboosted terminal speed, and nothing the boost factor below it', () => {
    // Against the sheet's KEYED entries, not the `DERIVED` object the module
    // reads, and not this module's arithmetic (trap 24).
    const value = (key: string) => (PROVENANCE[key] as { value: number }).value
    const cruise = value('derived.hoverjet.terminalSpeedCruise')
    const boost = value('derived.hoverjet.terminalSpeedBoost')
    expect(FADE.full).toBe(cruise)
    expect(FADE.from).toBeCloseTo((cruise * cruise) / boost, 9)
    // And the two numbers the preset note and the DEVIATIONS row quote.
    expect(FADE.from).toBeCloseTo(44.91, 2)
    expect(FADE.full).toBeCloseTo(89.81, 2)
  })

  it('draws WHOLE for a ship that never boosts: the follow-up finding', () => {
    // DEV-358 shipped the fade from cruise to full boost, so a player at the
    // unboosted terminal speed made no vapour at all. Whatever else changes,
    // a ship at its own cruising speed leaves a whole trail.
    const cruise = (PROVENANCE['derived.hoverjet.terminalSpeedCruise'] as { value: number }).value
    expect(wingTrailSpeedFactor(cruise, FADE)).toBe(1)
    expect(wingTrailStrength(cruise, FADE, ANNIVERSARY, 1)).toBe(1)
  })

  it('is nothing at rest and at half cruise, and whole at and above cruise', () => {
    for (const v of [0, 1, 30, 44.9, FADE.from]) expect(wingTrailSpeedFactor(v, FADE)).toBe(0)
    for (const v of [FADE.full, 90, 180, 240, 437.5, 1000])
      expect(wingTrailSpeedFactor(v, FADE)).toBe(1)
    // Backwards, and not a number, are no speed.
    expect(wingTrailSpeedFactor(-150, FADE)).toBe(0)
    expect(wingTrailSpeedFactor(Number.NaN, FADE)).toBe(0)
    expect(wingTrailSpeedFactor(Number.POSITIVE_INFINITY, FADE)).toBe(0)
  })

  it('rises and never falls, and is strictly between 0 and 1 inside the band', () => {
    let last = -1
    for (const v of sweep()) {
      const f = wingTrailSpeedFactor(v, FADE)
      expect(f, `at ${v} m/s`).toBeGreaterThanOrEqual(last)
      last = f
      if (v > FADE.from && v < FADE.full) {
        expect(f).toBeGreaterThan(0)
        expect(f).toBeLessThan(1)
      }
    }
    // Symmetric about the middle of the band: half halfway between cruise and full boost.
    expect(wingTrailSpeedFactor((FADE.from + FADE.full) / 2, FADE)).toBeCloseTo(0.5, 12)
  })

  it('has no corner at either end: crossing the cut in a corner begins it with no edge', () => {
    // The slope over the first and last metre per second of the band, against
    // the slope a straight ramp would have there. A straight line fails this
    // by its whole slope; a smoothstep's end slope is zero.
    const straight = 1 / (FADE.full - FADE.from)
    const start = wingTrailSpeedFactor(FADE.from + 1, FADE) - wingTrailSpeedFactor(FADE.from, FADE)
    const end = wingTrailSpeedFactor(FADE.full, FADE) - wingTrailSpeedFactor(FADE.full - 1, FADE)
    expect(start).toBeLessThan(straight / 10)
    expect(end).toBeLessThan(straight / 10)
    // And no STEP anywhere: 0.1 m/s never moves it more than a straight ramp's
    // 0.1 m/s would, times the smoothstep's peak slope of 1.5.
    let prev = 0
    for (const v of sweep()) {
      const f = wingTrailSpeedFactor(v, FADE)
      expect(f - prev, `step at ${v} m/s`).toBeLessThanOrEqual(1.5 * straight * 0.1 + 1e-12)
      prev = f
    }
  })

  it('degenerates to a step at the cut rather than running backwards', () => {
    const flat = { from: 150, full: 150 }
    expect(wingTrailSpeedFactor(149, flat)).toBe(0)
    expect(wingTrailSpeedFactor(150, flat)).toBe(0)
    expect(wingTrailSpeedFactor(150.001, flat)).toBe(1)
  })
})

describe('the comfort slider: 0 is off, everything else multiplies', () => {
  it('draws NOTHING at the slider 0, at every speed, with the flag on', () => {
    for (const v of sweep()) expect(wingTrailStrength(v, FADE, ANNIVERSARY, 0)).toBe(0)
    expect(wingTrailScale(ANNIVERSARY, 0)).toBe(0)
    expect(wingTrailScale(ANNIVERSARY, -1)).toBe(0)
    expect(wingTrailScale(ANNIVERSARY, Number.NaN)).toBe(0)
  })

  it('multiplies the strength by the slider: light is half of full at every speed', () => {
    const light = SPEED_FX_SCALE.light
    const full = SPEED_FX_SCALE.full
    expect(light).toBe(0.5)
    for (const v of sweep()) {
      const whole = wingTrailStrength(v, FADE, ANNIVERSARY, full)
      expect(whole).toBe(wingTrailSpeedFactor(v, FADE))
      expect(wingTrailStrength(v, FADE, ANNIVERSARY, light)).toBeCloseTo(whole * light, 12)
    }
    // Above 1 is clamped: nothing is ever drawn stronger than the preset.
    expect(wingTrailScale(ANNIVERSARY, 3)).toBe(1)
  })

  it('draws at the DEFAULT setting, which is light', () => {
    const scale = speedFxScale(DEFAULT_SETTINGS.speedFx)
    expect(scale).toBeGreaterThan(0)
    expect(wingTrailStrength(FADE.full, FADE, ANNIVERSARY, scale)).toBeGreaterThan(0)
  })
})

describe('the presets', () => {
  it('Classic draws nothing at any speed or slider, by the flag AND by its alpha', () => {
    expect(CLASSIC.enabled).toBe(false)
    expect(CLASSIC.alpha).toBe(0)
    for (const fx of [0, 0.5, 1]) {
      for (const v of sweep()) expect(wingTrailStrength(v, FADE, CLASSIC, fx)).toBe(0)
    }
  })

  it('Anniversary draws, lightly tinted and glowing, and the player sees his own from the seat', () => {
    expect(ANNIVERSARY.enabled).toBe(true)
    expect(ANNIVERSARY.alpha).toBeGreaterThan(0)
    expect(ANNIVERSARY.alpha).toBeLessThanOrEqual(1)
    // LIGHTLY: a hint of hue, well short of the livery itself.
    expect(ANNIVERSARY.tint).toBeGreaterThan(0)
    expect(ANNIVERSARY.tint).toBeLessThanOrEqual(0.5)
    expect(ANNIVERSARY.glow).toBeGreaterThan(1)
    // DEV-358 follow-up, Matt 2026-09-25: *"i wanna see the wing tip trails
    // from the cockpit."* Pinned by value, so turning it back off is an edit
    // somebody makes on purpose; `wing-trails.spec.ts`'s seat arm reads the
    // live batch from the cockpit.
    expect(ANNIVERSARY.fromCockpit).toBe(true)
    // The width cap is what keeps a ribbon 3 m from the eye a line from the
    // seat as it does from the chase camera: it must stay on.
    expect(ANNIVERSARY.maxWidthDeg).toBeGreaterThan(0)
    // Thin at the tip, and the vapour spreads: never a ribbon that narrows.
    expect(ANNIVERSARY.startWidth).toBeLessThan(ANNIVERSARY.endWidth)
  })
})

// ── The tint: the livery's hue, never its darkness ──────────────────────

const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}
/** Rec.709 luminance of a LINEAR triple — what the bloom pass thresholds. */
const luminance = (lin: readonly number[]): number =>
  0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number)
const linearOf = (s: readonly number[]): number[] => s.map((c) => srgbToLinear(c))
/** Every livery a trail is tinted toward: every palette colour and the player. */
const LIVERIES: readonly [string, TintSrgb][] = [
  ...PALETTE.map((c, i) => [`racer ${i}`, c] as [string, TintSrgb]),
  ['player', LIVERY_PANEL_SRGB],
]

describe('the tint: mostly white, with the livery hue and never its darkness', () => {
  it('is MOSTLY WHITE: no channel of any craft falls below 1 - tint', () => {
    for (const [who, livery] of LIVERIES) {
      const t = trailTint(livery, ANNIVERSARY.tint)
      for (const c of t) {
        expect(c, who).toBeGreaterThanOrEqual(1 - ANNIVERSARY.tint - 1e-12)
        expect(c, who).toBeLessThanOrEqual(1)
      }
      // And the brightest channel is white itself: the tint only ever takes
      // away from the others, so a trail is never dimmer than vapour.
      expect(Math.max(...t), who).toBe(1)
    }
  })

  it('keeps each livery HUE, so a racer trail leans toward its own colour', () => {
    for (const [who, livery] of LIVERIES) {
      const [h, s] = rgbToHsl(livery)
      if (s < 0.1) continue // a grey has no hue to keep; the next test is its
      const t = trailTint(livery, ANNIVERSARY.tint)
      const [th, ts] = rgbToHsl(t)
      expect(hueDistance(th, h), `${who} keeps its hue`).toBeLessThan(1)
      expect(ts, `${who} is visibly tinted`).toBeGreaterThan(0.2)
    }
    // The player's is the ORANGE, measured against DEV-350's panel hue.
    const [ph] = rgbToHsl(trailTint(LIVERY_PANEL_SRGB, ANNIVERSARY.tint))
    expect(hueDistance(ph, 25.2)).toBeLessThan(1)
  })

  it('leaves CHARCOAL white rather than smoke: a colour with no hue has nothing to give', () => {
    // DEV-350's charcoal, by value: the rainbow palette (its follow-up) has no
    // grey, and the law is the function's, not the palette's.
    const charcoal: TintSrgb = [0.15, 0.15, 0.15]
    expect(trailTint(charcoal, ANNIVERSARY.tint)).toEqual([1, 1, 1])
    // Darkness is never taken, at any amount: a near-black blue still comes
    // out as bright as a full blue does.
    const darkBlue: TintSrgb = [0.02, 0.04, 0.07]
    const fullBlue: TintSrgb = [0.2, 0.4, 0.7]
    expect(trailTint(darkBlue, 0.35)).toEqual(
      trailTint(fullBlue, 0.35).map((c) => expect.closeTo(c, 12)),
    )
  })

  it('is white at an amount of 0, and for a craft with no livery', () => {
    expect(trailTint(PALETTE[0] as TintSrgb, 0)).toEqual([1, 1, 1])
    expect(trailTint(null, ANNIVERSARY.tint)).toEqual([1, 1, 1])
    expect(trailTint(PALETTE[0] as TintSrgb, Number.NaN)).toEqual([1, 1, 1])
  })
})

// ── The glow: the core blooms on a monitor, the halo carries it in a headset ──

describe('the glow, against the flat bloom threshold', () => {
  const lightAlpha = ANNIVERSARY.alpha * speedFxScale(DEFAULT_SETTINGS.speedFx)

  it('puts the CORE above the bloom threshold over black, at the default slider, for every craft', () => {
    // What the composer's half-float target holds at the centre line: the HDR
    // colour at alpha a over a black background. Over anything brighter it is
    // brighter still, so black is the worst case.
    for (const [who, livery] of LIVERIES) {
      const core = linearOf(trailTint(livery, ANNIVERSARY.tint)).map((c) => c * ANNIVERSARY.glow)
      expect(lightAlpha * luminance(core), who).toBeGreaterThan(BLOOM_THRESHOLD)
    }
  })

  it('keeps the HALO below it: the halo is the soft part, not a second line', () => {
    for (const [who, livery] of LIVERIES) {
      const halo = linearOf(trailTint(livery, ANNIVERSARY.tint)).map(
        (c) => c * ANNIVERSARY.glow * ANNIVERSARY.halo,
      )
      expect(lightAlpha * luminance(halo), who).toBeLessThan(BLOOM_THRESHOLD)
    }
  })
})

describe('forward speed is the sim own, not a second opinion', () => {
  it('matches `rotateVec3` of the nose axis, dotted with the velocity, for any pose', () => {
    // The sim's own rotation, which `boot/app.ts`'s `forwardSpeedOf` uses.
    let seed = 7
    const rand = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 - 0.5
    }
    const axis = v3()
    for (let i = 0; i < 200; i++) {
      const q = normalizeQ(quat(), quat(rand(), rand(), rand(), rand()))
      const velocity = { x: rand() * 400, y: rand() * 400, z: rand() * 400 }
      rotateVec3(axis, q, v3(0, 0, 1))
      const expected = axis.x * velocity.x + axis.y * velocity.y + axis.z * velocity.z
      expect(bodyForwardSpeed({ orientation: q, velocity })).toBeCloseTo(expected, 9)
    }
  })

  it('is not the speed: sliding or falling at 200 m/s is no forward speed at all', () => {
    const level = quat()
    expect(bodyForwardSpeed({ orientation: level, velocity: { x: 0, y: 0, z: 150 } })).toBe(150)
    expect(bodyForwardSpeed({ orientation: level, velocity: { x: 200, y: 0, z: 0 } })).toBe(0)
    expect(bodyForwardSpeed({ orientation: level, velocity: { x: 0, y: -200, z: 0 } })).toBe(0)
  })
})

// ── The tips, on a planform built by hand ───────────────────────────────

/**
 * A swept wing, ship frame (x across, z aft, nose at -z), as one flat mesh:
 * a nose, two leading edges out to the TIPS at z = 1, a tip chord running aft
 * to the trailing corners at z = 2, and a trailing edge back in to the tail.
 * Plus a vertex INSIDE the outline, which the rule must never pick.
 */
const sweptWing = (): THREE.Mesh => {
  const outline = [
    [0, 0, -3], // nose
    [-3, 0.1, 1], // port tip, outermost
    [-2.8, 0.2, 2], // port trailing corner
    [0, 0, 4], // tail
    [2.8, 0.2, 2], // starboard trailing corner
    [3, 0.1, 1], // starboard tip, outermost
    [0, 0.5, 0], // inside the outline
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(outline.flat(), 3))
  g.setIndex([0, 1, 6, 1, 2, 6, 2, 3, 6, 3, 4, 6, 4, 5, 6, 5, 0, 6])
  return new THREE.Mesh(g)
}

describe('measureWingTips: the trailing corner of each tip, off the outline', () => {
  it('finds the aft end of each tip chord, not the outermost vertex', () => {
    const art = new THREE.Group()
    art.add(sweptWing())
    const { port, starboard } = measureWingTips(art)
    // Float32 positions: close, not equal.
    const near = (v: number) => expect.closeTo(v, 6)
    expect(port.toArray()).toEqual([near(-2.8), near(0.2), near(2)])
    expect(starboard.toArray()).toEqual([near(2.8), near(0.2), near(2)])
  })

  it("answers in the frame the art HANGS in, through the art's own transform", () => {
    // The consumers set the three ART_* lines on the art and ask in the ship
    // frame. A pure offset and a yaw of a quarter turn: the tips must move by
    // exactly that, whatever the art's parent is doing.
    const parent = new THREE.Group()
    parent.position.set(100, 50, -20)
    parent.rotation.set(0.3, 1.1, -0.2)
    const art = new THREE.Group()
    art.add(sweptWing())
    art.position.set(1, 2, 3)
    parent.add(art)
    const { port } = measureWingTips(art)
    expect(port.x).toBeCloseTo(-2.8 + 1, 6)
    expect(port.y).toBeCloseTo(0.2 + 2, 6)
    expect(port.z).toBeCloseTo(2 + 3, 6)
  })

  it('leaves from the tip itself when the tip is the aft-most corner of its side', () => {
    // A raked tip: nothing on the outline is aft of it on that side.
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, -3, -3, 0, 3, 0, 0, 2, 3, 0, 3], 3),
    )
    g.setIndex([0, 1, 2, 0, 2, 3])
    const art = new THREE.Group()
    art.add(new THREE.Mesh(g))
    const { port, starboard } = measureWingTips(art)
    expect(port.toArray()).toEqual([-3, 0, 3])
    expect(starboard.toArray()).toEqual([3, 0, 3])
  })

  it('refuses a hull with nothing to measure rather than trailing from the origin', () => {
    expect(() => measureWingTips(new THREE.Group())).toThrow(/no vertices/)
  })
})

// ── The batch: one mesh, vapour born at the strength of its moment ──────

const LOOK: WingTrailLook = {
  seconds: ANNIVERSARY.seconds,
  startWidth: ANNIVERSARY.startWidth,
  endWidth: ANNIVERSARY.endWidth,
  alpha: ANNIVERSARY.alpha,
  minVertexDistance: ANNIVERSARY.minVertexDistance,
  nearFade: ANNIVERSARY.nearFade,
  glow: ANNIVERSARY.glow,
  core: ANNIVERSARY.core,
  halo: ANNIVERSARY.halo,
  maxWidthDeg: ANNIVERSARY.maxWidthDeg,
}
const EYE = new THREE.Vector3(0, 30, 200)
const DT = 1 / 90
/** The CENTRE vertex of each point: the third of the five across. */
const CENTRE = 2

/** Fly `craft` ships along -z at `speed` for `frames`, each at its own strength. */
const fly = (
  trails: ReturnType<typeof createWingTrails>,
  strengths: readonly number[],
  frames: number,
  speed = 180,
  from = 0,
): void => {
  for (let f = from; f < from + frames; f++) {
    strengths.forEach((s, k) => {
      const z = -speed * DT * f
      trails.emit(
        k,
        new THREE.Vector3(k * 20 - 2.7, 0, z),
        new THREE.Vector3(k * 20 + 2.7, 0, z),
        s,
        DT,
        LOOK,
      )
    })
    trails.draw(EYE, LOOK)
  }
}

/** Every drawn vertex, in draw order: its index. */
const drawnVertices = (trails: ReturnType<typeof createWingTrails>): number[] => {
  const g = trails.object.geometry
  const index = g.index as THREE.BufferAttribute
  const seen = new Set<number>()
  for (let i = 0; i < g.drawRange.count; i++) seen.add(index.getX(i))
  return [...seen].sort((a, b) => a - b)
}

/** The CENTRE line's alpha at every drawn point, head first. */
const drawnAlphas = (trails: ReturnType<typeof createWingTrails>): number[] => {
  const colour = trails.object.geometry.getAttribute('color') as THREE.BufferAttribute
  return drawnVertices(trails)
    .filter((v) => v % WING_TRAIL_ACROSS === CENTRE)
    .map((v) => colour.getW(v))
}

describe('the batch: every craft in ONE draw', () => {
  it('is one mesh, one material, no groups, however many craft', () => {
    const trails = createWingTrails(5)
    fly(trails, [1, 1, 1, 1, 1], 60)
    expect(trails.object.isMesh).toBe(true)
    expect(Array.isArray(trails.object.material)).toBe(false)
    expect(trails.object.geometry.groups).toHaveLength(0)
    expect(trails.object.visible).toBe(true)
    expect(trails.stats.ribbons).toBe(10)
    expect(trails.stats.triangles).toBeGreaterThan(0)
    // Its colour carries ALPHA: four components, which is what makes three
    // read it (`vertexAlphas`), and a transparent material that writes no depth.
    expect(trails.object.geometry.getAttribute('color').itemSize).toBe(4)
    expect(trails.material.vertexColors).toBe(true)
    expect(trails.material.transparent).toBe(true)
    expect(trails.material.depthWrite).toBe(false)
    // Transparent AND double-sided is TWO draws in three unless forced to one:
    // `wing-trails.spec.ts` measured 4 calls for two batches without this.
    expect(trails.material.side).toBe(THREE.DoubleSide)
    expect(trails.material.forceSinglePass).toBe(true)
    // NORMAL blending: the fog's door mixes a colour toward the sky, and an
    // ADDITIVE ribbon mixed toward the sky would add the sky at distance.
    expect(trails.material.blending).toBe(THREE.NormalBlending)
    trails.dispose()
  })

  it('GLOWS: the centre is the HDR glow times the tint, the halo a fraction, the edges nothing', () => {
    const trails = createWingTrails(1)
    fly(trails, [1], 30)
    // The glow is the material colour, above 1: the HDR half the bloom catches.
    expect(trails.material.color.r).toBe(LOOK.glow)
    expect(trails.material.color.g).toBe(LOOK.glow)
    expect(trails.material.color.b).toBe(LOOK.glow)
    const colour = trails.object.geometry.getAttribute('color') as THREE.BufferAttribute
    const verts = drawnVertices(trails)
    expect(verts.length % WING_TRAIL_ACROSS, 'five vertices a point').toBe(0)
    for (let i = 0; i < verts.length; i += WING_TRAIL_ACROSS) {
      const at = (k: number) => verts[i + k] as number
      // The two edges are transparent: the halo falls to nothing.
      expect(colour.getW(at(0))).toBe(0)
      expect(colour.getW(at(4))).toBe(0)
      // The centre is the brightest, and the core's edges are `halo` of it.
      expect(colour.getX(at(CENTRE))).toBeCloseTo(1, 6)
      expect(colour.getX(at(1))).toBeCloseTo(LOOK.halo, 6)
      expect(colour.getX(at(3))).toBeCloseTo(LOOK.halo, 6)
      expect(colour.getW(at(1))).toBe(colour.getW(at(CENTRE)))
    }
    trails.dispose()
  })

  it('paints each craft its OWN tint, and leaves a craft it was not given white', () => {
    const trails = createWingTrails(2)
    trails.setTint(0, 0.2, 0.5, 1)
    fly(trails, [1, 1], 30)
    const colour = trails.object.geometry.getAttribute('color') as THREE.BufferAttribute
    const centres = drawnVertices(trails).filter((v) => v % WING_TRAIL_ACROSS === CENTRE)
    // Ribbons are laid out craft by craft, two each, so the first half of the
    // drawn centres are craft 0's and the second half craft 1's.
    const half = centres.length / 2
    const first = centres[0] as number
    const second = centres[half] as number
    expect([colour.getX(first), colour.getY(first), colour.getZ(first)]).toEqual([
      expect.closeTo(0.2, 6),
      expect.closeTo(0.5, 6),
      expect.closeTo(1, 6),
    ])
    expect([colour.getX(second), colour.getY(second), colour.getZ(second)]).toEqual([1, 1, 1])
    trails.dispose()
  })

  it('is NEVER wider than `maxWidthDeg` at the eye, and its world width where that is narrower', () => {
    const trails = createWingTrails(1)
    // Fly straight AT an eye just beside the line, so the ribbon runs from
    // far away to 1.5 m past the eye's shoulder.
    const eye = new THREE.Vector3(3, 1, -40)
    for (let f = 0; f < 30; f++) {
      const z = -180 * DT * f
      trails.emit(0, new THREE.Vector3(-2.7, 0, z), new THREE.Vector3(2.7, 0, z), 1, DT, LOOK)
    }
    trails.draw(eye, LOOK)
    const pos = trails.object.geometry.getAttribute('position') as THREE.BufferAttribute
    const verts = drawnVertices(trails)
    const capTan = Math.tan((LOOK.maxWidthDeg * Math.PI) / 360)
    let capped = 0
    let world = 0
    for (let i = 0; i < verts.length; i += WING_TRAIL_ACROSS) {
      const p = (k: number) => {
        const v = verts[i + k] as number
        return new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v))
      }
      const centre = p(CENTRE)
      const halfWidth = p(0).distanceTo(centre)
      const d = centre.distanceTo(eye)
      expect(halfWidth, `at ${d.toFixed(1)} m`).toBeLessThanOrEqual(d * capTan + 1e-6)
      if (halfWidth < LOOK.startWidth / 2 - 1e-6) capped++
      else world++
    }
    // The premise, both halves: some points were capped and some were not.
    expect(capped).toBeGreaterThan(0)
    expect(world).toBeGreaterThan(0)
    trails.dispose()
  })

  it('draws NOTHING, and is not even a draw, when nothing was born strong enough to see', () => {
    const trails = createWingTrails(3)
    fly(trails, [0, 0, 0], 60)
    expect(trails.object.visible).toBe(false)
    expect(trails.stats.triangles).toBe(0)
    // One craft at strength: only its two ribbons.
    fly(trails, [0, 0.8, 0], 60, 180, 60)
    expect(trails.object.visible).toBe(true)
    expect(trails.stats.ribbons).toBe(2)
    trails.dispose()
  })

  it('fades with age: brightest at the tip, at alpha x strength, and nothing at the tail', () => {
    const trails = createWingTrails(1)
    fly(trails, [0.6], 60)
    const alphas = drawnAlphas(trails)
    const peak = Math.max(...alphas)
    expect(peak).toBeCloseTo(LOOK.alpha * 0.6, 6)
    expect(trails.stats.peakAlpha).toBeCloseTo(LOOK.alpha * 0.6, 6)
    expect(Math.min(...alphas)).toBeLessThan(peak * 0.25)
    trails.dispose()
  })

  it('keeps the strength each point was born at: slowing stops the vapour, it does not erase it', () => {
    const trails = createWingTrails(1)
    fly(trails, [1], 20)
    fly(trails, [0], 3, 180, 20)
    // The head was born at nothing; the older points still carry theirs.
    expect(trails.object.visible).toBe(true)
    const alphas = drawnAlphas(trails)
    expect(alphas[0]).toBe(0)
    expect(Math.max(...alphas)).toBeGreaterThan(0)
    // And once they have aged out, nothing is left to draw.
    fly(trails, [0], Math.ceil(LOOK.seconds / DT) + 2, 180, 23)
    expect(trails.object.visible).toBe(false)
    trails.dispose()
  })

  it('drops the history on a teleport instead of drawing a streak across the map', () => {
    const trails = createWingTrails(1)
    fly(trails, [1], 30)
    // A respawn 2 km away in one frame.
    trails.emit(0, new THREE.Vector3(2000, 0, 0), new THREE.Vector3(2005.4, 0, 0), 1, DT, LOOK)
    trails.draw(EYE, LOOK)
    expect(trails.stats.triangles).toBe(0)
    trails.dispose()
  })

  it('fades out NEAR THE EYE, and only there: nothing at the eye, whole past `nearFade`', () => {
    // A long-lived ribbon, so age takes almost nothing off it, flown AWAY from
    // an eye standing where it began: its oldest points are beside the eye.
    // A 10 m fade (DEV-358's first value) so the band is wide enough to sample.
    const long = { ...LOOK, seconds: 10, nearFade: 10 }
    const eye = new THREE.Vector3(0, 0, 0)
    const alphasByDistance = (look: WingTrailLook) => {
      const trails = createWingTrails(1)
      for (let f = 0; f < 30; f++) {
        const z = -180 * DT * f
        trails.emit(0, new THREE.Vector3(-2.7, 0, z), new THREE.Vector3(2.7, 0, z), 1, DT, look)
      }
      trails.draw(eye, look)
      const g = trails.object.geometry
      const pos = g.getAttribute('position') as THREE.BufferAttribute
      const colour = g.getAttribute('color') as THREE.BufferAttribute
      const rows: { d: number; a: number }[] = []
      // The CENTRE line: the edges are transparent by design.
      for (const v of drawnVertices(trails)) {
        if (v % WING_TRAIL_ACROSS !== CENTRE) continue
        rows.push({ d: Math.hypot(pos.getX(v), pos.getY(v), pos.getZ(v)), a: colour.getW(v) })
      }
      trails.dispose()
      return rows
    }
    const faded = alphasByDistance(long)
    const near = faded.filter((r) => r.d < 3.5)
    const far = faded.filter((r) => r.d > long.nearFade)
    expect(near.length).toBeGreaterThan(0)
    expect(far.length).toBeGreaterThan(0)
    for (const r of near) expect(r.a, `at ${r.d.toFixed(1)} m`).toBeLessThan(0.3 * long.alpha)
    for (const r of far) expect(r.a, `at ${r.d.toFixed(1)} m`).toBeGreaterThan(0.9 * long.alpha)
    // And the fade is the cause: with none, the same points are whole.
    const unfaded = alphasByDistance({ ...long, nearFade: 0 })
    for (const r of unfaded.filter((q) => q.d < 3.5)) {
      expect(r.a, `unfaded at ${r.d.toFixed(1)} m`).toBeGreaterThan(0.9 * long.alpha)
    }
  })

  it('HOLDS on a frame with no time in it: a pause or a snap freezes the vapour, it does not age it', () => {
    const trails = createWingTrails(1)
    fly(trails, [1], 30)
    const before = trails.stats
    const positions = Array.from(trails.object.geometry.getAttribute('position').array)
    // A second of held frames: the sim is frozen, so the tip does not move.
    for (let f = 0; f < 90; f++) {
      const z = -180 * DT * 29
      trails.emit(0, new THREE.Vector3(-2.7, 0, z), new THREE.Vector3(2.7, 0, z), 1, 0, LOOK)
      trails.draw(EYE, LOOK)
    }
    expect(trails.stats).toEqual(before)
    expect(Array.from(trails.object.geometry.getAttribute('position').array)).toEqual(positions)
    trails.dispose()
  })

  it('clears one craft without touching its neighbour', () => {
    const trails = createWingTrails(2)
    fly(trails, [1, 1], 30)
    trails.clear(0)
    trails.draw(EYE, LOOK)
    expect(trails.stats.ribbons).toBe(2)
    trails.clear()
    trails.draw(EYE, LOOK)
    expect(trails.object.visible).toBe(false)
    trails.dispose()
  })
})

describe('craft: the preset and the slider switch the whole batch', () => {
  const craftAt = (speed: number, livery: TintSrgb | null = null) => {
    const frame = new THREE.Group()
    const body = { orientation: quat(), velocity: { x: 0, y: 0, z: speed } }
    const tips = { port: new THREE.Vector3(-2.7, 0, 2), starboard: new THREE.Vector3(2.7, 0, 2) }
    return { frame, body, tips, livery }
  }
  const run = (
    look: EditionWingTrails,
    speedFx: number,
    speed: number,
    shown = true,
    livery: TintSrgb | null = null,
  ) => {
    const c = craftAt(speed, livery)
    const trails = createCraftWingTrails([c], 'wing-trails:test')
    for (let f = 0; f < 40; f++) {
      c.frame.position.z = -speed * DT * f
      trails.update(EYE, DT, look, speedFx, shown)
    }
    const colour = trails.trails.object.geometry.getAttribute('color') as THREE.BufferAttribute
    const centre = drawnVertices(trails.trails).find((v) => v % WING_TRAIL_ACROSS === CENTRE)
    const out = {
      visible: trails.trails.object.visible,
      peak: trails.trails.stats.peakAlpha,
      centre:
        centre === undefined
          ? null
          : [colour.getX(centre), colour.getY(centre), colour.getZ(centre)],
    }
    trails.dispose()
    return out
  }

  it('draws at speed on Anniversary, at alpha x slider', () => {
    const r = run(ANNIVERSARY, 1, 200)
    expect(r.visible).toBe(true)
    expect(r.peak).toBeCloseTo(ANNIVERSARY.alpha, 6)
    expect(run(ANNIVERSARY, 0.5, 200).peak).toBeCloseTo(ANNIVERSARY.alpha * 0.5, 6)
  })

  it('draws WHOLE at cruise, unboosted: the player Matt could not see', () => {
    // The sheet's cruise, not `FADE.full`: a test that reads the speed off the
    // function it is testing agrees with that function whatever it says.
    const cruise = (PROVENANCE['derived.hoverjet.terminalSpeedCruise'] as { value: number }).value
    const r = run(ANNIVERSARY, 0.5, cruise)
    expect(r.visible).toBe(true)
    expect(r.peak).toBeCloseTo(ANNIVERSARY.alpha * 0.5, 6)
  })

  it("tints each craft toward its livery, in linear light: the player's orange", () => {
    const r = run(ANNIVERSARY, 1, 200, true, LIVERY_PANEL_SRGB)
    const want = linearOf(trailTint(LIVERY_PANEL_SRGB, ANNIVERSARY.tint))
    expect(r.centre).toEqual(want.map((c) => expect.closeTo(c, 6)))
    // And it is not white: the tint reached the vertices.
    expect(r.centre?.[2]).toBeLessThan(0.95)
  })

  it('draws nothing below half cruise, at the slider 0, on Classic, or when not shown', () => {
    expect(run(ANNIVERSARY, 1, 40).visible).toBe(false)
    expect(run(ANNIVERSARY, 0, 200).visible).toBe(false)
    expect(run(CLASSIC, 1, 200).visible).toBe(false)
    expect(run({ ...CLASSIC, enabled: true }, 1, 200).visible).toBe(false)
    expect(run(ANNIVERSARY, 1, 200, false).visible).toBe(false)
  })
})

describe('the batch uploads only what it wrote (DEV-919)', () => {
  it('marks the drawn prefix of each buffer, and less than the whole of any', () => {
    const trails = createWingTrails(5)
    fly(trails, [1, 1, 1, 1, 1], 60)
    const g = trails.object.geometry
    const index = g.getIndex() as THREE.BufferAttribute
    const position = g.getAttribute('position') as THREE.BufferAttribute
    const colour = g.getAttribute('color') as THREE.BufferAttribute
    // The vertices written are 0 .. the highest one the drawn indices reach.
    const written = Math.max(...drawnVertices(trails)) + 1
    expect(index.updateRanges).toEqual([{ start: 0, count: g.drawRange.count }])
    expect(position.updateRanges).toEqual([{ start: 0, count: written * 3 }])
    expect(colour.updateRanges).toEqual([{ start: 0, count: written * 4 }])
    // Sixty frames does not fill five craft's ribbons, so a whole-buffer upload
    // would not hide behind a range that happens to be the full length.
    expect(written * 3).toBeLessThan(position.array.length)
    expect(g.drawRange.count).toBeLessThan(index.array.length)
    trails.dispose()
  })
})
