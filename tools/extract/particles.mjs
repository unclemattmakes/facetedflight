// tools/extract/particles.mjs — Unity Shuriken, reduced to numbers FF2 can draw.
//
// PURE TRANSFORMER. It takes an already-parsed `ParticleSystem` document (and
// its `ParticleSystemRenderer`) and returns a compact spec. It reads no files,
// so `constants.mjs` stays the only thing that touches the Unity project and
// this stays unit-testable.
//
// ── What the 2016 game actually uses ──────────────────────────────────────
//
// Shuriken has 22 modules. Across the 25 particle systems on the shipped gate
// and the shipped ship, exactly ten are ever enabled:
//
//   InitialModule       25/25    ShapeModule          25/25
//   ColorModule         25/25    EmissionModule       24/25
//   SizeModule          21/25    RotationModule       21/25
//   VelocityModule      17/25    ForceModule          12/25
//   ClampVelocityModule  8/25    SizeBySpeedModule     3/25
//
// No sub-emitters, no collision, no trails, no noise, no UV animation, no
// inherited velocity. That is the entire surface FF2 has to reproduce, and it is
// why writing a particle engine for this game is a tractable job rather than a
// port of Shuriken.
//
// ── One material, and it is ours ──────────────────────────────────────────
//
// Every one of the 25 renders with `Materials/TriParticle.mat`: Unity's built-in
// `Particles/Additive` (shader fileID 200), tinted (0.868, 0.868, 0.868, 0.87),
// over `particles/tri_particle_64.tga` — a 64x64 white DOWNWARD TRIANGLE with an
// alpha matte, in Matt's own directory. First-party, 835 bytes as a PNG, and it
// is the whole look: the faceted world's particles are little triangles.
//
// Render mode is Billboard on 21 and Stretch on 4.
//
// ── MinMaxCurve, which is where a port goes wrong ─────────────────────────
//
// Every scalar in Shuriken is a `MinMaxCurve`: `{scalar, minCurve, maxCurve,
// minMaxState}`, and `scalar` is a MULTIPLIER, not the value.
//
//   state 0  Constant          value = scalar
//   state 1  Curve             value = scalar * maxCurve(t)
//   state 2  RandomBetweenCurves  value = scalar * lerp(minCurve(t), maxCurve(t), r)
//   state 3  RandomBetweenConstants value = scalar * lerp(minCurve[0], maxCurve[0], r)
//
// Reading `scalar` as the value gives you a system that is right whenever the
// state happens to be 0 and silently wrong otherwise — and state 3 is the common
// one. `ringBurst`'s lifetime is state 3 with scalar 1 over [0.1, 1]; its speed
// is state 3 with scalar **100** over [1, 1], i.e. 100 m/s.
//
// ── And the liveness walk, again ──────────────────────────────────────────
//
// A module carries its own `enabled`, and a DISABLED `EmissionModule` means the
// system plays and emits nothing. That is not hypothetical: it is the state of
// several systems on the shipped prefabs. `emits` on the output is the honest
// answer to "does this draw anything", and it is the field a caller should
// filter on rather than `playOnAwake`.

/** Unity `ParticleSystemShapeType`. */
export const SHAPE_TYPES = [
  'sphere',
  'sphereShell',
  'hemisphere',
  'hemisphereShell',
  'cone',
  'box',
  'mesh',
  'coneShell',
  'coneVolume',
  'coneVolumeShell',
  'circle',
  'circleEdge',
  'singleSidedEdge',
  'meshRenderer',
  'skinnedMeshRenderer',
]

/** Unity `ParticleSystemRenderMode`. */
export const RENDER_MODES = [
  'billboard',
  'stretch',
  'horizontalBillboard',
  'verticalBillboard',
  'mesh',
  'none',
]

/** Unity `ParticleSystemSimulationSpace` — `moveWithTransform`. */
export const SIMULATION_SPACE = ['world', 'local', 'custom']

const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

const round = (n, places = 6) => {
  if (!Number.isFinite(n)) return n
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** One `AnimationCurve` -> its keys. Hermite; evaluate, do not lerp. */
const curveKeys = (curve) =>
  (curve?.m_Curve ?? []).map((k) => ({
    time: round(num(k.time)),
    value: round(num(k.value)),
    inSlope: round(num(k.inSlope)),
    outSlope: round(num(k.outSlope)),
  }))

/**
 * A Shuriken `MinMaxCurve`.
 *
 * Returns `{mode, scalar, min, max, minCurve, maxCurve}` where `min`/`max` are
 * the constants for the two constant modes and the curves are kept for the two
 * curve modes. The consumer multiplies by `scalar` in every mode — that is what
 * Unity does, and forgetting it is worth a factor of 100 on a start speed.
 */
export const minMaxCurve = (m) => {
  const state = num(m?.minMaxState)
  const maxCurve = curveKeys(m?.maxCurve)
  const minCurve = curveKeys(m?.minCurve)
  return {
    mode: state,
    scalar: round(num(m?.scalar)),
    // For the constant modes Unity stores the two constants as the FIRST KEY of
    // each curve, which is why they are read from there rather than from a pair
    // of scalar fields that do not exist.
    min: round(num(minCurve[0]?.value)),
    max: round(num(maxCurve[0]?.value)),
    minCurve: state === 2 ? minCurve : null,
    maxCurve: state === 1 || state === 2 ? maxCurve : null,
  }
}

/** Unity packs gradient colours as a little-endian RGBA uint32. */
const unpackRgba = (packed) => {
  const v = num(packed) >>> 0
  return [
    round((v & 0xff) / 255),
    round(((v >>> 8) & 0xff) / 255),
    round(((v >>> 16) & 0xff) / 255),
    round(((v >>> 24) & 0xff) / 255),
  ]
}

/** One `Gradient` -> colour keys and alpha keys, both on 0..1 time. */
const gradientKeys = (g) => {
  if (!g) return null
  const colourCount = num(g.m_NumColorKeys, 2)
  const alphaCount = num(g.m_NumAlphaKeys, 2)
  const colours = []
  const alphas = []
  for (let i = 0; i < 8; i++) {
    const rgba = g[`key${i}`]?.rgba
    if (rgba === undefined) continue
    const [r, gg, b, a] = unpackRgba(rgba)
    // Unity stores key times as uint16 over 0..65535.
    if (i < colourCount) {
      colours.push({ time: round(num(g[`ctime${i}`]) / 65535), color: [r, gg, b] })
    }
    if (i < alphaCount) {
      alphas.push({ time: round(num(g[`atime${i}`]) / 65535), alpha: a })
    }
  }
  return { colours, alphas }
}

/**
 * A Shuriken `MinMaxGradient`.
 *
 * state 0 = one colour, 1 = one gradient, 2 = two colours, 3 = two gradients.
 * The single-colour modes still arrive as a gradient whose first key is the
 * colour, so the consumer can treat every mode as a gradient pair.
 */
export const minMaxGradient = (m) => ({
  mode: num(m?.minMaxState),
  max: gradientKeys(m?.maxGradient),
  min: gradientKeys(m?.minGradient),
})

const moduleEnabled = (m) => num(m?.enabled) === 1

/**
 * Emission, including the burst table.
 *
 * Unity 5.4 serialises bursts as four fixed slots — `time0..3`, `cnt0..3`,
 * `cntmax0..3` — with `m_BurstCount` saying how many are real. Reading all four
 * gives you phantom bursts at t=0; reading none gives you a gate that does not
 * flash when you fly through it.
 */
const emission = (m) => {
  if (!m) return null
  const count = num(m.m_BurstCount)
  const bursts = []
  for (let i = 0; i < Math.min(count, 4); i++) {
    bursts.push({
      time: round(num(m[`time${i}`])),
      min: num(m[`cnt${i}`]),
      max: num(m[`cntmax${i}`], num(m[`cnt${i}`])),
    })
  }
  return {
    enabled: moduleEnabled(m),
    /** 0 = per second, 1 = per distance travelled. */
    type: num(m.m_Type),
    rate: minMaxCurve(m.rate),
    bursts,
  }
}

const shape = (m) => {
  if (!m) return null
  return {
    enabled: moduleEnabled(m),
    type: SHAPE_TYPES[num(m.type)] ?? String(num(m.type)),
    radius: round(num(m.radius)),
    angleDeg: round(num(m.angle)),
    length: round(num(m.length)),
    box: [round(num(m.boxX)), round(num(m.boxY)), round(num(m.boxZ))],
    randomDirection: num(m.randomDirection) === 1,
  }
}

const axisCurves = (m, extra = {}) => {
  if (!m) return null
  return {
    enabled: moduleEnabled(m),
    x: minMaxCurve(m.x),
    y: minMaxCurve(m.y),
    z: minMaxCurve(m.z),
    inWorldSpace: num(m.inWorldSpace) === 1,
    ...extra,
  }
}

/**
 * Reduce one ParticleSystem (+ its renderer) to a spec.
 *
 * `data` is the parsed `ParticleSystem` document's body; `renderer` is the
 * parsed `ParticleSystemRenderer`'s. Both may be null-ish, which yields nulls
 * rather than throwing — an extractor that dies on a system nobody draws is
 * worse than one that records the gap.
 */
export const readParticleSystem = (data, renderer, { name = null, active = true } = {}) => {
  if (!data) return null
  const initial = data.InitialModule ?? null
  const em = emission(data.EmissionModule)

  return {
    name,
    /** The GameObject's own `m_IsActive`. */
    active,
    lengthSeconds: round(num(data.lengthInSec)),
    looping: num(data.looping) === 1,
    prewarm: num(data.prewarm) === 1,
    playOnAwake: num(data.playOnAwake) === 1,
    /** Simulation speed multiplier, NOT a particle speed. */
    simulationSpeed: round(num(data.speed, 1)),
    /** `moveWithTransform`: 0 = world, 1 = local. */
    simulationSpace: SIMULATION_SPACE[num(data.moveWithTransform)] ?? 'local',
    scalingMode: num(data.scalingMode),
    randomSeed: num(data.randomSeed),
    startDelay: minMaxCurve(data.startDelay),

    initial: initial && {
      enabled: moduleEnabled(initial),
      lifetime: minMaxCurve(initial.startLifetime),
      speed: minMaxCurve(initial.startSpeed),
      size: minMaxCurve(initial.startSize),
      rotationDeg: minMaxCurve(initial.startRotation),
      colour: minMaxGradient(initial.startColor),
      gravityModifier: round(num(initial.gravityModifier)),
      maxParticles: num(initial.maxNumParticles, 1000),
    },

    emission: em,
    shape: shape(data.ShapeModule),

    /** Size over lifetime. */
    sizeOverLifetime: data.SizeModule
      ? { enabled: moduleEnabled(data.SizeModule), curve: minMaxCurve(data.SizeModule.curve) }
      : null,
    /** Angular velocity over lifetime, DEGREES per second in Unity. */
    rotationOverLifetime: data.RotationModule
      ? {
          enabled: moduleEnabled(data.RotationModule),
          curve: minMaxCurve(data.RotationModule.curve),
        }
      : null,
    /** Colour over lifetime, multiplied onto the start colour. */
    colourOverLifetime: data.ColorModule
      ? {
          enabled: moduleEnabled(data.ColorModule),
          gradient: minMaxGradient(data.ColorModule.gradient),
        }
      : null,

    velocityOverLifetime: axisCurves(data.VelocityModule),
    force: axisCurves(data.ForceModule, {
      randomizePerFrame: num(data.ForceModule?.randomizePerFrame) === 1,
    }),
    clampVelocity: data.ClampVelocityModule
      ? {
          enabled: moduleEnabled(data.ClampVelocityModule),
          magnitude: minMaxCurve(data.ClampVelocityModule.magnitude),
          dampen: round(num(data.ClampVelocityModule.dampen)),
          separateAxis: num(data.ClampVelocityModule.separateAxis) === 1,
        }
      : null,
    sizeBySpeed: data.SizeBySpeedModule
      ? {
          enabled: moduleEnabled(data.SizeBySpeedModule),
          curve: minMaxCurve(data.SizeBySpeedModule.curve),
          range: [
            round(num(data.SizeBySpeedModule.range?.x)),
            round(num(data.SizeBySpeedModule.range?.y)),
          ],
        }
      : null,

    renderer: renderer && {
      mode: RENDER_MODES[num(renderer.m_RenderMode)] ?? String(num(renderer.m_RenderMode)),
      /** Stretch mode only. */
      velocityScale: round(num(renderer.m_VelocityScale)),
      lengthScale: round(num(renderer.m_LengthScale, 1)),
      cameraVelocityScale: round(num(renderer.m_CameraVelocityScale)),
      maxParticleSize: round(num(renderer.m_MaxParticleSize, 0.5)),
      sortMode: num(renderer.m_SortMode),
      sortingOrder: num(renderer.m_SortingOrder),
    },

    // ── The field a caller should actually filter on ────────────────────
    //
    // A system with a DISABLED EmissionModule plays and draws nothing, and
    // several of the shipped ones are exactly that. `playOnAwake` does not tell
    // you this and neither does the GameObject being active.
    emits:
      active &&
      Boolean(em?.enabled) &&
      (em.bursts.length > 0 || em.rate.scalar > 0 || em.rate.max > 0),
  }
}
