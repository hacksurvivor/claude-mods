// Pure helpers: reading Claude's limits, briefing Codex, and turning
// `codex exec --json` events into lines of the reply.

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Brief = { role: 'user' | 'assistant'; text: string; tools: string[] }

export type CodexEvent = {
  threadId?: string
  show?: string
  isActivity?: boolean
  files?: string[]
  error?: string
}

const KIND_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  spend_limit: 'spend',
}

const MESSAGE_CAP = 4000
const CONTEXT_CAP = 40000
const FIRST_CONTEXT = 20

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll('_', ' ')
}

/** The window that has run out and has not reset yet, if any. */
export function exhausted(limits: readonly Limit[], now: number): Limit | undefined {
  return limits.find(
    limit => limit.percentUsed >= 100 && (limit.resetsAt === undefined || Date.parse(limit.resetsAt) > now),
  )
}

/** The fullest window, for the status line. */
export function fullest(limits: readonly Limit[]): Limit | undefined {
  return [...limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
}

export function resetLabel(resetsAt: string | undefined): string {
  if (resetsAt === undefined) {
    return 'when it resets'
  }

  const at = new Date(resetsAt)

  if (Number.isNaN(at.getTime())) {
    return 'when it resets'
  }

  const day = at.toLocaleDateString('en-US', { weekday: 'short' })
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  return `${day} ${time}`
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)} […]`
}

function transcript(briefs: readonly Brief[]): string {
  const lines: string[] = []
  let size = 0

  // Newest first, so the cap drops the oldest messages.
  for (const brief of [...briefs].reverse()) {
    const who = brief.role === 'user' ? 'User' : 'Assistant'
    const tools = brief.tools.length > 0 ? ` (used: ${[...new Set(brief.tools)].join(', ')})` : ''
    const line = `[${who}]${tools}\n${clip(brief.text.trim() || '(no text)', MESSAGE_CAP)}`

    if (size + line.length > CONTEXT_CAP) {
      break
    }

    lines.unshift(line)
    size += line.length
  }

  return lines.join('\n\n')
}

/** What Codex reads: the situation once, then only what it has not seen. */
export function buildPrompt(args: {
  isFirst: boolean
  cwd: string
  why: string
  context: readonly Brief[]
  text: string
}): string {
  const parts: string[] = []

  if (args.isFirst) {
    parts.push(
      `You are taking over a coding conversation from Claude Code in ${args.cwd} because ${args.why}. ` +
        'Continue the work in the same direction. You can read and edit files in this directory. ' +
        'Reply to the user directly and briefly; they read your reply in the same chat.',
    )

    const recent = transcript(args.context.slice(-FIRST_CONTEXT))

    if (recent !== '') {
      parts.push(`The conversation so far, oldest first:\n\n${recent}`)
    }
  } else if (args.context.length > 0) {
    parts.push(`Since your last reply, the conversation went on:\n\n${transcript(args.context)}`)
  }

  parts.push(`The user's new message:\n\n${args.text.trim() || '(continue)'}`)

  return parts.join('\n\n---\n\n')
}

function unwrapShell(command: string): string {
  const found = /^\/bin\/(?:ba|z)?sh -lc '([\s\S]*)'$/.exec(command)

  return (found?.[1] ?? command).replaceAll("'\\''", "'")
}

function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const short = flat.length > 120 ? `${flat.slice(0, 117)}…` : flat

  return `\`${short.replaceAll('`', "'")}\``
}

type RawItem = {
  type?: string
  text?: string
  command?: string
  exit_code?: number | null
  changes?: { path?: string; kind?: string }[]
  query?: string
  server?: string
  tool?: string
  message?: string
}

type RawEvent = {
  type?: string
  thread_id?: string
  item?: RawItem
  error?: { message?: string }
  message?: string
}

/** One line of `codex exec --json` output; a line that is not JSON is skipped. */
export function readEvent(line: string): CodexEvent {
  let event: RawEvent

  try {
    event = JSON.parse(line) as RawEvent
  } catch {
    return {}
  }

  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return { threadId: event.thread_id }
  }

  if (event.type === 'turn.failed') {
    return { error: event.error?.message ?? 'Codex stopped with an error' }
  }

  if (event.type === 'error') {
    return { error: event.message ?? 'Codex reported an error' }
  }

  if (event.type !== 'item.completed' || event.item === undefined) {
    return {}
  }

  const item = event.item

  switch (item.type) {
    case 'agent_message':
      return item.text ? { show: item.text } : {}
    case 'command_execution': {
      const failed = typeof item.exit_code === 'number' && item.exit_code !== 0
      const ran = `ran ${inlineCode(unwrapShell(item.command ?? ''))}${failed ? ` (exit ${item.exit_code})` : ''}`

      return { show: ran, isActivity: true }
    }
    case 'file_change': {
      const files = (item.changes ?? []).map(change => change.path ?? '').filter(path => path !== '')
      const verb = (kind: string | undefined) => (kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : 'edited')
      const lines = (item.changes ?? [])
        .filter(change => change.path)
        .map(change => `${verb(change.kind)} ${inlineCode(change.path ?? '')}`)

      return lines.length > 0 ? { show: lines.join('\n- '), isActivity: true, files } : {}
    }
    case 'web_search':
      return item.query ? { show: `searched the web for ${inlineCode(item.query)}`, isActivity: true } : {}
    case 'mcp_tool_call':
      return { show: `used ${inlineCode(`${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`)}`, isActivity: true }
    case 'error':
      return { error: item.message ?? 'Codex reported an error' }
    default:
      return {}
  }
}

/** The command Nightshift runs: through a login shell, so `codex` and `node` resolve as in a terminal. */
export function codexArgv(
  threadId: string | undefined,
  prompt: string,
  choice: { model?: string; effort?: string; images?: readonly string[]; config?: readonly string[] } = {},
): string[] {
  const codex = threadId === undefined ? ['exec'] : ['exec', 'resume', threadId]
  const model = choice.model === undefined ? [] : ['-m', choice.model]
  const effort = choice.effort === undefined ? [] : ['-c', `model_reasoning_effort="${choice.effort}"`]

  return [
    '/bin/zsh',
    '-lc',
    'exec codex "$@"',
    'codex',
    ...codex,
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="workspace-write"',
    ...model,
    ...effort,
    ...(choice.config ?? []).flatMap(pair => ['-c', pair]),
    // `--image=` so the prompt after it is never read as one more image.
    ...(choice.images ?? []).map(path => `--image=${path}`),
    prompt,
  ]
}

/**
 * Claude's browser pane offered to a Codex run: the bridge as an MCP server.
 * Codex does not ask before its tools because Nightshift asks in Claude instead
 * (or not, when the user picked Tools: Codex, auto).
 */
export function browserConfig(root: string, socket: string): string[] {
  return [
    'mcp_servers.claude_browser.command="node"',
    `mcp_servers.claude_browser.args=${JSON.stringify([`${root}/hooks/browser-mcp.mjs`, socket])}`,
    'mcp_servers.claude_browser.tool_timeout_sec=180',
    'mcp_servers.claude_browser.default_tools_approval_mode="approve"',
  ]
}

export const BROWSER_NOTE =
  '\n\nFor any web browsing, use the claude_browser tools: they drive the browser pane the user is watching in Claude. ' +
  "Use @chrome only if this brief asks for the user's own Chrome."

export type CodexLimits = { fiveHour?: number; week?: number; weekResetsAt?: number }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

type RawWindow = { used_percent?: number; window_minutes?: number; resets_at?: number | null } | null | undefined

// Codex has logged the windows a minute either side of their nominal length.
const isWindow = (minutes: number | undefined, nominal: number) =>
  minutes !== undefined && Math.abs(minutes - nominal) <= 60

/** Codex's own windows, from the newest `rate_limits` line of its session logs. */
export function readCodexLimits(line: string, now: number): CodexLimits | undefined {
  let found: { payload?: { rate_limits?: { primary?: RawWindow; secondary?: RawWindow } } }

  try {
    found = JSON.parse(line) as typeof found
  } catch {
    return undefined
  }

  const limits = found.payload?.rate_limits

  if (!limits) {
    return undefined
  }

  const read: CodexLimits = {}

  for (const window of [limits.primary, limits.secondary]) {
    if (!window || typeof window.used_percent !== 'number') {
      continue
    }

    const resetsAt = typeof window.resets_at === 'number' ? window.resets_at * 1000 : undefined
    // A window that has reset since the line was written starts at zero.
    const used = resetsAt !== undefined && resetsAt <= now ? 0 : window.used_percent

    if (isWindow(window.window_minutes, 300)) {
      read.fiveHour = used
    } else if (isWindow(window.window_minutes, 10080)) {
      const week = currentWeek({ week: window.used_percent, weekResetsAt: resetsAt }, now)

      read.week = week.week

      if (week.weekResetsAt !== undefined) {
        read.weekResetsAt = week.weekResetsAt
      }
    }
  }

  return read
}

/**
 * Codex's 7-day window as it stands at `now`: once the read window has reset,
 * the next one has begun at zero and resets a week on. The strip asks at each
 * draw, so an idle session never shows a reset time that has passed.
 */
export function currentWeek(limits: CodexLimits | undefined, now: number): Pick<CodexLimits, 'week' | 'weekResetsAt'> {
  let resetsAt = limits?.weekResetsAt

  if (limits?.week === undefined || resetsAt === undefined || resetsAt > now) {
    return { week: limits?.week, weekResetsAt: resetsAt }
  }

  while (resetsAt <= now) {
    resetsAt += WEEK_MS
  }

  return { week: 0, weekResetsAt: resetsAt }
}

/** How far into its 7-day window Codex's limit is, 0 to 1, from when it resets. */
export function weekElapsed(resetsAt: number | undefined, now: number): number | undefined {
  if (resetsAt === undefined) {
    return undefined
  }

  return Math.min(1, Math.max(0, 1 - (resetsAt - now) / WEEK_MS))
}

/** `5h 3% · 7d 15%`: short enough for the line under the box. */
export function windows(fiveHour: number | undefined, week: number | undefined): string {
  const parts = [
    fiveHour === undefined ? undefined : `5h ${Math.round(fiveHour)}%`,
    week === undefined ? undefined : `7d ${Math.round(week)}%`,
  ].filter(part => part !== undefined)

  return parts.join(' · ')
}

/** The script Nightshift runs to find that line, newest logs first. */
// The newest log that has a reading, and its last one: newest file first,
// since grep would print an older file's lines after a newer one's.
export const CODEX_LIMITS_SCRIPT =
  'setopt nullglob; cd ~/.codex/sessions 2>/dev/null || exit 0; ' +
  'for file in $(ls -t */*/*/*.jsonl 2>/dev/null | head -8); do ' +
  'line=$(grep -h \'"rate_limits":{\' $file 2>/dev/null | tail -1); ' +
  '[[ -n $line ]] && { print -r -- $line; exit 0 }; done'

export type CodexModel = { slug: string; name: string; efforts?: string[] }

/** The models Codex lists, from its own cache (`~/.codex/models_cache.json`). */
export function readModels(cache: string): CodexModel[] {
  try {
    const parsed = JSON.parse(cache) as {
      models?: {
        slug?: string
        display_name?: string
        visibility?: string
        supported_reasoning_levels?: { effort?: string }[]
      }[]
    }

    return (parsed.models ?? [])
      .filter(model => model.visibility === 'list' && typeof model.slug === 'string')
      .map(model => ({
        slug: model.slug ?? '',
        name: model.display_name ?? model.slug ?? '',
        efforts: model.supported_reasoning_levels?.map(level => level.effort ?? '').filter(effort => effort !== ''),
      }))
  } catch {
    return []
  }
}

/** `model = "..."` and `model_reasoning_effort = "..."` from `~/.codex/config.toml`. */
export function readCodexDefaults(toml: string): { model?: string; effort?: string } {
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(toml)?.[1]

  return { model: value('model'), effort: value('model_reasoning_effort') }
}

// Only the two top-level settings Nightshift uses leave config.toml: the file can
// hold other tools' secrets further down.
export const CODEX_SETUP_SCRIPT =
  'cat ~/.codex/models_cache.json 2>/dev/null; printf "\\n@@config@@\\n"; ' +
  "awk '/^\\[/{exit} /^(model|model_reasoning_effort)[ \\t]*=/' ~/.codex/config.toml 2>/dev/null"
