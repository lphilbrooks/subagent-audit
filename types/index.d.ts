// State the subagent-audit pane keeps for the session. Only the pane's own
// selection lives here; the runs themselves are held by the module and on disk.
export type PaneState = {
  selected: string
  onlyFlagged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-audit': { selected: string; onlyFlagged: boolean }
  }
}
