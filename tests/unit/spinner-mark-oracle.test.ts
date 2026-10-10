import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScrollMark, createTvMark } from '@/render/door-marks'
import { holoShipLamps, SPIN_DEG_PER_SECOND } from '@/render/holo-ship'
import { createModeMark, type ModeMark, spinnerMark } from '@/render/mode-mark'
import { turntableYaw } from '@/render/turntable'
import { lcg } from './helpers/seeded'

// Reuse audit, last clones (DEV-782): `createModeMark` and `createGlyphMark`
// (door-marks) ended in the same fifteen lines, a `ModeMark` over a spinner
// group. That tail is `spinnerMark` now, and each factory keeps its own
// `dispose`. Two proofs:
//
//   1. a GOLDEN digest of the real factories (every kind, the TV and the
//      scroll), taken on the code BEFORE the extraction: construction fields,
//      the spinner yaw after a scripted run of `rest` and `update` calls
//      (bit patterns, so a -0 or a last-ulp change moves it), and which
//      resources `dispose` frees;
//   2. the OLD tail kept here, compared with `spinnerMark` over fuzzed
//      dimensions and scripts with Object.is.

const SPIN = (SPIN_DEG_PER_SECOND * Math.PI) / 180

const bits = new Float64Array(1)
const u32 = new Uint32Array(bits.buffer)
const bitsOf = (n: number): string => {
  bits[0] = n
  return `${u32[1]?.toString(16)}:${u32[0]?.toString(16)}`
}

/** One scripted run of rest/update calls, as bit patterns. */
const script = (mark: ModeMark, spinner: THREE.Object3D, seed: number): string[] => {
  const rng = lcg(seed)
  const out: string[] = [bitsOf(spinner.rotation.y)]
  for (let i = 0; i < 160; i++) {
    const roll = rng()
    if (roll < 0.15) mark.rest((rng() - 0.5) * 12)
    else if (roll < 0.55) mark.update(rng() * 0.05, false)
    else if (roll < 0.9) mark.update(rng() * 0.05)
    else mark.update(rng() < 0.5 ? 0 : -0.01, false)
    out.push(bitsOf(spinner.rotation.y))
  }
  return out
}

const spinnerOf = (mark: ModeMark): THREE.Object3D => {
  const found = mark.object.getObjectByName('mode-mark-spinner')
  if (!found) throw new Error('no spinner')
  return found
}

/** Everything a mark exposes that is not a closure, then the closures' effect. */
const traceOf = (label: string, mark: ModeMark, seed: number): string => {
  const spinner = spinnerOf(mark)
  const lines: string[] = [label, mark.object.name, JSON.stringify(mark.object.userData)]
  lines.push(mark.kind, JSON.stringify(mark.lamps))
  for (const k of ['reach', 'height', 'bottom', 'front'] as const) lines.push(bitsOf(mark[k]))
  lines.push(Object.keys(mark).join(','))
  lines.push(...script(mark, spinner, seed))
  // Which resources dispose frees, by their own `dispose` events.
  const freed: string[] = []
  spinner.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.addEventListener('dispose', () => freed.push(`${mesh.name}:geometry`))
    ;(mesh.material as THREE.Material).addEventListener('dispose', () =>
      freed.push(`${mesh.name}:material`),
    )
  })
  mark.dispose()
  lines.push(freed.join(','), String(spinner.children.length))
  return lines.join('\n')
}

const ring = (): THREE.BufferGeometry => new THREE.TorusGeometry(3, 0.5, 3, 6).rotateX(0.4)
const orb = (): THREE.BufferGeometry =>
  new THREE.IcosahedronGeometry(1.5, 1).translate(0.3, 2, -0.7)
const pad = (): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(2, 2.4, 0.3, 12).translate(1, 0.15, 0)

/** Taken on the code before the extraction (DEV-782). */
const GOLDEN = '3f80fc71b641ea1635f1dca0e0e27fefb3ba19f6a7b0ebb191d5779405c1552f'

afterEach(() => vi.restoreAllMocks())

describe('spinner mark tail, before and after the extraction (DEV-782)', () => {
  it('the real factories trace to the digest taken before the change', () => {
    // The mode mark starts at a random yaw; a fixed stream makes it a trace.
    const rng = lcg(7)
    vi.spyOn(Math, 'random').mockImplementation(rng)
    const parts = [
      traceOf('ring', createModeMark('ring', ring(), 0.52, 0.18), 1),
      traceOf('orb', createModeMark('orb', orb(), 0.52, 0.18), 2),
      traceOf('padZone', createModeMark('padZone', pad(), 0.52, 0.18), 3),
      traceOf('tv', createTvMark(0.52, 0.18), 4),
      traceOf('scroll', createScrollMark(0.52, 0.18), 5),
    ]
    const digest = createHash('sha256').update(parts.join('\n--\n')).digest('hex')
    expect(digest).toBe(GOLDEN)
  })

  it('spinnerMark agrees with the old inline tail over fuzzed sizes and scripts', () => {
    const rng = lcg(782)
    for (let trial = 0; trial < 60; trial++) {
      const reach = rng() * 0.4
      const height = rng() * 0.3
      const bottom = rng() * 0.1
      const kind = trial % 2 === 0 ? 'ring' : 'tv'
      const make = (): { object: THREE.Group; spinner: THREE.Group } => {
        const object = new THREE.Group()
        const spinner = new THREE.Group()
        object.add(spinner)
        spinner.rotation.y = (trial % 7) * 0.3
        return { object, spinner }
      }

      // The old tail, as it stood in both files.
      const legacy = make()
      let restYaw: number | null = null
      const old: ModeMark = {
        object: legacy.object,
        kind,
        lamps: holoShipLamps(2 * reach, bottom),
        reach,
        height,
        bottom,
        front: 0,
        rest(yaw: number) {
          restYaw = yaw
          legacy.spinner.rotation.y = yaw
        },
        update(seconds: number, spinning = true) {
          legacy.spinner.rotation.y = turntableYaw(
            legacy.spinner.rotation.y,
            restYaw,
            seconds,
            spinning,
            SPIN,
          )
        },
        dispose() {},
      }

      const fresh = make()
      let disposed = 0
      const now = spinnerMark({
        kind,
        object: fresh.object,
        spinner: fresh.spinner,
        reach,
        height,
        bottom,
        dispose: () => {
          disposed++
        },
      })

      expect(Object.keys(now)).toEqual(Object.keys(old))
      expect(now.object).toBe(fresh.object)
      expect(now.kind).toBe(old.kind)
      expect(now.lamps).toEqual(old.lamps)
      for (const k of ['reach', 'height', 'bottom', 'front'] as const) {
        expect(Object.is(now[k], old[k])).toBe(true)
      }
      const a = script(old, legacy.spinner, 100 + trial)
      const b = script(now, fresh.spinner, 100 + trial)
      expect(b).toEqual(a)
      now.dispose()
      expect(disposed).toBe(1)
    }
  })
})
