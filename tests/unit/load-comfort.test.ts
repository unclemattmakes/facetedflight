/**
 * tests/unit/load-comfort.test.ts — a course switch hands the thread back, and
 * what it shows while it does. DEV-355.
 *
 * Four pieces, each tested against something outside itself:
 *
 *   - `boot/slice.ts` against a fake clock: it yields exactly when a slice's
 *     budget is spent and never otherwise, and a drained bake returns what the
 *     bake returned.
 *   - the stepped bakes against their own one-shot form, AND interleaved with a
 *     second bake — `sky-visibility.ts` keeps module-level scratch, and a
 *     sliced bake is exactly the case where another caller can run between two
 *     rows (trap 19's guard: step a second one and assert the first did not
 *     move).
 *   - `render/warm-up.ts`'s two-pass warm against a fake renderer: the first
 *     pass draws nothing, the link wait comes between the passes, and the rig
 *     it borrows goes back where it was, on a throw as well.
 *   - `render/loading-scene.ts` as GEOMETRY: where the plate stands relative to
 *     the eye it was shown to, and which way it faces — not what rotation it
 *     was given (the orientation lesson).
 */
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { plateText } from '@/boot/load-progress'
import { createSlicer } from '@/boot/slice'
import {
  createLoadingScene,
  LOADING_PLATE_DISTANCE,
  LOADING_PLATE_PITCH_MAX,
  LOADING_PLATE_PITCH_MIN,
  loadingPlatePosition,
  plateElevation,
  skyColourAt,
  yawFacing,
} from '@/render/loading-scene'
import {
  type LinkingProgram,
  programsLinked,
  type WarmUpRenderer,
  warmWorld,
  warmWorldLinked,
} from '@/render/warm-up'
import { runSteps, type Steps } from '@/sim/steps'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  buildSkyVisibility,
  buildSunRadiance,
  skyVisibilitySteps,
} from '@/sim/terrain/sky-visibility'
import { buildSunHeight, sunHeightSteps } from '@/sim/terrain/sun-height'
import { appSource } from './helpers/app-source'

// ── fixtures ──────────────────────────────────────────────────────────────

/** A deterministic rough field, `n` samples on `step` metres. */
const roughField = (n: number, step: number, seed: number): HeightField => {
  let s = seed
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const terrainHeight = 1000
  const heights = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) heights[i] = (rnd() * 120) / terrainHeight
  return {
    vertPerSide: n,
    heights,
    step,
    terrainSize: (n - 1) * step,
    terrainHeight,
    originX: 0,
    originY: 0,
    originZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  }
}

const TOWARD: [number, number, number] = [0.8, 0.12, 0.3]

/** Radiance for a field, from its own sun march: the bake's real input. */
const radianceOf = (field: HeightField): Float32Array => {
  const n = field.vertPerSide
  const albedo = new Float32Array(n * n * 3).fill(0.4)
  return buildSunRadiance(field, TOWARD, albedo, null)
}

const SKY_OPTIONS = { stride: 1, azimuths: 8, samples: 12, maxDistance: 200 } as const

// ── the slicer ────────────────────────────────────────────────────────────

describe('createSlicer — DEV-355', () => {
  it('does not yield while the slice has budget, and yields once it is spent', async () => {
    let t = 0
    let turns = 0
    const slicer = createSlicer({
      budgetMs: 8,
      now: () => t,
      yieldTurn: async () => {
        turns += 1
      },
    })
    t = 7
    await slicer.checkpoint()
    expect(turns, '7 ms of an 8 ms slice is not a reason to stop').toBe(0)
    t = 8
    await slicer.checkpoint()
    expect(turns, 'a spent slice hands the thread back').toBe(1)
    // A new slice starts at the yield, so the very next checkpoint is free.
    await slicer.checkpoint()
    expect(turns).toBe(1)
    expect(slicer.yields).toBe(1)
  })

  it('drains a bake to the value it returns, stopping only at its own boundaries', async () => {
    let t = 0
    const at: number[] = []
    const slicer = createSlicer({
      budgetMs: 10,
      now: () => t,
      yieldTurn: async () => {
        at.push(t)
      },
    })
    // Every row "costs" 4 ms of the fake clock.
    function* rows(): Steps<string> {
      for (let r = 0; r < 10; r++) {
        t += 4
        yield (r + 1) / 10
      }
      return 'done'
    }
    const seen: number[] = []
    const value = await slicer.drain(rows(), (f) => seen.push(f))
    expect(value).toBe('done')
    expect(seen).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
    // 40 ms of rows in 10 ms slices: a turn every third row, never mid-row.
    expect(slicer.yields).toBe(3)
    for (const time of at) expect(time % 4, 'a turn lands on a row boundary').toBe(0)
  })
})

// ── the stepped bakes ─────────────────────────────────────────────────────

describe('the bakes, stepped — DEV-355', () => {
  it('sun height: one yield per row, ending at 1, and the field the one-shot builds', () => {
    const field = roughField(33, 8, 7)
    const steps = sunHeightSteps(field, TOWARD)
    const progress: number[] = []
    let next = steps.next()
    while (!next.done) {
      progress.push(next.value)
      next = steps.next()
    }
    expect(progress).toHaveLength(field.vertPerSide)
    expect(progress[progress.length - 1]).toBe(1)
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i] as number).toBeGreaterThan(progress[i - 1] as number)
    }
    const once = buildSunHeight(field, TOWARD)
    expect(Array.from(next.value.tops)).toEqual(Array.from(once.tops))
    expect(Array.from(next.value.depths)).toEqual(Array.from(once.depths))
  })

  it('sky visibility: two bakes interleaved row by row give what each gives alone', () => {
    // The module keeps scratch buffers for one sample's bounce. A sliced bake
    // is exactly when another caller can run between two of its rows, so the
    // guard is to step a SECOND bake between every row of the first.
    const a = roughField(17, 8, 11)
    const b = roughField(17, 8, 23)
    const aloneA = buildSkyVisibility(a, SKY_OPTIONS, radianceOf(a))
    const aloneB = buildSkyVisibility(b, SKY_OPTIONS, radianceOf(b))
    const stepsA = skyVisibilitySteps(a, SKY_OPTIONS, radianceOf(a))
    const stepsB = skyVisibilitySteps(b, SKY_OPTIONS, radianceOf(b))
    let nextA = stepsA.next()
    let nextB = stepsB.next()
    while (!nextA.done || !nextB.done) {
      if (!nextA.done) nextA = stepsA.next()
      if (!nextB.done) nextB = stepsB.next()
    }
    const [interA, interB] = [nextA.value, nextB.value]
    expect(Array.from(interA.values)).toEqual(Array.from(aloneA.values))
    expect(Array.from(interA.bounce as Float32Array)).toEqual(
      Array.from(aloneA.bounce as Float32Array),
    )
    expect(Array.from(interB.values)).toEqual(Array.from(aloneB.values))
    expect(Array.from(interB.bounce as Float32Array)).toEqual(
      Array.from(aloneB.bounce as Float32Array),
    )
    // And the fixture is not trivially flat: the two fields bake differently.
    expect(Array.from(aloneA.values)).not.toEqual(Array.from(aloneB.values))
  })

  it('runSteps is the one-shot form', () => {
    function* three(): Steps<number> {
      yield 0.5
      yield 1
      return 3
    }
    expect(runSteps(three())).toBe(3)
  })
})

// ── the two-pass warm ─────────────────────────────────────────────────────

interface Call {
  readonly kind: 'render' | 'compile'
  readonly target: THREE.WebGLRenderTarget | null
  readonly rigParent: string | null
}

/** A renderer whose programs link only when told to, in creation order. */
const linkingRenderer = (rig: THREE.Object3D) => {
  const calls: Call[] = []
  let target: THREE.WebGLRenderTarget | null = null
  const programs: { ready: boolean; isReady: () => boolean }[] = []
  const add = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const p = { ready: false, isReady: () => p.ready }
      programs.push(p)
    }
  }
  const log = (kind: Call['kind']): void => {
    calls.push({ kind, target, rigParent: rig.parent?.name ?? null })
  }
  const renderer: WarmUpRenderer = {
    render: () => {
      log('render')
    },
    compile: (() => {
      log('compile')
      add(2)
      return new Set<THREE.Material>()
    }) as WarmUpRenderer['compile'],
    setRenderTarget: ((t: THREE.WebGLRenderTarget | null) => {
      target = t
    }) as WarmUpRenderer['setRenderTarget'],
    getRenderTarget: () => target,
    info: {
      get programs() {
        return programs as unknown as THREE.WebGLProgram[]
      },
      memory: { geometries: 0, textures: 0 },
    },
  }
  return { renderer, calls, programs }
}

const warmStage = () => {
  const scene = new THREE.Scene()
  scene.name = 'mission'
  const room = new THREE.Scene()
  room.name = 'room'
  const rig = new THREE.Group()
  rig.name = 'xr-rig'
  room.add(rig)
  const root = new THREE.Group()
  root.visible = false
  root.add(new THREE.Mesh(new THREE.BufferGeometry()))
  scene.add(root)
  return { scene, room, rig, root, camera: new THREE.PerspectiveCamera() }
}

describe('warmWorld / warmWorldLinked — DEV-355', () => {
  it('compileOnly draws NOTHING and compiles at the same binding the draw would', () => {
    const { scene, rig, root, camera } = warmStage()
    const { renderer, calls } = linkingRenderer(rig)
    warmWorld(renderer, scene, camera, root, { offscreen: true, compileOnly: true }, () => 0)
    expect(calls.map((c) => c.kind)).toEqual(['compile', 'compile'])
    expect(calls[0]?.target, 'bound offscreen, as the draw is').not.toBeNull()
    expect(calls[0]?.target).toBe(calls[1]?.target)
  })

  it('adopts the rig into the warmed scene for every call, and puts it back', () => {
    const { scene, rig, root, camera } = warmStage()
    const { renderer, calls } = linkingRenderer(rig)
    warmWorld(renderer, scene, camera, root, { offscreen: false, adopt: [rig] }, () => 0)
    for (const c of calls)
      expect(c.rigParent, `${c.kind} saw the rig in the mission`).toBe('mission')
    expect(rig.parent?.name, 'the rig is back in the room').toBe('room')
  })

  it('rideLit compiles the whole scene LAST, with the room SHOWN, and puts it back', () => {
    const { scene, rig, root, camera } = warmStage()
    const room = new THREE.Group()
    room.name = 'launch-room'
    // Hidden as FOUND — which is what the frame loop leaves it as while the
    // screen is the menu, and the case the first cut ("put back as found")
    // compiled nothing for.
    room.visible = false
    scene.add(room)
    const seen: { handed: string; roomVisible: boolean }[] = []
    const { renderer } = linkingRenderer(rig)
    const watching: WarmUpRenderer = {
      ...renderer,
      compile: ((handed: THREE.Object3D) => {
        seen.push({ handed: handed.name, roomVisible: room.visible })
        return new Set<THREE.Material>()
      }) as WarmUpRenderer['compile'],
    }
    warmWorld(
      watching,
      scene,
      camera,
      root,
      { offscreen: false, compileOnly: true, hide: [room], rideLit: [room] },
      () => 0,
    )
    // The flight's pass with the room hidden, then the ride's with it shown.
    expect(seen).toEqual([
      { handed: 'mission', roomVisible: false },
      { handed: 'mission', roomVisible: false },
      { handed: 'mission', roomVisible: true },
    ])
    expect(room.visible, 'and it is left as it was found').toBe(false)
  })

  it('warmWorldLinked hands the thread back between its compile passes', async () => {
    const { scene, rig, root, camera } = warmStage()
    const room = new THREE.Group()
    scene.add(room)
    const { renderer, calls, programs } = linkingRenderer(rig)
    const turns: number[] = []
    await warmWorldLinked(
      renderer,
      scene,
      camera,
      root,
      { offscreen: true, alsoDefaultTarget: true, hide: [room], rideLit: [room] },
      () => 0,
      async () => {
        turns.push(calls.length)
        for (const p of programs) p.ready = true
      },
    )
    // Three compile passes (the flight's binding, the session's, the ride's),
    // a turn after each of the first two, and the link wait after the third.
    // Nothing between two calls of ONE pass: a pass holds state (the room
    // hidden, the rig adopted) that a frame must never see half-applied.
    expect(turns.length).toBeGreaterThanOrEqual(3)
    const perPass = [turns[0], (turns[1] as number) - (turns[0] as number)]
    // One binding is the draw's compile and the scene's; the session's binding
    // adds one compile of the scene.
    expect(perPass, 'the first pass is one binding, the second adds the session').toEqual([2, 3])
  })

  it('warmWorldLinked keeps rideLit out of the draw pass', async () => {
    const { scene, rig, root, camera } = warmStage()
    const room = new THREE.Group()
    scene.add(room)
    const { renderer, programs } = linkingRenderer(rig)
    const visibleAtCompile: boolean[] = []
    const watching: WarmUpRenderer = {
      ...renderer,
      compile: ((handed: THREE.Object3D) => {
        visibleAtCompile.push(room.visible)
        return renderer.compile(handed, camera)
      }) as WarmUpRenderer['compile'],
    }
    await warmWorldLinked(
      watching,
      scene,
      camera,
      root,
      { offscreen: false, hide: [room], rideLit: [room] },
      () => 0,
      async () => {
        for (const p of programs) p.ready = true
      },
    )
    // compile-only, the flight's pass: flight, flight. A turn. The ride's pass:
    // flight, flight as cache hits, then the ride with the room on. Then the
    // draw pass's one compile, room hidden again: it never asks for the ride.
    expect(visibleAtCompile).toEqual([false, false, false, false, true, false])
  })

  it('puts the rig back on a throw too', () => {
    const { scene, rig, root, camera } = warmStage()
    const { renderer } = linkingRenderer(rig)
    const throwing: WarmUpRenderer = {
      ...renderer,
      render: () => {
        throw new Error('context lost')
      },
    }
    expect(() =>
      warmWorld(throwing, scene, camera, root, { offscreen: false, adopt: [rig] }, () => 0),
    ).toThrow('context lost')
    expect(rig.parent?.name).toBe('room')
  })

  it('programsLinked waits in creation order and stops asking at the first one linking', async () => {
    const programs = [0, 1, 2].map(() => {
      const p = {
        ready: false,
        asked: 0,
        isReady: (): boolean => {
          p.asked += 1
          return p.ready
        },
      }
      return p
    })
    let waits = 0
    const done = programsLinked(
      () => programs as readonly LinkingProgram[],
      async () => {
        waits += 1
        // The driver finishes one program per poll.
        const next = programs.find((p) => !p.ready)
        if (next) next.ready = true
      },
    )
    expect(await done).toBe(3)
    expect(waits).toBe(3)
    // The last program was asked only while it was first in line: never
    // polled on the turns when an earlier one was still linking.
    expect(programs[2]?.asked).toBe(2)
  })

  it('programsLinked returns 0 when everything linked already', async () => {
    const ready = [{ isReady: () => true }, { isReady: () => true }]
    expect(
      await programsLinked(
        () => ready,
        async () => undefined,
      ),
    ).toBe(0)
  })

  it('warmWorldLinked: compile pass, THEN the wait, THEN the draw', async () => {
    const { scene, rig, root, camera } = warmStage()
    const { renderer, calls, programs } = linkingRenderer(rig)
    const order: string[] = []
    const result = await warmWorldLinked(
      renderer,
      scene,
      camera,
      root,
      { offscreen: false, adopt: [rig] },
      () => 0,
      async () => {
        order.push(`wait after ${calls.map((c) => c.kind).join('+')}`)
        for (const p of programs) p.ready = true
      },
    )
    expect(order).toEqual(['wait after compile+compile'])
    expect(calls.map((c) => c.kind)).toEqual(['compile', 'compile', 'render', 'compile'])
    expect(result.linkWaits).toBe(1)
    // Both passes' programs, so the app's console line means what it did.
    expect(result.programs).toBe(programs.length)
    expect(rig.parent?.name).toBe('room')
  })
})

// ── the loading scene ─────────────────────────────────────────────────────

/** Enough of a 2D context for the plate to draw into and nobody to read. */
const stubCanvas = (): void => {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    },
  )
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  })
}

const TEXT = {
  kicker: 'HoverJet · Ring Attack · Intermediate',
  title: 'Intermediate 1 - HoverJet',
  status: 'Loading Simonet Islands…',
  fraction: 0.25,
}

describe('the loading scene — DEV-355', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubCanvas()
  })

  it('stands the plate where the head looked, at its distance, facing back at it', () => {
    const scene = new THREE.Scene()
    const loading = createLoadingScene()
    scene.add(loading.object)
    // Headings none of which is an axis — a rule that only holds where two
    // conventions agree has not been tested — and two that tip past the band.
    for (const dir of [
      new THREE.Vector3(0.3, -0.4, -0.87),
      new THREE.Vector3(-0.9, 0.1, 0.4),
      new THREE.Vector3(0.6, -0.2, 0.77),
      new THREE.Vector3(0.2, -0.95, -0.1),
      new THREE.Vector3(-0.1, 0.9, 0.3),
    ]) {
      const eye = new THREE.Vector3(12.5, 1.7, -4.25)
      const elevation = plateElevation(dir)
      loading.show(eye, yawFacing(dir), elevation, TEXT)
      scene.updateMatrixWorld(true)
      const plate = loading.object.getObjectByName('loading-plate') as THREE.Mesh
      const at = plate.getWorldPosition(new THREE.Vector3())
      // At its distance, on the bearing the head was facing.
      expect(at.distanceTo(eye)).toBeCloseTo(LOADING_PLATE_DISTANCE, 6)
      const ahead = new THREE.Vector3(at.x - eye.x, 0, at.z - eye.z).normalize()
      const want = new THREE.Vector3(dir.x, 0, dir.z).normalize()
      expect(ahead.dot(want), 'the plate is where the head was facing').toBeGreaterThan(0.9999)
      // At the head's own pitch where that is in the band, at the band's edge
      // where it is not: never over the head, never under the seat.
      const pitch = Math.asin(dir.y / dir.length())
      const seen = Math.asin((at.y - eye.y) / LOADING_PLATE_DISTANCE)
      expect(seen).toBeGreaterThanOrEqual(LOADING_PLATE_PITCH_MIN - 1e-9)
      expect(seen).toBeLessThanOrEqual(LOADING_PLATE_PITCH_MAX + 1e-9)
      if (pitch > LOADING_PLATE_PITCH_MIN && pitch < LOADING_PLATE_PITCH_MAX) {
        expect(seen).toBeCloseTo(pitch, 9)
      }
      // The pure helper and the real object agree.
      const helper = loadingPlatePosition(eye, yawFacing(dir), elevation, new THREE.Vector3())
      expect(helper.distanceTo(at)).toBeLessThan(1e-9)
      // Its readable face (+z of the plane) turns straight back at the eye.
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(plate.matrixWorld)
      const toEye = eye.clone().sub(at).normalize()
      expect(normal.dot(toEye), 'the plate faces the eye').toBeGreaterThan(0.9999)
      // And the scene itself stands level: the horizon is a horizon.
      const up = new THREE.Vector3(0, 1, 0).transformDirection(loading.object.matrixWorld)
      expect(up.y).toBeCloseTo(1, 12)
    }
  })

  it('is on the default layer only — never an eye layer (DEV-141)', () => {
    const loading = createLoadingScene()
    loading.object.traverse((o) => {
      expect(o.layers.isEnabled(1), `${o.name} on the left eye's layer`).toBe(false)
      expect(o.layers.isEnabled(2), `${o.name} on the right eye's layer`).toBe(false)
    })
  })

  it('is hidden until shown, and shows its words and its fraction', () => {
    const loading = createLoadingScene()
    expect(loading.shown).toBe(false)
    loading.show(new THREE.Vector3(), 0, 0, TEXT)
    expect(loading.shown).toBe(true)
    expect(loading.text).toEqual(TEXT)
    const bar = loading.object.getObjectByName('loading-bar') as THREE.Mesh
    const track = loading.object.getObjectByName('loading-track') as THREE.Mesh
    expect(bar.scale.x / track.scale.x).toBeCloseTo(0.25, 6)
    loading.update({ ...TEXT, fraction: null, status: 'Building the course…' })
    expect(bar.scale.x / track.scale.x, 'work with no count shows a full bar').toBeCloseTo(1, 6)
    loading.hide()
    expect(loading.shown).toBe(false)
  })

  it('the mark turns only while shown', () => {
    const loading = createLoadingScene()
    const mark = loading.object.getObjectByName('loading-mark') as THREE.Mesh
    loading.tick(1)
    expect(mark.rotation.y).toBe(0)
    loading.show(new THREE.Vector3(), 0, 0, TEXT)
    loading.tick(1)
    expect(mark.rotation.y).toBeGreaterThan(0)
  })

  it('has a horizon: the sky is lightest just above it and darkens toward the zenith', () => {
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const low = lum(skyColourAt(0.02, new THREE.Color()))
    const mid = lum(skyColourAt(0.5, new THREE.Color()))
    const top = lum(skyColourAt(Math.PI / 2, new THREE.Color()))
    expect(low).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(top)
  })

  it('app.ts hangs it in the ROOM, and never on the rig or the camera', () => {
    const app = appSource()
    expect(app).toContain('menuScene.add(loadingScene.object)')
    expect(app).not.toMatch(/(rig|camera)\.add\(\s*loadingScene/)
  })
})

describe('plateText — DEV-355', () => {
  it('says words, never a number, so a per-chunk tick is not a canvas upload', () => {
    const base = { fraction: 0.43, place: 'Simonet Islands', error: null }
    expect(plateText({ ...base, phase: 'terrain' })).toBe('Loading Simonet Islands…')
    expect(plateText({ ...base, phase: 'assembling' })).toBe('Building the course…')
    for (const phase of ['terrain', 'assembling', 'ready', 'failed'] as const) {
      expect(plateText({ ...base, phase })).not.toMatch(/\d/)
    }
  })
})
