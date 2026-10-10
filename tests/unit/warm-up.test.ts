/**
 * tests/unit/warm-up.test.ts — the world's first draw happens under the
 * curtain, with the binding the flight will use, and leaves no flag changed.
 *
 * DEV-117. The renderer is a fake: what matters is WHAT was bound when the
 * draw and the compile ran, that the hidden group was drawable for exactly
 * that call, and that every flag went back. A real GL context would only add
 * the part this cannot get wrong.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type WarmUpRenderer, warmWorld } from '../../src/render/warm-up'
import { REPO as ROOT } from './helpers/repo-root'

interface Call {
  readonly kind: 'render' | 'compile'
  readonly target: THREE.WebGLRenderTarget | null
  /** Snapshot of the root's effective drawability at the moment of the call. */
  readonly rootVisible: boolean
  readonly culledMeshes: number
  /** DEV-152: what the call was handed, and what was visible when it ran. */
  readonly handed: string | undefined
  readonly visibleNames: readonly string[]
}

const fakeRenderer = (root: THREE.Object3D, scene?: THREE.Object3D) => {
  const calls: Call[] = []
  let target: THREE.WebGLRenderTarget | null = null
  let programs = 3
  let geometries = 10
  const snapshot = (kind: Call['kind'], handed?: THREE.Object3D): void => {
    let culled = 0
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.frustumCulled) culled++
    })
    const visibleNames: string[] = []
    scene?.traverse((o) => {
      if (o.name && o.visible) visibleNames.push(o.name)
    })
    calls.push({
      kind,
      target,
      rootVisible: root.visible,
      culledMeshes: culled,
      handed: handed?.name,
      visibleNames,
    })
  }
  const renderer: WarmUpRenderer = {
    render: () => {
      snapshot('render', undefined)
      // A draw compiles what it drew and uploads what it drew.
      programs += 5
      geometries += 7
    },
    compile: ((handed: THREE.Object3D) => {
      snapshot('compile', handed)
      programs += 1
      return new Set<THREE.Material>()
    }) as WarmUpRenderer['compile'],
    setRenderTarget: ((t: THREE.WebGLRenderTarget | null) => {
      target = t
    }) as WarmUpRenderer['setRenderTarget'],
    getRenderTarget: () => target,
    info: {
      get programs() {
        return new Array(programs) as THREE.WebGLProgram[]
      },
      memory: {
        get geometries() {
          return geometries
        },
        textures: 0,
      },
    },
  }
  return { renderer, calls, currentTarget: () => target }
}

const world = () => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  const root = new THREE.Group()
  root.visible = false
  const meshes = [0, 1, 2].map(() => new THREE.Mesh(new THREE.BufferGeometry()))
  // One mesh already unculled by its owner — the sky dome is like this — so
  // the restore has to put back what it FOUND, not `true` everywhere.
  ;(meshes[2] as THREE.Mesh).frustumCulled = false
  for (const m of meshes) root.add(m)
  scene.add(root)
  return { scene, camera, root, meshes }
}

describe('warmWorld — DEV-117', () => {
  it('draws once and compiles once, with the hidden group drawable for both', () => {
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root)
    warmWorld(renderer, scene, camera, root, { offscreen: false }, () => 0)
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
    for (const c of calls) {
      expect(c.rootVisible, `${c.kind} saw the root visible`).toBe(true)
      expect(c.culledMeshes, `${c.kind} saw no culled mesh`).toBe(0)
    }
  })

  it('binds a render target for the composer path and none otherwise — the whole lesson', () => {
    const { scene, camera, root } = world()
    const on = fakeRenderer(root)
    const off = fakeRenderer(root)
    warmWorld(on.renderer, scene, camera, root, { offscreen: true }, () => 0)
    warmWorld(off.renderer, scene, camera, root, { offscreen: false }, () => 0)
    for (const c of on.calls) expect(c.target, `${c.kind} bound offscreen`).not.toBeNull()
    for (const c of off.calls) expect(c.target, `${c.kind} bound the default`).toBeNull()
    // The same target for the draw and the compile: a compile against a
    // different binding than the draw would build a third variant.
    expect(on.calls[0]?.target).toBe(on.calls[1]?.target)
  })

  it('puts every flag back exactly as it found it, and the target too', () => {
    const { scene, camera, root, meshes } = world()
    const { renderer, currentTarget } = fakeRenderer(root)
    const previous = new THREE.WebGLRenderTarget(4, 4)
    renderer.setRenderTarget(previous)
    warmWorld(renderer, scene, camera, root, { offscreen: true }, () => 0)
    expect(root.visible, 'the land is hidden again for the ride').toBe(false)
    expect(meshes.map((m) => m.frustumCulled)).toEqual([true, true, false])
    expect(currentTarget(), 'the caller gets its own binding back').toBe(previous)
  })

  it('restores on a throw as well — a lost context must not leave the world visible', () => {
    const { scene, camera, root, meshes } = world()
    const { renderer } = fakeRenderer(root)
    const throwing: WarmUpRenderer = {
      ...renderer,
      render: () => {
        throw new Error('context lost')
      },
    }
    expect(() => warmWorld(throwing, scene, camera, root, { offscreen: true }, () => 0)).toThrow(
      'context lost',
    )
    expect(root.visible).toBe(false)
    expect(meshes.map((m) => m.frustumCulled)).toEqual([true, true, false])
  })

  it('reports what the draw added and how long it took', () => {
    const { scene, camera, root } = world()
    const { renderer } = fakeRenderer(root)
    let t = 100
    const r = warmWorld(renderer, scene, camera, root, { offscreen: true }, () => (t += 12.5))
    expect(r.programs).toBe(6)
    expect(r.geometries).toBe(7)
    expect(r.meshes, 'two meshes had culling suspended; the third was already off').toBe(2)
    expect(r.ms).toBeCloseTo(12.5)
    expect(r.offscreen).toBe(true)
  })

  it('hides what it is told to for the draw — the launch room and its lamp — and shows it again', () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    const lamp = new THREE.PointLight()
    room.add(lamp)
    scene.add(room)
    const alreadyHidden = new THREE.Group()
    alreadyHidden.visible = false
    scene.add(alreadyHidden)
    let lampsSeen = -1
    const { renderer } = fakeRenderer(root)
    const counting: WarmUpRenderer = {
      ...renderer,
      render: () => {
        lampsSeen = 0
        scene.traverseVisible((o) => {
          if ((o as THREE.Light).isLight) lampsSeen++
        })
      },
    }
    warmWorld(
      counting,
      scene,
      camera,
      root,
      { offscreen: true, hide: [room, alreadyHidden] },
      () => 0,
    )
    expect(lampsSeen, 'the room lamp was not in the light set the draw compiled against').toBe(0)
    expect(room.visible, 'the room is back for the ride').toBe(true)
    expect(alreadyHidden.visible, 'and what was hidden stays hidden').toBe(false)
  })

  it('a group that was already visible stays visible — the ?ride=0 and JumpSeat paths', () => {
    const { scene, camera, root } = world()
    root.visible = true
    const { renderer } = fakeRenderer(root)
    warmWorld(renderer, scene, camera, root, { offscreen: false }, () => 0)
    expect(root.visible).toBe(true)
  })

  // ── DEV-152: the SHAFT's own light count gets a pass of its own ──────────
  //
  // DEV-117 hides the launch room for the draw so the programs it builds match
  // the FLIGHT's light count, and that is what killed the 2-second reveal. The
  // bill for it was `numPointLights` — field #36 of three's program cache key —
  // being one HIGHER for everything drawn during the ride (Classic 0 -> 1,
  // Anniversary 2 -> 3, measured). Almost everything in the shaft draws on the
  // ride's first frame and pays there; the launch deck is outside the frustum
  // at the bottom and first drew about 44 m up, compiling one program in the
  // clear. `shaftLit` is the second, targeted compile that builds those.
  it('compiles the shaftLit roots AGAIN with the room put back', () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    room.name = 'launch-room'
    room.add(new THREE.PointLight())
    scene.add(room)
    const deck = new THREE.Group()
    deck.name = 'start-grid'
    deck.add(new THREE.Mesh(new THREE.BufferGeometry()))
    scene.add(deck)
    const { renderer, calls } = fakeRenderer(root, scene)

    warmWorld(
      renderer,
      scene,
      camera,
      root,
      { offscreen: false, hide: [room], shaftLit: [deck] },
      () => 0,
    )

    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile', 'compile'])
    // The first two run with the room HIDDEN — the flight's lights.
    expect(calls[0]?.visibleNames).not.toContain('launch-room')
    expect(calls[1]?.visibleNames).not.toContain('launch-room')
    // The third is handed the deck, and the room is BACK for it.
    expect(calls[2]?.handed, 'the shaft pass compiles the deck, not the world').toBe('start-grid')
    expect(calls[2]?.visibleNames, 'under the room lamp this time').toContain('launch-room')
    // Same render target for all three: the binding is in the key (DEV-117).
    expect(calls[2]?.target).toBe(calls[0]?.target)
    // And everything is put back.
    expect(room.visible).toBe(true)
    expect(deck.visible).toBe(true)
  })

  it('shows a shaftLit root that was hidden, and puts it back', () => {
    const { scene, camera, root } = world()
    const deck = new THREE.Group()
    deck.name = 'start-grid'
    deck.visible = false
    scene.add(deck)
    const { renderer, calls } = fakeRenderer(root, scene)
    warmWorld(renderer, scene, camera, root, { offscreen: false, shaftLit: [deck] }, () => 0)
    expect(calls[2]?.visibleNames, 'drawable for its own compile').toContain('start-grid')
    expect(deck.visible, 'and hidden again after').toBe(false)
  })

  it('does nothing extra when there is no shaft — the JumpSeat and ?ride=0 paths', () => {
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root, scene)
    warmWorld(renderer, scene, camera, root, { offscreen: false, shaftLit: [] }, () => 0)
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
  })

  // ── DEV-186 follow-up: `duringWarm` runs where it says it does ───────────
  //
  // The sea's four variants are chosen by flipping `material.defines`, which no
  // list of roots can express — so `warmVariants` is a callback rather than a
  // `shaftLit` entry. What it needs from this function is the two facts the
  // whole file is about, and BOTH of them stop being true in the `finally`: the
  // bound render target is in three's program cache key (`outputColorSpace`,
  // `toneMapping`) and so is the point-light count. Called one line later,
  // after `warmWorld` had returned — which is where it lived — it built four
  // programs keyed `srgb` / ACES / three point lights, against a game that
  // draws `srgb-linear` / none / two. Measured off three's own cache keys:
  // four programs nothing drew, while the flight's two compiled in the air.
  //
  // Nothing about that is visible from the outside. `warmVariants` returned a
  // count and the count was right either way, which is why this needs an
  // assertion on WHERE the callback runs rather than on what it returned.
  it('runs `duringWarm` with the target still bound and the room still hidden', () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    room.name = 'launch-room'
    room.add(new THREE.PointLight())
    scene.add(room)
    const ocean = new THREE.Group()
    ocean.name = 'ocean'
    scene.add(ocean)
    const { renderer, calls } = fakeRenderer(root, scene)

    const seen: { target: unknown; roomVisible: boolean; callsBefore: number }[] = []
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      {
        offscreen: true,
        hide: [room],
        duringWarm: (compile) => {
          seen.push({
            target: renderer.getRenderTarget(),
            roomVisible: room.visible,
            callsBefore: calls.length,
          })
          compile(ocean)
        },
      },
      () => 0,
    )

    expect(seen.length, 'called exactly once').toBe(1)
    // The binding the flight will use, not the canvas the `finally` puts back.
    expect(seen[0]?.target, 'a render target is bound').not.toBeNull()
    expect(seen[0]?.target, 'the same one the draw used').toBe(calls[0]?.target)
    // The FLIGHT's light count, not the shaft's.
    expect(seen[0]?.roomVisible, 'the room is still hidden').toBe(false)
    // After the draw and the scene compile, so both are a cache hit for it.
    expect(seen[0]?.callsBefore, 'after the render and the compile').toBe(2)
    // And the compile it was handed is scoped to the root it was given.
    expect(calls[2]?.kind).toBe('compile')
    expect(calls[2]?.handed, 'compiles the root the caller named').toBe('ocean')
    expect(calls[2]?.target, 'against the same binding').toBe(calls[0]?.target)
    // The restore still happens.
    expect(renderer.getRenderTarget()).toBeNull()
    expect(room.visible).toBe(true)
  })

  it('runs `duringWarm` BEFORE the shaftLit pass puts the room back', () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    room.name = 'launch-room'
    scene.add(room)
    const deck = new THREE.Group()
    deck.name = 'start-grid'
    scene.add(deck)
    const { renderer } = fakeRenderer(root, scene)
    let roomVisibleInside: boolean | null = null
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      {
        offscreen: false,
        hide: [room],
        shaftLit: [deck],
        duringWarm: () => {
          roomVisibleInside = room.visible
        },
      },
      () => 0,
    )
    expect(roomVisibleInside, 'the shaft pass had not run yet').toBe(false)
  })

  it('puts everything back when `duringWarm` throws', () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    scene.add(room)
    const { renderer } = fakeRenderer(root, scene)
    expect(() =>
      warmWorld(
        renderer,
        scene,
        camera,
        root,
        {
          offscreen: true,
          hide: [room],
          duringWarm: () => {
            throw new Error('sea')
          },
        },
        () => 0,
      ),
    ).toThrow('sea')
    expect(renderer.getRenderTarget(), 'the canvas is back').toBeNull()
    expect(room.visible, 'the room is back').toBe(true)
    expect(root.visible, 'the land is hidden again').toBe(false)
  })
})

// ── `variants` — DEV-177(b) ────────────────────────────────────────────────
//
// The sea's `warmVariants` used to be called AFTER `warmWorld` returned, and
// two things `warmWorld` does are undone by then — both of them in three's
// program cache key. Measured on `int_01` by cacheKey: the four sea programs
// carried `outputColorSpace = srgb` and `numPointLights = 3` against the
// flight's `srgb-linear` and 2, so they were four programs the game never
// draws with, and the sea went on compiling three variants in the seat.
//
// The assertions are on the STATE AT THE MOMENT the callback runs, which is
// the whole of the mechanism: what target was bound, and what was visible.
describe('warmWorld variants — DEV-177(b)', () => {
  const withRoom = () => {
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    room.name = 'launch-room'
    const deck = new THREE.Group()
    deck.name = 'start-grid'
    scene.add(room, deck)
    return { scene, camera, root, room, deck }
  }

  it('runs inside the draw binding — the same target the world was drawn into', () => {
    // The RELATIONSHIP, not the value (trap 24): asserting "it binds the
    // scratch" could be satisfied by a second scratch. What has to be true is
    // that the variant warm and the world draw agree, and this says exactly
    // that without re-deriving either side.
    const { scene, camera, root, room } = withRoom()
    const { renderer, calls, currentTarget } = fakeRenderer(root, scene)
    let boundDuring: unknown = 'not run'
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      { offscreen: true, hide: [room], duringWarm: () => (boundDuring = currentTarget()) },
      () => 0,
    )
    expect(boundDuring).toBe(calls[0]?.target)
    expect(boundDuring, 'and it is a real target, not the canvas').not.toBeNull()
  })

  it('and runs while `hide` is still hidden, so it warms the FLIGHT light count', () => {
    // The half the colour-space fix did not cover, and the reason the stalls
    // did not move when only the target was corrected. `shaftLit` puts the room
    // back on purpose (DEV-152) and it does so BEFORE the `finally` — so a warm
    // after `warmWorld` returns sees the shaft's three point lights where the
    // flight has two, and `numPointLights` is field 38 of the key.
    const { scene, camera, root, room, deck } = withRoom()
    const { renderer } = fakeRenderer(root, scene)
    let roomVisibleDuring: boolean | null = null
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      {
        offscreen: true,
        hide: [room],
        shaftLit: [deck],
        duringWarm: () => (roomVisibleDuring = room.visible),
      },
      () => 0,
    )
    expect(roomVisibleDuring, 'the room was hidden while the variants warmed').toBe(false)
    expect(room.visible, 'and put back afterwards').toBe(true)
  })

  it('runs before the shaftLit compiles, which are the ones that want the room', () => {
    const { scene, camera, root, room, deck } = withRoom()
    const { renderer, calls } = fakeRenderer(root, scene)
    const order: string[] = []
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      {
        offscreen: false,
        hide: [room],
        shaftLit: [deck],
        duringWarm: () => order.push('variants'),
      },
      () => 0,
    )
    // Two compiles happen: the scene's, then the deck's. The variants sit
    // between them, which is the only place both conditions hold.
    expect(order).toEqual(['variants'])
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile', 'compile'])
    expect(calls[2]?.handed, 'the deck compiled last, under the room').toBe('start-grid')
    expect(calls[2]?.visibleNames).toContain('launch-room')
  })

  it('is optional — a mission with no sea hands nothing and nothing extra runs', () => {
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root, scene)
    warmWorld(renderer, scene, camera, root, { offscreen: false }, () => 0)
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
  })

  it('a variant warm that throws still puts the target and the room back', () => {
    // A throw half way must not leave a 1x1 scratch target bound — the next
    // `render()` would draw the whole frame into it — nor the room hidden.
    const { scene, camera, root, room } = withRoom()
    const { renderer, currentTarget } = fakeRenderer(root, scene)
    expect(() =>
      warmWorld(
        renderer,
        scene,
        camera,
        root,
        {
          offscreen: true,
          hide: [room],
          duringWarm: () => {
            throw new Error('the sea has no material')
          },
        },
        () => 0,
      ),
    ).toThrow('the sea has no material')
    expect(currentTarget()).toBeNull()
    expect(room.visible).toBe(true)
    expect(root.visible, 'and the world is hidden again for the ride').toBe(false)
  })
})

// ── DEV-239: the SESSION's binding is the DEFAULT one, not the composer's ──
//
// `bloom.willComposite()` is `!renderer.xr.isPresenting && bloom.enabled` and
// this function runs under the loading curtain, before `#enter-vr` can have
// been pressed — so on Anniversary it is ALWAYS true and every program the
// warm-up builds is keyed to a target a session never draws through. Measured
// in a real VRto3D session on `int_01_hoverJet`: 105 warm keys at
// `srgb-linear`/none, which is the whole warm-up and exactly the flat run's
// count, 39 rebuilt at `srgb`/ACES on entering VR, and four in the air.
//
// §1 is the claim, read out of three's own build; §2 is what this function does
// about it. Split because the first is a fact about three and the second is a
// fact about us, and only the first goes stale when the pin moves.
describe('§1 three gives an XR layer the CANVAS’s key — the oracle', () => {
  const build = (): string =>
    fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

  it('uses the renderer’s tone mapping for the canvas AND for an XR target', () => {
    // Inside the `it`: a describe body runs during collection (CLAUDE.md).
    const text = build()
    expect(text).toContain(
      'if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {',
    )
    expect(text).toContain('toneMapping = renderer.toneMapping;')
  })

  it('takes the colour space from the renderer for the canvas and from the XR texture otherwise', () => {
    expect(build()).toContain(
      'outputColorSpace: ( currentRenderTarget === null ) ? renderer.outputColorSpace : ' +
        '( currentRenderTarget.isXRRenderTarget === true ? currentRenderTarget.texture.colorSpace : ' +
        'ColorManagement.workingColorSpace )',
    )
  })

  it('and builds that XR texture AT the renderer’s own output colour space', () => {
    // The step that closes the loop: without it the two branches above could
    // still disagree, and the whole of `alsoDefaultTarget` would be warming a
    // third variant nothing draws. `WebXRManager` writes it twice — the
    // multisampled path and the plain one — so both are asserted.
    const occurrences = build().split('colorSpace: renderer.outputColorSpace').length - 1
    expect(occurrences, 'WebXRManager no longer takes the renderer’s output colour space').toBe(2)
  })
})

describe('§2 warmWorld compiles the session’s binding too', () => {
  it('adds a second compile pass with NO target bound, after the composer’s', () => {
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root)
    const r = warmWorld(
      renderer,
      scene,
      camera,
      root,
      { offscreen: true, alsoDefaultTarget: true },
      () => 0,
    )
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile', 'compile'])
    // The draw and its compile are where DEV-117 put them, on the composer's
    // target — that half must not move.
    expect(calls[0]?.target, 'the real draw still uses the composer target').not.toBeNull()
    expect(calls[1]?.target).toBe(calls[0]?.target)
    // And the new one is the default binding, which is the session's key.
    expect(calls[2]?.target, 'the session pass binds the default target').toBeNull()
    expect(r.bindings).toBe(2)
  })

  it('is OFF by default — DEV-152’s function, unchanged', () => {
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root)
    const r = warmWorld(renderer, scene, camera, root, { offscreen: true }, () => 0)
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
    expect(r.bindings).toBe(1)
  })

  it('adds nothing when the build does not composite — the default target is already it', () => {
    // Classic, and any flat build with bloom off: the one pass it already does
    // IS the session's key, so a second would be a cache hit and a lie in the
    // log. `?xr=off` never gets here at all — `capabilities.immersiveVr` is
    // false, so `boot/app.ts` passes false.
    const { scene, camera, root } = world()
    const { renderer, calls } = fakeRenderer(root)
    const r = warmWorld(
      renderer,
      scene,
      camera,
      root,
      { offscreen: false, alsoDefaultTarget: true },
      () => 0,
    )
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
    expect(r.bindings).toBe(1)
  })

  // ── one assertion per VARIANT the flight was found to compile ───────────
  //
  // A node test has no GL context and cannot hold a cache key, so "the warm set
  // now contains it" is asserted in the only form that is true without one:
  // every variant `duringWarm` builds is built ONCE PER BINDING. That is the
  // property the four missed variants lacked — each of them existed in the warm
  // set at `srgb-linear`/none and nowhere else — and it is a property of this
  // function rather than of the machine.
  //
  // The four, from `int_01_hoverJet` in a VRto3D session (DEV-239):
  //
  //    0.84 s  the LAND chunk's LOD-fade clone      `terrain.warmLodFade()`
  //    1.45 s  the sea's SHAFT variant              `water.warmVariants`
  //   15.12 s  the sea's SHAFT + LOD-fade clone     both, nested
  //   26.10 s  a transparent flat-shaded piece      `fracture.prime`
  //
  // The first three are `duringWarm`'s; the fourth hangs an invisible mesh in
  // the scene and is therefore covered by the `compile(scene, camera)` that
  // opens each pass, which the first assertion here counts.
  it('runs duringWarm once per binding, with that binding bound', () => {
    const { scene, camera, root } = world()
    const ocean = new THREE.Group()
    ocean.name = 'ocean'
    scene.add(ocean)
    const { renderer, calls } = fakeRenderer(root, scene)

    const variants = ['two-sided+shaft', 'two-sided', 'shaft', 'above'] as const
    const built: { variant: string; target: unknown }[] = []
    warmWorld(
      renderer,
      scene,
      camera,
      root,
      {
        offscreen: true,
        alsoDefaultTarget: true,
        duringWarm: (compile) => {
          for (const variant of variants) {
            built.push({ variant, target: renderer.getRenderTarget() })
            compile(ocean)
          }
        },
      },
      () => 0,
    )

    // Every variant, at both bindings — eight builds of four variants.
    expect(built.length).toBe(variants.length * 2)
    for (const variant of variants) {
      const targets = built.filter((b) => b.variant === variant).map((b) => b.target)
      expect(targets.length, `${variant} built at both bindings`).toBe(2)
      expect(targets[0], `${variant} at the composer target`).not.toBeNull()
      expect(targets[1], `${variant} at the session's default target`).toBeNull()
    }
    // And each `compile(ocean)` really was scoped to the root it was handed.
    const handed = calls.filter((c) => c.handed === 'ocean')
    expect(handed.length).toBe(variants.length * 2)
  })

  it('warms the shaft’s own roots at both bindings, under the room’s lamp', () => {
    // DEV-152's pass is per binding for the same reason the rest is: the ride
    // is drawn in a session as readily as on a monitor, and the start grid
    // first draws 44 m up either way.
    const { scene, camera, root } = world()
    const room = new THREE.Group()
    room.name = 'launch-room'
    room.add(new THREE.PointLight())
    scene.add(room)
    const deck = new THREE.Group()
    deck.name = 'start-grid'
    deck.add(new THREE.Mesh(new THREE.BufferGeometry()))
    scene.add(deck)
    const { renderer, calls } = fakeRenderer(root, scene)

    warmWorld(
      renderer,
      scene,
      camera,
      root,
      { offscreen: true, alsoDefaultTarget: true, hide: [room], shaftLit: [deck] },
      () => 0,
    )

    const deckCalls = calls.filter((c) => c.handed === 'start-grid')
    expect(deckCalls.length, 'the deck is compiled at both bindings').toBe(2)
    expect(deckCalls[0]?.target, 'once on the composer target').not.toBeNull()
    expect(deckCalls[1]?.target, 'and once on the session’s').toBeNull()
    for (const c of deckCalls)
      expect(c.visibleNames, 'both under the room lamp — DEV-152').toContain('launch-room')
    expect(room.visible).toBe(true)
    expect(deck.visible).toBe(true)
  })

  it('still hands the caller its own binding back', () => {
    const { scene, camera, root } = world()
    const { renderer, currentTarget } = fakeRenderer(root)
    const previous = new THREE.WebGLRenderTarget(4, 4)
    renderer.setRenderTarget(previous)
    warmWorld(renderer, scene, camera, root, { offscreen: true, alsoDefaultTarget: true }, () => 0)
    expect(currentTarget()).toBe(previous)
  })
})

// ── DEV-250: `show` — the mirror of `hide` ─────────────────────────────────
//
// The HUD's canvas is rasterised for the first time at its FLIGHT layout on
// the frame the player is released, and that raster runs in the GPU process
// for 26.75 ms while the main thread waits (`docs/plan/HUD-REWORK.md` §1).
// `Hud.warm` paints the panel under the curtain; `show` is what puts it in
// the draw that uploads it, because `warmWorld` renders the whole scene and
// three's `projectObject` wants three things of a mesh that this draw
// satisfies by accident or not at all:
//
//     if ( object.visible === false ) return;
//     const visible = object.layers.test( camera.layers );
//     ...
//     } else if ( object.isMesh || object.isLine || object.isPoints ) {
//       if ( ! object.frustumCulled || _frustum.intersectsObject( object ) ) {
//
// — read out of `three.module.js` and asserted below against a real three
// `Frustum`, not against a memory of it. Two details of that code decide the
// shape of the option: the frustum test is SHORT-CIRCUITED by the flag, which
// is what makes the warm independent of where the camera happens to be
// pointing during boot; and children are recursed OUTSIDE the layer test but
// inside the visibility return, so one hidden ANCESTOR removes the whole
// subtree while a wrong layer removes only the node itself.
describe('warmWorld — show, DEV-250', () => {
  /** A panel parented three deep, off-camera, on a layer of its own. */
  const panelWorld = () => {
    const w = world()
    const ship = new THREE.Group()
    ship.name = 'ship'
    const pivot = new THREE.Group()
    pivot.name = 'art-pivot'
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.145))
    panel.name = 'hud'
    pivot.add(panel)
    ship.add(pivot)
    w.scene.add(ship)
    return { ...w, ship, pivot, panel }
  }

  /** What `projectObject` would decide, using three's own `Frustum`. */
  const wouldDraw = (o: THREE.Object3D, camera: THREE.Camera): boolean => {
    for (let n: THREE.Object3D | null = o; n !== null; n = n.parent) if (!n.visible) return false
    if (!o.layers.test(camera.layers)) return false
    if (o.frustumCulled === false) return true
    o.updateWorldMatrix(true, false)
    const m = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    )
    return new THREE.Frustum().setFromProjectionMatrix(m).intersectsObject(o as THREE.Mesh)
  }

  it('forces a panel into the draw that three would otherwise skip three ways over', () => {
    const { scene, camera, root, panel, ship } = panelWorld()
    // Every one of the three gates, shut. Not a contrived pile-up: at the
    // moment `warmWorld` runs the frame loop may not have shown the ship yet,
    // the camera is wherever the title left it, and `bloom.ts`'s classify pass
    // may or may not have moved the panel onto `UI_LAYER` — a race.
    ship.visible = false
    panel.position.set(0, 0, 4000) // behind the camera, far outside the frustum
    panel.layers.set(3)
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    expect(
      wouldDraw(panel, camera),
      'the panel must start undrawable, or this proves nothing',
    ).toBe(false)

    let drawn: boolean | null = null
    const { renderer } = fakeRenderer(root, scene)
    const watching: WarmUpRenderer = {
      ...renderer,
      render: () => {
        drawn = wouldDraw(panel, camera)
      },
    }
    const r = warmWorld(watching, scene, camera, root, { offscreen: true, show: [panel] }, () => 0)
    expect(drawn, 'the panel was not in the warm draw, so its texture never uploaded').toBe(true)
    expect(r.shown, 'one drawable forced in').toBe(1)
  })

  it('puts visibility, culling and the layer mask back exactly as found', () => {
    const { scene, camera, root, panel, ship, pivot } = panelWorld()
    ship.visible = false
    pivot.visible = false
    panel.layers.set(3)
    const mask = panel.layers.mask
    const { renderer } = fakeRenderer(root, scene)
    warmWorld(renderer, scene, camera, root, { offscreen: true, show: [panel] }, () => 0)
    expect(ship.visible, 'the ancestor it un-hid').toBe(false)
    expect(pivot.visible, 'and the one above that').toBe(false)
    expect(panel.visible).toBe(true)
    expect(panel.frustumCulled, 'culling back on').toBe(true)
    expect(panel.layers.mask, 'the mask is the object’s own again').toBe(mask)
  })

  it('restores on a throw too — a lost context must not leave the panel widened', () => {
    const { scene, camera, root, panel, ship } = panelWorld()
    ship.visible = false
    panel.layers.set(3)
    const mask = panel.layers.mask
    const { renderer } = fakeRenderer(root, scene)
    const throwing: WarmUpRenderer = {
      ...renderer,
      render: () => {
        throw new Error('context lost')
      },
    }
    expect(() =>
      warmWorld(throwing, scene, camera, root, { offscreen: true, show: [panel] }, () => 0),
    ).toThrow('context lost')
    expect(ship.visible).toBe(false)
    expect(panel.frustumCulled).toBe(true)
    expect(panel.layers.mask).toBe(mask)
  })

  it('widens the OBJECT’s mask and never the CAMERA’s — a light count would move', () => {
    // The decision this option turns on. `WebGLRenderer.projectObject` gathers
    // lights inside `if ( object.layers.test( camera.layers ) )`, so a camera
    // that can suddenly see one more layer can collect one more LIGHT — and
    // `numPointLights` is field #36 of three's program cache key. That would
    // rebuild every key the warm-up exists to build at the FLIGHT's count,
    // which is DEV-152's whole subject and DEV-117's before it.
    const { scene, camera, root, panel } = panelWorld()
    panel.layers.set(3)
    // A lamp on the same layer as the panel, which the camera cannot see.
    const stray = new THREE.PointLight()
    stray.name = 'stray-lamp'
    stray.layers.set(3)
    const strayMask = stray.layers.mask
    scene.add(stray)
    const cameraMask = camera.layers.mask

    let lampsCollected = -1
    const { renderer } = fakeRenderer(root, scene)
    const counting: WarmUpRenderer = {
      ...renderer,
      render: () => {
        lampsCollected = 0
        scene.traverseVisible((o) => {
          if ((o as THREE.Light).isLight && o.layers.test(camera.layers)) lampsCollected++
        })
      },
    }
    warmWorld(counting, scene, camera, root, { offscreen: true, show: [panel] }, () => 0)
    expect(lampsCollected, 'the stray lamp entered the warm draw’s light set').toBe(0)
    expect(camera.layers.mask, 'the camera’s mask was touched').toBe(cameraMask)
    expect(stray.layers.mask, 'a Light in the scene was widened').toBe(strayMask)
  })

  it('leaves a Light inside a shown subtree alone — drawables only', () => {
    const { scene, camera, root, panel } = panelWorld()
    const lamp = new THREE.PointLight()
    lamp.layers.set(3)
    const mask = lamp.layers.mask
    panel.add(lamp)
    const { renderer } = fakeRenderer(root, scene)
    const r = warmWorld(renderer, scene, camera, root, { offscreen: true, show: [panel] }, () => 0)
    expect(lamp.layers.mask, 'a lamp under the panel must not be widened').toBe(mask)
    expect(r.shown, 'and it is not counted as a drawable either').toBe(1)
  })

  it('does not disturb DEV-117’s own count of meshes unculled under root', () => {
    // `meshes` is DEV-117's number and `show` appends to the same list, so a
    // subtraction at the end would have been wrong by however many `show`
    // drawables were already unculled by their owner. Snapshot, not arithmetic.
    const { scene, camera, root, panel } = panelWorld()
    panel.frustumCulled = false // already off, like the sky dome
    const { renderer } = fakeRenderer(root, scene)
    const r = warmWorld(renderer, scene, camera, root, { offscreen: true, show: [panel] }, () => 0)
    expect(r.meshes, 'two under root; the third was already off').toBe(2)
    expect(r.shown, 'and the panel is counted here instead').toBe(1)
    expect(panel.frustumCulled, 'and it stays off, because that is how it was found').toBe(false)
  })

  it('is a no-op when nothing is shown, which is the shipped default', () => {
    const { scene, camera, root, panel, ship } = panelWorld()
    ship.visible = false
    const { renderer, calls } = fakeRenderer(root, scene)
    const r = warmWorld(renderer, scene, camera, root, { offscreen: true }, () => 0)
    expect(r.shown).toBe(0)
    expect(ship.visible, 'nothing was un-hidden').toBe(false)
    expect(panel.frustumCulled).toBe(true)
    expect(calls.map((c) => c.kind)).toEqual(['render', 'compile'])
  })
})
