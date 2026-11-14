# Pricing policy

**The tools and skills are free, and stay free.** MIT, no account, no telemetry, no gated feature.
Nothing in this repository is behind a paywall, and nothing will be moved behind one.

## Why a paid listing exists at all

A marketplace listing is a **distribution channel**, not a product tier. The same files are in this
repository, under MIT, for anyone who looks. A paid listing on a marketplace buys the person one
thing the repository cannot: *someone else already checked it*, and it installs without cloning.

That is worth a small amount of money to some people and zero to others. Both are correct.

## The numbers, and why they are not round

The platform takes a flat 30% and pays out 70%. Its **minimum card price is $5**, so the smallest
possible paid listing is:

| Buyer pays | Platform (30%) | Creator receives |
|---|---|---|
| $5.00 | $1.50 | **$3.50** |

There is no $1 tier. A listing priced below $5 is not a thing the checkout will process, so
"symbolic" means $5, and that is the only number this project will ever use.

Free listings need no payout method at all — no Stripe connection, no tax form, nothing.

## What is listed

| Skill | Price | Why |
|---|---|---|
| `read-sessions` | free | the headline capability; gating it would defeat the point |
| `audit-install` | free | it fixes silent breakage; nobody should pay to find out their hooks are dead |
| `triage-failure` | free | same — it is diagnostic, and diagnostics belong in everyone's hands |
| `build-atlas` | free | it is the artifact people forward to a colleague; charging for a report you can regenerate would be absurd |
| `audit-spend` | $5 (optional) | it is the one skill that touches money, and the $5 is a filter against casual installs, not a toll |

If the paid listing is ever removed, the free listing of the same skill goes up in its place. The
repository copy never changes.

## What is never charged for

- Bug fixes, and re-downloads after one.
- The CLI. `npx transcript-forensics` is free forever; it is the same code.
- Support in the issue tracker.
- Anything a security review would need to see. A skill you cannot inspect before installing is not
  a skill, it is a request for trust.

## If you paid and it does not work

Open an issue. Refund first, diagnose second — a $3.50 payout is not worth arguing over, and the
bug report is worth more than the sale.
