// tests/unit/briefing-wrap.test.ts — the wrap that must not eat a word.
//
// A wrap that OVERFLOWS the plate is obvious in any screenshot. A wrap that
// silently drops a word is not, and the briefing is the one panel carrying a
// sentence rather than a number — so losing "not" out of an instruction is a
// real failure mode with no visual tell.
//
// `measure` is injected so this needs no canvas: the suite is
// `environment: 'node'` on purpose.

import { describe, expect, it } from 'vitest'
import { wrapText } from '@/render/briefing'

/** One unit per character — exact, and independent of any font metric. */
const monospace = (s: string) => s.length

const SENTENCE = 'Fly through as many rings as you can before time runs out. Don’t CRASH!!'

describe('the briefing wrap', () => {
  it('keeps every word, in order, whatever the width', () => {
    // THE assertion. Rejoining the lines must reproduce the input word for
    // word — a greedy wrap that mishandles its last token loses one silently.
    for (const width of [8, 12, 20, 31, 40, 1_000]) {
      const words = wrapText(SENTENCE, width, monospace).join(' ').split(' ')
      expect(words, `width ${width}`).toEqual(SENTENCE.split(' '))
    }
  })

  it('actually wraps, rather than returning one long line', () => {
    // The guard against a "no word was lost" test that passes because nothing
    // was done at all.
    expect(wrapText(SENTENCE, 20, monospace).length).toBeGreaterThan(2)
    expect(wrapText(SENTENCE, 1_000, monospace)).toHaveLength(1)
  })

  it('stays inside the width whenever a break was possible', () => {
    const width = 24
    for (const line of wrapText(SENTENCE, width, monospace)) {
      // Every line either fits, or is a single word that could not be broken.
      expect(monospace(line) <= width || !line.includes(' '), line).toBe(true)
    }
  })

  it('gives an unbreakable word its own line instead of dropping it', () => {
    // A word longer than the line is the case a greedy wrap most often loses.
    // Overflowing by one word is recoverable; losing it is not.
    const lines = wrapText('short supercalifragilisticexpialidocious short', 10, monospace)
    expect(lines.join(' ')).toContain('supercalifragilisticexpialidocious')
    expect(lines).toContain('supercalifragilisticexpialidocious')
  })

  it('collapses runs of whitespace, including the prefab newline', () => {
    // 2016's `m_Text` is a multi-line YAML scalar and carries a trailing
    // newline. Left alone it becomes an empty last line under the paragraph.
    expect(wrapText('  a\n\n  b \t c  ', 100, monospace)).toEqual(['a b c'])
    expect(wrapText('   ', 100, monospace)).toEqual([])
  })
})
