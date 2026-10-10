// Type declarations for material.mjs. See legacy-root.d.mts for why these are separate.

export declare const materialDialect: (text: string) => 'old' | 'new'
export declare function rawColour(
  text: string,
  name: string,
): { value: [number, number, number, number]; line: number; dialect: 'old' | 'new' } | null
export declare function rawFloat(text: string, name: string): { value: number; line: number } | null
export declare function rawTexEnv(
  text: string,
  name: string,
): { guid: string | null; scale: [number, number]; offset: [number, number] } | null
export declare const shaderGuidOf: (text: string) => string | null
