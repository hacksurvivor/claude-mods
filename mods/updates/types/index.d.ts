// One thing with a newer upstream, as bin/check.py reports it.
export type Item = {
  kind: 'ready' | 'review' | 'manual'
  id: string
  name: string
  from: string
  to: string
  // Release notes or commit subjects, for the one-line summary.
  notes: string
  // ready: the commands Update runs, in order.
  apply?: string[][]
  // ready: a Claude plugin, so plugins reload afterwards.
  reload?: boolean
  // review: the prompt that starts the merge with Claude.
  review?: string
  // manual: the command the person runs.
  command?: string
  commits?: number
  // The one-line summary, written once per check.
  line?: string
}

export type Report = { checkedAt: string; items: Item[]; errors: string[] }

declare module 'claude-code' {
  interface PluginState {
    updates: {
      isChecking: boolean
    }
  }
}
