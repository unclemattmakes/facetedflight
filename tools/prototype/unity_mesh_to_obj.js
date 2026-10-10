#!/usr/bin/env node
/**
 * unity_mesh_to_obj.js -- decode a Unity 5.4 (Mesh serializedVersion 8) YAML .asset mesh and write
 *   - an .obj (positions + normals + uv0 + optional vertex colors as the "v x y z r g b" extension)
 *   - a .json sidecar with the full channel layout report and the decoded colors/tangents/uv1
 *   - optionally a .glb (--glb) with POSITION / NORMAL / COLOR_0 / TEXCOORD_0 / TANGENT
 *
 * Usage:
 *   node unity_mesh_to_obj.js <mesh.asset> [out.obj] [--three] [--glb] [--quiet]
 *
 * --three  converts Unity (left-handed, Y-up, +Z forward) to three.js/glTF (right-handed, Y-up,
 *          -Z forward) by negating Z on positions/normals/tangent.xyz and reversing triangle
 *          winding. Without the flag output is in raw Unity coordinates.
 *          NOTE: --glb implies --three (glTF is defined right-handed; writing raw Unity coords into
 *          a GLB would produce inside-out geometry).
 *
 * FIXED 2026-09-08: the previous version crashed with "Cannot read properties of undefined
 * (reading 'values')" because several assets in this project use CRLF line endings
 * (e.g. Meshes/Converted_Faceted_Meshes/rock1-Faceted.asset) while others use LF
 * (e.g. "Materialized Mesh/MM_.../....asset", all .unity scenes). Every structural regex anchored on a
 * bare "\n" therefore failed on the CRLF files, m_Channels came back null, and the channel list was
 * empty. All input is now normalised to LF before parsing, the "- stream:" split no longer drops
 * the first channel, and multiple !u!43 documents per file are supported.
 *
 * Format notes (verified against rock1-Faceted.asset and MM_TI_Old_Tree_05.asset):
 *   - one or more YAML documents "--- !u!43 &<fileId>" each with a "Mesh:" mapping
 *   - m_SubMeshes[]: firstByte (BYTE offset into the index buffer -> /2 for uint16 indices),
 *     indexCount, topology (0=triangles, 1=quads(pre-5), 2=lines, 3=linestrip, 4=points),
 *     firstVertex, vertexCount, localAABB {m_Center, m_Extent}
 *   - m_IndexBuffer: hex string, little-endian uint16. Unity 5.4 has NO m_IndexFormat field --
 *     32-bit indices did not exist until 2017.3, so a submesh can never exceed 65535 vertices.
 *   - m_VertexData: m_CurrentChannels (bitmask over the 8 channel slots), m_VertexCount,
 *     m_Channels[8] each {stream, offset, format, dimension}, m_DataSize, _typelessdata hex
 *       channel index: 0 position, 1 normal, 2 color, 3 uv0, 4 uv1, 5 uv2, 6 uv3, 7 tangent
 *       format: 0 float32, 1 float16, 2 Color32 (4 x uint8, RGBA order)
 *   - a channel with dimension 0 is unused even if its bit happens to be set
 *   - streams are laid out consecutively; each stream's stride is the sum of its channel sizes and
 *     each stream block starts on a 16-byte boundary. Only stream 0 occurs in this project.
 *   - m_MeshCompression != 0 would move the data into m_CompressedMesh (packed bitstreams); no
 *     first-party FF mesh uses it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CHANNEL_NAMES = ['position', 'normal', 'color', 'uv0', 'uv1', 'uv2', 'uv3', 'tangent'];
const FORMAT_SIZE = { 0: 4, 1: 2, 2: 1 }; // bytes per component
const FORMAT_NAME = { 0: 'float32', 1: 'float16', 2: 'uint8(Color32)' };
const TOPOLOGY_NAME = { 0: 'triangles', 1: 'quads', 2: 'lines', 3: 'linestrip', 4: 'points' };

/** Normalise CRLF -> LF and strip a UTF-8 BOM. MUST be done before any "\n"-anchored regex. */
function readUnityText(file) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}

/** Split a normalised Unity YAML stream into raw per-document text blocks. */
function splitDocuments(text) {
  const out = [];
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?[ \t]*$/gm;
  let m, prev = null;
  while ((m = re.exec(text)) !== null) {
    if (prev) out.push({ ...prev, body: text.slice(prev.bodyStart, m.index) });
    prev = { classId: Number(m[1]), fileId: m[2], stripped: !!m[3], bodyStart: re.lastIndex };
  }
  if (prev) out.push({ ...prev, body: text.slice(prev.bodyStart) });
  return out;
}

function parseVec(s) {
  if (!s) return null;
  const o = {};
  for (const m of s.matchAll(/([xyzw]):\s*(-?[\d.eE+-]+|-?\.inf|\.inf)/g)) o[m[1]] = Number(m[2]);
  return o;
}

/** Parse ONE Mesh document body (already LF-normalised). */
function parseMeshDoc(body) {
  const grab = (re, s = body) => { const m = s.match(re); return m ? m[1] : null; };
  const name = (grab(/^\s*m_Name:\s*(.*)$/m) || '').trim();
  const serializedVersion = Number(grab(/^\s*serializedVersion:\s*(\d+)/m));

  const subBlock = grab(/\n\s*m_SubMeshes:\n([\s\S]*?)\n\s*m_Shapes:/);
  const subMeshes = [];
  if (subBlock && subBlock.trim() !== '[]') {
    for (const chunk of subBlock.split(/^\s*- serializedVersion:/m).slice(1)) {
      subMeshes.push({
        firstByte: Number(grab(/firstByte:\s*(\d+)/, chunk)),
        indexCount: Number(grab(/indexCount:\s*(\d+)/, chunk)),
        topology: Number(grab(/topology:\s*(-?\d+)/, chunk)),
        firstVertex: Number(grab(/firstVertex:\s*(\d+)/, chunk)),
        vertexCount: Number(grab(/vertexCount:\s*(\d+)/, chunk)),
        aabbCenter: parseVec(grab(/m_Center:\s*(\{[^}]*\})/, chunk)),
        aabbExtent: parseVec(grab(/m_Extent:\s*(\{[^}]*\})/, chunk)),
      });
    }
  }

  const indexHex = (grab(/\n\s*m_IndexBuffer:\s*([0-9a-fA-F]*)/) || '');
  const indexFormat = grab(/\n\s*m_IndexFormat:\s*(\d+)/); // absent in Unity 5.4
  const currentChannels = Number(grab(/\n\s*m_CurrentChannels:\s*(\d+)/));
  const vertexCount = Number(grab(/\n\s*m_VertexCount:\s*(\d+)/));

  // channels: keep the leading entry (the old code's .slice(1) dropped channel 0)
  const channelsBlock = grab(/\n\s*m_Channels:\n([\s\S]*?)\n\s*m_DataSize:/);
  const channels = [];
  if (channelsBlock) {
    for (const c of channelsBlock.split(/^\s*- stream:/m).slice(1)) {
      channels.push({
        stream: Number(c.match(/^\s*(\d+)/)[1]),
        offset: Number(grab(/offset:\s*(\d+)/, c)),
        format: Number(grab(/format:\s*(\d+)/, c)),
        dimension: Number(grab(/dimension:\s*(\d+)/, c)),
      });
    }
  }
  const dataSize = Number(grab(/\n\s*m_DataSize:\s*(\d+)/));
  const dataHex = (grab(/\n\s*_typelessdata:\s*([0-9a-fA-F]*)/) || '');
  const aabbBlock = grab(/\n\s*m_LocalAABB:\n([\s\S]*?)\n\s*m_MeshUsageFlags:/) || '';
  const localAABB = { center: parseVec(grab(/m_Center:\s*(\{[^}]*\})/, aabbBlock)), extent: parseVec(grab(/m_Extent:\s*(\{[^}]*\})/, aabbBlock)) };
  const meshUsageFlags = Number(grab(/\n\s*m_MeshUsageFlags:\s*(-?\d+)/));
  const meshCompression = Number(grab(/\n\s*m_MeshCompression:\s*(\d+)/));
  const isReadable = Number(grab(/\n\s*m_IsReadable:\s*(\d+)/));
  return { name, serializedVersion, subMeshes, indexHex, indexFormat, currentChannels, vertexCount,
    channels, dataSize, dataHex, localAABB, meshUsageFlags, meshCompression, isReadable };
}

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function decode(mesh) {
  if (mesh.meshCompression !== 0) throw new Error('m_MeshCompression != 0 (packed m_CompressedMesh not handled)');
  const data = Buffer.from(mesh.dataHex, 'hex');
  const n = mesh.vertexCount;

  const active = mesh.channels.map((c, i) => ((mesh.currentChannels & (1 << i)) !== 0) && c.dimension > 0);

  const streamStride = {};
  mesh.channels.forEach((c, i) => {
    if (!active[i]) return;
    streamStride[c.stream] = Math.max(streamStride[c.stream] || 0, c.offset + c.dimension * FORMAT_SIZE[c.format]);
  });
  const streamBase = {};
  let cursor = 0;
  for (const s of Object.keys(streamStride).map(Number).sort((a, b) => a - b)) {
    streamBase[s] = cursor;
    cursor += n * streamStride[s];
    cursor = (cursor + 15) & ~15; // 16-byte stream alignment
  }
  const layout = { streamStride, streamBase, expectedBytes: cursor, declaredDataSize: mesh.dataSize, actualBytes: data.length };
  if (data.length !== mesh.dataSize) layout.WARN_dataSizeMismatch = true;

  const attrs = {};
  mesh.channels.forEach((c, i) => {
    if (!active[i]) return;
    const stride = streamStride[c.stream], base = streamBase[c.stream];
    const out = new Array(n);
    for (let v = 0; v < n; v++) {
      const off = base + v * stride + c.offset;
      const comps = new Array(c.dimension);
      for (let k = 0; k < c.dimension; k++) {
        if (c.format === 0) comps[k] = data.readFloatLE(off + 4 * k);
        else if (c.format === 1) comps[k] = halfToFloat(data.readUInt16LE(off + 2 * k));
        else if (c.format === 2) comps[k] = data.readUInt8(off + k) / 255; // Color32 = R,G,B,A bytes
        else throw new Error('unknown channel format ' + c.format);
      }
      out[v] = comps;
    }
    attrs[CHANNEL_NAMES[i]] = { format: c.format, dimension: c.dimension, values: out };
  });

  const ib = Buffer.from(mesh.indexHex, 'hex');
  const indices = new Array(ib.length >> 1);
  for (let i = 0; i + 1 < ib.length; i += 2) indices[i >> 1] = ib.readUInt16LE(i);
  return { attrs, indices, layout };
}

/* ---------------------------------------------------------------- OBJ ---- */

function writeObj(mesh, dec, outPath, three) {
  const zs = three ? -1 : 1;
  const pos = dec.attrs.position.values;
  const nrm = dec.attrs.normal ? dec.attrs.normal.values : null;
  const uv = dec.attrs.uv0 ? dec.attrs.uv0.values : null;
  const col = dec.attrs.color ? dec.attrs.color.values : null;
  const lines = [`# ${mesh.name} -- decoded from Unity YAML Mesh (serializedVersion ${mesh.serializedVersion})`,
    `# coordinates: ${three ? 'three.js/glTF (Unity Z negated, winding reversed)' : 'raw Unity (left-handed)'}`,
    `# vertex colors: ${col ? 'yes ("v x y z r g b" extension, alpha in sidecar json)' : 'none'}`, `o ${mesh.name}`];
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    let l = `v ${p[0]} ${p[1]} ${p[2] * zs}`;
    if (col) l += ` ${col[i][0].toFixed(5)} ${col[i][1].toFixed(5)} ${col[i][2].toFixed(5)}`;
    lines.push(l);
  }
  if (uv) for (const t of uv) lines.push(`vt ${t[0]} ${t[1]}`);
  if (nrm) for (const q of nrm) lines.push(`vn ${q[0]} ${q[1]} ${q[2] * zs}`);
  for (const [si, sm] of mesh.subMeshes.entries()) {
    lines.push(`g submesh_${si}`);
    if (sm.topology !== 0) { lines.push(`# topology ${sm.topology} (${TOPOLOGY_NAME[sm.topology]}) not triangles; skipped`); continue; }
    const start = sm.firstByte / 2;
    for (let i = 0; i < sm.indexCount; i += 3) {
      let a = dec.indices[start + i] + 1, b = dec.indices[start + i + 1] + 1, c = dec.indices[start + i + 2] + 1;
      if (three) [b, c] = [c, b];
      const f = (k) => (uv && nrm) ? `${k}/${k}/${k}` : nrm ? `${k}//${k}` : uv ? `${k}/${k}` : `${k}`;
      lines.push(`f ${f(a)} ${f(b)} ${f(c)}`);
    }
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
}

/* ---------------------------------------------------------------- GLB ---- */
/** Minimal single-buffer GLB writer. One glTF mesh, one primitive per Unity submesh. */
function buildGlb(mesh, dec, opts = {}) {
  const three = opts.three !== false; // glTF is right-handed: always convert unless explicitly told not to
  const zs = three ? -1 : 1;
  const pos = dec.attrs.position.values;
  const nrm = dec.attrs.normal ? dec.attrs.normal.values : null;
  const uv = dec.attrs.uv0 ? dec.attrs.uv0.values : null;
  const uv1 = dec.attrs.uv1 ? dec.attrs.uv1.values : null;
  const col = dec.attrs.color ? dec.attrs.color.values : null;
  const tan = dec.attrs.tangent ? dec.attrs.tangent.values : null;
  const n = pos.length;

  const chunks = [];        // {buf}
  const bufferViews = [];
  const accessors = [];
  let byteLen = 0;
  const pushView = (buf, target) => {
    while (byteLen % 4 !== 0) { chunks.push(Buffer.alloc(4 - (byteLen % 4))); byteLen += 4 - (byteLen % 4); }
    const v = { buffer: 0, byteOffset: byteLen, byteLength: buf.length };
    if (target) v.target = target;
    bufferViews.push(v); chunks.push(buf); byteLen += buf.length;
    return bufferViews.length - 1;
  };
  const f32Accessor = (rows, comps, name, withMinMax, target = 34962) => {
    const a = new Float32Array(rows.length * comps);
    for (let i = 0; i < rows.length; i++) for (let k = 0; k < comps; k++) a[i * comps + k] = rows[i][k];
    const view = pushView(Buffer.from(a.buffer, a.byteOffset, a.byteLength), target);
    const acc = { bufferView: view, componentType: 5126, count: rows.length, type: ['', 'SCALAR', 'VEC2', 'VEC3', 'VEC4'][comps], name };
    if (withMinMax) {
      const mn = new Array(comps).fill(Infinity), mx = new Array(comps).fill(-Infinity);
      for (const r of rows) for (let k = 0; k < comps; k++) { mn[k] = Math.min(mn[k], r[k]); mx[k] = Math.max(mx[k], r[k]); }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const P = pos.map(p => [p[0], p[1], p[2] * zs]);
  const attributes = { POSITION: f32Accessor(P, 3, 'POSITION', true) };
  if (nrm) attributes.NORMAL = f32Accessor(nrm.map(q => [q[0], q[1], q[2] * zs]), 3, 'NORMAL', false);
  if (tan) attributes.TANGENT = f32Accessor(tan.map(t => [t[0], t[1], t[2] * zs, t[3] === undefined ? 1 : t[3] * zs]), 4, 'TANGENT', false);
  if (uv) attributes.TEXCOORD_0 = f32Accessor(uv.map(t => [t[0], 1 - t[1]]), 2, 'TEXCOORD_0', false); // Unity V is bottom-up, glTF top-down
  if (uv1) attributes.TEXCOORD_1 = f32Accessor(uv1.map(t => [t[0], 1 - t[1]]), 2, 'TEXCOORD_1', false);
  if (col) attributes.COLOR_0 = f32Accessor(col.map(c => [c[0], c[1], c[2], c.length > 3 ? c[3] : 1]), 4, 'COLOR_0', false);

  const primitives = [];
  for (const sm of mesh.subMeshes) {
    if (sm.topology !== 0) continue;
    const start = sm.firstByte / 2;
    const idx = new Uint32Array(sm.indexCount);
    for (let i = 0; i < sm.indexCount; i += 3) {
      const a = dec.indices[start + i], b = dec.indices[start + i + 1], c = dec.indices[start + i + 2];
      idx[i] = a; idx[i + 1] = three ? c : b; idx[i + 2] = three ? b : c;
    }
    let buf, ct;
    if (n <= 65535) { const u = new Uint16Array(idx); buf = Buffer.from(u.buffer, u.byteOffset, u.byteLength); ct = 5123; }
    else { buf = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength); ct = 5125; }
    const view = pushView(buf, 34963);
    accessors.push({ bufferView: view, componentType: ct, count: sm.indexCount, type: 'SCALAR' });
    primitives.push({ attributes, indices: accessors.length - 1, material: 0, mode: 4 });
  }

  const json = {
    asset: { version: '2.0', generator: 'unity_mesh_to_obj.js (FacetedFlight2 pipeline)' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: mesh.name, mesh: 0 }],
    meshes: [{ name: mesh.name, primitives }],
    materials: [{ name: (opts.materialName || 'vertexColor'), pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: false }],
    accessors, bufferViews, buffers: [{ byteLength: byteLen }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let binBuf = Buffer.concat(chunks);
  while (binBuf.length % 4 !== 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(1)]);
  json.buffers[0].byteLength = binBuf.length;
  jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, binBuf]);
}

/* -------------------------------------------------------------- report --- */

function report(src, mesh, dec) {
  const pos = dec.attrs.position.values;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pos) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const col = dec.attrs.color ? dec.attrs.color.values : null;
  let distinctColors = 0, colorSample = [];
  if (col) {
    const set = new Set(col.map(c => c.map(x => Math.round(x * 255)).join(',')));
    distinctColors = set.size; colorSample = [...set].slice(0, 8);
  }
  return {
    file: src, name: mesh.name, serializedVersion: mesh.serializedVersion,
    indexFormatField: mesh.indexFormat, meshCompression: mesh.meshCompression, isReadable: mesh.isReadable,
    currentChannels: mesh.currentChannels, currentChannelsBits: mesh.currentChannels.toString(2).padStart(8, '0'),
    channelsPresent: mesh.channels.map((c, i) => ({ idx: i, name: CHANNEL_NAMES[i], ...c, formatName: FORMAT_NAME[c.format], bytes: c.dimension * FORMAT_SIZE[c.format] }))
      .filter((c, i) => (mesh.currentChannels & (1 << c.idx)) && c.dimension > 0),
    layout: dec.layout,
    vertexCount: mesh.vertexCount, indexCount: dec.indices.length, triangleCount: dec.indices.length / 3,
    subMeshes: mesh.subMeshes.map(s => ({ ...s, topologyName: TOPOLOGY_NAME[s.topology] })),
    hasNormals: !!dec.attrs.normal, hasUV0: !!dec.attrs.uv0, hasUV1: !!dec.attrs.uv1, hasTangents: !!dec.attrs.tangent,
    hasVertexColors: !!col,
    colorFormat: col ? (dec.attrs.color.format === 2 ? 'Color32 (4 x uint8)' : 'float32 x ' + dec.attrs.color.dimension) : null,
    distinctColors, colorSampleRGBA255: colorSample,
    decodedAABB: { min, max, center: min.map((v, k) => (v + max[k]) / 2), extent: min.map((v, k) => (max[k] - v) / 2) },
    declaredLocalAABB: mesh.localAABB, meshUsageFlags: mesh.meshUsageFlags,
    verticesEqualIndices: mesh.vertexCount === dec.indices.length,
  };
}

/** Library entry point: returns [{mesh, dec, report}] for every Mesh document in the file. */
function loadMeshes(src) {
  const text = readUnityText(src);
  const docs = splitDocuments(text).filter(d => d.classId === 43);
  if (!docs.length) throw new Error('no Unity Mesh (classId 43) document in ' + src);
  return docs.map(d => {
    const mesh = parseMeshDoc(d.body);
    mesh.fileId = d.fileId;
    const dec = decode(mesh);
    return { mesh, dec, report: report(src, mesh, dec) };
  });
}

module.exports = { loadMeshes, readUnityText, splitDocuments, parseMeshDoc, decode, writeObj, buildGlb, report, CHANNEL_NAMES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const files = args.filter(a => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node unity_mesh_to_obj.js <mesh.asset> [out.obj] [--three] [--glb] [--quiet]'); process.exit(1); }
  const three = flags.has('--three');
  const src = files[0];
  // NEVER default to writing beside the source: the Unity project is READ-ONLY.
  // Default output goes to this tool's own out/ directory.
  const DEFAULT_OUT_DIR = path.join(__dirname, 'out');
  if (!files[1]) fs.mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const out = files[1] || path.join(DEFAULT_OUT_DIR, path.basename(src, '.asset') + '.obj');
  const loaded = loadMeshes(src);
  loaded.forEach(({ mesh, dec, report: rep }, i) => {
    const objPath = loaded.length === 1 ? out : out.replace(/\.obj$/, `.${i}.obj`);
    writeObj(mesh, dec, objPath, three);
    fs.writeFileSync(objPath.replace(/\.obj$/, '.json'), JSON.stringify({ report: rep,
      colors: dec.attrs.color ? dec.attrs.color.values : null,
      tangents: dec.attrs.tangent ? dec.attrs.tangent.values : null,
      uv1: dec.attrs.uv1 ? dec.attrs.uv1.values : null }, null, 0));
    let extra = '';
    if (flags.has('--glb')) { const gp = objPath.replace(/\.obj$/, '.glb'); fs.writeFileSync(gp, buildGlb(mesh, dec, { three: true })); extra = ` and ${gp}`; }
    if (!flags.has('--quiet')) console.log(JSON.stringify(rep, null, 2));
    console.log(`wrote ${objPath} and ${objPath.replace(/\.obj$/, '.json')}${extra}`);
  });
}
