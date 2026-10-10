// src/boot/app/pause-state.ts: the pause and its aim, as ONE record.
// APP-SPLIT phase 3, slice 5 (`docs/plan/APP-SPLIT.md` §5, the many-writer
// bindings).
//
// `paused` had about ten writers and `pauseAim` about thirteen, spread over the
// frame, the menus, the editor's way back and the plate's pages. The record is
// the one place they are: every write is `pause.paused = …` or
// `pause.pauseAim = …`, which one search finds, and a module that writes one
// is handed the record rather than a setter over a closure `let`. The field
// docs are the ones the `let`s carried, moved verbatim.
//
// Types only: safe to import from a node test.

// DEV-143. The boost tank: `sim/energy.ts` owns the arithmetic and takes every
// number but the preset's `rechargeScale` off the generated sheet.
// DEV-144. The energy race's tank: gates pay in, flying takes out, empty is the
// end of the run. Never live at the same time as the boost tank above.
// `terrainHeightAt` is gone from this file with DEV-042's lift: the title rig's
// height is now 2016's own, composed rather than rescued, and the mission
// terrain's field is passed straight to the sim. Nothing here samples ground.
// DEV-388: the generated-content manifest, digested for a room's `join` (§6.7).
import { _headQuat } from './head-scratch'

export interface PauseState {
  paused: boolean
  /**
   * The selected row. STICKY — it is not recomputed from nothing each frame.
   *
   * Two things move it, because neither alone works everywhere. The GAZE is
   * 2016's model and the right one in a headset, where the head moves freely
   * whether or not the sim is running. On a flat screen the "gaze" is the
   * ship's forward, and a frozen sim means a frozen ship: the ray cannot be
   * aimed at all. So the PITCH axis moves it too — arrow keys, a pad stick, an
   * XR thumbstick, all through the same merged action, which costs no new
   * binding and works on all three routes.
   */
  pauseAim: number
}
