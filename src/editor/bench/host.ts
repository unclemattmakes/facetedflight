// src/editor/bench/host.ts — the contract between the game and the VR bench.
// DEV-492 (EDITOR.md §5.3, "On the bench (headset)").
//
// TYPES ONLY, as `editor/desk/host.ts` is: `boot/app.ts` imports this with
// `import type`, and the bench itself arrives by a dynamic
// `import('@/editor/bench')` the first time the door is pressed
// (`tests/unit/editor-desk.test.ts` holds app.ts to types from `src/editor/`).
//
// The split of duties, the desk's:
//
//   the GAME (app.ts)   owns the room, the session, the laser, the switch.
//                       It stands the bench's object in the hangar, hands it
//                       each hand's ray and buttons every frame the bench is
//                       up, and flies a playtest through the editor's own
//                       switch, coming back to the ROOM with the lap.
//   the BENCH           owns the draft, the history, the table and what it
//                       draws. It never reaches into the game's state.

import type * as THREE from 'three'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import type { PlaytestRequest, PlaytestResult } from '@/editor/core'
import type { DeskTerrains } from '@/editor/desk/host'
import type { HoloLook } from '@/render/diorama'

/** What the game hands the bench. Implemented in `boot/app.ts` (DEV-492's block). */
export interface BenchHost {
  /** The hangar room's object: the bench stands in its frame. */
  readonly room: THREE.Object3D
  /** The seated eye, and the bearing the seat faces, in the ROOM's frame. */
  readonly seat: { readonly x: number; readonly y: number; readonly z: number }
  readonly seatBearing: number
  /** A shipped mission by id (a draft's sky). */
  loadLevel(id: string): Promise<Level>
  /** The sky a new draft starts over when this browser has none. */
  readonly defaultSky: string
  /**
   * The level the game's world is BUILT for now, and its terrains, or null
   * while none is. The bench judges and places against that world's RENDER
   * surface when it is the draft's island (`editor/desk/ground.ts`).
   */
  liveLevel(): Level | null
  terrains(): DeskTerrains | null
  /** The preset's racer grid (DEV-475), for the pad's racer slots. */
  racers(): EditionRacers
  /** The menus' holo look (D35), or null for the plain model. */
  holoLook(): HoloLook | null
  /** Fly `request.level` through the editor's switch; back with `resume(result)`. */
  fly(request: PlaytestRequest): void
  /** Put the bench away, back to the room. */
  leave(): void
}

/** One hand as the bench reads it: its ray (WORLD frame) and its buttons. */
export interface BenchHand {
  readonly hand: 'left' | 'right'
  readonly origin: readonly [number, number, number]
  /** Unit. */
  readonly direction: readonly [number, number, number]
  readonly trigger: boolean
  readonly squeeze: boolean
  /** Thumbstick click. */
  readonly stick: boolean
  /** The lower face button (A, X): undo. */
  readonly lower: boolean
  /** The upper face button (B, Y): redo. */
  readonly upper: boolean
}

/** Where the game draws the laser this frame: from `hand`, `distance` metres out (null: on nothing). */
export interface BenchBeam {
  readonly hand: 'left' | 'right'
  readonly distance: number | null
}

export interface Bench {
  readonly object: THREE.Object3D
  /** Open on the most recent draft (or a new one), or with `result` after a flight. */
  open(result?: PlaytestResult | null): void
  /** Save, and put the bench away. */
  close(): void
  /** One frame with the bench up: the hands, then what the laser shows. */
  frame(seconds: number, hands: readonly BenchHand[]): BenchBeam | null
  /** Plain values for `__ff2.bench()` and the e2e spec. */
  probe(): BenchProbe
}

export interface BenchProbe {
  readonly up: boolean
  /** The island is drawn and the draft is live. */
  readonly ready: boolean
  readonly slot: string | null
  readonly sky: string | null
  readonly island: string | null
  /** The draft's control points, level frame. */
  readonly points: readonly (readonly [number, number, number])[]
  readonly selection: number | null
  readonly pad: readonly [number, number, number] | null
  readonly undo: number
  readonly redo: number
  readonly rings: number
  readonly warnings: readonly { kind: string; severity: string }[]
  /** 'render' when points sit over the built world's render surface; 'field' otherwise. */
  readonly ground: 'render' | 'field' | null
  /** Metres a new point stands over the ground. */
  readonly placeHeight: number
  /** What each hand is on: a handle index, 'pad', 'line', 'ground', a plate cell, or null. */
  readonly aimed: Readonly<Record<'left' | 'right', string | null>>
  /** The point (or 'pad') a grip holds, per hand. */
  readonly held: Readonly<Record<'left' | 'right', string | null>>
  /** The bench-frame → room-frame matrix's columns, and the island's frame, for a spec's geometry. */
  readonly frame: {
    readonly centreX: number
    readonly centreZ: number
    readonly seaY: number
    readonly scale: number
    readonly relief: number
  } | null
  /** The bench's local origin and axes, WORLD frame: origin, +x, +y, +z unit vectors. */
  readonly axes: readonly (readonly [number, number, number])[] | null
  /** The plate's cells, WORLD frame centres, by name. */
  readonly cells: Readonly<Record<string, readonly [number, number, number]>>
  readonly status: string
  readonly note: string
  /** The last authored lap the draft holds, seconds, or null. */
  readonly authorLap: number | null
  /** Each hand's ray as the bench last read it, WORLD frame. */
  readonly rays: Readonly<
    Record<
      'left' | 'right',
      { readonly origin: readonly number[]; readonly direction: readonly number[] } | null
    >
  >
  /** Where each hand's ray lands on the island, LEVEL frame, or null. */
  readonly hits: Readonly<Record<'left' | 'right', readonly number[] | null>>
  /** The ground the bench judges against under each point, level frame (null: none). */
  readonly groundUnder: readonly (number | null)[]
}
