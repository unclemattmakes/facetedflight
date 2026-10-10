// src/editor/desk/ground.ts: the desk's rendered ground. Moved to
// `game/terrain/render-ground.ts` so TV's camera can sample the drawn ground
// without loading the editor at boot (DEV-481 follow-up, editor-lazy-graph.test.ts).
// Re-exported here so the desk, the bench and their tests keep their import.
export * from '@/game/terrain/render-ground'
