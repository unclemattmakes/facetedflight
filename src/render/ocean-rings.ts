// src/render/ocean-rings.ts: the sea as camera-centred rings (a geometry clipmap).
//
// DEV-339, docs/plan/OCEAN-PERF.md §3. The plate draws 454,272 to 591,872
// triangles of sea over a fixed 16 km square, every one at the density of the
// chunk it happens to be in; the rings draw about 27,000, laid out by distance
// from the eye, and follow the eye. This file owns the three-facing half: the
// one shared cell mesh, a lattice texture and a material per level, the
// uniforms that move when the eye does, and the vertex GLSL.
//
// The numbers (which vertex is where) are `sim/terrain/ocean-ring-lattice.ts`'s
// and bit for bit the plate's; the layout (windows, holes, the six corners of a
// cell) is `sim/terrain/ocean-ring-layout.ts`'s, and the GLSL below is its twin.
// Read those two headers first.
//
// ── The shape ──────────────────────────────────────────────────────────────
//
// Each level is a FULL `cells` x `cells` grid of cells, six non-indexed vertices
// a cell, whose `position` attribute is (cell x, cell z, slot): no coordinates
// at all, only which corner of which cell. The vertex shader looks the corner up
// in the level's baked lattice texture (final jittered position, alpha = the
// plate's diagonal bit), so the diagonal is the plate's own bit and not a guess.
// A cell inside the next finer window collapses to one point (a hole), and the
// finer level's outer edge snaps onto the coarser level's, AFTER the wave, so no
// two levels meet in a crack and no skirt is needed.
//
// ── Why one clone of the plate's base material and not a material of its own ─
//
// Everything the app installs on the sea (fog, haze, the far-field shadow, the
// fragment gates, the point-light scope, the two-sided and shaft variants, the
// mirror) goes on `LoadedTerrain.materials`, i.e. the plate's BASE. A ring
// material that was a second base would need every one of those installed again
// and kept in step by hand. A delegating clone (`Water.deriveMaterial`) inherits
// the chain at compile time, shares the base's `defines` and joins its variant
// switch, so there is one `Water`, one set of uniforms (the wave clock, the sun,
// the coast) and one place a patch is written (DEV-183's "the sea stopped
// compiling" story is a clone handed to a patch installer; this is not that).
//
// ── What it does not do ────────────────────────────────────────────────────
//
// Nothing under `src/sim/` reads this. The collision surface is the height
// field, built from the map (`buildHeightField`), never from any mesh.

import * as THREE from 'three'
import type { FacetedTerrainParams, MapSampler } from '@/sim/terrain/faceted'
import {
  bakeRingLattice,
  type RingLattice,
  type RingLevelSpec,
  ringStepMesh,
} from '@/sim/terrain/ocean-ring-lattice'
import { ringFrame } from '@/sim/terrain/ocean-ring-layout'
import { MIRROR_VERTEX_GLSL, maxFacetTiltRadians, type Water } from './water'

/** `terrain.oceanRings` in the edition preset, minus `enabled`. */
export interface OceanRingsLadder {
  /** Cells per side of every level's window (even). */
  readonly cells: number
  /** The finest level's cell, world metres. Each level doubles it. */
  readonly innerCell: number
  /** How many levels. */
  readonly levels: number
}

/** The program-cache-key suffix every ring material carries. */
export const OCEAN_RINGS_KEY = 'oceanRings'

/** The defines the ring shader reads are all uniforms; this one names its text. */
export const OCEAN_RINGS_NAME = 'ocean-rings'

// ── The GLSL ───────────────────────────────────────────────────────────────
//
// Three blocks, and a test (`tests/unit/ocean-rings.test.ts`) reads each against
// the TypeScript twin: the helpers before `main`, the lookup that replaces
// `transformed` at `begin_vertex`, and the snap that overrides it again before
// `project_vertex`, once the wave block has run.

/** The six corners of a cell, per diagonal. `ocean-ring-layout.ts` is the twin. */
export const RING_GLSL_DECLS = /* glsl */ `
uniform highp sampler2D uRingLat;
uniform highp sampler2D uRingLatC;
// Lattice index of texel (0, 0), then the texture's width and height.
uniform vec4 uRingTex;
uniform vec4 uRingTexC;
// This window's min corner (lattice indices), cells per side, and 1 when a coarser level exists.
uniform vec4 uRingWin;
// The finer window as a hole in this level's cells: x0, z0, x1, z1.
uniform vec4 uRingHole;
// This level's step and the coarser level's (mesh units), and a y for lattice points off the bake.
uniform vec4 uRingFall;

const ivec2 FF2_RING_DIAG[6] = ivec2[6](
  ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));
const ivec2 FF2_RING_ANTI[6] = ivec2[6](
  ivec2(0, 0), ivec2(1, 1), ivec2(0, 1), ivec2(0, 0), ivec2(1, 0), ivec2(1, 1));

// (x, y, z, diag) of lattice point g, or w = -1 when the bake does not cover it.
vec4 ff2RingTexel(highp sampler2D tex, vec4 meta, ivec2 g) {
  ivec2 t = g - ivec2(meta.xy);
  if (t.x < 0 || t.y < 0 || t.x >= int(meta.z) || t.y >= int(meta.w)) return vec4(0.0, 0.0, 0.0, -1.0);
  return texelFetch(tex, t, 0);
}

// The local (three-space) position of lattice point g. Off the bake it is the
// regular lattice at \`fallbackY\`: still a pure function of the point, so two
// cells that share it agree and nothing cracks, just without the jitter.
vec3 ff2RingLocal(highp sampler2D tex, vec4 meta, ivec2 g, float stepM) {
  vec4 t = ff2RingTexel(tex, meta, g);
  if (t.w < 0.0) return vec3(float(g.x) * stepM, uRingFall.z, -float(g.y) * stepM);
  return t.xyz;
}

// The wave at a world position: the arithmetic of WAVE_GLSL (render/water.ts)
// as a function, so the snap can displace a coarse neighbour.
float ff2RingWave(vec3 wp) {
  float ux = wp.x;
  float uz = -wp.z;
  float s = sin(uWave.x);
  float c = cos(uWave.x);
  vec2 dir = vec2(c * ux - s * uz, s * ux + c * uz);
  float r = sin(ux * 12.9898 + uz * 78.233 + uz * 63.9137);
  float n = (r - floor(r)) * uWave.w;
  float phase = (dir.x + dir.y) * uWave.y + uWaveTime * uWaveSpeed + n;
  return uWave.z * (n + 1.0) * sin(phase);
}

// A level's lattice point with the wave added: the ONE expression every ring
// vertex takes its final local position from, whichever level or edge it is on.
// A fine vertex snapped onto a coarse edge and the coarse vertex it lands on are
// then the same arithmetic on the same inputs, which is what keeps a single pixel
// from leaking between them (run 4 of the GPU spec found 3 to 11 magenta pixels
// when the two went through different code).
vec3 ff2RingDisp(highp sampler2D tex, vec4 meta, ivec2 g, float stepM) {
  float yScale = max(1e-6, length(modelMatrix[1].xyz));
  vec3 p = ff2RingLocal(tex, meta, g, stepM);
  p.y += ff2RingWave((modelMatrix * vec4(p, 1.0)).xyz) / yScale;
  return p;
}

// The final local position of lattice point g (cell-relative rel) of THIS level:
// its displaced lattice position, or on the window's outer edge the midpoint of
// the two coarse neighbours, each displaced as the coarse level displaces it.
vec3 ff2RingFinal(ivec2 g, ivec2 rel) {
  int n = int(uRingWin.z);
  if (uRingWin.w > 0.5 && (rel.x == 0 || rel.y == 0 || rel.x == n || rel.y == n)) {
    ivec2 c0 = g / 2;
    ivec2 c1 = c0 + (g - c0 * 2);
    vec3 p0 = ff2RingDisp(uRingLatC, uRingTexC, c0, uRingFall.y);
    vec3 p1 = (c1 == c0) ? p0 : ff2RingDisp(uRingLatC, uRingTexC, c1, uRingFall.y);
    return 0.5 * (p0 + p1);
  }
  return ff2RingDisp(uRingLat, uRingTex, g, uRingFall.x);
}
`

/** After `begin_vertex`: this vertex's lattice point, or the cell's min corner in a hole. */
export const RING_GLSL_LOOKUP = /* glsl */ `
  ivec2 ff2RingCell = ivec2(int(position.x + 0.5), int(position.y + 0.5));
  int ff2RingSlot = int(position.z + 0.5);
  ivec2 ff2RingG0 = ivec2(uRingWin.xy) + ff2RingCell;
  vec4 ff2RingT0 = ff2RingTexel(uRingLat, uRingTex, ff2RingG0);
  ivec2 ff2RingCorner = ff2RingT0.w > 0.5 ? FF2_RING_DIAG[ff2RingSlot] : FF2_RING_ANTI[ff2RingSlot];
  bool ff2RingHole = ff2RingG0.x >= int(uRingHole.x) && ff2RingG0.x < int(uRingHole.z)
    && ff2RingG0.y >= int(uRingHole.y) && ff2RingG0.y < int(uRingHole.w);
  if (ff2RingHole) ff2RingCorner = ivec2(0);
  ivec2 ff2RingG = ff2RingG0 + ff2RingCorner;
  transformed = ff2RingLocal(uRingLat, uRingTex, ff2RingG, uRingFall.x);
`

/**
 * Before `project_vertex`, i.e. after the wave block: a vertex on the window's
 * outer edge is put on the coarser level's edge, between two coarse vertices
 * that are each displaced exactly as the coarse level displaces them.
 */
export const RING_GLSL_SNAP = /* glsl */ `
  if (!ff2RingHole) {
    transformed = ff2RingFinal(ff2RingG, ff2RingCell + ff2RingCorner);
    vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;${MIRROR_VERTEX_GLSL}
  }
`

// ── DEV-340: the facet normal from the vertex shader ──────────────────────
//
// The plate (and the rings, until now) derive a face normal per FRAGMENT from
// `dFdx` / `dFdy` of the world position, and two rows (DEV-050, DEV-183) repair
// the noise that gives wherever a pixel spans several facets. 2016 shaded from
// vertex normals and never took a derivative. A ring vertex knows its triangle:
// its cell, its slot, the plate's diagonal bit. So the vertex shader displaces
// all THREE corners of its triangle (each exactly as the vertex stage displaces
// that lattice point, perimeter snap included), crosses two edges, and hands the
// unit normal to the fragment as a `flat` varying: one exact normal per face, no
// derivatives, nothing at facet edges where a 2 x 2 pixel quad straddles two
// faces. The footprint term the plate used to flatten the far field is not
// needed: a ring's cell grows with distance, so a facet stays tens of pixels
// across at every range (32 m at 1 km is ~66 px at the worn eye's 2516 px).

/** Declarations for the face-normal variant: the flat varying (`ff2RingFinal` is in the common declarations). */
export const RING_GLSL_FACE_DECLS = /* glsl */ `
flat varying vec3 vRingNormal;
`

/** Before `project_vertex`, after the snap: this triangle's unit normal, in world space. */
export const RING_GLSL_FACE = /* glsl */ `
  {
    int ff2RingT = (ff2RingSlot / 3) * 3;
    bool ff2RingDiag2 = ff2RingT0.w > 0.5;
    ivec2 ff2RingA = ff2RingDiag2 ? FF2_RING_DIAG[ff2RingT] : FF2_RING_ANTI[ff2RingT];
    ivec2 ff2RingB = ff2RingDiag2 ? FF2_RING_DIAG[ff2RingT + 1] : FF2_RING_ANTI[ff2RingT + 1];
    ivec2 ff2RingC = ff2RingDiag2 ? FF2_RING_DIAG[ff2RingT + 2] : FF2_RING_ANTI[ff2RingT + 2];
    vec3 ff2RingWa = (modelMatrix * vec4(ff2RingFinal(ff2RingG0 + ff2RingA, ff2RingCell + ff2RingA), 1.0)).xyz;
    vec3 ff2RingWb = (modelMatrix * vec4(ff2RingFinal(ff2RingG0 + ff2RingB, ff2RingCell + ff2RingB), 1.0)).xyz;
    vec3 ff2RingWc = (modelMatrix * vec4(ff2RingFinal(ff2RingG0 + ff2RingC, ff2RingCell + ff2RingC), 1.0)).xyz;
    vec3 ff2RingFn = cross(ff2RingWb - ff2RingWa, ff2RingWc - ff2RingWa);
    float ff2RingFl = length(ff2RingFn);
    vRingNormal = ff2RingFl > 1e-9 ? ff2RingFn / ff2RingFl : vec3(0.0, 1.0, 0.0);
  }
`

/** The three derivative statements the water's normal block opens with, and what replaces each. */
export const RING_FRAGMENT_SWAPS: readonly (readonly [string, string])[] = [
  ['vec3 dPdx = dFdx(vWaterWorld);', 'vec3 dPdx = vec3(0.0);'],
  ['vec3 dPdy = dFdy(vWaterWorld);', 'vec3 dPdy = vec3(0.0);'],
  ['vec3 faceNormal = normalize(cross(dPdx, dPdy));', 'vec3 faceNormal = vRingNormal;'],
]

/**
 * The fragment half of DEV-340: the water's face normal is the vertex stage's,
 * and with no derivative the footprint is zero, so the flatten blend in the same
 * block is the identity. The statements are swapped IN PLACE (the block, its
 * `#ifndef` gate and the tilt clamp stay), and one that is not found throws:
 * a swap that matched nothing would leave the derived normal drawing while the
 * arm said otherwise.
 */
export const patchRingFragment = (source: string): string => {
  let out = `flat varying vec3 vRingNormal;\n${source}`
  for (const [from, to] of RING_FRAGMENT_SWAPS) {
    if (!out.includes(from)) {
      throw new Error(`ocean rings: the water normal block no longer has "${from}" to swap`)
    }
    out = out.replace(from, to)
  }
  return out
}

/** Rewrite a sea vertex shader (already carrying the water chain) to draw rings. */
export const patchRingVertex = (source: string, face = false): string => {
  const mainAt = source.indexOf('void main() {')
  if (mainAt < 0 || !source.includes('#include <begin_vertex>')) {
    throw new Error('ocean rings: the vertex shader has no main() or no begin_vertex to anchor on')
  }
  if (!source.includes('#include <project_vertex>')) {
    throw new Error('ocean rings: the vertex shader has no project_vertex to anchor the snap on')
  }
  if (!source.includes('vWaterWorld')) {
    throw new Error('ocean rings: the water wave block is not in the shader the rings patch')
  }
  const decls = face ? `${RING_GLSL_DECLS}\n${RING_GLSL_FACE_DECLS}` : RING_GLSL_DECLS
  const withDecls = `${source.slice(0, mainAt)}${decls}\n${source.slice(mainAt)}`
  return withDecls
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${RING_GLSL_LOOKUP}`)
    .replace(
      '#include <project_vertex>',
      `${RING_GLSL_SNAP}${face ? RING_GLSL_FACE : ''}\n#include <project_vertex>`,
    )
}

// ── The geometry ───────────────────────────────────────────────────────────

/** The ONE mesh every level draws: `cells`^2 cells, six vertices each. */
export const ringGeometry = (
  cells: number,
  colour: readonly [number, number, number],
): THREE.BufferGeometry => {
  const count = cells * cells * 6
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)
  let v = 0
  for (let cx = 0; cx < cells; cx++) {
    for (let cz = 0; cz < cells; cz++) {
      for (let slot = 0; slot < 6; slot++) {
        position[v * 3] = cx
        position[v * 3 + 1] = cz
        position[v * 3 + 2] = slot
        // Never read for lighting (the sea derives its own face normal), but a
        // missing attribute reads as zero and the vertex stage normalises it.
        normal[v * 3 + 1] = 1
        color[v * 3] = colour[0]
        color[v * 3 + 1] = colour[1]
        color[v * 3 + 2] = colour[2]
        v++
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  g.setAttribute('color', new THREE.BufferAttribute(color, 3))
  // Positions come from the shader; nothing here is where it is drawn. The
  // meshes are never culled, and this keeps anything that asks from computing a
  // sphere over cell indices.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)
  return g
}

// ── The controller ─────────────────────────────────────────────────────────

export interface OceanRingsInput {
  readonly grid: { verts: Float32Array; vertPerSide: number }
  readonly heightMap: MapSampler
  readonly params: FacetedTerrainParams
  /** The plate's own group: the rings are parented to it and share its transform. */
  readonly group: THREE.Group
  readonly water: Water
  readonly ladder: OceanRingsLadder
  /** The sea's one colour, linear as the plate's vertex colours are. */
  readonly colour: readonly [number, number, number]
  /** Where the eye can be: a world x/z, and how far from it (metres). Beyond it the lattice is regular. */
  readonly reach: { readonly x: number; readonly z: number; readonly radius: number }
}

export interface OceanRings {
  /** The levels, parented under `input.group`. */
  readonly object: THREE.Group
  /** Re-centre every level on an eye at THREE world (x, z). */
  follow(eyeX: number, eyeZ: number): void
  /** Triangles submitted per frame (every cell, holes included). */
  readonly submitted: number
  /** Triangles that rasterise: cells not inside a finer window. */
  live(): number
  /** Cell edge of each level, world metres. */
  readonly cellMetres: readonly number[]
  /** The bytes of lattice texture and cell geometry held. */
  readonly bytes: number
  /**
   * DEV-340: the face normal comes from the vertex shader (`face`) or from the
   * fragment's screen-space derivatives (`derived`, the plate's). The first
   * `face` cuts four materials and compiles a second program on its first draw.
   */
  setNormals(mode: 'derived' | 'face'): void
  readonly normals: 'derived' | 'face'
  dispose(): void
}

/** (stride, n) of each level for a ladder on a plate. Throws on a ladder the plate cannot take. */
export const ringLevelSpecs = (
  params: FacetedTerrainParams,
  scaleX: number,
  ladder: OceanRingsLadder,
): RingLevelSpec[] => {
  const parent = params.baseResolution * scaleX
  const n = parent / ladder.innerCell
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `ocean rings: innerCell ${ladder.innerCell} m does not divide the plate's ${parent} m parent quad`,
    )
  }
  if (ladder.cells < 4 || ladder.cells % 2 !== 0) {
    throw new Error(`ocean rings: cells must be an even number of 4 or more, got ${ladder.cells}`)
  }
  const specs: RingLevelSpec[] = []
  for (let k = 0; k < ladder.levels; k++) {
    const stride = 1 << k
    if (!Number.isInteger(params.terrainSize / params.baseResolution / stride)) {
      throw new Error(`ocean rings: level ${k} is coarser than the plate's grid`)
    }
    specs.push({ stride, n })
  }
  return specs
}

export const createOceanRings = (input: OceanRingsInput): OceanRings => {
  const { group, water, params, ladder } = input
  const specs = ringLevelSpecs(params, group.scale.x, ladder)
  const { cells } = ladder
  const steps = specs.map((s) => ringStepMesh(params, s))
  const meshOfWorld = (x: number, z: number): [number, number] => [
    (x - group.position.x) / group.scale.x,
    (group.position.z - z) / group.scale.z,
  ]
  const [reachX, reachZ] = meshOfWorld(input.reach.x, input.reach.z)
  const reachMesh = input.reach.radius / group.scale.x

  // One lattice texture per level, over the region an eye inside `reach` can see.
  const lattices: RingLattice[] = []
  const textures: THREE.DataTexture[] = []
  let sumY = 0
  let countY = 0
  for (let k = 0; k < specs.length; k++) {
    const step = steps[k] as number
    const half = Math.ceil(reachMesh / step) + cells / 2 + 4
    const lat = bakeRingLattice(input.grid, input.heightMap, params, specs[k] as RingLevelSpec, {
      gx0: Math.floor(reachX / step) - half,
      gz0: Math.floor(reachZ / step) - half,
      width: 2 * half + 1,
      height: 2 * half + 1,
    })
    lattices.push(lat)
    const tex = new THREE.DataTexture(
      lat.data,
      lat.width,
      lat.height,
      THREE.RGBAFormat,
      THREE.FloatType,
    )
    tex.name = `ocean-ring-lattice:${k}`
    tex.minFilter = THREE.NearestFilter
    tex.magFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.needsUpdate = true
    textures.push(tex)
    if (k === specs.length - 1) {
      for (let i = 1; i < lat.data.length; i += 4) {
        sumY += lat.data[i] as number
        countY++
      }
    }
  }
  const fallbackY = countY > 0 ? sumY / countY : 0

  const geometry = ringGeometry(cells, input.colour)
  const object = new THREE.Group()
  object.name = OCEAN_RINGS_NAME
  const levels: {
    readonly mesh: THREE.Mesh
    readonly win: THREE.Vector4
    readonly hole: THREE.Vector4
    readonly derived: THREE.Material
    /** DEV-340's face-normal twin, cut the first time it is asked for. */
    face: THREE.Material | null
    readonly uniforms: Readonly<Record<string, THREE.IUniform>>
  }[] = []
  const cellMetres: number[] = []
  for (let k = 0; k < specs.length; k++) {
    const lat = lattices[k] as RingLattice
    const coarse = lattices[k + 1] ?? lat
    const hasCoarse = k + 1 < specs.length
    const cell = (steps[k] as number) * group.scale.x
    cellMetres.push(cell)
    const win = new THREE.Vector4(0, 0, cells, hasCoarse ? 1 : 0)
    const hole = new THREE.Vector4(0, 0, 0, 0)
    const uniforms = {
      uRingLat: { value: textures[k] as THREE.Texture },
      uRingLatC: { value: (textures[k + 1] ?? textures[k]) as THREE.Texture },
      uRingTex: { value: new THREE.Vector4(lat.gx0, lat.gz0, lat.width, lat.height) },
      uRingTexC: { value: new THREE.Vector4(coarse.gx0, coarse.gz0, coarse.width, coarse.height) },
      uRingWin: { value: win },
      uRingHole: { value: hole },
      uRingFall: {
        value: new THREE.Vector4(
          steps[k] as number,
          steps[k + 1] ?? (steps[k] as number),
          fallbackY,
          0,
        ),
      },
      // The same two the plate's bands carry, for THIS level's cell.
      uFacet: { value: cell },
      uTiltCos: { value: Math.cos(maxFacetTiltRadians(water.displace.amplitude, cell)) },
    }
    const material = water.deriveMaterial({
      name: `ring${k}`,
      keySuffix: OCEAN_RINGS_KEY,
      uniforms,
      patch: (shader) => {
        shader.vertexShader = patchRingVertex(shader.vertexShader)
      },
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `ocean-ring-${k}`
    mesh.frustumCulled = false
    // Neither casts nor receives, as the plate's `ocean-chunk` role (shadows.ts).
    mesh.castShadow = false
    mesh.receiveShadow = false
    object.add(mesh)
    levels.push({ mesh, win, hole, derived: material, face: null, uniforms })
  }
  group.add(object)

  /** DEV-340: which normal the ring materials draw with. */
  let normals: 'derived' | 'face' = 'derived'
  const setNormals = (mode: 'derived' | 'face'): void => {
    for (const [k, l] of levels.entries()) {
      if (mode === 'face' && !l.face) {
        l.face = water.deriveMaterial({
          name: `ring${k}f`,
          keySuffix: `${OCEAN_RINGS_KEY}Face`,
          uniforms: l.uniforms,
          patch: (shader) => {
            shader.vertexShader = patchRingVertex(shader.vertexShader, true)
            shader.fragmentShader = patchRingFragment(shader.fragmentShader)
          },
        })
      }
      l.mesh.material = mode === 'face' ? (l.face as THREE.Material) : l.derived
    }
    normals = mode
  }

  const follow = (eyeX: number, eyeZ: number): void => {
    const [mx, mz] = meshOfWorld(eyeX, eyeZ)
    const frames = ringFrame(mx, mz, steps, cells)
    for (let k = 0; k < levels.length; k++) {
      const f = frames[k]
      const l = levels[k]
      if (!f || !l) continue
      l.win.x = f.wx
      l.win.y = f.wz
      if (f.hole) l.hole.set(f.hole.x0, f.hole.z0, f.hole.x1, f.hole.z1)
      else l.hole.set(0, 0, 0, 0)
    }
    lastFrames = frames
  }
  let lastFrames: ReturnType<typeof ringFrame> | null = null
  // Until the first `follow`, the windows sit at the lattice origin: draw nothing
  // sensible, so the caller follows once before the first frame.
  const reachEye: [number, number] = [input.reach.x, input.reach.z]
  follow(reachEye[0], reachEye[1])

  const submitted = specs.length * cells * cells * 2
  const bytes =
    lattices.reduce((sum, l) => sum + l.data.byteLength, 0) +
    geometry.getAttribute('position').array.byteLength * 3

  return {
    object,
    follow,
    submitted,
    live: () => {
      const f = lastFrames
      if (!f) return submitted
      let cellsLive = 0
      for (const frame of f) {
        const h = frame.hole
        cellsLive += cells * cells - (h ? (h.x1 - h.x0) * (h.z1 - h.z0) : 0)
      }
      return cellsLive * 2
    },
    cellMetres,
    bytes,
    setNormals,
    get normals() {
      return normals
    },
    dispose: () => {
      for (const l of levels) {
        l.derived.dispose()
        l.face?.dispose()
      }
      geometry.dispose()
      for (const t of textures) t.dispose()
      object.removeFromParent()
    },
  }
}
