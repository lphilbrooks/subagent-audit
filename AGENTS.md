# subagent-audit

Claude Code mod (plugin of function hooks) that logs native subagent runs to `~/.claude/agent-runs/`.

- Source: `hooks/register.tsx` (hooks, recording, git snapshots), `view.tsx` (the `/subagents` pane), `scope.ts`, `gitdelta.ts`, `receipt.ts`, `redact.ts`, `types.ts`. State contract: `types/index.d.ts`. Tests: `hooks/*.test.ts`.
- Validator rules: `# subagent-audit

Claude Code mod (plugin of function hooks) that logs native subagent runs to `~/.claude/agent-runs/`.

 may only be passed to top-level `function` declarations of the file that uses it; atom keys must be string literals and declared in `types/index.d.ts`.
- Check with `npm run validate`, `npm test`, `npm run typecheck` (typecheck needs the engine-written `.claude-plugin/types/`, which appears once the mod has loaded from a folder you own).
- No model calls, no network (git runs locally). Keep it that way.
- Public repo: never commit local paths, real names, e-mail addresses or anything identifying beyond the GitHub username. Commits use the GitHub no-reply address.
