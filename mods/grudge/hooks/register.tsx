import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Notice } from '../types'
import {
  NOTE_SCHEMA,
  NOTE_TOOL,
  NOTE_TOOL_ID,
  anchorOf,
  isPreviewTool,
  isUiFile,
  isUnder,
  grudgeBrief,
  listing,
  nameOf,
  noteAsk,
  unapprovedLine,
  verdictOf,
} from './grudge'

// Every look the person turns down or signs off on becomes a rule for that
// project. Claude writes the rule itself through the note tool, having seen
// their words and screenshot; the screenshot is copied out of the transcript.
// The first time a turn edits a UI file, Claude is handed the project's rules,
// and a reply that changed UI with no approved preview says so under it.

// The store key predates the name; Mods reads it under this key too.
const STORE_KEY = 'ledger'
const KEPT = 400
const NOTICES_KEPT = 30

const notices = atom({ plugin: 'grudge', key: 'notices' } as const, [] as Notice[])
const version = atom({ plugin: 'grudge', key: 'version' } as const, 0)
const isPaused = atom({ plugin: 'grudge', key: 'isPaused' } as const, false)

// This session: whether a look is on the table, and whether one was approved.
let isLookShown = false
let isApproved = false
let didLastTurnTouchUi = false
// This turn: the verdict given, the rules noted, the UI files changed.
let pending: { verdict: Entry['verdict']; quote: string; hasImage: boolean } | undefined
let noted: string[] = []
let uiFiles: string[] = []
let isBriefed = false

async function projectOf($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()
  const cwd = await $.session.cwd()

  return repo?.root ?? cwd
}

async function grudges($: EngineInterface): Promise<Entry[]> {
  const kept = await $.store.get(STORE_KEY)

  return Array.isArray(kept) ? (kept as Entry[]) : []
}

async function save($: EngineInterface, entries: Entry[]): Promise<void> {
  await $.store.set(STORE_KEY, entries.slice(-KEPT))
  await update($, version, n => n + 1)
}

// The screenshots of the person's last message, copied next to their grudges.
async function screenshots($: EngineInterface, project: string, id: string): Promise<string[]> {
  try {
    const home = await $.env.get('HOME')
    const folder = `${home ?? '~'}/.claude/grudge/${nameOf(project).replace(/[^\w.-]+/g, '-')}`
    const ran = await $.process.run(['/bin/zsh', '-lc', '"$@"', 'grudge', 'python3', `${$.plugin.root}/bin/shot.py`, await $.session.id(), folder, id], {
      timeoutMs: 20_000,
    })
    const paths = JSON.parse(ran.stdout.trim() || '[]') as unknown

    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
  } catch {
    return []
  }
}

async function note($: EngineInterface, screen: string, rule: string, verdict: Entry['verdict'] | undefined): Promise<Entry> {
  const project = await projectOf($)
  const at = await $.clock.now()
  const id = `grudge-${at.toString(36)}`
  const given = verdict ?? pending?.verdict ?? 'rejected'
  const images = pending?.hasImage === true ? await screenshots($, project, id) : []
  const entry: Entry = { id, at, project, verdict: given, screen: screen.trim(), rule: rule.trim(), quote: pending?.quote ?? '', images }
  await save($, [...(await grudges($)), entry])
  noted.push(id)

  return entry
}

async function forget($: EngineInterface, id: string): Promise<void> {
  await save($, (await grudges($)).filter(entry => entry.id !== id))
  $.ui.toast('Grudge dropped.', { timeoutMs: 5_000 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'grudge',
      description: "Show what Grudge holds against this project's looks, or forget, add, pause a rule",
      argumentHint: '[forget <n> | add <rule> | off | on]',
      immediate: true,
    })
    await $.tool.register({
      name: NOTE_TOOL,
      description:
        "Records what the person just rejected or approved in the product's look, as one rule for this project in Grudge, their list of looks they won't see again. Call it once when Grudge asks you to.",
      inputSchema: NOTE_SCHEMA,
    })

    return next(e)
  })

  on('command.run', { command: 'grudge' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const project = await projectOf($)
    const entries = await grudges($)

    if (verb === 'off' || verb === 'on') {
      await update($, isPaused, () => verb === 'off')

      return { text: verb === 'off' ? 'Grudge is paused for this session. /grudge on resumes it.' : 'Grudge is on.' }
    }

    if (verb === 'forget') {
      const mine = entries.filter(entry => entry.project === project)
      const target = mine[Number(rest[0]) - 1]

      if (target === undefined) {
        return { text: `No rule ${rest[0] ?? ''} here. /grudge lists them with their numbers.` }
      }

      await save($, entries.filter(entry => entry.id !== target.id))

      return { text: `Forgot: ${target.screen}: ${target.rule}` }
    }

    if (verb === 'add' && rest.length > 0) {
      const at = await $.clock.now()
      const entry: Entry = { id: `grudge-${at.toString(36)}`, at, project, verdict: 'rejected', screen: 'General', rule: rest.join(' '), quote: '', images: [] }
      await save($, [...entries, entry])

      return { text: `Added for ${nameOf(project)}: ${entry.rule}` }
    }

    return { text: listing(project, entries) }
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin === undefined || ['composer', 'bridge', 'sdk'].includes(e.origin.kind)

    if (!isPerson || e.turnId !== undefined) {
      return next(e)
    }

    noted = []
    uiFiles = []
    isBriefed = false
    pending = undefined

    if (await read($, isPaused)) {
      return next(e)
    }

    const hasImage = e.attachments?.some(item => item.type === 'image') ?? false
    const verdict = verdictOf(e.text, hasImage, isLookShown || didLastTurnTouchUi)

    if (verdict === undefined) {
      return next(e)
    }

    pending = { verdict, quote: e.text.trim().slice(0, 300), hasImage }
    isApproved = verdict === 'approved'

    return next({ ...e, context: [...(e.context ?? []), noteAsk(verdict, hasImage)] })
  })

  on('tool.call', { tool: NOTE_TOOL_ID }, async ($, e) => {
    const input = e as unknown as { screen?: unknown; rule?: unknown; verdict?: unknown }
    const screen = typeof input.screen === 'string' ? input.screen : ''
    const rule = typeof input.rule === 'string' ? input.rule : ''

    if (screen.trim() === '' || rule.trim() === '') {
      return { deny: 'Give the screen and the rule.' }
    }

    const verdict = input.verdict === 'approved' || input.verdict === 'rejected' ? input.verdict : undefined
    const entry = await note($, screen, rule, verdict)

    return { result: [{ type: 'text', text: `Recorded for ${nameOf(entry.project)}. Carry on with the person's request.` }] }
  })

  on('tool.call', async ($, e, next) => {
    const path = (e as unknown as { file_path?: unknown }).file_path
    const file = typeof path === 'string' ? path : undefined

    if (isPreviewTool(e.tool, file)) {
      isLookShown = true
      isApproved = false

      return next(e)
    }

    if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool) || file === undefined || !isUiFile(file) || (await read($, isPaused))) {
      return next(e)
    }

    const done = await next(e)

    if ('deny' in done && done.deny !== undefined) {
      return done
    }

    if ('isError' in done && done.isError === true) {
      return done
    }

    uiFiles.push(file)

    if (isBriefed) {
      return done
    }

    isBriefed = true
    const brief = grudgeBrief(await projectOf($), await grudges($), isApproved)

    return { ...done, context: [...(done.context ?? []), brief] }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined || e.reason !== 'answer') {
      return done
    }

    const unapproved = isApproved ? [] : uiFiles
    didLastTurnTouchUi = uiFiles.length > 0
    isLookShown = isLookShown || didLastTurnTouchUi

    if (noted.length > 0 || unapproved.length > 0) {
      const notice: Notice = { anchor: anchorOf(e.answer), ids: [...noted], unapproved: [...unapproved] }
      await update($, notices, list => [...list, notice].slice(-NOTICES_KEPT))
    }

    pending = undefined

    return done
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const mine = (await read($, notices)).filter(notice => isUnder(notice.anchor, e.props.text))

    if (mine.length === 0) {
      return next(e)
    }

    await read($, version)
    const entries = await grudges($)
    const drawn = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {drawn}
        {mine.flatMap((notice, at) => [
          ...notice.ids
            .map(id => entries.find(entry => entry.id === id))
            .filter((entry): entry is Entry => entry !== undefined)
            .map(entry => (
              <Box key={`noted-${entry.id}`} flexDirection="row" columnGap={1} marginTop={1} marginLeft={2}>
                <Text dimColor>{`Noted for ${nameOf(entry.project)}: ${entry.rule}`}</Text>
                <Text dimColor>·</Text>
                <Button key={`undo-${entry.id}`} label="Undo" plain onPress={() => forget($, entry.id)} />
              </Box>
            )),
          ...(notice.unapproved.length > 0
            ? [
                <Box key={`unapproved-${at}`} marginTop={1} marginLeft={2}>
                  <Text color="warning">{unapprovedLine(notice.unapproved)}</Text>
                </Box>,
              ]
            : []),
        ])}
      </Box>
    )
  })
}
