/**
 * `pnpm audit:security`'s two offline checks, run in `pnpm check` too
 * (docs/SECURITY-AUDIT.md): no credential in a tracked file, and no HTML or
 * eval sink in shipped code that is not on the allowlist with a reason.
 *
 * The positive cases build their sample credentials at run time, so this file
 * never holds one the tree scan would then have to excuse.
 */
import { describe, expect, it } from 'vitest'
import {
  judgeSinks,
  SINK_ALLOW,
  scanSecrets,
  scanSinks,
  secretsInTree,
  sinksInTree,
  trackedFiles,
} from '../../tools/security/audit.mjs'

const join = (...parts: string[]) => parts.join('')

describe('the secrets scan', () => {
  it('finds each credential shape it claims to', () => {
    const samples: [string, string][] = [
      ['AWS access key id', `key = ${join('AK', 'IA', 'ABCDEFGHIJKLMNOP')}`],
      ['GitHub token', `t = '${join('gh', 'p_', 'a'.repeat(36))}'`],
      ['Anthropic key', join('s', 'k-', 'ant-', 'x'.repeat(24))],
      ['private key block', join('-----BEGIN ', 'PRIVATE KEY-----')],
      ['secret assigned a literal', join('ADMIN', '_TOKEN', '=', 'Zq9'.repeat(8))],
      ['Cloudflare account id in a config', join('"account', '_id": "', 'ab12'.repeat(8), '"')],
    ]
    for (const [name, line] of samples) {
      expect(scanSecrets('src/x.ts', line).map((f) => f.name)).toContain(name)
    }
  })

  it('lets the documented local fake and short test salts through', () => {
    expect(
      scanSecrets('docs/x.md', join('ADMIN', '_TOKEN=local-admin-token-not-a-secret-0000')),
    ).toEqual([])
    expect(scanSecrets('src/x.ts', join('IP', "_SALT: 'test-salt'"))).toEqual([])
  })

  it('finds nothing in the tracked tree', () => {
    expect(trackedFiles().length).toBeGreaterThan(1000) // the scan is not vacuous
    expect(secretsInTree()).toEqual([])
  })
})

describe('the sink sweep', () => {
  it('catches HTML and code sinks, and ignores text and comments', () => {
    const hit = (line: string) => scanSinks('src/x.ts', line).length
    expect(hit('el.innerHTML = name')).toBe(1)
    expect(hit('el.outerHTML += s')).toBe(1)
    expect(hit("el.insertAdjacentHTML('beforeend', s)")).toBe(1)
    expect(hit('document.write(s)')).toBe(1)
    expect(hit('eval(code)')).toBe(1)
    expect(hit("new Function('return 1')")).toBe(1)
    expect(hit("setTimeout('go()', 10)")).toBe(1)
    expect(hit('el.textContent = name')).toBe(0)
    expect(hit('// el.innerHTML = name is what we never do')).toBe(0)
    expect(hit('setTimeout(() => go(), 10)')).toBe(0)
  })

  it('judges a new sink and a stale allow row alike', () => {
    const allowed = SINK_ALLOW.map((a) => ({ file: a.file, line: 1, text: a.line }))
    expect(judgeSinks(allowed)).toEqual({ unallowed: [], stale: [] })
    const extra = { file: 'src/y.ts', line: 3, text: 'el.innerHTML = s' }
    expect(judgeSinks([...allowed, extra]).unallowed).toEqual([extra])
    expect(judgeSinks(allowed.slice(1)).stale).toEqual([SINK_ALLOW[0]])
  })

  it('finds only the allowlisted sinks in shipped code', () => {
    expect(sinksInTree()).toEqual({ unallowed: [], stale: [] })
  })
})
