import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Flag } from '../types'
import { MARKETS_FILE, anchorOf, brief, isUnder, marketsFor, mismatch, periodAsked, wallClock } from './time'
import type { Market, Period } from './time'

// Every prompt carries the person's local date, time and weekday, the week
// ranges worked out once, and the local times of the markets a folder's work
// depends on, from ~/.claude/clock/markets.json. A reply
// to a prompt about a period (last week, yesterday, this month) whose dates all
// miss that period gets a line under it saying so.

const FLAGS_KEPT = 20

const flags = atom({ plugin: 'clock', key: 'flags' } as const, [] as Flag[])

// The period the prompt now running asked about, if any.
let asked: Period | undefined

// The markets for this session's folder; none without the file.
async function markets($: EngineInterface): Promise<Market[]> {
  try {
    const text = await $.fs.read(`${(await $.env.get('HOME')) ?? ''}/${MARKETS_FILE}`)

    return marketsFor(JSON.parse(text) as unknown, await $.session.cwd())
  } catch {
    return []
  }
}

const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') {
      return next(e)
    }

    asked = periodAsked(e.text) ?? (e.turnId === undefined ? undefined : asked)
    const said = brief(await $.clock.now(), zone(), await markets($))

    return next({ ...e, context: [...(e.context ?? []), said] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const period = asked

    if (e.agentId !== undefined || e.reason !== 'answer' || period === undefined) {
      return done
    }

    asked = undefined
    const today = wallClock(await $.clock.now(), zone()).day
    const text = mismatch(period, e.answer, today)

    if (text !== undefined) {
      await update($, flags, list => [...list, { anchor: anchorOf(e.answer), text }].slice(-FLAGS_KEPT))
    }

    return done
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const mine = (await read($, flags)).filter(flag => isUnder(flag.anchor, e.props.text))

    if (mine.length === 0) {
      return next(e)
    }

    const drawn = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {drawn}
        {mine.map((flag, at) => (
          <Box key={`clock-${at}`} marginTop={1} marginLeft={2}>
            <Text color="warning">{flag.text}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
