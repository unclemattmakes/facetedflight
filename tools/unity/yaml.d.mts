// Type declarations for yaml.mjs. See legacy-root.d.mts for why these are separate.

/** One document as `tools/prototype/unity_yaml.js` parses it. */
export interface UnityDoc {
  classId: number
  fileId: string
  stripped: boolean
  /** The top-level key, e.g. "GameObject", "Transform", "MonoBehaviour", "Prefab". */
  type: string
  // biome-ignore lint/suspicious/noExplicitAny: a parsed Unity mapping has no fixed shape
  data: any
}

/** Evaluate a CommonJS file from `tools/prototype/` and return its `module.exports`. */
// biome-ignore lint/suspicious/noExplicitAny: the exports of an arbitrary CJS module
export declare function requireCjs(absFile: string): any
/** `tools/prototype/<name>.js`, loaded through `requireCjs`. */
// biome-ignore lint/suspicious/noExplicitAny: the exports of an arbitrary CJS module
export declare const prototypeTool: (name: string) => any
/** The prototype YAML parser. */
export declare function unityYaml(file?: string): {
  parseDocuments(text: string): UnityDoc[]
}

/** Read a Unity text file: BOM always stripped, CRLF kept unless `lf` is true. */
export declare const readUnityText: (file: string, options?: { lf?: boolean }) => string

/** One document header: `--- !u!<classId> &<fileId>[ stripped]`. */
export declare const DOC_HEADER: RegExp
/** A top-level key of a document body. */
export declare const TOP_KEY: RegExp

export interface DocBound {
  classId: number
  fileId: string
  stripped: boolean
  /** 0-based line of the header. */
  start: number
  /** 0-based line of the next header, or the line count. Exclusive. */
  end: number
}

/** Split a Unity YAML file (text or its lines) into document line bounds, without parsing. */
export declare function scanDocuments(lines: string | readonly string[]): DocBound[]
/** The 1-based line of each top-level key inside `bound`, first occurrence wins. */
export declare function keyLines(lines: readonly string[], bound: DocBound): Map<string, number>
