// Codex's live voice and its images, as Nightshift shows them in Claude's window.
// The voice itself runs in voice.mjs; this is what Nightshift reads from it, and
// how Codex's pictures become cards in the chat.

/** What the voice bridge says, one JSON line at a time. */
export type BridgeEvent =
  | { t: 'state'; phase: 'connecting' | 'live' | 'ended'; error?: string }
  | { t: 'caption'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { t: 'work'; text: string }
  | { t: 'image'; path: string }
  | { t: 'exchange'; you: string; codex: string; images: string[] }
  | { t: 'claude'; task: string; you: string }

/** Who does the work the voice is asked for. */
export type Worker = 'codex' | 'claude'

export function readBridge(line: string): BridgeEvent | undefined {
  try {
    const event = JSON.parse(line) as { t?: unknown }

    return typeof event.t === 'string' ? (event as BridgeEvent) : undefined
  } catch {
    return undefined
  }
}

/** Node through a login shell, as Nightshift runs codex, so the user's PATH holds. */
export function voiceArgv(
  root: string,
  cwd: string,
  socket: string,
  worker: Worker,
  browserSocket: string,
  choice: { model?: string; effort?: string } = {},
): string[] {
  return [
    '/bin/zsh',
    '-lc',
    'exec node "$@"',
    'node',
    `${root}/hooks/voice.mjs`,
    cwd,
    socket,
    worker,
    browserSocket,
    choice.model ?? '-',
    choice.effort ?? '-',
  ]
}

/** The voice strip's state, from what the bridge has said. */
export type Talk = {
  phase: 'off' | 'connecting' | 'live' | 'ending'
  muted: boolean
  you: string
  codex: string
  work: string
}

export const QUIET: Talk = { phase: 'off', muted: false, you: '', codex: '', work: '' }

export function hear(talk: Talk, event: BridgeEvent): Talk {
  switch (event.t) {
    case 'state':
      return event.phase === 'ended' ? QUIET : talk.phase === 'ending' ? talk : { ...talk, phase: event.phase }
    case 'caption':
      return event.role === 'user' ? { ...talk, you: event.text, codex: event.final ? talk.codex : '' } : { ...talk, codex: event.text }
    case 'work':
      return { ...talk, work: event.text }
    default:
      return talk
  }
}

/**
 * The live mark: five bars that move on their own while the call is live and
 * lie flat when muted. It animates inside its own frame, so the app never
 * redraws for it; a redraw re-runs every Nightshift row in the chat.
 */
export function liveWave(isMuted: boolean): { source: string; isInteractive: boolean } {
  const heights = [5, 9, 14, 10, 6]
  // A frame of its own takes the page's color scheme, with no default margin.
  const frame = '<style>:root{color-scheme:light dark}html,body,svg{margin:0}</style>'
  const bar = (height: number, at: number) => {
    const rest = 3
    const y = (16 - (isMuted ? rest : height)) / 2

    if (isMuted) {
      return `<rect x="${at * 5}" y="${y}" width="3" height="${rest}" rx="1.5" fill="#8a8984"/>`
    }

    const low = Math.max(rest, Math.round(height * 0.35))
    const values = `${height};${low};${height}`
    const ys = `${(16 - height) / 2};${(16 - low) / 2};${(16 - height) / 2}`
    const timing = `dur="${(0.9 + at * 0.13).toFixed(2)}s" begin="-${(at * 0.21).toFixed(2)}s" repeatCount="indefinite"`

    return (
      `<rect x="${at * 5}" y="${y}" width="3" height="${height}" rx="1.5" fill="#d4d4ce">` +
      `<animate attributeName="height" values="${values}" ${timing}/>` +
      `<animate attributeName="y" values="${ys}" ${timing}/>` +
      '</rect>'
    )
  }

  return {
    isInteractive: !isMuted,
    source:
      '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="16" viewBox="0 0 25 16">' +
      (isMuted ? '' : frame) +
      heights.map(bar).join('') +
      '</svg>',
  }
}

/** The strip's state word: short, so the captions keep their room. */
export function talkState(talk: Talk): string {
  const state =
    talk.phase === 'connecting'
      ? 'Connecting'
      : talk.phase === 'ending'
        ? 'Ending'
        : talk.muted
          ? 'Muted'
          : talk.work !== ''
            ? talk.work
            : 'Listening'

  return state.length > 22 ? `${state.slice(0, 21)}…` : state
}

/** Claude's answer as the voice can say it: plain words, about a paragraph. */
export function speakable(answer: string): string {
  const plain = answer
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>*\-\s|]+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (plain.length <= 600) {
    return plain
  }

  const cut = plain.slice(0, 600)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))

  return end > 200 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`
}

// --- images ----------------------------------------------------------------

/** A spoken exchange as the chat keeps it: Codex's words, then its images. */
export const VOICE_HEADER = '**Codex** (voice)'

export function voiceReply(codex: string, images: readonly string[]): string {
  const words = codex.trim() === '' ? '' : `${codex.trim()}\n\n`

  return `${VOICE_HEADER}\n\n${words}${images.map(path => `![image](${path})`).join('\n')}`.trim()
}

export function isVoiceReply(text: string): boolean {
  return text.trimStart().startsWith(VOICE_HEADER)
}

const IMAGE_LINE = /^!\[[^\]]*\]\((\/[^)]+\.(?:png|jpe?g|webp))\)$/

/** Splits the image lines out of a reply's markdown. */
export function splitImages(markdown: string): { words: string; images: string[] } {
  const images: string[] = []
  const words: string[] = []

  for (const line of markdown.split('\n')) {
    const found = IMAGE_LINE.exec(line.trim())

    if (found?.[1] !== undefined) {
      images.push(found[1])
    } else {
      words.push(line)
    }
  }

  return { words: words.join('\n').trim(), images }
}

/**
 * Prints an image's size, then a JPEG preview as base64 small enough for a
 * card (a mod's SVG holds 131,072 characters): 640px first, smaller if not.
 */
export const PREVIEW_SCRIPT =
  'file=$1; out=$(mktemp -t nightshift-preview).jpg; ' +
  "size=$(sips -g pixelWidth -g pixelHeight $file 2>/dev/null | awk '/pixel/{print $2}' | tr '\\n' ' '); " +
  'for spec in "640 72" "512 62" "400 55" "320 50"; do ' +
  'edge=${spec% *}; quality=${spec#* }; ' +
  'sips -Z $edge -s format jpeg -s formatOptions $quality $file --out $out >/dev/null 2>&1 || exit 1; ' +
  "data=$(base64 -i $out | tr -d '\\n'); (( ${#data} <= 110000 )) && break; done; " +
  'rm -f $out; print -r -- $size; print -r -- $data'

export type Preview = { data: string; width: number; height: number }

export function readPreview(stdout: string): Preview | undefined {
  const [size = '', data = ''] = stdout.trim().split('\n')
  const [width, height] = size.trim().split(/\s+/).map(Number)

  if (!width || !height || data.length < 100 || data.length > 120000) {
    return undefined
  }

  return { data, width, height }
}

/** The picture of an image card: the preview, corners rounded, at most 396 by 300. */
export function imageCard(preview: Preview, maxWidth = 396, maxHeight = 300): { source: string; width: number; height: number } {
  const scale = Math.min(maxWidth / preview.width, maxHeight / preview.height)
  const width = Math.round(preview.width * scale)
  const height = Math.round(preview.height * scale)

  return {
    width,
    height,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<defs><clipPath id="r"><rect width="${width}" height="${height}" rx="8"/></clipPath></defs>` +
      `<image href="data:image/jpeg;base64,${preview.data}" width="${width}" height="${height}" clip-path="url(#r)" preserveAspectRatio="xMidYMid slice"/>` +
      '</svg>',
  }
}

/** The PNGs a Codex thread saved since `sinceSeconds`, oldest first. */
export function imagesScript(threadId: string, sinceSeconds: number): string[] {
  const safe = threadId.replace(/[^A-Za-z0-9_-]/g, '_')

  return [
    '/bin/zsh',
    '-c',
    'setopt nullglob; for f in ~/.codex/generated_images/$1/*.png(Om); do (( $(stat -f %m $f) >= $2 )) && print -r -- $f; done',
    'nightshift',
    safe,
    String(Math.floor(sinceSeconds)),
  ]
}

export const CODEX_TOOL_DESCRIPTION =
  "Runs a task with OpenAI Codex on the user's own ChatGPT plan and returns Codex's reply, plus any images it made " +
  '(you see them, and the user sees them in the chat). Use it when the user asks for an image (new, or an edit of one ' +
  'you pass in `images`; start the prompt with `$imagegen`), or asks to use one of Codex\'s tools or plugins by name: ' +
  "`@chrome` drives the user's own Chrome, signed in; `@computer-use` works Mac apps; documents, pdf, presentations " +
  'and spreadsheets make files. Write the prompt as a complete brief; Codex sees nothing else of this chat. ' +
  'It runs in the project folder and can write files there. Takes about a minute for an image or a browser task.'

/** Claude's own browser and Mac-app tools, which Codex takes over when Tools is Codex. */
export const HANDED_TOOLS = /^mcp__(Claude_Browser|claude-in-chrome|computer-use)__/

export const TOOLS_TO_CODEX =
  ' Tools are set to Codex: use this tool for all browser work (begin the prompt with `@chrome`), for Mac apps ' +
  '(`@computer-use`), for images (`$imagegen`) and for documents, slides and spreadsheets. Your own browser and ' +
  'computer-use tools are off. Code, files and the shell stay yours.'

export const HANDED_TOOL_NOTE =
  'Off: the user set Tools to Codex. Do this through mcp__nightshift__codex instead (begin the prompt with @chrome for ' +
  'the browser, @computer-use for Mac apps).'

export const CODEX_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'The complete brief for Codex' },
    images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of images to attach, for edits' },
  },
  required: ['prompt'],
} as const

// --- Codex in Claude's browser pane ----------------------------------------

/** One browser step Codex asks for, as the bridge hands it to Nightshift. */
export type BrowserCall = { id: number; tool: string; args: Record<string, unknown> }

/** How much Nightshift asks before Codex's browser steps run in Claude's pane. */
export type BrowserAccess = 'ask' | 'auto'

/** The step in words, for the Allow / Deny row: "Open producthunt.com". */
export function browserStep(call: BrowserCall): string {
  const args = call.args
  const said = typeof args.action_summary === 'string' && args.action_summary.trim() !== '' ? args.action_summary.trim() : undefined
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  const clip = (value: string) => (value.length > 60 ? `${value.slice(0, 59)}…` : value)

  switch (call.tool) {
    case 'navigate': {
      const url = text(args.url)

      if (url === 'back' || url === 'forward') {
        return `Go ${url}`
      }

      try {
        return `Open ${new URL(url).host.replace(/^www\./, '')}`
      } catch {
        return `Open ${clip(url)}`
      }
    }
    case 'get_page_text':
      return 'Read the page text'
    case 'read_page':
      return 'Read the page'
    case 'find':
      return `Find “${clip(text(args.query))}”`
    case 'form_input':
      return said ?? 'Fill in a form field'
    case 'tabs_context':
      return 'List the tabs'
    case 'tabs_create':
      return 'Open a new tab'
    case 'computer': {
      const action = text(args.action)

      if (said !== undefined) {
        return said
      }

      return action === 'screenshot'
        ? 'Take a screenshot'
        : action === 'type'
          ? `Type “${clip(text(args.text))}”`
          : action === 'key'
            ? `Press ${clip(text(args.text))}`
            : action.includes('click')
              ? 'Click on the page'
              : action === 'scroll' || action === 'scroll_to'
                ? 'Scroll the page'
                : `${action || 'Use'} the page`
    }
    default:
      return call.tool
  }
}

/** Steps that only look: auto-allowed even when asking would be too much. */
export function isLookOnly(call: BrowserCall): boolean {
  return (
    ['get_page_text', 'read_page', 'find', 'tabs_context'].includes(call.tool) ||
    (call.tool === 'computer' && ['screenshot', 'wait', 'zoom', 'scroll', 'scroll_to', 'hover'].includes(String(call.args.action)))
  )
}

export function readCall(text: string): BrowserCall | undefined {
  try {
    const call = JSON.parse(text) as Partial<BrowserCall>

    return typeof call.id === 'number' && typeof call.tool === 'string'
      ? { id: call.id, tool: call.tool, args: (call.args ?? {}) as Record<string, unknown> }
      : undefined
  } catch {
    return undefined
  }
}

// --- Codex's voice, live in the chat ------------------------------------------

/** The row a reply Codex speaks on its own opens with; the chat hides it. */
export const SPOKE = '(Codex spoke)'

/**
 * One spoken reply on its way into the chat. The voice bridge feeds it as
 * Codex talks; the chat row reads it as it fills, and closes with the images.
 */
export class VoiceFeed {
  private chunks: string[] = []
  private images: string[] = []
  private segment = ''
  private segments = 0
  private isClosed = false
  private wake: (() => void) | undefined

  /** Codex's words so far in this part of the reply (each caption repeats the whole part). */
  assistant(text: string, isFinal: boolean): void {
    if (this.isClosed) {
      return
    }

    const lead = this.segment === '' && this.segments > 0 ? ' ' : ''
    const fresh = text.startsWith(this.segment) ? text.slice(this.segment.length) : ''

    if (fresh !== '') {
      this.push(`${lead}${fresh}`)
      this.segment = text
    }

    if (isFinal) {
      this.segment = ''
      this.segments += 1
    }
  }

  image(path: string): void {
    if (!this.isClosed && !this.images.includes(path)) {
      this.images.push(path)
      this.notify()
    }
  }

  close(): void {
    this.isClosed = true
    this.notify()
  }

  get closed(): boolean {
    return this.isClosed
  }

  /** Whether Codex has said anything in this reply yet. */
  get hasWords(): boolean {
    return this.segments > 0 || this.segment !== ''
  }

  /** The words as they come, then each image as its own markdown line. */
  async *read(): AsyncGenerator<string> {
    let shown = 0

    for (;;) {
      while (this.chunks.length > 0) {
        yield this.chunks.shift() ?? ''
      }

      while (shown < this.images.length) {
        yield `\n\n![image](${this.images[shown]})`
        shown += 1
      }

      if (this.isClosed && this.chunks.length === 0 && shown === this.images.length) {
        return
      }

      await new Promise<void>(resolve => {
        this.wake = resolve
      })
    }
  }

  private push(text: string): void {
    this.chunks.push(text)
    this.notify()
  }

  private notify(): void {
    const wake = this.wake

    this.wake = undefined
    wake?.()
  }
}
