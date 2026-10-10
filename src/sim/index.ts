// src/sim/index.ts — public surface of the sim layer.
//
// HARD RULE: nothing under `src/sim/` may import `three`, reach into
// `src/render/`, or call `Math.random()` / `Date.now()` / `performance.now()`.
// Enforced by `tests/unit/sim-purity-guard.test.ts`. See CLAUDE.md hard rule 3
// and PORT_PLAN §2.4 / DECISIONS D7 for why: headless golden-trajectory tests,
// renderer-free ghost replay, terrain generation in a plain Worker.

export {
  type ConstantEntry,
  FIXED_DT,
  GRAVITY,
  PROVENANCE,
  TICK_RATE,
  type Trust,
} from './constants'
export {
  createHoverJet,
  type HoverJet,
  type HoverJetInput,
  type HoverJetTuning,
  noInput,
  stepHoverJet,
} from './hoverjet'
export { createClock, type FixedStepClock, stepFixed } from './integrator'
export * as quat from './math/quat'
export * as scalar from './math/scalar'
export * as vec3 from './math/vec3'
export {
  clearAccumulators,
  createRigidBody,
  integrate,
  type RigidBody,
  unityDragFactor,
} from './rigidbody'
