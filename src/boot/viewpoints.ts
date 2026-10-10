// src/boot/viewpoints.ts — named places to stand and look.
//
// Matt: *"i'd like you to setup camera positions to specifically take
// screenshots."*
//
// The orbit views are for watching the island go round; they are useless for
// judging anything specific, because the one thing you cannot do from them is
// point at what you want to see. Half of today went on that: the sea's specular
// is a sun glint, the sun is **4 degrees above the horizon**, and a glint at
// 4 degrees is only visible looking TOWARD the sun's reflection — which no orbit
// camera ever does.
//
// So these are fixed. Each one is a position, a target, and a note saying what
// it is FOR. `?view=cam&cam=<name>` puts you there and leaves you there.
// `?view=cam&eye=x,y,z&look=x,y,z` is the same thing ad hoc.
//
// ── The coordinate space ──────────────────────────────────────────────────
//
// THREE space, world, offsets already applied — the same numbers the level
// JSON's `rings[].pos` are in, so a viewpoint can be written down by copying a
// gate's position and backing off. Not sim space: these never touch the sim.
//
// ── Sea level is about 116 m, and there is NO SUCH NUMBER ──────────────
//
// The ocean is its own `FacetedTerrain` with its own transform, and its surface
// sits near **y = 116** — not at zero, and not at the -15 the ISLANDS heightmap
// reads over open water. That -15 is the SEABED: the island mesh carries on
// underneath the sea rather than stopping at the shoreline.
//
// **116.6 is a spot value near the map origin, not a constant**, and this
// comment asserted it as one for two sessions. The ocean has its OWN height map
// with **5,244 distinct base heights** — 115.29 over the open sea north-west of
// the island, 117.63 off the massif — and on top of those ride a ±3.459 m bob of
// the whole plate and a ±4 m per-vertex wave, which add. The instantaneous
// surface at one stand spans roughly **108 to 123 m**.
//
// That is not pedantry. `water.ts` wanted a CPU-side *"is the eye under the
// surface"* test and there is nothing to compare against; it decides per
// FRAGMENT instead (DEV-064). Anything here that treats 116.6 as the waterline
// is choosing a viewpoint, not stating a fact — which is fine for a viewpoint,
// and is why they are only ever used to aim a camera. (DEV-027's rule: say what
// the number is the height OF.)
//
// The first `water-glint` shot was taken from y = 40, which is 76 m underwater,
// and came back as a full-frame mess of dithering. Worth the two minutes: no
// amount of reading the extractor would have said where the sea was.
//
// ── Picking a viewpoint that shows a specular ─────────────────────────────
//
// `lighting.sun.direction` on `int_01_hoverJet` is the direction the light
// TRAVELS: (0.962, -0.070, 0.263). So the sun sits at minus that — off toward
// -X and slightly -Z, four degrees up. To see it glint off the sea you stand low
// over the water and look along that bearing, which is what `water-glint` does
// and what Matt's own reference shot is.

import * as THREE from 'three'

export interface Viewpoint {
  /** Camera position, THREE world space. */
  readonly eye: readonly [number, number, number]
  /** What it looks at. */
  readonly look: readonly [number, number, number]
  /** What this shot is for. Printed to the console when it is used. */
  readonly note: string
}

/**
 * Toward the sun on `int_01_hoverJet`, normalised, THREE space.
 *
 * Written out rather than imported so a viewpoint file stays readable, and
 * asserted against the level JSON in `tests/unit/viewpoints.test.ts` — a
 * viewpoint aimed at where the sun used to be is worse than no viewpoint.
 */
export const INT01_SUN_BEARING = [-0.962253, 0.069757, -0.263062] as const

export const VIEWPOINTS: Readonly<Record<string, Viewpoint>> = {
  /**
   * Low over the sea, looking INTO the sun.
   *
   * The shot that shows whether the water's specular works. The sun is 4 degrees
   * up, so the glint lies in a narrow band along its bearing; stand 40 m above
   * the surface, well out from the island, and look down that line.
   */
  'water-glint': {
    // Open sea north-west of the island: the land mesh is 130 m below the
    // surface here, so nothing but water is in frame.
    eye: [-563, 150, 1889],
    look: [-1525, 220, 1626],
    note: 'low over the sea, into the 4-degree sun — the specular glint',
  },
  /**
   * The same water with the sun BEHIND, for comparison.
   *
   * A control: if this looks identical to `water-glint` then the specular is not
   * doing anything and the glint in the other shot is something else.
   */
  'water-away': {
    eye: [-563, 150, 1889],
    look: [399, 80, 2152],
    note: 'the same water with the sun behind — the control for water-glint',
  },
  /**
   * The JOIN: where the water's facets meet the land's.
   *
   * The three `water-*` stands above are all open sea — `water-glint`'s own note
   * says the land mesh is 130 m below the surface there — which makes them the
   * CONTROL for DEV-087 and useless as its subject. This one looks at the
   * gentlest stretch of coast Simonet has: 100 of the 169 cells within 24 m of
   * (-460, -1627) are in 0 to 12 m of water, measured on a 4 m grid against a
   * 116.6 m waterline, where the island's mean shore runs at roughly 1:1.
   *
   * From 260 m out and 59 m up, so the shallows band (a mean 34.7 m wide at the
   * shipped `shallowDepth`) subtends enough of the frame to judge.
   */
  'water-shore': {
    eye: [-309, 176, -1838],
    look: [-460, 117, -1627],
    note: 'the shoreline — shallows, the foam line, and the join (DEV-087)',
  },
  /** Close enough to the surface to see individual 256 m facets. */
  'water-close': {
    eye: [-300, 128, 1800],
    look: [-1262, 120, 1537],
    note: 'just above the sea, close enough to read individual facets',
  },
  /**
   * The big massif, lit from the side.
   *
   * For judging the terrain's colour and how much the directional light is
   * shaping it. Matt, on his own reference shot: *"it looks like the lighting is
   * stronger overall too (note the shadows on the mtn)."*
   */
  'island-lit': {
    eye: [1100, 700, -900],
    look: [522, 338, -1533],
    note: 'the massif with the sun across it — terrain colour and shading',
  },
  /**
   * The SAME massif from 150 m instead of 930 m.
   *
   * The control for `island-lit`. Fog is a function of distance, so a colour
   * judged at 930 m is a judgement about the fog as much as about the terrain;
   * this stands close enough that the fog contributes almost nothing, and the
   * pixel you sample is the albedo times the light and nothing else. Same
   * bearing as `island-lit`, so the two differ only in range.
   */
  'island-close': {
    eye: [615, 396, -1431],
    look: [522, 338, -1533],
    note: 'the massif from 150 m — terrain colour with the fog taken out',
  },
  /** A gate at eye level, for the frame, the studs and the burst. */
  'gate-close': {
    eye: [-660, 160, 2060],
    look: [-761, 150, 2008],
    note: 'the first gate, close — frame colour, studs, particles',
  },
  /** The sky itself, no terrain: the SH background and the sun disc. */
  'sky-only': {
    eye: [0, 900, 0],
    look: [-962, 970, -263],
    note: 'sky only, toward the sun — the SH background and the disc',
  },
}

/** Parse `x,y,z` into a tuple, or null if it is not three finite numbers. */
export const parseTriple = (raw: string | null): [number, number, number] | null => {
  if (!raw) return null
  const parts = raw.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0] as number, parts[1] as number, parts[2] as number]
}

/**
 * Resolve `?cam=` / `?eye=&look=` into a viewpoint.
 *
 * Explicit coordinates win over a name, so a named shot can be nudged without
 * editing this file — which is the difference between a tool and a list.
 */
export const resolveViewpoint = (params: URLSearchParams): Viewpoint | null => {
  const eye = parseTriple(params.get('eye'))
  const look = parseTriple(params.get('look'))
  if (eye && look) return { eye, look, note: 'ad hoc' }
  const name = params.get('cam')
  if (!name) return null
  const found = VIEWPOINTS[name]
  if (!found) {
    console.warn(`viewpoint "${name}" is not one of: ${Object.keys(VIEWPOINTS).join(', ')}`)
    return null
  }
  return found
}

/** Point a camera at a viewpoint. Called once; nothing animates it. */
export const applyViewpoint = (camera: THREE.Camera, vp: Viewpoint): void => {
  camera.position.set(vp.eye[0], vp.eye[1], vp.eye[2])
  camera.lookAt(new THREE.Vector3(vp.look[0], vp.look[1], vp.look[2]))
}
