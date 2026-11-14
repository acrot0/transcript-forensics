# Agensi submission copy

Five listings. Four free, one $5 (Agensi's card minimum; creators receive $3.50).

Written from the same facts the tool prints, so the marketplace text cannot drift from
what the code does. Read `docs/pricing.md` before changing a price.

---
## read-sessions

**Name:** Read Claude Code sessions

**Tagline:** See which model actually answered, where the tokens went, and what compaction silently threw away.

**When to use:** Use when someone doubts which model answered, asks why a session cost so much, or says the agent forgot earlier context.

**Description:**

Claude Code writes a complete record of every session to disk and then shows almost none of it. This skill reads it.

It reports: the model the client asked for next to the model that answered (a substitution is a fact in the log, not a guess); the full token and cache accounting; every context compaction with the tokens it discarded; every upstream error with its retry counter.

Three things it refuses to do, because each is a way to look right while being wrong:
- It never reports a guess as a measurement. If the log shape is unfamiliar, it says unmeasured and stops.
- It never calls the cost figure a bill. The client's own pricing table marks unknown models, and that is surfaced.
- It never says "it forgot" without the compaction record as evidence.

Read-only. Node 20+. No dependencies, no network, no telemetry.

---

## audit-install

**Name:** Audit a Claude Code install

**Tagline:** Find the Claude Code failures that produce no error message: dead hooks, rejected skills, missing plugins, oversized memory files.

**When to use:** Use when a hook, skill, plugin or CLAUDE.md has stopped working and nothing reports an error.

**Description:**

Some Claude Code failures are silent. A hook points at a file that no longer exists. A skill's frontmatter no longer parses, so it is quietly skipped. A plugin is installed but nothing loads it. A CLAUDE.md grew to 20k tokens and is now paid on every single turn.

None of these produce an error. All of them are checkable.

This skill runs eight checks over the config directory - settings, hooks, skills, memory files, plugins, backups, transcripts, and credential-shaped values in settings keys that name one - and reports each as ok, warn, or unmeasured.

Unmeasured is a distinct state, not a pass. A check that could not read anything says so, because "I could not look" and "I looked and it is fine" are different answers.

Read-only. Node 20+.

---

## triage-failure

**Name:** Triage a failed Claude Code turn

**Tagline:** Diagnose a failed or slow turn from the session log: upstream quota, relay fault, transport, or a retry that hid itself.

**When to use:** Use when a request failed with a vague or empty error, or felt slow for no visible reason.

**Description:**

When a Claude Code request fails, the UI often says very little. The log says what actually happened: the provider's own error text, the HTTP status, and how many times the client retried before giving up.

That last part is the useful one. A turn that was retried three times and then succeeded looks identical to a clean turn in the UI - it just takes longer. Without the log you cannot tell a slow model from a flaky upstream.

This skill names the mechanism (quota, auth, relay, transport, timeout) and quotes the evidence, rather than guessing from the symptom.

It also separates two things that look alike: an error that was recovered (latency cost) and a failure that ended the turn (work lost).

Read-only. Node 20+.

---

## audit-spend

**Name:** Audit Claude Code spend

**Tagline:** Where the spend went, per model and per prompt - cross-checked against which model actually answered.

**When to use:** Use when someone asks what a month of Claude Code cost, or why one project is expensive.

**Description:**

A spend total on its own is not actionable. The useful questions are which model ate the budget, and how much of each turn was cache rather than fresh input.

This skill reports spend per model and per project, cost per prompt, and the cache hit rate - and it cross-checks the model column against the model that actually answered, because a request for one model answered by another is billed as the other.

Two honest limits, stated in the output rather than buried:
- The figure is the client's own estimate from its pricing table. It is not a bill. If the client flags a model as unknown-priced, the total is labelled a placeholder, not an estimate.
- Resumed sessions replay their history into a new file with the same cumulative cost. Files are de-duplicated by session id before anything is summed; on the machine this was built on, that was the difference between ~$397 and $3,562.

Read-only. Node 20+.

---

## build-atlas

**Name:** Build a local Claude Code atlas

**Tagline:** One offline HTML page of your Claude Code history - no server, no scripts, no network.

**When to use:** Use when someone wants a report they can keep, screenshot or share, instead of terminal output.

**Description:**

The three CLI reports answer three questions. Most people want one page.

This writes a single self-contained HTML file - inline CSS, no JavaScript, no remote fonts or images - that joins session history, model attribution, substitutions, compaction losses, upstream errors and install checks into one view, with a day-by-day strip showing when the pattern changed.

It is built to be honest rather than flattering:
- A figure resting on an unknown-model price is labelled a placeholder.
- Substitution is reported unmeasured when no record carries the requested model.
- An unrecognised log format stops the page with a banner instead of printing zeroes.
- The footer states the date the undocumented format was last verified, and the command to re-verify it.

Open the file from disk in five years and it still renders. That is the point of no scripts, no fonts and no network.
