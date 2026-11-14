# audit-install

Claude Code fails quietly in five specific places. This skill checks all of them.

## What it catches

- a **hook** whose script was deleted — the hook simply never runs, and nothing says so
- a **skill** whose `name` does not match its directory — it never fires
- a **plugin** whose install path is gone — still listed as installed
- a **CLAUDE.md** large enough to tax every single turn, subagents included
- a **credential** sitting in plaintext in `settings.json`, reported masked

## Why it is worth installing

Every item above produces no error message. You find out by noticing that something you
configured months ago has not been working. The tool is read-only: it reports, and the fix is
yours to apply.

## Requirements

Node.js >= 20. Reads `~/.claude` only. Creates, modifies and deletes nothing.
