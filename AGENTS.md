# subagent-audit

Claude Code mod (plugin of function hooks) that logs native subagent runs to `~/.claude/agent-runs/`.

- Source: `hooks/register.ts`. Tests: `hooks/register.test.ts`.
- Check with `npm run validate`, `npm test`, `npm run typecheck` (typecheck needs the engine-written `.claude-plugin/types/`, which appears once the mod has loaded from a folder you own).
- Validator rule: `$` may only be passed to top-level `function` declarations.
- No model calls, no network. Keep it that way.
- Public repo: never commit local paths, real names, e-mail addresses or anything identifying beyond the GitHub username. Commits use the GitHub no-reply address.
