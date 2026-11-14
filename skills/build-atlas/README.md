# build-atlas

Turns a machine's Claude Code history into one offline HTML page.

## What it does

Reads the session logs and the config directory, then writes a single self-contained
`atlas.html` — inline CSS, no scripts, no remote assets. Sections: headline KPIs, projects by
activity, which model actually answered, model substitutions, context compactions, upstream
errors, install checks.

## Why a page instead of a table

The CLI answers one question per command. The value here is the join: a project's spend next to
its compaction count next to the model that answered it, in one view you can screenshot.

## The honesty rules it carries

- A figure that rests on an unknown-model price is labelled a **placeholder**, not an estimate.
- Substitution is reported **unmeasured** when no record carries the requested model.
- An unrecognised log format stops the page with a banner instead of printing zeroes.
- Compaction loss uses the per-event delta, never the session-cumulative field.

## Requirements

Node.js >= 20. Read-only against `~/.claude`; the only file written is the HTML you ask for.
