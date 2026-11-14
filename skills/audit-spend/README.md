# audit-spend

Where Claude Code spend went, per model and per prompt — and whether that model was the one
you asked for.

## What it reports

- the **estimate per model**, with the share each one took
- **cost per prompt**, so a session is comparable to another session
- the **cache-read share** of prompt tokens — the number that makes a week cheap or expensive
- the **cross-check**: the cost record is keyed by the *requested* model, while the transcript
  shows the model that *answered*. When those differ, spend is attributed to a model that did
  not do the work.

## Honesty, stated on every line that shows a number

The figure is the client's own pricing-table estimate, not a bill. A relay bills its own way.
The skill says so, and refuses to present it as an amount owed.

## Requirements

Node.js >= 20. Read-only. No network — the pricing table ships with the client.
