import type { Inventory, Mine, Stats } from '../types'

export const FOLDED = 4
const BARS = '▁▂▃▄▅▆▇█'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function parse(stdout: string): { inventory: Inventory } | { error: string } {
  const line = stdout.trim().split('\n').at(-1) ?? ''

  try {
    const found = JSON.parse(line) as Partial<Inventory> & { error?: string }

    if (typeof found.error === 'string') {
      return { error: found.error }
    }

    return { inventory: { yours: found.yours ?? [], installed: found.installed ?? [], updates: found.updates ?? [], stats: found.stats ?? {}, repo: found.repo ?? null } }
  } catch {
    return { error: line === '' ? 'the helper printed nothing' : `the helper printed something else: ${line.slice(0, 100)}` }
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ▁▁▁█ from daily counts; an empty day is the lowest bar.
export function sparkline(daily: number[]): string {
  const top = Math.max(...daily, 0)

  return daily.map(n => (top === 0 || n === 0 ? BARS[0] : BARS[Math.max(1, Math.round((n / top) * (BARS.length - 1)))])).join('')
}

const shortDay = (iso: string): string => {
  const [, m, d] = iso.split('-').map(Number)

  return m === undefined || d === undefined ? iso : `${MONTHS[m - 1]} ${d}`
}

// The clones card: the number, the line under it, the sparkline.
export function clonesCard(stats: Stats): { value: string; label: string; spark: string; note: string } | string {
  if (stats.clones === undefined) {
    return stats.error === undefined ? 'GitHub numbers load with the list' : `Couldn't read GitHub: ${stats.error}`
  }

  const daily = stats.daily ?? []
  const active = daily.filter(n => n > 0).length
  const note = stats.clones > 0 && active === 1 && stats.peak ? `all on ${shortDay(stats.peak)}` : `${plural(stats.cloners ?? 0, 'source', 'sources')}`

  return { value: String(stats.clones), label: 'clones · 14 days', spark: sparkline(daily), note }
}

// The views card: the published mods' page views, most viewed first.
export function viewsCard(stats: Stats, published: Mine[]): { value: string; label: string; note: string } {
  const views = published.map(mod => ({ mod, n: stats.modViews?.[mod.id] ?? 0 })).sort((a, b) => b.n - a.n)
  const total = views.reduce((sum, entry) => sum + entry.n, 0)
  const [top, ...rest] = views

  if (top === undefined) {
    return { value: '0', label: 'page views', note: 'Nothing published yet' }
  }

  return {
    value: String(total),
    label: `${total === 1 ? 'page view' : 'page views'}${top.n > 0 ? ` · ${top.mod.name}` : ''}`,
    note: rest.length === 0 ? '14 days' : rest.map(entry => `${entry.n} on ${entry.mod.name}`).join(' · '),
  }
}

// The line over the list: how many are on, how the tests stand.
export function summary(yours: Mine[]): { left: string; right: string } {
  const on = yours.filter(mod => mod.isOn).length
  const pass = yours.reduce((sum, mod) => sum + (mod.tests?.pass ?? 0), 0)
  const fail = yours.reduce((sum, mod) => sum + (mod.tests?.fail ?? 0), 0)

  return {
    left: `${plural(yours.length, 'mod', 'mods')} · ${on} on`,
    right: fail > 0 ? `${plural(fail, 'test fails', 'tests fail')}` : `${pass} tests pass`,
  }
}

// What a row says on the right: published, else what the mod did, else its tests.
export function rowStat(mod: Mine): { text: string; tone?: 'success' | 'error' } {
  if (mod.tests !== null && mod.tests.fail > 0) {
    return { text: plural(mod.tests.fail, 'test fails', 'tests fail'), tone: 'error' }
  }

  if (mod.isPublished) {
    return { text: 'Published', tone: 'success' }
  }

  if (mod.usage !== null) {
    return { text: mod.usage }
  }

  return { text: mod.tests === null ? mod.version : `${mod.tests.pass} tests pass` }
}

// The opened row's line under its name.
export function details(mod: Mine, views: number | undefined): string {
  const parts = [mod.version]

  if (mod.tests !== null) {
    parts.push(mod.tests.fail > 0 ? plural(mod.tests.fail, 'test fails', 'tests fail') : `${mod.tests.pass} tests pass`)
  }

  if (mod.isPublished) {
    parts.push(plural(views ?? 0, 'page view', 'page views'))
  }

  return parts.join(' · ')
}

export const tabLabel = (inventory: Inventory | null) => ({
  yours: `Yours ${inventory?.yours.length ?? ''}`.trim(),
  installed: `Installed ${inventory?.installed.length ?? ''}`.trim(),
  updates: `Updates ${inventory === null ? '' : readyOf(inventory).length || ''}`.trim(),
})

export function restLine(names: string[]): string {
  if (names.length === 1) {
    return names[0] ?? ''
  }

  return `${names[0]} and ${names.length - 1} more`
}

export function publishPrompt(mod: Mine, repo: string | null | undefined): string {
  return [
    `Get my ${mod.name} mod (${mod.dir}) ready to publish${repo ? ` on ${repo}` : ''}, the way my published mods are:`,
    'check it for personal paths, names, client details and secrets first and tell me what you find;',
    'then a README, a privacy policy, the license, full plugin metadata, a marketplace entry and a row in the repo README,',
    'with its tests passing. Stop and ask me before committing or pushing.',
  ].join(' ')
}

export const readyOf = (inventory: Inventory | null) => inventory?.updates.filter(item => item.kind === 'ready') ?? []

export function updateVersions(item: { from: string; to: string }): string {
  return item.from === '' || item.from === item.to ? item.to : `${item.from} → ${item.to}`
}

// The row's line when the check wrote none.
export function updateLine(item: { kind: string; line?: string; commits?: number; from: string; to: string }): string {
  if (item.line !== undefined && item.line !== '') {
    return item.line
  }

  if (item.kind === 'review') {
    return item.commits === undefined ? 'Changed upstream' : plural(item.commits, 'commit', 'commits') + ' upstream'
  }

  if (item.kind === 'manual') {
    return 'Needs your password'
  }

  return item.from === item.to ? 'New commits, same version' : 'New version'
}

export function applyResult(stdout: string): { done: string[]; failed: Record<string, string>; reload: boolean } | undefined {
  try {
    const found = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { done?: string[]; failed?: Record<string, string>; reload?: boolean }

    return { done: found.done ?? [], failed: found.failed ?? {}, reload: found.reload === true }
  } catch {
    return undefined
  }
}
