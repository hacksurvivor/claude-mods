import type { Item, Report } from '../types'

export const WEEK_MS = 7 * 24 * 60 * 60_000

// What the checker printed: a report, or why there is none.
export function parse(stdout: string): { report: Report } | { error: string } {
  const line = stdout.trim().split('\n').at(-1) ?? ''

  if (line === '') {
    return { error: 'the check printed nothing' }
  }

  try {
    const found = JSON.parse(line) as Partial<Report> & { error?: string }

    if (typeof found.error === 'string') {
      return { error: found.error }
    }

    return { report: { checkedAt: found.checkedAt ?? '', items: found.items ?? [], errors: found.errors ?? [] } }
  } catch {
    return { error: `the check printed something else: ${line.slice(0, 120)}` }
  }
}

export function isDue(report: Report | null, now: number): boolean {
  if (report === null || report.checkedAt === '') {
    return true
  }

  return now - Date.parse(report.checkedAt) >= WEEK_MS
}

export const ready = (report: Report | null): Item[] => report?.items.filter(item => item.kind === 'ready') ?? []

export function versions(item: Item): string {
  if (item.from === '' || item.from === item.to) {
    return item.to
  }

  return `${item.from} → ${item.to}`
}

// The model's brief: one short line per item, from its notes.
export function summaryPrompt(items: Item[]): string {
  const rows = items.map(item => ({ id: item.id, name: item.name, from: item.from, to: item.to, notes: item.notes }))

  return [
    'For each update below, write what changed in at most seven plain words, for a developer deciding whether',
    'to update. Across several releases, name the biggest new capability or fix; skip release chores, docs,',
    'version bumps and merge commits. No trailing period, no quotes, no marketing words.',
    'Answer with one JSON object mapping each id to its line, and nothing else.',
    '',
    JSON.stringify(rows),
  ].join('\n')
}

export function withLines(report: Report, answer: string): Report {
  const json = answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)
  let lines: Record<string, unknown> = {}

  try {
    lines = JSON.parse(json) as Record<string, unknown>
  } catch {
    return report
  }

  return {
    ...report,
    items: report.items.map(item => {
      const line = lines[item.id]

      return typeof line === 'string' && line.trim() !== '' ? { ...item, line: line.trim().replace(/\.$/, '') } : item
    }),
  }
}

// /updates: what the check found, and where to apply it.
export function describe(found: Report | string): string {
  if (typeof found === 'string') {
    return `Couldn't check for updates: ${found}`
  }

  const updates = ready(found)
  const others = found.items.length - updates.length

  if (found.items.length === 0) {
    return 'Everything is up to date.'
  }

  const list = updates.map(item => `${item.name} ${versions(item)}`).join(', ')
  const head = updates.length === 0 ? 'Nothing to update by itself' : `${updates.length} ready: ${list}`
  const rest = others > 0 ? `; ${others} more to review` : ''

  return `${head}${rest}. Apply them in /mods, on the Updates tab.`
}
