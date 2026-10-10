// src/boot/app/autopilot-state.ts: who is flying, as ONE record. APP-SPLIT
// phase 3, slice 5 (`docs/plan/APP-SPLIT.md` §5, the many-writer bindings).
//
// `autopilot` had about fourteen writers (the key, the hold, the room's frame,
// the lesson, a Quick Race, the editor) and its hold one. The record is the
// one place they are: every write is `pilot.autopilot = …`, which one search
// finds. The field docs are the ones the `let`s carried, moved verbatim.
//
// Types only: safe to import from a node test.

import type { HoldToggleState } from '@/input/hold-toggle'
// DEV-143. The boost tank: `sim/energy.ts` owns the arithmetic and takes every
// number but the preset's `rechargeScale` off the generated sheet.
// DEV-144. The energy race's tank: gates pay in, flying takes out, empty is the
// end of the run. Never live at the same time as the boost tank above.
// `terrainHeightAt` is gone from this file with DEV-042's lift: the title rig's
// height is now 2016's own, composed rather than rescued, and the mission
// terrain's field is passed straight to the sim. Nothing here samples ground.
// DEV-388: the generated-content manifest, digested for a room's `join` (§6.7).
import { _headQuat } from './head-scratch'

export interface AutopilotState {
  autopilot: boolean
  /** DEV-181: the XR hold's own state. `src/input/hold-toggle.ts`. */
  autopilotHold: HoldToggleState
}
