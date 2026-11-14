# transcript-forensics

[![tests](https://img.shields.io/badge/tests-149%20passing-brightgreen)](test/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-blue)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Read-only forensics for **Claude Code**. Claude Code writes a complete record of every session to
disk and then shows almost none of it. These tools read that record.

```bash
npx transcript-forensics atlas --since 30d --out atlas.html
```

One command, one self-contained HTML file — no server, no CDN, no JavaScript, no network. It joins
session history, which model actually answered, what compaction threw away, upstream errors, and
install state into a page you can open from disk in five years.

| Question | Command |
|---|---|
| Which model actually answered when I asked for another? | `analyze` |
| What is this costing, per model and per prompt? | `cost` |
| Why is a hook/skill/plugin silently not working? | `doctor` |
| Show me all of it, as one page | `atlas` |

## Which of my two projects do you want?

| You use | Install |
|---|---|
| Claude Code, no custom gateway | **this repo** — `transcript-forensics` |
| Claude Code **through Claude Code Router (CCR)** | [ccr-toolkit](https://github.com/acrot0/ccr-toolkit) — gateway-side diagnosis |
| Both | both; they read different files and do not overlap |

This one reads `~/.claude` (session logs and config). ccr-toolkit reads CCR's own databases
(`request-log.sqlite`, `usage.sqlite`). Neither needs the other.

## Install

**As a Claude Code plugin** (Claude Code ≥ 2.1.275):

```bash
/plugin marketplace add acrot0/transcript-forensics
/plugin install transcript-forensics --marketplace acrot0/transcript-forensics
```

That adds four skills: `read-sessions`, `audit-spend`, `audit-install`, `triage-failure`.

**As a CLI** (Node.js ≥ 20):

```bash
git clone https://github.com/acrot0/transcript-forensics.git
cd transcript-forensics
node src/cf-analyze.mjs --since 7d
```

No runtime dependencies — only `node:` built-ins.

## What it found on the machine it was built on

Not marketing numbers: these are one developer's logs in November 2026, and they are why the
tools exist. Reproduce them with `--json` on your own.

- **5,668 turns** where the client requested one model and a different one answered. The UI shows
  the answer, not the request, so the substitution is invisible unless you read the log.
- **72 context compactions in 7 days**, dropping a cumulative **399.6M tokens** — every one of them
  auto-triggered, none of them announced.
- **101 upstream errors**, of which the largest group was a **429 quota message in Chinese** that
  the client retried ten times. A turn that recovers looks identical to a clean one.
- **93.2% cache hit rate** — the number that makes the difference between a $150 week and a $1,500
  one, and the number nobody has when they ask "why is this expensive".
- **819 MB** of session logs in `~/.claude`, one file at 167 MB. Reading that is a streaming
  problem, not a `readFileSync` problem.

## Commands

```bash
node src/cf-analyze.mjs --since 7d          # sessions, models, tokens, compactions, errors
node src/cf-analyze.mjs --session <prefix>  # one session, turn by turn
node src/cf-analyze.mjs --projects          # per-project activity and size
node src/cf-cost.mjs --since 30d            # spend estimate per model
node src/cf-doctor.mjs                      # installation health
```

All of them take `--json`. Exit codes are for automation: `cf-analyze` exits 1 on a model
substitution or a 5xx; `cf-doctor` exits 1 only on a failure (warnings exit 0).

## The rule these tools are built around

**Unmeasured is not passing.** Every one of them distinguishes three states, not two:

| State | Meaning | How it prints |
|---|---|---|
| `ok` | a check ran and found nothing | `✅` |
| `warn` / `fail` | a check ran and found something, with the evidence | `⚠️` / `❌` |
| **unmeasured** | the check could not run — no logs, no config, no data | `❓` / `level: "unknown"` |

The third state exists because the alternative is a tool that says "all good" on a machine it
never managed to read. `--json` emits `"measured": false` so a script cannot mistake one for the
other, and the exit code stays 0 for unmeasured — a missing install is not a build failure.

## What it does not claim

- **Prices are estimates.** `costUSD` comes from the client's own pricing table. A relay bills its
  own way; this is not an invoice and must not be presented as one.
- **Model substitution is an observation, not an accusation.** The log shows the requested id and
  the answered id. Why they differ — a relay, a fallback, a router — is not in the file.
- **Folder names are decoded for reading, never for use as a path.** Claude Code encodes the working
  directory with dashes, which is lossy by construction.
- **Not affiliated with Anthropic.** Independent tooling that reads files Claude Code already wrote.

## Privacy

These tools read your transcripts, which contain your prompts, your code, and your credentials as
they appeared in a session. Nothing is uploaded, and no summarising call is made to any API. Still:
treat the transcript directory as the sensitive store it is — `cf-doctor` reports (masked) when a
credential is sitting in `settings.json` in plaintext.

## Pricing

**Free.** MIT, no account, no telemetry, nothing gated. The CLI and all four skills are in this
repository and will stay that way.

| Skill | Marketplace listing |
|---|---|
| `read-sessions` | free |
| `audit-install` | free |
| `triage-failure` | free |
| `audit-spend` | $5 optional — the platform's minimum card price, $3.50 after its 30% |

The $5 listing is the cheapest thing the checkout will process; there is no $1 tier. The same skill
is in this repository for nothing either way — the listing buys the fact that someone reviewed it
before you did. See [docs/pricing.md](docs/pricing.md) for the rule, and why it will not move.

If it saves you an afternoon, the useful contribution is a reproducible bug report: the transcript
format is undocumented and changes between Claude Code versions.