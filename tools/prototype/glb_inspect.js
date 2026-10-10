#!/usr/bin/env node
// glb_inspect.js -- print nodes/meshes/accessors of a .glb (no deps). Usage: node glb_inspect.js file.glb [--positions]
const fs = require('fs');
function readGlb(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt32LE(0) !== 0x46546C67) throw new Error('not glb');
  const jsonLen = b.readUInt32LE(12); const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'));
  let off = 20 + jsonLen; let bin = null;
  if (off < b.length) { const len = b.readUInt32LE(off); bin = b.slice(off + 8, off + 8 + len); }
  return { json, bin };
}
function accessorArray(g, idx) {
  const a = g.json.accessors[idx], bv = g.json.bufferViews[a.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array, 5120: Int8Array, 5122: Int16Array }[a.componentType];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || comps * ctor.BYTES_PER_ELEMENT;
  const out = new Float64Array(a.count * comps);
  for (let i = 0; i < a.count; i++) { const v = new ctor(g.bin.buffer, g.bin.byteOffset + start + i * stride, comps); for (let k = 0; k < comps; k++) out[i * comps + k] = a.normalized ? v[k] / ((1 << (8 * ctor.BYTES_PER_ELEMENT)) - 1) : v[k]; }
  return { data: out, comps, count: a.count, normalized: !!a.normalized, componentType: a.componentType, min: a.min, max: a.max };
}
module.exports = { readGlb, accessorArray };
if (require.main === module) {
  const g = readGlb(process.argv[2]);
  const j = g.json;
  console.log(`generator: ${j.asset.generator}`);
  console.log(`nodes: ${(j.nodes || []).length}, meshes: ${(j.meshes || []).length}, materials: ${(j.materials || []).length}, animations: ${(j.animations || []).length}, skins: ${(j.skins || []).length}, images: ${(j.images || []).length}`);
  for (const [i, n] of (j.nodes || []).entries()) console.log(`  node[${i}] ${n.name} mesh=${n.mesh ?? '-'} T=${JSON.stringify(n.translation)} R=${JSON.stringify(n.rotation)} S=${JSON.stringify(n.scale)} children=${JSON.stringify(n.children)}`);
  for (const [i, m] of (j.meshes || []).entries()) for (const p of m.primitives) {
    const attrs = Object.entries(p.attributes).map(([k, v]) => { const a = j.accessors[v]; return `${k}(${a.type},ct=${a.componentType}${a.normalized ? ',norm' : ''},n=${a.count}${a.min ? ',min=' + a.min.map(x => +x.toFixed(4)) + ',max=' + a.max.map(x => +x.toFixed(4)) : ''})`; });
    console.log(`  mesh[${i}] ${m.name} material=${p.material} indices.count=${j.accessors[p.indices].count} attrs: ${attrs.join(' ')}`);
  }
  for (const [i, m] of (j.materials || []).entries()) console.log(`  material[${i}] ${m.name} ${JSON.stringify(m.pbrMetallicRoughness)}`);
}
