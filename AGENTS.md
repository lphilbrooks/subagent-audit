# subagent-audit

Claude Code mod (plugin of function hooks) that adds transparency to native subagent runs: audit records in `~/.claude/agent-runs/`, git-based file attribution, scope checks, chat receipts and a `/subagents` pane.

- Source: `hooks/register.tsx` (hooks, recording, git snapshots), `view.tsx` (the `/subagents` pane), `scope.ts`, `gitdelta.ts`, `receipt.ts`, `redact.ts`, `types.ts`. State contract: `types/index.d.ts`. Tests: `hooks/*.test.ts`.
- Check with `npm run validate`, `npm test`, `npm run typecheck` (typecheck needs the engine-written `.claude-plugin/types/`, which appears once the mod has loaded from a folder you own).
- Validator rules: the `$` engine handle may only be passed to top-level `function` declarations of the file that uses it; atom keys must be string literals and declared in `types/index.d.ts`.
- No model calls, no network (git runs locally). Keep it that way.
- Hooks must return exactly what `next()` returned and record afterwards, inside try/catch. The only wait before a spawn is the git snapshot, capped at 1.5 s.
- Public repo: never commit local paths, real names, e-mail addresses or anything identifying beyond the GitHub username. Commits use the GitHub no-reply address.
