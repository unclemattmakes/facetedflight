// Type declarations for convert-wings.mjs. See legacy-root.d.mts for why these are separate.

export declare const WINGS_OUT: string
export declare const GHOST_RACER: string
export declare const PROJECTOR_ASSET: string

/** One parsed Unity YAML document, as `tools/prototype/unity_yaml.js` returns it. */
export interface UnityDoc {
  readonly classId: number
  readonly fileId: string
  // biome-ignore lint/suspicious/noExplicitAny: a parsed YAML mapping
  readonly data: any
}

export interface Prefab {
  readonly docs: readonly UnityDoc[]
  readonly byId: ReadonlyMap<string, UnityDoc>
  goOf(tf: UnityDoc): UnityDoc
  tfOf(go: UnityDoc): UnityDoc | undefined
  nameOf(go: UnityDoc): string
  children(tf: UnityDoc): UnityDoc[]
  parentOf(tf: UnityDoc): UnityDoc | null
  componentsOf(go: UnityDoc): UnityDoc[]
}

export declare const readPrefab: (relPath: string) => Prefab
/** Column-major 4x4, three's `Matrix4.elements` layout, in UNITY space. */
export declare const unityTrs: (tf: UnityDoc) => number[]

export interface WingRenderer {
  readonly path: string
  readonly mesh: string
  readonly materials: readonly string[]
  readonly matrix: readonly number[]
}

export declare const liveWingRenderers: (
  prefab?: Prefab,
  guids?: ReadonlyMap<string, string>,
) => { renderers: WingRenderer[]; skipped: string[]; wingPose: number[] }

export declare const buildWings: () => {
  glb: Uint8Array
  report: {
    skipped: string[]
    projectorPart: number
    projectorParts: number[]
    glowParts: number[]
    bytes: number
    sha256: string
  }
}
