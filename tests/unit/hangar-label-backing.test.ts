// tests/unit/hangar-label-backing.test.ts — the room's words paint exactly as
// they did before DEV-488 lifted DEV-437's backing out of `createHangar`.
//
// DEV-437 wrapped every one of the room's canvases' `fillText` in a closure
// inside `createHangar`: a rounded dark plate behind each line and a fine
// outline round its letters. DEV-488 lifted that closure verbatim to module
// scope (`backHolotableText`), so the Your courses shelf's labels could wear
// it too. This file proves the lift moved no pixel on the room's own
// canvases: a canvas's pixels are a function of the calls made on it, their
// arguments and the context state at each call. So every call the room makes
// on every canvas it builds (the tables, the lap plates, the header) is
// recorded through a recording 2d context. The full sequence is compared with
// the one the room made BEFORE the lift, which is stored in
// `fixtures/hangar-label-strokes.json`.
//
// The fixture was written by this file at the parent of the lift commit
// (`HANGAR_STROKES_RECORD=1`). Rewrite it only on purpose, when the room's
// words are MEANT to paint differently.
//
// **Re-recorded once, on purpose, by DEV-559** (Matt, 2026-10-01: *"don't
// show the game modes on the aircraft mode select, nor number of courses vs
// flown"*). Checked call by call against the old fixture before it was
// replaced: the new one is the old one with exactly these lines' calls (each
// line's backing included) taken out, and nothing else moved: the aircraft
// table's plans and count, the plan table's count, and the placeholder's two
// EMPTY lines (an empty line is no longer painted, so it is no longer backed
// by an empty pill).
//
// **Re-recorded once more, on purpose, by DEV-605**: the lap plate's BACK
// word paints as two lines, a small BACK TO over the step's header word.
// Checked against the old fixture: one canvas of seven differs (the lap
// plate), and in it the PAGE painting is unchanged.
//
// **Re-recorded once more, on purpose, by DEV-793**: the CREDITS floor word is a
// ninth canvas, painted through the same backing. Checked against the old
// fixture: the eight earlier canvases are identical call for call and the new
// one is the only entry added (the word's pill and outline, then its fill).
//
// **DEV-832 changed that word's text**, `< CREDITS` to `< OPTIONS`, and nothing
// else: the same calls at the same sizes (a text edit of the fixture).

import fs from 'node:fs'
import path from 'node:path'
import type * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MissionCard } from '@/game/mission-index'
import { withYourCourses } from '@/render/course-shelf'
import { createHangar, paintHolotableLabel } from '@/render/hangar'
import { hangarSpecFor } from '@/sim/hangar'

// **Edited once more, on purpose, by DEV-848**: the UI face is CRYSTAL, so every
// font string in the fixture names `FF2 CRYSTAL` where it named `Roboto Condensed`.
// Nothing else in it moved (node has no loaded font, so the weights stay as asked).

const FIXTURE = path.join(process.cwd(), 'tests/unit/fixtures/hangar-label-strokes.json')

type Call = readonly unknown[]

/** A 2d context that records every call with the state it was made under. */
const recordingContext = (log: Call[]) => {
  const state = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  }
  const stack: (typeof state)[] = []
  const styles = () => [
    state.fillStyle,
    state.strokeStyle,
    state.lineWidth,
    state.lineJoin,
    state.font,
    state.textAlign,
    state.textBaseline,
  ]
  const ctx: Record<string, unknown> = {
    save: () => {
      stack.push({ ...state })
      log.push(['save'])
    },
    restore: () => {
      Object.assign(state, stack.pop() ?? state)
      log.push(['restore'])
    },
    clearRect: (...a: number[]) => log.push(['clearRect', ...a]),
    fillRect: (...a: number[]) => log.push(['fillRect', ...a, ...styles()]),
    beginPath: () => log.push(['beginPath']),
    roundRect: (...a: number[]) => log.push(['roundRect', ...a]),
    rect: (...a: number[]) => log.push(['rect', ...a]),
    fill: () => log.push(['fill', ...styles()]),
    stroke: () => log.push(['stroke', ...styles()]),
    fillText: (...a: unknown[]) => log.push(['fillText', ...a, ...styles()]),
    strokeText: (...a: unknown[]) => log.push(['strokeText', ...a, ...styles()]),
    // Deterministic metrics: the backing plate is sized from them.
    measureText: (t: string) => ({ width: t.length * 11 }),
  }
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key as keyof typeof state],
      set: (v: never) => {
        state[key as keyof typeof state] = v
      },
    })
  }
  return ctx
}

/** Every canvas the room creates, in creation order, each with its own log. */
const recordCanvases = (): Call[][] => {
  const logs: Call[][] = []
  vi.stubGlobal('document', {
    createElement: () => {
      const log: Call[] = []
      logs.push(log)
      const ctx = recordingContext(log)
      return { width: 0, height: 0, style: {}, getContext: () => ctx, log }
    },
  })
  return logs
}

/** The call log a recording canvas keeps. */
const logOf = (canvas: unknown): Call[] => (canvas as { log: Call[] }).log

const card = (id: string, vehicle: string, environment: string) =>
  ({
    id,
    title: id,
    vehicle: vehicle as MissionCard['vehicle'],
    difficulty: 'beginner',
    chainIndex: 0,
    environment,
    mode: 'ringAttack',
    vehicleName: vehicle,
    difficultyName: 'Beginner',
    modeName: 'Ring Attack',
    environmentName: environment,
    best: null,
    medal: null,
  }) satisfies MissionCard

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('DEV-488 — lifting DEV-437’s backing moved no pixel of the room’s own words', () => {
  it('paints every canvas of the room with the same calls, in the same state, as before the lift', () => {
    const logs = recordCanvases()
    const room = createHangar({
      spec: hangarSpecFor(),
      seed: 0x48414e47,
      title: '',
      subtitle: '',
      level: null,
      missions: [card('hj_a', 'hoverjet', 'simonet'), card('js_a', 'jumpseat', 'alpine')],
      currentId: 'hj_a',
      shapeFor: () => new Promise(() => {}),
    })
    // Two steps' worth of words: the aircraft, then the HoverJet's plans.
    room.openVehicle(0)
    room.setBusy('LOADING')
    room.setBusy(null)
    const recorded = JSON.parse(JSON.stringify(logs)) as Call[][]
    const drawn = recorded.flat().filter((c) => c[0] === 'fillText').length
    expect(drawn, 'the premise: the room painted words').toBeGreaterThan(5)
    expect(
      recorded.flat().filter((c) => c[0] === 'rect').length,
      'the premise: they were backed (DEV-437)',
    ).toBe(drawn)
    if (process.env.HANGAR_STROKES_RECORD === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded)}\n`)
      return
    }
    const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Call[][]
    expect(recorded.length, 'the same canvases').toBe(before.length)
    for (const [i, log] of recorded.entries()) expect(log, `canvas ${i}`).toEqual(before[i])
  })

  it('paints a Custom courses label EXACTLY as the room paints its own, backing and all', () => {
    recordCanvases()
    const base = createHangar({
      spec: hangarSpecFor(),
      seed: 0x48414e47,
      title: '',
      subtitle: '',
      level: null,
      missions: [card('hj_a', 'hoverjet', 'simonet'), card('js_a', 'jumpseat', 'alpine')],
      currentId: 'hj_a',
      shapeFor: () => new Promise(() => {}),
    })
    withYourCourses(base, {
      spec: hangarSpecFor(),
      enabled: () => false,
      entries: () => [],
      levelFor: () => new Promise(() => {}),
    })
    const labelCanvas = (group: THREE.Object3D): HTMLCanvasElement =>
      (
        (
          group.children.find((c) => {
            const m = c as THREE.Mesh
            return m.isMesh && m.geometry.type === 'PlaneGeometry'
          }) as THREE.Mesh
        ).material as THREE.MeshBasicMaterial
      ).map?.image as HTMLCanvasElement
    const room = labelCanvas(base.object.getObjectByName('hangar-holotable') as THREE.Object3D)
    const shelf = labelCanvas(base.object.getObjectByName('your-courses-door') as THREE.Object3D)
    expect(shelf, 'the premise: two canvases').not.toBe(room)
    expect([shelf.width, shelf.height]).toEqual([room.width, room.height])
    for (const canvas of [room, shelf]) {
      logOf(canvas).length = 0
      paintHolotableLabel(canvas, 'Amber Heron', 'Simonet Islands · Ring Attack', 'no time set')
    }
    expect(logOf(shelf).filter((c) => c[0] === 'rect').length, 'backed').toBe(3)
    expect(logOf(shelf)).toEqual(logOf(room))
  })
})
