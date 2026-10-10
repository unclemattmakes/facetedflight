// tests/unit/support/gate-preprocessor.ts — the driver's half of a gate test.
//
// Extracted from `fragment-gates.test.ts` by DEV-238, when a second file
// (`water-gates.test.ts`) needed the same thing. Not copied: two
// preprocessors that are supposed to agree are two preprocessors that will not,
// and the one that drifts is the one whose test still passes.
//
// It is deliberately NOT a re-implementation of the patch. `gateFragmentShader`
// and `water.ts`'s splices INSERT directives; this evaluates them the way a
// driver will and lets a test ask whether the named thing is gone. A test that
// re-derives its expectation the way the code does has not tested the code
// (CLAUDE.md, trap 24).

/**
 * Evaluate `#ifdef` / `#ifndef` / `#else` / `#endif` for the FF2 gate names
 * only, leaving every other directive as text.
 *
 * Scoped to our own names on purpose: three's chunks are full of `#if` blocks
 * whose conditions depend on defines three sets at compile time, and a
 * preprocessor that tried to evaluate those would be a second implementation of
 * `WebGLProgram` and wrong in its own way. Ours nest inside three's and never
 * inside each other, so tracking depth is enough to find the matching `#endif`.
 */
export const preprocessGates = (
  source: string,
  defined: readonly string[],
  /**
   * Restrict which `FF2_*` names this evaluates; anything else passes through
   * as text. DEV-238.
   *
   * Omitted, every `FF2_*` directive is evaluated, which is what the terrain's
   * gates want — the terrain shader has no other FF2 conditional in it. The sea
   * does: `FF2_WATER_TWO_SIDED`, `FF2_WATER_SHAFT` and `FF2_SUN_HEIGHT` are the
   * variant switch and a patch's own feature flag, not arms, and a test that
   * quietly resolved them would be asking about a shader nothing compiles.
   */
  only: readonly string[] | null = null,
): string => {
  const lines = source.split('\n')
  const out: string[] = []
  // Each open FF2 block: whether its body is kept, and how many of three's own
  // `#if` blocks are open INSIDE it — so a three `#endif` is never mistaken for
  // ours. Counting foreign depth GLOBALLY was the first version and it is
  // wrong: our IBL gate sits inside two of three's `#if`s, so the counter was
  // already non-zero when our directive arrived and the gate read as text.
  const stack: { keeping: boolean; foreign: number }[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const top =
      stack.length > 0 ? (stack[stack.length - 1] as { keeping: boolean; foreign: number }) : null
    const ours = /^#(ifdef|ifndef)\s+(FF2_\w+)/.exec(trimmed)
    const mine = ours !== null && (only === null || only.includes(ours[2] as string))
    if (ours && mine && (top === null || top.foreign === 0)) {
      const name = ours[2] as string
      const has = defined.includes(name)
      stack.push({ keeping: ours[1] === 'ifdef' ? has : !has, foreign: 0 })
      continue
    }
    if (top !== null && top.foreign === 0 && trimmed === '#else') {
      top.keeping = !top.keeping
      continue
    }
    if (top !== null && top.foreign === 0 && trimmed === '#endif') {
      stack.pop()
      continue
    }
    if (/^#(if|ifdef|ifndef)\b/.test(trimmed)) {
      if (top !== null) top.foreign++
    } else if (trimmed.startsWith('#endif') && top !== null && top.foreign > 0) top.foreign--
    if (stack.every((f) => f.keeping)) out.push(line)
  }
  return out.join('\n')
}

/**
 * Every line that is one of OUR directives, dropped — and nothing else touched.
 *
 * This is the other half of *"the default does not move"*, and it is a stronger
 * claim than `preprocessGates(text, [])`. That one says the gated statements
 * survive; this one says the text a driver compiles with no define set is
 * **byte-identical** to the text it compiled before the gates existed, because
 * an `#ifndef` whose name is absent and its `#endif` are the only two lines
 * that changed. A gate that accidentally reindented, reordered or reworded a
 * line it was only supposed to bracket fails here and passes there.
 */
export const stripGateDirectives = (source: string, names: readonly string[]): string => {
  const out: string[] = []
  // Open blocks of OURS, each counting the foreign `#if`s nested inside it, for
  // the same reason `preprocessGates` does: a three `#endif` must never be
  // mistaken for the close of one of ours.
  const stack: { foreign: number }[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const top = stack.length > 0 ? (stack[stack.length - 1] as { foreign: number }) : null
    const opens = /^#(ifdef|ifndef)\s+(FF2_\w+)/.exec(trimmed)
    if (opens && names.includes(opens[2] as string) && (top === null || top.foreign === 0)) {
      stack.push({ foreign: 0 })
      continue
    }
    if (top !== null && top.foreign === 0 && trimmed === '#endif') {
      stack.pop()
      continue
    }
    if (/^#(if|ifdef|ifndef)\b/.test(trimmed)) {
      if (top !== null) top.foreign++
    } else if (trimmed.startsWith('#endif') && top !== null && top.foreign > 0) top.foreign--
    out.push(line)
  }
  return out.join('\n')
}
