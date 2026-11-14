---
type: regex
target: last_message
pattern: hook
flags: i
---

The agent must have produced a real answer. Without this, a run that timed out or
errored also counts as 'did not call the skill' and the negative case passes for
the wrong reason — the same defect as reporting an unmeasured check as a pass.
