# subagent-audit

A [Claude Code](https://code.claude.com) mod that keeps an on-disk audit record of every native subagent run, so you can see afterwards what each subagent was asked, which model it ran on, what it did and what it reported.

No model calls, no network. Everything stays in local files.

## What you get

One folder per run in `~/.claude/agent-runs/` (or `$CLAUDE_CONFIG_DIR/agent-runs/` if that is set):

| File | Contents |
| --- | --- |
| `run.json` | Spawn parameters (type, description, requested and resolved model, permission mode, background/fork, parent, working directory), every tool call (time, duration, outcome, truncated input and output preview), files changed, Bash/MCP calls the engine did not mark read-only, each turn with token usage and its answer, and the final status |
| `prompt.md` | The task the subagent was given |
| `result.md` | Its latest final report |

Statuses: `running`, `completed`, `aborted`, `refused`, `error`, `denied` (spawn refused), `unfinished` (still running when the session ended).

Folder names look like `2026-10-08_143200_explore_find-the-parser_<agent-id-tail>`, so they sort by time.

## Requirements

Claude Code 2.1.287 or later, in the terminal or the desktop app's Code tab.

## Install

```
/plugin marketplace add lphilbrooks/subagent-audit
/plugin install subagent-audit@subagent-audit
```

To try it from a local clone: `claude --plugin-dir <path to this folder>`.

## Privacy

- Prompts, tool inputs (cut to 600 characters), tool output previews (300 characters) and answers are written to disk. Treat the folder like a transcript.
- Common secrets are replaced with `[redacted…]` before anything is stored: API keys and tokens with well-known prefixes, JWTs, private keys, `Authorization`/`Bearer` values, credentials inside URLs, and values after `password`, `secret`, `token`, `api_key` and similar names, including inside JSON-escaped strings. This is pattern matching and will miss some secrets.
- Files are created with your default permissions. There is no automatic retention: delete old run folders yourself.
- Keep `~/.claude/agent-runs` out of cloud sync and Git.

## Limits

- `filesChanged` covers Edit, Write and NotebookEdit only. `possibleMutations` lists Bash and MCP calls that succeeded and that the engine did not mark read-only; it is not a full list of side effects.
- At most 1000 tool entries are kept per run (`toolsDropped` counts the rest). Runs with more than 200 entries are rewritten at most every 10 seconds.
- Remote workflow agents never report a finished turn, so they end as `unfinished`.
- After a hot reload the mod finds a running subagent's folder again from its name; a truncated `run.json` cannot be recovered and the run continues in a new folder.
- `run.json` is rewritten whole on each flush; writes are not atomic.

## Develop

```
npm run validate    # claude plugin validate .
npm test            # claude plugin test .
npm run typecheck   # tsc against the typings the engine writes into .claude-plugin/types/
```

The typings appear after the mod has loaded once from a folder you own (for example via `--plugin-dir`).

## Licence

MIT
