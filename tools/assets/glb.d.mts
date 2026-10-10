// Type declarations for glb.mjs. See legacy-root.d.mts for why these are separate.

export interface GlbPart {
  readonly name: string
  readonly position: Float32Array
  readonly normal?: Float32Array | null
  /** TANGENT, VEC4. */
  readonly tangent?: Float32Array | null
  /** TEXCOORD_0, VEC2. */
  readonly uv0?: Float32Array | null
  /** TEXCOORD_1, VEC2. */
  readonly uv1?: Float32Array | null
  /** COLOR_0: VEC3 or VEC4, by length. */
  readonly color?: Float32Array | null
  /** One index array, or several (one primitive each, sharing the attributes). A Uint32Array is UNSIGNED_INT. */
  readonly indices: Uint16Array | Uint32Array | readonly (Uint16Array | Uint32Array)[]
  readonly material: unknown
  readonly extras?: unknown
}

export interface BuildGlbOptions {
  readonly parts: readonly GlbPart[]
  readonly root?: string
  readonly extras?: unknown
  /** One part, no root node: the scene's node is the part's own. */
  readonly flat?: boolean
  /** Every attribute accessor carries its glTF semantic as `name`. */
  readonly accessorNames?: boolean
  /** The `asset.generator` string. */
  readonly generator?: string
}

export declare const buildGlb: (options: BuildGlbOptions) => Buffer
export declare const toThreeHullFrame: (
  mesh: { position: Float32Array; normal?: Float32Array | null; indices: ArrayLike<number> },
  matrix: ArrayLike<number>,
) => { position: Float32Array; normal: Float32Array | null; indices: Uint16Array }
export declare const worstWindingDisagreement: (mesh: {
  position: ArrayLike<number>
  normal: ArrayLike<number>
  indices: ArrayLike<number>
}) => number
