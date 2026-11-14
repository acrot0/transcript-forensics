---
name: ignore-configure-hook
description: "Negative near-miss: the user wants to add a hook, not find out why one broke."
tags: [trigger, negative]
runs: 1
max_turns: 6
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

how do i add a new PostToolUse hook to my claude code settings? i want a formatter to run after every file edit, and i've never written one before.