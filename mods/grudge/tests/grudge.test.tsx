import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isPreviewTool, isUiFile, grudgeBrief, listing, unapprovedLine, verdictOf } from '../hooks/grudge'
import type { Entry } from '../types'

const APP = '/work/shop-app'

const entry = (over: Partial<Entry>): Entry => ({
  id: 'grudge-1',
  at: Date.parse('2026-10-04T07:00:00Z'),
  project: APP,
  verdict: 'rejected',
  screen: 'Top bar',
  rule: 'Keep the R4 top bar in every theme',
  quote: 'again this old design of top bar. wtf',
  images: ['/home/me/.claude/grudge/shop-app/grudge-1-1.png'],
  ...over,
})

describe('what counts as a verdict', () => {
  test('a rejection needs a screenshot, a look on the table or words about the UI', () => {
    expect(verdictOf('slop', true, false)).toBe('rejected')
    expect(verdictOf('again this old design of top bar. wtf', false, false)).toBe('rejected')
    expect(verdictOf('выглядит плохо', false, true)).toBe('rejected')
    expect(verdictOf('wtf why mx is using uk number?', false, false)).toBeUndefined()
    expect(verdictOf('the deploy is slop', false, false)).toBeUndefined()
  })

  test('an approval needs a look on the table and a short reply', () => {
    expect(verdictOf('looks right, yes pls.', false, true)).toBe('approved')
    expect(verdictOf('A', false, true)).toBe('approved')
    expect(verdictOf('A', false, false)).toBeUndefined()
    expect(verdictOf('perfect, now also wire the backend to the new endpoint and run the full suite please', false, true)).toBeUndefined()
  })

  test('UI files and preview tools', () => {
    expect(isUiFile('/repo/apps/mac/Sources/SettingsView.swift')).toBe(true)
    expect(isUiFile('/repo/apps/mac/Sources/RoomStore.swift')).toBe(false)
    expect(isUiFile('/repo/web/components/TopBar.tsx')).toBe(true)
    expect(isUiFile('/repo/web/components/TopBar.test.tsx')).toBe(false)
    expect(isPreviewTool('mcp__visualize__show_widget', undefined)).toBe(true)
    expect(isPreviewTool('Write', '/tmp/x/preview-r1.html')).toBe(true)
    expect(isPreviewTool('Edit', '/repo/a.ts')).toBe(false)
  })
})

describe('what Claude and the person read', () => {
  test('the brief lists the rules with their screenshots, then the habits', () => {
    const said = grudgeBrief(APP, [entry({}), entry({ id: 'grudge-2', verdict: 'approved', screen: 'Icons', rule: 'Keep the R2 icon set', images: [] })], false)

    expect(said).toContain('Grudge for shop-app')
    expect(said).toContain('Rejected:\n- Top bar: Keep the R4 top bar in every theme (Oct 4) [screenshot: /home/me/.claude/grudge/shop-app/grudge-1-1.png]')
    expect(said).toContain('Approved:\n- Icons: Keep the R2 icon set (Oct 4)')
    expect(said).toContain('real, shipped products')
    expect(said).toContain('No preview has been approved in this session yet.')
    expect(grudgeBrief('/other', [entry({})], true)).toContain('nothing recorded yet')
  })

  test('/grudge numbers the rules', () => {
    expect(listing(APP, [entry({})])).toBe(
      ['shop-app · 1 rule', 'Rejected', '  1. Top bar: Keep the R4 top bar in every theme · Oct 4', '/grudge forget <n> · /grudge add <rule>'].join('\n'),
    )
    expect(unapprovedLine(['/a/SettingsView.swift'])).toBe('Changed SettingsView.swift without a preview you approved')
    expect(unapprovedLine(['/a/A.tsx', '/a/B.tsx', '/a/C.tsx'])).toBe('Changed A.tsx and 2 more without a preview you approved')
  })
})

type Seen = { contexts: (readonly string[] | undefined)[]; edits: string[]; toasts: string[] }

function world(on: On): Seen {
  const seen: Seen = { contexts: [], edits: [], toasts: [] }
  mock.clock(on, { now: Date.parse('2026-10-04T07:00:00Z') })
  mock.store(on)
  on('session.cwd', () => ({ value: APP }))
  on('session.repo', () => ({ value: { root: APP, name: 'shop-app', remote: null, internal: false } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('env.get', () => ({ value: '/home/me' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '["/home/me/.claude/grudge/shop-app/shot-1.png"]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    seen.contexts.push(e.context)

    return { text: e.text, context: e.context }
  })
  // Beneath: the engine's own tools.
  on('tool.call', ($, e) => {
    seen.edits.push(e.tool)

    return { result: { ok: true } as never }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })

  return seen
}

const REPLY = "You're right, the old top bar came back with the theme change. Restored the R4 one."
const message = (surface: 'desktop' | 'terminal') =>
  ({ plugin: 'grudge', component: 'AssistantMessage', surface, props: { text: REPLY, isFirstOfReply: true } }) as const
const presentation = { isFullscreen: false, columns: 120 }

describe('in a session', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`on the ${surface}, a rejection with a screenshot becomes a rule under the next reply, and Undo takes it out`, async ($, on) => {
      const seen = world(on)
      await $.prompt.submit({
        text: 'again this old design of top bar. wtf',
        attachments: [{ type: 'image', mediaType: 'image/png' }],
        wait: false,
        origin: { kind: 'composer' },
      })

      expect(seen.contexts[0]?.some(block => block.includes('just rejected what you showed them, with a screenshot'))).toBe(true)

      const called = (await $.tool.call({ tool: 'mcp__grudge__note', tool_use_id: 'tu-1', screen: 'Top bar', rule: 'Keep the R4 top bar in every theme' } as never)) as {
        result?: { text: string }[]
      }
      expect(called.result?.[0]?.text).toBe("Recorded for shop-app. Carry on with the person's request.")
      await $.turn.complete({ agentId: undefined, reason: 'answer', answer: REPLY, turnId: 't1' } as never)

      const ui = await $.ui.mount(message(surface))
      expect(await ui.find({ type: 'Text', text: 'Noted for shop-app: Keep the R4 top bar in every theme' })).toBeDefined()

      const listed = await $.command.run({ command: 'grudge', args: '', origin: { kind: 'composer' }, presentation })
      expect(listed.text).toContain('1. Top bar: Keep the R4 top bar in every theme')

      await ui.press({ key: `undo-grudge-${Date.parse('2026-10-04T07:00:00Z').toString(36)}` })
      expect(await ui.find({ type: 'Text', text: 'Noted for shop-app: Keep the R4 top bar in every theme' })).toBeUndefined()
      expect(seen.toasts).toEqual(['Grudge dropped.'])
      await ui.unmount()
    })
  }

  test('the first UI edit of a turn carries the rules; with no approved preview the reply says so', async ($, on) => {
    world(on)
    await $.command.run({ command: 'grudge', args: 'add Flat buttons like Codex, never bordered macOS ones', origin: { kind: 'composer' }, presentation })
    await $.prompt.submit({ text: 'restyle the settings sheet', wait: false, origin: { kind: 'composer' } })

    const first = (await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${APP}/apps/mac/SettingsView.swift` } as never)) as { context?: string[] }
    const second = (await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: `${APP}/apps/mac/SettingsRow.swift` } as never)) as { context?: string[] }
    const logic = (await $.tool.call({ tool: 'Edit', tool_use_id: 'e3', file_path: `${APP}/apps/mac/RoomStore.swift` } as never)) as { context?: string[] }

    expect(first.context?.[0]).toContain('- General: Flat buttons like Codex, never bordered macOS ones')
    expect(second.context).toBeUndefined()
    expect(logic.context).toBeUndefined()

    await $.turn.complete({ agentId: undefined, reason: 'answer', answer: REPLY, turnId: 't1' } as never)
    const ui = await $.ui.mount(message('desktop'))
    expect(await ui.find({ type: 'Text', text: 'Changed SettingsView.swift and SettingsRow.swift without a preview you approved' })).toBeDefined()
    await ui.unmount()
  })

  test('after a preview and an approval, UI edits draw no warning', async ($, on) => {
    world(on)
    await $.prompt.submit({ text: 'show me two directions for settings', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'mcp__visualize__show_widget', tool_use_id: 'w1' } as never)
    await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'Here are A and B, pick one for the settings sheet.', turnId: 't1' } as never)

    await $.prompt.submit({ text: 'A', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'mcp__grudge__note', tool_use_id: 'n1', screen: 'Settings', rule: 'Use direction A: grouped sections' } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: `${APP}/apps/mac/SettingsView.swift` } as never)
    await $.turn.complete({ agentId: undefined, reason: 'answer', answer: REPLY, turnId: 't2' } as never)

    const ui = await $.ui.mount(message('desktop'))
    expect(await ui.find({ type: 'Text', text: 'Noted for shop-app: Use direction A: grouped sections' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /without a preview you approved/ })).toBeUndefined()
    await ui.unmount()
  })
})
