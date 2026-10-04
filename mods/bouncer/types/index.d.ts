export type Verdict = 'use' | 'later' | 'skip'

// What Claude says about a link, on the first line of its answer.
export type Ruling = {
  verdict: Verdict
  url: string
  title: string
  for: string[]
  effort: string
  cost: string
  why: string
  // The prompt "Start on it" sends.
  next: string
}

// A link Bouncer has looked at, kept across sessions for /bouncer.
export type Seen = Ruling & {
  id: string
  at: number
  status: 'new' | 'started' | 'later' | 'skipped'
}

declare module 'claude-code' {
  interface PluginState {
    'bouncer': {
      isPaused: boolean
      // Bumped when a card's choice changes, so the cards draw again.
      choices: Record<string, Seen['status']>
    }
  }
}
