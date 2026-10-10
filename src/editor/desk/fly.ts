// src/editor/desk/fly.ts: the desk camera's FLY mode. The maths moved to
// `render/fly-look.ts` so TV's Free camera can use it without loading the
// editor at boot (DEV-481 follow-up, editor-lazy-graph.test.ts). Re-exported
// here so the desk and its tests keep their import.
export * from '@/render/fly-look'
