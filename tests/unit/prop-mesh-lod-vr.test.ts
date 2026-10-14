// tests/unit/prop-mesh-lod-vr.test.ts: DEV-935, lever 8 of
// docs/plan/ANNIVERSARY-VR-FRAMERATE.md. A headset moves each coarser rung of
// `props.meshLod` nearer (`vr.override`), on the meshes the world already
// built, and the pass reads the edges LIVE so a world built at the monitor
// takes them on the next scan and gives them back when the headset comes off.
//
// Held to the preset and to the drawn meshes, not to the code read back:
// which mesh each chunk's props are drawn on, before and after the table
// moves (`prop-mesh-lod.test.ts` is DEV-338's own suite; this follows its
// fixture shape).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition, EditionMeshLodRung } from '@/content/edition-schema'
import type { PropScatter } from '@/content/load-environment'
import { createEditionState, vrValueOffFrom } from '@/game/edition'
import type { ChunkRun } from '@/game/props/instance-plan'
import { createPassLod, createScatterBatch, type LoadPropsOptions } from '@/game/props/load-props'
import anniversaryJson from '../../content/editions/anniversary.json'
import desertJson from '../../content/environments/desert.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition

const CHUNK_SIZE = 256
const PER_CHUNK = 10
const RUNS: ChunkRun[] = [
  { chunk: 0, start: 0, count: PER_CHUNK },
  { chunk: 1, start: PER_CHUNK, count: PER_CHUNK },
  { chunk: 2, start: 2 * PER_CHUNK, count: PER_CHUNK },
]
const TOTAL = RUNS.length * PER_CHUNK
const desertPass = desertJson.scatter[0] as unknown as PropScatter

const rungedBatch = () => {
  const make = () =>
    new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.Material(), TOTAL)
  const inst = make()
  const lower = [make(), make()]
  const batch = createScatterBatch(inst, RUNS, lower)
  const m = new THREE.Matrix4()
  for (let i = 0; i < TOTAL; i++) batch.setSource(i, m.makeTranslation(i, 0, 0))
  batch.apply({ count: TOTAL, spans: [{ src: 0, dst: 0, count: TOTAL }] })
  return { batch, meshes: [inst, ...lower] }
}

const FLAT: readonly EditionMeshLodRung[] = [
  { from: 200, keep: 0.35 },
  { from: 550, keep: 0.12 },
]
const NEAR: readonly EditionMeshLodRung[] = [
  { from: 120, keep: 0.35 },
  { from: 300, keep: 0.12 },
]

const options = (live: { rungs: readonly EditionMeshLodRung[] }): LoadPropsOptions =>
  ({
    terrain: { terrainSize: 4096, terrainHeight: 1000, chunkSize: CHUNK_SIZE },
    heightMap: null as never,
    meshLod: { rungs: FLAT, enabled: () => true, liveRungs: () => live.rungs },
  }) as LoadPropsOptions

const counts = (meshes: THREE.InstancedMesh[]) => meshes.map((m) => m.count)

describe('DEV-935: the rung edges are live, the meshes are not', () => {
  it('moves a chunk to a coarser mesh when the table moves nearer, and back', () => {
    const { batch, meshes } = rungedBatch()
    const live = { rungs: FLAT }
    const lod = createPassLod(desertPass, [batch], 16, options(live))
    // Camera on chunk 0's centre: nearest points 0, 128 and 384 m.
    lod?.step(128, 128, 1)
    expect(counts(meshes), 'flat: 0 and 128 on the full mesh, 384 on rung 1').toEqual([
      2 * PER_CHUNK,
      PER_CHUNK,
      0,
    ])
    live.rungs = NEAR
    for (let i = 0; i < 40; i++) lod?.step(128, 128, 1 / 30)
    expect(counts(meshes), 'nearer edges: 128 m is rung 1, 384 m is rung 2').toEqual([
      PER_CHUNK,
      PER_CHUNK,
      PER_CHUNK,
    ])
    live.rungs = FLAT
    for (let i = 0; i < 40; i++) lod?.step(128, 128, 1 / 30)
    expect(counts(meshes), 'and the monitor table again').toEqual([2 * PER_CHUNK, PER_CHUNK, 0])
  })

  it('never names a rung the pass did not build', () => {
    const { batch, meshes } = rungedBatch()
    const live = { rungs: [...NEAR, { from: 350, keep: 0.05 }] }
    const lod = createPassLod(desertPass, [batch], 16, options(live))
    lod?.step(128, 128, 1)
    expect(
      counts(meshes).reduce((a, b) => a + b, 0),
      'every prop drawn once',
    ).toBe(TOTAL)
  })
})

describe('DEV-935: what the headset gets', () => {
  it('the same meshes, every rung starting nearer, and the flat table on a monitor', () => {
    const s = createEditionState(ANNIVERSARY, DEFAULT_SETTINGS)
    const flat = s.current.props.meshLod.rungs
    s.setImmersive(true)
    const vr = s.current.props.meshLod.rungs
    expect(vr.length).toBe(flat.length)
    for (let i = 0; i < flat.length; i++) {
      expect(vr[i]?.keep, `rung ${i + 1} keeps the same mesh`).toBe(flat[i]?.keep)
      expect(vr[i]?.from as number, `rung ${i + 1} starts nearer`).toBeLessThan(
        flat[i]?.from as number,
      )
    }
    s.setImmersive(false)
    expect(s.current.props.meshLod.rungs).toEqual(flat)
  })

  it('?vrMeshLod=0 keeps the flat table in the headset, and ?vrFxTrim=0 does not touch it', () => {
    const flat = ANNIVERSARY.props.meshLod.rungs
    const off = createEditionState(
      ANNIVERSARY,
      DEFAULT_SETTINGS,
      ANNIVERSARY,
      vrValueOffFrom('?vrMeshLod=0'),
    )
    off.setImmersive(true)
    expect(off.current.props.meshLod.rungs).toEqual(flat)
    const fxOnly = createEditionState(
      ANNIVERSARY,
      DEFAULT_SETTINGS,
      ANNIVERSARY,
      vrValueOffFrom('vrFxTrim=0'),
    )
    fxOnly.setImmersive(true)
    expect(fxOnly.current.props.meshLod.rungs).not.toEqual(flat)
  })

  it('the pin reader: 0 is off, anything else (1, absent) is the default ON', () => {
    expect(vrValueOffFrom('vrFxTrim=0')('fx.motes')).toBe(true)
    expect(vrValueOffFrom('vrFxTrim=0')('props.meshLod')).toBe(false)
    expect(vrValueOffFrom('vrMeshLod=0')('props.meshLod')).toBe(true)
    expect(vrValueOffFrom('vrMeshLod=0')('fx.speedLines')).toBe(false)
    expect(vrValueOffFrom('vrFxTrim=1&vrMeshLod=1')('fx.motes')).toBe(false)
    expect(vrValueOffFrom('')('props.meshLod')).toBe(false)
  })
})
