---
name: trigger-read-sessions
description: "Positive: a user suspects a different model answered than the one they picked."
tags: [trigger, positive]
runs: 1
max_turns: 14
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

my claude code bill jumped and i don't trust it — i'm pretty sure i picked opus in the model picker but the replies feel like something much dumber. can you go look at my last week of sessions on this machine and tell me which model actually answered?