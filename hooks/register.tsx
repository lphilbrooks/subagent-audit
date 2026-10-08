import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { buildFiles, diffSnapshots, parseStatus } from './gitdelta'
import type { Snapshot } from './gitdelta'
import { receiptText } from './receipt'
import { clip, redact, scrub, text } from './redact'
import { evaluateScope } from './scope'
import type { Api, Run, ToolEntry } from './types'
import { buildPane, listText } from './view'

// One folder per subagent run under ~/.claude/agent-runs/ (or $CLAUDE_CONFIG_DIR/agent-runs):
//   run.json  full machine-readable record
//   prompt.md the task the subagent was given
//   result.md the subagent's latest final report
// On top of that record the mod:
//   - compares git state at the subagent's start and end, to attribute file changes
//     (including edits made through Bash) and to flag violations by read-only agents;
//   - writes a one-notice receipt into the chat when a subagent finishes (the model never
//     reads it, so it costs no usage);
//   - offers /subagents, a pane listing this session's subagents with their full audit detail.
// Local only: no model calls, no network (git runs on this machine). Secrets are
// pattern-redacted before anything is stored; that is best effort, not a guarantee.
//
// The hooks only observe: each returns exactly what `next()` returned, and recording
// happens after that, off the engine's path, inside try/catch. The one exception is the
// git snapshot taken before a subagent starts, which waits at most SNAP_BUDGET_MS.

const PANE = 'subagent-audit'
const FLUSH_MS = 2000
const END_WAIT_MS = 2000
const SNAP_BUDGET_MS = 1500
const SNAP_TIMEOUT_MS = 4000
const MAX_SNAP_FILES = 300
const MAX_GIT_FILES = 200
const MAX_DISK_SCAN = 80
const MAX_FIELD = 2000
const MAX_INPUT = 600
const MAX_PREVIEW = 300
const MAX_TOOLS = 1000
const MAX_FILES = 500
const MAX_LIVE_RUNS = 200
// Past this many tool entries a run is rewritten at most every SLOW_FLUSH_MS, so a
// very long run does not rewrite an ever larger run.json every few seconds.
const SLOW_AFTER_TOOLS = 200
const SLOW_FLUSH_MS = 10000
const CHANGERS = new Set(['Edit', 'Write', 'NotebookEdit'])

type ToolOutcome = { deny?: string; isError?: boolean; text?: string; isReadOnly?: boolean }
type Started = { deny?: string; model?: string; agentId?: string; teammateId?: string }

const selectedAtom = atom({ plugin: 'subagent-audit', key: 'selected' } as const, '')
const flaggedAtom = atom({ plugin: 'subagent-audit', key: 'onlyFlagged' } as const, false)

// Module state. A hot reload clears it; runFor rehydrates a run from disk.
const runs = new Map<string, Run>()
const dirty = new Set<string>()
const usedFolders = new Set<string>()
const promptWritten = new Set<string>()
const resultWritten = new Map<string, string>()
const chains = new Map<string, Promise<void>>()
const lastFlush = new Map<string, number>()
const snapshots = new Map<string, Snapshot>()
const pendingSnapshots = new Map<string, Snapshot>()
let base: string | undefined
let sessionId: string | undefined
let timerArmed = false
let diskLoaded = false
let counter = 0
let config = { receipts: true, gitAttribution: true }

const pad = (n: number) => String(n).padStart(2, '0')

const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'

const idTail = (agentId: string) => slug(agentId).slice(-12)

const toSlash = (p: string) => p.split(String.fromCharCode(92)).join('/')

function normPath(p: string, cwd: unknown): string {
  const slashed = toSlash(p)
  const isAbsolute = /^(?:[A-Za-z]:)?\//.test(slashed)
  return !isAbsolute && typeof cwd === 'string' && cwd !== '' ? `${toSlash(cwd).replace(/\/$/, '')}/${slashed}` : slashed
}

async function clockNow($: Api): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

async function sessionIdOf($: Api): Promise<string | undefined> {
  if (sessionId === undefined) {
    try {
      sessionId = await $.session.id()
    } catch {
      return undefined
    }
  }
  return sessionId
}

async function baseDir($: Api): Promise<string | undefined> {
  if (base !== undefined) return base
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir) {
    base = `${toSlash(configDir).replace(/\/$/, '')}/agent-runs`
    return base
  }
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return undefined
  base = `${toSlash(home).replace(/\/$/, '')}/.claude/agent-runs`
  return base
}

function redraw($: Api): void {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // nothing is drawing
  }
}

// ---- git attribution -------------------------------------------------------

async function takeSnapshot($: Api, cwd: string | undefined): Promise<Snapshot | undefined> {
  try {
    const init = { cwd, timeoutMs: SNAP_TIMEOUT_MS }
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], init)
    if (top.exitCode !== 0) return undefined
    const root = top.stdout.trim()
    const status = await $.process.run(['git', '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-uall'], {
      cwd: root,
      timeoutMs: SNAP_TIMEOUT_MS,
    })
    if (status.exitCode !== 0) return undefined
    const entries = parseStatus(status.stdout)
    const hashable = entries.filter(e => !e.xy.includes('D')).slice(0, MAX_SNAP_FILES)
    let hashed: string[] = []
    if (hashable.length > 0) {
      const res = await $.process.run(['git', 'hash-object', '--stdin-paths'], {
        cwd: root,
        stdin: `${hashable.map(e => e.path).join('\n')}\n`,
        timeoutMs: SNAP_TIMEOUT_MS,
      })
      if (res.exitCode === 0) hashed = res.stdout.split('\n')
    }
    return {
      root,
      files: buildFiles(entries, hashable, hashed),
      truncated: entries.length > MAX_SNAP_FILES,
    }
  } catch {
    return undefined
  }
}

async function snapshotWithin($: Api, cwd: string | undefined): Promise<Snapshot | undefined> {
  if (!config.gitAttribution) return undefined
  try {
    return await Promise.race([takeSnapshot($, cwd), $.clock.sleep(SNAP_BUDGET_MS).then(() => undefined)])
  } catch {
    return undefined
  }
}

function overlaps(a: Run, b: Run, now: number): boolean {
  const aStart = a.startMs ?? 0
  const bStart = b.startMs ?? 0
  return aStart < (b.endMs ?? now) && bStart < (a.endMs ?? now)
}

// ---- persistence -----------------------------------------------------------

// Writes for one run are chained so an older snapshot can never land after a
// newer one; the snapshot is serialised when its turn comes, so it is the latest.
// A failed write puts the run back in `dirty` so the timer retries it.
function flush($: Api, run: Run): Promise<void> {
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

async function flushDirty($: Api): Promise<void> {
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
  redraw($)
}

// One timer for the module. session.start arms it; so does the first tool call,
// for a module reloaded without a session.start.
function armTimer($: Api): void {
  if (timerArmed) return
  timerArmed = true
  $.clock.every(FLUSH_MS, () => { void flushDirty($) })
}

function forget(run: Run): void {
  runs.delete(run.agentId)
  snapshots.delete(run.agentId)
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
    session: sessionId,
    status,
    startedAt: now.toISOString(),
    startMs: now.getTime(),
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

function parseRun(raw: string, name: string): Run | undefined {
  try {
    const run = JSON.parse(raw) as Run
    if (typeof run.agentId !== 'string') return undefined
    run.folder = name
    return run
  } catch {
    return undefined
  }
}

function adopt(run: Run): void {
  usedFolders.add(run.folder)
  promptWritten.add(run.folder)
  if (run.answer !== undefined) resultWritten.set(run.folder, run.answer)
  runs.set(run.agentId, run)
}

// After a reload the module has forgotten its runs: find the run's folder on
// disk by the agent id in its name and carry on writing to it. The folder name
// on disk is trusted over the one inside run.json; a truncated run.json is skipped.
async function rehydrate($: Api, agentId: string): Promise<Run | undefined> {
  const root = await baseDir($)
  if (root === undefined) return undefined
  const entries = await $.fs.list(root).catch(() => [])
  const suffix = `_${idTail(agentId)}`
  const names = entries.map(x => x.name).filter(n => n.includes(suffix)).sort().reverse()
  for (const name of names) {
    const raw = await $.fs.read(`${root}/${name}/run.json`).catch(() => undefined)
    const run = raw === undefined ? undefined : parseRun(raw, name)
    if (run && run.agentId === agentId) return run
  }
  return undefined
}

// A subagent's events can arrive before its spawn is recorded, or after a
// reload cleared module state: rehydrate from disk, else a labelled stub run.
async function runFor($: Api, agentId: string): Promise<Run> {
  const known = runs.get(agentId)
  if (known) return known
  const loaded = await rehydrate($, agentId)
  const raced = runs.get(agentId)
  if (raced) return raced
  if (loaded) {
    adopt(loaded)
    return loaded
  }
  return open(agentId, { subagentType: 'unknown', description: 'seen-without-spawn' }, 'running',
    'Events seen without a recorded spawn (the spawn hook was skipped, or the folder was removed).')
}

// The pane lists this session's subagents. After a reload or a resume the module
// has none in memory, so the first look reads this session's recent runs from disk.
async function loadSessionRuns($: Api): Promise<void> {
  if (diskLoaded) return
  diskLoaded = true
  try {
    const root = await baseDir($)
    const sid = await sessionIdOf($)
    if (root === undefined || sid === undefined) return
    const entries = await $.fs.list(root).catch(() => [])
    const names = entries.map(x => x.name).sort().reverse().slice(0, MAX_DISK_SCAN)
    for (const name of names) {
      if (usedFolders.has(name)) continue
      const raw = await $.fs.read(`${root}/${name}/run.json`).catch(() => undefined)
      const run = raw === undefined ? undefined : parseRun(raw, name)
      if (run && run.session === sid && !runs.has(run.agentId)) adopt(run)
    }
  } catch {
    // listing is a convenience
  }
}

function sessionRuns(): Run[] {
  return [...runs.values()]
    .filter(r => r.session === undefined || r.session === sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

// ---- recording -------------------------------------------------------------

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

async function recordSpawn(
  $: Api,
  e: Record<string, unknown>,
  started: Started | undefined,
  error: unknown,
  before: Snapshot | undefined,
): Promise<void> {
  try {
    await sessionIdOf($)
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
      run.endMs = run.startMs
      void flush($, run)
    } else if (started?.deny !== undefined) {
      const run = open(`denied-${++counter}-${toolUse}`, spawn, 'denied', scrub(started.deny, MAX_INPUT))
      run.endedAt = run.startedAt
      run.endMs = run.startMs
      void flush($, run)
    } else if (started?.agentId !== undefined) {
      const full = { ...spawn, resolvedModel: started.model, teammateId: started.teammateId }
      if (before) snapshots.set(started.agentId, before)
      const existing = runs.get(started.agentId)
      if (existing) {
        // Tool events beat the spawn record here: keep what they collected.
        existing.spawn = full
        existing.session = existing.session ?? sessionId
        existing.note = undefined
        void flush($, existing)
      } else {
        void flush($, open(started.agentId, full, 'running'))
      }
    }
    redraw($)
  } catch {
    // logging must never get in the way of a spawn
  }
}

async function recordTool(
  $: Api,
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
      run.endMs = undefined
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

// Runs when a subagent's turn ends: attribute file changes with a second git
// snapshot, judge scope, save, write the receipt, redraw.
async function finalize($: Api, run: Run): Promise<void> {
  try {
    const before = snapshots.get(run.agentId)
    if (before) {
      const after = await snapshotWithin($, before.root)
      if (after) {
        const now = Date.now()
        const others = [...runs.values()].filter(r => r !== run && overlaps(r, run, now))
        const shared = run.spawn.background === true || others.length > 0
        const changes = diffSnapshots(before, after)
        run.gitDelta = {
          files: changes.slice(0, MAX_GIT_FILES),
          attribution: shared ? 'shared' : 'exclusive',
          truncated: before.truncated || after.truncated || changes.length > MAX_GIT_FILES || undefined,
        }
      }
    }
    run.scope = evaluateScope(run)
    await flush($, run)
    redraw($)
    if (config.receipts) {
      await $.session
        .append({ message: { type: 'system', content: [{ type: 'text', text: receiptText(run) }] } })
        .catch(() => {})
    }
  } catch {
    // see recordSpawn
  }
}

async function recordTurn($: Api, e: Record<string, unknown>): Promise<void> {
  try {
    armTimer($)
    const agentId = text(e.agentId)
    const run = await runFor($, agentId)
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
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
    run.endMs = nowMs
    run.answer = answer
    run.status =
      e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'aborted' : e.reason === 'refusal' ? 'refused' : 'error'
    void finalize($, run)
  } catch {
    // see recordSpawn
  }
}

// Anything still running when the session ends (a remote workflow agent never
// raises turn.complete, a crashed run never finishes) is marked unfinished.
// Waits for the writes, but never longer than END_WAIT_MS.
async function endSession($: Api): Promise<void> {
  try {
    const nowMs = Date.now()
    for (const run of runs.values()) {
      if (run.status === 'running') {
        run.status = 'unfinished'
        run.endedAt = new Date(nowMs).toISOString()
        run.endMs = nowMs
        run.scope = evaluateScope(run)
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

async function openPane($: Api): Promise<string> {
  await sessionIdOf($)
  await loadSessionRuns($)
  try {
    await $.ui.open({ id: PANE, title: 'Subagents', focus: true })
  } catch {
    // a surface that draws no pane gets the text reply alone
  }
  return listText(sessionRuns())
}

export const register: Register = (on, options) => {
  config = {
    receipts: options?.receipts !== false,
    gitAttribution: options?.gitAttribution !== false,
  }

  on('session.start', async ($, e, next) => {
    armTimer($)
    await $.command.register({
      name: 'subagents',
      description: 'Browse this session\'s subagent runs: scope, git changes, tool calls, result',
    })
    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => ({ text: await openPane($) }))

  on('agent.spawn', async ($, e, next) => {
    const before = await snapshotWithin($, typeof e.cwd === 'string' ? e.cwd : undefined)
    let started
    try {
      started = await next(e)
    } catch (err) {
      void recordSpawn($, e as Record<string, unknown>, undefined, err, before)
      throw err
    }
    void recordSpawn($, e as Record<string, unknown>, started, undefined, before)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e)
    const selectedId = await read($, selectedAtom)
    const onlyFlagged = await read($, flaggedAtom)
    const list = sessionRuns()
    return buildPane(E, {
      runs: list,
      selected: selectedId === '' ? undefined : list.find(r => r.agentId === selectedId),
      onlyFlagged,
      columns: e.props.bodyColumns ?? e.viewport?.columns ?? 80,
      rows: e.viewport?.rows ?? 24,
      select: id => { void update($, selectedAtom, () => id) },
      toggleFlagged: () => { void update($, flaggedAtom, v => !v) },
    })
  })
}
