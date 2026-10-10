// Type declarations for graph.mjs. See legacy-root.d.mts for why these are separate.

import type { UnityDoc } from './yaml.mjs'

/** Anything with `.get(fileId)`: a Map, or a lazy wrapper that parses on demand. */
export interface DocLookup {
  get(id: string): UnityDoc | null | undefined
}

/** The `{ fileID }` reference inside one `m_Component` entry, in either dialect. */
// biome-ignore lint/suspicious/noExplicitAny: a parsed Unity reference
export declare function componentRef(entry: unknown): any
export declare const goIdOf: (comp: UnityDoc | null | undefined) => string
export declare const goOfComponent: (
  byId: DocLookup,
  comp: UnityDoc | null | undefined,
) => UnityDoc | null | undefined
export declare function componentIdsOf(go: UnityDoc | null | undefined): string[]
export declare function componentsOfGo(byId: DocLookup, go: UnityDoc | null | undefined): UnityDoc[]
export declare const transformOfGo: (
  byId: DocLookup,
  go: UnityDoc | null | undefined,
) => UnityDoc | undefined
export declare function componentOwners(docs: readonly UnityDoc[]): Map<string, string>
export declare const fatherIdOf: (tf: UnityDoc | null | undefined) => string
export declare const parentOf: (
  byId: DocLookup,
  tf: UnityDoc | null | undefined,
) => UnityDoc | undefined
export declare const nameOfGo: (go: UnityDoc | null | undefined) => string
export declare const childrenOf: (byId: DocLookup, tf: UnityDoc | null | undefined) => UnityDoc[]

export interface PrefabGraph {
  docs: UnityDoc[]
  byId: Map<string, UnityDoc>
  goOf(comp: UnityDoc): UnityDoc | undefined
  tfOf(go: UnityDoc): UnityDoc | undefined
  nameOf(go: UnityDoc): string
  children(tf: UnityDoc): UnityDoc[]
  parentOf(tf: UnityDoc): UnityDoc | null
  componentsOf(go: UnityDoc): UnityDoc[]
}
export declare function graphOf(docs: UnityDoc[]): PrefabGraph

/** 1 active, 0 inactive, -1 unknown (no GameObject here, or a stripped placeholder). */
export declare const activeOf: (go: UnityDoc | null | undefined) => number

export interface ChainNode {
  transform: UnityDoc
  go: UnityDoc | null | undefined
  active: number
  fatherId: string
}
export declare function chainUp(
  byId: DocLookup,
  tf: UnityDoc | null | undefined,
  options?: { includeSelf?: boolean; cap?: number },
): { nodes: ChainNode[]; rootReached: boolean }
export declare const chainIsLive: (
  nodes: readonly ChainNode[],
  options?: { unknown?: 'dead' | 'alive' },
) => boolean

export declare function flatIsLive<
  T extends { active?: boolean | undefined; key?: string | undefined },
>(
  obj: T,
  parentOf: (o: T) => T | null | undefined,
  options?: { forced?: (o: T) => boolean },
): boolean
