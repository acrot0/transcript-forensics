# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`cf-atlas` / `atlas`** — one self-contained HTML page (inline CSS, no scripts, no remote
  assets) joining projects, model attribution, substitutions, compactions, errors and install
  checks. `--out` chooses the file; nothing is served.
- `build-atlas` skill, and the packaging entry that ships the analyzer and doctor it imports.

### Fixed

Three aggregation defects, all found by generating the real page and checking the numbers
against the raw logs. None raised an error; each produced a confident, plausible, wrong total.

- **Compaction loss was multiplied.** `cumulativeDroppedTokens` is cumulative per *session*, not
  the amount one boundary removed. Summing it over 119 boundaries reported 437M dropped where the
  per-event deltas total 19.4M. Now uses `pre - post`, keeping the cumulative value aside.
- **Resumed sessions were counted twice.** A resumed session replays its history into a new file
  with the same cumulative cost. This machine had 398 files for 330 session ids, one session in 17
  files; summing files turned ~$397 of spend into $3,562. Now de-duplicated by session id, newest
  file kept — in both the CLI and the atlas, so the two cannot disagree.
- **Spend was presented as an estimate when it was a placeholder.** The client sets
  `hasUnknownModelCost` when its pricing table has no entry for the model. On this machine 24 of
  34 cost records carried it. The total is now labelled a placeholder in the text report, in
  `--json` (`costIsPlaceholder`), and as a banner on the page, instead of being called an
  estimate.

### Added

- `docs/pricing.md` — the pricing rule, stated once: free, MIT, nothing gated. One optional $5
  marketplace listing (`audit-spend`), which is the platform's minimum card price; three of the four
  listings are free.
- `marketplace/agensi/listings.json` — the listing plan (skill, zip, price, tags, one-line pitch).
  A plan, not a submission: nothing has been uploaded.
- A `README.md` per skill, shipped inside each zip. A marketplace shows it before install, and a zip
  without it makes the buyer guess.

## [0.1.0] — 2026-11-14

First release.

### Added

- `cf-analyze` — reads `~/.claude/projects/**/*.jsonl` and reports model substitution (requested
  vs answered), token and cache accounting, silent context compaction, tool failures, and upstream
  errors with their retry counters. `--session` for one session, `--projects` for per-project sizes.
- `cf-cost` — spend estimate per model and per prompt from the `cost-state` records, with an explicit
  cross-check against which model actually answered.
- `cf-doctor` — installation health: credential-shaped values in `settings.json`, `apiKeyHelper`
  targets that do not exist, hook scripts that were deleted, skills the loader will reject, oversized
  always-injected `CLAUDE.md`, registered-but-missing plugins, backup sprawl, transcript footprint.
- Four skills for any agent that reads `SKILL.md`: `read-sessions`, `audit-spend`,
  `audit-install`, `triage-failure`.

### Design notes worth knowing

- **Streaming reader.** One measured session is 167 MB and the directory is 819 MB. Lines over 4 MB
  are counted and skipped rather than parsed.
- **Three states, not two.** A check that cannot run reports `unmeasured` / `"measured": false`,
  never `ok`.
- **Substitution vs alias.** `sonnet` → a dated snapshot is legitimate and excluded; a different
  model answering a specific id is not. Conflating them produces a warning on every healthy session.
- **Dedupe on read.** A resumed session rewrites earlier records into a new file, so compactions and
  errors have to be de-duplicated or the counts double.