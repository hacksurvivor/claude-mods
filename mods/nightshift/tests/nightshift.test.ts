import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, SessionUsage } from 'claude-code'

import { browserConfig, buildPrompt, codexArgv, currentWeek, exhausted, readCodexLimits, readEvent, readModels, weekElapsed, windows } from '../hooks/codex'
import { EFFORT_LABELS, effortsFor, effortWithin, limitTiles, liveLine, logoDots, readReply, shimmerColors } from '../hooks/look'
import { browserStep, hear, imageCard, isLookOnly, readCall, imagesScript, isVoiceReply, liveWave, QUIET, readBridge, readPreview, speakable, splitImages, talkState, voiceArgv, voiceReply } from '../hooks/talk'

declare const setTimeout: (run: (value: unknown) => void, ms: number) => unknown

// Engine tests run real dispatches; give them room on a busy machine.
const SLOW = { timeoutMs: 30000 }

const NOW = Date.parse('2026-10-02T06:00:00Z')
const LATER = '2026-10-05T03:48:00Z'

const CODEX_LIMITS_LINE = JSON.stringify({
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: 22, window_minutes: 10080, resets_at: Date.parse(LATER) / 1000 } } },
})

const CODEX_RUN = [
  '{"type":"thread.started","thread_id":"th-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"I’ll add the test."}}',
  '{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"tests/total.test.ts","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"/bin/zsh -lc \'npm test\'","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Added a test. 42 passed."}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
  '',
].join('\n')

describe('helpers', () => {
  test('a window counts as used up only until it resets', () => {
    expect(exhausted([{ kind: 'seven_day', percentUsed: 100, resetsAt: LATER }], NOW)?.kind).toBe('seven_day')
    expect(exhausted([{ kind: 'seven_day', percentUsed: 100, resetsAt: '2026-10-01T00:00:00Z' }], NOW)).toBeUndefined()
    expect(exhausted([{ kind: 'five_hour', percentUsed: 96 }], NOW)).toBeUndefined()
  })

  test('reads Codex events into reply lines', () => {
    expect(readEvent('{"type":"thread.started","thread_id":"abc"}').threadId).toBe('abc')
    expect(readEvent('not json')).toEqual({})
    expect(
      readEvent('{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc \'cat note.txt\'","exit_code":0}}').show,
    ).toBe('ran `cat note.txt`')
    expect(
      readEvent('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":1}}').show,
    ).toBe('ran `npm test` (exit 1)')
    expect(
      readEvent('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"update"}]}}').files,
    ).toEqual(['a.ts'])
    expect(readEvent('{"type":"turn.failed","error":{"message":"usage limit"}}').error).toBe('usage limit')
  })

  test('briefs Codex once, then sends only what it has not seen', () => {
    const first = buildPrompt({
      isFirst: true,
      cwd: '/work',
      why: "the user's Claude weekly usage limit ran out",
      context: [{ role: 'user', text: 'fix rounding', tools: [] }, { role: 'assistant', text: 'Fixed.', tools: ['Edit'] }],
      text: 'now add a test',
    })

    expect(first).toContain('/work')
    expect(first).toContain('[Assistant] (used: Edit)')
    expect(first).toContain('now add a test')

    const later = buildPrompt({ isFirst: false, cwd: '/work', why: '', context: [], text: 'thanks, commit it' })

    expect(later).not.toContain('taking over')
    expect(later).toContain('thanks, commit it')
  })

  test("reads Codex's own 5-hour and 7-day windows", () => {
    const line = JSON.stringify({
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 9, window_minutes: 300, resets_at: NOW / 1000 + 3600 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_at: NOW / 1000 + 86400 },
        },
      },
    })
    const reset = line.replace(String(NOW / 1000 + 3600), String(NOW / 1000 - 60))

    expect(readCodexLimits(line, NOW)).toEqual({ fiveHour: 9, week: 22, weekResetsAt: NOW + 86400 * 1000 })
    expect(readCodexLimits(reset, NOW)?.fiveHour).toBe(0)
    expect(readCodexLimits('nothing', NOW)).toBeUndefined()
    expect(windows(3, 15)).toBe('5h 3% · 7d 15%')
    expect(windows(undefined, 22)).toBe('7d 22%')
  })

  test('runs codex through a login shell and resumes its thread', () => {
    expect(codexArgv(undefined, 'hi').slice(0, 5)).toEqual(['/bin/zsh', '-lc', 'exec codex "$@"', 'codex', 'exec'])
    expect(codexArgv('th-1', 'hi')).toContain('resume')
    expect(codexArgv('th-1', 'hi').at(-1)).toBe('hi')

    const chosen = codexArgv(undefined, 'hi', { model: 'gpt-6.1-sol', effort: 'high' })

    expect(chosen).toContain('gpt-6.1-sol')
    expect(chosen).toContain('model_reasoning_effort="high"')
  })
})
const VOICE_RUN = [
  '{"t":"state","phase":"connecting"}',
  '{"t":"state","phase":"live"}',
  '{"t":"caption","role":"user","text":"make a hero image","final":true}',
  '{"t":"caption","role":"assistant","text":"On it.","final":true}',
  '{"t":"image","path":"/Users/me/.codex/generated_images/th-v/exec-1.png"}',
  '{"t":"exchange","you":"make a hero image","codex":"On it. Here it is.","images":["/Users/me/.codex/generated_images/th-v/exec-1.png"]}',
  '{"t":"state","phase":"ended"}',
  '',
].join('\n')

type World = {
  claude: number
  spawned: string[][]
  notices: string[]
  statuses: (string | undefined)[]
  limitsLine: string
  setNow: (at: number) => Promise<void>
  images: string[]
  submitted: string[]
  voiceRun: string
  spoke: string[]
  browserCalls: string[]
  awaitsBrowser: boolean
  results: string[]
  panes: string[]
}

function world(on: On, percentUsed: number): World {
  const seen: World = { claude: 0, spawned: [], notices: [], statuses: [], limitsLine: CODEX_LIMITS_LINE, setNow: async () => {}, images: [], submitted: [], voiceRun: VOICE_RUN, spoke: [], browserCalls: [], awaitsBrowser: false, results: [], panes: [] }
  const usage: SessionUsage = {
    startedAt: NOW,
    context: { window: 200000 },
    rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: LATER }],
  }
  const rows: SessionMessage[] = [
    { role: 'user', text: 'fix the checkout total rounding', toolUses: [] },
    { role: 'assistant', text: 'Fixed the rounding.', toolUses: [] },
    { role: 'user', text: 'now add a test for it', toolUses: [] },
  ]

  const clock = mock.clock(on, { now: NOW })

  seen.setNow = async at => {
    await clock.set(at)
  }
  mock.store(on)
  on('session.usage', () => ({ value: usage }))
  on('session.messages', () => ({ value: rows }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.toast', ($, e) => {
    seen.notices.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('process.spawn', async function* ($, e) {
    seen.spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: e.argv.some(arg => arg.endsWith('voice.mjs')) ? seen.voiceRun : CODEX_RUN }

    return { value: { code: 0, signal: null } }
  })
  on('process.run', async ($, e) => {
    const script = e.argv.join(' ')

    // A Codex run with browser steps ends once Nightshift has answered them.
    if (script.includes('exec codex') && script.includes('claude_browser') && seen.awaitsBrowser) {
      for (let tries = 0; tries < 200 && seen.results.length === 0; tries++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    const stdout = script.includes('sips')
      ? `1254 1254\n${'A'.repeat(400)}`
      : script.includes('generated_images')
        ? seen.images.join('\n')
        : script.includes('exec codex')
          ? CODEX_RUN
          : seen.limitsLine

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async ($, e) => {
    if (e.url.endsWith('/next')) {
      const call = seen.browserCalls.shift()

      // The real bridge holds a poll until a step comes; this one pauses a little.
      if (call === undefined) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }

      return { value: { status: call === undefined ? 204 : 200, ok: true, headers: {}, text: call ?? '' } }
    }

    if (e.url.endsWith('/result')) {
      seen.results.push(String(e.init?.body ?? ''))
    } else {
      seen.spoke.push(`${e.url} ${e.init?.body ?? ''}`)
    }

    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('mcp.call', ($, e) => {
    seen.panes.push(`${e.server} ${e.tool}`)

    return { value: { content: [{ type: 'text', text: 'Product Hunt' }], isError: false } }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)

    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    seen.claude += 1

    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  return seen
}

async function ask($: Engine, turnId: string, text: string): Promise<string> {
  await $.turn.start({ text, turnId })

  const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })
  let shown = ''

  for await (const chunk of stream) {
    if (chunk.kind === 'text') {
      shown += chunk.text
    }
  }

  return shown
}

describe('the handoff', () => {
  test('Claude answers while the limit lasts, and the status warns near it', SLOW, async ($, on) => {
    const seen = world(on, 96)

    expect(await ask($, 't1', 'now add a test for it')).toBe('')
    expect(seen.claude).toBe(1)
    expect(seen.spawned).toEqual([])
    expect(seen.statuses).toEqual([])
  })

  test('Codex answers in the same chat once the limit is used up', SLOW, async ($, on) => {
    const seen = world(on, 100)
    const reply = await ask($, 't1', 'now add a test for it')

    expect(seen.claude).toBe(0)
    expect(reply).toContain('**Codex**')
    expect(reply).toContain('- added `tests/total.test.ts`')
    expect(reply).toContain('- ran `npm test`')
    expect(reply).toContain('Added a test. 42 passed.')
    expect(seen.notices[0]).toContain("Claude's weekly limit is used up")
    expect(seen.spawned[0]?.at(-1)).toContain('fix the checkout total rounding')
    expect(seen.statuses.at(-1)).toBeUndefined()
  })

  test('the next message resumes the same Codex thread', SLOW, async ($, on) => {
    const seen = world(on, 100)

    await ask($, 't1', 'now add a test for it')
    await ask($, 't2', 'now add a test for it')

    expect(seen.spawned[1]).toContain('resume')
    expect(seen.spawned[1]).toContain('th-1')
    expect(seen.notices).toHaveLength(1)
  })
})

describe('the Codex look', () => {
  test('splits a reply into steps and words', () => {
    const reply = readReply('**Codex**\n\nI’ll add the test.\n\n\n- added `tests/total.test.ts`\n- ran `npm test` (exit 1)\n\nDone.\n\n')

    expect(reply.steps.map(step => step.text)).toEqual(['Added tests/total.test.ts', 'Ran npm test'])
    expect(reply.steps[1]?.isFailed).toBe(true)
    expect(reply.words).toContain('Done.')
    expect(liveLine('ran `npm test`')).toBe('Running npm test')
  })

  test('draws a Codex reply with the CLI header and its steps on the desktop', SLOW, async ($, on) => {
    world(on, 100)

    const ui = await $.ui.mount({
      plugin: 'nightshift',
      surface: 'desktop',
      component: 'AssistantMessage',
      props: { text: '**Codex**\n\n- ran `npm test`\n\nAll good.', isFirstOfReply: true },
    })

    expect(await ui.find({ type: 'Text', text: '>_' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Codex' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ran npm test/ })).toBeDefined()
    await ui.unmount()
  })

  test('leaves Claude replies alone', SLOW, async ($, on) => {
    let isPassedOn = false

    world(on, 10)
    on('ui.render', ($, e) => {
      isPassedOn = true

      return $.ui.resolve(e).Text({ children: 'drawn by the app' })
    })

    const ui = await $.ui.mount({
      plugin: 'nightshift',
      surface: 'desktop',
      component: 'AssistantMessage',
      props: { text: 'A normal Claude reply.', isFirstOfReply: true },
    })

    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(isPassedOn).toBe(true)
    await ui.unmount()
  })
})

describe('the Codex CLI art', () => {
  test('draws the still Codex mark as a dot matrix', () => {
    const logo = logoDots(26)

    expect(logo.source).toContain('<circle')
    expect(logo.width).toBeGreaterThan(26)
  })

  test('sweeps the working line like the CLI: half ink at rest, full ink under the band', () => {
    const rest = shimmerColors('Running npm test', 0)
    const mid = shimmerColors('Running npm test', 600 + 500)

    const red = (color: string) => parseInt(color.slice(1, 3), 16)

    expect(new Set(rest).size).toBe(1)
    expect(red(rest[0] ?? '#000000')).toBeLessThan(0x90)
    expect(Math.max(...mid.map(red))).toBeGreaterThan(0xe0)
  })
})

describe('the Codex strip', () => {
  test("shows its controls before Codex's limit is known", SLOW, async ($, on) => {
    world(on, 15)

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    expect(await ui.find({ key: 'effort', type: 'Select' })).toBeDefined()
    expect(await ui.find({ key: 'tools', type: 'Select' })).toBeDefined()
    expect(await ui.find({ key: 'talk', type: 'Button' })).toBeDefined()
    expect(await ui.find({ key: 'limit' })).toBeUndefined()
    await ui.unmount()
  })

  test("shows Codex's 7-day limit as a week of tiles", SLOW, async ($, on) => {
    world(on, 15)
    await ask($, 't1', 'add a footer')

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    let meter = ''

    for (let tries = 0; tries < 20 && meter === ''; tries++) {
      const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })
      const found = await ui.find({ key: 'limit' })

      meter = found === undefined ? '' : JSON.stringify(found)
      await ui.unmount()
    }

    expect(meter).toContain('Codex 7-day limit: 78% left')
    expect(meter).toContain('<rect')
  })
})

describe('the strip over time', () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }

  async function strip($: Engine, query: Record<string, unknown>): Promise<string> {
    for (let tries = 0; tries < 20; tries++) {
      const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })
      const found = await ui.find(query)

      await ui.unmount()

      if (found !== undefined) {
        return JSON.stringify(found)
      }
    }

    return ''
  }

  test("drops 'Claude back' once Claude's limit has reset", SLOW, async ($, on) => {
    const seen = world(on, 100)

    await ask($, 't1', 'add a footer')
    expect(await strip($, { type: 'Text', text: /Claude back/ })).not.toBe('')

    await seen.setNow(Date.parse(LATER) + 3600 * 1000)
    expect(await strip($, { type: 'Text', text: /Claude back/ })).toBe('')
  })

  test("shows Codex's week at zero once it reset while idle", SLOW, async ($, on) => {
    const seen = world(on, 15)

    await ask($, 't1', 'add a footer')
    expect(await strip($, { key: 'limit' })).toContain('78% left')

    await seen.setNow(Date.parse(LATER) + 3600 * 1000)
    expect(await strip($, { key: 'limit' })).toContain('100% left')
  })

  test("reads Codex's limit again right after a Codex turn", SLOW, async ($, on) => {
    const seen = world(on, 100)

    seen.limitsLine = CODEX_LIMITS_LINE
    await $.turn.start({ text: 'add a footer', turnId: 't1' })
    seen.limitsLine = CODEX_LIMITS_LINE.replace('"used_percent":22', '"used_percent":30')

    for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 3 })) {
      void chunk
    }

    let meter = ''

    for (let tries = 0; tries < 20 && !meter.includes('70% left'); tries++) {
      meter = await strip($, { key: 'limit' })
    }

    expect(meter).toContain('70% left')
  })
})

describe('the 7-day limit tiles', () => {
  test('lights what is left, like a battery: full at 0% used, empty when spent', () => {
    const lit = (percent: number) => (limitTiles({ percent }).source.match(/<rect [^>]*fill="(#d4d4ce|#d9b779|#e36d5d)"/g) ?? []).length

    expect(lit(100)).toBe(0)
    expect(lit(22)).toBeGreaterThan(lit(60))
    expect(lit(0)).toBe(limitTiles({ percent: 0 }).source.match(/<rect /g)?.length)
    expect(lit(99)).toBe(1)
    expect(limitTiles({ percent: 22 }).source).toContain('>78%<')
  })

  test('warms to honey from 75% and turns red from 90%', () => {
    const tiles = (percent: number, color: string) => (limitTiles({ percent }).source.match(new RegExp(`<rect [^>]*fill="${color}"`, 'g')) ?? []).length

    expect(tiles(60, '#d4d4ce')).toBeGreaterThan(0)
    expect(tiles(80, '#d9b779')).toBeGreaterThan(0)
    expect(tiles(80, '#e36d5d')).toBe(0)
    expect(tiles(95, '#e36d5d')).toBeGreaterThan(0)
    expect(tiles(95, '#d4d4ce') + tiles(95, '#d9b779')).toBe(0)
  })

  test('keeps the end-of-week tick on the canvas and 100% clear of the reset time', () => {
    const start = limitTiles({ percent: 0, elapsed: 1, reset: 'Wed 22:59' }).source
    const tick = Number(/<rect x="(-?[\d.]+)"[^>]*fill="#74736d"/.exec(start)?.[1])
    const first = Number(/<rect x="(-?[\d.]+)"/.exec(start)?.[1])

    expect(tick).toBeGreaterThanOrEqual(0)
    expect(first - (tick + 1)).toBeGreaterThanOrEqual(1)

    const full = limitTiles({ percent: 0, reset: 'Wed 22:59' })
    const percentX = Number(/<text x="([\d.]+)"[^>]*>100%</.exec(full.source)?.[1])

    // "100%" is 37px wide and "Wed 22:59" 58px at these sizes (measured).
    expect(full.width - 58 - (percentX + 37)).toBeGreaterThanOrEqual(8)
  })

  test('marks now in the week and shows the reset time when there is room', () => {
    expect(limitTiles({ percent: 22, elapsed: 0.3 }).source).toContain('fill="#74736d"')
    expect(limitTiles({ percent: 22 }).source).not.toContain('fill="#74736d"')
    expect(limitTiles({ percent: 22, reset: 'Mon 10:48' }).source).toContain('Mon 10:48')
    expect(limitTiles({ percent: 22, reset: 'Mon 10:48', width: 240 }).source).not.toContain('Mon 10:48')
  })

  test('knows how far into the week Codex is from when it resets', () => {
    const day = 86400 * 1000

    expect(weekElapsed(NOW + 7 * day, NOW)).toBe(0)
    expect(weekElapsed(NOW + 3.5 * day, NOW)).toBe(0.5)
    expect(weekElapsed(undefined, NOW)).toBeUndefined()
  })

  test('starts a week that reset while idle at zero, a week on', () => {
    const resetsAt = NOW + 3600 * 1000

    expect(currentWeek({ week: 64, weekResetsAt: resetsAt }, NOW)).toEqual({ week: 64, weekResetsAt: resetsAt })
    expect(currentWeek({ week: 64, weekResetsAt: resetsAt }, resetsAt + 1)).toEqual({ week: 0, weekResetsAt: resetsAt + 7 * 86400 * 1000 })
    expect(currentWeek(undefined, NOW)).toEqual({ week: undefined, weekResetsAt: undefined })
  })

  test('reads windows logged a minute off their length, and a missing reset time', () => {
    const odd = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 30, window_minutes: 10081, resets_at: null } } } })

    expect(readCodexLimits(odd, NOW)).toEqual({ week: 30 })
    expect(readCodexLimits(JSON.stringify({ payload: { rate_limits: null } }), NOW)).toBeUndefined()
  })

  test('rolls a window that already reset forward to the next one', () => {
    const past = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 40, window_minutes: 10080, resets_at: NOW / 1000 - 3600 } } } })
    const read = readCodexLimits(past, NOW)

    expect(read?.week).toBe(0)
    expect(read?.weekResetsAt).toBe(NOW - 3600 * 1000 + 7 * 86400 * 1000)
  })
})

describe('Codex effort levels', () => {
  test('offers Light through Max, limited to what the model takes', () => {
    expect(effortsFor(undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortsFor(['low', 'medium', 'high', 'xhigh'])).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(EFFORT_LABELS.low).toBe('Light')
  })

  test('runs a level the model lacks at the closest one below it', () => {
    expect(effortWithin('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh')
    expect(effortWithin('high', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('high')
  })

  test("reads each model's levels from Codex's cache", () => {
    const cache = JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }] },
        { slug: 'hidden', visibility: 'hide' },
      ],
    })

    expect(readModels(cache)).toEqual([{ slug: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'xhigh'] }])
  })
})

describe('the Codex strip dropdowns', () => {
  test('picking XHigh in the effort dropdown sets Codex to xhigh', SLOW, async ($, on) => {
    world(on, 15)
    await ask($, 't1', 'add a footer')

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    expect((await ui.find({ key: 'effort', type: 'Select' }))?.props.value).toBe('medium')
    await ui.select({ key: 'effort', value: 'xhigh' })
    await ui.unmount()

    const after = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    expect((await after.find({ key: 'effort', type: 'Select' }))?.props.value).toBe('xhigh')
    await after.unmount()
  })

  test('the Tools dropdown hands browser work to Codex', SLOW, async ($, on) => {
    world(on, 15)
    on('tool.call', () => ({ result: 'ran' }))
    await ask($, 't1', 'hello')

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    expect((await ui.find({ key: 'tools', type: 'Select' }))?.props.value).toBe('claude')
    await ui.select({ key: 'tools', value: 'codex' })
    await ui.unmount()

    const browser = (await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)) as { deny?: string }

    expect(browser.deny).toContain('mcp__nightshift__codex')
  })
})

describe('Codex voice and images', () => {
  test('reads the voice bridge and keeps the strip in step with it', () => {
    const live = hear(QUIET, { t: 'state', phase: 'live' })
    const heard = hear(live, { t: 'caption', role: 'user', text: 'make it', final: false })

    expect(readBridge('{"t":"work","text":"Running pwd"}')).toEqual({ t: 'work', text: 'Running pwd' })
    expect(readBridge('not json')).toBeUndefined()
    expect(heard).toMatchObject({ phase: 'live', you: 'make it' })
    expect(hear(heard, { t: 'state', phase: 'ended' })).toEqual(QUIET)
  })

  test('keeps a spoken exchange as a Codex voice reply with its images', () => {
    const reply = voiceReply('Here it is.', ['/Users/me/a.png'])

    expect(isVoiceReply(reply)).toBe(true)
    expect(splitImages(readReply(reply.replace(' (voice)', '')).words)).toEqual({ words: 'Here it is.', images: ['/Users/me/a.png'] })
  })

  test('draws an image card that fits a mod SVG', () => {
    const preview = readPreview(`1536 1024\n${'A'.repeat(110000)}`)
    const card = preview === undefined ? undefined : imageCard(preview)

    expect(preview).toMatchObject({ width: 1536, height: 1024 })
    expect(card?.width).toBe(396)
    expect(card?.height).toBe(264)
    expect(card?.source.length).toBeLessThan(131072)
    expect(readPreview('nothing')).toBeUndefined()
  })

  test('finds the images of one Codex thread and attaches images to an edit', () => {
    expect(imagesScript('th/../x', 100).slice(-2)).toEqual(['th____x', '100'])
    expect(codexArgv(undefined, 'edit it', { images: ['/a.png'] }).slice(-2)).toEqual(['--image=/a.png', 'edit it'])
  })

  test('Talk starts Codex voice, and a spoken exchange lands in the chat without a model', SLOW, async ($, on) => {
    const seen = world(on, 15)
    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    await ui.press({ key: 'talk' })

    for (let tries = 0; tries < 50 && seen.submitted.length === 0; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    await ui.unmount()
    expect(seen.spawned.some(argv => argv.some(arg => arg.endsWith('/hooks/voice.mjs')))).toBe(true)
    expect(seen.submitted).toEqual(['make a hero image'])

    const shown = await ask($, 'tv', 'make a hero image')

    expect(shown).toContain('**Codex** (voice)')
    expect(shown).toContain('![image](/Users/me/.codex/generated_images/th-v/exec-1.png)')
    expect(seen.claude).toBe(0)
  })

  test('drops the images a Codex turn made into its reply', SLOW, async ($, on) => {
    const seen = world(on, 100)

    seen.images = ['/Users/me/.codex/generated_images/th-1/exec-9.png']

    expect(await ask($, 't1', 'draw a fox')).toContain('![image](/Users/me/.codex/generated_images/th-1/exec-9.png)')
  })

  test('/codex answers one message with Codex while Claude has its limit', SLOW, async ($, on) => {
    const seen = world(on, 15)

    await ask($, 't0', 'hello')
    await $.command.run({ command: 'codex', args: '$imagegen a fox' } as never)
    await seen.setNow(NOW + 1000)

    for (let tries = 0; tries < 50 && seen.submitted.length === 0; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(seen.submitted).toEqual(['$imagegen a fox'])

    const shown = await ask($, 't1', '$imagegen a fox')

    expect(shown).toContain('**Codex**')
    expect(seen.claude).toBe(1)

    await ask($, 't2', 'thanks')
    expect(seen.claude).toBe(2)
  })

  test("Claude's codex tool returns Codex's reply and shows the image to the model", SLOW, async ($, on) => {
    const seen = world(on, 15)

    seen.images = ['/Users/me/.codex/generated_images/th-1/exec-9.png']
    await ask($, 't0', 'hello')

    const called = (await $.tool.call({ tool: 'mcp__nightshift__codex', tool_use_id: 'tu-1', prompt: '$imagegen a fox' } as never)) as {
      result?: { type: string; text?: string; mimeType?: string }[]
    }
    const content = called.result ?? []

    expect(content[0]?.text).toContain('Added a test. 42 passed.')
    expect(content[0]?.text).toContain('/Users/me/.codex/generated_images/th-1/exec-9.png')
    expect(content.some(block => block.type === 'image' && block.mimeType === 'image/jpeg')).toBe(true)
  })
})

describe('who does the work you ask for out loud', () => {
  test('keeps the strip short and Claude\'s answer sayable', () => {
    expect(talkState({ ...QUIET, phase: 'live', work: 'Running a very long command line here' })).toBe('Running a very long c…')
    expect(talkState({ ...QUIET, phase: 'ending' })).toBe('Ending')
    expect(liveWave(false).isInteractive).toBe(true)
    expect(liveWave(false).source).toContain('<animate')
    expect(liveWave(false).source).toContain('color-scheme:light dark')
    expect(liveWave(true).isInteractive).toBe(false)
    expect(liveWave(true).source).not.toContain('<animate')
    expect(speakable('## Done\n\nFixed **two** bugs in `cart.ts`.\n\n```ts\nx()\n```')).toBe('Done Fixed two bugs in cart.ts. (code)')
    expect(voiceArgv('/p', '/w', '/s.sock', 'claude', '/b.sock', { model: 'gpt', effort: 'low' }).slice(-6)).toEqual([
      '/w',
      '/s.sock',
      'claude',
      '/b.sock',
      'gpt',
      'low',
    ])
    expect(voiceArgv('/p', '/w', '/s.sock', 'codex', '/b.sock').slice(-2)).toEqual(['-', '-'])
  })

  test('work passed to Claude by voice lands in the chat and runs on Claude, not Codex', SLOW, async ($, on) => {
    const seen = world(on, 15)

    seen.voiceRun = [
      '{"t":"state","phase":"live"}',
      '{"t":"claude","task":"Fix the checkout rounding bug","you":"pass this to Claude"}',
      '',
    ].join('\n')

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    await ui.press({ key: 'talk' })

    for (let tries = 0; tries < 50 && seen.submitted.length === 0; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(seen.submitted).toEqual(['Fix the checkout rounding bug'])
    await ui.unmount()

    const before = seen.spawned.length

    await ask($, 'tc', 'Fix the checkout rounding bug')
    expect(seen.claude).toBe(1)
    expect(seen.spawned.length).toBe(before)
  })
})

describe('Tools set to Codex', () => {
  test("turns Claude's browser and Mac-app tools back to Codex, and leaves the rest alone", SLOW, async ($, on) => {
    world(on, 15)
    on('tool.call', () => ({ result: 'ran' }))
    await ask($, 't0', 'hello')

    const before = (await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)) as { deny?: string }

    expect(before.deny).toBeUndefined()

    await $.command.run({ command: 'nightshift', args: 'tools codex' } as never)

    const browser = (await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)) as { deny?: string }
    const mac = (await $.tool.call({ tool: 'mcp__computer-use__app_click', x: 1 } as never)) as { deny?: string }

    expect(browser.deny).toContain('mcp__nightshift__codex')
    expect(mac.deny).toContain('@computer-use')

    await $.command.run({ command: 'nightshift', args: 'tools claude' } as never)

    const after = (await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://example.com' } as never)) as { deny?: string }

    expect(after.deny).toBeUndefined()
  })
})

describe("Codex in Claude's browser pane", () => {
  const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
  const NAVIGATE = JSON.stringify({ id: 1, tool: 'navigate', args: { url: 'https://www.producthunt.com/' } })

  test('says each step plainly and lets looking through', () => {
    expect(browserStep({ id: 1, tool: 'navigate', args: { url: 'https://www.producthunt.com/' } })).toBe('Open producthunt.com')
    expect(browserStep({ id: 2, tool: 'computer', args: { action: 'left_click', action_summary: 'Opens the Gauth page' } })).toBe('Opens the Gauth page')
    expect(browserStep({ id: 3, tool: 'computer', args: { action: 'type', text: 'hello' } })).toBe('Type “hello”')
    expect(isLookOnly({ id: 4, tool: 'get_page_text', args: {} })).toBe(true)
    expect(isLookOnly({ id: 5, tool: 'computer', args: { action: 'left_click' } })).toBe(false)
    expect(readCall(NAVIGATE)?.tool).toBe('navigate')
    expect(readCall('nope')).toBeUndefined()
    expect(browserConfig('/p', '/s.sock')).toContain('mcp_servers.claude_browser.args=["/p/hooks/browser-mcp.mjs","/s.sock"]')
  })

  async function press($: Engine, key: string): Promise<boolean> {
    for (let tries = 0; tries < 100; tries++) {
      const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

      if ((await ui.find({ key, type: 'Button' })) !== undefined) {
        await ui.press({ key })
        await ui.unmount()

        return true
      }

      await ui.unmount()
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    return false
  }

  test('asks above the strip before Codex opens a page, and runs it in the pane on Allow', SLOW, async ($, on) => {
    const seen = world(on, 15)

    await ask($, 't0', 'hello')
    seen.browserCalls.push(NAVIGATE)

    seen.awaitsBrowser = true

    const running = $.tool.call({ tool: 'mcp__nightshift__codex', tool_use_id: 'tu-b', prompt: 'check producthunt' } as never)

    expect(await press($, 'ask-allow')).toBe(true)
    await running
    expect(seen.panes).toEqual(['Claude_Browser navigate'])
    expect(seen.results[0]).toContain('Product Hunt')
  })

  test('Deny keeps the step out of the pane and tells Codex', SLOW, async ($, on) => {
    const seen = world(on, 15)

    await ask($, 't0', 'hello')
    seen.browserCalls.push(NAVIGATE)
    seen.awaitsBrowser = true

    const running = $.tool.call({ tool: 'mcp__nightshift__codex', tool_use_id: 'tu-d', prompt: 'check producthunt' } as never)

    expect(await press($, 'ask-deny')).toBe(true)
    await running
    expect(seen.panes).toEqual([])
    expect(seen.results[0]).toContain('declined')
  })

  test('Tools: Codex, auto runs browser steps without asking', SLOW, async ($, on) => {
    const seen = world(on, 15)

    await ask($, 't0', 'hello')
    await $.command.run({ command: 'nightshift', args: 'tools auto' } as never)
    seen.browserCalls.push(NAVIGATE)
    seen.awaitsBrowser = true
    await $.tool.call({ tool: 'mcp__nightshift__codex', tool_use_id: 'tu-a', prompt: 'check producthunt' } as never)

    expect(seen.panes).toEqual(['Claude_Browser navigate'])
  })
})

describe('a live call stays light', () => {
  test('words of the call do not redraw the chat; only what the strip shows does', SLOW, async ($, on) => {
    const seen = world(on, 15)
    let redraws = 0

    on('ui.invalidate', () => {
      redraws += 1

      return { value: undefined }
    })

    seen.voiceRun = [
      '{"t":"state","phase":"connecting"}',
      '{"t":"state","phase":"live"}',
      ...Array.from({ length: 40 }, (_, at) => JSON.stringify({ t: 'caption', role: at % 2 ? 'assistant' : 'user', text: 'word '.repeat(at + 1), final: false })),
      '{"t":"work","text":"Running pwd"}',
      '{"t":"work","text":""}',
      '',
    ].join('\n')

    const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
    const ui = await $.ui.mount({ plugin: 'nightshift', surface: 'desktop', component: 'AbovePrompt', props: BAND })

    await ui.press({ key: 'talk' })

    for (let tries = 0; tries < 50 && redraws < 3; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    await new Promise(resolve => setTimeout(resolve, 100))
    await ui.unmount()

    // connecting, live, Running pwd, Listening again, the end: not 40 more.
    expect(redraws).toBeGreaterThan(0)
    expect(redraws).toBeLessThan(10)
  })
})
