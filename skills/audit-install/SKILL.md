---
name: audit-install
description: Audit a Claude Code installation for the failures that produce no error message — hooks pointing at deleted scripts, skills whose frontmatter the loader rejects, plugins whose install path is gone, always-injected CLAUDE.md cost, credential copies left in backups. Use for "hooks not running", "my skill never triggers", "Claude Code feels slow", "体检", "check my setup", or after moving machines or renaming a directory.
license: MIT
compatibility: Requires Node.js >= 20. Reads ~/.claude only; creates, modifies and deletes nothing.
allowed-tools: Bash Read
---

# Audit the installation, not the conversation

Every check here covers something that fails **quietly**. A hook whose script was deleted does
not error — it simply does not run, and the behaviour you configured is silently absent. A skill
whose `name` does not match its directory never fires, and nothing says so. A plugin whose install
path is gone stays listed as installed.

```bash
TOOLKIT="${CLAUDE_PLUGIN_ROOT}"
# standalone: TOOLKIT="${CLAUDE_SKILL_DIR}"
node "$TOOLKIT/src/cf-doctor.mjs"
node "$TOOLKIT/src/cf-doctor.mjs" --json
```

## How to read each check

| Check | `warn`/`fail` means | Do not say |
|---|---|---|
| `settingsParse` **fail** | the file is invalid JSON and Claude Code ignores **all** of it | do not report only the one broken key — everything in that file is inactive |
| `inlineSecret` | a credential sits in plaintext; `apiKeyHelper` is exempt by design | do not echo the value; the tool masks it and so should you |
| `apiKeyHelper` **fail** | the command it points at does not exist — every keyed request fails before leaving the machine | the error will not name this path, so name it |
| `hooks` | a referenced script is missing, so that hook never runs | "hooks are broken" is too broad — name the event and the path |
| `skills` | a skill will not load or will never fire | a name mismatch is fatal, a long description is a silent truncation |
| `memoryFile` | CLAUDE.md is large and is injected into **every** turn, subagents included | this is a per-turn tax, not a one-time cost |
| `plugins` | registered but unloadable | do not conflate "registered" with "working" |
| `backups` | stale copies of settings, each one a copy of any credential in it | archiving is the user's call; propose, do not delete |
| `transcripts` | session log size; `cleanupPeriodDays` sets retention | a large log is not a bug — it is the forensics source |

## Hard rules

- Read-only. Never edit `settings.json`, never delete a backup, never delete a transcript.
- Never print a secret. If a check reports one, repeat only the masked form the tool printed.
- A check that could not run (`No ~/.claude`, unreadable file) is **unmeasured**. Say that; do not
  fold it into "all good".
- Never claim a fix. This skill reports; the user edits `settings.json`, not you.
- A `warn` is not a failure. Do not tell the user their install is broken when every check passed
  and one backup file is stale.