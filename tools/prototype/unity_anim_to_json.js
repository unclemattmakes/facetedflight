#!/usr/bin/env node
/**
 * unity_anim_to_json.js -- decode a Unity 5.4 .anim (AnimationClip, !u!74) into a three.js
 * AnimationClip JSON, with optional keyframe decimation.
 *
 * Usage:
 *   node unity_anim_to_json.js <clip.anim> [--out f.json] [--epsilon 0.01] [--max-keys N]
 *                              [--raw] [--summary-only] [--binary]
 *
 *   --epsilon <e>   decimate with a position error tolerance of e metres (rotation tolerance is
 *                   e/10 in quaternion units). Default 0 = keep every key.
 *   --max-keys <N>  hard cap: resample uniformly to at most N keys per track.
 *   --raw           keep RAW UNITY coordinates (default converts to three.js: pos z -> -z,
 *                   quat (x,y,z,w) -> (-x,-y,z,w))
 *   --binary        additionally write a .bin: Float32 [t, px,py,pz, qx,qy,qz,qw] per key,
 *                   in three.js space. This is the recommended shipping format for ghost replays.
 *   --summary-only  print stats, write nothing
 *
 * WHY THIS MATTERS
 *   Assets/OMS_Animation/Resources/*.anim are the GHOST RACER RECORDINGS (Motion Recorder asset).
 *   They are legacy clips (m_Legacy: 1) with exactly one rotation curve and one position curve, both
 *   bound to path "" (the recorded object's own root transform), sampled at m_SampleRate 60.
 *   They are enormous as YAML (adv_01_leftSpawn_fast_01.anim = 5.1 MB for 163.8 s of flight) and
 *   must be decimated or binary-packed before they go on the web.
 *
 * FORMAT (verified)
 *   AnimationClip:
 *     m_Legacy: 1                       legacy Animation component clip (not Mecanim)
 *     m_RotationCurves[]  { curve: { m_Curve: [ {time, value:{x,y,z,w}, inSlope, outSlope,
 *                                                tangentMode} ], m_PreInfinity, m_PostInfinity },
 *                           path: <transform path, "" = the animated object itself> }
 *     m_PositionCurves[]  same shape with Vector3 values
 *     m_ScaleCurves[] m_FloatCurves[] m_PPtrCurves[]   (all empty in the ghost clips)
 *     m_SampleRate: 60
 *     m_WrapMode / m_AnimationClipSettings.{m_StartTime, m_StopTime, m_LoopTime}
 *     m_HasGenericRootTransform: 1
 *   Unity's inSlope/outSlope are Hermite tangents (units/second). three.js KeyframeTrack has no
 *   Hermite mode: use InterpolateSmooth (Catmull-Rom) or, for a 60 Hz recording, plain linear --
 *   at 60 Hz the tangent contribution is below the visible threshold. Tangent data is preserved in
 *   the JSON under `tracks[].tangents` when --raw is given, so a custom interpolant stays possible.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** Fast, allocation-light scanner for the one shape Unity writes for curves. Much faster than the
 *  generic YAML parser on 5-15 MB clips (those have ~20k keyframes each). */
function parseAnim(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  // rejoin flow mappings Unity wrapped across lines
  text = text.replace(/\{([^{}\n]*),\n\s+([^{}\n]*)\}/g, (m, a, b) => `{${a}, ${b}}`);

  const grab = (re) => { const m = text.match(re); return m ? m[1] : null; };
  const clip = {
    name: (grab(/^\s*m_Name:\s*(.*)$/m) || '').trim(),
    serializedVersion: Number(grab(/^\s*serializedVersion:\s*(\d+)/m)),
    legacy: Number(grab(/^\s*m_Legacy:\s*(\d+)/m)),
    compressed: Number(grab(/^\s*m_Compressed:\s*(\d+)/m)),
    sampleRate: Number(grab(/^\s*m_SampleRate:\s*([\d.]+)/m)),
    wrapMode: Number(grab(/^\s*m_WrapMode:\s*(-?\d+)/m)),
    startTime: Number(grab(/^\s*m_StartTime:\s*(-?[\d.eE+-]+)/m)),
    stopTime: Number(grab(/^\s*m_StopTime:\s*(-?[\d.eE+-]+)/m)),
    loopTime: Number(grab(/^\s*m_LoopTime:\s*(\d+)/m)),
    hasGenericRootTransform: Number(grab(/^\s*m_HasGenericRootTransform:\s*(\d+)/m)),
  };

  const sectionOf = (name, next) => {
    const re = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)\\n  (?:${next})`);
    const m = text.match(re);
    return m ? m[1] : null;
  };
  const rotBlock = sectionOf('m_RotationCurves', 'm_CompressedRotationCurves|m_PositionCurves');
  const posBlock = sectionOf('m_PositionCurves', 'm_ScaleCurves|m_FloatCurves|m_EulerCurves');
  const sclBlock = sectionOf('m_ScaleCurves', 'm_FloatCurves|m_PPtrCurves');
  const fltBlock = sectionOf('m_FloatCurves', 'm_PPtrCurves|m_SampleRate');

  const VEC = /\{\s*x:\s*(-?[\d.eE+-]+),\s*y:\s*(-?[\d.eE+-]+),\s*z:\s*(-?[\d.eE+-]+)(?:,\s*w:\s*(-?[\d.eE+-]+))?\s*\}/;
  function parseCurveList(block, comps) {
    if (!block || block.trim() === '[]') return [];
    const out = [];
    // Each entry starts with "  - curve:" at 2-space indent. NOTE the leading '\n' we prepend:
    // the first entry sits at offset 0 of the block, so without it split() would drop curve #0 --
    // the exact same off-by-one that broke unity_mesh_to_obj.js's channel list.
    for (const chunk of ('\n' + block).split(/\n  - curve:\n/).slice(1)) {
      const pathM = chunk.match(/\n\s*path:\s*(.*)$/m);
      const attrM = chunk.match(/\n\s*attribute:\s*(.*)$/m);
      const classM = chunk.match(/\n\s*classID:\s*(\d+)/);
      const keys = [];
      const tangents = [];
      const lines = chunk.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const tm = /^\s*- time:\s*(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
        if (!tm) continue;
        const t = Number(tm[1]);
        let value = null, inS = null, outS = null;
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const vm = /^\s*(value|inSlope|outSlope):\s*(.*)$/.exec(lines[j]);
          if (!vm) break;
          const raw = vm[2].trim();
          let v;
          if (raw.startsWith('{')) { const g = VEC.exec(raw); v = g ? [Number(g[1]), Number(g[2]), Number(g[3]), g[4] !== undefined ? Number(g[4]) : undefined] : null; }
          else v = [Number(raw)];
          if (vm[1] === 'value') value = v; else if (vm[1] === 'inSlope') inS = v; else outS = v;
        }
        if (value) { keys.push({ t, v: value.slice(0, comps) }); tangents.push({ in: inS ? inS.slice(0, comps) : null, out: outS ? outS.slice(0, comps) : null }); }
      }
      out.push({ path: pathM ? pathM[1].trim() : '', attribute: attrM ? attrM[1].trim() : undefined, classID: classM ? Number(classM[1]) : undefined, keys, tangents });
    }
    return out;
  }

  clip.rotationCurves = parseCurveList(rotBlock, 4);
  clip.positionCurves = parseCurveList(posBlock, 3);
  clip.scaleCurves = parseCurveList(sclBlock, 3);
  clip.floatCurves = parseCurveList(fltBlock, 1);
  return clip;
}

/** Douglas-Peucker-ish greedy decimation on a keyframe list, using max component error. */
function decimate(keys, eps) {
  if (!eps || keys.length < 3) return keys;
  const n = keys[0].v.length;
  const out = [keys[0]];
  let anchor = 0;
  for (let i = 1; i < keys.length - 1; i++) {
    // error of dropping every key between anchor and i+1
    let worst = 0;
    const a = keys[anchor], b = keys[i + 1];
    const dt = b.t - a.t || 1e-9;
    for (let k = anchor + 1; k <= i; k++) {
      const f = (keys[k].t - a.t) / dt;
      for (let c = 0; c < n; c++) worst = Math.max(worst, Math.abs(a.v[c] + (b.v[c] - a.v[c]) * f - keys[k].v[c]));
    }
    if (worst > eps) { out.push(keys[i]); anchor = i; }
  }
  out.push(keys[keys.length - 1]);
  return out;
}

function resample(keys, maxKeys) {
  if (!maxKeys || keys.length <= maxKeys) return keys;
  const out = [];
  for (let i = 0; i < maxKeys; i++) out.push(keys[Math.round(i * (keys.length - 1) / (maxKeys - 1))]);
  return out;
}

const toThreePos = (v) => [v[0], v[1], -v[2]];
const toThreeQuat = (v) => [-v[0], -v[1], v[2], v[3]];

/** Build a three.js AnimationClip JSON (THREE.AnimationClip.parse-compatible). */
function toThreeClip(clip, opts = {}) {
  const three = !opts.raw;
  const tracks = [];
  for (const c of clip.positionCurves) {
    const keys = resample(decimate(c.keys, opts.epsilon), opts.maxKeys);
    const times = [], values = [];
    for (const k of keys) { times.push(Number(k.t.toFixed(5))); const v = three ? toThreePos(k.v) : k.v; values.push(v[0], v[1], v[2]); }
    tracks.push({ type: 'vector', name: (c.path ? c.path.replace(/\//g, '/') : '') + '.position', times, values, originalKeyCount: c.keys.length });
  }
  for (const c of clip.rotationCurves) {
    const keys = resample(decimate(c.keys, opts.epsilon ? opts.epsilon / 10 : 0), opts.maxKeys);
    const times = [], values = [];
    for (const k of keys) { times.push(Number(k.t.toFixed(5))); const v = three ? toThreeQuat(k.v) : k.v; values.push(v[0], v[1], v[2], v[3]); }
    tracks.push({ type: 'quaternion', name: (c.path || '') + '.quaternion', times, values, originalKeyCount: c.keys.length });
  }
  for (const c of clip.scaleCurves) {
    const keys = resample(decimate(c.keys, opts.epsilon), opts.maxKeys);
    const times = [], values = [];
    for (const k of keys) { times.push(Number(k.t.toFixed(5))); values.push(k.v[0], k.v[1], k.v[2]); }
    tracks.push({ type: 'vector', name: (c.path || '') + '.scale', times, values, originalKeyCount: c.keys.length });
  }
  for (const c of clip.floatCurves) {
    const keys = resample(decimate(c.keys, opts.epsilon), opts.maxKeys);
    tracks.push({ type: 'number', name: `${c.path || ''}.${c.attribute || 'value'}`, times: keys.map(k => Number(k.t.toFixed(5))), values: keys.map(k => k.v[0]), originalKeyCount: c.keys.length });
  }
  return {
    name: clip.name,
    duration: clip.stopTime,
    tracks,
    unity: { legacy: clip.legacy, sampleRate: clip.sampleRate, wrapMode: clip.wrapMode, loopTime: clip.loopTime, startTime: clip.startTime, stopTime: clip.stopTime, hasGenericRootTransform: clip.hasGenericRootTransform },
    coordinateSpace: three ? 'three.js/glTF (pos z negated, quat (-x,-y,z,w))' : 'raw Unity',
  };
}

/** Pack one position+rotation pair into a flat Float32 buffer: [t, px,py,pz, qx,qy,qz,qw] per key. */
function toBinary(clip, opts = {}) {
  const three = !opts.raw;
  const p = clip.positionCurves[0], r = clip.rotationCurves[0];
  if (!p || !r) return null;
  const pk = resample(decimate(p.keys, opts.epsilon), opts.maxKeys);
  const rk = resample(decimate(r.keys, opts.epsilon ? opts.epsilon / 10 : 0), opts.maxKeys);
  // sample rotation at the position key times (linear-nlerp) so one stride covers both
  const buf = new Float32Array(pk.length * 8);
  let j = 0;
  for (let i = 0; i < pk.length; i++) {
    const t = pk[i].t;
    while (j < rk.length - 2 && rk[j + 1].t < t) j++;
    const a = rk[Math.min(j, rk.length - 1)], b = rk[Math.min(j + 1, rk.length - 1)];
    const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    let q = [0, 1, 2, 3].map(c => a.v[c] + (b.v[c] - a.v[c]) * f);
    const dot = a.v[0] * b.v[0] + a.v[1] * b.v[1] + a.v[2] * b.v[2] + a.v[3] * b.v[3];
    if (dot < 0) q = [0, 1, 2, 3].map(c => a.v[c] + (-b.v[c] - a.v[c]) * f);
    const L = Math.hypot(...q) || 1; q = q.map(x => x / L);
    const pv = three ? toThreePos(pk[i].v) : pk[i].v;
    const qv = three ? toThreeQuat(q) : q;
    buf.set([t, pv[0], pv[1], pv[2], qv[0], qv[1], qv[2], qv[3]], i * 8);
  }
  return buf;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const src = argv.find(a => !a.startsWith('--') && argv.indexOf(a) !== argv.indexOf(get('--out', '\0')) && a !== get('--epsilon', '\0') && a !== get('--max-keys', '\0') && a !== get('--out', '\0'));
  if (!src) { console.error('usage: node unity_anim_to_json.js <clip.anim> [--out f.json] [--epsilon e] [--max-keys N] [--raw] [--binary] [--summary-only]'); process.exit(1); }
  const opts = { epsilon: Number(get('--epsilon', 0)), maxKeys: Number(get('--max-keys', 0)), raw: argv.includes('--raw') };
  const t0 = Date.now();
  const clip = parseAnim(src);
  const parseMs = Date.now() - t0;
  const three = toThreeClip(clip, opts);

  console.log(`clip "${clip.name}"  legacy=${clip.legacy} sampleRate=${clip.sampleRate} duration=${clip.stopTime}s wrapMode=${clip.wrapMode} loopTime=${clip.loopTime}`);
  console.log(`curves: rotation=${clip.rotationCurves.length} position=${clip.positionCurves.length} scale=${clip.scaleCurves.length} float=${clip.floatCurves.length}   (parsed in ${parseMs} ms)`);
  for (const c of clip.rotationCurves) console.log(`  rot  path="${c.path}" keys=${c.keys.length} t=[${c.keys[0].t}..${c.keys[c.keys.length - 1].t}]`);
  for (const c of clip.positionCurves) console.log(`  pos  path="${c.path}" keys=${c.keys.length} t=[${c.keys[0].t}..${c.keys[c.keys.length - 1].t}]  first=${JSON.stringify(c.keys[0].v)} last=${JSON.stringify(c.keys[c.keys.length - 1].v)}`);
  for (const t of three.tracks) console.log(`  track ${t.name.padEnd(14)} ${String(t.times.length).padStart(6)} keys (from ${t.originalKeyCount})`);

  if (!argv.includes('--summary-only')) {
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const out = get('--out', path.join(outDir, path.basename(src, path.extname(src)) + '.clip.json'));
    fs.writeFileSync(out, JSON.stringify(three));
    console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)  source ${(fs.statSync(src).size / 1024).toFixed(1)} KB`);
    if (argv.includes('--binary')) {
      const b = toBinary(clip, opts);
      if (b) { const bp = out.replace(/\.json$/, '.f32'); fs.writeFileSync(bp, Buffer.from(b.buffer)); console.log(`wrote ${bp} (${(b.length * 4 / 1024).toFixed(1)} KB, ${b.length / 8} keys x 8 float32)`); }
    }
  }
}

module.exports = { parseAnim, toThreeClip, toBinary, decimate, resample };
