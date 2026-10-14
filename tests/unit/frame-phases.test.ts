// tests/unit/frame-phases.test.ts: the frame is a list of phases, in one order,
// and no phase outgrows what V8 will optimise. DEV-975.
//
// `createFrame`'s `frame` was one closure of about five thousand lines. Its
// bytecode (67,881 bytes in node 24's V8) was over `--max-optimized-bytecode-size`
// (61,440), so TurboFan never saw it and every frame ran in the interpreter and
// the baseline tier. It is now 24 named phase functions in `src/boot/app/frame.ts`,
// called in the order the work happens. Three things stand against the split
// undoing itself:
//
//   1. the phases are the ones listed here, called once each, in this order. The
//      order is the contract: input before the menus before the confirm handler
//      (B closes a plate BEFORE the latch is taken, `phasePauseMenus` before
//      `phasePointer`), the sim after every press, the camera after the sim and
//      the view decision, the touch context last because every flag it reads is
//      settled, the draw last. Adding a phase is a decision, so it is edited in
//      here on purpose;
//   2. a phase never returns early. Only `frame` may (the running check and the
//      course editor, whose frame is the whole frame): a `return` inside a phase
//      would skip every phase after it without saying so. A phase's one allowed
//      `return` is its last statement, the object a later phase reads;
//   3. each phase compiles to under 40,000 bytes of bytecode and `frame` itself to
//      under 8,000, measured by V8 (`--print-bytecode`) on the transpiled file. A
//      phase that grows toward V8's 61,440 stops being optimised again, which is
//      the whole of what the split bought.
//
// The phase bodies are the old frame's statements moved unchanged; that claim is
// held by the diff (`git diff -U0` against the commit before DEV-975 removes five
// lines) and by `git log`, not by a test that could only compare two copies.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { appFileWith } from './helpers/app-source'

/** The phases, in the order `frame` calls them. */
const PHASES = [
  'phaseOpen',
  'phaseInput',
  'phasePilot',
  'phaseReveal',
  'phaseXrSession',
  'phasePauseMenus',
  'phasePointer',
  'phaseConfirm',
  'phaseLapPresses',
  'phaseSim',
  'phaseStage',
  'phaseView',
  'phaseTitle',
  'phaseCamera',
  'phaseAfterCamera',
  'phaseRoomAim',
  'phaseRacerRender',
  'phaseAudio',
  'phasePanels',
  'phaseWorldClocks',
  'phaseFeel',
  'phaseEnvironment',
  'phaseTouch',
  'phaseRender',
] as const

/** Under V8's 61,440 with room to grow. The largest function is the sim's per-tick callback, about 20,000. */
const PHASE_BYTECODE_MAX = 40_000
/** `frame` is a list of calls. */
const FRAME_BYTECODE_MAX = 8_000

const frameFile = () => appFileWith('const frame = (time')

const parse = () => ts.createSourceFile('frame.ts', frameFile().text, ts.ScriptTarget.ES2022, true)

const arrows = (sf: ts.SourceFile): Map<string, ts.ArrowFunction> => {
  const out = new Map<string, ts.ArrowFunction>()
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isArrowFunction(n.initializer)
    ) {
      out.set(n.name.text, n.initializer)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('the frame is a list of phases (DEV-975)', () => {
  it('calls the phases, once each, in the pinned order', () => {
    const fns = arrows(parse())
    const frame = fns.get('frame')
    expect(frame, 'createFrame defines `frame`').toBeDefined()
    const called: string[] = []
    for (const s of ((frame as ts.ArrowFunction).body as ts.Block).statements) {
      let call: ts.Expression | undefined
      if (ts.isExpressionStatement(s)) call = s.expression
      else if (ts.isVariableStatement(s)) call = s.declarationList.declarations[0]?.initializer
      if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
        if (/^phase[A-Z]/.test(call.expression.text)) called.push(call.expression.text)
      }
    }
    expect(called).toEqual([...PHASES])
  })

  it('defines exactly the pinned phases, each before `frame`', () => {
    const sf = parse()
    const defined = [...arrows(sf).keys()].filter((k) => /^phase[A-Z]/.test(k))
    expect(defined.sort()).toEqual([...PHASES].sort())
    const text = frameFile().text
    const frameAt = text.indexOf('const frame = (time')
    for (const p of PHASES) {
      const at = text.indexOf(`const ${p} = (`)
      expect(at, `${p} is defined`).toBeGreaterThan(-1)
      expect(at, `${p} before frame`).toBeLessThan(frameAt)
    }
  })

  it('has no early return in a phase: only the last statement may, and it returns the next phase its object', () => {
    const fns = arrows(parse())
    for (const p of PHASES) {
      const fn = fns.get(p) as ts.ArrowFunction
      const body = fn.body as ts.Block
      const returns: ts.ReturnStatement[] = []
      const visit = (n: ts.Node): void => {
        if (ts.isReturnStatement(n)) returns.push(n)
        // a nested function's own returns are its own
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
          return
        ts.forEachChild(n, visit)
      }
      for (const s of body.statements) visit(s)
      const last = body.statements[body.statements.length - 1]
      for (const r of returns) {
        expect(
          r,
          `${p}: a return that is not the phase's last statement skips every phase after it`,
        ).toBe(last)
        expect(
          r.expression !== undefined && ts.isObjectLiteralExpression(r.expression),
          `${p}: the last return hands the next phases an object`,
        ).toBe(true)
      }
    }
  })

  it('keeps `frame`s own early returns to the running check and the editor', () => {
    const frame = arrows(parse()).get('frame') as ts.ArrowFunction
    const returns: string[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n))
        returns.push(n.parent.getText().replace(/\s+/g, ' ').slice(0, 60))
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return
      ts.forEachChild(n, visit)
    }
    for (const s of (frame.body as ts.Block).statements) visit(s)
    expect(returns).toEqual([
      'if (!ctx.running) return',
      'if (editorFrame(time, openOut.frameSeconds)) return',
    ])
  })
})

describe('no phase outgrows what V8 will optimise (DEV-975)', () => {
  /**
   * V8's own bytecode length of every function the transpiled file defines, by name (an anonymous
   * one, such as the sim's per-tick callback, under ''). A control child that compiles an empty
   * script prints node's own handful of functions, none over 1,100 bytes.
   */
  const bytecodeLengths = (): Map<string, number> => {
    const js = ts.transpileModule(frameFile().text, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        verbatimModuleSyntax: false,
        isolatedModules: true,
      },
    }).outputText
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-frame-phases-'))
    const file = path.join(dir, 'frame.cjs')
    fs.writeFileSync(file, js)
    try {
      const out = execFileSync(
        process.execPath,
        [
          '--no-lazy',
          '--print-bytecode',
          '--print-bytecode-filter=*',
          '-e',
          "new (require('vm').Script)(require('fs').readFileSync(process.argv[1], 'utf8'))",
          file,
        ],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      )
      const lengths = new Map<string, number>()
      let name: string | null = null
      for (const line of out.split(/\r?\n/)) {
        const m = /^\[generated bytecode for function: (\S*) /.exec(line)
        if (m) name = m[1] ?? ''
        const b = /^Bytecode length: (\d+)/.exec(line)
        if (b && name !== null) {
          lengths.set(name, Math.max(lengths.get(name) ?? 0, Number(b[1])))
          name = null
        }
      }
      return lengths
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('compiles every phase, the sim callback and every other function under the bound, and frame to a list of calls', () => {
    const lengths = bytecodeLengths()
    for (const p of PHASES) {
      const n = lengths.get(p)
      expect(n, `V8 compiled ${p} (an empty read passes for ever)`).toBeGreaterThan(0)
      expect(n, `${p} bytecode`).toBeLessThan(PHASE_BYTECODE_MAX)
    }
    const frame = lengths.get('frame')
    expect(frame, 'V8 compiled frame').toBeGreaterThan(0)
    expect(frame, 'frame bytecode').toBeLessThan(FRAME_BYTECODE_MAX)
    // The per-tick sim callback is anonymous and the largest function in the file; so is anything
    // else a phase hands to a call. No function of any name may reach the bound.
    const largest = [...lengths.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number]
    expect(largest[1], `the largest function (${largest[0] || 'anonymous'}) bytecode`).toBeLessThan(
      PHASE_BYTECODE_MAX,
    )
  })
})
