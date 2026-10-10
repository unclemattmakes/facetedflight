// src/render/shaft-paint.ts — the elevator shaft keeps the hangar's colours (DEV-456).
//
// Matt, 2026-09-27: *"it looks like the elevator shaft stops using it's vertex
// colors when just above the hangar."* And, told why: *"shaft should keep it's
// hangar colors - consider it a decade old bug fix."*
//
// ── The 2016 bug ──────────────────────────────────────────────────────────
//
// The shaft's three meshes (`walls_and_pillars_pwn`, `pipes_LOD3_pwn`,
// `elev_shaft_013_pwn`) are PolyWorld conversions, and they CARRY vertex
// colours: 156, 109 and 33 distinct Color32s, the same dark brick family as the
// room's. But their material, `ent_elevatorShaft_pwn_Mat`, is Marmoset's plain
// `Specular IBL`, whose source has `//#define MARMO_VERTEX_COLOR` commented out.
// The room and the stepped lower shaft wear the `Vertex Color` variant. So in
// 2016 the paint stopped exactly where the room's mesh does, and above it the
// shaft drew `_Color` alone, near-white; `hangar-room.glb` reproduces that
// faithfully (`tools/assets/convert-hangar-art.mjs` reads the shader, not the
// name). Nothing about the mesh says it was meant to: a material picked from the
// wrong family, on a mesh somebody had painted.
//
// ── The fix, as data ─────────────────────────────────────────────────────
//
// `hangar-shaft-painted.glb` is the same segment again — the same vertices in
// the same order, in the same ROOM frame — with its vertex colours read. So the
// fix is a swap of one attribute, `color`, on `hangar-room.glb`'s `shaft` mesh
// before either room assembles it: the level-select room (DEV-430/439, where it
// wears the reflective material) and the launch (DEV-438, where it is baked
// under the room's light). Everything else about both is untouched.
//
// The paint is the HANGAR's: the shaft's own vertex colours times the room's
// `botfloor_shaft_pwm_Mat` `_Color`, as if the shaft wore the room's material —
// chroma r:g:b 0.28:0.30:0.43 against the room's 0.27:0.30:0.43. Its OWN
// `_Color` (the Vertex Color variant of its own material) was measured too and
// came out maroon, 0.41:0.28:0.31: not the hangar's colour, so not shipped.
//
//   hangar  the paint (`SHAFT_PAINT_SHIPPED`)
//   2016    2016's flat shaft, the room file as it is (`?shaftPaint=2016`)
//
// `?shaftPaint=` is a development A/B; it is never stored. A painted file that
// fails to load leaves 2016's shaft, with a line in the console: a missing
// part, never a missing room.

import type * as THREE from 'three'

/** `tools/assets/convert-hangar-art.mjs`'s `HANGAR_ART_OUT.shaftPainted`. */
export const HANGAR_SHAFT_PAINTED_MESH = 'assets/hangar/hangar-shaft-painted.glb'

export type ShaftPaint = 'hangar' | '2016'

export const SHAFT_PAINTS: readonly ShaftPaint[] = ['hangar', '2016']

/** The paint the game ships (DEV-456). The one assertion that pins it is in `shaft-paint.test.ts`. */
export const SHAFT_PAINT_SHIPPED: ShaftPaint = 'hangar'

/** The painted part's name in `hangar-shaft-painted.glb`. */
export const SHAFT_PAINT_PART = 'shaft'

let current: ShaftPaint = SHAFT_PAINT_SHIPPED

/** `boot/app.ts` sets it from `?shaftPaint=` before any room loads. */
export const setShaftPaint = (paint: ShaftPaint): void => {
  current = paint
}

export const shaftPaint = (): ShaftPaint => current

/** `?shaftPaint=<id>`, or null for the shipped paint. Never fatal: an unknown id says so. */
export const shaftPaintParam = (raw: string | null): ShaftPaint | null => {
  if (raw === null) return null
  if ((SHAFT_PAINTS as readonly string[]).includes(raw)) return raw as ShaftPaint
  console.warn(`?shaftPaint=${raw} is not one of ${SHAFT_PAINTS.join(', ')}; ignored`)
  return null
}

const meshNamed = (root: THREE.Object3D, name: string): THREE.Mesh => {
  const mesh = root.getObjectByName(name) as THREE.Mesh | undefined
  if (!mesh?.isMesh) throw new Error(`shaft-paint: no mesh named ${name}`)
  return mesh
}

/**
 * Put the hangar's colours on `room`'s `shaft` mesh — `hangar-room.glb`'s
 * scene, as loaded — from `painted`, `hangar-shaft-painted.glb`'s. Refuses a
 * file whose part is not the same vertices: a colour on the wrong vertex is
 * paint in the wrong place, and it would be invisible to every count.
 */
export const paintShaft = (room: THREE.Object3D, painted: THREE.Object3D): void => {
  const target = meshNamed(room, 'shaft').geometry
  const source = meshNamed(painted, SHAFT_PAINT_PART).geometry
  const a = target.getAttribute('position')
  const b = source.getAttribute('position')
  const colour = source.getAttribute('color')
  if (!a || !b || !colour || a.count !== b.count || colour.count !== a.count) {
    throw new Error('shaft-paint: the painted shaft is not the same mesh as the room file')
  }
  let worst = 0
  for (let i = 0; i < a.count; i++) {
    worst = Math.max(
      worst,
      Math.abs(a.getX(i) - b.getX(i)),
      Math.abs(a.getY(i) - b.getY(i)),
      Math.abs(a.getZ(i) - b.getZ(i)),
    )
  }
  if (worst > 1e-5) {
    throw new Error(`shaft-paint: the painted shaft's vertices are ${worst} m off the room file's`)
  }
  const ti = target.getIndex()
  const si = source.getIndex()
  if ((ti?.count ?? -1) !== (si?.count ?? -1)) {
    throw new Error('shaft-paint: the painted shaft has other triangles than the room file')
  }
  if (ti && si) {
    for (let i = 0; i < ti.count; i++) {
      if (ti.getX(i) !== si.getX(i)) {
        throw new Error('shaft-paint: the painted shaft has other triangles than the room file')
      }
    }
  }
  target.setAttribute('color', colour.clone())
}
