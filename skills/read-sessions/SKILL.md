---
name: read-sessions
description: Explain what actually happened in a Claude Code session — which model answered when another was requested, where the tokens went, what silent compaction threw away, and what the upstream really said when a request failed. Use when the user asks "why did this cost so much", "为什么这么贵", "which model am I actually using", "did it switch models", "上下文怎么没了", "it forgot what I told it", "why did that request fail", or before blaming a provider for a bill.
license: MIT
compatibility: Requires Node.js >= 20. Reads Claude Code's own session logs under ~/.claude/projects. Read-only; it never modifies a transcript.
allowed-tools: Bash Read
---

# Read a Claude Code session

Claude Code writes one JSONL file per session under `~/.claude/projects/<project>/`.
That file holds every turn, the model the client *asked* for next to the model that
*answered*, the full token/cache accounting, every tool result including failures, every
upstream error with its retry counter, and a boundary record for every compaction.

None of it is shown to you. This skill turns it into a verdict.

```bash
# plugin install: tools live at the plugin root
TOOLKIT="${CLAUDE_PLUGIN_ROOT}"
# standalone skill: copy src/ into this skill's directory, then use:
# TOOLKIT="${CLAUDE_SKILL_DIR}"
```

## Run

```bash
node "$TOOLKIT/src/cf-analyze.mjs" --since 7d            # the report
node "$TOOLKIT/src/cf-analyze.mjs" --since 7d --json    # for parsing, not reading
node "$TOOLKIT/src/cf-analyze.mjs" --session <id-prefix> # one session
node "$TOOLKIT/src/cf-analyze.mjs" --projects           # per-project size and activity
```

## What each line actually means

| Line in the report | What it proves | What you must NOT say |
|---|---|---|
| `MODEL SUBSTITUTION` | the client requested one id and a different one answered — on a measured machine, 11,490 turns in 30 days | never "the model changed"; the request did not change, the answer did |
| `aliasExpansions` in `--json` | `sonnet` → a dated snapshot is normal and was excluded | do not merge this count into substitutions |
| `cache hit` | cache-read tokens ÷ (cache-read + fresh input) | a low rate on a *new* session is cold start, not a regression |
| `per prompt` | full prompt size per turn — what a compaction makes you pay again | not the same as "cost per turn" |
| `CONTEXT COMPACTION` | everything above the boundary is gone from the model's view | never "it forgot" without this record as evidence |
| `UPSTREAM ERRORS` | the provider's own words, plus whether it was retried | a retried-and-recovered turn is invisible in the UI, not in this log |
| `reported cost` | the client's own estimate from its pricing table | never call it a bill |
| `level: "unknown"` / `No sessions matched` | nothing was measured | **never** report this as healthy |

## Report shape

1. **Verdict** — one sentence, naming the mechanism (substitution, cold cache, compaction, quota).
2. **Numbers** — the actual figures, in the same units the tool printed.
3. **Evidence** — the session id or timestamp that shows it. A number without a source is a guess.
4. **Not measured** — if a window had no sessions, or the log was missing, say so and stop.

## Hard rules

- Never claim a fix. This is a read-only report; state what changed and let the user act.
- Never invent a model name, an error string or a token count. Quote what the tool printed.
- `--json` `level` is `unknown` when nothing was read. That is not a pass, and it is not an error either.
- A 429 that was retried and recovered is still a real event: it cost latency and it is why the
  turn felt slow. Report it as such rather than as a failure or as nothing.