// Type declarations for prop-mesh-glb.mjs. See legacy-root.d.mts for why these are separate.

import type { DecodedMesh, ParsedMesh } from './unity-mesh-asset.mjs'

export declare const PROP_GLB_GENERATOR: string
export declare const propGlbFromMesh: (parsed: ParsedMesh, mesh: DecodedMesh) => Buffer
export declare const propGlbFromAsset: (file: string) => Buffer
