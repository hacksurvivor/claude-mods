// One look the person turned down or signed off on, and the rule it left.
export type Entry = {
  id: string
  at: number
  // The repository's root, or the folder when there is no repository.
  project: string
  verdict: 'rejected' | 'approved'
  // The part of the product, in a few words: "Top bar", "Settings sheet".
  screen: string
  // One imperative line Claude follows next time.
  rule: string
  // What the person wrote.
  quote: string
  // The screenshots they sent with it, copied out of the transcript.
  images: string[]
}

// What goes under one reply: the rules it noted, and UI files it changed
// with no approved preview.
export type Notice = { anchor: string; ids: string[]; unapproved: string[] }

declare module 'claude-code' {
  interface PluginState {
    'grudge': {
      notices: Notice[]
      // Bumped when a grudge is added or dropped, so notices draw again.
      version: number
      isPaused: boolean
    }
  }
}
