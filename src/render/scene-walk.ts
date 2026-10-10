import type * as THREE from 'three'

/**
 * Walks over the meshes and materials under a root (code-reuse RC-3 and RC-9).
 *
 * Ten files wrote "dispose every geometry and material under this object" out
 * by hand, and seven wrote "visit every distinct material under this object".
 * Both are the same traversal: `traverse`, keep the meshes, normalise
 * `mesh.material` (one material or an array of them) to an array. They live
 * together so the traversal is written once and the part that DIFFERS between
 * callers is a named choice instead of an accident of whichever copy was
 * pasted.
 *
 * Every walk here visits MESHES only (`isMesh`), which is what every copy it
 * replaced did: a `Points`, `Line` or `Sprite` child is skipped, and so is a
 * bare `Group`. `InstancedMesh` is a `Mesh`, so it is visited.
 */

/**
 * A mesh's material slots as an array, with an empty slot dropped. A mesh has
 * one material or an array of them; nothing downstream should care which.
 */
export const meshMaterials = (mesh: THREE.Mesh): readonly THREE.Material[] => {
  const material = mesh.material as THREE.Material | readonly THREE.Material[] | null | undefined
  if (!material) return []
  if (Array.isArray(material)) return (material as readonly THREE.Material[]).filter(Boolean)
  return [material as THREE.Material]
}

/** Every mesh under `root` (the root included), in `traverse` order. */
export const meshesUnder = (root: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh === true) out.push(mesh)
  })
  return out
}

/**
 * Call `visit` once per material SLOT of every mesh under `root`: a material
 * shared by two meshes is visited twice, and `mesh` says which. For work whose
 * flags live on the mesh (or that wants to count every slot).
 */
export const forEachMeshMaterial = (
  root: THREE.Object3D,
  visit: (material: THREE.Material, mesh: THREE.Mesh) => void,
): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh !== true) return
    for (const material of meshMaterials(mesh)) visit(material, mesh)
  })
}

/**
 * The distinct materials of `meshes`, in first-seen order. For a caller that
 * already holds its mesh list (a cockpit's casters) rather than a root.
 */
export const uniqueMaterialsOf = (meshes: Iterable<THREE.Mesh>): THREE.Material[] => {
  const seen = new Set<THREE.Material>()
  for (const mesh of meshes) for (const material of meshMaterials(mesh)) seen.add(material)
  return [...seen]
}

/** The distinct materials under `root`, in first-seen (traverse) order. */
export const uniqueMaterials = (root: THREE.Object3D): THREE.Material[] =>
  uniqueMaterialsOf(meshesUnder(root))

/**
 * Call `visit` once per DISTINCT material under `root`, in first-seen order.
 * The filter a caller wants ("only materials with an emissive") belongs in
 * `visit`: it is a pure function of the material, so deduplicating before or
 * after it gives the same set.
 */
export const forEachUniqueMaterial = (
  root: THREE.Object3D,
  visit: (material: THREE.Material) => void,
): void => {
  for (const material of uniqueMaterials(root)) visit(material)
}

/** What {@link disposeTree} frees. Both default to true. */
export interface DisposeWhat {
  /** Free each mesh's geometry. */
  readonly geometry?: boolean
  /** Free each mesh's material slots (not the textures they hold). */
  readonly materials?: boolean
}

/**
 * Free the GPU resources of every mesh under `root` (a null root frees nothing).
 *
 * The choice is OWNERSHIP, so the caller says it. `{ geometry: true }` is for a
 * tree whose materials are shared with something that outlives it
 * (`mode-mark.ts`: "never the shared materials"); `{ materials: true }` is for
 * a tree whose geometry belongs to the room (`course-shelf.ts`). A call site
 * never defaults a shared-material tree to full disposal.
 *
 * It never disposes a material's TEXTURES (`map`, `emissiveMap` ...): a map can
 * be a shared atlas, and every caller disposes its own canvas textures by hand.
 * Disposal is not de-duplicated: a geometry or material under two meshes has
 * `dispose()` called twice, which three tolerates (the second is a no-op for
 * the renderer, an extra `dispose` event for a listener that is already gone).
 */
export const disposeTree = (
  root: THREE.Object3D | null | undefined,
  what: DisposeWhat = {},
): void => {
  if (!root) return
  const geometry = what.geometry ?? true
  const materials = what.materials ?? true
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh !== true) return
    if (geometry) mesh.geometry.dispose()
    if (materials) for (const material of meshMaterials(mesh)) material.dispose()
  })
}
