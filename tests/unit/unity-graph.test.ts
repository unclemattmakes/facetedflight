// tests/unit/unity-graph.test.ts: the shared Unity prefab-graph layer (tools/unity/*, WP-23 / WP-24).
//
// Every extractor used to carry its own copy of these: the component list in both YAML dialects,
// the document header scan, the m_Modifications read, the raw material readers and the liveness
// walk. The generated trees are the proof that the move changed no byte (`extract:check`); these
// tests pin the RULES the copies disagreed about, on hand-written YAML, so they need no Unity
// project and run on CI.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildScenes, classifyScene, shippedMissions } from '../../tools/unity/build-settings.mjs'
import {
  activeOf,
  chainIsLive,
  chainUp,
  componentIdsOf,
  componentOwners,
  componentRef,
  componentsOfGo,
  flatIsLive,
  graphOf,
  transformOfGo,
} from '../../tools/unity/graph.mjs'
import { materialDialect, rawColour, rawFloat, rawTexEnv } from '../../tools/unity/material.mjs'
import {
  instancesOf,
  modificationsOf,
  modPath,
  modTarget,
  modTargetOrNull,
  modValue,
  prefabInstances,
} from '../../tools/unity/modifications.mjs'
import { keyLines, readUnityText, scanDocuments, unityYaml } from '../../tools/unity/yaml.mjs'

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n'

const go = (
  id: number,
  name: string,
  comps: string[],
  active: number | null,
  dialect: 'new' | 'old',
) =>
  [
    `--- !u!1 &${id}`,
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_Component:',
    ...comps.map((c) => {
      const [cls, cid] = c.split(':')
      return dialect === 'new' ? `  - component: {fileID: ${cid}}` : `  - ${cls}: {fileID: ${cid}}`
    }),
    `  m_Name: ${name}`,
    ...(active === null ? [] : [`  m_IsActive: ${active}`]),
  ].join('\n')

const tf = (id: number, goId: number, father: number) =>
  [
    `--- !u!4 &${id}`,
    'Transform:',
    `  m_GameObject: {fileID: ${goId}}`,
    `  m_Father: {fileID: ${father}}`,
    '  m_Children: []',
  ].join('\n')

const parse = (text: string) => unityYaml().parseDocuments(`${HEAD}${text}\n`)

/** root(1) <- mid(2) <- leaf(3), each one GameObject + Transform. `active` per GameObject. */
const chainText = (active: [number | null, number | null, number | null], dialect: 'new' | 'old') =>
  [
    go(1, 'root', ['4:11'], active[0], dialect),
    go(2, 'mid', ['4:12'], active[1], dialect),
    go(3, 'leaf', ['4:13'], active[2], dialect),
    tf(11, 1, 0),
    tf(12, 2, 11),
    tf(13, 3, 12),
  ].join('\n')

const byIdOf = (docs: ReturnType<typeof parse>) => new Map(docs.map((d) => [String(d.fileId), d]))

describe('the component list, in both 2016 dialects', () => {
  for (const dialect of ['new', 'old'] as const) {
    it(`reads ${dialect}-dialect entries (${dialect === 'new' ? '- component: {...}' : '- 4: {...}'})`, () => {
      const docs = parse(chainText([1, 1, 1], dialect))
      const byId = byIdOf(docs)
      const leaf = byId.get('3')
      expect(componentIdsOf(leaf)).toEqual(['13'])
      expect(componentsOfGo(byId, leaf).map((d) => d.fileId)).toEqual(['13'])
      expect(transformOfGo(byId, leaf)?.fileId).toBe('13')
    })
  }

  it('componentRef answers for both spellings and for junk', () => {
    expect(componentRef({ component: { fileID: 7 } })).toEqual({ fileID: 7 })
    expect(componentRef({ 4: { fileID: 7 } })).toEqual({ fileID: 7 })
    expect(componentRef(null)).toBeNull()
    expect(componentRef({})).toBeNull()
  })

  it('graphOf is the shape convert-wings used to build by hand', () => {
    const g = graphOf(parse(chainText([1, 1, 1], 'old')))
    const leafTf = g.byId.get('13')
    if (!leafTf) throw new Error('fixture')
    expect(g.nameOf(g.goOf(leafTf) as never)).toBe('leaf')
    expect(g.parentOf(leafTf)?.fileId).toBe('12')
    expect(g.parentOf(g.byId.get('11') as never)).toBeNull()
    expect(componentOwners(g.docs).get('13')).toBe('3')
  })
})

describe('scanDocuments and keyLines', () => {
  const text = `${HEAD}--- !u!1 &10\nGameObject:\n  m_Name: A\n  m_IsActive: 1\n--- !u!1 &20 stripped\nGameObject:\n  m_Name: B\n  m_Name: dup\n`
  it('gives 0-based line bounds, a number class id and a stripped flag; directives belong to no document', () => {
    const lines = text.split(/\r?\n/)
    const bounds = scanDocuments(lines)
    expect(bounds.map((b) => [b.classId, b.fileId, b.stripped, b.start, b.end])).toEqual([
      [1, '10', false, 2, 6],
      [1, '20', true, 6, lines.length],
    ])
    expect(scanDocuments(text)).toEqual(bounds)
  })

  it('records the 1-based line of each top-level key, first occurrence winning', () => {
    const lines = text.split(/\r?\n/)
    const second = scanDocuments(lines)[1]
    if (!second) throw new Error('fixture')
    const keys = keyLines(lines, second)
    expect(keys.has('GameObject')).toBe(false) // the type key is at column 0, not a body key
    expect(keys.get('m_Name')).toBe(9)
  })

  it('tolerates CRLF headers', () => {
    const bounds = scanDocuments(`--- !u!4 &5\r\nTransform:\r\n  m_Father: {fileID: 0}\r\n`)
    expect(bounds).toHaveLength(1)
    expect(bounds[0]?.fileId).toBe('5')
  })
})

describe('readUnityText: one BOM and line-ending policy', () => {
  it('always strips a BOM, and keeps CRLF unless asked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-unity-text-'))
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, '﻿one\r\ntwo\r\n')
    try {
      expect(readUnityText(file)).toBe('one\r\ntwo\r\n')
      expect(readUnityText(file, { lf: true })).toBe('one\ntwo\n')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the liveness walk', () => {
  const nodes = (
    active: [number | null, number | null, number | null],
    dialect: 'new' | 'old' = 'new',
  ) => {
    const byId = byIdOf(parse(chainText(active, dialect)))
    return { byId, up: chainUp(byId, byId.get('13')) }
  }

  it('is alive only when the GameObject AND every ancestor is active, in either dialect', () => {
    for (const dialect of ['new', 'old'] as const) {
      expect(chainIsLive(nodes([1, 1, 1], dialect).up.nodes)).toBe(true)
      expect(chainIsLive(nodes([0, 1, 1], dialect).up.nodes)).toBe(false) // the root switched it off
      expect(chainIsLive(nodes([1, 0, 1], dialect).up.nodes)).toBe(false)
      expect(chainIsLive(nodes([1, 1, 0], dialect).up.nodes)).toBe(false)
    }
  })

  it('walks nearest first, and says whether it reached a real root', () => {
    const { up } = nodes([1, 1, 1])
    expect(up.nodes.map((n) => n.transform.fileId)).toEqual(['13', '12', '11'])
    expect(up.rootReached).toBe(true)
    const ancestors = chainUp(nodes([1, 1, 1]).byId, nodes([1, 1, 1]).byId.get('13'), {
      includeSelf: false,
    })
    expect(ancestors.nodes.map((n) => n.transform.fileId)).toEqual(['12', '11'])
    expect(ancestors.rootReached).toBe(true)
  })

  it('has no depth limit unless a caller asks for one (the old copies stopped at 16 and said alive)', () => {
    const depth = 40
    const docs = [go(1, 'n1', ['4:101'], 1, 'new'), tf(101, 1, 0)]
    for (let i = 2; i <= depth; i++) {
      docs.push(go(i, `n${i}`, [`4:${100 + i}`], i === 20 ? 0 : 1, 'new'), tf(100 + i, i, 99 + i))
    }
    const byId = byIdOf(parse(docs.join('\n')))
    const up = chainUp(byId, byId.get(String(100 + depth)))
    expect(up.nodes).toHaveLength(depth)
    expect(chainIsLive(up.nodes)).toBe(false) // node 20 is 21 hops up: past the old cap of 16
    expect(chainUp(byId, byId.get(String(100 + depth)), { cap: 16 }).nodes).toHaveLength(16)
  })

  it('treats a stripped placeholder (no m_IsActive) as UNKNOWN, and lets the caller choose', () => {
    // mid is a stripped placeholder: it has a Transform but its GameObject carries no m_IsActive.
    const { up } = nodes([1, null, 1])
    expect(up.nodes.map((n) => n.active)).toEqual([1, -1, 1])
    expect(chainIsLive(up.nodes)).toBe(false) // conservative default
    expect(chainIsLive(up.nodes, { unknown: 'dead' })).toBe(false)
    expect(chainIsLive(up.nodes, { unknown: 'alive' })).toBe(true)
    expect(activeOf(undefined)).toBe(-1)
    expect(activeOf({ data: { m_IsActive: '0' } } as never)).toBe(0)
    // An explicit 0 still kills it whatever the policy.
    expect(chainIsLive(nodes([1, 0, 1]).up.nodes, { unknown: 'alive' })).toBe(false)
  })

  it('reports a father that is not in the file as rootReached = false', () => {
    const byId = byIdOf(parse([go(3, 'leaf', ['4:13'], 1, 'new'), tf(13, 3, 999)].join('\n')))
    const up = chainUp(byId, byId.get('13'))
    expect(up.nodes).toHaveLength(1)
    expect(up.rootReached).toBe(false)
  })

  it('throws on a cycle instead of answering', () => {
    const byId = byIdOf(
      parse(
        [
          go(1, 'a', ['4:11'], 1, 'new'),
          go(2, 'b', ['4:12'], 1, 'new'),
          tf(11, 1, 12),
          tf(12, 2, 11),
        ].join('\n'),
      ),
    )
    expect(() => chainUp(byId, byId.get('11'))).toThrow(/cycle/)
  })

  it('works through a lazy lookup, which is how the terrain and sky scanners call it', () => {
    const byId = byIdOf(parse(chainText([1, 1, 1], 'new')))
    let gets = 0
    const lazy = {
      get: (id: string) => {
        gets++
        return byId.get(id)
      },
    }
    expect(chainUp(lazy, byId.get('13')).nodes).toHaveLength(3)
    expect(gets).toBeGreaterThan(0)
  })

  describe('flatIsLive (the flattened scene: level.mjs and the hangar converter)', () => {
    type Obj = { key: string; active: boolean | undefined; parent?: string }
    const objs: Record<string, Obj> = {
      page: { key: 'page', active: false, parent: 'room' },
      room: { key: 'room', active: true, parent: 'world' },
      world: { key: 'world', active: false },
      leaf: { key: 'leaf', active: true, parent: 'page' },
    }
    const parentOf = (o: Obj) => (o.parent ? objs[o.parent] : undefined)

    it('is dead when any ancestor is inactive, and a missing parent is a root', () => {
      expect(flatIsLive(objs.room as Obj, parentOf)).toBe(false) // world is off
      expect(flatIsLive({ key: 'x', active: undefined, parent: 'nowhere' }, parentOf)).toBe(true)
    })

    it('skips a forced node own flag but still checks its ancestors', () => {
      const forced = (o: Obj) => o.key === 'page' || o.key === 'world'
      expect(flatIsLive(objs.leaf as Obj, parentOf, { forced })).toBe(true)
      expect(flatIsLive(objs.leaf as Obj, parentOf, { forced: (o) => o.key === 'page' })).toBe(
        false,
      )
    })

    it('throws on a cycle', () => {
      const a: Obj = { key: 'a', active: true, parent: 'b' }
      const b: Obj = { key: 'b', active: true, parent: 'a' }
      const table: Record<string, Obj> = { a, b }
      expect(() => flatIsLive(a, (o) => (o.parent ? table[o.parent] : undefined))).toThrow(/cycle/)
    })
  })
})

describe('m_Modifications', () => {
  const sceneText = [
    '--- !u!1001 &900',
    'Prefab:',
    '  m_ParentPrefab: {fileID: 100100000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}',
    '  m_Modification:',
    '    m_TransformParent: {fileID: 0}',
    '    m_Modifications:',
    '    - target: {fileID: 4, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}',
    '      propertyPath: m_LocalPosition.x',
    '      value: 3.5',
    '      objectReference: {fileID: 0}',
    '    - target: {fileID: 0}',
    '      propertyPath: m_IsActive',
    '      value: 0',
    '      objectReference: {fileID: 0}',
    '--- !u!1001 &901',
    'Prefab:',
    '  m_ParentPrefab: {fileID: 100100000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}',
    '  m_Modification:',
    '    m_TransformParent: {fileID: 0}',
    '    m_Modifications: []',
  ].join('\n')

  it('reads the list, the target, the path and the value one way', () => {
    const docs = parse(sceneText)
    const [first] = prefabInstances(docs)
    const mods = modificationsOf(first)
    expect(mods).toHaveLength(2)
    expect(modTarget(mods[0])).toBe('4')
    expect(modTarget(mods[1])).toBe('0')
    expect(modTargetOrNull({ propertyPath: 'x' })).toBeNull()
    expect(modTargetOrNull(mods[0])).toBe('4')
    expect(modPath(mods[0])).toBe('m_LocalPosition.x')
    expect(modPath(undefined)).toBe('')
    expect(modificationsOf(undefined)).toEqual([])
  })

  it('finds the instances of ONE prefab, and a missing guid matches nothing, not everything', () => {
    const docs = parse(sceneText)
    expect(prefabInstances(docs)).toHaveLength(2)
    expect(instancesOf(docs, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').map((d) => d.fileId)).toEqual([
      '901',
    ])
    expect(instancesOf(docs, null)).toEqual([])
    expect(instancesOf(docs, undefined)).toEqual([])
  })

  it('keeps null as null and flattens an object to JSON (the two old encodings disagreed on null)', () => {
    expect(modValue(null)).toBeNull()
    expect(modValue({ a: 1 })).toBe('{"a":1}')
    expect(modValue(2)).toBe(2)
    expect(modValue('x')).toBe('x')
  })
})

describe('material readers answer for both dialects (DEV-043)', () => {
  const newDialect = [
    'Material:',
    '  m_SavedProperties:',
    '    m_TexEnvs:',
    '    - first:',
    '        name: _MainTex',
    '      second:',
    '        m_Texture: {fileID: 2800000, guid: abc123, type: 3}',
    '        m_Scale: {x: 2, y: 3}',
    '        m_Offset: {x: 0.25, y: 0}',
    '    m_Floats:',
    '    - first:',
    '        name: _Shininess',
    '      second: 0.078125',
    '    - first:',
    '        name: _SpecInt',
    '      second: 1e-05',
    '    m_Colors:',
    '    - first:',
    '        name: _Color',
    '      second: {r: 0.5, g: 0.25, b: 0.125, a: 1}',
    '    - first:',
    '        name: _ColorTint',
    '      second: {r: 9, g: 9, b: 9, a: 9}',
  ].join('\n')

  // Old dialect: no list marker, the same `data:` key written once per property.
  const oldDialect = [
    'Material:',
    '  m_SavedProperties:',
    '    m_Floats:',
    '      data:',
    '        first:',
    '          name: _Shininess',
    '        second: 0.5',
    '      data:',
    '        first:',
    '          name: _SpecInt',
    '        second: 0.25',
    '    m_Colors:',
    '      data:',
    '        first:',
    '          name: _Color',
    '        second: {r: 1, g: 0.5, b: 0.25, a: 1}',
    '      data:',
    '        first:',
    '          name: _GlowColor',
    '        second: {r: 0, g: 1, b: 0, a: 0.5}',
  ].join('\n')

  it('reads a new-dialect colour whole-name, with its line', () => {
    const c = rawColour(newDialect, '_Color')
    expect(c?.value).toEqual([0.5, 0.25, 0.125, 1])
    expect(c?.dialect).toBe('new')
    expect(c?.line).toBe(20)
    expect(rawColour(newDialect, '_Missing')).toBeNull()
  })

  it('reads every property of an OLD-dialect material, which the YAML parser cannot', () => {
    expect(materialDialect(oldDialect)).toBe('old')
    expect(rawColour(oldDialect, '_Color')?.value).toEqual([1, 0.5, 0.25, 1])
    expect(rawColour(oldDialect, '_GlowColor')?.value).toEqual([0, 1, 0, 0.5])
    expect(rawFloat(oldDialect, '_Shininess')?.value).toBe(0.5)
    expect(rawFloat(oldDialect, '_SpecInt')?.value).toBe(0.25)
    // The DEV-043 receipt: the parser keeps only the LAST repeated `data` key, so it cannot see
    // _Color on this material. The raw reader does.
    const parsed = parse(`--- !u!21 &1\n${oldDialect}`)[0]
    expect(JSON.stringify(parsed?.data)).not.toContain('"name":"_Color"')
  })

  it('reads floats with exponents and a texture slot', () => {
    expect(rawFloat(newDialect, '_SpecInt')?.value).toBe(1e-5)
    expect(rawFloat(newDialect, '_Shininess')?.value).toBe(0.078125)
    expect(rawTexEnv(newDialect, '_MainTex')).toEqual({
      guid: 'abc123',
      scale: [2, 3],
      offset: [0.25, 0],
    })
  })

  it('tolerates CRLF, so a raw (non-LF) read answers too', () => {
    expect(rawColour(newDialect.replace(/\n/g, '\r\n'), '_Color')?.value).toEqual([
      0.5, 0.25, 0.125, 1,
    ])
    expect(rawFloat(newDialect.replace(/\n/g, '\r\n'), '_Shininess')?.value).toBe(0.078125)
  })
})

describe('the build list', () => {
  it('classifies scenes by folder', () => {
    expect(
      classifyScene('Assets/Faceted Flight/Scenes/missions/HoverJet/int_01_hoverJet.unity'),
    ).toBe('mission')
    expect(
      classifyScene('Assets/Faceted Flight/Scenes/missions/HoverJet/Multiplayer/m.unity'),
    ).toBe('multiplayer')
    expect(classifyScene('Assets/Faceted Flight/Scenes/main_menu.unity')).toBe('other')
  })

  it('reads enabled and present, and keeps the shipped missions only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-build-settings-'))
    try {
      const missions = 'Assets/Faceted Flight/Scenes/missions'
      fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true })
      fs.mkdirSync(path.join(root, missions, 'Multiplayer'), { recursive: true })
      fs.writeFileSync(path.join(root, missions, 'a.unity'), '')
      fs.writeFileSync(
        path.join(root, 'ProjectSettings/EditorBuildSettings.asset'),
        `${HEAD}--- !u!1045 &1\nEditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: ${missions}/a.unity\n  - enabled: 0\n    path: ${missions}/off.unity\n  - enabled: 1\n    path: ${missions}/Multiplayer/gone.unity\n  - enabled: 1\n    path: Assets/Faceted Flight/Scenes/menu.unity\n`,
      )
      const scenes = buildScenes(root)
      expect(scenes.map((s) => [path.basename(s.path), s.enabled, s.present])).toEqual([
        ['a.unity', true, true],
        ['off.unity', false, false],
        ['gone.unity', true, false],
        ['menu.unity', true, false],
      ])
      expect(shippedMissions(root).map((m) => m.id)).toEqual(['a'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
