#!/usr/bin/env node
/**
 * handedness_test.js -- settle the Unity -> three.js/glTF coordinate rule from the DATA, using only
 * one asset (no second export to compare against).
 *
 * Usage: node handedness_test.js <mesh.asset> [...]
 *
 * Method: for every triangle, transform positions and normals by a candidate axis map, optionally
 * swap the 2nd/3rd index, then compute dot( (B-A) x (C-A), avg vertex normal ) with the STANDARD
 * RIGHT-HANDED cross product. glTF/three.js require front faces to be counter-clockwise, i.e. that
 * dot must be POSITIVE. A mapping that yields -1 renders the model inside-out.
 *
 * Bonus: meanDot == 1.0000 exactly means face normals == vertex normals, i.e. the mesh is FLAT
 * SHADED / fully split (the "faceted" look). A value below 1 means smoothed vertex normals.
 */
'use strict';
const { loadMeshes } = require('./unity_mesh_to_obj.js');

const MAPS = {
  'raw Unity            ': [p => [p[0], p[1], p[2]], false],
  'negZ + swap winding  ': [p => [p[0], p[1], -p[2]], true],
  'negZ   no swap       ': [p => [p[0], p[1], -p[2]], false],
  'negX + swap winding  ': [p => [-p[0], p[1], p[2]], true],
  'raw  + swap winding  ': [p => [p[0], p[1], p[2]], true],
};

function analyse(file) {
  for (const { mesh, dec } of loadMeshes(file)) {
    const pos = dec.attrs.position.values, nrm = dec.attrs.normal && dec.attrs.normal.values, idx = dec.indices;
    if (!nrm) { console.log(`--- ${mesh.name}: no normal channel, skipped`); continue; }
    console.log(`--- ${mesh.name} (tris ${idx.length / 3})`);
    for (const [label, [T, swap]] of Object.entries(MAPS)) {
      let sum = 0, front = 0;
      for (let i = 0; i < idx.length; i += 3) {
        let a = idx[i], b = idx[i + 1], c = idx[i + 2];
        if (swap) { const t = b; b = c; c = t; }
        const A = T(pos[a]), B = T(pos[b]), C = T(pos[c]);
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const na = T(nrm[a]), nb = T(nrm[b]), nc = T(nrm[c]);
        const n = [0, 1, 2].map(k => (na[k] + nb[k] + nc[k]) / 3);
        const L = (Math.hypot(...cr) * Math.hypot(...n)) || 1e-12;
        const d = (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2]) / L;
        sum += d; if (d > 0) front++;
      }
      const N = idx.length / 3;
      console.log(`   ${label} meanDot(cross,normal)=${(sum / N).toFixed(4)}  frontFacing(RH/CCW)=${front}/${N}`);
    }
  }
}

if (require.main === module) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node handedness_test.js <mesh.asset> [...]'); process.exit(1); }
  for (const f of files) { try { analyse(f); } catch (e) { console.log(`ERR ${f}: ${e.message}`); } }
}
module.exports = { analyse };
