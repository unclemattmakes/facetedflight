// tests/unit/draw-order.test.ts — DEV-238, made the default by DEV-241 and
// joined by DEV-246. What decides submission order, and three switches that
// ARE the default now.
//
// ── What DEV-246 added ───────────────────────────────────────────────────
//
// §2e, the vehicle. Same shape as §2a and §2b and one thing more: its
// assertions run three's OWN comparison over a list of real render items —
// the key order is read out of `three.module.js` the way §1 reads it — so
// they say *the cockpit sorts ahead of the island* rather than *its
// renderOrder is -1*. And the cabin in them is the REAL one:
// `buildCockpitBody()` needs no GL context and no GLB, so the twenty-one
// drawables the row is about are held rather than stood in for.
//
// Four of §2e's eleven are red on a `setCockpitFirst` that does nothing,
// checked by stubbing the body and running them: the pin does not take, the
// eligible set is wrong, the refusal set is wrong, and a mesh born after the
// call is missed. The other seven are guards — restore, idempotency, the
// refusal to touch a mesh somebody else ordered — which a no-op satisfies
// trivially and a WRONG implementation does not.
//
// ── What DEV-241 changed here ────────────────────────────────────────────
//
// The switches are thrown at CONSTRUCTION — `render/sky.ts` on the dome it has
// just built, `game/terrain/load-terrain.ts` on a water terrain's chunks — so
// `false` is the A/B arm and what it restores is what those two constructors
// made. §2 therefore tests two things it did not before: that the SHIPPED
// object arrives in the new order (§2d, through `createSkyDomeMesh`, which is
// exported so a node test can hold the real dome without a GL context), and
// that the OFF arm is the pre-DEV-241 frame rather than a second opinion about
// what that frame was.
//
// ── The oracle is three's own build, not a belief about it ───────────────
//
// §1 READS `painterSortStable` out of `node_modules/three/build/three.module.js`
// and asserts the ORDER OF ITS COMPARISONS. That matters because the fact
// `render/draw-order.ts` is built on is counter-intuitive and is not API:
//
//     groupOrder -> renderOrder -> material.id -> materialVariant -> z
//
// `material.id` comes BEFORE `z`, so "opaques are drawn front to back" is true
// only within one material. Everything the two switches are for follows from
// that, and `three` is pinned exact — so if an upgrade reorders those branches
// this file is the measured result that upgrade is supposed to land with
// (CLAUDE.md: *every dependency upgrade lands alone, with a measured result*).
// `xr-eye-layers.test.ts` reads three the same way for the same reason.
//
// §2 is the switches, and the assertions are RELATIONSHIPS rather than
// literals — 1 and 2 are arbitrary and the facts about them are not. A test
// that says `expect(renderOrder).toBe(1)` re-states the implementation; one
// that says *the ocean now sorts after the terrain and before the motes* is
// true independently of which numbers were picked. That is the orientation
// lesson applied to a sort key.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PROPS } from '@/generated/constants.generated'
import { buildCockpitBody } from '@/render/cockpit-body'
import {
  COCKPIT_FIRST_ORDER,
  captureDrawOrder,
  drawRuns,
  OCEAN_LATE_ORDER,
  SKY_FAR_PIN_DEFINE,
  SKY_FIRST_ORDER,
  SKY_LAST_ORDER,
  setCockpitFirst,
  setOceanLate,
  setSkyLast,
} from '@/render/draw-order'
import { createSkyDomeMesh } from '@/render/sky'
import { type WarmUpRenderer, warmWorld } from '@/render/warm-up'
import { REPO as ROOT } from './helpers/repo-root'

describe('§1 three decides opaque order by material BEFORE depth', () => {
  const source = (): string =>
    fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

  /** The keys `painterSortStable` compares, in the order it compares them. */
  const opaqueSortKeys = (): string[] => {
    const text = source()
    const start = text.indexOf('function painterSortStable(')
    expect(start, 'three no longer has painterSortStable').toBeGreaterThan(-1)
    const end = text.indexOf('function reversePainterSortStable(', start)
    expect(end, 'painterSortStable is no longer followed by its reverse').toBeGreaterThan(start)
    const body = text.slice(start, end)
    return [...body.matchAll(/a\.([\w.]+)\s*!==\s*b\.\1/g)].map((m) => m[1] as string)
  }

  it('compares renderOrder, then material.id, then z — in that order', () => {
    const keys = opaqueSortKeys()
    const at = (k: string): number => keys.indexOf(k)
    for (const key of ['groupOrder', 'renderOrder', 'material.id', 'z']) {
      expect(keys, `painterSortStable no longer compares ${key}`).toContain(key)
    }
    // The three relationships the switches rest on, each true whatever else
    // three adds between them.
    expect(at('groupOrder'), 'groupOrder must outrank renderOrder').toBeLessThan(at('renderOrder'))
    expect(
      at('renderOrder'),
      'renderOrder must outrank material.id, or a renderOrder switch does nothing',
    ).toBeLessThan(at('material.id'))
    expect(
      at('material.id'),
      'material.id must outrank z — this is the whole reason the order is not depth today',
    ).toBeLessThan(at('z'))
  })

  it('sorts the TRANSPARENT list by depth without consulting the material', () => {
    // The contrast is what makes the finding legible rather than a curiosity:
    // three really does sort one of its two lists by depth, and it is the
    // other one. Nothing in the ocean or the terrain is in it.
    const text = source()
    const start = text.indexOf('function reversePainterSortStable(')
    const end = text.indexOf('function', start + 10)
    const body = text.slice(start, end > start ? end : start + 600)
    const keys = [...body.matchAll(/a\.([\w.]+)\s*!==\s*b\.\1/g)].map((m) => m[1] as string)
    expect(keys).toContain('z')
    expect(
      keys,
      'the transparent sort is the depth one; it must not group by material',
    ).not.toContain('material.id')
  })
})

describe('§2a the ocean-late default, and the arm that takes it off', () => {
  /** A stand-in ocean: a group of chunk meshes, as `load-terrain.ts` builds it. */
  const oceanGroup = (): THREE.Group => {
    const group = new THREE.Group()
    group.name = 'world-ocean'
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
      mesh.name = `chunk_${i}_0`
      group.add(mesh)
    }
    // A non-mesh child, because a group carries them and a switch that touched
    // one would be reporting a number it did not earn.
    group.add(new THREE.Object3D())
    return group
  }

  /** A land chunk, built the way `load-terrain.ts` builds one: nothing set. */
  const landChunk = (): THREE.Mesh =>
    new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())

  it('sorts the sea after the opaque terrain and before the motes', () => {
    // The relationship, not the number. `render/motes.ts` is 9 and the gate
    // spray 10; the terrain is whatever a plain mesh is. A default that put the
    // sea past the motes would be reordering two things and reporting one.
    expect(OCEAN_LATE_ORDER).toBeGreaterThan(landChunk().renderOrder)
    expect(OCEAN_LATE_ORDER).toBeLessThan(9)
  })

  it('moves every mesh and nothing else', () => {
    const group = oceanGroup()
    const report = setOceanLate(group, true)
    expect(report.seen).toBe(4)
    expect(report.moved).toBe(4)
    expect(report.on).toBe(true)
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) expect(o.renderOrder).toBe(OCEAN_LATE_ORDER)
      else expect(o.renderOrder).toBe(0)
    })
  })

  it('the ARM puts the sea back LEVEL with the land, not at a number of its own', () => {
    // DEV-241's inversion, and the assertion is deliberately a comparison
    // against a freshly built land chunk rather than against `0`. Level with
    // the land is the property the pre-DEV-241 frame HAD — the sea and the
    // island sorted by `material.id` because nothing else separated them — and
    // it stays true if three's default ever moves or the terrain is given an
    // order of its own, where a literal 0 would quietly stop meaning it
    // (trap 24: assert the relationship, not the value).
    const group = oceanGroup()
    setOceanLate(group, true)
    setOceanLate(group, false)
    for (const child of group.children) {
      expect(child.renderOrder).toBe(landChunk().renderOrder)
    }
  })

  it('restores the EXACT constructed order, including one that was not zero', () => {
    // A band that already carried an order is the case a "set it back to 0"
    // implementation gets wrong, and it would get it wrong silently: the sea
    // would go on drawing in an order nobody asked for, for the rest of the
    // session, after an arm that reported itself cleared.
    const group = oceanGroup()
    const odd = group.children[1] as THREE.Object3D
    odd.renderOrder = 7
    setOceanLate(group, true)
    expect(odd.renderOrder).toBe(OCEAN_LATE_ORDER)
    setOceanLate(group, false)
    expect(odd.renderOrder).toBe(7)
    for (const child of group.children) {
      if (child === odd) continue
      expect(child.renderOrder).toBe(landChunk().renderOrder)
    }
  })

  it('is idempotent, so a sweep that re-asserts the default pays nothing', () => {
    // And this is the reading the trace spec's mechanism line has to survive:
    // re-asserting the DEFAULT on a level that has just loaded reports
    // `moved: 0`, which is not a dead arm. `on` and `seen` are what is true.
    const group = oceanGroup()
    setOceanLate(group, true)
    const again = setOceanLate(group, true)
    expect(again.moved).toBe(0)
    expect(again.on).toBe(true)
    expect(again.seen).toBe(4)
    setOceanLate(group, false)
    expect(setOceanLate(group, false).moved).toBe(0)
  })

  it('reports seen: 0 rather than throwing before the level lands', () => {
    // `seen: 0` is what an arm reads as ARM DID NOT FIRE. A throw here would
    // fail the run for a timing question that has a correct answer.
    expect(setOceanLate(null, true)).toEqual({ moved: 0, seen: 0, on: false })
  })
})

describe('§2b the sky-last default, and the arm that takes it off', () => {
  /** The dome exactly as `render/sky.ts` ships it — defaults already thrown. */
  const dome = (): THREE.Mesh => createSkyDomeMesh(new THREE.BufferGeometry())

  const materialOf = (mesh: THREE.Mesh): THREE.Material => mesh.material as THREE.Material

  it('sorts the dome after the sea and before the horizon band', () => {
    // The relationship again. `render/horizon.ts` is 5 and is drawn OVER the
    // sky on purpose; the sea under this wave's other default is 1. The sky
    // going last among the WORLD's opaques is a different claim from the sky
    // going last in the frame, and only the first one is being made.
    expect(SKY_LAST_ORDER).toBeGreaterThan(OCEAN_LATE_ORDER)
    expect(SKY_LAST_ORDER).toBeLessThan(5)
  })

  it('SHIPS drawn last, depth-tested, writing no depth, pinned', () => {
    // DEV-241, and the one that fails on the unfixed build: before it, the
    // dome `sky.ts` handed back was at SKY_FIRST_ORDER with `depthTest: false`
    // and carried no define at all.
    const mesh = dome()
    const material = materialOf(mesh)
    expect(mesh.renderOrder, 'the shipped dome is not drawn last').toBe(SKY_LAST_ORDER)
    expect(material.depthTest, 'the shipped dome is not depth-tested').toBe(true)
    expect(material.depthWrite, 'the shipped dome writes depth').toBe(false)
    expect(
      material.defines?.[SKY_FAR_PIN_DEFINE],
      'the shipped dome is drawn last WITHOUT the far-plane pin — a 1000 m dome would ' +
        'then occlude a 6000 m world',
    ).toBeDefined()
  })

  it('turns the depth test back ON and never writes depth', () => {
    // Both halves, because either alone is wrong. depthTest without the
    // far-plane pin would let a 1000 m dome occlude a 4 km island (SKY_RADIUS
    // is 1000 against CAMERA_FAR 6000); depthWrite would put the dome's depth
    // in the buffer and z-fight everything drawn after it.
    const mesh = dome()
    const report = setSkyLast(mesh, true)
    expect(report.on).toBe(true)
    expect(report.depthTest).toBe(true)
    expect(report.depthWrite).toBe(false)
    expect(report.pinned).toBe(true)
    expect(mesh.renderOrder).toBe(SKY_LAST_ORDER)
  })

  it('the ARM puts the dome back exactly as the constructor built it', () => {
    // The pre-DEV-241 background, which is the build every wave-3 and wave-4
    // baseline was taken on. `SKY_FIRST_ORDER` is imported rather than written
    // out here because `sky.ts` builds the mesh from the same constant — so
    // this is one authority checked, not the same number typed twice.
    const mesh = dome()
    const material = materialOf(mesh)
    const report = setSkyLast(mesh, false)
    expect(mesh.renderOrder).toBe(SKY_FIRST_ORDER)
    expect(material.depthTest).toBe(false)
    expect(material.depthWrite).toBe(false)
    expect(report.pinned).toBe(false)
    expect(material.defines?.[SKY_FAR_PIN_DEFINE]).toBeUndefined()
  })

  it('and back on again, which is what closes a bracket', () => {
    const mesh = dome()
    const material = materialOf(mesh)
    setSkyLast(mesh, false)
    const back = setSkyLast(mesh, true)
    expect(mesh.renderOrder).toBe(SKY_LAST_ORDER)
    expect(material.depthTest).toBe(true)
    expect(back.pinned).toBe(true)
  })

  it('reaches the same define ORDER whichever route it took', () => {
    // DEV-194, in the form that cost a 318 ms compile in the air: three walks
    // `defines` with `for…in`, so a name that leaves and comes back lands at
    // the END and the key becomes a function of the run's HISTORY. A sweep that
    // throws this arm and clears it mid-flight is exactly that route, and it is
    // reachable now that the arm is a subtraction from the shipped build.
    const fresh = dome()
    const flipped = dome()
    setSkyLast(flipped, false)
    setSkyLast(flipped, true)
    expect(Object.keys((flipped.material as THREE.Material).defines ?? {})).toEqual(
      Object.keys((fresh.material as THREE.Material).defines ?? {}),
    )
  })

  it('pins the clip-space z to the far plane, in the VERTEX shader', () => {
    // `gl_Position.z = gl_Position.w` is a plane in clip space, so the near
    // clipper interpolates it exactly and a dome triangle straddling the eye
    // still lands on the far plane. A fragment-shader depth write would not
    // have that property and would also cost early-Z everywhere.
    const mesh = dome()
    const material = materialOf(mesh)
    const shader = {
      uniforms: {},
      vertexShader: 'void main() {\n  gl_Position = vec4(0.0);\n}',
      fragmentShader: '',
    }
    material.onBeforeCompile?.(shader as never, null as never)
    expect(shader.vertexShader).toContain(`#ifdef ${SKY_FAR_PIN_DEFINE}`)
    expect(shader.vertexShader).toContain('gl_Position.z = gl_Position.w;')
    // And the pin is INSIDE main, after the position is computed. Above it, it
    // would be overwritten by the very next line and the switch would be a
    // no-op that reported itself on.
    expect(shader.vertexShader.indexOf('gl_Position = vec4(0.0);')).toBeLessThan(
      shader.vertexShader.indexOf('gl_Position.z = gl_Position.w;'),
    )
  })

  it('changes the program cache key, because onBeforeCompile does not', () => {
    // `render/program-cache-key.ts`: three hashes `defines` and the numeric
    // parameters and NOT the patch function, so two materials differing only
    // in their patch share one program and whichever compiled first wins. A
    // default that patched without tagging would draw the unpinned dome while
    // reporting itself pinned.
    const shipped = materialOf(dome()) as THREE.Material & {
      customProgramCacheKey: () => string
    }
    const plain = new THREE.MeshBasicMaterial() as THREE.Material & {
      customProgramCacheKey: () => string
    }
    expect(shipped.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey())
  })

  it('reports seen: 0 rather than throwing before the sky lands', () => {
    expect(setSkyLast(null, true).seen).toBe(0)
  })
})

describe('§2d what else is in the frame still composes with a dome drawn LAST', () => {
  // The one general risk the move creates, stated as a condition rather than
  // as a list of files: the dome at `z = w` under `LEQUAL` passes only where
  // the depth buffer is still at its cleared 1.0, so **an OPAQUE object
  // submitted before it must write depth** or the dome paints over it.
  //
  // Three groups of objects in `src/` set `depthWrite: false`. Two are safe by
  // a property three guarantees — everything transparent is in the other
  // render list and is drawn after every opaque whatever its `renderOrder`.
  // The third is the ring frames, the finish gate's frame and the turn
  // indicators, and they are transparent only because a GENERATED CONSTANT
  // says so. That is the one that can change under us, so that is the one
  // asserted here.

  it('the ring and finish-gate frames are transparent, which is what keeps them safe', () => {
    // `game/rings.ts` and `game/turn-indicators.ts` build these with
    // `transparent: ring.frameBlends` and `depthWrite: false`. `frameBlends` is
    // the 2016 material's own `m_ShaderKeywords`, not a guess from the alpha —
    // so if an extraction ever flips it to false those three meshes move into
    // the OPAQUE list at renderOrder 0, still writing no depth, and the sky
    // would paint over every gate silhouetted against it.
    //
    // A picture bug that would be invisible to every ordering assertion in this
    // file, found instead by a sheet the port already consults (DEV-069: when
    // you implement something the sheet has a key for, import the key).
    expect(
      PROPS.checkpointRing.frameBlends,
      'the ring frame is no longer transparent — it is opaque, writes no depth, and ' +
        'sits at renderOrder 0, so a dome drawn last will paint over it',
    ).toBe(true)
    expect(
      PROPS.finishGate.frameBlends,
      'the finish gate frame is no longer transparent — see the ring frame above',
    ).toBe(true)
  })

  it('the ring STUDS write depth, which is what keeps THEM safe', () => {
    // The other half of the same pair, and the reason the frames are the only
    // exposure: a stud is `depthWrite: !studBlends`, so the moment it is opaque
    // it writes depth and the dome is rejected. The two flags have to stay
    // opposite for that to hold.
    expect(PROPS.checkpointRing.studBlends).toBe(false)
  })
})

describe('§2e the cockpit-first default, and the arm that takes it off', () => {
  // DEV-246, and Matt's question: *"would it make sense to draw the cockpit
  // before the environment so the pixels it blocks aren't drawn?"*
  //
  // The oracle for "before" is three's OWN comparison order, read out of the
  // pinned build by §1 and used here to sort real render items — so these
  // tests say *the cockpit sorts ahead of the terrain* rather than *the
  // cockpit's renderOrder is -1*, which is the implementation written twice
  // (trap 24, and the orientation lesson applied to a sort key).
  //
  // The cabin is the REAL one. `buildCockpitBody()` needs no GL context and no
  // GLB, so the twenty-one drawables this row is about can be held here rather
  // than stood in for — the same reason `createSkyDomeMesh` is exported for
  // §2b.

  /** The keys `painterSortStable` compares, in the order three compares them. */
  const sortKeys = (): string[] => {
    const text = fs.readFileSync(
      path.join(ROOT, 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    const start = text.indexOf('function painterSortStable(')
    const end = text.indexOf('function reversePainterSortStable(', start)
    expect(start, 'three no longer has painterSortStable').toBeGreaterThan(-1)
    expect(end, 'painterSortStable is no longer followed by its reverse').toBeGreaterThan(start)
    return [...text.slice(start, end).matchAll(/a\.([\w.]+)\s*!==\s*b\.\1/g)].map(
      (m) => m[1] as string,
    )
  }

  interface Item {
    readonly label: string
    readonly object: THREE.Object3D
    readonly material: THREE.Material
    /** Camera-space depth. Every value here is negative-z-forward, as three's is. */
    readonly z: number
  }

  const read = (item: Item, key: string): number => {
    if (key === 'groupOrder') return 0
    if (key === 'renderOrder') return item.object.renderOrder
    if (key === 'material.id') return (item.material as unknown as { id: number }).id
    if (key === 'materialVariant') return 0
    if (key === 'z') return item.z
    throw new Error(`painterSortStable compares a key this test does not model: ${key}`)
  }

  /**
   * Three's opaque order over a list, with the comparison built FROM three's
   * own source rather than from a belief about it. `painterSortStable` falls
   * through to `a.id - b.id`, which is insertion order; the list is built in
   * construction order, so index is that id.
   */
  const painterSort = (items: readonly Item[]): Item[] => {
    const keys = sortKeys()
    const indexed = items.map((item, id) => ({ item, id }))
    indexed.sort((a, b) => {
      for (const key of keys) {
        const av = read(a.item, key)
        const bv = read(b.item, key)
        if (av !== bv) return av - bv
      }
      return a.id - b.id
    })
    return indexed.map((e) => e.item)
  }

  /**
   * The frame as the probe measured it on `int_01_hoverJet`, in CONSTRUCTION
   * order, with the material ids that produced the accident.
   *
   * The hull's material is created while the ship's GLB loads (id 97 in the
   * measured frame) and the cabin's four are created when a preset first asks
   * for the interior (254–257), while the terrain's chunk material lands
   * between them. That is the whole of why the vehicle came out as two runs
   * 318 submissions apart — and it is why a stand-in here has to reproduce the
   * ID ORDER and not just the objects.
   */
  const measuredFrame = (): {
    items: Item[]
    cockpit: THREE.Object3D[]
    chunks: THREE.Object3D[]
  } => {
    const items: Item[] = []
    const cockpit: THREE.Object3D[] = []
    const chunks: THREE.Object3D[] = []
    const add = (
      label: string,
      object: THREE.Object3D,
      material: THREE.Material,
      z: number,
    ): void => {
      items.push({ label, object, material, z })
    }
    // 1. the hull, whose material is born first — the half of the accident
    //    that landed the right way up.
    const hullMat = new THREE.MeshStandardMaterial({ name: 'lambert1' })
    const hull = new THREE.Mesh(new THREE.BufferGeometry(), hullMat)
    hull.name = 'polySurface25'
    cockpit.push(hull)
    add('hull', hull, hullMat, -0.8)
    // 2. the terrain, born next.
    const chunkMat = new THREE.MeshStandardMaterial({ name: 'chunk' })
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), chunkMat)
      mesh.name = `chunk_${i}_0`
      chunks.push(mesh)
      add(`chunk_${i}`, mesh, chunkMat, -200 - i * 100)
    }
    // 3. the cabin, born LAST, which is the half that did not.
    const cabin = buildCockpitBody()
    cabin.object.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      cockpit.push(mesh)
      add(`cabin/${mesh.name}`, mesh, mesh.material as THREE.Material, -0.5)
    })
    return { items, cockpit, chunks }
  }

  /** A vehicle group shaped like the measured one: hull, cabin, HUD. */
  const vehicleGroup = (): {
    group: THREE.Group
    hull: THREE.Mesh
    cabin: THREE.Object3D
    hud: THREE.Mesh
  } => {
    const group = new THREE.Group()
    group.name = 'hoverjet'
    const artPivot = new THREE.Group()
    artPivot.name = 'art_pivot'
    group.add(artPivot)
    const hull = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    hull.name = 'polySurface25'
    artPivot.add(hull)
    const cabin = buildCockpitBody().object
    artPivot.add(cabin)
    // The HUD, exactly as `render/hud.ts` builds it: transparent, no depth
    // write, no depth test, renderOrder 10. Three independent reasons to be
    // ineligible, which is the point of including it.
    const hud = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false }),
    )
    hud.name = 'hud'
    hud.renderOrder = 10
    group.add(hud)
    // A non-mesh child, as `setOceanLate`'s stand-in has, so a switch that
    // counted one would be reporting a number it did not earn.
    group.add(new THREE.Object3D())
    return { group, hull, cabin, hud }
  }

  const cabinMeshes = (cabin: THREE.Object3D): THREE.Mesh[] => {
    const out: THREE.Mesh[] = []
    cabin.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh)
    })
    return out
  }

  it('sorts the vehicle before the terrain, the sea and the dome', () => {
    // The relationship over the three constants, which is the claim in one
    // line: the opaque world runs cockpit -1, terrain 0, ocean 1, sky 2.
    const plainChunk = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    expect(COCKPIT_FIRST_ORDER).toBeLessThan(plainChunk.renderOrder)
    expect(COCKPIT_FIRST_ORDER).toBeLessThan(OCEAN_LATE_ORDER)
    expect(COCKPIT_FIRST_ORDER).toBeLessThan(SKY_LAST_ORDER)
  })

  it('the UNFIXED frame really does sort the cabin after the whole island', () => {
    // The finding, reproduced from the material ids alone and with no switch
    // thrown. If this ever stops being true the row's premise is gone and the
    // test below is asserting something that was never broken.
    const { items, chunks } = measuredFrame()
    const order = painterSort(items).map((i) => i.label)
    const lastChunk = Math.max(...chunks.map((c) => order.indexOf(`chunk_${c.name.slice(6, 7)}`)))
    const firstCabin = Math.min(
      ...order.map((l, i) => (l.startsWith('cabin/') ? i : Number.POSITIVE_INFINITY)),
    )
    expect(order[0], 'the hull was not the accident that landed early').toBe('hull')
    expect(
      firstCabin,
      'the cabin already sorts before the terrain without the pin — DEV-246 has no premise',
    ).toBeGreaterThan(lastChunk)
  })

  it('pins the cabin AHEAD of the island, which is the whole of the change', () => {
    const { items, cockpit, chunks } = measuredFrame()
    const group = new THREE.Group()
    for (const o of cockpit) group.add(o)
    const report = setCockpitFirst(group, true)
    expect(report.on).toBe(true)
    expect(report.seen, 'the switch owned no vehicle mesh').toBe(cockpit.length)

    const order = painterSort(items)
    const lastVehicle = Math.max(
      ...order.map((item, i) => (cockpit.includes(item.object) ? i : -1)),
    )
    const firstChunk = Math.min(
      ...order.map((item, i) => (chunks.includes(item.object) ? i : Number.POSITIVE_INFINITY)),
    )
    expect(
      lastVehicle,
      'a vehicle draw is still submitted after a terrain chunk — the pin did not take',
    ).toBeLessThan(firstChunk)
  })

  it('moves every eligible mesh and leaves the HUD exactly where it was', () => {
    const { group, hull, cabin, hud } = vehicleGroup()
    const cabinCount = cabinMeshes(cabin).length
    expect(cabinCount, 'the real cabin built no meshes').toBeGreaterThan(0)
    const report = setCockpitFirst(group, true)
    expect(report.on).toBe(true)
    expect(report.seen).toBe(1 + cabinCount)
    expect(report.moved).toBe(1 + cabinCount)
    // The HUD and the bare Object3D. One is a drawable the switch refused, the
    // other is not a drawable at all, and only the first is `skipped`.
    expect(report.skipped).toBe(1)
    expect(hull.renderOrder).toBe(COCKPIT_FIRST_ORDER)
    for (const mesh of cabinMeshes(cabin)) expect(mesh.renderOrder).toBe(COCKPIT_FIRST_ORDER)
    expect(hud.renderOrder, 'the transparent HUD was dragged into the opaque pin').toBe(10)
  })

  it('refuses a mesh that would VANISH if it were drawn early', () => {
    // The condition, as a property of the material rather than as a list of
    // names. Each of these three is a real object in `src/`:
    //
    //   transparent          — the HUD, the plates, the briefing (they are a
    //                          stack against each other, not against the world)
    //   opaque, no depth write — `render/medal.ts`'s outline shell, which
    //                          DEV-241 §5b found at the same seam from the
    //                          other end. Early, the terrain paints over it.
    //   opaque, no depth test  — always draws, so late it paints over the
    //                          world and early the world paints over it.
    const group = new THREE.Group()
    const cases: [string, THREE.Material][] = [
      ['transparent', new THREE.MeshStandardMaterial({ transparent: true })],
      ['no depthWrite', new THREE.MeshStandardMaterial({ depthWrite: false })],
      ['no depthTest', new THREE.MeshStandardMaterial({ depthTest: false })],
    ]
    for (const [name, material] of cases) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
      mesh.name = name
      group.add(mesh)
    }
    const report = setCockpitFirst(group, true)
    expect(report.seen, 'the switch claimed a mesh it must not move').toBe(0)
    expect(report.skipped).toBe(3)
    for (const child of group.children) {
      expect(child.renderOrder, `${child.name} was pinned and must not have been`).toBe(0)
    }
  })

  it('leaves a mesh SOMEBODY has already ordered alone, in both directions', () => {
    // A `renderOrder` that is not three's default is a decision, and this
    // switch exists because the vehicle's position is not one. The ocean's
    // switch takes the opposite view — it moves a band that already carried an
    // order and restores it — and the difference is deliberate: the sea is a
    // closed set this port builds, and the vehicle group is where the plates,
    // the perf plate and the checklist arrive from six other files.
    const { group } = vehicleGroup()
    const dial = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    dial.name = 'somebody-chose-this'
    dial.renderOrder = 4
    group.add(dial)
    setCockpitFirst(group, true)
    expect(dial.renderOrder).toBe(4)
    setCockpitFirst(group, false)
    expect(dial.renderOrder).toBe(4)
  })

  it('the ARM puts the vehicle back LEVEL with the land, not at a number of its own', () => {
    // §2a's assertion in the new place, and for its reason: level with the
    // land is the property the pre-DEV-246 frame HAD — the cabin and the
    // island sorted by `material.id` because nothing else separated them — and
    // it stays true if three's default ever moves.
    const { group, hull, cabin } = vehicleGroup()
    const plainChunk = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    setCockpitFirst(group, true)
    const off = setCockpitFirst(group, false)
    expect(off.on).toBe(false)
    expect(off.moved).toBe(off.seen)
    expect(hull.renderOrder).toBe(plainChunk.renderOrder)
    for (const mesh of cabinMeshes(cabin)) expect(mesh.renderOrder).toBe(plainChunk.renderOrder)
  })

  it('and the ARM really is the pre-DEV-246 frame, by three’s own sort', () => {
    // Not "the numbers went back" — the SEQUENCE went back. The cabin is after
    // the island again, which is the frame wave 4's baselines were taken on.
    const { items, cockpit, chunks } = measuredFrame()
    const group = new THREE.Group()
    for (const o of cockpit) group.add(o)
    setCockpitFirst(group, true)
    setCockpitFirst(group, false)
    const order = painterSort(items)
    const lastChunk = Math.max(...order.map((item, i) => (chunks.includes(item.object) ? i : -1)))
    const cabinAt = order
      .map((item, i) => (item.label.startsWith('cabin/') ? i : -1))
      .filter((i) => i >= 0)
    expect(cabinAt.length).toBeGreaterThan(0)
    expect(
      Math.min(...cabinAt),
      'the OFF arm left the cabin ahead of the island — it is not the pre-DEV-246 frame',
    ).toBeGreaterThan(lastChunk)
  })

  it('is idempotent, so a sweep that re-asserts the default pays nothing', () => {
    const { group } = vehicleGroup()
    const first = setCockpitFirst(group, true)
    const again = setCockpitFirst(group, true)
    expect(again.moved).toBe(0)
    expect(again.on).toBe(true)
    expect(again.seen).toBe(first.seen)
    setCockpitFirst(group, false)
    expect(setCockpitFirst(group, false).moved).toBe(0)
  })

  it('picks up a mesh born after the call — the cabin is LAZY', () => {
    // `render/cockpit-interior.ts` constructs nothing until a preset asks, so
    // the twenty-one draws this row is about do not exist when the loader
    // throws the switch. `game/flight.ts` calls it again from `setInterior`;
    // this is the property that makes that call work rather than double-count.
    const group = new THREE.Group()
    const hull = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    group.add(hull)
    expect(setCockpitFirst(group, true).seen).toBe(1)

    const cabin = buildCockpitBody().object
    group.add(cabin)
    const late = setCockpitFirst(group, true)
    expect(late.seen).toBe(1 + cabinMeshes(cabin).length)
    expect(late.moved, 'the late cabin was not picked up').toBe(cabinMeshes(cabin).length)
    for (const mesh of cabinMeshes(cabin)) expect(mesh.renderOrder).toBe(COCKPIT_FIRST_ORDER)
  })

  it('reports seen: 0 rather than throwing before the level lands', () => {
    // `flight` is null until the mission loads, and `seen: 0` is what an arm
    // reads as ARM DID NOT FIRE. A throw here would fail a 60-second run for a
    // timing question that has a correct answer.
    expect(setCockpitFirst(null, true)).toEqual({ moved: 0, seen: 0, skipped: 0, on: false })
  })
})

describe('§2c a FRAME is a render of the world’s scene', () => {
  /**
   * A renderer stub that does what three does: a world render, then a post
   * pass's `FullScreenQuad`, which calls `renderer.render` again on a scene of
   * its own AFTER the first has returned.
   *
   * That shape is why the first headed run of `tests/e2e/draw-order.spec.ts`
   * reported *"1 submissions this frame"* and one row reading `Mesh / 1
   * triangle`: an outermost-only detector counted the bloom composer's
   * fullscreen triangle as two of three frames.
   */
  const rendererWithPostPass = (): {
    renderer: {
      render: (s: THREE.Object3D, c: THREE.Camera) => void
      renderBufferDirect: (...args: unknown[]) => void
    }
    world: THREE.Scene
    tick: () => void
  } => {
    const world = new THREE.Scene()
    const post = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const worldMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    worldMesh.name = 'world-ocean'
    const quad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    quad.name = 'fullscreen'
    const renderer = {
      render(_scene: THREE.Object3D, _camera: THREE.Camera) {
        const target = _scene === world ? worldMesh : quad
        ;(
          renderer as unknown as {
            renderBufferDirect: (
              c: THREE.Camera,
              s: THREE.Object3D | null,
              g: THREE.BufferGeometry,
              m: THREE.Material,
              o: THREE.Object3D,
              gr: null,
            ) => void
          }
        ).renderBufferDirect(
          _camera,
          _scene,
          target.geometry,
          target.material as THREE.Material,
          target,
          null,
        )
      },
      renderBufferDirect() {},
    }
    return {
      renderer,
      world,
      tick: () => {
        renderer.render(world, camera)
        // The post pass, outermost and not nested — this is the one an
        // outermost-only detector lets through.
        renderer.render(post, camera)
      },
    }
  }

  it('ignores a post pass that renders its own scene', async () => {
    const { renderer, world, tick } = rendererWithPostPass()
    const capture = captureDrawOrder(
      renderer,
      (o) => o.name,
      2,
      (scene) => scene === (world as unknown as THREE.Object3D),
      2000,
    )
    for (let i = 0; i < 3; i++) tick()
    const frames = await capture
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      expect(
        frame.rows.map((r) => r.group),
        'a fullscreen post pass was counted as a frame',
      ).toEqual(['world-ocean'])
    }
  })

  it('puts both functions back when it resolves', async () => {
    // A recorder left installed would slow every subsequent frame and, worse,
    // would go on appending to a promise nobody is waiting for. An instrument
    // that does not uninstall is a change to the build.
    const { renderer, world, tick } = rendererWithPostPass()
    const before = { render: renderer.render, buffer: renderer.renderBufferDirect }
    const capture = captureDrawOrder(
      renderer,
      (o) => o.name,
      1,
      (scene) => scene === (world as unknown as THREE.Object3D),
      2000,
    )
    tick()
    await capture
    expect(renderer.render).toBe(before.render)
    expect(renderer.renderBufferDirect).toBe(before.buffer)
  })

  it('gives up rather than hanging when the loop is not running', async () => {
    const { renderer, world } = rendererWithPostPass()
    const frames = await captureDrawOrder(
      renderer,
      (o) => o.name,
      1,
      (scene) => scene === (world as unknown as THREE.Object3D),
      30,
    )
    expect(frames).toEqual([])
    expect(renderer.renderBufferDirect).toBeTypeOf('function')
  })
})

describe('§3 folding a sequence into runs', () => {
  const row = (
    seq: number,
    group: string,
    renderOrder = 0,
    pass: 'shadow' | 'color' = 'color',
  ): Parameters<typeof drawRuns>[0][number] => ({
    seq,
    group,
    name: group,
    material: 'm',
    materialId: 1,
    renderOrder,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    triangles: 10,
    pass,
  })

  it('keeps an interleaving visible instead of grouping it away', () => {
    // The failure a summary invites: sky, land, sea, land is FOUR runs, and a
    // table that reported "land: 2 calls" would have hidden the one fact the
    // instrument exists to show.
    const runs = drawRuns([
      row(0, 'sky-dome'),
      row(1, 'world-terrain/chunks'),
      row(2, 'world-ocean'),
      row(3, 'world-terrain/chunks'),
    ])
    expect(runs.map((r) => r.group)).toEqual([
      'sky-dome',
      'world-terrain/chunks',
      'world-ocean',
      'world-terrain/chunks',
    ])
    expect(runs.map((r) => r.from)).toEqual([0, 1, 2, 3])
  })

  it('never folds a shadow call into a colour one', () => {
    const runs = drawRuns([
      row(0, 'world-terrain/chunks', 0, 'shadow'),
      row(1, 'world-terrain/chunks', 0, 'color'),
    ])
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.pass)).toEqual(['shadow', 'color'])
  })

  it('reports a mixed run’s renderOrder as null rather than as one of them', () => {
    const runs = drawRuns([row(0, 'world-ocean', 1), row(1, 'world-ocean', 0)])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.renderOrder).toBeNull()
    expect(runs[0]?.calls).toBe(2)
    expect(runs[0]?.triangles).toBe(20)
  })
})

describe('§4 the warm-up builds the dome the game draws with', () => {
  // DEV-239 found the warm-up compiling every program against a target no
  // session ever draws through, and the lesson it left is the one DEV-241 has
  // to answer for: **nothing was missing from the warm-up's list; the list was
  // compiled for the wrong surface.** Moving the shipped sky onto a new program
  // key is exactly the move that can reintroduce that — a dome warmed unpinned
  // and drawn pinned compiles in the air, on the first frame of every flight.
  //
  // `render/warm-up.ts` chooses no defines of its own. It renders and compiles
  // the SCENE, so whatever the dome carries at that moment is what it builds —
  // which means the assertion is not about warm-up's code at all. It is that
  // the dome is in the scene carrying the DEFAULT when the warm draw happens,
  // and that the default is a different key from the arm's. If those two ever
  // agreed, the pin would not be in the key and DEV-238's tag would be doing
  // nothing.

  /**
   * The parts of three's program cache key that this change can move.
   *
   * `getProgramCacheKey` is built from the shader id, every name in
   * `material.defines` (in INSERTION order), the numeric and boolean
   * parameters, the output colour space and `customProgramCacheKey()`.
   * `tests/unit/program-key.test.ts` §1 reads that construction out of three's
   * own bundle and fails if it moves, which is what anchors this helper: the
   * two fields below are the only ones the far-plane pin touches, and a `three`
   * upgrade that reordered the key turns that file red rather than this one
   * silently wrong.
   */
  const keySignature = (material: THREE.Material): string =>
    [
      ...Object.keys(material.defines ?? {}),
      (
        material as THREE.Material & { customProgramCacheKey: () => string }
      ).customProgramCacheKey(),
    ].join(',')

  /** A fake renderer, the shape `warm-up.test.ts` uses: no GL, just the calls. */
  const fakeRenderer = (onDraw: () => void): { renderer: WarmUpRenderer } => {
    let target: THREE.WebGLRenderTarget | null = null
    const renderer: WarmUpRenderer = {
      render: () => onDraw(),
      compile: (() => {
        onDraw()
        return new Set<THREE.Material>()
      }) as WarmUpRenderer['compile'],
      setRenderTarget: ((t: THREE.WebGLRenderTarget | null) => {
        target = t
      }) as WarmUpRenderer['setRenderTarget'],
      getRenderTarget: () => target,
      info: {
        get programs() {
          return [] as unknown as THREE.WebGLProgram[]
        },
        memory: { geometries: 0, textures: 0 },
      },
    }
    return { renderer }
  }

  /** The dome, a root to hide, and a scene the dome is really in. */
  const sceneWithSky = () => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const root = new THREE.Group()
    root.visible = false
    root.add(new THREE.Mesh(new THREE.BufferGeometry()))
    const dome = createSkyDomeMesh(new THREE.BufferGeometry())
    scene.add(root, dome)
    return { scene, camera, root, dome }
  }

  it('warms the dome at the key the default draws with, not the arm’s', () => {
    const { scene, camera, root, dome } = sceneWithSky()
    const material = dome.material as THREE.Material
    const seen: string[] = []
    const { renderer } = fakeRenderer(() => seen.push(keySignature(material)))

    warmWorld(renderer, scene, camera, root, { offscreen: true }, () => 0)

    expect(seen.length, 'the warm-up drew nothing').toBeGreaterThan(0)
    const warmed = new Set(seen)
    expect([...warmed], 'the dome changed key DURING the warm-up').toHaveLength(1)

    // The live default's key — read off the same material after the warm-up has
    // put every flag back, which is the whole question: is what was compiled
    // what will be drawn.
    expect(
      [...warmed][0],
      'the warm-up compiled the dome at a key the shipped frame does not draw with',
    ).toBe(keySignature(material))

    // And the arm really is a different program, or the tag is doing nothing
    // and a "restore" would silently keep drawing the pinned shader.
    setSkyLast(dome, false)
    expect(
      keySignature(material),
      'the OFF arm has the same cache key as the default — the pin is not in the key',
    ).not.toBe([...warmed][0])
  })

  it('and the dome is still in the scene, in the shipped order, afterwards', () => {
    // `warmWorld` suspends visibility and frustum culling and puts every flag
    // back in a `finally`. It has no business touching `renderOrder` or a
    // material's depth state, and an instrument that quietly did would be the
    // hardest kind of bug to find: the frame would be right until the first
    // warm-up and wrong forever after.
    const { scene, camera, root, dome } = sceneWithSky()
    const material = dome.material as THREE.Material
    const { renderer } = fakeRenderer(() => {})
    warmWorld(renderer, scene, camera, root, { offscreen: false }, () => 0)
    expect(dome.renderOrder).toBe(SKY_LAST_ORDER)
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(scene.children).toContain(dome)
  })
})
