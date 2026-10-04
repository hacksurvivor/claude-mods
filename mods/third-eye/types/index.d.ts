// One idea the third eye offered, and the reply it sits under.
export type Idea = {
  id: string
  // The end of the reply's text, to find the block it hangs under.
  anchor: string
  idea: string
  why: string
  prompt: string
  at: number
  status: 'new' | 'asked' | 'dismissed'
}

// What the person turned down or took, kept across sessions to steer the next ones.
export type Taste = { dismissed: string[]; asked: string[] }

declare module 'claude-code' {
  interface PluginState {
    'third-eye': {
      ideas: Idea[]
      // Ideas whose footnote is unfolded.
      open: string[]
      // The anchor of the reply the eye is looking at now, if any.
      looking: string | null
      isPaused: boolean
    }
  }
}
