// Type declarations for guid-index.mjs. See legacy-root.d.mts for why these are separate.

export interface GuidIndex {
  /** guid -> project-relative path, forward slashes, as the TSV holds it. */
  readonly guidToPath: Map<string, string>
  /** path -> guid; a duplicated path keeps the LATER row (the real index has none). */
  readonly pathToGuid: Map<string, string>
  /** Rows that carried a guid before their tab. */
  readonly rows: number
}

/** `docs/research/_guid_index.tsv` under the repo root. */
export declare const DEFAULT_GUID_INDEX: string

/** The error text for a missing index: the path, why it is absent, and how to rebuild it. */
export declare const missingGuidIndexMessage: (file: string) => string

/** Parse TSV text with the one policy (CRLF or LF, trimmed halves, later path wins). */
export declare const parseGuidIndex: (text: string) => GuidIndex

/** Load and cache the index; throws `missingGuidIndexMessage` when the file is absent. */
export declare const loadGuidIndex: (file?: string) => GuidIndex
