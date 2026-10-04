import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { brief, datesIn, marketsFor, mismatch, periodAsked, rangeOf, showRange, wallClock } from '../hooks/time'
import type { Day } from '../hooks/time'

// Sunday 4 October 2026, 14:05 in Jakarta.
const NOW = Date.parse('2026-10-04T07:05:00Z')
const JAKARTA = 'Asia/Jakarta'
const SUNDAY: Day = { y: 2026, m: 10, d: 4 }
const WEDNESDAY: Day = { y: 2026, m: 9, d: 30 }

describe('the ranges', () => {
  test('on a weekend, last week is the work week that just ended', () => {
    expect(showRange(rangeOf('lastWeek', SUNDAY))).toBe('Sep 28 – Oct 2')
    expect(showRange(rangeOf('thisWeek', SUNDAY))).toBe('Sep 28 – Oct 4')
  })

  test('on a weekday, last week is the work days of the week before', () => {
    expect(showRange(rangeOf('lastWeek', WEDNESDAY))).toBe('Sep 21–25')
    expect(showRange(rangeOf('yesterday', WEDNESDAY))).toBe('Sep 29')
    expect(showRange(rangeOf('lastMonth', SUNDAY))).toBe('Sep 1–30')
    expect(showRange(rangeOf('thisMonth', SUNDAY))).toBe('Oct 1–31')
  })

  test('reads the wall clock in a zone', () => {
    expect(wallClock(NOW, JAKARTA)).toEqual({ day: SUNDAY, hh: 14, mm: 5, offset: 420 })
    expect(wallClock(NOW, 'America/Mexico_City').hh).toBe(1)
  })
})

describe('the brief', () => {
  test('names today, the weeks and, for a folder with markets, their times', () => {
    const config = [{ folder: '/shop', markets: [{ label: 'US', place: 'New York', zone: 'America/New_York' }, { label: 'Mexico', place: 'Mexico City', zone: 'America/Mexico_City' }, { label: 'Czechia', place: 'Prague', zone: 'Europe/Prague' }] }]
    expect(marketsFor(config, '/work/shop/api')).toHaveLength(3)
    expect(marketsFor(config, '/work/blog')).toEqual([])
    expect(marketsFor('nonsense', '/work/shop')).toEqual([])
    const said = brief(NOW, JAKARTA, marketsFor(config, '/work/shop'))

    expect(said).toContain('- Now: Sunday, 4 October 2026, 14:05 (UTC+07:00)')
    expect(said).toContain('"Last week", as the person means it on a weekend: Mon Sep 28 – Oct 2 (Fri), 2026')
    expect(said).toContain('US (New York) Sun Oct 4 03:05 · Mexico (Mexico City) Sun Oct 4 01:05 · Czechia (Prague) Sun Oct 4 09:05')
    expect(said).toContain('Keep city and timezone names out of titles')
    expect(brief(NOW, JAKARTA, [])).not.toContain('Markets now')
  })
})

describe('the date check', () => {
  test('knows which period a prompt asks about, in English and Russian', () => {
    expect(periodAsked('make the weekly report for alexander, last week')).toBe('lastWeek')
    expect(periodAsked('Сделай отчёт за прошлую неделю')).toBe('lastWeek')
    expect(periodAsked('how many calls yesterday?')).toBe('yesterday')
    expect(periodAsked('fix the button')).toBeUndefined()
  })

  test('reads the dates a reply names', () => {
    const days = (text: string) => datesIn(text, SUNDAY).map(day => `${day.m}/${day.d}`)

    expect(days('Weekly report, 10–14 August')).toEqual(['8/10', '8/14'])
    expect(days('From Sep 28 – Oct 2 we made 1,200 calls')).toEqual(['9/28', '10/2'])
    expect(days('Отчёт за 28 сентября – 2 октября')).toEqual(['9/28', '10/2'])
    expect(days('Deadline 2026-10-09, see 03.10.2026')).toEqual(['10/9', '10/3'])
    expect(days('Звонки 14 августа и 3 сентября')).toEqual(['8/14', '9/3'])
    expect(days('5 market calls, may 2 be later')).toEqual(['5/2'])
    expect(days('No dates here, 3 calls and 14 leads')).toEqual([])
  })

  test('flags a reply whose dates all miss the period, and only then', () => {
    expect(mismatch('lastWeek', 'Weekly report, 10–14 August…', SUNDAY)).toBe('Last week was Sep 28 – Oct 2. This reply says Aug 10–14')
    expect(mismatch('lastWeek', 'Weekly report, Sep 28 – Oct 2', SUNDAY)).toBeUndefined()
    expect(mismatch('lastWeek', 'Report for Sep 29 to Oct 3, next one due Oct 12', SUNDAY)).toBeUndefined()
    expect(mismatch('lastWeek', 'No dates in this one.', SUNDAY)).toBeUndefined()
    expect(mismatch('yesterday', 'Calls on Oct 1: 40', SUNDAY)).toBe('Yesterday was Oct 3. This reply says Oct 1')
  })
})

const presentation = { isFullscreen: false, columns: 120 }
void presentation

function world(on: On, cwd: string): { contexts: (readonly string[] | undefined)[] } {
  const seen = { contexts: [] as (readonly string[] | undefined)[] }
  mock.clock(on, { now: NOW })
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => ({ value: JSON.stringify([{ folder: '/shop', markets: [{ label: 'US', place: 'New York', zone: 'America/New_York' }] }]) }))
  on('prompt.submit', ($, e) => {
    seen.contexts.push(e.context)

    return { text: e.text, context: e.context }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.text}</Text>
  })

  return seen
}

const REPLY = 'Weekly report, 10–14 August. We made 1,200 calls and found 31 leads across both markets.'

describe('in a session', () => {
  test('each prompt carries the brief, with the markets of its folder', async ($, on) => {
    const seen = world(on, '/work/shop')
    await $.prompt.submit({ text: 'how are the calls?', wait: false, origin: { kind: 'composer' } })

    expect(seen.contexts[0]?.some(block => block.includes('Markets now'))).toBe(true)
  })

  test('a report with the wrong week gets the line under it, on both surfaces', async ($, on) => {
    world(on, '/work/blog')
    await $.prompt.submit({ text: 'make the weekly report, last week', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ agentId: undefined, reason: 'answer', answer: REPLY, turnId: 't1' } as never)

    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'clock', component: 'AssistantMessage', surface, props: { text: REPLY, isFirstOfReply: true } })

      expect(await ui.find({ type: 'Text', text: 'Last week was Sep 28 – Oct 2. This reply says Aug 10–14' })).toBeDefined()
      await ui.unmount()
    }
  })
})
