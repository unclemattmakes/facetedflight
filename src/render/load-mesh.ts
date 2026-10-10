// src/render/load-mesh.ts — load one glTF binary and hand back a usable mesh.
//
// Small on purpose. Everything FF2 loads is a single mesh with a single flat
// material and per-vertex colour — the whole art style is vertex colour on flat
// faces, which is why the port needs almost no texture pipeline at all.
//
// ── The two traps that come with these particular files ───────────────────
//
//  1. **`Color32` alpha decodes to 1/255.** Unity stores vertex colour as four
//     bytes; a converter that reads alpha as a byte and writes it as a float
//     without dividing produces `a = 1/255`, and any glTF consumer honouring
//     `COLOR_0.a` renders the mesh essentially invisible. The exporter is meant
//     to force alpha to 1, but a mesh that arrives 0.4% opaque looks exactly
//     like a mesh that failed to load, so `forceOpaqueVertexColors` fixes it
//     here as well and says so.
//
//  2. **FBX unit scale.** `SR9_rev4.glb` exports 15 nodes at scale 0.01 —
//     centimetres, not metres. The conversion step bakes unit scale, so the
//     shipped GLBs are metres, but a mesh that arrives 100x too small is worth
//     recognising rather than debugging as a camera problem.

import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { disposeTree } from './scene-walk'

export class MeshLoadError extends Error {
  constructor(url: string, cause: string) {
    super(`Failed to load mesh ${url}: ${cause}`)
    this.name = 'MeshLoadError'
  }
}

const loader = new GLTFLoader()

export interface LoadedMesh {
  /** The glTF scene root. Add this, not the meshes inside it. */
  readonly object: THREE.Object3D
  readonly meshCount: number
  readonly vertexCount: number
  dispose(): void
}

/**
 * Force every `COLOR_0` alpha to 1.
 *
 * See trap 1. Cheap, idempotent, and the failure it prevents is indistinguishable
 * from a 404 at a glance.
 */
const forceOpaqueVertexColors = (root: THREE.Object3D): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    const colour = mesh.geometry?.getAttribute?.('color')
    if (colour?.itemSize !== 4) return
    const array = colour.array as Float32Array
    for (let i = 3; i < array.length; i += 4) array[i] = 1
    colour.needsUpdate = true
  })
}

export const loadMesh = async (url: string): Promise<LoadedMesh> => {
  const gltf = await loader.loadAsync(url).catch((err: unknown) => {
    throw new MeshLoadError(url, (err as Error)?.message ?? String(err))
  })

  const object = gltf.scene
  forceOpaqueVertexColors(object)

  let meshCount = 0
  let vertexCount = 0
  object.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    meshCount++
    vertexCount += mesh.geometry.getAttribute('position')?.count ?? 0
  })
  if (meshCount === 0) throw new MeshLoadError(url, 'contains no meshes')

  return {
    object,
    meshCount,
    vertexCount,
    dispose() {
      disposeTree(object)
    },
  }
}
