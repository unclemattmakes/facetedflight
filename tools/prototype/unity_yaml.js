/**
 * unity_yaml.js -- minimal, dependency-free parser for the YAML subset Unity 5.x writes (ForceText).
 *
 * Handles: the multi-document stream ("%YAML 1.1", "%TAG !u! tag:unity3d.com,2011:",
 * "--- !u!<classId> &<fileId>[ stripped]"), block mappings (2-space indent), block sequences
 * ("- key: v" and "- scalar"), flow mappings "{x: 1, y: 2}" / "{fileID: 1, guid: ..., type: 2}"
 * (including the wrapped form Unity emits when a flow mapping exceeds the line width), flow
 * sequences "[]" / "[1, 2]", empty values ("m_Name: " -> ""), single/double-quoted scalars, and
 * the giant hex scalars used for mesh data (kept as strings).
 *
 * It is NOT a general YAML parser (no anchors/aliases beyond the document anchor, no multi-line
 * literal blocks). Unity does not emit those in scene/prefab/asset files.
 *
 * API:
 *   parseDocuments(text) -> [{ classId, fileId, stripped, type, data }]
 *     type = top-level key (e.g. "GameObject", "Transform", "MonoBehaviour", "Prefab")
 *     data = plain JS object for that mapping
 */
'use strict';

const DOC_RE = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/;

function parseDocuments(text) {
  const lines = text.split(/\r?\n/);
  const docs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = DOC_RE.exec(line);
    if (m) {
      if (cur) docs.push(finish(cur));
      cur = { classId: Number(m[1]), fileId: m[2], stripped: !!m[3], lines: [] };
      continue;
    }
    if (line.startsWith('%')) continue; // directives
    if (cur) cur.lines.push(line);
  }
  if (cur) docs.push(finish(cur));
  return docs;
}

function finish(doc) {
  const body = parseBlock(joinWrappedFlow(doc.lines));
  const type = Object.keys(body)[0];
  return { classId: doc.classId, fileId: doc.fileId, stripped: doc.stripped, type, data: body[type] };
}

/** Unity wraps long flow mappings onto continuation lines:
 *    m_PrefabParentObject: {fileID: 114000011401087442, guid: 54436c2455...,
 *      type: 2}
 *  Merge such continuation lines back so each flow mapping is on one physical line. */
function joinWrappedFlow(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let depth = braceDepth(line);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      line += ' ' + lines[i].trim();
      depth = braceDepth(line);
    }
    out.push(line);
  }
  return out;
}

function braceDepth(line) {
  // ignore braces inside quotes
  let depth = 0, q = null;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return depth;
}

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

/** Parse a list of lines (already de-wrapped) as a block node. Returns object or array. */
function parseBlock(lines) {
  const items = lines.map((l, idx) => ({ raw: l, idx })).filter(o => o.raw.trim() !== '' && !o.raw.trim().startsWith('#'));
  let pos = 0;
  function parseNode(indent) {
    // decide: sequence or mapping based on first line at this indent
    const first = items[pos];
    if (!first) return null;
    const t = first.raw.trim();
    if (t.startsWith('- ') || t === '-') return parseSeq(indentOf(first.raw));
    return parseMap(indentOf(first.raw));
  }
  function parseMap(indent) {
    const obj = {};
    while (pos < items.length) {
      const it = items[pos];
      const ind = indentOf(it.raw);
      if (ind < indent) break;
      if (ind > indent) { pos++; continue; } // stray deeper line (should not happen)
      const t = it.raw.slice(ind);
      if (t.startsWith('- ')) break; // sequence at same indent belongs to parent key handled below
      const kv = splitKey(t);
      if (!kv) { pos++; continue; }
      const [key, rest] = kv;
      pos++;
      if (rest === '') {
        // nested block: mapping or sequence on following lines
        const next = items[pos];
        if (next) {
          const nind = indentOf(next.raw);
          const nt = next.raw.trim();
          if (nind > indent) obj[key] = parseNode(nind);
          else if (nind === indent && (nt.startsWith('- ') || nt === '-')) obj[key] = parseSeq(indent); // Unity: sequence items at same indent as key
          else obj[key] = '';
        } else obj[key] = '';
      } else {
        obj[key] = parseScalarOrFlow(rest);
      }
    }
    return obj;
  }
  function parseSeq(indent) {
    const arr = [];
    while (pos < items.length) {
      const it = items[pos];
      const ind = indentOf(it.raw);
      if (ind !== indent) { if (ind < indent) break; pos++; continue; }
      const t = it.raw.slice(ind);
      if (!(t.startsWith('- ') || t === '-')) break;
      const inner = t === '-' ? '' : t.slice(2);
      if (inner === '') { pos++; const next = items[pos]; arr.push(next && indentOf(next.raw) > indent ? parseNode(indentOf(next.raw)) : null); continue; }
      const kv = splitKey(inner);
      if (kv && !inner.startsWith('{') && !inner.startsWith('[') && !inner.startsWith('"') && !inner.startsWith("'")) {
        // "- key: value" starts an inline mapping whose further keys are at indent+2
        // rewrite current line as a mapping line at indent+2 and parse the mapping
        items[pos] = { raw: ' '.repeat(indent + 2) + inner, idx: it.idx };
        arr.push(parseMap(indent + 2));
      } else {
        pos++;
        arr.push(parseScalarOrFlow(inner));
      }
    }
    return arr;
  }
  const result = parseNode(indentOf(items[0] ? items[0].raw : ''));
  return result;
}

/** split "key: rest" respecting quotes; returns [key, rest] or null */
function splitKey(t) {
  // a key is everything before the first ": " (or trailing ":")
  let q = null;
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (q) { if (ch === q) q = null; continue; }
    if (k === 0 && (ch === '"' || ch === "'")) { q = ch; continue; }
    if (ch === ':' && (k === t.length - 1 || t[k + 1] === ' ')) {
      return [unquote(t.slice(0, k).trim()), t.slice(k + 1).trim()];
    }
    if (ch === '{' || ch === '[') return null; // flow value without key
  }
  return null;
}

function unquote(s) {
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch (e) { return s.slice(1, -1); }
  }
  return s;
}

function parseScalarOrFlow(s) {
  s = s.trim();
  if (s.startsWith('{')) return parseFlowMap(s);
  if (s.startsWith('[')) return parseFlowSeq(s);
  return scalar(s);
}

function scalar(s) {
  if (s === '') return '';
  if (s[0] === '"' || s[0] === "'") return unquote(s);
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    // Unity writes fileIDs up to 2^63 -- keep those as strings to avoid precision loss
    if (Number.isSafeInteger(n) || !/^-?\d+$/.test(s)) return n;
    return s;
  }
  if (s === '-.inf' || s === '.inf' || s === '.nan') return s;
  return s;
}

function parseFlowMap(s) {
  // {a: 1, b: {c: 2}, d: []}
  const obj = {};
  let i = 1, key = null;
  const n = s.length;
  const readToken = () => {
    let depth = 0, start = i, q = null;
    for (; i < n; i++) {
      const ch = s[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      else if (ch === ':' && depth === 0 && key === null && (s[i + 1] === ' ' || s[i + 1] === ',' || s[i + 1] === '}')) break;
    }
    return s.slice(start, i).trim();
  };
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === ',')) i++;
    if (s[i] === '}') break;
    key = null;
    const k = readToken();
    if (s[i] === ':') { i++; key = unquote(k); const v = readToken(); obj[key] = parseScalarOrFlow(v); }
    else if (k !== '') obj[k] = null;
  }
  return obj;
}

function parseFlowSeq(s) {
  const arr = [];
  let i = 1;
  const n = s.length;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === ',')) i++;
    if (s[i] === ']') break;
    let depth = 0, start = i, q = null;
    for (; i < n; i++) {
      const ch = s[i];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
    }
    const tok = s.slice(start, i).trim();
    if (tok !== '') arr.push(parseScalarOrFlow(tok));
  }
  return arr;
}

module.exports = { parseDocuments, parseBlock, parseScalarOrFlow };
