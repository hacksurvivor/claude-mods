import type { Entry } from '../types'

export const NOTE_TOOL = 'note'
export const NOTE_TOOL_ID = 'mcp__grudge__note'
export const RULES_SHOWN = 25

const REJECTED =
  /\bslop|\bugly\b|\blooks? (bad|off|wrong|weird|cheap|awful|terrible|shit|sloppy|old)\b|\bdon'?t like\b|\bnot (right|correct|good enough)\b|\bdoesn'?t look\b|\bregress|\bold (design|look|style)\b|\bwtf\b|не нравится|некрасив|убог|криво|выглядит (плохо|странно|дёшево|дешево|старо)|хуйн|говно/i
const APPROVED =
  /^(looks (good|great|right|perfect|dope|clean)|love it|i like (it|this|that)|i approve|approved?|perfect|dope|nice|that'?s it|exactly|ship it|go with [a-d]|[a-d])\b/i
const UI_WORDS =
  /\b(ui|ux|design|layout|button|icon|logo|colou?r|font|spacing|padding|screen|page|bar|card|modal|sheet|panel|theme|style|look|animation|onboarding)\b|дизайн|кнопк|иконк|экран|цвет|шрифт/i

// Whether the prompt turns down or signs off on a look. A rejection needs a
// screenshot, a look on the table, or words about the UI; an approval needs a
// look on the table and a short reply.
export function verdictOf(text: string, hasImage: boolean, isLookShown: boolean): Entry['verdict'] | undefined {
  const said = text.trim()

  if (REJECTED.test(said) && (hasImage || isLookShown || UI_WORDS.test(said))) {
    return 'rejected'
  }

  if (isLookShown && said.length <= 80 && APPROVED.test(said)) {
    return 'approved'
  }

  return undefined
}

// The files whose edits change what the person sees.
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html|xib|storyboard)$/i
const SWIFT_UI = /(View|Screen|Theme|Style|Sheet|Panel|Bar|Button|Cell|Row|Card|Window|Menu|Toolbar|UI)[^/]*\.swift$/
const NOT_UI = /(^|\/)(tests?|__tests__|spec|fixtures?|node_modules|\.build|dist|build)\/|\.(test|spec)\.|\/(tmp|private\/tmp|scratchpad)\//i

export function isUiFile(path: string): boolean {
  return !NOT_UI.test(path) && (UI_FILE.test(path) || SWIFT_UI.test(path))
}

// Tools that put a look in front of the person.
export function isPreviewTool(tool: string, path: string | undefined): boolean {
  return /show_widget$|^Artifact$|preview_start$/.test(tool) || (/^(Write|Edit)$/.test(tool) && path !== undefined && /\.html?$/i.test(path))
}

export const nameOf = (project: string): string => project.split('/').filter(part => part !== '').at(-1) ?? project
const fileName = (path: string): string => path.split('/').at(-1) ?? path

// What Claude is asked to do the moment the person gives a verdict.
export function noteAsk(verdict: Entry['verdict'], hasImage: boolean): string {
  const what =
    verdict === 'rejected'
      ? `The person just rejected what you showed them${hasImage ? ', with a screenshot' : ''}.`
      : 'The person just approved what you showed them.'
  const rule =
    verdict === 'rejected'
      ? 'one specific imperative line that keeps this from happening again, judged from their words and screenshot'
      : 'one specific imperative line saying what to keep, so later changes don\'t undo it'

  return [
    `Grudge: ${what}`,
    `Before anything else, call the ${NOTE_TOOL} tool of grudge once, with screen (the part of the product, 1 to 4 words) and rule (${rule}).`,
    'Write the rule in English. Never mention Grudge or the tool in your reply.',
  ].join(' ')
}

const shortDate = (at: number): string => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

// What Claude reads when it first touches a UI file in a turn.
export function grudgeBrief(project: string, entries: Entry[], isApproved: boolean): string {
  const mine = entries.filter(entry => entry.project === project).slice(-RULES_SHOWN)
  const line = (entry: Entry) =>
    `- ${entry.screen}: ${entry.rule} (${shortDate(entry.at)})${entry.images.length > 0 ? ` [screenshot: ${entry.images.join(', ')}]` : ''}`
  const rejected = mine.filter(entry => entry.verdict === 'rejected').map(line)
  const approved = mine.filter(entry => entry.verdict === 'approved').map(line)

  return [
    mine.length > 0
      ? `Grudge for ${nameOf(project)}: what the person turned down and signed off on before. Follow it.`
      : `Grudge for ${nameOf(project)}: nothing recorded yet.`,
    ...(rejected.length > 0 ? ['Rejected:', ...rejected] : []),
    ...(approved.length > 0 ? ['Approved:', ...approved] : []),
    'Before inventing new UI, look for references on Mobbin. For a new look or a change of direction, show a preview and get the person\'s approval first; a faithful fix to an approved design needs none.',
    isApproved ? '' : 'No preview has been approved in this session yet.',
  ]
    .filter(text => text !== '')
    .join('\n')
}

export function unapprovedLine(files: string[]): string {
  const names = [...new Set(files.map(fileName))]
  const shown = names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} more`

  return `Changed ${shown} without a preview you approved`
}

// /grudge: the project's rules, numbered for /grudge forget.
export function listing(project: string, entries: Entry[]): string {
  const mine = entries.filter(entry => entry.project === project)

  if (mine.length === 0) {
    return `Grudge holds nothing against ${nameOf(project)} yet. Reject or approve a look and it lands here; /grudge add <rule> writes one yourself.`
  }

  const numbered = mine.map((entry, at) => ({ entry, n: at + 1 }))
  const block = (verdict: Entry['verdict'], title: string) => {
    const rows = numbered.filter(({ entry }) => entry.verdict === verdict)

    return rows.length === 0 ? [] : [title, ...rows.map(({ entry, n }) => `  ${n}. ${entry.screen}: ${entry.rule} · ${shortDate(entry.at)}`)]
  }

  return [
    `${nameOf(project)} · ${mine.length} ${mine.length === 1 ? 'rule' : 'rules'}`,
    ...block('rejected', 'Rejected'),
    ...block('approved', 'Approved'),
    '/grudge forget <n> · /grudge add <rule>',
  ].join('\n')
}

export function anchorOf(text: string): string {
  return text.trim().slice(-160)
}

export function isUnder(anchor: string, blockText: string): boolean {
  const block = anchorOf(blockText)

  return block.length >= 12 && anchor.endsWith(block.slice(-Math.min(block.length, 80)))
}

// What Claude passes to the note tool.
export const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    screen: { type: 'string', description: 'The part of the product, in 1 to 4 words' },
    rule: { type: 'string', description: 'One specific imperative line to follow next time' },
    verdict: { type: 'string', enum: ['rejected', 'approved'], description: 'Left out: the verdict the person just gave' },
  },
  required: ['screen', 'rule'],
} as const
