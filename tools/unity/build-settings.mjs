// tools/unity/build-settings.mjs: the scenes 2016 shipped, read from EditorBuildSettings.
//
// WP-23, TL-16 in docs/plan/code-reuse/tools.md. constants.mjs (`shippedSceneList`) and level.mjs
// (`shippedMissions`) each parsed ProjectSettings/EditorBuildSettings.asset and filtered it
// their own way. The list is read, never transcribed: `enabled: 1` under Scenes/missions/ is a
// shipped mission, and the multiplayer scenes (enabled too, one of them absent from the backup)
// are told apart by folder because they carry the `_unet` decoy prefab (CLAUDE.md).

import fs from 'node:fs'
import path from 'node:path'
import { readUnityText, unityYaml } from './yaml.mjs'

/** Where the build list lives, relative to the Unity project root. */
export const BUILD_SETTINGS_REL = 'ProjectSettings/EditorBuildSettings.asset'

/**
 * Every scene in the build list: `{ path, enabled, present }`, in file order.
 * `present` says whether the scene file exists in this backup: an enabled scene that is missing
 * (the multiplayer Simonet one) is the caller's to warn about, not to silently drop.
 */
export function buildScenes(root) {
  const { parseDocuments } = unityYaml()
  const docs = parseDocuments(readUnityText(path.join(root, BUILD_SETTINGS_REL)))
  const ebs = docs.find((d) => d.classId === 1045)
  if (!ebs) throw new Error(`${BUILD_SETTINGS_REL}: no EditorBuildSettings document`)
  return (ebs.data.m_Scenes ?? []).map((s) => {
    const rel = String(s.path)
    return {
      path: rel,
      enabled: Number(s.enabled) === 1,
      present: fs.existsSync(path.join(root, rel)),
    }
  })
}

/**
 * 'mission' (under Scenes/missions/), 'multiplayer' (a mission folder's Multiplayer/ scenes, which
 * are never a source of vehicle constants), or 'other'.
 */
export function classifyScene(p) {
  if (!p.startsWith('Assets/Faceted Flight/Scenes/missions/')) return 'other'
  if (p.includes('/Multiplayer/')) return 'multiplayer'
  return 'mission'
}

/** The shipped missions: enabled and classified 'mission'. `{ id, rel, abs }`, in file order. */
export function shippedMissions(root) {
  return buildScenes(root)
    .filter((s) => s.enabled && classifyScene(s.path) === 'mission')
    .map((s) => ({
      id: path.basename(s.path, '.unity'),
      rel: s.path,
      abs: path.join(root, s.path),
    }))
}
