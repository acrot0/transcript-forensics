---
name: trigger-build-atlas
description: "Positive: the user wants one offline HTML page rather than terminal output."
tags: [trigger, positive]
runs: 1
max_turns: 14
model: deepseek-v4.1-flash
timeout_seconds: 240
allowed_tools: [Skill]
---

instead of dumping terminal output at me, can you generate a single self-contained html page of my claude code usage that i can open without a server and screenshot for a blog post?