#!/usr/bin/env node
/**
 * cf-analyze — what actually happened in your Claude Code sessions.
 *
 * Reads the JSONL files under ~/.claude/projects (one per session) and answers the
 * questions the UI never
 * does: which model answered when you asked for another, where the tokens went,
 * how often the context was silently compacted, which tool calls fail, and what
 * the upstream said when a request died.
 *
 * Read-only. Nothing here writes to `~/.claude`.
 *
 * Usage:
 *   node src/cf-analyze.mjs [--since 7d] [--limit 20] [--json]
 *   node src/cf-analyze.mjs --session <id-prefix>   # one session, turn by turn
 *   node src/cf-analyze.mjs --projects              # per-project breakdown
 *
 * Exit: 0 = nothing worth flagging, 1 = substitution or a 5xx upstream error.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  locateProjects, listSessions, readSession, windowToMs, parseArgs,
  fmtTokens, fmtBytes, classifyModel, stripTag, listProjects,
} from './lib/transcript.mjs';

/** Aggregate one session's records into facts. Pure-ish: no I/O, so the tests can feed it. */
export function summarizeSession(records) {
  const s = {
    sessionId: null,
    cwd: null,
    version: null,
    entrypoint: null,
    startsAt: null,
    endsAt: null,
    turns: 0,
    assistantTurns: 0,
    sidechainTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    models: new Map(),          // answered model → turns
    requested: new Map(),       // requested model → { turns, answered: Map }
    drift: [],                  // { requested, actual, at }
    toolCalls: new Map(),       // name → count
    toolErrors: new Map(),      // name → count (approximate: errors carry no name)
    toolErrorCount: 0,
    apiErrors: [],              // { message, status, retryAttempt, maxRetries, at }
    compactions: [],            // { trigger, preTokens, postTokens, dropped, durationMs, at }
    cost: null,
    aliases: 0,
    prompts: 0,
    userTextChars: 0,
  };

  for (const r of records) {
    if (!s.sessionId && r.sessionId) s.sessionId = r.sessionId;
    if (!s.cwd && r.cwd) s.cwd = r.cwd;
    if (!s.version && r.version) s.version = r.version;
    if (!s.entrypoint && r.entrypoint) s.entrypoint = r.entrypoint;
    const at = r.timestamp;
    if (at) {
      if (!s.startsAt || at < s.startsAt) s.startsAt = at;
      if (!s.endsAt || at > s.endsAt) s.endsAt = at;
    }

    if (r.type === 'system') {
      if (r.subtype === 'api_error') {
        const e = r.error || {};
        s.apiErrors.push({
          message: String(e.message ?? '').slice(0, 400),
          status: e.status ?? null,
          formatted: e.formatted ?? null,
          retryAttempt: r.retryAttempt ?? null,
          maxRetries: r.maxRetries ?? null,
          at,
        });
      }
      if (r.subtype === 'compact_boundary') {
        const m = r.compactMetadata || {};
        s.compactions.push({
          trigger: m.trigger ?? 'unknown',
          preTokens: m.preTokens ?? null,
          postTokens: m.postTokens ?? null,
          dropped: m.cumulativeDroppedTokens ?? (m.preTokens && m.postTokens ? m.preTokens - m.postTokens : null),
          durationMs: m.durationMs ?? null,
          at,
        });
      }
    }

    if (r.type === 'cost-state') s.cost = { totalCostUSD: r.totalCostUSD ?? null, modelUsage: r.modelUsage ?? null };

    if (r.type === 'user') {
      const c = r.message?.content;
      if (typeof c === 'string') { s.prompts++; s.userTextChars += c.length; }
      else if (Array.isArray(c)) {
        let hadText = false;
        for (const b of c) {
          if (b.type === 'text') { s.userTextChars += (b.text || '').length; hadText = true; }
          if (b.type === 'tool_result' && b.is_error) { s.toolErrorCount++; }
        }
        if (hadText) s.prompts++;
      }
    }

    if (r.type === 'assistant') {
      s.assistantTurns++;
      if (r.isSidechain) s.sidechainTurns++;
      const m = r.message || {};
      const model = stripTag(m.model) || 'unknown';
      s.models.set(model, (s.models.get(model) || 0) + 1);

      const req = r.requestedModel;
      if (req) {
        const key = stripTag(req);
        const rec = s.requested.get(key) || { turns: 0, answered: new Map() };
        rec.turns++;
        rec.answered.set(model, (rec.answered.get(model) || 0) + 1);
        s.requested.set(key, rec);
        const verdict = classifyModel(req, m.model);
        if (verdict === 'substituted') s.drift.push({ requested: key, actual: model, at });
        else if (verdict === 'alias') s.aliases++;
      }

      const u = m.usage || {};
      s.tokens.input += u.input_tokens || 0;
      s.tokens.output += u.output_tokens || 0;
      s.tokens.cacheRead += u.cache_read_input_tokens || 0;
      s.tokens.cacheCreate += u.cache_creation_input_tokens || 0;

      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') {
            s.toolCalls.set(b.name, (s.toolCalls.get(b.name) || 0) + 1);
            s.turns++;
          }
        }
      }
    }
  }
  return s;
}

/** Roll many session summaries into one report. */
export function rollup(summaries, sessions) {
  const agg = {
    sessions: summaries.length,
    scanned: sessions?.scanned ?? summaries.length,
    skipped: sessions?.skipped ?? 0,
    bytes: sessions?.bytes ?? 0,
    prompts: 0,
    assistantTurns: 0,
    sidechainTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    costUSD: 0,
    costKnown: false,
    models: new Map(),
    aliases: 0,
    drift: [],
    driftSessions: new Set(),
    toolCalls: new Map(),
    toolErrors: 0,
    apiErrors: [],
    compactions: [],
    startedAt: null,
    endedAt: null,
  };
  for (const s of summaries) {
    agg.prompts += s.prompts;
    agg.assistantTurns += s.assistantTurns;
    agg.sidechainTurns += s.sidechainTurns;
    agg.tokens.input += s.tokens.input;
    agg.tokens.output += s.tokens.output;
    agg.tokens.cacheRead += s.tokens.cacheRead;
    agg.tokens.cacheCreate += s.tokens.cacheCreate;
    if (s.cost?.totalCostUSD != null) { agg.costUSD += s.cost.totalCostUSD; agg.costKnown = true; }
    for (const [k, v] of s.models) agg.models.set(k, (agg.models.get(k) || 0) + v);
    agg.aliases += s.aliases || 0;
    if (s.drift.length > 0 && s.sessionId) agg.driftSessions.add(s.sessionId);
    agg.drift.push(...s.drift);
    for (const [k, v] of s.toolCalls) agg.toolCalls.set(k, (agg.toolCalls.get(k) || 0) + v);
    agg.toolErrors += s.toolErrorCount;
    agg.apiErrors.push(...s.apiErrors);
    agg.compactions.push(...s.compactions);
    if (s.startsAt && (!agg.startedAt || s.startsAt < agg.startedAt)) agg.startedAt = s.startsAt;
    if (s.endsAt && (!agg.endedAt || s.endsAt > agg.endedAt)) agg.endedAt = s.endsAt;
  }
  agg.compactions = dedupeCompactions(agg.compactions);
  agg.apiErrors = dedupeApiErrors(agg.apiErrors);
  return agg;
}

/**
 * Drop duplicate boundary/error records.
 *
 * A resumed or forked session rewrites earlier records into a new file, so the
 * same 429 or the same compaction appears twice. Counting both makes one event
 * look like two — and these counts are reported as facts ("context was thrown
 * away N times", "N errors"), so a doubled number is a wrong claim.
 */
export function dedupeBy(items, keyOf) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function dedupeCompactions(all) {
  return dedupeBy(all, (c) => `${c.at || ''}|${c.preTokens ?? ''}|${c.postTokens ?? ''}`)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function dedupeApiErrors(all) {
  return dedupeBy(all, (e) => `${e.at || ''}|${e.status ?? ''}|${(e.message || '').slice(0, 80)}`);
}

/**
 * The worst thing found, as a level.
 *
 * Substitution is a `warn`, not a `fail`: nothing is broken, but something about
 * what you got differs from what you asked for, and you are the only one who can
 * call that a problem. `--strict` promotes it for a CI gate where "no substitution"
 * is the actual policy. A 5xx is a `fail` because the request did not complete.
 */
export function levelOf(agg, { strict = false } = {}) {
  if (agg.sessions === 0) return 'unknown';
  if (agg.apiErrors.some((e) => (e.status ?? 0) >= 500)) return 'fail';
  if (agg.drift.length > 0) return strict ? 'fail' : 'warn';
  if (agg.apiErrors.length > 0 || agg.compactions.length > 0) return 'warn';
  return 'ok';
}

/** Cache hit rate the way it has to be computed: hits / (hits + misses). */
export function cacheRate(tokens) {
  const total = tokens.cacheRead + tokens.input;
  return total > 0 ? (tokens.cacheRead / total) * 100 : null;
}

async function scan(opts) {
  const projectsDir = locateProjects();
  if (!projectsDir) return { projectsDir: null, summaries: [], sessions: { scanned: 0, bytes: 0 } };
  const sinceMs = Date.now() - windowToMs(opts.since ?? '7d');
  let sessions = listSessions(projectsDir, { limit: opts.limit ? Number(opts.limit) : 0 });
  if (opts.session) sessions = sessions.filter((s) => s.session.startsWith(String(opts.session)));
  else sessions = sessions.filter((s) => s.mtimeMs >= sinceMs);

  const summaries = [];
  let bytes = 0;
  let skipped = 0;
  for (const s of sessions) {
    // A session whose mtime is in the window may still hold months of history;
    // the per-record timestamp filter below is what makes --since honest.
    const records = [];
    try {
      await readSession(s.path, async (r) => {
        if (r.timestamp && Date.parse(r.timestamp) < sinceMs && !opts.session) return;
        records.push(r);
      });
    } catch (e) {
      skipped++;
      continue;
    }
    bytes += s.size;
    const sum = summarizeSession(records);
    if (!sum.sessionId) sum.sessionId = s.session;
    sum.size = s.size;
    sum.mtimeMs = s.mtimeMs;
    sum.file = s.path;
    sum.project = s.project;
    sum.unreadable = false;
    summaries.push(sum);
  }
  return { projectsDir, summaries, sessions: { scanned: sessions.length, bytes, skipped } };
}

const pct = (n) => (n === null ? '—' : `${n.toFixed(1)}%`);

export function renderText(agg, opts = {}) {
  const lines = [];
  const window = opts.session ? `session ${opts.session}` : `last ${opts.since ?? '7d'}`;
  lines.push(`Claude Code session report — ${window}`);
  lines.push('');

  if (agg.sessions === 0) {
    lines.push('  No sessions found in the window.');
    lines.push('  Nothing was measured — this is not "all healthy".');
    return lines.join('\n');
  }

  lines.push(`  sessions      ${agg.sessions} (${fmtBytes(agg.bytes)} read)`);
  lines.push(`  prompts       ${agg.prompts} from you, ${agg.assistantTurns} assistant turns`);
  if (agg.sidechainTurns) lines.push(`  subagents     ${agg.sidechainTurns} turns ran in a sidechain`);
  lines.push(`  tokens        in ${fmtTokens(agg.tokens.input)}  out ${fmtTokens(agg.tokens.output)}  cache-read ${fmtTokens(agg.tokens.cacheRead)}`);
  const tpp = agg.prompts > 0 ? Math.round((agg.tokens.input + agg.tokens.cacheRead) / agg.prompts) : null;
  if (tpp !== null) lines.push(`  per prompt    ${fmtTokens(tpp)} prompt tokens on average`);
  lines.push(`  cache hit     ${pct(cacheRate(agg.tokens))} of prompt tokens came from cache`);
  if (agg.costKnown) lines.push(`  reported cost $${agg.costUSD.toFixed(2)} (the client\'s own estimate, not a bill)`);

  const models = [...agg.models.entries()].sort((a, b) => b[1] - a[1]);
  if (models.length > 0) {
    lines.push('', '  MODELS THAT ACTUALLY ANSWERED');
    const w = Math.max(...models.map(([m]) => m.length));
    for (const [m, n] of models) lines.push(`    ${m.padEnd(w)}  ${String(n).padStart(6)} turns`);
  }

  if (agg.drift.length > 0) {
    const byPair = new Map();
    for (const d of agg.drift) {
      const k = `${d.requested} -> ${d.actual}`;
      byPair.set(k, (byPair.get(k) || 0) + 1);
    }
    lines.push('', `  MODEL SUBSTITUTION  (${agg.driftSessions.size} session(s), ${agg.drift.length} turns)`);
    for (const [k, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`    ${k}   ${n} turn(s)`);
    }
    lines.push('    You asked for one model; a different one answered. That is a substitution, not a');
    lines.push('    synonym: pricing, cache identity and capability all follow the answer, not the ask.');
    if (agg.aliases) lines.push(`    (${agg.aliases} legitimate alias expansion(s) excluded — a family name resolving to a snapshot.)`);
  }

  if (agg.apiErrors.length > 0) {
    const byStatus = new Map();
    for (const e of agg.apiErrors) {
      const k = `${e.status ?? 'n/a'} ${(e.formatted || e.message || '').slice(0, 90)}`;
      byStatus.set(k, (byStatus.get(k) || 0) + 1);
    }
    lines.push('', `  UPSTREAM ERRORS  ${agg.apiErrors.length} event(s)`);
    for (const [k, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`    ${String(n).padStart(4)}x  ${k}`);
    }
    const retried = agg.apiErrors.filter((e) => e.retryAttempt != null);
    if (retried.length) {
      const maxR = Math.max(...retried.map((e) => e.maxRetries ?? 0));
      lines.push(`    retried in-session (max retries configured: ${maxR}); a recovered turn looks identical to a clean one in the UI`);
    }
  }

  if (agg.compactions.length > 0) {
    const dropped = agg.compactions.reduce((s, c) => s + (c.dropped || 0), 0);
    lines.push('', `  CONTEXT COMPACTION  ${agg.compactions.length} time(s), ${fmtTokens(dropped)} tokens dropped total`);
    for (const c of agg.compactions.slice(0, 6)) {
      lines.push(`    ${(c.at || '').slice(0, 16)}  ${c.trigger}  ${fmtTokens(c.preTokens)} -> ${fmtTokens(c.postTokens)}`);
    }
    lines.push('    Everything above the boundary is gone from the model\'s view. A prompt that was');
    lines.push('    read earlier is not available later unless it is still on disk.');
  }

  if (agg.toolCalls.size > 0) {
    const tools = [...agg.toolCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    lines.push('', `  TOOL USE  ${[...agg.toolCalls.values()].reduce((a, b) => a + b, 0)} calls, ${agg.toolErrors} returned an error`);
    const w = Math.max(...tools.map(([t]) => t.length));
    for (const [t, n] of tools) lines.push(`    ${t.padEnd(w)}  ${String(n).padStart(6)}`);
  }

  lines.push('');
  lines.push('  Read-only: no session file was modified.');
  return lines.join('\n');
}

export function toJson(agg, levelOverride) {
  const models = Object.fromEntries([...agg.models.entries()].sort((a, b) => b[1] - a[1]));
  const byRequested = {};
  for (const d of agg.drift) {
    byRequested[d.requested] = byRequested[d.requested] || { actual: {}, turns: 0 };
    byRequested[d.requested].actual[d.actual] = (byRequested[d.requested].actual[d.actual] || 0) + 1;
    byRequested[d.requested].turns++;
  }
  return {
    level: levelOverride ?? levelOf(agg),
    measured: true,
    window: agg.window,
    sessions: agg.sessions,
    bytes: agg.bytes,
    prompts: agg.prompts,
    assistantTurns: agg.assistantTurns,
    sidechainTurns: agg.sidechainTurns,
    tokens: agg.tokens,
    cacheHitRate: cacheRate(agg.tokens),
    costUSD: agg.costKnown ? agg.costUSD : null,
    models,
    substitutions: byRequested,
    substitutionTurns: agg.drift.length,
    aliasExpansions: agg.aliases,
    substitutionSessions: agg.driftSessions.size,
    apiErrors: agg.apiErrors.slice(0, 50),
    apiErrorCount: agg.apiErrors.length,
    compactions: agg.compactions.slice(0, 50),
    compactionCount: agg.compactions.length,
    droppedTokens: agg.compactions.reduce((s, c) => s + (c.dropped || 0), 0),
    toolCalls: Object.fromEntries([...agg.toolCalls.entries()].sort((a, b) => b[1] - a[1])),
    toolErrors: agg.toolErrors,
    startedAt: agg.startedAt,
    endedAt: agg.endedAt,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.projects) {
    const dir = locateProjects();
    if (!dir) {
      console.error('ERROR: no Claude Code session directory found.');
      process.exit(0);
    }
    const sinceMs = Date.now() - windowToMs(opts.since ?? '30d');
    const rows = listProjects(dir, listSessions(dir).filter((s) => s.mtimeMs >= sinceMs));
    if (opts.json) console.log(JSON.stringify({ projects: rows }, null, 2));
    else console.log(renderProjectsText(rows, opts));
    process.exit(0);
  }

  const { projectsDir, summaries, sessions } = await scan(opts);

  if (!projectsDir) {
    const payload = {
      level: 'unknown',
      measured: false,
      reason: 'No Claude Code session directory found (~/.claude/projects or $CLAUDE_CONFIG_DIR/projects)',
    };
    if (opts.json) console.log(JSON.stringify(payload));
    else {
      console.error(`ERROR: ${payload.reason}`);
      console.error('Nothing to analyse. This is "not measured", not "no problems".');
    }
    process.exit(0);
  }

  const agg = rollup(summaries, sessions);
  agg.window = opts.since ?? '7d';

  const strict = opts.strict === true;
  const level = levelOf(agg, { strict });

  if (opts.json) {
    console.log(JSON.stringify(toJson(agg, level), null, 2));
    process.exit(level === 'fail' ? 1 : 0);
  }

  console.log(renderText(agg, opts));
  if (agg.drift.length > 0 && !strict) {
    console.log('');
    console.log('  Substitution is reported as a warning, not a failure: use --strict to gate on it.');
  }
  // Only `fail` is an exit 1. Warnings — retried errors, compactions, substitutions —
  // are real, but they are not "the build is red".
  process.exit(level === 'fail' ? 1 : 0);
}

/** `--projects`: which working directories actually get sessions, and how big they are. */
export function renderProjectsText(projects, opts = {}) {
  const L = [`Claude Code projects — last ${opts.since ?? '30d'}`, ''];
  if (projects.length === 0) {
    L.push('  No sessions in the window.');
    return L.join('\n');
  }
  const w = Math.min(64, Math.max(...projects.map((p) => p.project.length), 7));
  L.push(`  ${'project'.padEnd(w)}  ${'sessions'.padStart(8)}  ${'size'.padStart(8)}  last active`);
  for (const p of projects) {
    L.push(`  ${p.project.padEnd(w)}  ${String(p.sessions).padStart(8)}  ${fmtBytes(p.bytes).padStart(8)}  ${new Date(p.lastMs).toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  L.push('');
  L.push('  Folder names encode the working directory with dashes, which is not reversible:');
  L.push('  read the label, do not paste it into a path.');
  return L.join('\n');
}

if (process.argv[1] && pathToFileURLSafe(process.argv[1]) === import.meta.url) main();

function pathToFileURLSafe(p) {
  return pathToFileURL(path.resolve(p)).href;
}
