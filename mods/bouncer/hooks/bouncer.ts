import type { Ruling, Seen, Verdict } from '../types'

export const MARK = '[bouncer]'

// Where the person lists what they work on, one project per line.
export const PROJECTS_FILE = '.claude/bouncer/projects.md'

// The projects in that file: its "- " lines, or its non-empty lines.
export function projectsIn(text: string): string[] {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))

  return lines.map(line => line.replace(/^[-*]\s+/, ''))
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g
// Links that are work in progress, not something to weigh.
const NOT_A_FIND = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[^/]*\.(local|test|localhost)\b|mail\.google\.com|docs\.google\.com|claude\.ai\/(code|chat|artifact)|chatgpt\.com\/(c|g)\/)/i
// Past this much text beside the links, the prompt is a task, not a link to weigh.
const MAX_ASIDE = 400

export function linksIn(text: string): string[] {
  return [...new Set((text.match(URL_PATTERN) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')))]
}

// The links worth a verdict, when the prompt is mostly a link and a question.
export function findsIn(text: string): string[] {
  const links = linksIn(text)
  const aside = links.reduce((rest, url) => rest.split(url).join(' '), text).trim()

  if (aside.length > MAX_ASIDE) {
    return []
  }

  return links.filter(url => !NOT_A_FIND.test(url.replace(/^https?:\/\//, '')))
}

// What rides beside the prompt, unseen, asking for the verdict line.
export function brief(links: string[], projects: string[]): string {
  return [
    `The person pasted ${links.length === 1 ? 'a link' : 'links'}: ${links.join(' ')}`,
    'Read what it is first (open the page, the repo or the video\'s transcript) and answer what they asked.',
    ...(projects.length > 0
      ? ['Judge it for their projects:', ...projects.map(project => `- ${project}`)]
      : ['Judge it for what they are working on, from this conversation and folder.']),
    '',
    `Begin your final answer with one line of its own: ${MARK} followed by JSON, then a blank line, then your answer.`,
    'The line is drawn as a card and hidden from the text; never mention it.',
    `${MARK} {"verdict":"use|later|skip","url":"<the link>","title":"<2 to 5 words naming it>","for":["<project names it serves, empty for none>"],"effort":"<time to try it, e.g. Half a day>","cost":"<free, free tier, $20/mo, ...>","why":"<one sentence: what it would do for them, or why it isn't worth their time>","next":"<the prompt they'd send to start on it, in their voice>"}`,
    'use: worth acting on now; later: real but not now; skip: hype, a course pitch, a scam, or nothing in it for them.',
    'Keep effort and cost to four words each and why under 25 words; they sit on one small card.',
    'Be blunt. With several links, judge the one they asked about most.',
  ].join('\n')
}

const VERDICTS: readonly Verdict[] = ['use', 'later', 'skip']

// The verdict line out of a reply block, and the block without it. A line still
// streaming in is hidden too, before it parses.
export function split(text: string): { ruling: Ruling | undefined; text: string } {
  const lines = text.split('\n')
  const last = lines.length - 1
  const isStreamingIn = (line: string, index: number): boolean =>
    index === last && line.trim() !== '' && MARK.startsWith(line.trim())
  const at = lines.findIndex((line, index) => line.trimStart().startsWith(MARK) || isStreamingIn(line, index))

  if (at === -1) {
    return { ruling: undefined, text }
  }

  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').replace(/^\s*\n/, '')

  return { ruling: parseLine(lines[at] ?? ''), text: rest }
}

function parseLine(line: string): Ruling | undefined {
  const json = line.trim().slice(MARK.length).trim()

  try {
    const found = JSON.parse(json) as Partial<Ruling>
    const verdict = VERDICTS.find(entry => entry === found.verdict)

    if (verdict === undefined || typeof found.why !== 'string') {
      return undefined
    }

    return {
      verdict,
      url: String(found.url ?? ''),
      title: String(found.title ?? found.url ?? 'This link'),
      for: Array.isArray(found.for) ? found.for.map(String).filter(name => name.trim() !== '') : [],
      effort: String(found.effort ?? ''),
      cost: String(found.cost ?? ''),
      why: found.why,
      next: String(found.next ?? ''),
    }
  } catch {
    return undefined
  }
}

export const VERDICT_LABEL: Record<Verdict, string> = { use: 'Use it', later: 'Later', skip: 'Skip' }
export const VERDICT_COLOR: Record<Verdict, string | undefined> = { use: 'success', later: 'warning', skip: undefined }
export const STATUS_LABEL: Record<Seen['status'], string> = {
  new: '',
  started: 'Started',
  later: 'Saved for later',
  skipped: 'Skipped',
}

// A link's key across sessions.
export function idOf(ruling: Ruling): string {
  const key = (ruling.url || ruling.title).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
  let hash = 0

  for (const char of key) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }

  return `ruling-${(hash >>> 0).toString(36)}`
}

export function meta(ruling: Ruling): string {
  return [ruling.effort, ruling.cost].filter(part => part.trim() !== '').join(' · ')
}

// /bouncer: what Bouncer has seen, by verdict, newest first.
export function listing(seen: Seen[], now: number): string {
  if (seen.length === 0) {
    return 'Nothing yet. Paste a link and ask what it is worth.'
  }

  const day = (at: number): string => {
    const days = Math.floor((now - at) / 86_400_000)

    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`
  }

  return VERDICTS.flatMap(verdict => {
    const rows = seen.filter(entry => entry.verdict === verdict).sort((a, b) => b.at - a.at)

    if (rows.length === 0) {
      return []
    }

    return [
      `${VERDICT_LABEL[verdict]}:`,
      ...rows.map(entry => {
        const status = STATUS_LABEL[entry.status]
        const parts = [entry.title, entry.for.join(', '), day(entry.at), status].filter(part => part !== '')

        return `  ${parts.join(' · ')}  ${entry.url}`
      }),
    ]
  }).join('\n')
}
