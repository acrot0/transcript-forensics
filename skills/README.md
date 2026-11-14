# Skills

Four skills in the open [Agent Skills](https://agentskills.io/specification) format. Each is a plain
directory with a `SKILL.md` — no build step, no runtime, nothing to install. Copy a directory into
`~/.claude/skills/`, or install the plugin and get all four.

| Skill | Answers |
|---|---|
| `read-sessions` | which model actually answered, where the tokens went, what compaction threw away |
| `audit-spend` | what this is costing, per model and per prompt — and whether that model was the one you asked for |
| `audit-install` | why a hook, skill or plugin is silently not working |
| `triage-failure` | client bug, relay fault, upstream quota, or a retry that hid itself |

## Package one skill as a zip

```bash
node scripts/pack-skill.mjs --all        # writes dist/<skill>/ with src/ inside
cd dist/read-sessions && zip -r ../../read-sessions.zip .   # SKILL.md at the archive root
```

Windows:

```powershell
Compress-Archive -Path dist/read-sessions/* -DestinationPath read-sessions.zip
```

The scripts are copied in on purpose: a marketplace takes a zip, and a skill that runs
`$TOOLKIT/src/cf-analyze.mjs` without shipping it fails **after** the user has downloaded it.

## Writing style used here, and why

Every skill names the wrong answer it exists to prevent. That is deliberate: an agent handed a
table of numbers will otherwise fill the gap with a plausible sentence, and "the gateway is healthy"
or "already fixed" are both wrong and both easy. If you add a skill, add the trap it blocks.

None of these tools writes anything. The skills say so in the first paragraph, so the claim
survives truncation, and every one of them forbids claiming a fix.
