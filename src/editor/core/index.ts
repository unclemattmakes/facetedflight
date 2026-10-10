// src/editor/core/index.ts — the editor core's public face. DEV-468, E2.
//
// Three-free and DOM-free; what the desktop editor (DEV-469) and the bench
// after it build on. Nothing here draws, listens or stores on its own: the
// ground, the storage, the clock and the dice are all handed in.

export {
  addPoint,
  addProp,
  aimPad,
  anchorToPad,
  clampPropScale,
  deletePoint,
  deleteProp,
  insertPoint,
  insertPointOnPath,
  isAnchoredPoint,
  movePad,
  movePoint,
  moveProp,
  rerollName,
  scaleProp,
  select,
  setFinish,
  setGap,
  setLight,
  setSky,
  setTimeLimit,
  setWater,
  toggleRingSkip,
  turnProp,
} from './commands'
export { createDebounce, type Debounce } from './debounce'
export {
  type AuthorLap,
  authorLapOf,
  defaultStart,
  donorGap,
  draftFromCourse,
  type EditorDraft,
  newDraft,
  safeCourseId,
} from './draft'
export {
  DRAFT_INDEX_KEY,
  type DraftStorage,
  type DraftSummary,
  deleteDraft,
  draftKey,
  draftToDrop, // DEV-889
  isBlankDraft, // DEV-889
  listDrafts,
  loadDraft,
  newDraftSlot,
  randomInt,
  readDraftCourse,
  saveDraft,
  shelfLabel, // DEV-889
  shelfOf, // DEV-889
} from './drafts'
// ── DEV-491: fly-to-author ──────────────────────────────────────────────
export {
  applyFit,
  FIT_POLICY,
  type Flight,
  type FlightFit,
  fitFlight,
  flightOfClip,
  recordingLevel,
  recordingLevelId,
} from './fit'
// ── end DEV-491 ─────────────────────────────────────────────────────────
export {
  canRedo,
  canUndo,
  createHistory,
  type DraftKind, // DEV-540
  depth,
  EDITOR_DRAFT_KIND, // DEV-540
  type History,
  isDirty,
  markSaved,
  type RecordOptions,
  record,
  redo,
  seal,
  undo,
  withAuthorLap,
} from './history'
export { createHistoryLoop, type HistoryLoop, type HistoryLoopOptions } from './history-loop'
export {
  groundShortfalls,
  liftClear,
  pointWeights,
  type RunInShortfall,
  runInShortfalls,
  type Shortfall,
} from './lift'
export {
  authorParTime,
  isAuthorLap,
  onReturn,
  type PlaytestHost,
  type PlaytestRequest,
  type PlaytestResult,
  playtestLevel,
  playtestRequest,
} from './playtest'
export {
  anchorHeightFor,
  EDITOR_POLICY,
  groundClearance,
  propReach, // DEV-503
  shipCollisionRadius, // DEV-503
  tightestTurnRadius,
} from './policy'
// DEV-486: the fix beside a too-sharp run-in.
export {
  type AnchorAim, // DEV-501 follow-up
  anchorAimNote, // DEV-501 follow-up
  anchorHeading, // DEV-501
  type RunInFix,
  runInFixOf,
  straightenRunIn,
  yawToward,
} from './run-in'
// DEV-889: the fix beside "the line ends too close to the finish".
export { extendRunout } from './runout'
// ── DEV-540: a shipped mission as a draft (2016's level plus an override) ──
export {
  addNote,
  addRingAfter,
  deleteLinePoint, // DEV-541
  distanceToLine,
  editLine, // DEV-541
  emptyOverride,
  entityPose,
  entityState,
  evaluateShipped,
  insertLinePointAfter, // DEV-541
  isShippedEditable,
  linePoints, // DEV-541
  liveTurnIndicators,
  loadShippedDraft,
  moveEntity,
  moveLinePoint, // DEV-541
  nearestOnLine, // DEV-541
  type OpenedShipped,
  openShipped,
  overrideSummary,
  overrideText,
  removeEntity,
  revertEntity,
  revertLine, // DEV-541
  ringEntityAt,
  SHIPPED_DRAFT_KIND,
  type ShippedDraft,
  type ShippedEntity,
  type ShippedEvaluation,
  type StoredShipped,
  sameEntity, // DEV-541
  saveShippedDraft,
  seedLine, // DEV-541
  selectEntity,
  setTimer,
  shippedDraftKey,
  shippedLevel,
  shippedPose, // DEV-541
  snapRingToLine, // DEV-541
  tryShippedLevel,
} from './shipped'
// ── end DEV-540 ─────────────────────────────────────────────────────────
export {
  anchoredRingIntrusion, // DEV-501 follow-up
  type DraftEvaluation,
  type EditorWarning,
  evaluateDraft,
  GROUND_WARNING_KINDS,
  type Ground,
  NO_GROUND,
  type PropContact, // DEV-503
  type Props, // DEV-503
  padFootprint,
  padSizeOf,
  type RingOpening,
  type RunIn,
  type RunInSample,
  type RunInTurn,
  ringIntrusion,
  ringOpeningRim,
  runInOf,
  runInSamples,
  runInShortOfClear,
  runInTurn,
  type SlotPad,
  seatPadAt,
  type WarningKind,
  type WarningSeverity,
} from './warnings'
