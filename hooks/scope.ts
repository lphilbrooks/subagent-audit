import type { Run, Scope } from './types'

// Agent types that are read-only by design: any write, flagged call or git
// change made by one of them is reported as a violation.
const READ_ONLY_TYPES = new Set(['explore', 'plan', 'claude-code-guide'])

const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function evaluateScope(run: Run): Scope {
  const type = String(run.spawn.subagentType ?? '').toLowerCase()
  const declared: Scope['declared'] = READ_ONLY_TYPES.has(type) ? 'read-only' : 'unrestricted'
  const violations: string[] = []
  if (declared === 'read-only') {
    for (const t of run.tools) {
      if (t.outcome === 'ok' && WRITERS.has(t.tool)) violations.push(`${t.tool} succeeded`)
    }
    for (const m of run.possibleMutations) violations.push(`${m.tool} call not marked read-only`)
    if (run.gitDelta && run.gitDelta.attribution === 'exclusive') {
      for (const f of run.gitDelta.files) violations.push(`git: ${f.path} ${f.change}`)
    }
  }
  return { declared, violations: [...new Set(violations)].slice(0, 20) }
}

export const deniedCalls = (run: Run) => run.tools.filter(t => t.outcome === 'denied').length

// How many things in this run deserve a second look: violations for a
// read-only agent, flagged Bash/MCP calls for any other.
export function flagCount(run: Run): number {
  const scope = run.scope ?? evaluateScope(run)
  return scope.declared === 'read-only' ? scope.violations.length : run.possibleMutations.length
}
