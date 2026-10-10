// Type declarations for modifications.mjs. See legacy-root.d.mts for why these are separate.

import type { UnityDoc } from './yaml.mjs'

/** One raw `m_Modifications` entry. */
export interface RawModification {
  target?: { fileID?: number | string }
  propertyPath?: unknown
  value?: unknown
}

export declare const prefabInstances: (docs: readonly UnityDoc[]) => UnityDoc[]
export declare const parentGuidOf: (instance: UnityDoc | null | undefined) => string
export declare const instancesOf: (
  docs: readonly UnityDoc[],
  guid: string | null | undefined,
) => UnityDoc[]
export declare const modificationsOf: (instance: UnityDoc | null | undefined) => RawModification[]
export declare const modTarget: (m: RawModification | null | undefined) => string
export declare const modTargetOrNull: (m: RawModification | null | undefined) => string | null
export declare const modPath: (m: RawModification | null | undefined) => string
export declare const modValue: (v: unknown) => unknown
