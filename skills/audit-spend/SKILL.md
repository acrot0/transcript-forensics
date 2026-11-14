---
name: audit-spend
description: Explain where Claude Code spend went — per model, per prompt, and how much of the prompt bill was cache reads — then cross-check it against which model actually answered. Use for "why is this so expensive", "这个月花了多少", "cost per prompt", "am I paying for a model I did not pick", or before disputing an invoice.
license: MIT
compatibility: Requires Node.js >= 20. Reads the cost-state records Claude Code writes into its session logs. Read-only.
allowed-tools: Bash Read
---

# Audit Claude Code spend

Claude Code writes a `cost-state` record per session carrying its own estimate: tokens per
model and a `costUSD` figure from its pricing table. That is the only local spend number,
and **it is an estimate, never a bill**.

```bash
TOOLKIT="${CLAUDE_PLUGIN_ROOT}"
# standalone: TOOLKIT="${CLAUDE_SKILL_DIR}"
node "$TOOLKIT/src/cf-cost.mjs" --since 7d
node "$TOOLKIT/src/cf-cost.mjs" --since 30d --json
```

## The cross-check that makes this worth running

The cost record is keyed by the model id the client **requested**. The transcript's assistant
records show which model **answered**. When those differ, spend is attributed to the request
while a different model did the work.

```bash
node "$TOOLKIT/src/cf-analyze.mjs" --since 7d      # shows substitutions
node "$TOOLKIT/src/cf-cost.mjs" --since 7d         # shows what was charged to
```

Say what you observed — "the cost record names model A, the answers came from model B" — and
stop there. Do **not** assert that the invoice is wrong; a relay bills on its own schedule and
that is not visible from here.

## Reading the numbers

| Figure | Meaning | Trap |
|---|---|---|
| `total (estimate)` | sum of each session's final cost-state | never call it a bill |
| `per prompt` | spend ÷ your prompts | many tool turns per prompt is not "expensive per prompt" |
| `cache-read share` | cached tokens ÷ (cached + fresh) | a high share is good — the prefix was reused |
| `sessions without one` | sessions that carried no cost record | they are **excluded**, not zero; the total understates |
| `level: "unknown"` | no cost record anywhere in the window | not "free", not "healthy" — unmeasured |

## Report shape

1. The total, labelled **estimate**, with the number of sessions it covers.
2. The top spender and its share, then whether `cf-analyze` shows that model answering.
3. The cache-read share, if the question was about cost efficiency.
4. What was not measured: sessions without a cost record, and the pricing table's own limits.

## Hard rules

- Never present the estimate as an amount owed.
- Never sum cost-state records yourself — they repeat per turn; only the last per session counts.
- A model in the cost table that never appears in the answers is a finding, not proof of fraud.