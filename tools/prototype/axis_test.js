#!/usr/bin/env node
// axis_test.js -- empirically find the axis mapping between a Unity-space mesh (OBJ from unity_mesh_to_obj.js,
// raw coords) and the glTF exported by Blender from the same source FBX.
// Usage: node axis_test.js unity.obj blender.glb
const fs = require('fs');
const { readGlb, accessorArray } = require('./glb_inspect.js');
const obj = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l.startsWith('v ')).map(l => l.split(/\s+/).slice(1, 4).map(Number));
const g = readGlb(process.argv[3]);
const glPts = [];
for (const m of g.json.meshes) for (const p of m.primitives) { const a = accessorArray(g, p.attributes.POSITION); for (let i = 0; i < a.count; i++) glPts.push([a.data[3 * i], a.data[3 * i + 1], a.data[3 * i + 2]]); }
const centroid = pts => pts.reduce((c, p) => [c[0] + p[0] / pts.length, c[1] + p[1] / pts.length, c[2] + p[2] / pts.length], [0, 0, 0]);
const uc = centroid(obj), gc = centroid(glPts);
const extent = pts => { const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (const p of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); } return mx.map((x, k) => x - mn[k]); };
console.log(`unity verts=${obj.length} centroid=${uc.map(x => x.toFixed(4))} extent=${extent(obj).map(x => x.toFixed(4))}`);
console.log(`gltf  verts=${glPts.length} centroid=${gc.map(x => x.toFixed(4))} extent=${extent(glPts).map(x => x.toFixed(4))}`);
// scale ratio from extents (largest axis)
const ue = extent(obj), ge = extent(glPts);
const scale = Math.max(...ue) / Math.max(...ge);
console.log(`scale factor unity/gltf (max extent) = ${scale.toFixed(6)}`);
const mappings = { 'identity (x,y,z)': p => [p[0], p[1], p[2]], 'negate X (-x,y,z)': p => [-p[0], p[1], p[2]], 'negate Z (x,y,-z)': p => [p[0], p[1], -p[2]], 'negate X,Z (-x,y,-z)': p => [-p[0], p[1], -p[2]], 'negate Y (x,-y,z)': p => [p[0], -p[1], p[2]], 'swap YZ (x,z,y)': p => [p[0], p[2], p[1]], 'swap YZ negZ (x,z,-y)': p => [p[0], p[2], -p[1]], 'swap YZ negY (x,-z,y)': p => [p[0], -p[2], p[1]] };
// grid hash of unity points (centered) for nearest-neighbour lookup
const eps = 1e-3 * Math.max(...ue);
const key = p => p.map(x => Math.round(x / eps)).join(',');
const uset = new Map(); for (const p of obj) { const q = [p[0] - uc[0], p[1] - uc[1], p[2] - uc[2]]; uset.set(key(q), q); }
const near = q => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const k = [Math.round(q[0] / eps) + dx, Math.round(q[1] / eps) + dy, Math.round(q[2] / eps) + dz].join(','); if (uset.has(k)) return true; } return false; };
for (const [name, f] of Object.entries(mappings)) {
  let hit = 0;
  for (const p of glPts) { const m = f([(p[0] - gc[0]) * scale, (p[1] - gc[1]) * scale, (p[2] - gc[2]) * scale]); if (near(m)) hit++; }
  console.log(`  mapping gltf->unity ${name.padEnd(24)} : ${hit}/${glPts.length} glTF vertices match a Unity vertex (${(100 * hit / glPts.length).toFixed(1)}%)`);
}
