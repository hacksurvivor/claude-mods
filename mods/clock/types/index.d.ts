// A reply whose dates missed the period asked for, and what to say under it.
export type Flag = { anchor: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    clock: {
      flags: Flag[]
    }
  }
}
