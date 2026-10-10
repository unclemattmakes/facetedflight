/**
 * tests/e2e/fixtures/program-key.ts — read a `WebGLProgram.cacheKey` back.
 *
 * ── Why a decoder and not a hash ─────────────────────────────────────────
 *
 * `tests/e2e/inflight-compile.spec.ts` (DEV-194) diffs the live program set
 * across a flight and prints the new key. That was enough to fix DEV-194
 * because the key was diffed BY HAND, field by field, against its nearest warm
 * neighbour — the row says so — and by hand is the part that does not scale to
 * a gate somebody else reads at 2 a.m. A 300-character comma-joined string
 * names its variant precisely and names it to nobody.
 *
 * So this parses it. `WebGLPrograms.getProgramCacheKey` builds the string as
 *
 *     shaderID  (or customVertexShaderID, customFragmentShaderID)
 *     (name, value) for every entry of `material.defines`, IN INSERTION ORDER
 *     48 parameters, `precision` first and `depthPacking` last
 *     two `_programLayers` bit masks
 *     `renderer.outputColorSpace`
 *     `customProgramCacheKey()`
 *
 * joined with `,`. Everything after the defines is a FIXED 52 fields, which is
 * what makes the parse possible at all: the defines are the only variable-length
 * run and they are bracketed by the shader id on the left and `precision` on
 * the right.
 *
 * ── The oracle is three's own build (DEV-141's rule) ─────────────────────
 *
 * Those field lists and bit positions are three's PRIVATE ordering, not API,
 * and the `three` pin will move. `tests/unit/program-key.test.ts` extracts both
 * lists and the shader-id table out of `node_modules/three/build/three.module.js`
 * and fails if this file's copy has drifted — the same arrangement as
 * `tests/unit/xr-eye-layers.test.ts` and `tests/unit/water-fog-flag.test.ts`,
 * and for the same reason: *a test that compares two of your own devices has
 * not tested either of them.*
 *
 * ── The one thing it cannot do ───────────────────────────────────────────
 *
 * `array.join()` with a `,` separator is not escaped, so a define VALUE or a
 * `customProgramCacheKey` token containing a comma would split across fields.
 * Every define in `src/` is valueless (`defines[K] = ''`) and every
 * `tagProgramCacheKey` token is a bare identifier, so that case does not arise
 * here — but the parse does not pretend otherwise: it reports its anchor as
 * `ambiguous` when more than one position satisfies every check, rather than
 * picking one and sounding certain.
 */

/**
 * `getProgramCacheKeyParameters`, in push order. 48 entries.
 *
 * Kept as a list rather than a count because the decoded object is keyed by
 * these names, and a count alone would let two of them swap places silently.
 */
export const PARAMETER_FIELDS = [
  'precision',
  'outputColorSpace',
  'envMapMode',
  'envMapCubeUVHeight',
  'mapUv',
  'alphaMapUv',
  'lightMapUv',
  'aoMapUv',
  'bumpMapUv',
  'normalMapUv',
  'displacementMapUv',
  'emissiveMapUv',
  'metalnessMapUv',
  'roughnessMapUv',
  'anisotropyMapUv',
  'clearcoatMapUv',
  'clearcoatNormalMapUv',
  'clearcoatRoughnessMapUv',
  'iridescenceMapUv',
  'iridescenceThicknessMapUv',
  'sheenColorMapUv',
  'sheenRoughnessMapUv',
  'specularMapUv',
  'specularColorMapUv',
  'specularIntensityMapUv',
  'transmissionMapUv',
  'thicknessMapUv',
  'combine',
  'fogExp2',
  'sizeAttenuation',
  'morphTargetsCount',
  'morphAttributeCount',
  'numDirLights',
  'numPointLights',
  'numSpotLights',
  'numSpotLightMaps',
  'numHemiLights',
  'numRectAreaLights',
  'numDirLightShadows',
  'numPointLightShadows',
  'numSpotLightShadows',
  'numSpotLightShadowsWithMaps',
  'numLightProbes',
  'shadowMapType',
  'toneMapping',
  'numClippingPlanes',
  'numClipIntersection',
  'depthPacking',
] as const

/** `getProgramCacheKeyBooleans`, first mask, bit 0 upward. */
export const MASK_A_BITS = [
  'instancing',
  'instancingColor',
  'instancingMorph',
  'matcap',
  'envMap',
  'normalMapObjectSpace',
  'normalMapTangentSpace',
  'clearcoat',
  'iridescence',
  'alphaTest',
  'vertexColors',
  'vertexAlphas',
  'vertexUv1s',
  'vertexUv2s',
  'vertexUv3s',
  'vertexTangents',
  'anisotropy',
  'alphaHash',
  'batching',
  'dispersion',
  'batchingColor',
  'gradientMap',
  'packedNormalMap',
  'vertexNormals',
] as const

/**
 * The second mask, bit 0 upward.
 *
 * Bits 0 and 1 are DEV-194's pair — `fog` is the SCENE's and `useFog` is the
 * MATERIAL's, and three emits `#define USE_FOG` only for the conjunction, so a
 * key that differs here alone compiles textually identical GLSL. The decoder
 * says so in `describeProgramKey` rather than leaving a reader to remember it.
 */
export const MASK_B_BITS = [
  'fog',
  'useFog',
  'flatShading',
  'logarithmicDepthBuffer',
  'reversedDepthBuffer',
  'skinning',
  'morphTargets',
  'morphNormals',
  'morphColors',
  'premultipliedAlpha',
  'shadowMapEnabled',
  'doubleSided',
  'flipSided',
  'useDepthPacking',
  'dithering',
  'transmission',
  'sheen',
  'opaque',
  'pointsUvs',
  'decodeVideoTexture',
  'decodeVideoTextureEmissive',
  'alphaToCoverage',
  'numLightProbeGrids',
  'hasPositionAttribute',
] as const

/** Three's own `shaderIDs` values, deduplicated. The first field of a built-in key. */
export const SHADER_IDS = [
  'depth',
  'distance',
  'normal',
  'basic',
  'lambert',
  'phong',
  'toon',
  'physical',
  'matcap',
  'dashed',
  'points',
  'shadow',
  'sprite',
] as const

/** `WebGLRenderer.precision` — the anchor the parse hangs on. */
const PRECISIONS: readonly string[] = ['highp', 'mediump', 'lowp']

/**
 * The colour-space strings three can put in either colour-space slot, `''`
 * being `NoColorSpace`. A second, independent check on the anchor.
 */
const COLOR_SPACES: readonly string[] = [
  '',
  'srgb',
  'srgb-linear',
  'linear',
  'display-p3',
  'display-p3-linear',
]

/** How many fields follow `precision`'s slot, inclusive of it. */
export const TRAILING_FIELDS = PARAMETER_FIELDS.length + 2 + 1 + 1

export interface KeyDefine {
  readonly name: string
  readonly value: string
}

export interface DecodedProgramKey {
  /** The key, verbatim. */
  readonly key: string
  /** Whether an anchor was found at all. Everything below is empty when false. */
  readonly ok: boolean
  /** More than one position satisfied every check — see the header. */
  readonly ambiguous: boolean
  /**
   * A `RawShaderMaterial`: three hashes the two shader ids, the defines and the
   * tag, and NOTHING else. `parameters` and `flags` are empty because the key
   * genuinely does not carry them, which is different from failing to read them.
   */
  readonly raw: boolean
  /** `'physical'`, `'depth'`, … or null for a `ShaderMaterial`. */
  readonly shaderId: string | null
  /** The two custom shader ids, for a `ShaderMaterial`; null otherwise. */
  readonly customShaderIds: readonly [string, string] | null
  /** `material.defines`, IN INSERTION ORDER — which is what three hashes. */
  readonly defines: readonly KeyDefine[]
  /** The 48 parameters, by name. */
  readonly parameters: Readonly<Record<string, string>>
  /** The set bits of both masks, named. */
  readonly flags: readonly string[]
  /** `renderer.outputColorSpace`, the second-to-last field. */
  readonly rendererColorSpace: string
  /** `customProgramCacheKey()` — this project's `tagProgramCacheKey` chain. */
  readonly tag: string
}

const EMPTY: Omit<DecodedProgramKey, 'key'> = {
  ok: false,
  ambiguous: false,
  raw: false,
  shaderId: null,
  customShaderIds: null,
  defines: [],
  parameters: {},
  flags: [],
  rendererColorSpace: '',
  tag: '',
}

/**
 * A `RawShaderMaterial`'s key, which has no anchor because three skips the
 * whole block: `if ( parameters.isRawShaderMaterial === false )` guards the 48
 * parameters, both masks and `renderer.outputColorSpace`, so what is left is
 * two custom shader ids, the defines, and the tag — an ODD number of fields.
 *
 * Found by running the gate: `10,11,SRGB_TRANSFER,,ACES_FILMIC_TONE_MAPPING,,
 * onBeforeCompile() {}` is three's own output pass, one key in 148, and
 * `ok: false` on it would have put `UNPARSED` beside a program that is
 * perfectly readable. Returns `{}` — leaving `EMPTY`'s `ok: false` — for
 * anything that is not that shape, because guessing here is worse than saying
 * nothing.
 */
const rawShaderKey = (fields: readonly string[]): Partial<DecodedProgramKey> => {
  if (fields.length < 3 || fields.length % 2 === 0) return {}
  const [vertexId, fragmentId] = fields as unknown as [string, string]
  if (!/^\d+$/.test(vertexId) || !/^\d+$/.test(fragmentId)) return {}
  const defines: KeyDefine[] = []
  for (let i = 2; i < fields.length - 1; i += 2)
    defines.push({ name: fields[i] as string, value: fields[i + 1] as string })
  return {
    ok: true,
    raw: true,
    customShaderIds: [vertexId, fragmentId],
    defines,
    tag: fields[fields.length - 1] as string,
  }
}

const namedBits = (mask: number, bits: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < bits.length; i++) if ((mask & (1 << i)) !== 0) out.push(bits[i] as string)
  return out
}

/**
 * Parse one `WebGLProgram.cacheKey`.
 *
 * Never throws: a key it cannot read comes back `ok: false` with the raw string
 * still on it, because a gate that dies on an unfamiliar key has replaced a
 * finding with a stack trace.
 */
export const decodeProgramCacheKey = (key: string): DecodedProgramKey => {
  const fields = key.split(',')
  const lead = SHADER_IDS.includes(fields[0] as (typeof SHADER_IDS)[number]) ? 1 : 2
  // ── find `precision` ──────────────────────────────────────────────────
  //
  // Four checks, every one of them independent of what we believe the material
  // is: the offset from the shader id must be EVEN (defines come in pairs),
  // the field must be a precision, the two mask slots must be integers, and
  // the renderer's colour space must be a colour space. Anything that passes
  // all four at two different offsets is reported rather than resolved.
  const anchors: number[] = []
  for (let p = lead; p + TRAILING_FIELDS <= fields.length; p++) {
    if ((p - lead) % 2 !== 0) continue
    if (!PRECISIONS.includes(fields[p] as string)) continue
    if (!COLOR_SPACES.includes(fields[p + 1] as string)) continue
    const maskA = fields[p + PARAMETER_FIELDS.length] as string
    const maskB = fields[p + PARAMETER_FIELDS.length + 1] as string
    const rendererCs = fields[p + PARAMETER_FIELDS.length + 2] as string
    if (!/^\d+$/.test(maskA) || !/^\d+$/.test(maskB)) continue
    if (!COLOR_SPACES.includes(rendererCs)) continue
    anchors.push(p)
  }
  const p = anchors[0]
  if (p === undefined) return { key, ...EMPTY, ...rawShaderKey(fields) }

  const defines: KeyDefine[] = []
  for (let i = lead; i < p; i += 2)
    defines.push({ name: fields[i] as string, value: fields[i + 1] as string })

  const parameters: Record<string, string> = {}
  for (let i = 0; i < PARAMETER_FIELDS.length; i++)
    parameters[PARAMETER_FIELDS[i] as string] = fields[p + i] as string

  const maskA = Number(fields[p + PARAMETER_FIELDS.length])
  const maskB = Number(fields[p + PARAMETER_FIELDS.length + 1])

  return {
    key,
    ok: true,
    ambiguous: anchors.length > 1,
    raw: false,
    shaderId: lead === 1 ? (fields[0] as string) : null,
    customShaderIds: lead === 2 ? [fields[0] as string, fields[1] as string] : null,
    defines,
    parameters,
    flags: [...namedBits(maskA, MASK_A_BITS), ...namedBits(maskB, MASK_B_BITS)],
    rendererColorSpace: fields[p + PARAMETER_FIELDS.length + 2] as string,
    tag: fields.slice(p + PARAMETER_FIELDS.length + 3).join(','),
  }
}

/**
 * The flags worth printing on a one-line name. The rest of the 48 are `0` on
 * every material this game draws and would bury the three that move.
 */
const NOTABLE_FLAGS: readonly string[] = [
  'instancing',
  'batching',
  'vertexColors',
  'vertexAlphas',
  'flatShading',
  'shadowMapEnabled',
  'doubleSided',
  'flipSided',
  'useDepthPacking',
  'alphaTest',
  'alphaToCoverage',
  'envMap',
  'useFog',
  'fog',
]

/**
 * One line that NAMES the variant: the shader, this project's own patch tags,
 * the defines in order, the light counts and the colour space.
 *
 * The tag is first among the FF2-specific parts on purpose — `tagProgramCacheKey`
 * is the one field the port writes itself, so it is the field that says which
 * module to open.
 */
export const describeProgramKey = (d: DecodedProgramKey): string => {
  if (!d.ok) return `UNPARSED (${d.key.split(',').length} fields)`
  const what = d.shaderId ?? `shader(${(d.customShaderIds ?? ['?', '?']).join('+')})`
  const tag = d.tag.replace(/^\|/, '') || '(untagged)'
  const defines = d.defines.length === 0 ? '(no defines)' : d.defines.map((x) => x.name).join('+')
  // A raw material's key carries no parameters and no masks at all, so the rest
  // of this line would be a row of `?` claiming to be a reading.
  if (d.raw) return [`RAW ${what}`, tag, defines].join(' · ')
  const lights =
    `dir ${d.parameters.numDirLights ?? '?'}` +
    `/pt ${d.parameters.numPointLights ?? '?'}` +
    `/spot ${d.parameters.numSpotLights ?? '?'}` +
    `/hemi ${d.parameters.numHemiLights ?? '?'}` +
    `/probe ${d.parameters.numLightProbes ?? '?'}`
  const shadows =
    `dirShadow ${d.parameters.numDirLightShadows ?? '?'}` +
    `/ptShadow ${d.parameters.numPointLightShadows ?? '?'}`
  const flags = d.flags.filter((f) => NOTABLE_FLAGS.includes(f))
  return [
    what,
    tag,
    defines,
    lights,
    shadows,
    `out ${d.rendererColorSpace || 'none'}`,
    `tone ${d.parameters.toneMapping ?? '?'}`,
    flags.length > 0 ? flags.join('+') : 'no flags',
    d.ambiguous ? 'ANCHOR AMBIGUOUS' : '',
  ]
    .filter((s) => s.length > 0)
    .join(' · ')
}

export interface KeyDifference {
  /** `'shaderId'`, a parameter name, `'flags'`, `'defines'`, `'tag'`, … */
  readonly field: string
  readonly mine: string
  readonly theirs: string
}

const definesSignature = (d: DecodedProgramKey): string =>
  d.defines.map((x) => (x.value === '' ? x.name : `${x.name}=${x.value}`)).join('+')

/**
 * Every field in which `a` differs from `b`.
 *
 * Defines are compared as an ORDERED signature and not as a set, because
 * insertion order is what three hashes: `{A,B}` and `{B,A}` are two keys for
 * one shader (DEV-194), and a set comparison would report them identical —
 * which is exactly the bug that cost 318 ms in the air.
 */
export const diffProgramKeys = (
  a: DecodedProgramKey,
  b: DecodedProgramKey,
): readonly KeyDifference[] => {
  const out: KeyDifference[] = []
  const add = (field: string, mine: string, theirs: string): void => {
    if (mine !== theirs) out.push({ field, mine, theirs })
  }
  add(
    'shaderId',
    a.shaderId ?? (a.customShaderIds ?? []).join('+'),
    b.shaderId ?? (b.customShaderIds ?? []).join('+'),
  )
  add('defines', definesSignature(a), definesSignature(b))
  for (const name of PARAMETER_FIELDS) add(name, a.parameters[name] ?? '', b.parameters[name] ?? '')
  const flagsA = new Set(a.flags)
  const flagsB = new Set(b.flags)
  for (const f of [...MASK_A_BITS, ...MASK_B_BITS])
    add(f, flagsA.has(f) ? 'on' : 'off', flagsB.has(f) ? 'on' : 'off')
  add('tag', a.tag, b.tag)
  return out
}

export interface NearestKey {
  readonly nearest: DecodedProgramKey
  readonly differences: readonly KeyDifference[]
  /** Whether the nearest key is the SAME material, by the identity below. */
  readonly sameMaterial: boolean
}

/**
 * What identifies the MATERIAL rather than the variant: the shader it is built
 * from, its defines, and `customProgramCacheKey` — which in this repo is
 * three's `onBeforeCompile.toString()` followed by every `tagProgramCacheKey`
 * token the module chain added, and is therefore the most nameful field in the
 * whole key.
 *
 * Everything else — the light counts, the colour space, the tone mapping, the
 * two bit masks — is which VARIANT of that material three is being asked for.
 *
 * Each part is JSON-quoted before joining, because the tag is three's
 * `onBeforeCompile.toString()` and can hold anything a function body can — so
 * any separator short enough to type is one a tag could contain. It was a NUL
 * for one commit and `tests/unit/source-bytes.test.ts` refused it, which is the
 * only guard in the repo that could have.
 */
const materialIdentity = (d: DecodedProgramKey): string =>
  [d.shaderId ?? (d.customShaderIds ?? []).join('+'), definesSignature(d), d.tag]
    .map((x) => JSON.stringify(x))
    .join('|')

/**
 * The already-warm key that this fresh one is CLOSEST to, and what separates
 * them — DEV-194's hand method, mechanised.
 *
 * The nearest neighbour is what turns "a program appeared" into "the warm-up
 * built this same variant with `numPointLights` 3 and the flight wants 2", and
 * that second sentence is a fix. Ties go to the first, which is stable because
 * `info.programs` keeps creation order.
 *
 * ── Same material first, THEN fewest fields (DEV-239) ────────────────────
 *
 * Fewest-fields alone is literal-minded in exactly the case that matters. On
 * `int_01_jumpSeat` the variant that compiled at 8.2 s was a `ShaderMaterial`
 * whose own composer-binding twin WAS in the warm set, two fields away
 * (`outputColorSpace`, `toneMapping`) — and a DIFFERENT ShaderMaterial, sharing
 * its tag and its flags, sat one field away. So the honest answer, *"you warmed
 * this same material against the wrong render target"*, lost to *"it looks a
 * bit like that other shader"*, and the report named the wrong mechanism.
 *
 * So the search is two-tier: among keys that are the same MATERIAL, take the
 * fewest differing fields; only if there are none does it fall back to the
 * whole set, and `sameMaterial` says which of the two happened rather than
 * leaving the reader to guess.
 */
export const nearestWarmKey = (
  fresh: DecodedProgramKey,
  warm: readonly string[],
): NearestKey | null => {
  const identity = materialIdentity(fresh)
  let best: NearestKey | null = null
  for (const w of warm) {
    const decoded = decodeProgramCacheKey(w)
    const candidate: NearestKey = {
      nearest: decoded,
      differences: diffProgramKeys(fresh, decoded),
      sameMaterial: materialIdentity(decoded) === identity,
    }
    if (best === null) {
      best = candidate
      continue
    }
    // A same-material candidate beats any other-material one outright; within a
    // tier it is fewest differing fields, first wins.
    if (candidate.sameMaterial !== best.sameMaterial) {
      if (candidate.sameMaterial) best = candidate
      continue
    }
    if (candidate.differences.length < best.differences.length) best = candidate
  }
  return best
}
