import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const BS = String.fromCharCode(92)
const norm = (p: string) => p.split(BS).join('/')
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  await clock.advance(2500)
  await pause(120)
}

// The full agent.spawn input the engine would raise; the mod reads only some of it.
const spawnInput = (prompt: string, description: string, subagentType: string, cwd?: string) =>
  ({
    prompt, description, subagentType, cwd, tool_use_id: 'tu-1', provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus', background: false, fork: false,
  }) as never
const SESSION = { cwd: 'C:/work', surface: null, isInteractive: false } as const

// An in-memory file system under the plugins, keyed by forward-slash paths.
function memfs(on: On, seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  on('fs.write', (_$, e) => {
    writes.push(norm(e.path))
    files.set(norm(e.path), e.text)
    return { value: undefined } as never
  })
  on('fs.read', (_$, e) => {
    const body = files.get(norm(e.path))
    return body === undefined ? ({ deny: 'ENOENT' } as never) : ({ value: body } as never)
  })
  on('fs.list', (_$, e) => {
    const dir = norm(e.path).replace(/\/$/, '') + '/'
    const names = new Set<string>()
    for (const key of files.keys()) {
      if (key.startsWith(dir)) names.add(key.slice(dir.length).split('/')[0] as string)
    }
    return { value: [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  const find = (suffix: string) => [...files.keys()].filter(k => k.endsWith(suffix))
  const json = (suffix: string) => JSON.parse(files.get(find(suffix)[0] as string) as string)
  return { files, find, json, writes }
}

function world(on: On, env: Record<string, string> = { USERPROFILE: ['C:', 'Users', 'tester'].join(BS) }) {
  const clock = mock.clock(on)
  mock.env(on, env)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', () => ({ sessionId: 's' }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return clock
}

const turn = (agentId: string, answer: string, reason: 'answer' | 'aborted' = 'answer') =>
  ({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't', agentId, reason }) as never

test('records a subagent run to disk', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1234abcd' }))
  on('tool.call', () => ({ result: 'ok', text: 'file contents' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('Read README.md', 'Read readme', 'Explore'))
  await $.tool.call({ tool: 'Edit', agentId: 'agent-1234abcd', file_path: 'C:/p/a.txt', old_string: 'x', new_string: 'y' } as never)
  await $.turn.complete(turn('agent-1234abcd', 'Done.'))
  await settle(clock)

  const [runKey] = fsx.find('/run.json')
  expect(runKey).toContain('C:/Users/tester/.claude/agent-runs/')
  const run = fsx.json('/run.json')
  expect(run.status).toBe('completed')
  expect(run.filesChanged).toEqual(['C:/p/a.txt'])
  expect(run.tools.length).toBe(1)
  expect(run.answer).toBe('Done.')
  expect(fsx.find('/prompt.md').length).toBe(1)
  expect(fsx.find('/result.md').length).toBe(1)
})

test('hooks hand back exactly what the engine answered', async ($, on) => {
  memfs(on)
  world(on)
  const spawned = { model: 'haiku', agentId: 'agent-pass00001' }
  const called = { result: 'ok', text: 'same' }
  on('agent.spawn', () => spawned)
  on('tool.call', () => called as never)

  await $.session.start(SESSION)
  expect(await $.agent.spawn(spawnInput('x', 'x', 'Explore'))).toEqual(spawned)
  expect(await $.tool.call({ tool: 'Read', agentId: 'agent-pass00001', file_path: 'a' } as never)).toEqual(called)
})

test('a failing write never breaks the spawn, and is retried', async ($, on) => {
  const files = new Map<string, string>()
  let failures = 2
  const clock = world(on)
  on('fs.write', (_$, e) => {
    if (failures > 0) {
      failures -= 1
      throw new Error('disk full')
    }
    files.set(norm(e.path), e.text)
    return { value: undefined } as never
  })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-zzzz9999' }))

  await $.session.start(SESSION)
  const started = await $.agent.spawn(spawnInput('x', 'x', 'Explore'))
  expect(started.agentId).toBe('agent-zzzz9999')
  await settle(clock)
  await settle(clock)
  expect([...files.keys()].some(k => k.endsWith('/run.json'))).toBe(true)
})

test('a spawn the engine refuses or fails is recorded', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  let mode = 'deny'
  on('agent.spawn', () => {
    if (mode === 'throw') throw new Error('boom')
    return { deny: 'nope' }
  })

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'x', 'Explore'))
  await settle(clock)
  expect(fsx.json('/run.json').status).toBe('denied')

  mode = 'throw'
  let threw = false
  try {
    await $.agent.spawn(spawnInput('y', 'y', 'Explore'))
  } catch {
    threw = true
  }
  await settle(clock)
  expect(threw).toBe(true)
  const statuses = fsx.find('/run.json').map(k => JSON.parse(fsx.files.get(k) as string).status).sort()
  expect(statuses).toEqual(['denied', 'error'])
})

test('tool errors, denials, mutations and secrets', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  let answer: unknown
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-tools0001' }))
  on('tool.call', () => answer as never)

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('use the key', 'tools', 'general-purpose'))

  answer = { result: 'x', text: 'out', isReadOnly: true }
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tools0001', command: 'ls' } as never)
  answer = { result: 'x', text: 'wrote it' }
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tools0001', command: 'echo API_KEY=abcd1234efgh > x' } as never)
  answer = { isError: true, result: 'boom', text: 'boom' }
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tools0001', command: 'false' } as never)
  answer = { deny: 'not allowed' }
  await $.tool.call({ tool: 'Bash', agentId: 'agent-tools0001', command: 'rm -rf /' } as never)
  await settle(clock)

  const run = fsx.json('/run.json')
  expect(run.tools.map((t: { outcome: string }) => t.outcome)).toEqual(['ok', 'ok', 'error', 'denied'])
  expect(run.possibleMutations.length).toBe(1)
  expect(JSON.stringify(run)).not.toContain('abcd1234efgh')
})

test('redaction covers common secret shapes and leaves ordinary text', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-redact001' }))
  const secrets = [
    ['sk', 'ant', 'a1b2c3d4e5f6g7h8'].join('-'),
    ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1'].join('_'),
    ['eyJ', 'hbGciOiJIUzI1'].join('') + '.' + ['eyJ', 'zdWIiOiIxMjM0'].join('') + '.' + 'SflKxwRJSMeKKF2Q',
    'hunter2hunter2',
    'dXNlcjpwYXNzd29yZA==',
    'Sup3rS3cretVal',
    'abcd1234efgh',
    ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
    ['sk', 'live', 'abcdefghijklmnopqrstu'].join('_'),
  ]
  const prompt = [
    `key ${secrets[0]}`,
    `gh ${secrets[1]}`,
    `jwt ${secrets[2]}`,
    `url postgres://user:${secrets[3]}@db.example.com/x`,
    `Authorization: Basic ${secrets[4]}`,
    `json {\\"password\\":\\"${secrets[5]}\\"}`,
    `api_key=${secrets[6]}`,
    `aws ${secrets[7]}`,
    `stripe ${secrets[8]}`,
    'max_tokens: 5000 and a normal sentence about tokens.',
  ].join('\n')

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput(prompt, 'redaction', 'Explore'))
  await settle(clock)

  const stored = JSON.stringify(fsx.json('/run.json')) + (fsx.files.get(fsx.find('/prompt.md')[0] as string) ?? '')
  for (const secret of secrets) expect(stored).not.toContain(secret)
  expect(stored).toContain('max_tokens: 5000')
})

test('aborted and repeated turns keep each answer; a resumed agent runs again', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-turns0001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'turns', 'Explore'))
  await $.turn.complete(turn('agent-turns0001', 'first'))
  await $.turn.complete(turn('agent-turns0001', 'second', 'aborted'))
  await settle(clock)
  let run = fsx.json('/run.json')
  expect(run.turns.map((t: { answer: string }) => t.answer)).toEqual(['first', 'second'])
  expect(run.status).toBe('aborted')

  await $.tool.call({ tool: 'Read', agentId: 'agent-turns0001', file_path: 'a' } as never)
  await settle(clock)
  run = fsx.json('/run.json')
  expect(run.status).toBe('running')
  expect(run.resumedAt).toBeDefined()
})

test('a reload without a new session.start still flushes', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-reload001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))

  // no $.session.start here
  await $.agent.spawn(spawnInput('x', 'reload', 'Explore'))
  await $.tool.call({ tool: 'Read', agentId: 'agent-reload001', file_path: 'a' } as never)
  await settle(clock)
  expect(fsx.json('/run.json').tools.length).toBe(1)
})

test('tool events that beat the spawn merge into one run', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-early0001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Read', agentId: 'agent-early0001', file_path: 'a' } as never)
  await pause(50)
  await $.agent.spawn(spawnInput('the real prompt', 'early', 'Explore'))
  await settle(clock)

  expect(fsx.find('/run.json').length).toBe(1)
  const run = fsx.json('/run.json')
  expect(run.tools.length).toBe(1)
  expect(run.spawn.prompt).toBe('the real prompt')
})

test('after a reload the run is picked up from disk, not duplicated', async ($, on) => {
  const folder = '2026-10-08_100000_explore_old_ent-old00001'
  const root = 'C:/Users/tester/.claude/agent-runs'
  const seeded = {
    agentId: 'agent-old00001', folder: 'wrong-name', status: 'running', startedAt: 'x', spawn: { prompt: 'p' },
    tools: [], toolsDropped: 0, filesChanged: [], possibleMutations: [], turns: [],
  }
  const fsx = memfs(on, { [`${root}/${folder}/run.json`]: JSON.stringify(seeded) })
  const clock = world(on)
  on('tool.call', () => ({ result: 'ok', text: 'hi' }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Read', agentId: 'agent-old00001', file_path: 'a' } as never)
  await settle(clock)

  expect(fsx.find('/run.json').length).toBe(1)
  expect(fsx.find('/run.json')[0]).toContain(folder)
  expect(fsx.json('/run.json').tools.length).toBe(1)
})

test('a truncated run.json on disk gets a fresh stub instead of a crash', async ($, on) => {
  const root = 'C:/Users/tester/.claude/agent-runs'
  const fsx = memfs(on, { [`${root}/2026-10-08_100000_explore_old_ent-bad000001/run.json`]: '{"agentId": "agent-bad000001", "tools": [' })
  const clock = world(on)
  on('tool.call', () => ({ result: 'ok', text: 'hi' }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Read', agentId: 'agent-bad000001', file_path: 'a' } as never)
  await settle(clock)
  expect(fsx.find('/run.json').length).toBe(2)
})

test('tool entries are capped and counted', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-cap000001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'cap', 'Explore'))
  for (let i = 0; i < 1005; i++) await $.tool.call({ tool: 'Read', agentId: 'agent-cap000001', file_path: 'a' } as never)
  await clock.advance(20000)
  await pause(200)
  const run = fsx.json('/run.json')
  expect(run.tools.length).toBe(1000)
  expect(run.toolsDropped).toBe(5)
})

test('changed files are normalised against the working directory and deduplicated', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-files0001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'files', 'general-purpose', 'C:/proj'))
  const id = 'agent-files0001'
  await $.tool.call({ tool: 'Edit', agentId: id, file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Write', agentId: id, file_path: ['src', 'a.ts'].join(BS), content: 'z' } as never)
  await $.tool.call({ tool: 'NotebookEdit', agentId: id, notebook_path: 'nb.ipynb', new_source: 'z' } as never)
  await settle(clock)
  expect(fsx.json('/run.json').filesChanged).toEqual(['C:/proj/src/a.ts', 'C:/proj/nb.ipynb'])
})

test('session end marks running runs unfinished', async ($, on) => {
  const fsx = memfs(on)
  world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-end00001' }))

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'end', 'Explore'))
  await $.session.end({ reason: 'other' } as never)
  await pause(120)
  expect(fsx.json('/run.json').status).toBe('unfinished')
})

test('home folder resolution: HOME, CLAUDE_CONFIG_DIR, empty and missing values', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on, { HOME: '/home/tester', USERPROFILE: '' })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-home0001' }))
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'home', 'Explore'))
  await settle(clock)
  expect(fsx.find('/run.json')[0]).toContain('/home/tester/.claude/agent-runs/')
})

test('CLAUDE_CONFIG_DIR wins over the home folder', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on, { CLAUDE_CONFIG_DIR: '/custom/claude', HOME: '/home/tester' })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-conf0001' }))
  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'conf', 'Explore'))
  await settle(clock)
  expect(fsx.find('/run.json')[0]).toContain('/custom/claude/agent-runs/')
})

test('with no home folder at all nothing is written and nothing breaks', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on, {})
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-none0001' }))
  await $.session.start(SESSION)
  const started = await $.agent.spawn(spawnInput('x', 'none', 'Explore'))
  await settle(clock)
  expect(started.agentId).toBe('agent-none0001')
  expect(fsx.writes.length).toBe(0)
})

test('very long runs are rewritten at most every 10 seconds', async ($, on) => {
  const fsx = memfs(on)
  const clock = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-long00001' }))
  on('tool.call', () => ({ result: 'ok', text: 'hi', isReadOnly: true }))
  const call = () => $.tool.call({ tool: 'Read', agentId: 'agent-long00001', file_path: 'a' } as never)
  const runWrites = () => fsx.writes.filter(w => w.endsWith('/run.json')).length

  await $.session.start(SESSION)
  await $.agent.spawn(spawnInput('x', 'long', 'Explore'))
  for (let i = 0; i < 205; i++) await call()
  await settle(clock)
  const afterFirst = runWrites()
  await call()
  await clock.advance(2500)
  await pause(50)
  expect(runWrites()).toBe(afterFirst)
  await clock.advance(10000)
  await pause(120)
  expect(runWrites()).toBe(afterFirst + 1)
})
