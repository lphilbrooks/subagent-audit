import { deniedCalls, evaluateScope } from './scope'
import type { Run } from './types'

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export function totals(run: Run): { input: number; output: number; cached: number } {
  let input = 0
  let output = 0
  let cached = 0
  for (const t of run.turns) {
    const u = (t.usage ?? {}) as Usage
    input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    output += u.output_tokens ?? 0
    cached += u.cache_read_input_tokens ?? 0
  }
  return { input, output, cached }
}

export function duration(run: Run): number | undefined {
  return run.startMs !== undefined && run.endMs !== undefined ? run.endMs - run.startMs : undefined
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// The notice written into the chat when a subagent finishes: up to four short
// lines. The model never reads it.
export function receiptText(run: Run): string {
  const scope = run.scope ?? evaluateScope(run)
  const type = String(run.spawn.subagentType ?? 'agent')
  const what = String(run.spawn.description ?? '').slice(0, 60)
  const ms = duration(run)
  const t = totals(run)
  const files = run.gitDelta ? run.gitDelta.files.length : run.filesChanged.length
  const head = [
    `subagent-audit: ${type}${what ? ` "${what}"` : ''} ${run.status}`,
    ms !== undefined ? fmtDuration(ms) : undefined,
    plural(run.tools.length, 'tool call'),
    `${plural(files, 'file')} changed (${run.gitDelta ? 'git' : 'edit tools'})`,
    `out ${fmtTokens(t.output)}`,
  ].filter(Boolean)
  const lines = [head.join(' · ')]
  if (run.gitDelta && run.gitDelta.files.length > 0) {
    const shown = run.gitDelta.files.slice(0, 5).map(f => f.path).join(', ')
    const more = run.gitDelta.files.length > 5 ? ` +${run.gitDelta.files.length - 5} more` : ''
    const shared = run.gitDelta.attribution === 'shared' ? ' (shared: others may have changed these)' : ''
    lines.push(`  changed: ${shown}${more}${shared}`)
  }
  if (scope.violations.length > 0) {
    lines.push(`  scope: ${scope.declared} agent, ${plural(scope.violations.length, 'violation')}: ${scope.violations.slice(0, 3).join('; ')}`)
  } else if (run.possibleMutations.length > 0) {
    lines.push(`  flagged: ${plural(run.possibleMutations.length, 'Bash/MCP call')} not marked read-only`)
  }
  const denied = deniedCalls(run)
  if (denied > 0) lines.push(`  ${plural(denied, 'tool call')} denied`)
  return lines.join('\n')
}
