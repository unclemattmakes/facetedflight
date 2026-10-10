// tools/security/audit.mjs: `pnpm audit:security`, the repeatable half of the
// launch security audit (docs/SECURITY-AUDIT.md, "Re-run before each release").
//
//   pnpm audit:security                    every check; dist/ checked if present
//   pnpm audit:security --require-dist     and a missing dist/_headers is a FAILURE
//   pnpm audit:security --offline          skip the two `pnpm audit` calls (no network)
//
// Checks, each printed with its own verdict:
//
//   deps      `pnpm audit --prod` for the game and for `workers/rooms`.
//   secrets   every TRACKED file (a superset of what `pnpm release:list` copies
//             into the public repository) against credential patterns, and no
//             tracked file whose NAME is a secret's (`.env`, `.dev.vars`, keys).
//   sinks     `src/`, `functions/`, `workers/` and `index.html` for HTML and
//             code-execution sinks; every hit must be on `SINK_ALLOW` with a
//             reason, and every allow entry must still be hit (no stale rows).
//   headers   `dist/_headers` carries every line `tools/dev/security-headers.mjs`
//             says it should. Skipped LOUDLY without a build, unless
//             `--require-dist` makes that a failure (the release gate's form).
//
// A skipped check prints SKIPPED, never "ok": a skip read as a pass is
// CLAUDE.md's "a SKIPPED gate looks like a pass in a summary line".
//
// The pure scanners are exported, and `tests/unit/security-audit.test.ts`
// runs `secrets` and `sinks` over the tree in `pnpm check`, so a regression is
// red in the ordinary gate and not only on release day.
//
// This file describes its patterns in prose and keeps them in RegExp source,
// so the secrets scan cannot match its own text (CLAUDE.md: a guard that
// classifies by substring is answered by prose about it).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEADERS_FILE, SECURITY_HEADERS } from '../dev/security-headers.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

// ── secrets ───────────────────────────────────────────────────────────────

/** Credential shapes. Each is specific enough that a hit is worth a human's minute. */
export const SECRET_PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  // A Pages/Worker secret or a Cloudflare credential assigned a literal value.
  // A value starting `local-` is the documented fake for `wrangler pages dev`
  // (docs/lap-server.md; `copy-list.mjs` makes the same exception). Test
  // fixtures use other fake values; those are allowed by `SECRET_ALLOW`.
  [
    'secret assigned a literal',
    /\b(?:ADMIN_TOKEN|IP_SALT|CLOUDFLARE_API_TOKEN|CF_API_TOKEN|R2_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY)\b\s*(?:=|:)\s*['"`]?(?!local-)[A-Za-z0-9+/_.=-]{16,}/,
  ],
  ['Cloudflare account id in a config', /\baccount_id\b['"]?\s*[=:]\s*['"]?[0-9a-f]{32}\b/],
]

/** Tracked-file names that are a secret by being present at all. */
export const SECRET_FILE_NAMES =
  /(^|\/)(\.env(\.(?!example$)[^/]*)?|\.dev\.vars|[^/]*\.(pem|p12|pfx|key)|id_(rsa|ed25519|ecdsa))$/

/**
 * Where a pattern may hit, with the reason. A path regex and the pattern's
 * name; nothing else is excused.
 */
export const SECRET_ALLOW = [
  {
    path: /^tests\/unit\//,
    name: 'secret assigned a literal',
    why: 'unit tests bind fake ADMIN_TOKEN / IP_SALT values to exercise the guard (`lap-admin.test.ts`)',
  },
]

/** Findings for one file's text: `{ file, line, name }`. */
export const scanSecrets = (file, text) => {
  const out = []
  const lines = text.split('\n')
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (SECRET_ALLOW.some((a) => a.name === name && a.path.test(file))) continue
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) out.push({ file, line: i + 1, name })
    }
  }
  return out
}

// ── sinks ─────────────────────────────────────────────────────────────────

/** HTML and code-execution sinks. Text set on canvas or via `textContent` is not one. */
export const SINK_PATTERN =
  /\.(?:innerHTML|outerHTML)\s*(?:=|\+=)|\binsertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(|\.srcdoc\s*=|\bcreateContextualFragment\s*\(|\bsetTimeout\s*\(\s*['"`]|\bsetInterval\s*\(\s*['"`]/

/**
 * Every sink that exists today, by file and the exact trimmed line, with why
 * it is safe. A new sink fails the check until somebody adds a row here; a row
 * whose line has gone fails it too, so the list cannot rot.
 */
export const SINK_ALLOW = [
  {
    file: 'src/input/turn-phone.ts',
    line: 'plate.innerHTML = ICON',
    why: '`ICON` is an SVG string literal in the same file; no input reaches it',
  },
  {
    file: 'src/making-of/shared/toy-host.ts',
    line: "root.innerHTML = ''",
    why: 'clears the element; writes no markup',
  },
]

/** Where the sweep looks: shipped code that runs in a page or a Worker. */
export const SINK_ROOTS = ['src/', 'functions/', 'workers/rooms/src/', 'index.html']

const isSinkFile = (f) =>
  SINK_ROOTS.some((r) => (r.endsWith('/') ? f.startsWith(r) : f === r)) &&
  /\.(ts|tsx|js|mjs|html)$/.test(f) &&
  !/\.d\.ts$/.test(f)

/** Sink hits in one file's text: `{ file, line, text }`. */
export const scanSinks = (file, text) => {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (SINK_PATTERN.test(line)) out.push({ file, line: i + 1, text: trimmed })
  }
  return out
}

/** Unallowed hits, and allow rows nothing hit. */
export const judgeSinks = (hits) => {
  const allowed = (h) => SINK_ALLOW.some((a) => a.file === h.file && a.line === h.text)
  const unallowed = hits.filter((h) => !allowed(h))
  const stale = SINK_ALLOW.filter((a) => !hits.some((h) => h.file === a.file && h.text === a.line))
  return { unallowed, stale }
}

// ── the tree ──────────────────────────────────────────────────────────────

/** Tracked files, forward slashes, relative to the repo root. */
export const trackedFiles = (root = ROOT) => {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`)
  return r.stdout.split('\0').filter((f) => f !== '')
}

const readText = (root, f) => {
  let buf
  try {
    buf = fs.readFileSync(path.join(root, f))
  } catch {
    return null // deleted in the worktree, or a junction
  }
  if (buf.length > 4 * 1024 * 1024 || buf.includes(0)) return null // binary or huge
  return buf.toString('utf8')
}

/** The secrets check over the tracked tree. */
export const secretsInTree = (root = ROOT) => {
  const files = trackedFiles(root)
  const named = files
    .filter((f) => SECRET_FILE_NAMES.test(f))
    .map((file) => ({ file, line: 0, name: 'secret file tracked' }))
  const found = [...named]
  for (const f of files) {
    if (f === 'pnpm-lock.yaml' || f.endsWith('/pnpm-lock.yaml')) continue // integrity hashes, not secrets
    const text = readText(root, f)
    if (text !== null) found.push(...scanSecrets(f, text))
  }
  return found
}

/** The sinks check over the tracked tree. */
export const sinksInTree = (root = ROOT) => {
  const hits = []
  for (const f of trackedFiles(root).filter(isSinkFile)) {
    const text = readText(root, f)
    if (text !== null) hits.push(...scanSinks(f, text))
  }
  return judgeSinks(hits)
}

/** Missing `_headers` lines, or null when there is no built file. */
export const missingHeaders = (distDir) => {
  const file = path.join(distDir, HEADERS_FILE)
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  return Object.entries(SECURITY_HEADERS)
    .map(([n, v]) => `  ${n}: ${v}`)
    .filter((l) => !lines.includes(l))
}

// ── main ──────────────────────────────────────────────────────────────────

const pnpmAudit = (dir) => {
  const r = spawnSync('pnpm', ['audit', '--prod'], { cwd: dir, encoding: 'utf8', shell: true })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const main = () => {
  const argv = process.argv.slice(2)
  const offline = argv.includes('--offline')
  const requireDist = argv.includes('--require-dist')
  let failed = false
  const verdict = (name, ok, detail = '') => {
    console.log(
      `${ok === null ? 'SKIPPED' : ok ? 'ok     ' : 'FAILED '} ${name}${detail ? `  ${detail}` : ''}`,
    )
    if (ok === false) failed = true
  }

  if (offline) {
    verdict('deps (game)', null, '--offline')
    verdict('deps (workers/rooms)', null, '--offline')
  } else {
    for (const [name, dir] of [
      ['deps (game)', ROOT],
      ['deps (workers/rooms)', path.join(ROOT, 'workers/rooms')],
    ]) {
      const r = pnpmAudit(dir)
      verdict(name, r.status === 0, r.out.split('\n').slice(-1)[0])
      if (r.status !== 0) console.log(r.out)
    }
  }

  const secrets = secretsInTree()
  verdict('secrets (tracked files)', secrets.length === 0, `${secrets.length} finding(s)`)
  for (const s of secrets) console.log(`    ${s.file}:${s.line}  ${s.name}`)

  const { unallowed, stale } = sinksInTree()
  verdict(
    'sinks (HTML / eval)',
    unallowed.length === 0 && stale.length === 0,
    `${SINK_ALLOW.length} allowlisted`,
  )
  for (const h of unallowed) console.log(`    NEW   ${h.file}:${h.line}  ${h.text}`)
  for (const a of stale) console.log(`    STALE ${a.file}  "${a.line}" (remove the SINK_ALLOW row)`)

  const missing = missingHeaders(path.join(ROOT, 'dist'))
  if (missing === null)
    verdict('headers (dist/_headers)', requireDist ? false : null, 'no build in dist/')
  else {
    verdict('headers (dist/_headers)', missing.length === 0, `${missing.length} missing`)
    for (const l of missing) console.log(`    missing:${l}`)
  }

  console.log(failed ? '\naudit:security FAILED' : '\naudit:security passed')
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
