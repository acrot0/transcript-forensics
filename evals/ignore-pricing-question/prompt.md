---
name: ignore-pricing-question
description: "Negative near-miss: asks the product's list price, not this machine's spend."
tags: [trigger, negative]
runs: 1
max_turns: 6
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

what does the claude code pro plan cost per month these days, and is the max plan worth it for someone who codes maybe three hours a day?