// src/boot/visibility-mask.ts — what the headset's lenses hide, recorded. DEV-331.
//
// `docs/plan/XR-PERF-VS-THREE.md` §3.11 found the only FILL lever desktop Chrome
// delivers on the shipping path: `XRSession.onvisibilitymaskchange`, the lens's
// visible region per eye (OpenXR's `XR_KHR_visibility_mask`). Every eye-buffer
// pixel outside that region is shaded and then thrown away by the compositor,
// and the frame is 75 % fill. So priming depth outside it could reject those
// fragments early, and the saving is CAPPED at the hidden fraction.
//
// **That fraction is unknown, and this file exists to measure it, not to use
// it.** The doc's instruction was "do not build first". This records the event
// on the next worn flight and puts it in the `?perf=1` capture, so one trip
// answers three things:
//   · does Chrome expose the event at all (`supported`);
//   · does the runtime send a mask (any `eyes` entry);
//   · how much of each eye it covers (the raw mesh, plus its own-space area).
//
// ── Why the raw mesh, and not a fraction ─────────────────────────────────
//
// The mask's coordinate space is not verified here: OpenXR defines its vertices
// in view space on the z = -1 plane, but whether Chrome forwards them unchanged
// or in another space was not checkable without a runtime. The capture already
// carries each eye's frustum (`XrProbe.views[].projection`), so the raw mesh
// lets the fraction be computed afterwards under either reading. `ownArea` is
// the mesh's area in whatever space it came in, for a first look.
//
// ── Why it attaches in `main.ts`, before `setSession` ────────────────────
//
// The initial mask events fire at session start (`DispatchInitialEvents`), and
// a listener added after three's `setSession` has awaited its way through
// reference spaces may be too late. `main.ts` attaches it on the line after
// `requestSession` resolves, which is as early as app code can.

/** One mask event, as recorded. */
export interface VisibilityMaskEye {
  readonly eye: string
  readonly index: number
  /** Flat `[x0, y0, x1, y1, ...]`, as the event carries them. Capped at `MAX_FLOATS`. */
  readonly vertices: readonly number[]
  readonly indices: readonly number[]
  /** Triangles in the event, before any cap. */
  readonly triangles: number
  /** Summed triangle area in the mesh's own space. See the header. */
  readonly ownArea: number
}

export interface VisibilityMaskReport {
  /** `'onvisibilitymaskchange' in XRSession.prototype` on this page. */
  readonly supported: boolean
  /** Sessions a listener was attached to. 0 means the hook never ran. */
  readonly watched: number
  readonly eyes: readonly VisibilityMaskEye[]
}

/** Plenty for a lens mesh (OpenVR's hidden-area meshes run to hundreds of vertices). */
const MAX_FLOATS = 8192

/** The summed area of an indexed 2D triangle mesh. */
export const meshArea = (vertices: ArrayLike<number>, indices: ArrayLike<number>): number => {
  let area = 0
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = (indices[t] as number) * 2
    const b = (indices[t + 1] as number) * 2
    const c = (indices[t + 2] as number) * 2
    const ax = vertices[a] as number
    const ay = vertices[a + 1] as number
    const bx = vertices[b] as number
    const by = vertices[b + 1] as number
    const cx = vertices[c] as number
    const cy = vertices[c + 1] as number
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  return area
}

interface MaskEvent {
  readonly eye?: unknown
  readonly index?: unknown
  readonly vertices?: ArrayLike<number>
  readonly indices?: ArrayLike<number>
}

interface Listenable {
  addEventListener(type: string, fn: (e: MaskEvent) => void): void
}

/** A recorder. The app uses the module's one; a test makes its own. */
export const createVisibilityMaskRecorder = (
  supported: () => boolean = () =>
    typeof XRSession !== 'undefined' && 'onvisibilitymaskchange' in XRSession.prototype,
) => {
  let watched = 0
  const eyes: VisibilityMaskEye[] = []
  return {
    watch(session: Listenable): void {
      watched++
      session.addEventListener('visibilitymaskchange', (e) => {
        const vertices = e.vertices ?? []
        const indices = e.indices ?? []
        eyes.push(
          Object.freeze({
            eye: typeof e.eye === 'string' ? e.eye : 'unknown',
            index: typeof e.index === 'number' ? e.index : -1,
            vertices: Object.freeze(Array.from(vertices).slice(0, MAX_FLOATS)),
            indices: Object.freeze(Array.from(indices).slice(0, MAX_FLOATS)),
            triangles: Math.floor(indices.length / 3),
            ownArea: meshArea(vertices, indices),
          }),
        )
      })
    },
    report(): VisibilityMaskReport {
      let isSupported = false
      try {
        isSupported = supported()
      } catch {
        isSupported = false
      }
      return Object.freeze({ supported: isSupported, watched, eyes: Object.freeze([...eyes]) })
    },
  }
}

/** The app's recorder: `main.ts` watches each session, the perf probe reports it. */
export const visibilityMask = createVisibilityMaskRecorder()
