---
name: trigger-audit-spend
description: "Positive: a user asks where the money went, per model."
tags: [trigger, positive]
runs: 1
max_turns: 14
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

how much did i burn on claude code this month? i'd like it broken down by which model ate most of it, and roughly what one prompt is costing me.