import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ruling, Seen } from '../types'
import { MARK, PROJECTS_FILE, STATUS_LABEL, VERDICT_COLOR, VERDICT_LABEL, brief, findsIn, idOf, listing, meta, projectsIn, split } from './bouncer'

// Paste a link with a short question, and Claude's answer opens with a card:
// use it, later or skip, which of the person's projects it serves, the effort
// and one line why. The prompt carries a hidden brief asking for a verdict
// line; the card is drawn from that line and the line is hidden. /bouncer lists
// every link judged so far.

const SEEN_KEY = 'seen'
const SEEN_KEPT = 200

const isPaused = atom({ plugin: 'bouncer', key: 'isPaused' } as const, false)
const choices = atom({ plugin: 'bouncer', key: 'choices' } as const, {} as Record<string, Seen['status']>)

// The person's projects, from ~/.claude/bouncer/projects.md when it exists.
async function projects($: EngineInterface): Promise<string[]> {
  try {
    return projectsIn(await $.fs.read(`${(await $.env.get('HOME')) ?? ''}/${PROJECTS_FILE}`))
  } catch {
    return []
  }
}

async function allSeen($: EngineInterface): Promise<Seen[]> {
  const kept = await $.store.get(SEEN_KEY)

  return Array.isArray(kept) ? (kept as Seen[]) : []
}

async function remember($: EngineInterface, ruling: Ruling): Promise<void> {
  const seen = await allSeen($)
  const id = idOf(ruling)
  const before = seen.find(entry => entry.id === id)
  const entry: Seen = { ...ruling, id, at: await $.clock.now(), status: before?.status ?? 'new' }
  await $.store.set(SEEN_KEY, [...seen.filter(item => item.id !== id), entry].slice(-SEEN_KEPT))
}

async function choose($: EngineInterface, ruling: Ruling, status: Seen['status']): Promise<void> {
  const id = idOf(ruling)
  const seen = await allSeen($)
  const known = seen.some(entry => entry.id === id)
  const next = known
    ? seen.map(entry => (entry.id === id ? { ...entry, status } : entry))
    : [...seen, { ...ruling, id, at: await $.clock.now(), status }]
  await $.store.set(SEEN_KEY, next.slice(-SEEN_KEPT))
  await update($, choices, now => ({ ...now, [id]: status }))
}

async function start($: EngineInterface, ruling: Ruling): Promise<void> {
  await choose($, ruling, 'started')
  await $.prompt.submit({ text: ruling.next || `Let's start on ${ruling.title}: ${ruling.url}`, asUser: true })
}

async function statusOf($: EngineInterface, ruling: Ruling): Promise<Seen['status']> {
  const id = idOf(ruling)
  const chosen = (await read($, choices))[id]

  return chosen ?? (await allSeen($)).find(entry => entry.id === id)?.status ?? 'new'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bouncer',
      description: 'List the links Bouncer judged, or turn it off or on',
      argumentHint: '[off|on]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'bouncer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isPaused, () => arg === 'off')

      return { text: arg === 'off' ? 'Bouncer is off for this session. /bouncer on brings it back.' : 'Bouncer is on.' }
    }

    return { text: listing(await allSeen($), await $.clock.now()) }
  })

  // A link the person pasted gets the brief beside it.
  on('prompt.submit', async ($, e, next) => {
    // Typed by the person: at the terminal, through Remote Control, or in an SDK
    // host such as the desktop app; not a task, a schedule or a plugin.
    const isPerson = e.origin === undefined || ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
    const links = isPerson && !e.text.trimStart().startsWith('/') ? findsIn(e.text) : []

    if (links.length === 0 || (await read($, isPaused))) {
      return next(e)
    }

    return next({ ...e, context: [...(e.context ?? []), brief(links, await projects($))] })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined && e.reason === 'answer' && e.answer.includes(MARK)) {
      const { ruling } = split(e.answer)

      if (ruling !== undefined) {
        await remember($, ruling)
      }
    }

    return done
  })

  // The card above the answer the verdict line opens; the line itself hidden.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes(MARK.slice(0, 2))) {
      return next(e)
    }

    const { ruling, text } = split(e.props.text)

    if (text === e.props.text) {
      return next(e)
    }

    const drawn = await next({ ...e, props: { ...e.props, text } })

    if (ruling === undefined) {
      return drawn
    }

    const status = await statusOf($, ruling)
    const id = idOf(ruling)
    const { Box, Button, Text } = $.ui.resolve(e)
    const detail = meta(ruling)

    return (
      <Box flexDirection="column">
        <Box key={`ruling-${id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginBottom={1}>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text bold color={VERDICT_COLOR[ruling.verdict]} dimColor={ruling.verdict === 'skip'}>
              {VERDICT_LABEL[ruling.verdict]}
            </Text>
            {ruling.for.map(project => (
              <Text key={`for-${project}`} dimColor>
                {`· ${project}`}
              </Text>
            ))}
            {detail === '' ? null : (
              <Box flexGrow={1} justifyContent="flex-end">
                <Text dimColor>{detail}</Text>
              </Box>
            )}
          </Box>
          <Text wrap="wrap">{ruling.why}</Text>
          {status === 'new' ? (
            <Box flexDirection="row" columnGap={2} marginTop={1}>
              <Button key={`start-${id}`} label="Start on it" variant="primary" onPress={() => start($, ruling)} />
              <Button key={`later-${id}`} label="Later" plain onPress={() => choose($, ruling, 'later')} />
              <Button key={`skip-${id}`} label="Skip" plain dimColor onPress={() => choose($, ruling, 'skipped')} />
            </Box>
          ) : (
            <Text key={`status-${id}`} dimColor>
              {STATUS_LABEL[status]}
            </Text>
          )}
        </Box>
        {drawn}
      </Box>
    )
  })
}
