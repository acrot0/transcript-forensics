---
name: trigger-triage-failure
description: "Positive: a request died with an empty error box and retried."
tags: [trigger, positive]
runs: 1
max_turns: 14
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

one of my requests yesterday just died — the error box was basically empty and it retried a bunch of times before giving up. i want to know what actually broke, not just that it broke.