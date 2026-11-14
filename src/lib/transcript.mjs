/**
 * transcript — read Claude Code's own session logs, read-only.
 *
 * Every Claude Code session appends to `~/.claude/projects/<project>/<session>.jsonl`.
 * That file is a complete forensic record: every turn, the model the client asked
 * for and the model that answered, the token/cache accounting, tool results
 * including the failures, API errors with their retry counters, and a boundary
 * record for every context compaction.
 *
 * Almost none of it is ever shown to the user. Nothing here writes.
 *
 * WHY A STREAMING READER
 * Measured on one machine: 398 files, 859 MB, and a single session at 175 MB.
 * `readFileSync` plus `split` on that is an out-of-memory waiting to happen, so
 * lines are counted as they arrive and an oversized line is rejected without
 * being parsed — a 40 MB "api-request-blob" would otherwise be a 40 MB object
 * graph for no gain, since only its `type` is needed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/** A single JSONL line larger than this is counted but not materialised. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Where Claude Code keeps its projects, in the order the CLI itself checks.
 * `CLAUDE_CONFIG_DIR` wins when set — that is the documented way to relocate
 * the whole config tree, and a user who set it does not have `~/.claude`.
 */
export function configRoots(env = process.env, home = os.homedir()) {
  // CLAUDE_CONFIG_DIR is authoritative, not a preference. It is how the CLI is told
  // to relocate the whole config tree, so falling back to ~/.claude when it has no
  // projects directory would read a tree the user is not using — and in CI it would
  // silently analyse the runner's home instead of the empty fixture.
  if (env.CLAUDE_CONFIG_DIR) return [env.CLAUDE_CONFIG_DIR];
  const roots = [path.join(home, '.claude')];
  if (process.platform === 'win32' && env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude'));
  return roots;
}

export function locateProjects(env = process.env, home = os.homedir()) {
  for (const root of configRoots(env, home)) {
    const p = path.join(root, 'projects');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Every session file, newest first.
 *
 * The mtime sort matters: a user asking "why did that just fail" wants this
 * morning's session, and walking 859 MB in directory order would read it last.
 */
export function listSessions(projectsDir, { limit = 0 } = {}) {
  const out = [];
  if (!projectsDir || !fs.existsSync(projectsDir)) return out;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable project dir is not a reason to fail the whole scan
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(p);
          out.push({ path: p, project: path.basename(dir), session: e.name.replace(/\.jsonl$/, ''), size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* deleted between readdir and stat */ }
      }
    }
  };
  walk(projectsDir);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Every project directory under `projects/`, with its session count and size.
 *
 * Claude Code encodes the working directory into the folder name (`E--trae-ide-data`),
 * which is the only place the mapping exists — so it is decoded here rather than
 * guessed by a caller.
 */
export function listProjects(projectsDir, sessions = []) {
  const byProject = new Map();
  for (const s of sessions) {
    const rec = byProject.get(s.project) || { project: s.project, cwd: decodeProjectName(s.project), sessions: 0, bytes: 0, lastMs: 0 };
    rec.sessions++;
    rec.bytes += s.size;
    rec.lastMs = Math.max(rec.lastMs, s.mtimeMs);
    byProject.set(s.project, rec);
  }
  return [...byProject.values()].sort((a, b) => b.lastMs - a.lastMs);
}

/**
 * `E--trae-ide-data-Claude-code` → `E:\trae ide data\Claude code`.
 *
 * Lossy by construction: Claude Code replaces both the path separator and the
 * dashes that were already in a directory name with `-`, so an exact recovery
 * is impossible. The decoded form is a label for a human reading a table — it is
 * never used as a path, which is why a wrong answer here is harmless.
 */
export function decodeProjectName(name) {
  if (typeof name !== 'string' || !name) return name;
  const m = /^([A-Za-z])--(.*)$/.exec(name);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/-/g, '\\')}`;
  return name.replace(/-/g, '/');
}

/** Parse one JSONL line, or null when it is too large / not JSON. */
export function parseLine(line, byteLength = Buffer.byteLength(line)) {
  if (byteLength > MAX_LINE_BYTES) return null;
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Stream one session file, calling `onRecord` for every parsed line.
 *
 * Returns counters the summarisers need and a plain reader would have to
 * recompute: total lines, unparseable lines, and skipped-oversize lines.
 */
export async function readSession(file, onRecord) {
  const stats = { lines: 0, parsed: 0, bad: 0, oversize: 0, bytes: 0 };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      stats.lines++;
      const n = Buffer.byteLength(line);
      stats.bytes += n;
      const rec = parseLine(line, n);
      if (rec === null) {
        if (n > MAX_LINE_BYTES) stats.oversize++;
        else if (line.trim()) stats.bad++;
        continue;
      }
      stats.parsed++;
      await onRecord(rec);
    }
  } finally {
    rl.close();
    stream.close();
  }
  return stats;
}

/** `provider/model[1m]` → `provider/model`. The tag is a context-window hint, not the model. */
export function stripTag(model) {
  return typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : model;
}

const MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'default', 'inherit', 'best']);

/**
 * Classify a requested/actual model pair.
 *
 *   'same'        the id matched (modulo a `[1m]` window tag)
 *   'alias'       the client asked for a family name (`sonnet`) and a concrete
 *                 snapshot answered — legitimate, and warning on it would drown
 *                 out everything else
 *   'equivalent'  `provider/x` answered as `x` — the same model, prefixed
 *   'substituted' a different model answered
 *
 * The distinction is the whole point: a relay that quietly answers with a
 * cheaper model on every turn produces the same shape of record as a healthy
 * alias expansion, and only one of them costs you capability.
 */
export function classifyModel(requested, actual) {
  if (!requested || !actual) return 'same';
  if (actual === '<synthetic>') return 'same'; // generated locally, no upstream call
  const req = stripTag(requested).toLowerCase();
  const got = stripTag(actual).toLowerCase();
  if (req === got) return 'same';
  const bareReq = req.split('/').pop();
  const bareGot = got.split('/').pop();
  if (MODEL_ALIASES.has(bareReq)) return 'alias';
  if (bareReq === bareGot) return 'equivalent';
  // A dated snapshot of the requested model: `opus-4-5` -> `opus-4-5-20260101`
  if (bareGot.startsWith(bareReq) || bareReq.startsWith(bareGot)) return 'equivalent';
  return 'substituted';
}

/** True only for the pair that actually changes what you get. */
export function isModelDrift(requested, actual) {
  return classifyModel(requested, actual) === 'substituted';
}

/** Human token count: 1_798_400 → "1.8M". Keeps tables readable. */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/** `7d`, `24h`, `90m` → milliseconds. Unknown input falls back to 7 days. */
export function windowToMs(spec, fallbackMs = 7 * 86400000) {
  const m = /^(\d+)([dhms])$/.exec(String(spec ?? '').trim());
  if (!m) return fallbackMs;
  const unit = { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
  return Number(m[1]) * unit;
}

/** `--json`, `--since 7d`, `--limit 5` and friends, shared by every tool. */
export function parseArgs(argv, spec = {}) {
  const out = { json: false, ...Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, v])) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}