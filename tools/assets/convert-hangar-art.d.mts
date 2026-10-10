// Type declarations for convert-hangar-art.mjs. See legacy-root.d.mts for why these are separate.

/** Where each file lands under `public/`, and what `src/render/hangar-art.ts` fetches. */
export declare const HANGAR_ART_OUT: {
  readonly room: string
  readonly chair: string
  readonly table: string
}

export declare const SCENE: string

/**
 * Build the room GLBs from the read-only Unity project.
 * Reads `$FF2_LEGACY`, writes nothing; throws when 2016's inventory moves.
 */
export declare const buildHangarArt: () => {
  readonly files: {
    readonly room: Buffer
    readonly chair: Buffer
    readonly table: Buffer
  }
  // biome-ignore lint/suspicious/noExplicitAny: a report printed for a human
  readonly report: any
}
