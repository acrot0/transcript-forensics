# Trigger evals

`claude plugin eval` runs each case with the plugin loaded and scores it against the
graders in `graders/`. These cases answer one question the unit tests cannot: **does the
right skill get chosen when a real person phrases the request their own way?**

```bash
claude plugin eval . --runs 1 --trust-plugin
```

Five cases should fire a specific skill. Two are near-misses that share the vocabulary but
need something else — those are the ones that catch a description that is merely broad.

| Case | Expects | Why it exists |
|---|---|---|
| `trigger-read-sessions` | fires `read-sessions` | user doubts which model answered |
| `trigger-audit-spend` | fires `audit-spend` | asks where the money went |
| `trigger-triage-failure` | fires `triage-failure` | a request died with an empty error box |
| `trigger-audit-install` | fires `audit-install` | a hook silently stopped running |
| `trigger-build-atlas` | fires `build-atlas` | wants one offline page |
| `ignore-configure-hook` | does **not** fire `audit-install` | wants to *add* a hook, not diagnose one |
| `ignore-pricing-question` | does **not** fire `audit-spend` | asks the list price, not this machine's spend |

## The false pass this suite nearly shipped with

A negative case asserts "the skill was not called". A run that times out or errors also did
not call the skill — so it scored 1.00. The first run of this suite recorded exactly that:
`ignore-configure-hook  score 1.00  error: timed out after 240s`.

That is the same defect the tool itself reports on: an unmeasured thing presented as a pass.
Both negative cases now carry a second grader (`answered.md`) requiring the agent to have
actually produced an answer, so a dead run fails instead of passing.

## What these evals do not prove

- **Not a security review.** A passing suite does not vet the plugin's code.
- **Not the report's correctness.** Trigger evals score *whether the skill was loaded*, not
  whether the numbers it printed were right. That is what `test/` covers (169 unit tests).
- **Model-dependent.** The cases pin `model:` because an unreachable model makes every run
  time out, which used to score as a pass. Repin it if that model is unavailable.
- **One run per case.** Model behaviour is nondeterministic; `--runs 3` is the honest default
  and costs about three times as much. The recorded run used 1 to keep the total near $2.
