import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildFiles, diffSnapshots, parseStatus } from './gitdelta'
import { receiptText } from './receipt'
import { evaluateScope, flagCount } from './scope'
import type { Run } from './types'
import { listText } from './view'

declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const BS = String.fromCharCode(92)
const norm = (p: string) => p.split(BS).join('/')
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  await clock.advance(2500)
  await pause(150)
}
const SESSION = { cwd: 'C:/work', surface: null, isInteractive: false } as const

const spawnInput = (description: string, subagentType: string, extra: Record<string, unknown> = {}) =>
  ({
    prompt: 'do the thing', description, subagentType, tool_use_id: `tu-${description}`,
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false, ...extra,
  }) as never

const blankRun = (over: Partial<Run> = {}): Run => ({
  agentId: 'agent-x', folder: 'f', status: 'completed', startedAt: '2026-10-08T10:00:00.000Z',
  startMs: 1000, endMs: 66000, spawn: { subagentType: 'Explore', description: 'find the parser' },
  tools: [], toolsDropped: 0, filesChanged: [], possibleMutations: [], turns: [], ...over,
})

// ---- pure helpers ----------------------------------------------------------

test('git status lines parse, including renames and quoted paths', () => {
  const out = [' M src/a.ts', '?? new file.txt', 'R  old.ts -> renamed.ts', ' D gone.ts', '?? "odd name.txt"'].join(String.fromCharCode(10))
  const entries = parseStatus(out)
  expect(entries.map(e => e.path)).toEqual(['src/a.ts', 'new file.txt', 'renamed.ts', 'gone.ts', 'odd name.txt'])
  expect(entries.map(e => e.xy)).toEqual([' M', '??', 'R ', ' D', '??'])
})

test('snapshot comparison finds new, changed and cleaned files', () => {
  const before = { root: '/r', truncated: false, files: buildFiles(
    [{ path: 'a', xy: ' M' }, { path: 'b', xy: ' M' }, { path: 'c', xy: '??' }],
    [{ path: 'a', xy: ' M' }, { path: 'b', xy: ' M' }, { path: 'c', xy: '??' }], ['h1', 'h2', 'h3']) }
  const after = { root: '/r', truncated: false, files: buildFiles(
    [{ path: 'a', xy: ' M' }, { path: 'b', xy: ' M' }, { path: 'd', xy: '??' }],
    [{ path: 'a', xy: ' M' }, { path: 'b', xy: ' M' }, { path: 'd', xy: '??' }], ['h1', 'h2-changed', 'h4']) }
  expect(diffSnapshots(before, after)).toEqual([
    { path: 'b', change: 'changed' },
    { path: 'c', change: 'cleaned' },
    { path: 'd', change: 'new' },
  ])
})

test('read-only agents are judged, unrestricted ones only flagged', () => {
  const readOnly = blankRun({
    tools: [{ at: 'x', tool: 'Write', ms: 1, outcome: 'ok', input: '{}' }],
    possibleMutations: [{ tool: 'Bash', input: 'rm x' }],
    gitDelta: { files: [{ path: 'a.ts', change: 'changed' }], attribution: 'exclusive' },
  })
  const scope = evaluateScope(readOnly)
  expect(scope.declared).toBe('read-only')
  expect(scope.violations).toEqual(['Write succeeded', 'Bash call not marked read-only', 'git: a.ts changed'])

  const shared = blankRun({ gitDelta: { files: [{ path: 'a.ts', change: 'changed' }], attribution: 'shared' } })
  expect(evaluateScope(shared).violations).toEqual([])

  const general = blankRun({ spawn: { subagentType: 'general-purpose' }, possibleMutations: [{ tool: 'Bash', input: 'make' }] })
  expect(evaluateScope(general)).toEqual({ declared: 'unrestricted', violations: [] })
  expect(flagCount(general)).toBe(1)
})

test('the receipt names type, time, files, scope and denials', () => {
  const run = blankRun({
    status: 'completed',
    tools: [{ at: 'x', tool: 'Bash', ms: 1, outcome: 'denied', input: '{}' }],
    gitDelta: { files: [{ path: 'a.ts', change: 'changed' }, { path: 'b.ts', change: 'new' }], attribution: 'shared' },
    turns: [{ endedAt: 'x', reason: 'answer', durationMs: 1, usage: { output_tokens: 14254 } }],
    possibleMutations: [{ tool: 'Bash', input: 'rm x' }],
  })
  run.scope = evaluateScope(run)
  const text = receiptText(run)
  expect(text).toContain('Explore "find the parser" completed')
  expect(text).toContain('1m 5s')
  expect(text).toContain('2 files changed (git)')
  expect(text).toContain('a.ts, b.ts')
  expect(text).toContain('shared')
  expect(text).toContain('violation')
  expect(text).toContain('denied')
  expect(text).toContain('out 14k')
})

test('the text list handles no runs and many runs', () => {
  expect(listText([])).toContain('No subagent runs')
  const list = listText([blankRun(), blankRun({ status: 'running', endMs: undefined })])
  expect(list).toContain('2 subagent runs · 1 running')
})

// ---- the mod in an engine --------------------------------------------------

function memfs(on: On) {
  const files = new Map<string, string>()
  on('fs.write', (_$, e) => { files.set(norm(e.path), e.text); return { value: undefined } as never })
  on('fs.read', (_$, e) => {
    const body = files.get(norm(e.path))
    return body === undefined ? ({ deny: 'ENOENT' } as never) : ({ value: body } as never)
  })
  on('fs.list', (_$, e) => {
    const dir = norm(e.path).replace(/\/$/, '') + '/'
    const names = new Set<string>()
    for (const key of files.keys()) if (key.startsWith(dir)) names.add(key.slice(dir.length).split('/')[0] as string)
    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  const runs = () => [...files.entries()].filter(([k]) => k.endsWith('/run.json')).map(([, v]) => JSON.parse(v))
  return { files, runs }
}

// A fake git: `phase` picks what the working tree looks like.
function fakeGit(on: On, tree: { phase: number }) {
  const states: Record<number, { path: string; hash: string }[]> = {
    0: [{ path: 'keep.txt', hash: 'h-keep' }],
    1: [{ path: 'keep.txt', hash: 'h-keep' }, { path: 'made.txt', hash: 'h-made' }],
    2: [{ path: 'keep.txt', hash: 'h-keep-edited' }, { path: 'made.txt', hash: 'h-made' }],
  }
  on('process.run', (_$, e) => {
    const argv = e.argv as readonly string[]
    const sub = argv.includes('status') ? 'status' : argv.includes('hash-object') ? 'hash' : 'top'
    const files = states[tree.phase] ?? []
    const stdout =
      sub === 'top' ? '/repo\n'
      : sub === 'status' ? files.map(f => `?? ${f.path}`).join('\n') + '\n'
      : files.map(f => f.hash).join('\n') + '\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
}

function world(on: On) {
  const clock = mock.clock(on)
  mock.env(on, { USERPROFILE: ['C:', 'Users', 'tester'].join(BS) })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('command.register', () => ({ value: { command: 'subagents' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', () => ({ sessionId: 's' }) as never)
  return clock
}

const done = (agentId: string, answer = 'ok') =>
  ({ answer, durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer', usage: { output_tokens: 2000, model: 'm' } }) as never

test('git attribution catches edits made outside the edit tools, and a read-only agent is flagged', async ($, on) => {
  const fsx = memfs(on)
  const tree = { phase: 0 }
  fakeGit(on, tree)
  const clock = world(on)
  const session = mock.session(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-git000001' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('scout', 'Explore', { cwd: 'C:/repo' }))
  await pause(50)
  tree.phase = 2
  await $.turn.complete(done('agent-git000001'))
  await settle(clock)

  const run = fsx.runs()[0]
  expect(run.gitDelta.attribution).toBe('exclusive')
  expect(run.gitDelta.files).toEqual([
    { path: 'keep.txt', change: 'changed' },
    { path: 'made.txt', change: 'new' },
  ])
  expect(run.scope.declared).toBe('read-only')
  expect(run.scope.violations.length).toBe(2)
  const rows = session.appended()
  expect(rows.length).toBe(1)
  const body = JSON.stringify(rows[0]?.message)
  expect(body).toContain('subagent-audit: Explore')
  expect(body).toContain('violation')
})

test('overlapping subagents share attribution instead of claiming each other\'s files', async ($, on) => {
  const fsx = memfs(on)
  const tree = { phase: 0 }
  fakeGit(on, tree)
  const clock = world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `agent-ovl0000${++n}` }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('first', 'general-purpose'))
  await $.agent.spawn(spawnInput('second', 'general-purpose'))
  await pause(50)
  tree.phase = 1
  await $.turn.complete(done('agent-ovl00001'))
  await settle(clock)

  const first = fsx.runs().find(r => r.agentId === 'agent-ovl00001')
  expect(first.gitDelta.attribution).toBe('shared')
})

test('outside a git repository the delta is simply absent', async ($, on) => {
  const fsx = memfs(on)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-nogit0001' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'general-purpose'))
  await $.turn.complete(done('agent-nogit0001'))
  await settle(clock)
  expect(fsx.runs()[0].gitDelta).toBeUndefined()
  expect(fsx.runs()[0].scope.declared).toBe('unrestricted')
})

test('receipts and git attribution can be switched off', { options: { receipts: false, gitAttribution: false } }, async ($, on) => {
  const fsx = memfs(on)
  let gitCalls = 0
  on('process.run', () => { gitCalls += 1; return { value: { exitCode: 1, stdout: '', stderr: '' } } as never })
  const clock = world(on)
  const session = mock.session(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-off000001' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'Explore'))
  await $.turn.complete(done('agent-off000001'))
  await settle(clock)
  expect(gitCalls).toBe(0)
  expect(session.appended().length).toBe(0)
  expect(fsx.runs()[0].status).toBe('completed')
})

test('/subagents answers with the session list', async ($, on) => {
  memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-cmd000001' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('look around', 'Explore'))
  await $.turn.complete(done('agent-cmd000001'))
  await settle(clock)
  const reply = await $.command.run({
    command: 'subagents', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
  } as never)
  expect(JSON.stringify(reply)).toContain('1 subagent run')
})

test('the pane lists the runs and opens one in detail', async ($, on) => {
  memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-pane00001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('look around', 'Explore'))
  await $.tool.call({ tool: 'Read', agentId: 'agent-pane00001', file_path: 'a.ts' } as never)
  await $.turn.complete(done('agent-pane00001', 'found it'))
  await settle(clock)

  const pane = await $.ui.mount({
    plugin: 'subagent-audit', surface: 'terminal', component: 'Pane', requestId: 'subagent-audit',
    props: { bodyColumns: 100 },
  } as never)
  expect(await pane.findAll({ type: 'Button', text: /Explore/ })).toHaveLength(1)
  await pane.press({ key: 'run:agent-pane00001' } as never)
  expect(await pane.findAll({ type: 'Text', text: /Scope: read-only agent/ })).toHaveLength(1)
  expect(await pane.findAll({ type: 'Text', text: /found it/ })).toHaveLength(1)
})
