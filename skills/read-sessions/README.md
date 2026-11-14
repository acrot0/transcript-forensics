# read-sessions

A Claude Code skill that answers what actually happened in a session, from the log the client
already wrote — not from guesswork.

## What it does

Reads `~/.claude/projects/**/*.jsonl` (read-only) and reports:

- **which model answered** when a different one was requested, with the turn count
- **where the tokens went**, including the cache-hit rate that decides what a week costs
- **what compaction threw away** — every auto-compaction, its trigger, and the tokens dropped
- **which tool calls failed**, and how many upstream errors were retried away silently

## Why the description matters

On a measured machine this is not a marginal feature: over 30 days, 11,490 turns were answered by
a model the client had not requested, and 119 context compactions dropped 19.2M tokens without a
single prompt. None of that is visible in the UI. A skill that cannot name the mechanism is
worse than no skill, because it produces a confident wrong answer.

## Requirements

Node.js >= 20. No dependencies. No network. No writes.

## What it will not do

It never claims a fix. It reports what the log shows and says *unmeasured* when there is no log
— the one answer a diagnostic tool must never get wrong.
