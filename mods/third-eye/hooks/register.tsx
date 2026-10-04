import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Idea } from '../types'
import { IDLE_MS, anchorOf, isDue, isUnder, parseIdea, question, readTaste, remember } from './eye'

// A footnote under Claude's reply with one idea the person wouldn't have
// suggested themselves. The eye looks a little while after a reply, at most
// once in 15 minutes, by asking the session's own model over this chat (a
// fork, so the chat's prompt cache serves it). /third-eye asks it now.

const TASTE_KEY = 'taste'
const IDEAS_KEPT = 20

const ideas = atom({ plugin: 'third-eye', key: 'ideas' } as const, [] as Idea[])
const open = atom({ plugin: 'third-eye', key: 'open' } as const, [] as string[])
const looking = atom({ plugin: 'third-eye', key: 'looking' } as const, null as string | null)
const isPaused = atom({ plugin: 'third-eye', key: 'isPaused' } as const, false)

let waiting: Timer | undefined
let isBusy = false
let lastAnchor: string | undefined

// Resolves the new idea, or a sentence saying why there is none.
async function look($: EngineInterface, anchor: string): Promise<Idea | string> {
  if (isBusy) {
    return 'Your third eye is already looking.'
  }

  isBusy = true
  await update($, looking, () => anchor)

  try {
    const taste = readTaste(await $.store.get(TASTE_KEY))
    const reply = await $.model.fork({ prompt: question(taste) })

    if (!reply.isAnswered) {
      return reply.reason === 'nothing-to-fork'
        ? 'Nothing to look at yet. Ask Claude something first.'
        : `Your third eye couldn't look this time (${reply.reason}).`
    }

    const found = parseIdea(reply.text)

    if (found === undefined) {
      return 'Your third eye came back without an idea. Try again in a bit.'
    }

    const at = await $.clock.now()
    const idea: Idea = { id: `eye-${at}`, anchor, ...found, at, status: 'new' }
    await update($, ideas, list => [...list, idea].slice(-IDEAS_KEPT))
    await update($, open, list => [...list, idea.id])

    return idea
  } finally {
    await update($, looking, () => null)
    isBusy = false
  }
}

// The reply the eye looks from: the last one this module saw end, or after a
// reload, the chat's last assistant text.
async function lastReply($: EngineInterface): Promise<string | undefined> {
  if (lastAnchor !== undefined) {
    return lastAnchor
  }

  const rows = await $.session.messages()
  const row = [...rows].reverse().find(item => item.role === 'assistant' && item.text.trim() !== '')

  return row === undefined ? undefined : anchorOf(row.text)
}

async function ask($: EngineInterface, idea: Idea): Promise<void> {
  await update($, ideas, list => list.map(item => (item.id === idea.id ? { ...item, status: 'asked' as const } : item)))
  await $.store.set(TASTE_KEY, remember(readTaste(await $.store.get(TASTE_KEY)), 'asked', idea.idea))
  await $.prompt.submit({ text: idea.prompt, asUser: true })
}

async function dismiss($: EngineInterface, idea: Idea): Promise<void> {
  await update($, ideas, list => list.map(item => (item.id === idea.id ? { ...item, status: 'dismissed' as const } : item)))
  await $.store.set(TASTE_KEY, remember(readTaste(await $.store.get(TASTE_KEY)), 'dismissed', idea.idea))
  $.ui.toast('Got it. Fewer ideas like that one.')
}

async function fold($: EngineInterface, id: string): Promise<void> {
  await update($, open, list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
}

// The footnote's paragraph: the blind spot, then the idea, in the reply's own voice.
function paragraph(idea: Idea): string {
  const sentence = /[.!?]$/.test(idea.idea) ? idea.idea : `${idea.idea}.`

  return `*${`${idea.why} ${sentence}`.replace(/\*/g, '\\*')}*`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'third-eye',
      description: "Ask your third eye for an idea you wouldn't suggest, or turn it off or on",
      argumentHint: '[off|on]',
    })

    return next(e)
  })

  on('command.run', { command: 'third-eye' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await update($, isPaused, () => arg === 'off')
      waiting?.cancel()

      return {
        text: arg === 'off' ? 'Your third eye is resting for this session. /third-eye on wakes it.' : 'Your third eye is awake.',
      }
    }

    const anchor = await lastReply($)

    if (anchor === undefined) {
      return { text: 'Nothing to look at yet. Ask Claude something first.' }
    }

    waiting?.cancel()
    const found = await look($, anchor)

    return { text: typeof found === 'string' ? found : `Another angle: ${found.idea}` }
  })

  // A while after a main-loop reply, unless the person has written again.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined || e.reason !== 'answer' || e.answer.trim() === '') {
      return done
    }

    const anchor = anchorOf(e.answer)
    lastAnchor = anchor

    if (!(await read($, isPaused)) && isDue(await $.clock.now(), await read($, ideas))) {
      waiting?.cancel()
      waiting = $.clock.after(IDLE_MS, () => void look($, anchor))
    }

    return done
  })

  on('prompt.submit', ($, e, next) => {
    waiting?.cancel()
    waiting = undefined

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    const mine = (await read($, ideas)).filter(idea => idea.status !== 'dismissed' && isUnder(idea.anchor, text))
    const lookingAt = await read($, looking)
    const isLookingHere = lookingAt !== null && isUnder(lookingAt, text)

    if (mine.length === 0 && !isLookingHere) {
      return next(e)
    }

    const drawn = await next(e)
    const unfolded = await read($, open)
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {drawn}
        {mine.map(idea => {
          const isOpen = unfolded.includes(idea.id)

          return (
            <Box key={idea.id} flexDirection="column" marginTop={1} marginLeft={2}>
              <Button
                key={`fold-${idea.id}`}
                label={isOpen ? 'Another angle ⌄' : 'Another angle ›'}
                plain
                dimColor
                onPress={() => fold($, idea.id)}
              />
              {isOpen ? (
                <Box key={`body-${idea.id}`} flexDirection="column" marginLeft={2}>
                  <Markdown key={`text-${idea.id}`} text={paragraph(idea)} dimColor />
                  {idea.status === 'new' ? (
                    <Box key={`acts-${idea.id}`} flexDirection="row" columnGap={1}>
                      <Button key={`ask-${idea.id}`} label="Ask Claude about this" plain onPress={() => ask($, idea)} />
                      <Text dimColor>·</Text>
                      <Button key={`nope-${idea.id}`} label="Not for me" plain dimColor onPress={() => dismiss($, idea)} />
                    </Box>
                  ) : (
                    <Text key={`asked-${idea.id}`} dimColor>
                      Asked
                    </Text>
                  )}
                </Box>
              ) : null}
            </Box>
          )
        })}
        {isLookingHere ? (
          <Box key="looking" marginTop={1} marginLeft={2}>
            <Text dimColor>Another angle…</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
