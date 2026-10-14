// DEV-937: `render/static-scene.ts`. The claim that matters is that freezing
// changes no world matrix: a frozen scene and an untouched copy, with the
// same movers moved, must agree on every object. Then the rules (what is
// frozen, what is not), the lift's freeze and thaw, and the hand-back that
// keeps a wrong freeze from sticking silently.
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStaticScene, type StaticRules } from '@/render/static-scene'

const RULES: StaticRules = {
  roots: ['land', 'ship'],
  movers: ['ship', 'pivot'],
  dynamicSubtrees: ['shards'],
  lift: ['platform'],
}

const named = (name: string, ...children: THREE.Object3D[]): THREE.Object3D => {
  const o = new THREE.Object3D()
  o.name = name
  o.position.set(name.length, 2 * name.length, -name.length)
  o.rotation.set(0.1 * name.length, 0.2, 0.3)
  for (const c of children) o.add(c)
  return o
}

/** land / rock, land / shards / piece, land / platform / rail, ship / pivot / seat, sky. */
const build = (): THREE.Scene => {
  const scene = new THREE.Scene()
  scene.add(
    named('land', named('rock'), named('shards', named('piece')), named('platform', named('rail'))),
    named('ship', named('pivot', named('seat'))),
    named('sky'),
  )
  return scene
}

const byName = (scene: THREE.Object3D, name: string): THREE.Object3D =>
  scene.getObjectByName(name) as THREE.Object3D

afterEach(() => vi.restoreAllMocks())

describe('DEV-937: the static scene', () => {
  it('changes no world matrix: a frozen scene and an untouched one agree after the movers move', () => {
    const frozen = build()
    const plain = build()
    const s = createStaticScene(frozen, RULES)
    s.tick(true)
    const move = (scene: THREE.Scene, t: number) => {
      byName(scene, 'ship').position.set(10 * t, 5, -3 * t)
      byName(scene, 'ship').rotation.y = t
      byName(scene, 'pivot').rotation.z = 0.5 * t
      byName(scene, 'piece').position.y = -t
      byName(scene, 'sky').position.x = t
    }
    for (let t = 1; t <= 5; t++) {
      move(frozen, t)
      move(plain, t)
      s.tick(true)
      frozen.updateMatrixWorld()
      plain.updateMatrixWorld()
      const a: THREE.Object3D[] = []
      const b: THREE.Object3D[] = []
      frozen.traverse((o) => a.push(o))
      plain.traverse((o) => b.push(o))
      expect(a.length).toBe(b.length)
      for (let i = 0; i < a.length; i++) {
        const x = (a[i] as THREE.Object3D).matrixWorld.elements
        const y = (b[i] as THREE.Object3D).matrixWorld.elements
        for (let k = 0; k < 16; k++)
          expect(x[k], (a[i] as THREE.Object3D).name).toBeCloseTo(y[k] as number, 9)
      }
    }
    // And it froze something, or the comparison proved nothing.
    expect(s.report().frozen).toBeGreaterThan(3)
  })

  it('freezes the static parts, keeps movers and fragments live, and leaves unlisted roots alone', () => {
    const scene = build()
    const s = createStaticScene(scene, RULES)
    s.tick(false)
    const auto = (n: string) => byName(scene, n).matrixAutoUpdate
    expect(auto('land')).toBe(false)
    expect(auto('rock')).toBe(false)
    expect(auto('rail')).toBe(false) // a lift's child is not the lift
    expect(auto('seat')).toBe(false) // a mover's child is still swept
    expect(auto('ship')).toBe(true)
    expect(auto('pivot')).toBe(true)
    expect(auto('shards')).toBe(true)
    expect(auto('piece')).toBe(true)
    expect(auto('platform')).toBe(true) // the lift, before the race is live
    expect(auto('sky')).toBe(true) // not a root
    // The scene root never moves, and on auto-update it would force every
    // world matrix below it to be rebuilt every frame.
    expect(scene.matrixAutoUpdate).toBe(false)
  })

  it('skips the frozen subtrees entirely: no world matrix below a still ancestor is rebuilt', () => {
    const scene = build()
    const s = createStaticScene(scene, RULES)
    s.tick(true)
    scene.updateMatrixWorld()
    // A sentinel in a frozen object's world matrix survives a render's walk
    // only if three skipped it: neither its own compose nor a forced rebuild.
    const rock = byName(scene, 'rock')
    rock.matrixWorld.elements[12] = 12345
    scene.updateMatrixWorld()
    expect(rock.matrixWorld.elements[12]).toBe(12345)
    // Below a mover, the rebuild still happens (the seat rides the pivot).
    const seat = byName(scene, 'seat')
    seat.matrixWorld.elements[12] = 12345
    scene.updateMatrixWorld()
    expect(seat.matrixWorld.elements[12]).not.toBe(12345)
  })

  it('freezes the lift once the race is live, and thaws it for a restart', () => {
    const scene = build()
    const s = createStaticScene(scene, RULES)
    s.tick(false)
    expect(byName(scene, 'platform').matrixAutoUpdate).toBe(true)
    s.tick(true)
    expect(byName(scene, 'platform').matrixAutoUpdate).toBe(false)
    expect(s.report().lift).toEqual({ known: 1, frozen: true })
    s.tick(false)
    expect(byName(scene, 'platform').matrixAutoUpdate).toBe(true)
    // The thawed lift moves for real.
    byName(scene, 'platform').position.y = 42
    scene.updateMatrixWorld()
    expect(byName(scene, 'platform').matrix.elements[13]).toBe(42)
  })

  it('hands a frozen object that something moved back to three, and names it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scene = build()
    const s = createStaticScene(scene, RULES)
    s.tick(true)
    const rock = byName(scene, 'rock')
    expect(rock.matrixAutoUpdate).toBe(false)
    rock.position.x += 1
    for (let i = 0; i < 40; i++) s.tick(true)
    expect(rock.matrixAutoUpdate).toBe(true)
    expect(s.report().healed).toEqual(['land / rock'])
    expect(warn).toHaveBeenCalledTimes(1)
    // and it moves from here on
    scene.updateMatrixWorld()
    expect(rock.matrix.elements[12]).toBeCloseTo(rock.position.x, 9)
  })

  it('heals nothing on a scene where only the movers move', () => {
    const scene = build()
    const s = createStaticScene(scene, RULES)
    for (let i = 0; i < 100; i++) {
      byName(scene, 'ship').position.x = i
      byName(scene, 'pivot').rotation.x = i * 0.01
      s.tick(true)
      scene.updateMatrixWorld()
    }
    expect(s.report().healed).toEqual([])
  })

  it('freezes what is added later on its next sweep, and forgets what is removed', () => {
    const scene = build()
    const s = createStaticScene(scene, RULES)
    s.tick(true)
    const before = s.report().frozen
    const chunk = named('chunk')
    byName(scene, 'land').add(chunk)
    expect(chunk.matrixAutoUpdate).toBe(true)
    for (let i = 0; i < 30; i++) s.tick(true)
    expect(chunk.matrixAutoUpdate).toBe(false)
    expect(s.report().frozen).toBe(before + 1)
    chunk.removeFromParent()
    for (let i = 0; i < 40; i++) s.tick(true)
    expect(s.report().frozen).toBe(before)
  })

  it('leaves an object whose owner already writes its matrix alone', () => {
    const scene = build()
    const owned = byName(scene, 'rock')
    owned.matrixAutoUpdate = false
    owned.matrix.makeTranslation(7, 7, 7) // not its position: the owner's own
    const s = createStaticScene(scene, RULES)
    for (let i = 0; i < 40; i++) s.tick(true)
    expect(owned.matrix.elements[12]).toBe(7)
    expect(owned.matrixAutoUpdate).toBe(false)
    expect(s.report().healed).toEqual([])
  })
})
