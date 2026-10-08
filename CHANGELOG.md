# Changelog

## 0.2.2 - 2026-10-08
- Hooks now return `next()`'s result untouched and do all recording afterwards, off the engine's path. A recording failure can no longer block or delay a spawn or tool call.
- Tool arguments and outputs are clipped before redaction, so a large `Write` is never scanned whole.
- The flush timer is armed by `session.start` and by the first tool call or turn, so a hot reload without a new `session.start` still flushes.
- A late spawn record merges into the run its tool events already created (no duplicate folder).
- Failed writes are retried; shutdown waits at most 2 s for writes.
- Runs resumed after finishing go back to `running`; evicted runs and their bookkeeping are dropped together.
- `$CLAUDE_CONFIG_DIR` is respected; an empty `HOME` or `USERPROFILE` is treated as unset.
- Redaction now covers JSON-escaped values, JWTs, more token prefixes, `Authorization` headers, URL credentials and `pass`/`pwd` style keys; refusal text, errors, denials, `cwd` and `name` are redacted too.
- `filesChanged` is normalised against the subagent's `cwd` and capped.
- Folder names are made unique; a folder name on disk wins over the one inside `run.json`.

## 0.2.1 - 2026-10-08
- Renamed to `subagent-audit`.

## 0.2.0 - 2026-10-08
- Runs saved to `~/.claude/agent-runs/`; secret redaction; reload recovery; chained per-run writes; per-turn answers; `possibleMutations`; `unfinished` status; tool-entry cap; throttled rewrites for long runs.

## 0.1.0 - 2026-10-08
- First version: one folder per native subagent run with `run.json`, `prompt.md`, `result.md`.
