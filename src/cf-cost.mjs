#!/usr/bin/env node
/**
 * cf-cost — where the money went, per model and per prompt.
 *
 * Claude Code writes a `cost-state` record carrying its own estimate per model:
 * input, output, cache-read and cache-write tokens, and a costUSD figure from its
 * pricing table. That is the only spend number that exists locally, and it is an
 * *estimate* — a relay bills its own way. Reporting it as a bill would be a
 * confident wrong answer, so every line here says "estimate".
 *
 * The useful part is not the total. It is the split: which model earned the spend,
 * how much of the prompt bill was cache reads, and what one prompt cost.
 *
 * Read-only.
 *
 * Usage:
 *   node src/cf-cost.mjs [--since 7d] [--top 10] [--json]
 *
 * Exit: 0 always when a report was produced; 1 only when spend crossed --budget
 * (off by default, because "expensive" is a policy, not a fact).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  locateProjects, listSessions, readSession, windowToMs, parseArgs, fmtTokens, dedupeResumed,
} from './lib/transcript.mjs';

/**
 * Fold every `cost-state` record into spend per model.
 *
 * A session writes cost-state repeatedly, each one cumulative for that session,
 * so only the last per session counts. Summing them all multiplies the bill by
 * the number of turns — the classic way to produce a horrifying and wrong total.
 */
export function summarizeCost(perSession) {
  const models = new Map();
  let total = 0;
  let reported = 0;
  let unknownCostSessions = 0;

  for (const s of perSession) {
    const c = s.cost;
    if (!c || c.totalCostUSD == null) { unknownCostSessions++; continue; }
    reported++;
    total += c.totalCostUSD;
    for (const [name, u] of Object.entries(c.modelUsage || {})) {
      const rec = models.get(name) || { model: name, costUSD: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      rec.costUSD += u.costUSD || 0;
      rec.input += u.inputTokens || 0;
      rec.output += u.outputTokens || 0;
      rec.cacheRead += u.cacheReadInputTokens || 0;
      rec.cacheCreate += u.cacheCreationInputTokens || 0;
      rec.sessions++;
      models.set(name, rec);
    }
  }

  const rows = [...models.values()].sort((a, b) => b.costUSD - a.costUSD);
  // Share of spend that was cache reads: they are billed at a lower rate, so this
  // is what makes a "why is it cheap" or "why is it not" answer possible.
  const cacheReadShare = total > 0
    ? rows.reduce((s, r) => s + r.cacheRead, 0) / Math.max(1, rows.reduce((s, r) => s + r.input + r.cacheRead, 0))
    : null;

  return { total, reported, unknownCostSessions, models: rows, cacheReadShare };
}

/** Cost per user prompt — the number that answers "is this session expensive". */
export function costPerPrompt(totalCost, prompts) {
  if (!prompts || prompts <= 0) return null;
  return totalCost / prompts;
}

/**
 * The model that took the largest share, or null when nothing cost anything.
 *
 * Deliberately searches instead of taking `rows[0]`: the function is named for
 * what it returns, and a caller that passes an unsorted list should not silently
 * get the wrong model — that is the kind of bug that only shows up in a report
 * nobody diffs.
 */
export function topModel(rows) {
  if (!rows || rows.length === 0) return null;
  const best = rows.reduce((a, b) => ((b.costUSD || 0) > (a.costUSD || 0) ? b : a), rows[0]);
  return (best.costUSD || 0) > 0 ? best : null;
}

export function renderCostText(summary, extra = {}) {
  const L = [`Claude Code spend estimate — last ${extra.window ?? '7d'}`, ''];
  if (summary.reported === 0) {
    L.push('  No session in the window carried a cost record.');
    L.push('  The client writes one only for sessions it priced. Nothing was measured.');
    return L.join('\n');
  }
  L.push(`  sessions with a cost record   ${summary.reported}`);
  if (summary.unknownCostSessions) L.push(`  sessions without one           ${summary.unknownCostSessions} (excluded — not zero)`);
  L.push(`  total (estimate)              $${summary.total.toFixed(2)}`);
  const cpp = costPerPrompt(summary.total, extra.prompts);
  if (cpp !== null) L.push(`  per prompt (estimate)         $${cpp.toFixed(3)}   across ${extra.prompts} prompt(s)`);
  if (summary.cacheReadShare !== null) {
    L.push(`  cache-read share of tokens    ${(summary.cacheReadShare * 100).toFixed(1)}%`);
  }
  L.push('');
  L.push('  BY MODEL');
  const w = Math.max(...summary.models.map((m) => m.model.length), 8);
  L.push(`  ${'model'.padEnd(w)}  ${'est. $'.padStart(9)}  ${'share'.padStart(7)}  ${'in'.padStart(7)}  ${'out'.padStart(7)}  ${'cache-read'.padStart(11)}`);
  for (const m of summary.models) {
    const share = summary.total > 0 ? (m.costUSD / summary.total) * 100 : 0;
    L.push(`  ${m.model.padEnd(w)}  ${m.costUSD.toFixed(2).padStart(9)}  ${(share.toFixed(0) + '%').padStart(7)}  ${fmtTokens(m.input).padStart(7)}  ${fmtTokens(m.output).padStart(7)}  ${fmtTokens(m.cacheRead).padStart(11)}`);
  }

  const top = topModel(summary.models);
  if (top && summary.total > 0) {
    L.push('');
    L.push(`  ${top.model} accounts for ${((top.costUSD / summary.total) * 100).toFixed(0)}% of the estimate.`);
    L.push('  Cross-check with the session report: the cost record is keyed by the model id the');
    L.push('  client asked for, while the assistant records show which model actually answered.');
    L.push('  When those differ, spend is attributed to the request, not to the answer — run');
    L.push('  cf-analyze and compare before concluding what you were charged for.');
  }
  L.push('');
  L.push('  Every figure is the client\'s own pricing-table estimate, not a bill. A relay');
  L.push('  bills on its own schedule; compare against its invoice before drawing conclusions.');
  return L.join('\n');
}

export function toCostJson(summary, extra = {}) {
  return {
    level: summary.reported === 0 ? 'unknown' : 'ok',
    measured: summary.reported > 0,
    window: extra.window ?? '7d',
    sessionsWithCost: summary.reported,
    sessionsWithoutCost: summary.unknownCostSessions,
    totalEstimateUSD: summary.reported > 0 ? summary.total : null,
    costPerPromptUSD: costPerPrompt(summary.total, extra.prompts),
    cacheReadShare: summary.cacheReadShare,
    models: summary.models,
    disclaimer: 'Estimate from the client pricing table, not a bill.',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const dir = locateProjects();
  if (!dir) {
    const payload = { level: 'unknown', measured: false, reason: 'No Claude Code session directory found' };
    if (opts.json) console.log(JSON.stringify(payload));
    else console.error('ERROR: ' + payload.reason);
    process.exit(0);
  }

  const sinceMs = Date.now() - windowToMs(opts.since ?? '7d');
  const sessions = listSessions(dir).filter((s) => s.mtimeMs >= sinceMs);
  const perSession = [];
  let prompts = 0;

  for (const s of sessions) {
    const state = { cost: null, prompts: 0, sessionId: s.session, file: s.path, mtimeMs: s.mtimeMs };
    try {
      await readSession(s.path, async (r) => {
        if (r.timestamp && Date.parse(r.timestamp) < sinceMs) return;
        // The record's own id beats the filename: a resumed session's new file keeps
        // the original id inside its records.
        if (!state.recordId && r.sessionId) state.recordId = r.sessionId;
        if (r.type === 'cost-state') state.cost = { totalCostUSD: r.totalCostUSD ?? null, modelUsage: r.modelUsage ?? null };
        if (r.type === 'user') {
          const c = r.message?.content;
          if (typeof c === 'string') state.prompts++;
          else if (Array.isArray(c) && c.some((b) => b.type === 'text')) state.prompts++;
        }
      });
    } catch { continue; }
    if (state.recordId) state.sessionId = state.recordId;
    perSession.push(state);
  }

  // Same rule as cf-analyze and cf-atlas. Without it this tool summed the same
  // resumed session once per file and reported $3,566 while cf-analyze reported
  // $3,562 for the same window — two authoritative-looking numbers, neither flagged.
  const kept = dedupeResumed(perSession);
  for (const s of kept) prompts += s.prompts;

  const summary = summarizeCost(kept);
  const extra = { window: opts.since ?? '7d', prompts };

  if (opts.json) {
    console.log(JSON.stringify(toCostJson(summary, extra), null, 2));
    process.exit(0);
  }

  console.log(renderCostText(summary, extra));
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
