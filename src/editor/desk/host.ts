// src/editor/desk/host.ts — the contract between the game and the desktop
// editor. DEV-469, E4 (docs/plan/EDITOR-DISPATCH.md; EDITOR.md §5.3).
//
// TYPES ONLY. `boot/app.ts` imports this file with `import type`, which the
// compiler erases, so the game's entry chunk carries none of the editor: the
// desk itself arrives by a dynamic `import('@/editor/desk')` the first time it
// is asked for (`tests/unit/editor-desk.test.ts` holds app.ts to that).
//
// The split of duties:
//
//   the GAME (app.ts)   owns the world, the screens, the fades and the switch.
//                       It builds the island the ordinary way, flies a
//                       playtest through `switchMission`, and brings the
//                       player back. While the editor is up it runs a short
//                       frame of its own: the world's per-frame upkeep (LOD,
//                       fog, sky, clouds) and one render from the DESK's camera,
//                       and none of the mission (no sim step, no input, no HUD).
//   the DESK            owns the draft, the history, the camera, the tools,
//                       the panel and what it draws. It never reaches into the
//                       game's state: what it needs comes through `DeskHost`.

import type * as THREE from 'three'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import type { PlayerCourse } from '@/content/player-course'
import type { PlayerCourseLight } from '@/content/player-course-light'
import type { PlaytestRequest, PlaytestResult } from '@/editor/core'
import type { LineClearingReceipt } from '@/game/props/course-clearing'
import type { CustomGround } from '@/game/terrain/custom-ground'
import type { LoadedTerrain } from '@/game/terrain/load-terrain'
import type { LapDoc } from '@/sim/ghost'
import type { PropColliders } from '@/sim/props/collision'

/** The world's two terrains as the game built them. */
export interface DeskTerrains {
  readonly land: LoadedTerrain
  readonly ocean: LoadedTerrain | null
}

/** What the game hands the desk. Implemented in `boot/app.ts` (DEV-469's block). */
export interface DeskHost {
  readonly renderer: THREE.WebGLRenderer
  /** The mission scene: the desk's objects go in it, and are re-added after a world swap. */
  readonly scene: THREE.Scene
  readonly canvas: HTMLCanvasElement
  /** The game's own camera, as a template: its layers, near and far planes. Never moved. */
  readonly gameCamera: THREE.PerspectiveCamera
  /** The level the world now built was built for: a sky, or the last playtest's course. */
  level(): Level
  /**
   * DEV-475: the preset's racer grid (`gameplay.racers`), the one the game
   * spawns the racers from, so the desk draws them beside the start pad where
   * they will stand.
   */
  racers(): EditionRacers
  /**
   * DEV-504: how the preset draws the island's own scatter, so a NEW placed
   * prop matches it: `sink`, metres its pivot stands under the ground you see
   * (`props.groundSnap`, DEV-134; 0 where the snap is off), and `scale`, the
   * per-kind multiplier (`props.scale`: Anniversary's cacti at 0.35) its
   * default size is taken at. Only a new prop reads these; a placed one keeps
   * the numbers it was placed with, on either look.
   */
  propLook(): { readonly sink: number; readonly scale: Readonly<Record<string, number>> }
  /** The world's terrains, or null while a world is being built. */
  terrains(): DeskTerrains | null
  /**
   * Rebuild the world as `donor` — a change of sky — through the game's own
   * switch, and come back to the editor with `resume(null)`.
   */
  showWorld(donor: Level): void
  /** Fly `request.level` through the game's switch. Comes back with `resume(result)`. */
  fly(request: PlaytestRequest): void
  /** Leave the editor for the hangar. */
  leave(): void
  /**
   * DEV-476: light the world the editor draws as the course would fly it —
   * `light` over `donor` (its sun inside the sky's band, and its tint), or the
   * donor's own with null. `settled` false is a slider still moving: the game
   * moves the light, the fog's and the sea's sun and the sky's disc at once,
   * and re-bakes the far-shadow and sky-visibility maps only once it settles.
   */
  setLight(light: PlayerCourseLight | null, donor: Level, settled: boolean): void
  /**
   * DEV-500: move the drawn sea plate by `metres` from where the world built it
   * — the live preview of a water level being dragged. 0 puts it back.
   */
  previewWater(metres: number): void
  /**
   * DEV-502: clear `level`'s own ground on the world as drawn — its pad, the
   * island's volumes resolved against its pad and rings, and the capsule chain
   * along its flown line (`game/props/course-clearing.ts`'s `course` list, the
   * one a flight of it builds with). The trees it now covers are hidden and
   * lose their colliders; the ones the last line took and this one does not
   * come back. Null `level` is a draft with no line yet: every tree back.
   * Returns null when there is no forest, or `level` is of another island.
   */
  clearLine(level: Level | null): LineClearingReceipt | null
  /**
   * DEV-503: the world's LIVE colliding props, SIM space, as the game built
   * them and after any clearing (a cleared prop is out of the set); null with
   * no world, no forest or collision off. The desk judges its prop warnings
   * against them (`desk/prop-colliders.ts`).
   */
  propColliders(): PropColliders | null
  /**
   * DEV-503: the ids, in `propColliders()`, of the world's copy of a course's
   * PLACED props (DEV-504): the desk hides that copy and draws the draft's, so
   * its warnings leave these out and judge the draft's own.
   */
  placedPropIds(): readonly number[]
  /**
   * Save `course` (a VALID one) as a `.ffcourse` download, and keep it in the
   * library as made here: DEV-467's wire and DEV-467's one save path.
   */
  saveFile(course: PlayerCourse): Promise<void>
  /** `course`'s link (`#c=…`, DEV-467's wire), kept in the library as made here. */
  link(course: PlayerCourse): Promise<string>
  /** The library's courses, newest first (DEV-467's `course-library.ts`): what Remix offers. */
  library(): Promise<readonly DeskLibraryEntry[]>
  // ── DEV-490: a course's own island ──────────────────────────────────────
  /** Keep an imported map's bytes under their SHA-256, in the library's maps store. */
  keepMap(sha: string, bytes: Uint8Array): Promise<boolean>
  /**
   * The ground `course` stands on — null on its sky's own island — its map
   * read back from the library. Rejects (`PlayerCourseError`) when it cannot
   * be built: the map is not in this browser, or does not decode.
   */
  groundOf(course: PlayerCourse): Promise<CustomGround | null>
  // ── DEV-491: fly-to-author ──────────────────────────────────────────────
  /**
   * Fly `level` — a recording flight, `recordingLevel`'s: Free Flight from the
   * draft's pad — through the game's switch. In flight R starts and stops the
   * recording (DEV-370's recorder); stopping, or the pause plate's Back to
   * editor, comes back with `recorded(…)`.
   */
  record(level: Level): void
  // ── end DEV-491 ─────────────────────────────────────────────────────────
}

/**
 * DEV-491: what a recording flight hands back: the lap doc DEV-370's recorder
 * made of it (`recordedLap`), and the offset its positions are relative to.
 */
export interface DeskRecordedFlight {
  readonly doc: LapDoc
  readonly worldOffset: readonly [number, number, number]
}

/** One course the library keeps, as Remix lists it. */
export interface DeskLibraryEntry {
  readonly id: string
  readonly name: string
  readonly island: string
  readonly course: PlayerCourse
}

/** What the desk gives the game back. */
export interface Desk {
  /**
   * One editor frame: the tools and the camera, then the camera the game is to
   * render the world from. `seconds` is the frame's wall time.
   */
  frame(seconds: number): THREE.PerspectiveCamera
  /** Hide the panel and stop listening: a playtest or a world swap is under way. */
  suspend(): void
  /**
   * Back in the editor. `result` is the flown lap (DEV-468's `onReturn`), or
   * null after a world swap. The draft, the selection and the camera are as
   * they were left.
   */
  resume(result: PlaytestResult | null): void
  /**
   * DEV-491: back in the editor from a recording flight, with what was
   * recorded (null: nothing was). The desk fits it and makes it the line.
   */
  recorded(flight: DeskRecordedFlight | null): void
  /** Plain values for `__ff2.editor()` and the e2e spec. Never a live object. */
  probe(): unknown
  /** Test hooks the e2e spec drives, as a player's clicks would. */
  readonly debug: DeskDebug
}

/** What `editor-desk.spec.ts` may ask of the desk beyond its plain probe. */
export interface DeskDebug {
  /** Viewport pixels (CSS) of a level-frame point, or null behind the camera. */
  screenOf(x: number, y: number, z: number): { x: number; y: number } | null
  /**
   * The drawn rings as geometry: each instance's centre and the unit normal of
   * its thinnest extent (the opening's axis), from the INSTANCE MATRICES and
   * the mesh's own bounds — not from the level's quaternions.
   */
  ringGeometry(): { centre: [number, number, number]; normal: [number, number, number] }[]
  /** The drawn line's samples, level frame. */
  lineSamples(): [number, number, number][]
  /**
   * DEV-478: the RED geometry as drawn, read back off its buffers: one loop per
   * buried ring (its opening's rim) and one polyline per stretch of line under
   * the ground.
   */
  groundMarks(): {
    rings: [number, number, number][][]
    under: [number, number, number][][]
    /** DEV-503: the loops round rings a prop reaches into, and the stretches near props. */
    propRings: [number, number, number][][]
    propLine: [number, number, number][][]
  }
  /** DEV-478: the height of the render surface the desk judges against, at level-frame (x, z). */
  groundAt(x: number, z: number): number
  /**
   * DEV-472: where to put the mouse to hover the gizmo's `axis` arrow: the
   * viewport pixel (CSS) of the centre of that arrow's PICKER mesh on its
   * positive side — the geometry the gizmo's own ray tests — or null with no
   * gizmo up. Read off the meshes as last drawn, never off a belief about
   * their size. DEV-570: under the Scale tool (R), that axis's scale handle.
   */
  gizmoHandle(axis: 'X' | 'Y' | 'Z'): { x: number; y: number } | null
  /** The colour the gizmo draws `axis`'s arrow in now, as `0xRRGGBB`: its highlight state. */
  gizmoColour(axis: 'X' | 'Y' | 'Z'): number | null
  /**
   * DEV-475: where to put the mouse to grab the ROTATE gizmo's Y ring, a point
   * on its picker torus, or null when the gizmo is not aiming the pad.
   */
  gizmoRing(): { x: number; y: number } | null
  /** The layer masks of the gizmo's picker meshes and of the ray that tests them (the DEV-472 cause). */
  gizmoLayers(): { picker: number[]; ray: number }
  /** DEV-491: the last recorded flight as drawn, level frame, read back off its buffer. */
  recordedFlight(): [number, number, number][]
  /** DEV-503: the world's colliding props near a level-frame segment, as the warnings ask; null with none. */
  propsNear(
    a: [number, number, number],
    b: [number, number, number],
    reach: number,
  ): { id: number; kind: string; at: [number, number, number]; depth: number }[] | null
  /** DEV-503: the median cost, ms, of judging the draft with the world's props and without. */
  evaluateCost(runs: number): { withProps: number; withoutProps: number; props: boolean }
  /** DEV-504: where the desk draws placed prop `i`, its world matrix (column-major), or null. */
  propMatrix(i: number): number[] | null
  /** DEV-504: how far prop `i`'s base reaches, metres in plan, and the height it is seated at; null while loading. */
  propBase(i: number): { radius: number; seat: number | null } | null
  /** DEV-504: the picked prop's box as drawn, world space, or null. */
  propBox(): { min: number[]; max: number[] } | null
}
