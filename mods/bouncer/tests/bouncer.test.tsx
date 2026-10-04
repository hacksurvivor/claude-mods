import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MARK, brief, projectsIn, findsIn, idOf, listing, split } from '../hooks/bouncer'
import type { Ruling } from '../types'

const RULING: Ruling = {
  verdict: 'use',
  url: 'https://openai.com/index/introducing-the-agents-api/',
  title: 'Agents API',
  for: ['shop-app', 'Nightshift'],
  effort: 'Half a day',
  cost: 'free tier',
  why: 'A hosted agent loop shop-app could run as one more harness.',
  next: 'Add the Agents API to shop-app as a harness, starting with a spike.',
}
const LINE = `${MARK} ${JSON.stringify(RULING)}`
const ANSWER = `${LINE}\n\nThe Agents API runs the tool loop on OpenAI's side.`

describe('which prompts get a verdict', () => {
  test('a link with a short question, not a task that mentions one', () => {
    expect(findsIn('https://openai.com/index/introducing-the-agents-api/ how can we leverage from it?')).toEqual([
      'https://openai.com/index/introducing-the-agents-api/',
    ])
    expect(findsIn('[https://github.com/trailhq/Graft](https://github.com/trailhq/Graft) do we need it?')).toEqual([
      'https://github.com/trailhq/Graft',
    ])
    expect(findsIn(`fix the login bug on https://example.com/login ${'and more detail '.repeat(40)}`)).toEqual([])
  })

  test('local, mail and chat links are work, not finds', () => {
    expect(findsIn('kill http://127.0.0.1:3000/explore')).toEqual([])
    expect(findsIn('http://localhost:5173 looks off')).toEqual([])
    expect(findsIn('https://mail.google.com/mail/u/0/#inbox/FMfcg')).toEqual([])
    expect(findsIn('https://claude.ai/code/artifact/abc')).toEqual([])
    expect(findsIn('no links here')).toEqual([])
  })

  test('the brief names the link, the projects and the line', () => {
    const said = brief(['https://x.com/a/status/1'], ['shop-app: an online store'])

    expect(said).toContain('https://x.com/a/status/1')
    expect(said).toContain('- shop-app: an online store')
    expect(brief(['https://x.com/a/status/1'], [])).toContain('from this conversation and folder')
    expect(projectsIn('# mine\n- shop-app: a store\n\nblog')).toEqual(['shop-app: a store', 'blog'])
    expect(said).toContain(`${MARK} {"verdict":"use|later|skip"`)
  })
})

describe('the verdict line', () => {
  test('comes out of the answer, which keeps the rest', () => {
    expect(split(ANSWER)).toEqual({ ruling: RULING, text: "The Agents API runs the tool loop on OpenAI's side." })
  })

  test('is hidden while it streams in, before it parses', () => {
    expect(split('[bo')).toEqual({ ruling: undefined, text: '' })
    expect(split(`${MARK} {"verdict":"us`)).toEqual({ ruling: undefined, text: '' })
    expect(split('Plain [link](https://a.b) text')).toEqual({ ruling: undefined, text: 'Plain [link](https://a.b) text' })
  })

  test('a broken line is hidden and draws no card', () => {
    expect(split(`${MARK} {"verdict":"maybe","why":"x"}\nText`)).toEqual({ ruling: undefined, text: 'Text' })
  })

  test('/bouncer lists by verdict, newest first', () => {
    const now = Date.parse('2026-10-03T12:00:00Z')
    const seen = [
      { ...RULING, id: idOf(RULING), at: now - 86_400_000, status: 'started' as const },
      { ...RULING, verdict: 'skip' as const, title: 'Polymarket bot video', for: [], url: 'https://youtu.be/x', id: 'b', at: now, status: 'new' as const },
    ]

    expect(listing(seen, now)).toBe(
      [
        'Use it:',
        '  Agents API · shop-app, Nightshift · yesterday · Started  https://openai.com/index/introducing-the-agents-api/',
        'Skip:',
        '  Polymarket bot video · today  https://youtu.be/x',
      ].join('\n'),
    )
    expect(listing([], now)).toBe('Nothing yet. Paste a link and ask what it is worth.')
  })
})

type Saw = { contexts: (readonly string[] | undefined)[]; submitted: string[] }

function world(on: On): Saw {
  const saw: Saw = { contexts: [], submitted: [] }
  mock.clock(on, { now: Date.parse('2026-10-03T12:00:00Z') })
  mock.store(on)
  // Beneath: the engine, which draws the text it is given.
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })
  on('prompt.submit', ($, e) => {
    if (e.origin?.kind === 'plugin') {
      saw.submitted.push(e.text)
    } else {
      saw.contexts.push(e.context)
    }

    return { text: e.text, context: e.context }
  })

  return saw
}

const message = (text: string) => ({ plugin: 'bouncer', component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as const
const presentation = { isFullscreen: false, columns: 120 }

describe('the card', () => {
  test('a pasted link carries the brief; a plain prompt and /bouncer off do not', async ($, on) => {
    const saw = world(on)

    await $.prompt.submit({ text: 'https://github.com/trailhq/Graft do we need it?', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'fix the rounding bug', wait: false, origin: { kind: 'composer' } })
    await $.command.run({ command: 'bouncer', args: 'off', origin: { kind: 'composer' }, presentation })
    await $.prompt.submit({ text: 'https://github.com/trailhq/Graft do we need it?', wait: false, origin: { kind: 'composer' } })

    expect(saw.contexts[0]?.some(block => block.includes('https://github.com/trailhq/Graft'))).toBe(true)
    expect(saw.contexts[1]).toBeUndefined()
    expect(saw.contexts[2]).toBeUndefined()
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`on the ${surface}, sits above the answer with the line hidden; Start on it sends the next prompt`, async ($, on) => {
      const saw = world(on)
      const ui = await $.ui.mount({ ...message(ANSWER), surface })

      expect(await ui.find({ type: 'Text', text: 'Use it' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '· shop-app' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Half a day · free tier' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: "The Agents API runs the tool loop on OpenAI's side." })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ANSWER })).toBeUndefined()

      await ui.press({ key: `start-${idOf(RULING)}` })
      expect(saw.submitted).toEqual([RULING.next])
      expect(await ui.find({ type: 'Text', text: 'Started' })).toBeDefined()
      expect(await ui.find({ key: `start-${idOf(RULING)}` })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('Later is remembered for /bouncer', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...message(ANSWER), surface: 'desktop' })
    await ui.press({ key: `later-${idOf(RULING)}` })

    expect(await ui.find({ type: 'Text', text: 'Saved for later' })).toBeDefined()
    const listed = await $.command.run({ command: 'bouncer', args: '', origin: { kind: 'composer' }, presentation })
    expect(listed.text).toContain('Agents API · shop-app, Nightshift · today · Saved for later')
    await ui.unmount()
  })

  test('an answer with no verdict line draws as it is', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({ ...message('Just an answer.'), surface: 'desktop' })

    expect(await ui.find({ type: 'Text', text: 'Just an answer.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Use it' })).toBeUndefined()
    await ui.unmount()
  })
})
