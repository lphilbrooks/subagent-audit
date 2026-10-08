export type Timer = { cancel: () => void }

// The part of the engine's `$` this mod uses. Declared here so the helpers
// that take `$` stay checkable without importing the engine's whole interface.
export type Api = {
  clock: {
    now: () => number | Promise<number>
    every: (ms: number, fn: () => void) => Timer
    sleep: (ms: number) => Promise<void>
  }
  env: { get: (name: string) => Promise<string | undefined> }
  fs: {
    write: (path: string, text: string) => Promise<void>
    read: (path: string) => Promise<string>
    list: (path: string) => Promise<{ name: string }[]>
  }
  process: {
    run: (
      argv: readonly string[],
      init?: { cwd?: string; stdin?: string; timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
  session: {
    id: () => Promise<string>
    append: (args: {
      message: { type: 'system'; content: { type: 'text'; text: string }[] }
    }) => Promise<unknown>
  }
  ui: {
    invalidate: (event: 'ui.render') => void
    open: (pane: { id: string; title?: string; focus?: true }) => Promise<unknown>
  }
}

export type ToolEntry = {
  at: string
  tool: string
  ms: number
  outcome: 'ok' | 'error' | 'denied'
  input: string
  preview?: string
}

export type Turn = {
  endedAt: string
  reason: string
  durationMs: number
  usage?: unknown
  refusal?: string
  answer?: string
}

export type RunStatus = 'running' | 'completed' | 'aborted' | 'error' | 'refused' | 'denied' | 'unfinished'

export type GitChange = { path: string; change: 'new' | 'changed' | 'cleaned' }

export type GitDelta = {
  files: GitChange[]
  // exclusive: nothing else was running while this subagent ran.
  // shared: it ran in the background, or overlapped another subagent, so the
  // listed files may belong to someone else.
  attribution: 'exclusive' | 'shared'
  truncated?: boolean
}

export type Scope = {
  declared: 'read-only' | 'unrestricted'
  violations: string[]
}

export type Run = {
  agentId: string
  folder: string
  session?: string
  status: RunStatus
  startedAt: string
  startMs?: number
  endMs?: number
  endedAt?: string
  resumedAt?: string
  spawn: Record<string, unknown>
  tools: ToolEntry[]
  toolsDropped: number
  // Files changed through Edit, Write and NotebookEdit calls that succeeded.
  filesChanged: string[]
  // Bash and MCP calls that succeeded and that the engine did not mark read-only.
  possibleMutations: { tool: string; input: string }[]
  // Files whose git state differs between the subagent's start and its end,
  // so edits made through Bash and other tools are caught too. Absent when the
  // working directory is not a git repository or the check failed.
  gitDelta?: GitDelta
  scope?: Scope
  turns: Turn[]
  answer?: string
  note?: string
}
