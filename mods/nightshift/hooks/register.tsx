import type { EngineInterface, Register, RenderElement, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'

import {
  BROWSER_NOTE,
  browserConfig,
  buildPrompt,
  CODEX_LIMITS_SCRIPT,
  CODEX_SETUP_SCRIPT,
  codexArgv,
  exhausted,
  kindLabel,
  readCodexDefaults,
  currentWeek,
  readCodexLimits,
  readEvent,
  readModels,
  resetLabel,
  weekElapsed,
} from './codex'
import type { Brief, CodexLimits, CodexModel, Limit } from './codex'
import {
  bulletColor,
  CODEX_EFFORTS,
  EFFORT_LABELS,
  effortsFor,
  effortWithin,
  duration,
  HEADER,
  isCodexReply,
  limitTiles,
  liveLine,
  logoDots,
  readReply,
  shimmerColors,
} from './look'
import type { CodexEffort } from './look'
import {
  browserStep,
  CODEX_TOOL_DESCRIPTION,
  CODEX_TOOL_SCHEMA,
  HANDED_TOOL_NOTE,
  HANDED_TOOLS,
  hear,
  imageCard,
  imagesScript,
  isLookOnly,
  isVoiceReply,
  liveWave,
  PREVIEW_SCRIPT,
  QUIET,
  readBridge,
  readCall,
  readPreview,
  speakable,
  splitImages,
  SPOKE,
  talkState,
  TOOLS_TO_CODEX,
  VOICE_HEADER,
  voiceArgv,
  VoiceFeed,
} from './talk'
import type { BrowserAccess, BrowserCall, Preview, Talk, Worker } from './talk'

// While Claude's usage limit is used up, Codex answers in the same chat:
// a turn.step hook answers the request itself instead of sending it. When
// the limit resets, Claude answers again and is told what Codex did.

type Mode = 'auto' | 'codex' | 'claude'

async function limitsNow($: EngineInterface): Promise<{ limits: Limit[]; now: number }> {
  const [usage, now] = await Promise.all([$.session.usage(), $.clock.now()])

  return { limits: usage.rateLimits, now }
}

// A line in the transcript the model never reads; a toast where that fails,
// so a missing note never stops the answer.
async function notice($: EngineInterface, text: string): Promise<void> {
  try {
    await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
  } catch {
    $.ui.toast(text)
  }
}

// Codex's own limits, read from its newest session logs; never its messages.
async function readCodex($: EngineInterface, now: number): Promise<CodexLimits | undefined> {
  try {
    const { stdout } = await $.process.run(['/bin/zsh', '-c', CODEX_LIMITS_SCRIPT], { timeoutMs: 5000 })

    return readCodexLimits(stdout.trim(), now)
  } catch {
    return undefined
  }
}

// The same, stamped with when it was read.
async function readCodexNow($: EngineInterface): Promise<{ read: CodexLimits | undefined; now: number }> {
  const now = await $.clock.now()

  return { read: await readCodex($, now), now }
}

// Which models Codex offers and what it uses by default, from its own files.
async function readCodexSetup($: EngineInterface): Promise<{ models: CodexModel[]; model?: string; effort?: string }> {
  try {
    const { stdout } = await $.process.run(['/bin/zsh', '-c', CODEX_SETUP_SCRIPT], { timeoutMs: 5000 })
    const [cache = '', config = ''] = stdout.split('@@config@@')

    return { models: readModels(cache.trim()), ...readCodexDefaults(config) }
  } catch {
    return { models: [] }
  }
}

// Codex's effort: Light (low) through Max; "light" names low.
function asEffort(value: unknown): CodexEffort | undefined {
  const word = value === 'light' ? 'low' : value

  return CODEX_EFFORTS.find(effort => effort === word)
}

// A small JPEG of a Codex image for its card in the chat.
async function previewOf($: EngineInterface, path: string): Promise<Preview | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['/bin/zsh', '-c', PREVIEW_SCRIPT, 'nightshift', path], { timeoutMs: 20000 })

    return exitCode === 0 ? readPreview(stdout) : undefined
  } catch {
    return undefined
  }
}

// Asks for the previews a card needs; each redraws the chat once it is ready.
function wantPreviews($: EngineInterface, paths: readonly string[], previews: Map<string, Preview | null | undefined>): void {
  for (const path of paths) {
    if (!previews.has(path)) {
      previews.set(path, undefined)
      void previewOf($, path).then(preview => {
        previews.set(path, preview ?? null)
        $.ui.invalidate('ui.render')
      })
    }
  }
}

// The images a Codex thread saved during a run.
async function newImages($: EngineInterface, thread: string, sinceMs: number): Promise<string[]> {
  try {
    const { stdout } = await $.process.run(imagesScript(thread, sinceMs / 1000 - 2), { timeoutMs: 10000 })

    return stdout.split('\n').filter(line => line.startsWith('/'))
  } catch {
    return []
  }
}

// One Codex run for Claude's `codex` tool: its reply, and the images it made.
async function runCodexTool(
  $: EngineInterface,
  input: { prompt: string; images?: readonly string[] },
  choice: { model?: string; effort?: string; config?: readonly string[] },
): Promise<{ text: string; images: string[]; previews: Preview[] }> {
  const [cwd, startedAt] = await Promise.all([$.session.cwd(), $.clock.now()])
  const { stdout, stderr } = await $.process.run(codexArgv(undefined, input.prompt, { ...choice, images: input.images }), {
    cwd,
    timeoutMs: 600000,
  })
  let thread: string | undefined
  let error: string | undefined
  const said: string[] = []

  for (const line of stdout.split('\n')) {
    const event = readEvent(line)

    thread = event.threadId ?? thread
    error = event.error ?? error

    if (event.show !== undefined && event.isActivity !== true) {
      said.push(event.show)
    }
  }

  const images = thread === undefined ? [] : await newImages($, thread, startedAt)
  const previews = (await Promise.all(images.map(path => previewOf($, path)))).filter(
    (preview): preview is Preview => preview !== undefined,
  )
  const reason = error ?? (said.length === 0 ? stderr.trim().split('\n').at(-1) : undefined)

  return {
    text:
      (said.join('\n\n') || (reason ? `Codex couldn't finish: ${reason}` : 'Codex finished without a reply.')) +
      (images.length > 0 ? `\n\nImages saved:\n${images.map(path => `- ${path}`).join('\n')}` : ''),
    images,
    previews,
  }
}

// While a Codex run lasts, carries each of its browser steps into Claude's
// browser pane: the bridge holds the step, `decide` says whether it may run,
// and the pane's own tool does it.
async function pumpBrowser(
  $: EngineInterface,
  socket: string,
  decide: (call: BrowserCall) => Promise<boolean>,
  isRunning: () => boolean,
): Promise<void> {
  while (isRunning()) {
    let call: BrowserCall | undefined

    try {
      const next = await $.http.fetch('http://localhost/next', { method: 'GET', socketPath: socket })

      call = next.status === 200 ? readCall(next.text) : undefined
    } catch {
      // The bridge starts with Codex's run; until then its socket is not there.
      await $.clock.sleep(300)
      continue
    }

    if (call === undefined) {
      continue
    }

    const result = (await decide(call))
      ? await $.mcp.call('Claude_Browser', call.tool, call.args).catch((error: unknown) => ({
          content: [{ type: 'text', text: `Claude's browser pane refused: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        }))
      : {
          content: [{ type: 'text', text: 'The user declined this browser step. Do not retry it; say what you needed it for.' }],
          isError: true,
        }

    await $.http
      .fetch('http://localhost/result', { method: 'POST', socketPath: socket, body: JSON.stringify({ id: call.id, result }) })
      .catch(() => undefined)
  }
}

// The user's own temp folder for the helpers' sockets (macOS gives each user
// one), so no other account on the machine can reach them.
async function privateDir($: EngineInterface): Promise<string> {
  try {
    const { stdout } = await $.process.run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'], { timeoutMs: 5000 })
    const dir = stdout.trim()

    return dir.startsWith('/') ? dir.replace(/\/?$/, '/') : '/tmp/'
  } catch {
    return '/tmp/'
  }
}

// The strip's limit meter: room for 8px tiles, two a day, and the reset time.
const STRIP_METER_WIDTH = 300

// The key a finished reply's meta line is kept under until it is drawn.
function keyOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

function brief(message: SessionMessage): Brief {
  return { role: message.role, text: message.text, tools: message.toolUses.map(use => use.tool) }
}

export const register: Register = on => {
  let mode: Mode = 'auto'
  let threadId: string | undefined
  let seen = 0
  let codexTurns = 0
  let isCodexActive = false
  const files = new Set<string>()
  const prompts = new Map<string, string>()
  let lastPrompt: string | undefined
  let isRetrying = false
  let isCodexOn = false
  let lastOut: Limit | undefined
  let working: { startedAt: number; step: string } | undefined
  const metas = new Map<string, string>()
  let ticker: (() => void) | undefined
  let refresher: (() => void) | undefined
  let codexLimits: CodexLimits | undefined
  // Codex's live voice: the strip's state, the bridge's socket, and each spoken
  // exchange waiting to be kept in the chat as your words and Codex's reply.
  let talk: Talk = QUIET
  let talkSocket: string | undefined
  // Codex's spoken replies, each waiting for its chat row by the words that open it.
  const feeds = new Map<string, VoiceFeed[]>()
  // Rows the voice put in the chat: what you said to Codex, what you asked Claude
  // for, or the hidden row a reply Codex speaks on its own opens with.
  const voiceRows = new Map<string, Worker | 'hidden'>()
  // Who does the work you ask for out loud; Claude's tasks get its answer read back.
  let voiceWorker: Worker = 'codex'
  // Who does browser, Mac-app, image and document work: Claude's own tools, or Codex.
  let toolsWorker: Worker = 'claude'
  // Codex's steps in Claude's browser pane: asked here first, or run as they come.
  let browserAccess: BrowserAccess = 'ask'
  const asks: { call: BrowserCall; answer: (allowed: boolean) => void; allowRest: () => void }[] = []
  const claudeTasks = new Set<string>()
  let talkRun: ReturnType<EngineInterface['process']['spawn']> | undefined
  // Codex's one-off runs: `/codex <prompt>`, answered by Codex whatever the mode.
  const once = new Set<string>()
  // Image card previews by path: absent until asked, undefined while loading.
  const previews = new Map<string, Preview | null | undefined>()
  // Each image's card, built once: its picture is ~100 KB of SVG, and every
  // redraw re-runs the chat's rows.
  const cards = new Map<string, ReturnType<typeof imageCard>>()
  const cardFor = (path: string, preview: Preview | null | undefined) => {
    if (!preview) {
      return undefined
    }

    const card = cards.get(path) ?? imageCard(preview)

    cards.set(path, card)

    return card
  }
  const toolImages = new Map<string, string[]>()
  let codexReadAt = 0
  let models: CodexModel[] = []
  let codexModel: string | undefined
  let codexEffort: CodexEffort = 'medium'

  // The levels the chosen model takes, so the strip never offers one it refuses.
  const offered = (): CodexEffort[] => effortsFor(models.find(model => model.slug === codexModel)?.efforts)

  // Codex's limit moves when Codex runs here or anywhere else on this Mac.
  const keepCodex = ({ read, now }: { read: CodexLimits | undefined; now: number }): void => {
    codexReadAt = now
    codexLimits = read ?? codexLimits
  }

  // Whether Codex answers the next message; the strip above the box says so.
  const settle = (limits: readonly Limit[], now: number): void => {
    lastOut = exhausted(limits, now)
    isCodexOn = mode === 'codex' || (mode === 'auto' && lastOut !== undefined)
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nightshift',
      description: 'Hand the chat to Codex when your Claude limit runs out, or switch by hand',
      argumentHint: 'auto | codex | claude | effort <level> | model <name> | tools codex|claude',
    })
    await $.command.register({
      name: 'codex',
      description: 'Ask Codex once, here in the chat: $imagegen for an image, or any of its tools and plugins',
      argumentHint: '<prompt>',
    })

    try {
      await $.tool.register({ name: 'codex', description: CODEX_TOOL_DESCRIPTION, inputSchema: CODEX_TOOL_SCHEMA })
    } catch {
      // Without the tool, /codex still reaches Codex.
    }

    const [setup, savedModel, savedEffort, savedWorker, savedTools, savedAccess] = await Promise.all([
      readCodexSetup($),
      $.store.get('codexModel'),
      $.store.get('codexEffort'),
      $.store.get('voiceWorker'),
      $.store.get('toolsWorker'),
      $.store.get('browserAccess'),
    ])

    voiceWorker = savedWorker === 'claude' ? 'claude' : 'codex'
    toolsWorker = savedTools === 'codex' ? 'codex' : 'claude'
    browserAccess = savedAccess === 'auto' ? 'auto' : 'ask'

    models = setup.models
    codexModel = typeof savedModel === 'string' ? savedModel : setup.model
    codexEffort = asEffort(savedEffort) ?? asEffort(setup.effort) ?? 'medium'

    const { limits, now } = await limitsNow($)

    codexLimits = await readCodex($, now)
    codexReadAt = now
    settle(limits, now)
    // Every five minutes, so use in the Codex app shows here too.
    refresher?.()
    refresher = $.clock.every(5 * 60 * 1000, () => {
      void readCodexNow($).then(read => {
        keepCodex(read)
        $.ui.invalidate('ui.render')
      })
    }).cancel
    // The strip above the box shows Codex now; clear the old status line.
    $.ui.status(undefined)

    return next(e)
  })

  // Claude answers again after Codex did: tell it what happened meanwhile.
  on('prompt.submit', async ($, e, next) => {
    if (codexTurns === 0 || mode === 'codex') {
      return next(e)
    }

    const { limits, now } = await limitsNow($)

    if (mode === 'auto' && exhausted(limits, now) !== undefined) {
      return next(e)
    }

    const changed = [...files]
    const note =
      `While Claude was unavailable, Codex (OpenAI) answered the last ${codexTurns} ` +
      `message${codexTurns === 1 ? '' : 's'} in this conversation; its replies are above. ` +
      (changed.length > 0 ? `It changed: ${changed.join(', ')}. ` : 'It changed no files. ') +
      'Check its work where it matters before building on it.'

    await notice(
      $,
      `Claude is back. It got a summary of what Codex did: ${codexTurns} repl${codexTurns === 1 ? 'y' : 'ies'}, ` +
        `${changed.length} file${changed.length === 1 ? '' : 's'} changed.`,
    )
    codexTurns = 0
    files.clear()
    isCodexActive = false

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', ($, e, next) => {
    prompts.set(e.turnId, e.text)
    lastPrompt = e.text

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || e.index > 0) {
      return yield* next(e)
    }

    // A voice row: Codex's spoken reply streams in as Codex talks; no model runs.
    const said = prompts.get(e.turnId)
    const queued = said === undefined ? undefined : feeds.get(said)
    const feed = queued?.shift()

    if (feed !== undefined) {
      if (queued?.length === 0 && said !== undefined) {
        feeds.delete(said)
      }

      let answer = `${VOICE_HEADER}\n\n`

      yield { kind: 'text', index: 0, text: answer }

      for await (const piece of feed.read()) {
        answer += piece
        yield { kind: 'text', index: 0, text: piece }
      }

      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }

      return result
    }

    const { limits, now } = await limitsNow($)
    const out = exhausted(limits, now)
    const isOnce = said !== undefined && once.delete(said)
    const isCodex = isOnce || mode === 'codex' || (mode === 'auto' && out !== undefined)

    settle(limits, now)
    $.ui.invalidate('ui.render')

    if (now - codexReadAt > 60000) {
      codexReadAt = now
      void readCodexNow($).then(read => {
        keepCodex(read)
        $.ui.invalidate('ui.render')
      })
    }

    if (!isCodex) {
      return yield* next(e)
    }

    const text = prompts.get(e.turnId) ?? ''
    const [cwd, read] = await Promise.all([$.session.cwd(), $.session.messages()])
    const rows: readonly SessionMessage[] = Array.isArray(read) ? read : []
    const last = rows.at(-1)
    const isNewPrompt = last?.role === 'user' && last.text.trim() === text.trim()
    const before = isNewPrompt ? rows.slice(0, -1) : rows
    const isFirst = threadId === undefined
    const context = (isFirst ? before : before.slice(Math.min(seen, before.length))).map(brief)
    const why = isOnce
      ? 'the user asked for you by name with /codex'
      : out !== undefined
        ? `the user's Claude ${kindLabel(out.kind)} usage limit ran out`
        : 'the user switched this conversation to you'

    if (!isCodexActive && !isOnce) {
      const handoff =
        out !== undefined
          ? `Claude's ${kindLabel(out.kind)} limit is used up (resets ${resetLabel(out.resetsAt)}). `
          : 'You switched this chat to Codex. '

      await notice(
        $,
        `${handoff}Codex picked up this conversation` +
          (isFirst ? ` with the last ${Math.min(context.length, 20)} messages` : '') +
          ' · your ChatGPT login',
      )
      isCodexActive = true
    }

    seen = rows.length
    // A one-off is the user's own ask; Claude is not told it was away.
    codexTurns += isOnce ? 0 : 1

    const prompt = buildPrompt({ isFirst, cwd, why, context, text })
    const run = $.process.spawn({
      argv: codexArgv(threadId, prompt, { model: codexModel, effort: effortWithin(codexEffort, offered()) }),
      cwd,
      input: '',
    })
    const header: TurnStepChunk = { kind: 'text', index: 0, text: `${HEADER}\n\n` }
    let answer = ''
    let pending = ''
    let wasActivity = false
    let error: string | undefined
    let stderr = ''
    let steps = 0
    const startedAt = await $.clock.now()

    yield header

    working = { startedAt, step: 'Thinking' }
    // Ten frames a second, the most the app redraws, for the working shimmer.
    ticker?.()
    ticker = $.clock.every(100, () => $.ui.invalidate('ui.render')).cancel
    $.ui.invalidate('ui.render')

    try {
      for await (const piece of run) {
        if (piece.stream === 'stderr') {
          stderr = (stderr + piece.text).slice(-2000)
          continue
        }

        pending += piece.text

        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          const event = readEvent(pending.slice(0, end))
          pending = pending.slice(end + 1)

          if (event.threadId !== undefined) {
            threadId = event.threadId
          }

          for (const file of event.files ?? []) {
            files.add(file)
          }

          if (event.error !== undefined) {
            error = event.error
          }

          if (event.show === undefined) {
            continue
          }

          const line = event.isActivity
            ? `${wasActivity ? '' : '\n'}- ${event.show}\n`
            : `${wasActivity ? '\n' : ''}${event.show}\n\n`

          wasActivity = event.isActivity === true
          steps += event.isActivity ? 1 : 0
          working = { startedAt, step: event.isActivity ? liveLine(event.show) : 'Writing the reply' }
          $.ui.invalidate('ui.render')
          answer += line
          yield { kind: 'text', index: 0, text: line }
        }
      }
    } finally {
      ticker?.()
      ticker = undefined
      working = undefined
      $.ui.invalidate('ui.render')
    }

    const ended = await run.result

    if (error !== undefined || (ended.code !== 0 && answer === '')) {
      const reason = error ?? (stderr.trim().split('\n').at(-1) || `codex exited with code ${ended.code}`)
      const piece = `\nCodex couldn't finish: ${reason}\n`

      answer += piece
      yield { kind: 'text', index: 0, text: piece }
    }

    // Codex's JSON leaves images out; they are in its folder for this thread.
    const made = threadId === undefined ? [] : await newImages($, threadId, startedAt)

    if (made.length > 0) {
      const piece = `\n${made.map(path => `![image](${path})`).join('\n')}\n`

      answer += piece
      yield { kind: 'text', index: 0, text: piece }
    }

    const took = duration((await $.clock.now()) - startedAt)

    // The turn spent some of Codex's limit; show it now, not on the next one.
    void readCodexNow($).then(read => {
      keepCodex(read)
      $.ui.invalidate('ui.render')
    })
    metas.set(keyOf(`${HEADER}\n\n${answer}`), `${steps} step${steps === 1 ? '' : 's'} · ${took}`)
    $.ui.invalidate('ui.render')

    yield { kind: 'stop', stopReason: 'end_turn', usage: null }

    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: `${HEADER}\n\n${answer}`,
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }

    return result
  })

  // A limit can run out in the middle of Claude's turn: send the message again
  // so Codex answers it, once.
  on('turn.complete', async ($, e, next) => {
    const asked = prompts.get(e.turnId)

    prompts.delete(e.turnId)

    // Work you passed to Claude by voice: its answer goes back to the voice.
    if (asked !== undefined && claudeTasks.delete(asked) && talkSocket !== undefined && e.answer.trim() !== '') {
      void $.http
        .fetch('http://localhost/speak', { method: 'POST', socketPath: talkSocket, body: speakable(e.answer) })
        .catch(() => undefined)
    }

    const done = await next(e)

    if (e.agentId !== undefined) {
      return done
    }

    const { limits, now } = await limitsNow($)

    settle(limits, now)
    $.ui.invalidate('ui.render')

    const out = exhausted(limits, now)

    if (e.reason !== 'error' || mode !== 'auto' || out === undefined || isRetrying || lastPrompt === undefined) {
      isRetrying = false

      return done
    }

    isRetrying = true
    $.ui.toast(`Claude's ${kindLabel(out.kind)} limit ran out. Codex is taking your message.`)
    void $.prompt.submit({ text: lastPrompt, asUser: true })

    return done
  })

  // A Codex reply: the mark and name, its steps as rows, then its words.
  // A Codex reply: the mark and name, its steps as rows, its words, its images.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || !isCodexReply(e.props.text)) {
      return next(e)
    }

    const { Box, Markdown, Svg, Text } = $.ui.resolve(e)
    const isVoice = isVoiceReply(e.props.text)
    const reply = readReply(isVoice ? HEADER + e.props.text.trimStart().slice(VOICE_HEADER.length) : e.props.text)
    const { words, images } = splitImages(reply.words)
    const meta = metas.get(keyOf(e.props.text))

    // A spoken reply that ended before Codex said anything leaves no row.
    if (isVoice && words === '' && images.length === 0) {
      return <Box />
    }

    wantPreviews($, images, previews)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {/* The Codex CLI's session header: ">_" in its accent color, then the name. */}
          <Text color="cyan">{'>_'}</Text>
          <Text bold>Codex</Text>
          {isVoice && <Text dimColor>· voice</Text>}
          {meta !== undefined && <Text dimColor>· {meta}</Text>}
        </Box>
        {reply.steps.length > 0 && (
          <Box flexDirection="column" paddingLeft={3}>
            {reply.steps.map(step => (
              <Text dimColor={!step.isFailed} color={step.isFailed ? 'red' : undefined}>
                {step.glyph}  {step.text}
              </Text>
            ))}
          </Box>
        )}
        {words !== '' && (
          <Box paddingLeft={3}>{isVoice ? <Text dimColor>{words}</Text> : <Markdown text={words} />}</Box>
        )}
        {images.map(path => {
          const preview = previews.get(path)
          const card = cardFor(path, preview)
          const name = path.split('/').at(-1) ?? path

          return (
            <Box key={`image-${path}`} flexDirection="column" paddingLeft={3} gap={0}>
              {card !== undefined && <Svg source={card.source} alt={`Image from Codex: ${name}`} width={card.width} height={card.height} />}
              {preview === undefined && <Text dimColor>Loading the image…</Text>}
              <Text dimColor>
                {preview ? `${preview.width}×${preview.height} · ` : ''}
                {path.replace(/^\/Users\/[^/]+/, '~')}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // What you said to Codex's voice, kept as a quiet row rather than a bubble.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const to = voiceRows.get(e.props.text.trim())

    if (e.surface !== 'desktop' || to === undefined) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    // A reply Codex spoke on its own shows only as Codex's row.
    if (to === 'hidden') {
      return <Box />
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{'\u{1F399}\uFE0E'}</Text>
        <Text bold dimColor>
          {to === 'claude' ? 'You → Claude' : 'You'}
        </Text>
        <Text dimColor>{e.props.text}</Text>
      </Box>
    )
  })

  // Claude's `codex` tool: the reply as Codex's card, its images drawn.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const images = e.props.tool === 'mcp__nightshift__codex' ? (toolImages.get(e.props.tool_use_id) ?? []) : []

    if (e.surface !== 'desktop' || e.props.isErrored || images.length === 0) {
      return next(e)
    }

    const { Box, Svg, Text } = $.ui.resolve(e)

    wantPreviews($, images, previews)

    return (
      <Box flexDirection="column" gap={1}>
        {images.map(path => {
          const preview = previews.get(path)
          const card = cardFor(path, preview)

          return (
            <Box key={`image-${path}`} flexDirection="column">
              {card !== undefined && <Svg source={card.source} alt={`Image from Codex: ${path.split('/').at(-1) ?? path}`} width={card.width} height={card.height} />}
              {preview === undefined && <Text dimColor>Loading the image…</Text>}
              <Text dimColor>
                {preview ? `${preview.width}×${preview.height} · ` : ''}
                {path.replace(/^\/Users\/[^/]+/, '~')}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // Tools set to Codex: Claude's browser and Mac-app tools say they are off and
  // wait behind ToolSearch, and the codex tool says it takes that work.
  on('tool.describe', async ($, e, next) => {
    if (toolsWorker !== 'codex') {
      return next(e)
    }

    if (HANDED_TOOLS.test(e.tool)) {
      return { description: HANDED_TOOL_NOTE, isDeferred: true }
    }

    if (e.tool === 'mcp__nightshift__codex') {
      const described = await next(e)

      return { ...described, description: `${described.description}${TOOLS_TO_CODEX}`, isDeferred: false }
    }

    return next(e)
  })

  // And a call that still reaches one of them is turned back to Codex.
  on('tool.call', async ($, e, next) => {
    if (toolsWorker === 'codex' && HANDED_TOOLS.test(e.tool)) {
      return { deny: HANDED_TOOL_NOTE }
    }

    return next(e)
  })

  // One Codex run's say on its browser steps. Asking: each step that changes
  // something waits on Allow or Deny above the strip; looking runs at once;
  // "Allow all" lets the rest of this run through. Auto: nothing waits.
  const browserDecider = (redraw: () => void) => {
    let isTrusted = false
    const mine = new Set<(allowed: boolean) => void>()

    return {
      decide: (call: BrowserCall): Promise<boolean> => {
        if (browserAccess === 'auto' || isTrusted || isLookOnly(call)) {
          return Promise.resolve(true)
        }

        return new Promise<boolean>(resolve => {
          const answer = (allowed: boolean) => {
            mine.delete(answer)
            asks.splice(
              asks.findIndex(ask => ask.answer === answer),
              1,
            )
            redraw()
            resolve(allowed)
          }

          mine.add(answer)
          asks.push({
            call,
            answer,
            allowRest: () => {
              isTrusted = true
              answer(true)
            },
          })
          redraw()
        })
      },
      // The run is over: anything still waiting is declined and leaves the strip.
      drop: () => {
        for (const answer of [...mine]) {
          answer(false)
        }
      },
    }
  }

  on('tool.call', { tool: 'mcp__nightshift__codex' }, async ($, e) => {
    // The tool's arguments ride on the event itself, beside `tool` and its id.
    const input = e as unknown as { prompt?: unknown; images?: unknown }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const images = Array.isArray(input.images) ? input.images.filter((path): path is string => typeof path === 'string') : []

    if (prompt === '') {
      return { deny: 'Give Codex a prompt.' }
    }

    // Codex browses in Claude's browser pane, through the bridge, for this run.
    const socket = `${await privateDir($)}nightshift-browser-${(await $.clock.now()).toString(36)}.sock`
    const decider = browserDecider(() => $.ui.invalidate('ui.render'))
    let isRunning = true
    const pump = pumpBrowser($, socket, decider.decide, () => isRunning)
    let ran: Awaited<ReturnType<typeof runCodexTool>>

    try {
      ran = await runCodexTool(
        $,
        { prompt: `${prompt}${BROWSER_NOTE}`, images },
        { model: codexModel, effort: effortWithin(codexEffort, offered()), config: browserConfig($.plugin.root, socket) },
      )
    } finally {
      isRunning = false
      decider.drop()
    }

    void pump

    for (const [at, path] of ran.images.entries()) {
      const preview = ran.previews[at]

      if (preview !== undefined) {
        previews.set(path, preview)
      }
    }

    toolImages.set(e.tool_use_id, ran.images)
    void readCodexNow($).then(read => {
      keepCodex(read)
      $.ui.invalidate('ui.render')
    })

    // Blocks the engine hands the model as they are: the text, then each image.
    return {
      result: [
        { type: 'text', text: ran.text },
        ...ran.previews.map(preview => ({ type: 'image', data: preview.data, mimeType: 'image/jpeg' })),
      ],
    }
  })

  // While Codex works, the spinner says what it is doing; the strip animates.
  on('ui.render', { component: 'Spinner' }, ($, e, next) =>
    working === undefined ? next(e) : next({ ...e, props: { ...e.props, message: `Codex · ${working.step}` } }),
  )

  // The Codex strip above the box: the mark, its 7-day meter, and while it
  // answers, the shimmer, the ripple and a way back to Claude.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The strip holds controls, so it shows even before Codex's limit is known.
    if (e.props.hasSurvey) {
      return next(e)
    }

    const now = await $.clock.now()
    // Read at each draw, so a week that reset while idle starts again at zero.
    const { week, weekResetsAt } = currentWeek(codexLimits, now)
    const isWorking = working !== undefined
    const title = isWorking ? (working?.step ?? 'Thinking') : 'Codex'
    // While Codex covers for a spent Claude limit, say when Claude is back;
    // once that time has passed, the next message goes to Claude.
    const isClaudeOut = lastOut !== undefined && (lastOut.resetsAt === undefined || Date.parse(lastOut.resetsAt) > now)
    const note = mode === 'auto' && isClaudeOut ? `Claude back ${resetLabel(lastOut?.resetsAt)}` : undefined
    const weekReset = weekResetsAt === undefined ? undefined : resetLabel(new Date(weekResetsAt).toISOString())
    const back = () => {
      mode = 'auto'
      isCodexOn = lastOut !== undefined
      $.ui.invalidate('ui.render')
    }

    const pickEffort = async (effort: CodexEffort) => {
      codexEffort = effort
      $.ui.invalidate('ui.render')
      await $.store.set('codexEffort', effort)
    }
    const pickModel = async (model: string) => {
      codexModel = model
      $.ui.invalidate('ui.render')
      await $.store.set('codexModel', model)
    }
    const choices = models.map(model => ({ value: model.slug, label: model.name }))
    const levels = offered()
    const current = effortWithin(codexEffort, levels)

    // Talk: Codex's live voice. The bridge runs while the loop reads it; each
    // finished exchange is kept in the chat as your words and Codex's reply.
    const startTalk = async () => {
      if (talk.phase !== 'off') {
        return
      }

      const [cwd, at, dir] = await Promise.all([$.session.cwd(), $.clock.now(), privateDir($)])
      const socket = `${dir}nightshift-voice-${at.toString(36)}.sock`
      const browserSocket = `${dir}nightshift-browser-${at.toString(36)}v.sock`
      const run = $.process.spawn({
        argv: voiceArgv($.plugin.root, cwd, socket, voiceWorker, browserSocket, {
          model: codexModel,
          effort: effortWithin(codexEffort, offered()),
        }),
        cwd,
        input: '',
      })
      // What Codex browses while you talk shows in Claude's browser pane too.
      const decider = browserDecider(() => $.ui.invalidate('ui.render'))
      let isTalking = true
      const pump = pumpBrowser($, browserSocket, decider.decide, () => isTalking)
      let pending = ''
      let failure: string | undefined
      let drawn = ''

      // The reply Codex is speaking, streaming into its chat row. It ends a
      // moment after Codex stops, when you speak again, or when the call ends.
      let reply: VoiceFeed | undefined
      let heard = 0
      const endReply = () => {
        reply?.close()
        reply = undefined
      }
      const openReply = (text: string, row: Worker | 'hidden'): VoiceFeed => {
        endReply()

        const fresh = new VoiceFeed()

        feeds.set(text, [...(feeds.get(text) ?? []), fresh])
        voiceRows.set(text, row)
        void $.prompt.submit({ text, asUser: true })
        reply = fresh

        return fresh
      }

      talk = { ...QUIET, phase: 'connecting' }
      talkSocket = socket
      talkRun = run
      $.ui.invalidate('ui.render')

      try {
        for await (const piece of run) {
          if (piece.stream === 'stderr') {
            continue
          }

          pending += piece.text

          for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const event = readBridge(pending.slice(0, end))

            pending = pending.slice(end + 1)

            if (event === undefined) {
              continue
            }

            talk = hear(talk, event)

            if (event.t === 'state' && event.error !== undefined) {
              failure = event.error
            }

            // Your words land as a row the moment you finish; speaking again
            // closes the reply before it.
            if (event.t === 'caption' && event.role === 'user') {
              if (event.final) {
                openReply(event.text, 'codex')
              } else if (reply?.hasWords) {
                endReply()
              }
            }

            // Codex's words stream into the open reply, or open one of their own.
            if (event.t === 'caption' && event.role === 'assistant') {
              const into = reply ?? openReply(SPOKE, 'hidden')
              const mark = ++heard

              into.assistant(event.text, event.final)

              if (event.final) {
                $.clock.after(1500, () => {
                  if (heard === mark && reply === into) {
                    endReply()
                  }
                })
              }
            }

            if (event.t === 'image') {
              ;(reply ?? openReply(SPOKE, 'hidden')).image(event.path)
            }

            // Work you want Claude to do: Codex's reply closes, then Claude takes it.
            if (event.t === 'claude' && event.task !== '') {
              endReply()
              claudeTasks.add(event.task)
              voiceRows.set(event.task, 'claude')
              void $.prompt.submit({ text: event.task, asUser: true })
            }

            if (event.t === 'state' && event.phase === 'ended') {
              endReply()
            }

            // A redraw re-runs every Nightshift row in the chat, so the strip redraws
            // only when what it shows changes: not for each word of the call.
            const shown = `${talk.phase}|${talk.muted}|${talkState(talk)}`

            if (shown !== drawn) {
              drawn = shown
              $.ui.invalidate('ui.render')
            }
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      endReply()
      talk = QUIET
      talkSocket = undefined
      talkRun = undefined
      isTalking = false
      decider.drop()
      void pump
      $.ui.invalidate('ui.render')

      if (failure !== undefined) {
        $.ui.toast(`Codex voice stopped: ${failure}`)
      }
    }
    // The voice bridge's three controls, each one fixed local address on its
    // Unix socket; a bridge that is already gone ends the loop on its own.
    const toggleMute = async () => {
      talk = { ...talk, muted: !talk.muted }
      $.ui.invalidate('ui.render')

      if (talkSocket !== undefined) {
        await $.http
          .fetch('http://localhost/mute', { method: 'POST', socketPath: talkSocket, body: talk.muted ? 'on' : 'off' })
          .catch(() => undefined)
      }
    }
    // End shows at once; if the bridge has not closed in four seconds, Nightshift
    // leaves its loop, which stops the bridge and everything it runs.
    const endTalk = async () => {
      const run = talkRun

      talk = { ...talk, phase: 'ending' }
      $.ui.invalidate('ui.render')
      if (talkSocket !== undefined) {
        await $.http.fetch('http://localhost/end', { method: 'POST', socketPath: talkSocket }).catch(() => undefined)
      }

      $.clock.after(4000, () => {
        if (talkRun !== undefined && talkRun === run) {
          void run?.return({ code: null, signal: 'SIGTERM' } as never)
        }
      })
    }
    // Tools: Claude, Codex (asks before browser steps), or Codex, auto.
    const pickTools = async (choice: string) => {
      toolsWorker = choice === 'claude' ? 'claude' : 'codex'
      browserAccess = choice === 'codex-auto' ? 'auto' : 'ask'
      $.ui.invalidate('tool.describe')
      $.ui.invalidate('ui.render')
      await Promise.all([$.store.set('toolsWorker', toolsWorker), $.store.set('browserAccess', browserAccess)])
    }
    const toolsChoice = toolsWorker === 'claude' ? 'claude' : browserAccess === 'auto' ? 'codex-auto' : 'codex'
    const pickWorker = async (worker: Worker) => {
      voiceWorker = worker
      $.ui.invalidate('ui.render')
      await $.store.set('voiceWorker', worker)

      if (talkSocket !== undefined) {
        await $.http.fetch('http://localhost/route', { method: 'POST', socketPath: talkSocket, body: worker }).catch(() => undefined)
      }
    }

    // Only real controls: effort and model dropdowns, the limit meter, the
    // Tools switch and Talk.
    if (e.surface === 'desktop') {
      const { Box, Button, Select, Svg, Text } = $.ui.resolve(e)
      const elapsed = working === undefined ? 0 : now - working.startedAt
      const meter =
        week === undefined
          ? undefined
          : limitTiles({ percent: week, elapsed: weekElapsed(weekResetsAt, now), reset: weekReset, width: STRIP_METER_WIDTH })
      const logo = logoDots(26)
      const colors = shimmerColors(title, elapsed)
      const ask = asks[0]
      // Codex asking for a browser step: Allow, Allow all, Deny, above the strip.
      const framed = (strip: RenderElement): RenderElement =>
        ask === undefined ? (
          strip
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box key="ask" flexDirection="row" alignItems="center" gap={2} paddingX={1}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                <Text bold>Codex wants to use Claude's browser</Text>
                <Text dimColor wrap="truncate-end">
                  {browserStep(ask.call)}
                  {asks.length > 1 ? ` · ${asks.length - 1} more waiting` : ''}
                </Text>
              </Box>
              <Box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
                <Button key="ask-allow" label="Allow" variant="primary" onPress={() => ask.answer(true)} />
                <Button key="ask-all" plain label="Allow all" onPress={ask.allowRest} />
                <Button key="ask-deny" plain dimColor label="Deny" onPress={() => ask.answer(false)} />
              </Box>
            </Box>
            {strip}
          </Box>
        )

      // While talking, the strip is the call: state, captions, level, Mute, End.
      if (talk.phase !== 'off') {
        const state = talkState(talk)
        const tones = shimmerColors(state, now)
        const wave = liveWave(talk.muted)
        const isLive = talk.phase === 'live'

        // The call itself: the mark and a short state word, then level, who
        // works, Mute and End. What was said is in the chat, not here.
        return framed(
          <Box flexDirection="row" alignItems="center" gap={3} paddingX={1}>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
              <Svg source={logo.source} alt="Codex" width={logo.width} height={26} />
              <Box flexDirection="row">
                {[...state].map((char, at) => (
                  <Text bold color={tones[at]}>
                    {char === ' ' ? '\u00a0' : char}
                  </Text>
                ))}
              </Box>
            </Box>
            <Box flexGrow={1} />
            <Box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
              {isLive && (
                <Svg key="live" source={wave.source} alt={talk.muted ? 'Muted' : 'Live'} width={25} height={16} isInteractive={wave.isInteractive} />
              )}
              {isLive && (
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Text dimColor>Work:</Text>
                  {(['codex', 'claude'] as const).map(worker =>
                    worker === voiceWorker ? (
                      <Button key={`worker-${worker}`} label={worker === 'codex' ? 'Codex' : 'Claude'} variant="primary" onPress={() => pickWorker(worker)} />
                    ) : (
                      <Button key={`worker-${worker}`} plain dimColor label={worker === 'codex' ? 'Codex' : 'Claude'} onPress={() => pickWorker(worker)} />
                    ),
                  )}
                </Box>
              )}
              {isLive && <Button key="mute" plain dimColor label={talk.muted ? 'Unmute' : 'Mute'} onPress={toggleMute} />}
              {talk.phase !== 'ending' && <Button key="end" label="End" variant="primary" onPress={endTalk} />}
            </Box>
          </Box>
        )
      }

      // Every control keeps its size; only the meter gives way when the window
      // is narrow, so nothing overlaps.
      return framed(
        <Box flexDirection="row" alignItems="center" gap={2} paddingX={1}>
          <Box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
            <Svg source={logo.source} alt="Codex" width={logo.width} height={26} />
            {isWorking ? (
              <Box flexDirection="row">
                <Text color={bulletColor(elapsed)}>{'\u2022\u00a0'}</Text>
                {[...title].map((char, at) => (
                  <Text color={colors[at]}>{char === ' ' ? '\u00a0' : char}</Text>
                ))}
              </Box>
            ) : (
              <Text bold>Codex</Text>
            )}
          </Box>
          <Box flexShrink={0}>
            <Select
              key="effort"
              options={levels.map(effort => ({ value: effort, label: EFFORT_LABELS[effort] }))}
              value={current}
              onSelect={value => pickEffort(asEffort(value) ?? current)}
            />
          </Box>
          {choices.length > 0 && (
            <Box flexShrink={0}>
              <Select key="model" options={choices} value={codexModel} onSelect={pickModel} />
            </Box>
          )}
          {meter !== undefined && (
            <Box key="limit" flexShrink={1} minWidth={0}>
              <Svg
                source={meter.source}
                alt={`Codex 7-day limit: ${100 - Math.round(week ?? 0)}% left${weekReset === undefined ? '' : `, resets ${weekReset}`}`}
                width={meter.width}
                height={26}
              />
            </Box>
          )}
          {note !== undefined && <Text dimColor>{note}</Text>}
          <Box flexGrow={1} />
          <Box flexDirection="row" alignItems="center" gap={2} flexShrink={0}>
            {mode === 'codex' && <Button key="back" label="Back to Claude" onPress={back} />}
            <Select
              key="tools"
              options={[
                { value: 'claude', label: 'Tools: Claude' },
                { value: 'codex', label: 'Tools: Codex' },
                { value: 'codex-auto', label: 'Tools: Codex · auto' },
              ]}
              value={toolsChoice}
              onSelect={pickTools}
            />
            <Button key="talk" label="Talk" onPress={startTalk} />
          </Box>
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>{`>_ ${title}`}</Text>
        {levels.map((effort, at) => (
          <Button key={`effort-${effort}`} plain label={EFFORT_LABELS[effort]} hotkey={String(at + 1)} dimColor={effort !== current} onPress={() => pickEffort(effort)} />
        ))}
        {week !== undefined && <Text dimColor>· 7d {100 - Math.round(week)}% left</Text>}
        {note !== undefined && <Text dimColor>· {note}</Text>}
        {mode === 'codex' && <Button key="back" label="Back to Claude" hotkey="b" onPress={back} />}
        <Button
          key="tools"
          plain
          label={toolsChoice === 'claude' ? 'Tools: Claude' : toolsChoice === 'codex' ? 'Tools: Codex' : 'Tools: Codex · auto'}
          hotkey="o"
          onPress={() => pickTools(toolsChoice === 'claude' ? 'codex' : toolsChoice === 'codex' ? 'codex-auto' : 'claude')}
        />
        {asks[0] !== undefined && <Text dimColor>· Codex wants: {browserStep(asks[0].call)}</Text>}
        {asks[0] !== undefined && <Button key="ask-allow" plain label="Allow" hotkey="a" onPress={() => asks[0]?.answer(true)} />}
        {asks[0] !== undefined && <Button key="ask-deny" plain label="Deny" hotkey="d" onPress={() => asks[0]?.answer(false)} />}
        {talk.phase === 'off' && <Button key="talk" plain label="Talk" hotkey="t" onPress={startTalk} />}
        {talk.phase !== 'off' && (
          <Text dimColor>· {talk.phase === 'connecting' ? 'connecting' : talk.codex || talk.you || 'listening'}</Text>
        )}
        {talk.phase === 'live' && <Button key="mute" plain label={talk.muted ? 'Unmute' : 'Mute'} hotkey="m" onPress={toggleMute} />}
        {talk.phase !== 'off' && <Button key="end" plain label="End" hotkey="e" onPress={endTalk} />}
      </Box>
    )
  })

  // `/codex <prompt>`: Codex answers this one message here, whatever the mode.
  on('command.run', { command: 'codex' }, async ($, e) => {
    const prompt = e.args.trim()

    if (prompt === '') {
      return { text: 'Usage: /codex <prompt>. For an image, start with $imagegen.' }
    }

    once.add(prompt)
    // A command cannot submit while it holds the turn; a moment later it can.
    $.clock.after(10, () => void $.prompt.submit({ text: prompt, asUser: true }))

    return { text: '' }
  })

  on('command.run', { command: 'nightshift' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [verb, value = ''] = arg.split(/\s+/)

    if (verb === 'tools') {
      if (value !== 'codex' && value !== 'claude' && value !== 'auto') {
        return {
          text: `Tools are set to ${toolsWorker === 'claude' ? 'Claude' : browserAccess === 'auto' ? 'Codex, auto' : 'Codex'}. Use /nightshift tools claude, codex or auto.`,
        }
      }

      toolsWorker = value === 'claude' ? 'claude' : 'codex'
      browserAccess = value === 'auto' ? 'auto' : 'ask'
      await Promise.all([$.store.set('toolsWorker', toolsWorker), $.store.set('browserAccess', browserAccess)])
      $.ui.invalidate('tool.describe')
      $.ui.invalidate('ui.render')

      return {
        text:
          value === 'claude'
            ? 'Tools are set to Claude: Claude uses its own browser and computer-use tools again.'
            : `Tools are set to Codex: browsing (in Claude's browser pane), Mac apps, images and documents go to Codex. Code and the shell stay with Claude. ${
                value === 'auto' ? 'Its browser steps run without asking.' : 'Its browser steps that change something ask here first.'
              }`,
      }
    }

    if (verb === 'effort') {
      const effort = asEffort(value)

      if (effort === undefined) {
        return { text: `Codex effort is ${EFFORT_LABELS[codexEffort]}. Use /nightshift effort light, medium, high, xhigh or max.` }
      }

      codexEffort = effort
      await $.store.set('codexEffort', effort)
      $.ui.invalidate('ui.render')

      return { text: `Codex now thinks at ${EFFORT_LABELS[effort]}.` }
    }

    if (verb === 'model') {
      const found = models.find(model => model.slug === value || model.name.toLowerCase() === value)

      if (found === undefined) {
        return { text: `Codex uses ${codexModel ?? 'its default'}. Models: ${models.map(model => model.slug).join(', ')}.` }
      }

      codexModel = found.slug
      await $.store.set('codexModel', found.slug)
      $.ui.invalidate('ui.render')

      return { text: `Codex now uses ${found.name}.` }
    }

    if (arg === 'auto' || arg === 'codex' || arg === 'claude') {
      mode = arg

      const { limits, now } = await limitsNow($)

      settle(limits, now)
        $.ui.invalidate('ui.render')

      const said = {
        auto: 'Nightshift is on auto: Codex answers only while your Claude limit is used up.',
        codex: 'Codex answers from your next message. /nightshift auto switches back.',
        claude: 'Claude answers every message, even past the limit. /nightshift auto turns the handoff back on.',
      }

      return { text: said[arg] }
    }

    const { limits, now } = await limitsNow($)
    const windows =
      limits.length === 0
        ? 'No limit readings yet; they arrive with the next Claude reply.'
        : limits
            .map(limit => `- ${kindLabel(limit.kind)}: ${Math.round(limit.percentUsed)}%, resets ${resetLabel(limit.resetsAt)}`)
            .join('\n')

    return {
      text: [
        `Nightshift is on ${mode}. Commands: /nightshift auto, /nightshift codex, /nightshift claude.`,
        '',
        'Claude limits:',
        windows,
        '',
        threadId === undefined
          ? 'Codex has not answered in this session yet.'
          : `Codex has answered ${codexTurns} message${codexTurns === 1 ? '' : 's'} since Claude last did.`,
      ].join('\n'),
    }
  })
}
