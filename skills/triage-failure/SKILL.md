---
name: triage-failure
description: Diagnose a failed or oddly slow Claude Code turn by reading the session log instead of guessing — separate a client bug, a gateway/relay fault, an upstream quota, and a retry that hid itself. Use when the user says "it just failed", "报错了", "why was that so slow", "it keeps retrying", "429", "connection error", or pastes an error with no context.
license: MIT
compatibility: Requires Node.js >= 20. Reads Claude Code session logs. Read-only; it never retries or modifies anything.
allowed-tools: Bash Read
---

# Triage a failure from the log, not from the message

Claude Code records every upstream failure in the session file, including the ones it retried
and recovered from — which are exactly the ones that leave no trace in the UI. A turn that felt
slow and a turn that never happened look identical to the user and completely different here.

```bash
TOOLKIT="${CLAUDE_PLUGIN_ROOT}"
# standalone: TOOLKIT="${CLAUDE_SKILL_DIR}"
node "$TOOLKIT/src/cf-analyze.mjs" --since 1d --json
```

## The four fault classes, and how to tell them apart

| In the log | Class | What to say |
|---|---|---|
| `429` + a provider message about quota/credit/plan | **upstream account state** | quote the message; it names the account, not your code |
| `429` with no message, many attempts, then success | **rate limit, retried** | the turn succeeded; it cost latency, not correctness |
| `500`/`502`/`503` | **upstream fault** | the request did not complete; a retry is the only remedy |
| `ECONNRESET` / `Request timed out` | **transport** | almost always a proxy or a long body, not a bad prompt |
| a 400 whose body was already malformed at ingress | **client** | the request was wrong before it was sent |

The status code alone never tells you which of these you have. `429` covers both "your plan
expired" and "too many requests right now", and they have opposite fixes.

## The retry question

`retryAttempt` / `maxRetries` on each error record is the only evidence that a retry happened.
Default is 10 attempts. A session that reports 32 errors and finishes normally did not fail 32
times — it failed once per attempt and recovered. Say "retried N times, recovered", never "it
failed N times", and never "it worked fine".

## Report shape

1. **What happened** — one sentence, with the class from the table.
2. **The provider's own words**, quoted, plus the status and the attempt count.
3. **What to change** — account/quota, a different provider, a smaller request, or nothing if it
   recovered. Read-only: state the change, do not attempt it.
4. **What is not visible from here** — a relay's own billing and routing decisions are not in the
   log. Do not infer them.

## Hard rules

- Do not retry anything. This tooling is read-only, and a retry changes the evidence.
- Do not guess a cause the log does not show. If `apiErrorCount` is 0, say the failure was not
  recorded — not that it did not happen.
- A 429 the client retried and survived is still worth reporting: it is why the turn took 40
  seconds.