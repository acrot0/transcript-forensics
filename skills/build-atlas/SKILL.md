---
name: build-atlas
description: Render one local, offline HTML page that fuses a Claude Code machine's session logs, model substitutions, compaction losses, upstream errors and install state into a single report. Use when someone asks "show me my usage", "给我一个报告", "export my stats", "what does my month look like", or wants a screenshot-friendly summary instead of terminal output.
license: MIT
compatibility: Requires Node.js >= 20. Reads the Claude Code config directory; writes one HTML file and nothing else.
allowed-tools: Bash Read
---

# Build a local atlas

Three CLI tools answer three questions. Most people want one page. This writes a single
self-contained HTML file — no CDN, no fonts, no JavaScript, no network — that joins session
history, model attribution, compaction losses, errors and install checks together.

```bash
TOOLKIT="${CLAUDE_PLUGIN_ROOT}"
# standalone: TOOLKIT="${CLAUDE_SKILL_DIR}"
node "$TOOLKIT/src/cf-atlas.mjs" --since 30d --out atlas.html
```

Open the file directly in a browser; nothing is served and nothing is uploaded.

## What belongs in the page, and what must not

| Section | Rule |
|---|---|
| headline KPIs | every figure must carry its own caveat when it has one |
| projects | the top model column names the model that **answered**, not the one requested |
| substitution | an alias you chose yourself (`sonnet` → a dated snapshot) is excluded, and the page says so |
| compaction | the per-event drop (`pre - post`), **never** the session-cumulative field |
| spend | if the client flagged the model as unpriced, the number is labelled a placeholder, not an estimate |
| install | a warning is not a failure; `unmeasured` is not a pass |

## The three numbers that are easy to get wrong

1. **Dropped tokens.** `cumulativeDroppedTokens` is cumulative per *session*. Summing it over
   boundaries turned 7.7M of real drops into 26.2M here. Use `pre - post`.
2. **Spend.** A resumed session replays its whole history into a new file with the same
   cumulative cost. 398 files held 330 session ids; summing files made ~$397 look like $3,566.
   De-duplicate by session id, keep the newest file.
3. **Coverage.** If no assistant record carries the requested model, substitution is
   *unmeasured* — which is not the same as zero substitutions. The page must say which.

## Report shape

Give the user: the file path, the window it covers, the session count, and the two or three
findings worth repeating out loud. Do not paste the tables back as text.

## Hard rules

- This skill writes exactly one thing: the HTML file the user names. It never modifies
  `~/.claude` — it is read-only against the config directory, not against the filesystem.
- Never claim the spend figure is what they were charged.
- Never present an unmeasured check as a pass.
- Do not add a remote font, script or image to the page. A local report that phones home is not a
  local report.
