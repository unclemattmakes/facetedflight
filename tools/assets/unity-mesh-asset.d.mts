// Type declarations for unity-mesh-asset.mjs. See legacy-root.d.mts for why these are separate.

export declare const UNITY4_SLOTS: readonly string[]
export declare const UNITY5_SLOTS: readonly string[]

export interface MeshChannel {
  readonly stream: number
  readonly offset: number
  readonly format: number
  readonly dimension: number
  readonly slot: number
  readonly name: string
}

export interface ParsedMesh {
  readonly name: string
  readonly dialect: 'unity4' | 'unity5'
  readonly vertexCount: number
  readonly dataSize: number
  readonly channels: readonly MeshChannel[]
  readonly strides: Readonly<Record<number, number>>
  readonly streamBase: Readonly<Record<number, number>>
  readonly subMeshes: readonly {
    firstByte: number
    indexCount: number
    topology: number
    firstVertex: number
    vertexCount: number
  }[]
  readonly data: Uint8Array
  readonly indices: Uint16Array
  readonly localAABB: {
    center: { x: number; y: number; z: number }
    extent: { x: number; y: number; z: number }
  } | null
}

export interface DecodedMesh {
  readonly indices: Uint16Array
  readonly position: Float32Array
  readonly normal?: Float32Array
  readonly tangent?: Float32Array
  readonly uv0?: Float32Array
  readonly uv1?: Float32Array
  /** R, G, B, A bytes per vertex (quantised from `colorFloat` when the mesh stores floats). */
  readonly color?: Uint8Array
  /** R, G, B, A as stored, when the colour channel is FLOAT (`format: 0`): Mesh Materializer's bakes. */
  readonly colorFloat?: Float32Array
}

export declare const readUnityText: (file: string) => string
export declare const parseMeshAsset: (text: string) => ParsedMesh
export declare const decodeMesh: (parsed: ParsedMesh) => DecodedMesh
export declare const loadMeshAsset: (file: string) => { parsed: ParsedMesh; mesh: DecodedMesh }
export declare const connectedParts: (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  eps?: number,
) => number[][]
