# Release: how to rebuild and verify one

Two forms ship from this repository: a plugin (installed by path) and five standalone skill
zips (uploaded to a marketplace, or handed to someone who will not clone). They must agree.

## The chain

```bash
npm ci                              # installs vitest only; the runtime has no dependencies
npx vitest run --pool=forks         # the whole suite must be green
node scripts/pack-skill.mjs --all   # writes dist/<skill>/ with src/ copied inside
```

Then zip the **contents** of each `dist/<skill>/`, so `SKILL.md` sits at the archive root.
Zipping the directory instead of its contents puts everything one level down, and the
marketplace then rejects a zip whose root has no `SKILL.md`.

```powershell
# Windows. Absolute paths, and note the trailing `$false`:
# CreateFromDirectory resolves RELATIVE paths against the process CWD, not the script's
# directory, so a relative call silently produced five identical 22-byte empty zips.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dir = "<repo>\dist\read-sessions"
$zip = "<out>\read-sessions.zip"
[System.IO.Compression.ZipFile]::CreateFromDirectory($dir, $zip,
  [System.IO.Compression.CompressionLevel]::Optimal, $false)   # $false = no parent folder
```

## What to check before uploading

1. `SKILL.md` is an entry at the archive root, not `read-sessions/SKILL.md`.
2. Every script the skill names is inside the archive. A skill that says
   `$TOOLKIT/src/cf-analyze.mjs` without shipping it fails *after* someone downloaded it. The
   dependency list is `SKILL_DEPS` in `scripts/pack-skill.mjs`, and `test/packaging.test.mjs`
   asserts the two cannot drift.
3. Each packed skill runs from its own copy:
   `node <extracted>/src/cf-analyze.mjs --json` must print JSON.
4. **The packed copy behaves like the source.** Not "it starts" — the same numbers. Run
   `packed cf-cost --since 30d --json` and `cf-analyze --since 30d --json` and compare the
   totals. This is how a fix that only landed in one of them would have been caught.
5. The prose inside the zip matches the code. The `v0.1.0` zips shipped a README quoting
   `399.6M` dropped tokens — the figure produced by the cumulative-counter bug fixed in the
   same release (the same window summed per event is `19.2M`; summed cumulatively today it is
   `437M`). Numbers in shipped copy are a release artifact, not decoration; re-read them.

## Verify a published release

```bash
gh release view v0.1.1 --json assets --jq '.assets[] | "\(.name) \(.size) \(.digest)"'
```

GitHub returns a SHA-256 digest per asset. Compare it with `Get-FileHash <zip> -Algorithm SHA256`
(or `sha256sum`) on the file you built. If they differ, the upload did not deliver what you
tested.

## Reproducibility limit, stated plainly

The zips embed file mtimes, so the same source packed twice does not produce the same bytes.
The digest proves *what was uploaded*, not that anyone can rebuild it byte-for-byte. What is
reproducible is the content: every entry can be diffed against the repository at the tag —
`v0.1.1` zips were checked that way, entry by entry, and matched `HEAD` exactly.
