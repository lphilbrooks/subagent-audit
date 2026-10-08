import { duration, fmtDuration, fmtTokens, totals } from './receipt'
import { deniedCalls, evaluateScope, flagCount } from './scope'
import type { Run, RunStatus } from './types'

// The elements table `$.ui.resolve(e)` returns differs per surface; this view
// uses only Box, Text and Button, which every surface that draws a pane has.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Elements = { Box: any; Text: any; Button: any }

export type PaneCtx = {
  runs: Run[]
  selected: Run | undefined
  onlyFlagged: boolean
  columns: number
  rows: number
  select: (id: string) => void
  toggleFlagged: () => void
}

const GLYPH: Record<RunStatus, string> = {
  running: '●',
  completed: '✓',
  aborted: '■',
  error: '✗',
  refused: '⊘',
  denied: '⊘',
  unfinished: '…',
}

const COLOR: Record<RunStatus, string | undefined> = {
  running: 'yellow',
  completed: 'green',
  aborted: undefined,
  error: 'red',
  refused: 'red',
  denied: 'red',
  unfinished: undefined,
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function runLabel(run: Run): string {
  const type = String(run.spawn.subagentType ?? 'agent')
  const what = oneLine(String(run.spawn.description ?? ''))
  const ms = duration(run)
  const files = run.gitDelta ? run.gitDelta.files.length : run.filesChanged.length
  const flags = flagCount(run)
  return [
    `${GLYPH[run.status]} ${type}${what ? ` · ${what}` : ''}`,
    ms !== undefined ? fmtDuration(ms) : run.status,
    plural(run.tools.length, 'tool'),
    plural(files, 'file'),
    flags > 0 ? `⚠ ${flags}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

// The plain-text list `/subagents` answers with, for surfaces that draw no pane.
export function listText(runs: Run[]): string {
  if (runs.length === 0) return 'No subagent runs recorded in this session yet.'
  const running = runs.filter(r => r.status === 'running').length
  const flagged = runs.filter(r => flagCount(r) > 0).length
  const head = `${plural(runs.length, 'subagent run')} · ${running} running · ${flagged} flagged`
  return [head, ...runs.slice(0, 15).map(runLabel)].join('\n')
}

export function buildPane(E: Elements, ctx: PaneCtx) {
  const { Box, Text, Button } = E
  const width = Math.max(30, ctx.columns - 2)

  if (ctx.selected) {
    const run = ctx.selected
    const scope = run.scope ?? evaluateScope(run)
    const t = totals(run)
    const ms = duration(run)
    const room = Math.max(6, ctx.rows - 22)
    const git = run.gitDelta
    const timeline = run.tools.slice(-Math.min(room, 14))
    const t0 = run.startMs ?? Date.parse(run.startedAt)
    const denied = deniedCalls(run)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Button key="back" plain onPress={() => ctx.select('')}>← All subagents</Button>
        <Text bold color={COLOR[run.status]}>{cut(`${GLYPH[run.status]} ${run.spawn.subagentType ?? 'agent'} · ${oneLine(String(run.spawn.description ?? ''))}`, width)}</Text>
        <Text dimColor>{cut([run.status, ms !== undefined ? fmtDuration(ms) : undefined, String(run.spawn.resolvedModel ?? run.spawn.requestedModel ?? ''), run.spawn.permissionMode ? `mode ${run.spawn.permissionMode}` : undefined, run.spawn.background ? 'background' : undefined].filter(Boolean).join(' · '), width)}</Text>
        <Text dimColor>{cut(`tokens: in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache read ${fmtTokens(t.cached)}`, width)}</Text>

        <Text bold color={scope.violations.length > 0 ? 'red' : undefined}>
          Scope: {scope.declared} agent{scope.violations.length > 0 ? ` · ${plural(scope.violations.length, 'violation')}` : ' · no violations'}
        </Text>
        {scope.violations.slice(0, 6).map((v: string) => <Text color="red">{cut(`  ${v}`, width)}</Text>)}
        {denied > 0 && <Text dimColor>{`  ${plural(denied, 'tool call')} denied`}</Text>}

        <Text bold>
          Changed in git{git ? ` (${git.attribution})` : ''}
        </Text>
        {!git && <Text dimColor>  not available (not a git repository, or the check did not run)</Text>}
        {git && git.files.length === 0 && <Text dimColor>  no file changes between start and end</Text>}
        {git && git.attribution === 'shared' && git.files.length > 0 && <Text dimColor>  shared: others may have changed these</Text>}
        {git && git.files.slice(0, 10).map(f => <Text>{cut(`  ${f.change.padEnd(7)} ${f.path}`, width)}</Text>)}
        {git && git.files.length > 10 && <Text dimColor>{`  +${git.files.length - 10} more`}</Text>}

        {run.filesChanged.length > 0 && <Text bold>Edited with Edit/Write ({run.filesChanged.length})</Text>}
        {run.filesChanged.slice(0, 6).map((f: string) => <Text dimColor>{cut(`  ${f}`, width)}</Text>)}

        {run.possibleMutations.length > 0 && <Text bold color="yellow">Flagged calls ({run.possibleMutations.length})</Text>}
        {run.possibleMutations.slice(0, 6).map(m => <Text>{cut(`  ${m.tool}: ${oneLine(m.input)}`, width)}</Text>)}

        <Text bold>Tool calls ({run.tools.length}{run.toolsDropped > 0 ? ` + ${run.toolsDropped} not kept` : ''})</Text>
        {timeline.map(c => (
          <Text color={c.outcome === 'ok' ? undefined : 'red'} dimColor={c.outcome === 'ok'}>
            {cut(`  +${fmtDuration(Math.max(0, Date.parse(c.at) - t0)).padEnd(6)} ${c.tool.padEnd(8)} ${c.outcome === 'ok' ? '' : `${c.outcome} `}${oneLine(c.input)}`, width)}
          </Text>
        ))}

        <Text bold>Task</Text>
        <Text dimColor>{cut(oneLine(String(run.spawn.prompt ?? '')), width * 3)}</Text>
        {run.answer && <Text bold>Result</Text>}
        {run.answer && <Text>{cut(oneLine(run.answer), width * 4)}</Text>}

        <Text dimColor>{cut(`record: ~/.claude/agent-runs/${run.folder}`, width)}</Text>
        <Text dimColor>{cut(`native transcript: subagents/agent-${run.agentId}.jsonl`, width)}</Text>
      </Box>
    )
  }

  const visible = ctx.onlyFlagged ? ctx.runs.filter(r => flagCount(r) > 0) : ctx.runs
  const running = ctx.runs.filter(r => r.status === 'running').length
  const flagged = ctx.runs.filter(r => flagCount(r) > 0).length
  const room = Math.max(3, ctx.rows - 5)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{plural(ctx.runs.length, 'subagent run')} · {running} running · {flagged} flagged</Text>
      <Button key="filter" plain dimColor onPress={ctx.toggleFlagged}>{ctx.onlyFlagged ? 'Showing flagged only · show all' : 'Show flagged only'}</Button>
      {visible.length === 0 && <Text dimColor>{ctx.onlyFlagged ? 'Nothing flagged.' : 'No subagent runs in this session yet.'}</Text>}
      {visible.slice(0, room).map(run => (
        <Button key={`run:${run.agentId}`} plain onPress={() => ctx.select(run.agentId)}>
          {cut(runLabel(run), width)}
        </Button>
      ))}
      {visible.length > room && <Text dimColor>{`+${visible.length - room} older`}</Text>}
    </Box>
  )
}
