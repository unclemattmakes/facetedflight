// src/render/lod-fade-define.ts: the LOD fade's define, in a module that imports
// nothing. `lod-fade.ts` re-exports it, and `fragment-gates.ts` reads it from
// here, because lod-fade -> delegating-clone -> point-light-scope ->
// fragment-gates closes a cycle: entered at lod-fade, `GATE_DEFINES` read this
// name before lod-fade had set it (a boot crash, 2026-10-07;
// `tests/unit/fragment-gates-load-order.test.ts`). A leaf cannot be half-loaded.

/**
 * The define a fading clone carries. `material.defines` is hashed into three's
 * program cache key, so setting it on a clone is half of what makes it a
 * second program (see `lod-fade.ts`).
 */
export const LOD_FADE_DEFINE = 'FF2_LOD_FADE'
