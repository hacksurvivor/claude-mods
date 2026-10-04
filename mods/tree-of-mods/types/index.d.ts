export type Tests = { pass: number; fail: number; stale?: boolean }

// A mod in the mods folder.
export type Mine = {
  id: string
  name: string
  version: string
  description: string
  dir: string
  isPublished: boolean
  isOn: boolean
  // What it has done, from its own store ("1 link judged"), when it keeps such a count.
  usage: string | null
  tests: Tests | null
}

// A plugin installed from a marketplace.
export type Installed = { id: string; name: string; market: string; version: string; isOn: boolean; update: string | null }

// One thing with a newer upstream, from the Updates mod's report.
export type Update = {
  kind: 'ready' | 'review' | 'manual'
  id: string
  name: string
  from: string
  to: string
  line?: string
  // review: the prompt that starts the merge with Claude.
  review?: string
  // manual: the command the person runs.
  command?: string
  reload?: boolean
  commits?: number
}

export type Stats = {
  cloners?: number
  clones?: number
  // Clones per day, oldest first, the last 14 days.
  daily?: number[]
  // The day with the most clones, YYYY-MM-DD.
  peak?: string
  visitors?: number
  stars?: number
  // Page views of each mod's folder on GitHub, 14 days, by mod folder name.
  modViews?: Record<string, number>
  error?: string
}

export type Inventory = { yours: Mine[]; installed: Installed[]; updates: Update[]; stats: Stats; repo?: string | null }

export type Tab = 'yours' | 'installed' | 'updates'

declare module 'claude-code' {
  interface PluginState {
    'tree-of-mods': {
      inventory: Inventory | null
      error: string | null
      tab: Tab
      isLoading: boolean
      // Switched this session: they apply on a reload or in new sessions.
      changed: string[]
      showsAll: boolean
      // The mod whose details are open.
      opened: string | null
      // Updates running now, and why the failed ones failed.
      updating: string[]
      failures: Record<string, string>
      needsReload: boolean
    }
  }
}
