import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { GAP_MS, IDLE_MS, anchorOf, isDue, isUnder, parseIdea, question, remember } from '../hooks/eye'
import type { Idea } from '../types'

const ANSWER = 'CZ made 16 calls yesterday out of 25. It lost about two hours to the deploy pause, so today should be back to normal.'
const IDEA = {
  idea: 'Listen to the worst CZ call of each day',
  why: 'You track how many calls go out, never how they sound.',
  prompt: 'Pull the worst CZ call from yesterday and tell me what went wrong',
}

describe('the question and the answer', () => {
  test('asks for one idea outside the person\'s frame, steered by their taste', () => {
    const asked = question({ dismissed: ['Add more tests'], asked: ['Price MX by the hour'] })

    expect(asked).toContain('would not have suggested themselves')
    expect(asked).toContain('"Add more tests"')
    expect(asked).toContain('"Price MX by the hour"')
    expect(question({ dismissed: [], asked: [] })).not.toContain('turned these down')
  })

  test('reads the JSON even with words around it', () => {
    expect(parseIdea(`Here you go:\n${JSON.stringify(IDEA)}`)).toEqual(IDEA)
    expect(parseIdea('{"idea": "Try X", "why": "Because."}')?.prompt).toBe('Try X')
    expect(parseIdea('no idea today')).toBeUndefined()
    expect(parseIdea('{"idea": ""}')).toBeUndefined()
  })

  test('finds the last block of the reply it belongs under', () => {
    const anchor = anchorOf(ANSWER)

    expect(isUnder(anchor, ANSWER)).toBe(true)
    expect(isUnder(anchor, 'It lost about two hours to the deploy pause, so today should be back to normal.')).toBe(true)
    expect(isUnder(anchor, 'A different reply altogether, about something else.')).toBe(false)
    expect(isUnder(anchor, 'ok')).toBe(false)
  })

  test('waits its turn and keeps taste short', () => {
    const last = { at: 1_000 } as Idea

    expect(isDue(1_000 + GAP_MS - 1, [last])).toBe(false)
    expect(isDue(1_000 + GAP_MS, [last])).toBe(true)
    expect(remember({ dismissed: ['a', 'b'], asked: [] }, 'dismissed', 'a').dismissed).toEqual(['b', 'a'])
  })
})

const REPLY = {
  plugin: 'third-eye',
  component: 'AssistantMessage',
  props: { text: ANSWER, isFirstOfReply: true },
} as const
const presentation = { isFullscreen: false, columns: 120 }

function world(on: On, store: Record<string, unknown> = {}): { forks: string[]; sent: string[] } {
  const forks: string[] = []
  const sent: string[] = []
  mock.store(on, store)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    const usage = { input_tokens: 10, output_tokens: 60, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }

    return { value: { isAnswered: true as const, text: JSON.stringify(IDEA), usage } }
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)

    return { text: e.text }
  })

  return { forks, sent }
}

async function replied($: Engine): Promise<void> {
  await $.turn.complete({ answer: ANSWER, durationMs: 4000, isAborted: false, turnId: 't1', reason: 'answer' })
}

describe('a session', () => {
  test('looks once the person has been quiet for a while', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000_000 })
    const { forks } = world(on)
    await replied($)
    await clock.advance(IDLE_MS - 1)

    expect(forks).toHaveLength(0)
    await clock.advance(1)
    expect(forks).toHaveLength(1)
  })

  test('a new prompt before then means it does not look', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000_000 })
    const { forks } = world(on)
    await replied($)
    await $.prompt.submit({ text: 'next thing', origin: { kind: 'composer' }, wait: false })
    await clock.advance(IDLE_MS * 2)

    expect(forks).toHaveLength(0)
  })

  test('draws the footnote under the reply on the terminal and the desktop', async ($, on) => {
    mock.clock(on, { now: 10_000_000 })
    world(on)
    await replied($)
    const said = await $.command.run({ command: 'third-eye', args: '', origin: { kind: 'composer' }, presentation })

    expect(said.text).toBe('Another angle: Listen to the worst CZ call of each day')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...REPLY, surface })

      expect(await ui.find({ key: `fold-${'eye-10000000'}` })).toBeDefined()
      expect(await ui.find({ type: 'Markdown', text: /never how they sound\. Listen to the worst CZ call/ })).toBeDefined()
      expect(await ui.find({ key: 'ask-eye-10000000' })).toBeDefined()
      await ui.unmount()
    }

    const other = await $.ui.mount({ ...REPLY, surface: 'terminal', props: { text: 'Some earlier reply about a different topic.', isFirstOfReply: true } })
    expect(await other.find({ key: 'fold-eye-10000000' })).toBeUndefined()
    await other.unmount()
  })

  test('asking sends the prompt; not for me hides it and is remembered', async ($, on) => {
    mock.clock(on, { now: 10_000_000 })
    const store: Record<string, unknown> = {}
    const { sent, forks } = world(on, store)
    await replied($)
    await $.command.run({ command: 'third-eye', args: '', origin: { kind: 'composer' }, presentation })
    const ui = await $.ui.mount({ ...REPLY, surface: 'desktop' })
    await ui.press({ key: 'fold-eye-10000000' })

    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.press({ key: 'fold-eye-10000000' })
    await ui.press({ key: 'nope-eye-10000000' })
    expect(await ui.find({ key: 'fold-eye-10000000' })).toBeUndefined()
    await ui.unmount()

    await $.command.run({ command: 'third-eye', args: '', origin: { kind: 'composer' }, presentation })
    expect(forks.at(-1)).toContain(`"${IDEA.idea}"`)
    const next = await $.ui.mount({ ...REPLY, surface: 'terminal' })
    await next.press({ key: 'ask-eye-10000000' })
    expect(sent).toEqual([IDEA.prompt])
    await next.unmount()
  })

  test('rests when told to', async ($, on) => {
    const clock = mock.clock(on, { now: 10_000_000 })
    const { forks } = world(on)
    const rest = await $.command.run({ command: 'third-eye', args: 'off', origin: { kind: 'composer' }, presentation })
    await replied($)
    await clock.advance(IDLE_MS)

    expect(rest.text).toContain('resting')
    expect(forks).toHaveLength(0)
  })
})
