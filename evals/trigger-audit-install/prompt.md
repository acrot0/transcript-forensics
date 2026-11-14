---
name: trigger-audit-install
description: "Positive: a hook silently stopped running, with no error."
tags: [trigger, positive]
runs: 1
max_turns: 14
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

my PostToolUse hook stopped doing anything at some point and nothing errors, it just doesn't run anymore. i haven't touched the settings file in weeks. can you work out what's wrong with my setup?