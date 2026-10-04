import { describe as group, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { WEEK_MS, describe, isDue, parse, versions, withLines } from '../hooks/check'
import type { Item, Report } from '../types'

const NOW = Date.parse('2026-10-04T09:00:00Z')

const item = (over: Partial<Item>): Item => ({
  kind: 'ready',
  id: 'icons8@icons8',
  name: 'icons8',
  from: '0.4.1',
  to: '0.5.1',
  notes: 'v0.5.0: animated icons',
  apply: [['claude', 'plugin', 'update', '--json', 'icons8@icons8']],
  ...over,
})

const REPORT: Report = {
  checkedAt: '2026-10-04T08:00:00Z',
  items: [
    item({}),
    item({ id: 'npm:@openai/codex', name: 'Codex CLI', from: '0.159.2', to: '0.160.0', notes: '' }),
    item({ kind: 'review', id: 'adapted:img2threejs', name: 'img2threejs', from: 'dede590', to: 'v2.0.0', apply: undefined }),
  ],
  errors: [],
}

group('what Updates says', () => {
  test('/updates names what is ready and points to the Mods panel', () => {
    expect(describe(REPORT)).toBe('2 ready: icons8 0.4.1 → 0.5.1, Codex CLI 0.159.2 → 0.160.0; 1 more to review. Apply them in /mods, on the Updates tab.')
    expect(describe({ ...REPORT, items: [] })).toBe('Everything is up to date.')
    expect(describe('timeout')).toBe("Couldn't check for updates: timeout")
  })

  test('checks once a week, reads the checker and the summaries', () => {
    expect(isDue(null, NOW)).toBe(true)
    expect(isDue({ ...REPORT, checkedAt: new Date(NOW - WEEK_MS + 60_000).toISOString() }, NOW)).toBe(false)
    expect(parse(JSON.stringify(REPORT))).toEqual({ report: REPORT })
    expect(parse('')).toEqual({ error: 'the check printed nothing' })
    expect(withLines(REPORT, '{"icons8@icons8": "Animated icons."}').items[0]?.line).toBe('Animated icons')
    expect(versions(item({ from: '', to: 'skill' }))).toBe('skill')
  })
})

function world(on: On): { prompts: string[]; saved: unknown[] } {
  const seen = { prompts: [] as string[], saved: [] as unknown[] }
  mock.clock(on, { now: NOW })
  on('store.get', () => ({ value: undefined }))
  on('store.set', ($, e) => {
    seen.saved.push(e.value)

    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('model.complete', ($, e) => {
    seen.prompts.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: '{"icons8@icons8": "Animated icons, Lottie and gif"}',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  return seen
}

group('in a session', () => {
  test('/updates checks, words only the items with notes, and keeps the report', async ($, on) => {
    const seen = world(on)
    const said = await $.command.run({ command: 'updates', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

    expect(said.text).toMatch(/^2 ready: icons8/)
    expect(seen.prompts[0]).toContain('icons8@icons8')
    expect(seen.prompts[0]).not.toContain('npm:@openai/codex')
    expect((seen.saved.at(-1) as Report).items[0]?.line).toBe('Animated icons, Lottie and gif')
  })
})
