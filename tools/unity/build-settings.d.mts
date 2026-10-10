// Type declarations for build-settings.mjs. See legacy-root.d.mts for why these are separate.

export declare const BUILD_SETTINGS_REL: string
export interface BuildScene {
  path: string
  enabled: boolean
  present: boolean
}
export declare function buildScenes(root: string): BuildScene[]
export declare function classifyScene(p: string): 'mission' | 'multiplayer' | 'other'
export declare function shippedMissions(root: string): { id: string; rel: string; abs: string }[]
