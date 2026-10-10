/**
 * tests/e2e/fixtures/shader-link.ts — did every GLSL program this page built
 * actually LINK? DEV-324.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * No gate in this repo compiles a shader. `tsc`, `biome`, `vitest`,
 * `extract:check`, `assets:check` and `vite build` all pass while a program
 * fails to link, and that shipped twice in eight days — most recently DEV-298's
 * `uSunTopXf`, declared in the FRAGMENT prelude and used in the VERTEX shader:
 * two symbol tables, `VALIDATE_STATUS false`, GL error 1282, on the title
 * screen, with a unit test named after the defect green beside it.
 *
 * ── Two detectors, and why the console alone is not enough ───────────────
 *
 * 1. **What three prints.** three 0.185.1's `WebGLProgram` checks
 *    `gl.getProgramParameter( program, gl.LINK_STATUS )` inside `onFirstUse`
 *    and, when it is false, calls its `error()` helper with a message that
 *    starts `WebGLProgram: Shader Error <glError> - VALIDATE_STATUS …` — and
 *    `error()` prefixes `THREE.`. That prefix is `SHADER_ERROR_PREFIX` below,
 *    and `tests/unit/shader-link-signature.test.ts` reads it back out of
 *    three's own build so a pin bump that rewords it goes red in node.
 *
 *    **An exact prefix, not a word.** A program that linked but has a
 *    non-empty info log gets `warn( 'WebGLProgram: Program Info Log:', … )` —
 *    on this box the ANGLE/D3D11 compiler's `warning X4122` precision notes,
 *    which every run logs and every run survives, and which share
 *    `THREE.WebGLProgram:` with the failure. App lines mention shaders too.
 *    So the classifier keys on three's two full prefixes and nothing looser.
 *    (`docs/AGENT-NOTES.md` §4 says a regex for *shader* matched the X4122
 *    lines. DEV-324's runs did not reproduce that particular overlap: 12
 *    `Program Info Log` warnings, 60 X4122 lines, none containing the word.
 *    The rule stands on the prefix argument alone.)
 *
 * 2. **What GL says, for every program three holds.** `onFirstUse` is LAZY: it
 *    runs from `getUniforms()` / `getAttributes()`, i.e. the first time a
 *    program is DRAWN. `WebGLRenderer.compile()` creates and links programs and
 *    calls neither — and `render/warm-up.ts` builds most of this game's
 *    programs exactly that way, under the loading curtain, including every
 *    variant a headset session draws with (`alsoDefaultTarget`, DEV-239) that
 *    a flat run never draws at all. **A link failure in one of those prints
 *    nothing, ever, on a flat run.** So the sweep asks GL directly:
 *    `LINK_STATUS` of every entry in `renderer.info.programs`, which is three's
 *    whole program cache — and this app has exactly one renderer
 *    (`render/renderer.ts`) and no raw `gl.createProgram` anywhere in `src/`.
 *
 *    That is observation, not a different code path: a GL query changes no
 *    state three reads. The only write in here — `renderer.properties.get` on a
 *    material, which creates an empty entry if absent — runs on the FAILURE
 *    path only, to name who uses the broken program, when the run is already
 *    red.
 *
 * ── Positive first ───────────────────────────────────────────────────────
 *
 * A frame that drew nothing reports zero errors too. So the sweep also returns
 * the frame's draw calls, triangles and the program count, and the spec asserts
 * those are non-zero BEFORE it asserts the failure list is empty.
 */
import type { Page } from '@playwright/test'
import { decodeProgramCacheKey, describeProgramKey } from './program-key'

// ── the signatures, which the unit test holds to three's build ───────────

/**
 * three's message for a program whose `LINK_STATUS` is false. `console.error`,
 * one string, and it carries the material type, the program info log and each
 * shader's `ERROR: 0:<line>` block.
 */
export const SHADER_ERROR_PREFIX = 'THREE.WebGLProgram: Shader Error'

/**
 * three's message for a program that LINKED with a non-empty info log.
 * `console.warn`. Benign: counted and printed, never failed on.
 */
export const PROGRAM_INFO_LOG_PREFIX = 'THREE.WebGLProgram: Program Info Log:'

/**
 * Chrome's own, when a draw binds a program that did not link. It follows a
 * `SHADER_ERROR_PREFIX` line, so it names nothing new — but it is the one
 * signature that does not depend on three's `checkShaderErrors` being on.
 */
export const USE_PROGRAM_NOT_VALID = 'useProgram: program not valid'

export type ConsoleKind = 'link-failure' | 'program-info-log' | 'webgl' | 'other'

/**
 * What one console line is, for this spec's purposes. Decided by exact
 * prefixes, never by a word that benign lines share with fatal ones.
 */
export const classifyConsole = (text: string): ConsoleKind => {
  if (text.startsWith(SHADER_ERROR_PREFIX)) return 'link-failure'
  if (text.includes(USE_PROGRAM_NOT_VALID)) return 'link-failure'
  if (text.startsWith(PROGRAM_INFO_LOG_PREFIX)) return 'program-info-log'
  // Printed beside the counts, not failed on: a driver performance note or an
  // INVALID_* from something that is not a program is not this spec's row.
  if (/^WebGL: |GL_INVALID_|\[\.WebGL-/.test(text)) return 'webgl'
  return 'other'
}

/** The first `ERROR:` line of a shader or program log, or the first line. */
export const firstErrorLine = (log: string): string => {
  const lines = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  return lines.find((l) => /\bERROR\b/.test(l)) ?? lines[0] ?? ''
}

/**
 * One console failure as one line: three's material type and the first
 * `ERROR:` it quotes, rather than the whole numbered source listing three
 * appends after it.
 */
export const describeConsoleFailure = (text: string): string => {
  const type = /Material Type: (\S*)/.exec(text)?.[1]
  const name = /Material Name: ([^\n]*)/.exec(text)?.[1]?.trim()
  const head = text.split('\n')[0] ?? text
  const err = firstErrorLine(text.split('\n').slice(1).join('\n'))
  return [head, type ? `${type}${name ? ` '${name}'` : ''}` : '', err && err !== head ? err : '']
    .filter((s) => s.length > 0)
    .join(' · ')
}

/**
 * Identical lines once each, with a count. A broken program is bound on every
 * draw, and Chrome logs `useProgram: program not valid` each time until its
 * per-context cap — the first RED run collected 258 console lines for two
 * broken programs, which buried the two that named them.
 */
export const collapseRepeats = (lines: readonly string[]): string[] => {
  const counts = new Map<string, number>()
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1)
  return [...counts].map(([l, n]) => (n > 1 ? `×${n} ${l}` : l))
}

// ── the console ledger ───────────────────────────────────────────────────

export interface ConsoleLine {
  readonly type: string
  readonly text: string
  readonly kind: ConsoleKind
}

export interface ShaderConsole {
  /** Every console line and page error so far, in order. */
  readonly lines: () => readonly ConsoleLine[]
  /** Uncaught exceptions, printed beside the counts. */
  readonly pageErrors: () => readonly string[]
}

/** Start recording. Call before `page.goto`. */
export const watchShaderConsole = (page: Page): ShaderConsole => {
  const lines: ConsoleLine[] = []
  const pageErrors: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    lines.push({ type: msg.type(), text, kind: classifyConsole(text) })
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })
  return { lines: () => [...lines], pageErrors: () => [...pageErrors] }
}

// ── the GL sweep ─────────────────────────────────────────────────────────

export interface FailedProgram {
  /** three's `WebGLProgram.id`. */
  readonly id: number
  /** `material.name` at compile time — often empty. */
  readonly name: string
  /** `material.type`, e.g. `MeshStandardMaterial`. */
  readonly type: string
  /** The full cache key; decode with `fixtures/program-key.ts`. */
  readonly cacheKey: string
  readonly programLog: string
  readonly vertexLog: string
  readonly fragmentLog: string
  /**
   * Whether three has already run `onFirstUse` on it — i.e. whether it was
   * ever DRAWN, and so whether the console could possibly have reported it.
   */
  readonly drawn: boolean
  /** `object name / material name` of up to eight scene users. */
  readonly usedBy: readonly string[]
}

/**
 * NAME a program that did not link, in one line: which program, what material,
 * the variant (the decoded key, whose `tagProgramCacheKey` chain says which
 * module in `src/render/` to open), who draws it, and the compiler's own first
 * error for each half.
 */
export const describeFailedProgram = (f: FailedProgram): string => {
  const decoded = decodeProgramCacheKey(f.cacheKey)
  // three's default `customProgramCacheKey()` is `onBeforeCompile.toString()`,
  // so the key's tag field opens with the whole patch FUNCTION SOURCE and only
  // then carries this project's `|tag` chain. The first RED run printed forty
  // lines of JavaScript per program. The chain is what names the module, and
  // it is everything after the function's closing brace.
  const tail = decoded.tag.lastIndexOf('}')
  const tags = (tail >= 0 ? decoded.tag.slice(tail + 1) : decoded.tag)
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const variant = describeProgramKey({ ...decoded, tag: tags.join('|') })
  const halves = [
    f.vertexLog ? `VERTEX ${firstErrorLine(f.vertexLog)}` : '',
    f.fragmentLog ? `FRAGMENT ${firstErrorLine(f.fragmentLog)}` : '',
  ].filter((s) => s.length > 0)
  if (halves.length === 0) halves.push(`PROGRAM ${firstErrorLine(f.programLog) || '(no log)'}`)
  const users =
    f.usedBy.length > 0 ? `used by ${f.usedBy.join(', ')}` : 'held by no mesh in the drawn scenes'
  return [
    `program #${f.id} ${f.type}${f.name ? ` '${f.name}'` : ''}`,
    f.drawn ? 'drawn' : 'compiled and NEVER drawn, so the console cannot see it',
    variant,
    users,
    halves.join(' | '),
  ].join(' · ')
}

/**
 * How many `physical` programs carry the SESSION's output colour space.
 *
 * On Anniversary the flat frame is drawn by the bloom composer into a linear
 * target, so its lit programs are `srgb-linear`; a headset session draws them
 * at the canvas's `srgb` (DEV-239, `render/warm-up.ts`). So this is the count
 * that separates "the warm-up built the session's variants" from "it did not",
 * and the session arm asserts it is non-zero — without it, that arm would be
 * the flat arm again with a longer name.
 */
export const sessionKeyedPhysical = (keys: readonly string[]): number =>
  keys
    .map(decodeProgramCacheKey)
    .filter((d) => d.shaderId === 'physical' && d.parameters.outputColorSpace === 'srgb').length

export interface ProgramSweep {
  /** `renderer.info.render.calls` for the last frame. */
  readonly calls: number
  readonly triangles: number
  /** `renderer.info.programs.length`. */
  readonly programs: number
  /** Programs whose `LINK_STATUS` read back `true`. */
  readonly linked: number
  /**
   * Programs three built that have never been drawn — compiled only, by the
   * warm-up or a `compile()`. The console cannot see a failure in one of
   * these; only the sweep can.
   */
  readonly compileOnly: number
  /** Programs GL would not answer for (context lost, no handle). */
  readonly unreadable: number
  readonly failed: readonly FailedProgram[]
  /** `renderer.debug.checkShaderErrors` — the console half is live only when true. */
  readonly checkShaderErrors: boolean
  /** Every program's cache key, for the census line and the session premise. */
  readonly keys: readonly string[]
}

/**
 * Ask GL about every program three holds. Harness observation only; see the
 * header for the one write, which is on the failure path.
 */
export const sweepPrograms = (page: Page): Promise<ProgramSweep> =>
  page.evaluate(() => {
    interface Gl {
      LINK_STATUS: number
      DELETE_STATUS: number
      getProgramParameter: (p: unknown, pname: number) => unknown
      getShaderParameter: (s: unknown, pname: number) => unknown
      getProgramInfoLog: (p: unknown) => string | null
      getShaderInfoLog: (s: unknown) => string | null
    }
    interface Program {
      id: number
      name: string
      type: string
      cacheKey: string
      program?: unknown
      vertexShader?: unknown
      fragmentShader?: unknown
      diagnostics?: {
        programLog: string
        vertexShader: { log: string }
        fragmentShader: { log: string }
      }
    }
    interface Node {
      name?: string
      type?: string
      material?: { name?: string; type?: string } | { name?: string; type?: string }[]
      traverse: (fn: (o: Node) => void) => void
    }
    interface Renderer {
      getContext: () => Gl
      debug: { checkShaderErrors: boolean }
      info: { render: { calls: number; triangles: number }; programs: Program[] | null }
      properties: { get: (m: unknown) => { programs?: Map<string, Program> } }
    }
    const w = globalThis as unknown as {
      __ff2?: { render: { renderer: Renderer; scene: Node }; stage: () => Node }
    }
    const app = w.__ff2
    if (!app) throw new Error('shader-link: no __ff2 handle — the page never booted')
    const renderer = app.render.renderer
    const gl = renderer.getContext()
    const programs = renderer.info.programs ?? []

    const usersOf = (target: Program): string[] => {
      const out: string[] = []
      const seen = new Set<Node>()
      for (const root of [app.render.scene, app.stage()]) {
        if (seen.has(root)) continue
        seen.add(root)
        root.traverse((o) => {
          if (!o.material) return
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            const held = renderer.properties.get(m).programs
            if (!held) continue
            for (const p of held.values()) {
              if (p !== target) continue
              const label = `${o.name || o.type || '?'} / ${m.name || m.type || '?'}`
              if (!out.includes(label)) out.push(label)
            }
          }
        })
      }
      return out
    }

    let linked = 0
    let compileOnly = 0
    let unreadable = 0
    const failed: FailedProgram[] = []
    for (const p of programs) {
      if (!p.program) {
        unreadable += 1
        continue
      }
      // `onFirstUse` ends with `gl.deleteShader` on both halves. A shader still
      // attached to its program is only FLAGGED for deletion, so it survives
      // and answers `DELETE_STATUS` true — which is the one GL-side trace that
      // three has run `onFirstUse`, i.e. that the program has been DRAWN.
      // (Not `isShader`: the first run of this file used it and Chrome answers
      // true for a flagged shader, so every program read "never drawn".)
      const drawn =
        p.vertexShader !== undefined &&
        gl.getShaderParameter(p.vertexShader, gl.DELETE_STATUS) === true
      if (!drawn) compileOnly += 1
      const status = gl.getProgramParameter(p.program, gl.LINK_STATUS)
      if (status === true) {
        linked += 1
        continue
      }
      if (status !== false) {
        unreadable += 1
        continue
      }
      // Logs: three's own diagnostics when it has run `onFirstUse` (it records
      // them on every failure), else straight from the shaders, which are
      // still attached and readable either way.
      const d = p.diagnostics
      const vertexLog = d ? d.vertexShader.log : (gl.getShaderInfoLog(p.vertexShader) ?? '').trim()
      const fragmentLog = d
        ? d.fragmentShader.log
        : (gl.getShaderInfoLog(p.fragmentShader) ?? '').trim()
      failed.push({
        id: p.id,
        name: p.name ?? '',
        type: p.type ?? '',
        cacheKey: p.cacheKey,
        programLog: d ? d.programLog : (gl.getProgramInfoLog(p.program) ?? '').trim(),
        vertexLog,
        fragmentLog,
        drawn,
        usedBy: usersOf(p).slice(0, 8),
      })
    }

    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: programs.length,
      linked,
      compileOnly,
      unreadable,
      failed,
      checkShaderErrors: renderer.debug.checkShaderErrors === true,
      keys: programs.map((p) => p.cacheKey),
    }
  })
