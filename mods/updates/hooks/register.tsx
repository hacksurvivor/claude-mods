import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Report } from '../types'
import { describe, isDue, parse, summaryPrompt, withLines } from './check'

// A weekly look at the person's Claude and Codex plugins, skills and CLIs.
// bin/check.py only reads; the report lands in this plugin's store, where the
// Updates tab in The Tree of Mods reads it and applies what is ready. /updates checks now.

const CHECK_TIMEOUT_MS = 180_000
const FIRST_LOOK_MS = 20_000
const REPORT_KEY = 'report'

const isChecking = atom({ plugin: 'updates', key: 'isChecking' } as const, false)

// The check in flight; a second caller waits for it instead of starting another.
let checking: Promise<Report | string> | undefined

function check($: EngineInterface): Promise<Report | string> {
  checking ??= look($).finally(() => {
    checking = undefined
  })

  return checking
}

async function look($: EngineInterface): Promise<Report | string> {
  await update($, isChecking, () => true)

  try {
    // Through a login shell, so gh, npm and the person's updaters are on the PATH.
    const ran = await $.process.run(['/bin/zsh', '-lc', '"$@"', 'updates', 'python3', `${$.plugin.root}/bin/check.py`], {
      timeoutMs: CHECK_TIMEOUT_MS,
    })
    const found = parse(ran.stdout)

    if ('error' in found) {
      return found.error
    }

    const written = await summarise($, found.report)
    await $.store.set(REPORT_KEY, written)

    return written
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200)
  } finally {
    await update($, isChecking, () => false)
  }
}

// One short line per item, from its notes; the plain fallback when it can't.
async function summarise($: EngineInterface, found: Report): Promise<Report> {
  const worded = found.items.filter(item => item.kind !== 'manual' && item.notes.trim() !== '')

  if (worded.length === 0) {
    return found
  }

  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: summaryPrompt(worded), maxTokens: 600, effort: 'low' })

    return reply.isAnswered ? withLines(found, reply.text) : found
  } catch {
    return found
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'updates', description: 'Check your plugins, skills and CLIs for updates now', immediate: true })

    const kept = (await $.store.get(REPORT_KEY)) as Report | undefined

    if (isDue(kept ?? null, await $.clock.now())) {
      $.clock.after(FIRST_LOOK_MS, () => void check($))
    }

    return next(e)
  })

  on('command.run', { command: 'updates' }, async $ => ({ text: describe(await check($)) }))
}
