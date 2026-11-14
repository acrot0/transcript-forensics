# triage-failure

A failed Claude Code turn has four possible causes and one status code. This skill separates
them using the evidence the client already recorded.

## The distinction it makes

- **upstream account state** — a 429 that says the plan expired
- **rate limit, retried** — the same 429, with `retryAttempt` proving it recovered
- **upstream fault** — a 5xx, request did not complete
- **transport** — `ECONNRESET`, usually a proxy or an oversized body
- **client** — a 400 whose body was already malformed before sending

The status code alone cannot tell these apart, and two of them have opposite fixes.

## The part users never see

A retried-and-recovered turn looks identical to a clean one. It is not: it is why the turn took
40 seconds. This skill reports it as *retried N times, recovered* — never as a failure, never as
nothing.

## Requirements

Node.js >= 20. Read-only. It does not retry anything; a retry would change the evidence.
