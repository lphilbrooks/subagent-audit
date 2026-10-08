# subagent-audit

A [Claude Code](https://code.claude.com) mod that adds transparency to native subagents. Claude Code already saves each subagent's raw transcript; this mod adds what the transcript doesn't tell you at a glance:

- **Which files a subagent really changed**, including edits made through Bash, found by comparing `git status` (with file content hashes) when the subagent starts and when it ends. Runs that overlapped another subagent, or ran in the background, are marked *shared* instead of claiming files that may not be theirs.
- **Scope checks.** Agents that are read-only by design (`Explore`, `Plan`, `claude-code-guide`) are held to it: a successful write, a Bash/MCP call the engine did not mark read-only, or a git change is reported as a violation.
- **A receipt in the chat** when each subagent finishes: type, time, tool calls, files changed, violations, denied calls, output tokens. It is a notice row the model never reads, so it costs no usage, and it is saved in the session transcript.
- **`/subagents`**, a pane listing this session's subagents (finished ones too, which the built-in views drop after about 30 seconds) with scope verdict, git changes, flagged calls, a tool timeline, the task and the result.
- **A durable, redacted record** of every run in `~/.claude/agent-runs/`, independent of the transcript store's cleanup.

No model calls and no network. Git runs locally.

## What gets recorded

One folder per run in `~/.claude/agent-runs/` (or `$CLAUDE_CONFIG_DIR/agent-runs/` if that is set):

| File | Contents |
| --- | --- |
| `run.json` | Spawn parameters (type, description, requested and resolved model, permission mode, background/fork, parent, working directory), every tool call (time, duration, outcome, truncated input and output preview), files changed (edit tools and git), Bash/MCP calls the engine did not mark read-only, the scope verdict, each turn with token usage and its answer, and the final status |
| `prompt.md` | The task the subagent was given |
| `result.md` | Its latest final report |

Statuses: `running`, `completed`, `aborted`, `refused`, `error`, `denied` (spawn refused), `unfinished` (still running when the session ended).

Folder names look like `2026-10-08_143200_explore_find-the-parser_<agent-id-tail>`, so they sort by time.

## Settings

| Option | Default | Effect |
| --- | --- | --- |
| `receipts` | on | Write the finish receipt into the chat |
| `gitAttribution` | on | Compare git state at start and end. Turning it off removes the git file list and the git-based scope checks |

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
- The git comparison reads file *contents* only to hash them; nothing from the files is stored except their paths. Untracked files count, ignored files do not.
- Before a subagent starts, the mod waits up to 1.5 seconds for the first git snapshot (usually well under 0.1 s); a slower repository simply goes without a delta for that run.
- Files are created with your default permissions. There is no automatic retention: delete old run folders yourself.
- Keep `~/.claude/agent-runs` out of cloud sync and Git.

## Limits

- The git delta sees changes inside the repository the subagent works in, not files elsewhere on disk, network calls or processes it started. Subagents running at the same time cannot be told apart, so those runs are marked shared. `filesChanged` covers Edit, Write and NotebookEdit calls; `possibleMutations` lists Bash and MCP calls the engine did not mark read-only.
- Appending a receipt into the subagent's own transcript is not possible once it has finished, so receipts go into the main chat.
- The pane after a reload or resume shows only this session's runs recorded by 0.3.0 or later (older records carry no session id).
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
