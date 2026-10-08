import type { Register } from 'claude-code'

// One folder per subagent run under ~/.claude/agent-runs/ (or $CLAUDE_CONFIG_DIR/agent-runs):
//   run.json  full machine-readable record
//   prompt.md the task the subagent was given
//   result.md the subagent's latest final report
// Local files only. No model calls, no network. Secrets are pattern-redacted
// before anything is stored; that is best effort, not a guarantee.
//
// The hooks only observe: each returns exactly what `next()` returned, and all
// recording happens after that, off the engine's path, inside try/catch.

const FLUSH_MS = 2000
const END_WAIT_MS = 2000
const MAX_FIELD = 2000
const MAX_INPUT = 600
const MAX_PREVIEW = 300
const MAX_SCAN = 20000
const MAX_TOOLS = 1000
const MAX_FILES = 500
const MAX_LIVE_RUNS = 200
// Past this many tool entries a run is rewritten at most every SLOW_FLUSH_MS, so a
// very long run does not rewrite an ever larger run.json every few seconds.
const SLOW_AFTER_TOOLS = 200
const SLOW_FLUSH_MS = 10000
const CHANGERS = new Set(['Edit', 'Write', 'NotebookEdit'])

type Timer = { cancel: () => void }

type Fs = {
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
}

type ToolEntry = {
  at: string
  tool: string
  ms: number
  outcome: 'ok' | 'error' | 'denied'
  input: string
  preview?: string
}

type Turn = {
  endedAt: string
  reason: string
  durationMs: number
  usage?: unknown
  refusal?: string
  answer?: string
}

type Run = {
  agentId: string
  folder: string
  status: 'running' | 'completed' | 'aborted' | 'error' | 'refused' | 'denied' | 'unfinished'
  startedAt: string
  endedAt?: string
  resumedAt?: string
  spawn: Record<string, unknown>
  tools: ToolEntry[]
  toolsDropped: number
  // Files changed through Edit, Write and NotebookEdit calls that succeeded.
  filesChanged: string[]
  // Bash and MCP calls that succeeded and that the engine did not mark read-only.
  // Not a complete list of side effects, but the calls worth a second look.
  possibleMutations: { tool: string; input: string }[]
  turns: Turn[]
  answer?: string
  note?: string
}

type ToolOutcome = { deny?: string; isError?: boolean; text?: string; isReadOnly?: boolean }

// Module state. A hot reload clears it; runFor rehydrates a run from disk.
const runs = new Map<string, Run>()
const dirty = new Set<string>()
const usedFolders = new Set<string>()
const promptWritten = new Set<string>()
const resultWritten = new Map<string, string>()
const chains = new Map<string, Promise<void>>()
const lastFlush = new Map<string, number>()
let base: string | undefined
let timerArmed = false
let counter = 0

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(?:sk-ant-|sk-|sk_live_|sk_test_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|hf_|npm_|SG\.|ya29\.)[A-Za-z0-9_.-]{12,}/g, '[redacted token]'],
  [/\b(Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:Bearer|Basic|Token)\s+)[^\s"'\\]{6,}/gi, '$1[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]'],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  [/((?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)(?=[^\s"'\\&,;]*[A-Za-z])[^\s"'\\&,;]{6,}/gi, '$1[redacted]'],
]

function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s)

// Clip first, then redact: a huge tool argument is never scanned whole.
const scrub = (s: string, n: number) => clip(redact(s.slice(0, MAX_SCAN)), n)

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

const idTail = (agentId: string) => slug(agentId).slice(-12)

const toSlash = (p: string) => p.split(String.fromCharCode(92)).join('/')

function normPath(p: string, cwd: unknown): string {
  const slashed = toSlash(p)
  const isAbsolute = /^(?:[A-Za-z]:)?\//.test(slashed)
  return !isAbsolute && typeof cwd === 'string' && cwd !== '' ? `${toSlash(cwd).replace(/\/$/, '')}/${slashed}` : slashed
}

async function clockNow($: Fs): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

async function baseDir($: Fs): Promise<string | undefined> {
  if (base !== undefined) return base
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config) {
    base = `${toSlash(config).replace(/\/$/, '')}/agent-runs`
    return base
  }
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return undefined
  base = `${toSlash(home).replace(/\/$/, '')}/.claude/agent-runs`
  return base
}

// Writes for one run are chained so an older snapshot can never land after a
// newer one; the snapshot is serialised when its turn comes, so it is the latest.
// A failed write puts the run back in `dirty` so the timer retries it.
function flush($: Fs, run: Run): Promise<void> {
  dirty.delete(run.agentId)
  const prev = chains.get(run.folder) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      lastFlush.set(run.agentId, await clockNow($))
      const root = await baseDir($)
      if (root === undefined) return
      const dir = `${root}/${run.folder}`
      await $.fs.write(`${dir}/run.json`, JSON.stringify(run, null, 2))
      if (!promptWritten.has(run.folder)) {
        await $.fs.write(`${dir}/prompt.md`, text(run.spawn.prompt))
        promptWritten.add(run.folder)
      }
      if (run.answer !== undefined && resultWritten.get(run.folder) !== run.answer) {
        await $.fs.write(`${dir}/result.md`, run.answer)
        resultWritten.set(run.folder, run.answer)
      }
    })
    .catch(() => {
      dirty.add(run.agentId)
    })
  chains.set(run.folder, next)
  return next
}

async function flushDirty($: Fs): Promise<void> {
  for (const id of [...dirty]) {
    const run = runs.get(id)
    if (!run) {
      dirty.delete(id)
      continue
    }
    const isSlow = run.tools.length > SLOW_AFTER_TOOLS
    if (isSlow && (await clockNow($)) - (lastFlush.get(id) ?? 0) < SLOW_FLUSH_MS) continue
    await flush($, run)
  }
}

// One timer for the module. session.start arms it; so does the first tool call,
// for a module reloaded without a session.start.
function armTimer($: Fs): void {
  if (timerArmed) return
  timerArmed = true
  $.clock.every(FLUSH_MS, () => { void flushDirty($) })
}

function forget(run: Run): void {
  runs.delete(run.agentId)
  promptWritten.delete(run.folder)
  resultWritten.delete(run.folder)
  chains.delete(run.folder)
  lastFlush.delete(run.agentId)
}

function open(agentId: string, spawn: Record<string, unknown>, status: Run['status'], note?: string): Run {
  if (runs.size >= MAX_LIVE_RUNS) {
    for (const old of [...runs.values()]) {
      if (old.status !== 'running' && !dirty.has(old.agentId)) forget(old)
      if (runs.size < MAX_LIVE_RUNS) break
    }
  }
  const now = new Date()
  const stem = `${stamp(now)}_${slug(text(spawn.subagentType) || 'agent')}_${slug(text(spawn.description))}_${idTail(agentId)}`
  let folder = stem
  for (let n = 2; usedFolders.has(folder); n++) folder = `${stem}-${n}`
  usedFolders.add(folder)
  const run: Run = {
    agentId,
    folder,
    status,
    startedAt: now.toISOString(),
    spawn,
    tools: [],
    toolsDropped: 0,
    filesChanged: [],
    possibleMutations: [],
    turns: [],
    note,
  }
  runs.set(agentId, run)
  return run
}

// After a reload the module has forgotten its runs: find the run's folder on
// disk by the agent id in its name and carry on writing to it. The folder name
// on disk is trusted over the one inside run.json; a truncated run.json is skipped.
async function rehydrate($: Fs, agentId: string): Promise<Run | undefined> {
  const root = await baseDir($)
  if (root === undefined) return undefined
  const entries = await $.fs.list(root).catch(() => [])
  const suffix = `_${idTail(agentId)}`
  const names = entries.map(x => x.name).filter(n => n.includes(suffix)).sort().reverse()
  for (const name of names) {
    const raw = await $.fs.read(`${root}/${name}/run.json`).catch(() => undefined)
    if (raw === undefined) continue
    try {
      const run = JSON.parse(raw) as Run
      if (run.agentId !== agentId) continue
      run.folder = name
      usedFolders.add(name)
      promptWritten.add(name)
      if (run.answer !== undefined) resultWritten.set(name, run.answer)
      return run
    } catch {
      continue
    }
  }
  return undefined
}

// A subagent's events can arrive before its spawn is recorded, or after a
// reload cleared module state: rehydrate from disk, else a labelled stub run.
async function runFor($: Fs, agentId: string): Promise<Run> {
  const known = runs.get(agentId)
  if (known) return known
  const loaded = await rehydrate($, agentId)
  const raced = runs.get(agentId)
  if (raced) return raced
  if (loaded) {
    runs.set(agentId, loaded)
    return loaded
  }
  return open(agentId, { subagentType: 'unknown', description: 'seen-without-spawn' }, 'running',
    'Events seen without a recorded spawn (the spawn hook was skipped, or the folder was removed).')
}

function spawnRecord(e: Record<string, unknown>): Record<string, unknown> {
  return {
    prompt: redact(text(e.prompt)),
    description: scrub(text(e.description), MAX_INPUT),
    subagentType: e.subagentType,
    requestedModel: e.model,
    parentModel: e.parentModel,
    provider: e.provider,
    parentAgentId: e.parentAgentId,
    permissionMode: e.permissionMode,
    background: e.background,
    fork: e.fork,
    isTeammate: e.isTeammate,
    name: e.name === undefined ? undefined : scrub(text(e.name), MAX_INPUT),
    cwd: e.cwd === undefined ? undefined : scrub(text(e.cwd), MAX_INPUT),
    workflow: e.workflow,
    toolUseId: e.tool_use_id,
  }
}

type Started = { deny?: string; model?: string; agentId?: string; teammateId?: string }

function recordSpawn($: Fs, e: Record<string, unknown>, started: Started | undefined, error?: unknown): void {
  try {
    let spawn: Record<string, unknown>
    try {
      spawn = spawnRecord(e)
    } catch {
      spawn = { subagentType: e.subagentType, toolUseId: e.tool_use_id, note: 'spawn details could not be recorded' }
    }
    const toolUse = text(e.tool_use_id)
    if (error !== undefined) {
      const run = open(`failed-${++counter}-${toolUse}`, spawn, 'error', scrub(`spawn failed: ${text(error)}`, MAX_INPUT))
      run.endedAt = run.startedAt
      void flush($, run)
    } else if (started?.deny !== undefined) {
      const run = open(`denied-${++counter}-${toolUse}`, spawn, 'denied', scrub(started.deny, MAX_INPUT))
      run.endedAt = run.startedAt
      void flush($, run)
    } else if (started?.agentId !== undefined) {
      const full = { ...spawn, resolvedModel: started.model, teammateId: started.teammateId }
      const existing = runs.get(started.agentId)
      if (existing) {
        // Tool events beat the spawn record here: keep what they collected.
        existing.spawn = full
        existing.note = undefined
        void flush($, existing)
      } else {
        void flush($, open(started.agentId, full, 'running'))
      }
    }
  } catch {
    // logging must never get in the way of a spawn
  }
}

async function recordTool(
  $: Fs,
  agentId: string,
  e: Record<string, unknown>,
  result: ToolOutcome,
  startedAt: number,
): Promise<void> {
  try {
    armTimer($)
    const endedAt = await clockNow($)
    const run = await runFor($, agentId)
    const { tool, tool_use_id: _id, agentId: _a, ...args } = e
    const name = text(tool)
    const compact: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) compact[k] = typeof v === 'string' ? clip(v, MAX_FIELD) : v
    const input = scrub(JSON.stringify(compact) ?? '', MAX_INPUT)
    const outcome: ToolEntry['outcome'] =
      result.deny !== undefined ? 'denied' : result.isError === true ? 'error' : 'ok'
    const preview = result.deny ?? result.text

    if (run.status !== 'running') {
      run.status = 'running'
      run.resumedAt = new Date(endedAt).toISOString()
      run.endedAt = undefined
    }
    if (run.tools.length < MAX_TOOLS) {
      run.tools.push({
        at: new Date(startedAt).toISOString(),
        tool: name,
        ms: Math.max(0, endedAt - startedAt),
        outcome,
        input,
        preview: typeof preview === 'string' ? scrub(preview, MAX_PREVIEW) : undefined,
      })
    } else {
      run.toolsDropped += 1
    }
    if (outcome === 'ok') {
      const rawPath = args.file_path ?? args.notebook_path
      if (CHANGERS.has(name) && typeof rawPath === 'string') {
        const file = scrub(normPath(rawPath, run.spawn.cwd), MAX_INPUT)
        if (!run.filesChanged.includes(file) && run.filesChanged.length < MAX_FILES) run.filesChanged.push(file)
      } else if (
        (name === 'Bash' || name.startsWith('mcp__')) &&
        result.isReadOnly !== true &&
        run.possibleMutations.length < MAX_TOOLS
      ) {
        run.possibleMutations.push({ tool: name, input: clip(input, 200) })
      }
    }
    dirty.add(agentId)
  } catch {
    // see recordSpawn
  }
}

async function recordTurn($: Fs, e: Record<string, unknown>): Promise<void> {
  try {
    armTimer($)
    const agentId = text(e.agentId)
    const run = await runFor($, agentId)
    const now = new Date().toISOString()
    const answer = redact(text(e.answer))
    run.turns.push({
      endedAt: now,
      reason: text(e.reason),
      durationMs: Number(e.durationMs) || 0,
      usage: e.usage,
      refusal: e.reason === 'refusal' ? scrub(JSON.stringify(e.refusal) ?? '', MAX_INPUT) : undefined,
      answer,
    })
    run.endedAt = now
    run.answer = answer
    run.status =
      e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'aborted' : e.reason === 'refusal' ? 'refused' : 'error'
    void flush($, run)
  } catch {
    // see recordSpawn
  }
}

// Anything still running when the session ends (a remote workflow agent never
// raises turn.complete, a crashed run never finishes) is marked unfinished.
// Waits for the writes, but never longer than END_WAIT_MS.
async function endSession($: Fs): Promise<void> {
  try {
    const now = new Date().toISOString()
    for (const run of runs.values()) {
      if (run.status === 'running') {
        run.status = 'unfinished'
        run.endedAt = now
        dirty.add(run.agentId)
      }
    }
    for (const id of [...dirty]) {
      const run = runs.get(id)
      if (run) void flush($, run)
    }
    await Promise.race([Promise.all([...chains.values()]), $.clock.sleep(END_WAIT_MS)])
  } catch {
    // see recordSpawn
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    armTimer($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    let started
    try {
      started = await next(e)
    } catch (err) {
      recordSpawn($, e as Record<string, unknown>, undefined, err)
      throw err
    }
    recordSpawn($, e as Record<string, unknown>, started)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)
    const startedAt = await clockNow($)
    const result = await next(e)
    void recordTool($, agentId, e as Record<string, unknown>, result as ToolOutcome, startedAt)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) void recordTurn($, e as Record<string, unknown>)
    return done
  })

  on('session.end', async ($, e, next) => {
    await endSession($)
    return next(e)
  })
}
