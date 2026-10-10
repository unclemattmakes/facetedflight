#!/usr/bin/env node
/**
 * ff_route_report.js -- Faceted-Flight-specific report on top of unity_scene_to_json.js.
 *
 * Usage:
 *   node ff_route_report.js <scene.unity | scene.json> [--out out/<name>.route.json] [--print]
 *
 * Emits (and prints a digest of):
 *   raceWaypoints[]     ordered Trigger_RaceWaypoint world positions   (Ring Attack / race route)
 *   ringCheckpoints[]   ordered TriggerCheckpoint world positions + collider radius
 *   splines[]           every CurvySpline with its ordered CPnnn control points (world) and the
 *                       baked `Approximation` polyline stored on each CurvySplineSegment
 *   spawns              player spawn / respawn / multiplayer spawn transforms from the `Level` script
 *   ship                the Ship_HoverShip / HoverMotor / EnergySystem_Ship tuned fields
 *   removeTreeVolumes[] Trigger_RemoveTrees boxes
 *   magnets[]           Trigger_Magnet
 *
 * Ordering rule: Unity clones these as "%04dCheckpoint_Race(Clone)" / "%04dCheckpoint_Ring(Clone)"
 * so the numeric prefix of the *ancestor* object is the authoritative race order. Objects without a
 * numeric prefix fall back to their transform sibling index (m_RootOrder), then to path.
 */
'use strict';
const fs = require('fs');
const path = require('path');
// This repo's root, derived from __dirname rather than hard-coded. These two
// scripts defaulted to an absolute path INSIDE this repository, which is a
// worse version of the $FF2_LEGACY problem: it hard-codes where the CHECKOUT
// lives, so the default was wrong for every clone but one.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { extract, loadGuidIndex, findProjectRoot } = require('./unity_scene_to_json.js');

function loadScene(src, argv) {
  if (/\.json$/i.test(src)) return JSON.parse(fs.readFileSync(src, 'utf8'));
  const gi = argv.gi || path.join(REPO_ROOT, 'docs', 'research', '_guid_index.tsv');
  return extract(src, { project: argv.project || findProjectRoot(src), guidIndex: loadGuidIndex(gi), resolvePrefabs: true, expandPrefabs: false });
}

const ORDER_RE = /(?:^|\/)(\d{3,5})[^/]*$/;
function orderKey(o) {
  // deepest ancestor segment carrying a numeric prefix wins
  let best = null;
  for (const seg of o.path.split('/')) { const m = /^(\d{3,5})/.exec(seg); if (m) best = Number(m[1]); }
  return best === null ? Number.POSITIVE_INFINITY : best;
}
const P = (o) => o.world.position;
const P3 = (o) => o.worldThree.position;

function scriptOf(o, name) { return o.scripts.find(s => s.name === name); }
function has(o, name) { return o.scripts.some(s => s.name === name); }

function build(scene) {
  const objs = scene.objects;
  const byKey = new Map(objs.map(o => [o.key, o]));
  const colliderOf = (o) => o.components.find(c => [65, 135, 136, 64].includes(c.classId)) || null;

  // Container = the path prefix above the numbered "%04dFoo(Clone)" segment (or the direct parent).
  // Two different families of Trigger_RaceWaypoint coexist in a mission scene: the sparse lap
  // checkpoints under RaceObjects/race_checkpoints and the dense AI racing-line waypoints directly
  // under RaceObjects. Grouping keeps their orderings separate.
  const groupOf = (o) => {
    const segs = o.path.split('/');
    for (let i = segs.length - 1; i >= 0; i--) if (/^\d{3,5}/.test(segs[i])) return segs.slice(0, i).join('/');
    return segs.slice(0, -1).join('/');
  };
  const collect = (scriptName) => objs.filter(o => has(o, scriptName))
    .map(o => ({ o, order: orderKey(o), group: groupOf(o) }))
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || (a.order - b.order) || (a.o.path < b.o.path ? -1 : 1))
    .map(({ o, order, group }, i) => {
      const s = scriptOf(o, scriptName), c = colliderOf(o);
      return {
        index: i, order: Number.isFinite(order) ? order : null, group,
        name: o.name, path: o.path, key: o.key,
        active: o.activeInHierarchy, layer: o.layer, tag: o.tag,
        world: P(o), worldThree: P3(o), rotation: o.world.rotation, eulerDeg: o.world.eulerDeg, scale: o.world.scale,
        collider: c ? { type: c.type, isTrigger: c.isTrigger, radius: c.radius, size: c.size, center: c.center, height: c.height } : null,
        fields: s.fields,
      };
    });

  const raceWaypoints = collect('Trigger_RaceWaypoint');
  const ringCheckpoints = collect('TriggerCheckpoint');
  const removeTreeVolumes = collect('Trigger_RemoveTrees');
  const magnets = collect('Trigger_Magnet');

  // splines
  const splines = objs.filter(o => has(o, 'CurvySpline')).map(sp => {
    const cps = objs.filter(o => o.path.startsWith(sp.path + '/') && has(o, 'CurvySplineSegment'))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(o => {
        const s = scriptOf(o, 'CurvySplineSegment');
        return {
          name: o.name, key: o.key,
          world: P(o), worldThree: P3(o), rotation: o.world.rotation,
          local: o.local.position,
          approximationCount: Array.isArray(s.fields.Approximation) ? s.fields.Approximation.length : 0,
          approximation: Array.isArray(s.fields.Approximation) ? s.fields.Approximation : null,
          tcb: { StartTension: s.fields.StartTension, StartContinuity: s.fields.StartContinuity, StartBias: s.fields.StartBias,
            EndTension: s.fields.EndTension, EndContinuity: s.fields.EndContinuity, EndBias: s.fields.EndBias,
            OverrideGlobalTension: s.fields.OverrideGlobalTension },
        };
      });
    const s = scriptOf(sp, 'CurvySpline');
    return { name: sp.name, path: sp.path, key: sp.key, world: P(sp), worldThree: P3(sp),
      settings: { Interpolation: s.fields.Interpolation, Closed: s.fields.Closed, AutoEndTangents: s.fields.AutoEndTangents,
        Orientation: s.fields.Orientation, Granularity: s.fields.Granularity, Tension: s.fields.Tension,
        Continuity: s.fields.Continuity, Bias: s.fields.Bias, Swirl: s.fields.Swirl, SwirlTurns: s.fields.SwirlTurns },
      controlPointCount: cps.length, controlPoints: cps };
  });

  // Level script -> spawns
  const levelObj = objs.find(o => has(o, 'Level'));
  const lf = levelObj ? scriptOf(levelObj, 'Level').fields : {};
  const derefT = (ref) => {
    const k = ref && (ref.fileID !== undefined ? String(ref.fileID) : String(ref));
    const o = k && byKey.get(k);
    return o ? { name: o.name, path: o.path, key: o.key, world: o.world, worldThree: o.worldThree } : (k ? { unresolvedFileID: k } : null);
  };
  const spawns = {
    singlePlayerSpawn: derefT(lf.SinglePlayerSpawnPosition),
    singlePlayerRespawn: derefT(lf.SinglePlayerRespawnPosition),
    multiplayerSpawns: (lf.MultiplayerSpawnPositions || []).map(derefT),
    ringAttackParent: derefT(lf.ringAttackParent),
    freeFlightParent: derefT(lf.freeFlightParent),
    shipPrefab: lf.ShipPrefab || null,
    levelFields: lf,
  };

  // ship tuning (usually resolved from the ship prefab referenced by the scene)
  const shipObj = objs.find(o => has(o, 'Ship_HoverShip'));
  const ship = shipObj ? {
    path: shipObj.path, world: shipObj.world, worldThree: shipObj.worldThree,
    scripts: Object.fromEntries(shipObj.scripts.map(s => [s.name, s.fields])),
    rigidbody: shipObj.components.find(c => c.classId === 54) || null,
  } : null;

  return {
    meta: { ...scene.meta, report: 'ff_route_report.js' },
    counts: { raceWaypoints: raceWaypoints.length, ringCheckpoints: ringCheckpoints.length,
      splines: splines.length, splineControlPoints: splines.reduce((a, s) => a + s.controlPointCount, 0),
      removeTreeVolumes: removeTreeVolumes.length, magnets: magnets.length },
    spawns, ship, splines, raceWaypoints, ringCheckpoints, removeTreeVolumes, magnets,
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const src = argv.find(a => !a.startsWith('--'));
  if (!src) { console.error('usage: node ff_route_report.js <scene.unity|scene.json> [--out f.json] [--print]'); process.exit(1); }
  const scene = loadScene(src, { project: get('--project', null), gi: get('--guid-index', null) });
  const r = build(scene);
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const out = get('--out', path.join(outDir, path.basename(src).replace(/\.(unity|scene\.json|json)$/i, '') + '.route.json'));
  fs.writeFileSync(out, JSON.stringify(r, null, 1));

  console.log(`source: ${r.meta.source}`);
  console.log(`counts: ${JSON.stringify(r.counts)}`);
  console.log(`spawn:   ${r.spawns.singlePlayerSpawn ? r.spawns.singlePlayerSpawn.path : '-'}`);
  if (r.spawns.singlePlayerSpawn && r.spawns.singlePlayerSpawn.world)
    console.log(`         unity ${JSON.stringify(r.spawns.singlePlayerSpawn.world.position)} eulerY=${r.spawns.singlePlayerSpawn.world.eulerDeg.y}  three ${JSON.stringify(r.spawns.singlePlayerSpawn.worldThree.position)}`);
  if (r.spawns.singlePlayerRespawn && r.spawns.singlePlayerRespawn.world)
    console.log(`respawn: ${r.spawns.singlePlayerRespawn.path} ${JSON.stringify(r.spawns.singlePlayerRespawn.world.position)}`);
  if (argv.includes('--print')) {
    console.log('\nraceWaypoints (order  x y z  | startFinish maxLaps):');
    for (const w of r.raceWaypoints) console.log(`  ${w.group.split("/").pop().padEnd(18)} ${String(w.order).padStart(5)}  ${[w.world.x, w.world.y, w.world.z].map(v => v.toFixed(2).padStart(10)).join(' ')}  sf=${w.fields.startFinish} laps=${w.fields.maxLaps} ${w.collider ? w.collider.type + (w.collider.radius !== undefined ? ' r=' + w.collider.radius : '') : ''} ${w.active ? '' : '[inactive]'}`);
    console.log('\nringCheckpoints:');
    for (const w of r.ringCheckpoints) console.log(`  ${w.group.split("/").pop().padEnd(18)} ${String(w.order).padStart(5)}  ${[w.world.x, w.world.y, w.world.z].map(v => v.toFixed(2).padStart(10)).join(' ')}  boost=${w.fields.energyBoost} once=${w.fields.triggerOnce} score=${w.fields.addScore} ${w.collider ? w.collider.type + ' r=' + w.collider.radius : ''}`);
    for (const s of r.splines) {
      console.log(`\nspline "${s.name}" (${s.path}) interp=${s.settings.Interpolation} closed=${s.settings.Closed} granularity=${s.settings.Granularity} cps=${s.controlPointCount}`);
      for (const c of s.controlPoints) console.log(`   ${c.name.padEnd(8)} ${[c.world.x, c.world.y, c.world.z].map(v => v.toFixed(2).padStart(10)).join(' ')}  approx=${c.approximationCount}`);
    }
  }
  console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
}

module.exports = { build, loadScene };
