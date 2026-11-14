#!/usr/bin/env node
/**
 * cf-atlas — one local HTML page that fuses what this machine actually did.
 *
 * The three CLI tools answer one question each. Nobody wants to run three commands and
 * read three tables to find out what their week looked like. This writes a single
 * self-contained HTML file — no CDN, no fonts, no JavaScript, no network — that joins:
 *
 *   1. session logs      what each project spent, on which model, over which window
 *   2. config inventory  skills, hooks, plugins, memory files, backup sprawl
 *   3. substitution      which model answered when another was requested
 *   4. compaction        what was thrown away, and how much
 *
 * It is deliberately static: a page you can open from disk in five years and still read.
 * The honest labels (unmeasured / estimate / partial) travel with every number, because a
 * dashboard is exactly where a guess turns into a fact nobody re-checks.
 *
 * Usage:
 *   node src/cf-atlas.mjs [--since 30d] [--out atlas.html] [--open]
 *
 * Read-only against ~/.claude. The only file written is the HTML you asked for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  locateProjects, listSessions, readSession, windowToMs, parseArgs,
  fmtTokens, fmtBytes,
} from './lib/transcript.mjs';
import { summarizeSession, rollup, familiarity, cacheRate, levelOf, dedupeResumed } from './cf-analyze.mjs';
import { runChecks, overallLevel } from './cf-doctor.mjs';

export function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Percentage width for a CSS bar, capped so a runaway value cannot overflow the cell. */
export function barWidth(value, max) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

/**
 * Where the field-level knowledge in this file came from, and when it was last checked.
 *
 * Every number this project prints rests on an UNDOCUMENTED file format. That format is
 * the whole risk: when it changes, the tool used to print confident zeroes. It now
 * degrades loudly (see familiarity()), but "loudly" is only useful if a reader can tell
 * how old the knowledge is. So the age travels with the output.
 */
export const FORMAT_PROVENANCE = {
  verifiedOn: '2026-11-14',
  observedWith: 'Claude Code 2.x session logs (JSONL) on this machine',
  fields: [
    'type', 'message.role', 'message.model', 'message.usage.{input_tokens,output_tokens,cache_read_input_tokens}',
    'requestedModel', 'isSidechain', 'timestamp', 'sessionId',
    'system/subtype=compact_boundary + compactMetadata.{trigger,preTokens,postTokens,cumulativeDroppedTokens}',
    'system/subtype=api_error + {error,retryAttempt,maxRetries}',
    'cost-state.{totalCostUSD,modelUsage,hasUnknownModelCost}',
  ],
  /** What the tool does when these stop appearing. */
  onDrift: 'Report level "unknown", measured false, and refuse to print totals rather than print zeroes.',
  /** How a reader re-verifies it themselves, without trusting this file. */
  recheck: 'node src/cf-analyze.mjs --json and read formatFamiliarity.records / .missing.',
};

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Reduce an upstream error to its cause.
 *
 * Providers put a request id, a trace id and sometimes a timestamp inside the
 * message. Two occurrences of one fault therefore string-compare as different, and
 * grouping on the raw text inflates a single repeated fault into a list of rows.
 * Strip the identifiers, keep the words.
 */
export function errorCause(e) {
  let text = String((e && (e.formatted || e.message)) || '').replace(/\s+/g, ' ').trim();
  // Repeated leading status first, so "429 429 X" collapses before the id rules run.
  text = text.replace(/^(\d{3})\s+(?=\1\b)/, '').replace(/^\d{3}\s+/, '');
  // Bracketed request ids, trace_…, request_id=…, and bare long hex ids.
  text = text.replace(/\[[0-9a-f]{12,}\]/gi, ' ')
             .replace(/\b(?:trace|request|req|span)[_-]?id\s*[:=]\s*[0-9a-z_-]{8,}/gi, ' ')
             .replace(/\btrace_[0-9a-z-]{8,}/gi, ' ')
             .replace(/\b[0-9a-f]{24,}\b/gi, ' ')
             .replace(/\s+/g, ' ')
             .trim();
  return text.slice(0, 160);
}

/**
 * Fold per-session summaries into the shape the page renders.
 *
 * Pure: the caller supplies the summaries and the clock, so a test can pin both.
 */
/**
 * One row per calendar day, for the timeline strip.
 *
 * Days with no activity are emitted as zeroes rather than skipped: a gap in a time
 * series is a fact, and a strip that closes the gap silently turns a two-week
 * pause into continuous work.
 */
export function dailyRows(summaries, windowDays) {
  const byDay = new Map();
  const dayKey = (iso) => String(iso || '').slice(0, 10);
  for (const s of summaries) {
    for (const at of [s.startsAt, s.endsAt]) {
      if (!at) continue;
      const k = dayKey(at);
      if (!k) continue;
      if (!byDay.has(k)) byDay.set(k, { day: k, turns: 0, promptTokens: 0, compactions: 0, dropped: 0, errors: 0, substitutions: 0 });
    }
    const k = dayKey(s.startsAt || s.endsAt);
    if (!k) continue;
    const row = byDay.get(k) || { day: k, turns: 0, promptTokens: 0, compactions: 0, dropped: 0, errors: 0, substitutions: 0 };
    row.turns += s.assistantTurns || 0;
    row.promptTokens += (s.tokens?.input || 0) + (s.tokens?.cacheRead || 0);
    row.compactions += s.compactions.length;
    row.dropped += s.compactions.reduce((n, c) => n + (c.dropped || 0), 0);
    row.errors += s.apiErrors.length;
    row.substitutions += s.drift.length;
    byDay.set(k, row);
  }
  const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  if (rows.length === 0) return [];
  // Fill interior gaps so the strip's x axis is real time, not row order.
  const out = [];
  const start = new Date(rows[0].day + 'T00:00:00Z');
  const end = new Date(rows[rows.length - 1].day + 'T00:00:00Z');
  const index = new Map(rows.map((r) => [r.day, r]));
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    const key = d.toISOString().slice(0, 10);
    out.push(index.get(key) || { day: key, turns: 0, promptTokens: 0, compactions: 0, dropped: 0, errors: 0, substitutions: 0 });
  }
  return windowDays > 0 ? out.slice(-windowDays) : out;
}

export function buildAtlas(summaries, opts = {}) {
  const projects = new Map();
  const models = new Map();
  const substitutions = new Map();
  const errors = new Map();
  const compactions = [];

  for (const s of summaries) {
    const key = s.project || 'unknown';
    const p = projects.get(key) || {
      name: key, cwd: s.cwd || '', sessions: 0, bytes: 0, prompts: 0, turns: 0,
      costUSD: 0, costKnown: false, costSessions: 0, costUnpriced: 0, models: new Map(), compactions: 0, dropped: 0, errors: 0,
    };
    p.sessions++;
    p.bytes += s.size || 0;
    p.prompts += s.prompts || 0;
    p.turns += s.assistantTurns || 0;
    if (s.cwd && !p.cwd) p.cwd = s.cwd;
    if (s.cost && s.cost.totalCostUSD !== null && s.cost.totalCostUSD !== undefined) {
      p.costUSD += s.cost.totalCostUSD;
      p.costKnown = true;
      p.costSessions++;
      if (s.cost.hasUnknownModelCost) p.costUnpriced++;
    }
    for (const [m, n] of s.models) {
      p.models.set(m, (p.models.get(m) || 0) + n);
      models.set(m, (models.get(m) || 0) + n);
    }
    p.compactions += s.compactions.length;
    p.errors += s.apiErrors.length;
    for (const c of s.compactions) {
      p.dropped += c.dropped || 0;
      compactions.push({ at: c.at, project: key, trigger: c.trigger, pre: c.preTokens, post: c.postTokens, dropped: c.dropped });
    }
    for (const d of s.drift) {
      const k = d.requested + ' -> ' + d.actual;
      const rec = substitutions.get(k) || { requested: d.requested, actual: d.actual, turns: 0, projects: new Set() };
      rec.turns++;
      rec.projects.add(key);
      substitutions.set(k, rec);
    }
    for (const e of s.apiErrors) {
      // Group by cause, not by raw message. A provider echoes a request id inside
      // the message, so one quota error repeated five times arrived as five
      // distinct strings and printed as five rows of 2 — the same fault counted
      // as if it were five different ones.
      const cause = errorCause(e);
      const k = String(e.status || 'n/a') + ' ' + cause;
      const rec = errors.get(k) || { key: k, status: e.status, message: cause, count: 0, retried: 0, sample: String(e.formatted || e.message || '').slice(0, 200) };
      rec.count++;
      if (e.retryAttempt !== null && e.retryAttempt !== undefined) rec.retried++;
      errors.set(k, rec);
    }
    projects.set(key, p);
  }

  const agg = rollup(summaries, opts.meta || {});
  const fam = familiarity(agg.fmt);

  const projectRows = [...projects.values()]
    .map((p) => ({ ...p, models: [...p.models.entries()].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.turns - a.turns);

  return {
    generatedAt: opts.generatedAt || new Date().toISOString(),
    window: opts.window || '30d',
    projects: projectRows,
    models: [...models.entries()].map(([model, turns]) => ({ model, turns })).sort((a, b) => b.turns - a.turns),
    daily: dailyRows(summaries, opts.days || 0),
    substitutions: [...substitutions.values()].map((r) => ({ ...r, projects: [...r.projects] })).sort((a, b) => b.turns - a.turns),
    errors: [...errors.values()].sort((a, b) => b.count - a.count),
    compactions: compactions.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    totals: {
      sessions: agg.sessions,
      bytes: agg.bytes,
      prompts: agg.prompts,
      turns: agg.assistantTurns,
      sidechain: agg.sidechainTurns,
      tokens: agg.tokens,
      cacheRate: cacheRate(agg.tokens),
      costUSD: agg.costKnown ? round2(agg.costUSD) : null,
      costSessions: agg.costSessions,
      costUnpriced: agg.costUnpriced,
      costIsPlaceholder: agg.costKnown && agg.costUnpriced === agg.costSessions,
      dropped: compactions.reduce((sum, c) => sum + (c.dropped || 0), 0),
    },
    familiarity: fam,
    provenance: FORMAT_PROVENANCE,
    level: levelOf(agg),
    checks: opts.checks || [],
    configRoot: opts.configRoot || null,
  };
}

/* ── tokens ─────────────────────────────────────────────────────────────────
   Style: data-terminal (dealt seed 1337947196, dark). Its move is kept intact:
   the accent is never more than a 1px line, and every selection is that line.
   Prices and counts are monospace with stacking digits; the text face is the
   system UI face, because a report that must open offline in five years cannot
   fetch a font.
   Colour budget: <3% of pixels. It appears on the live day, the substitution
   bars, and the two polarity marks. Everything else is ink and grey.        */
const CSS = `
:root{color-scheme:dark;
  --ground:#101013;--surface:#16161a;--raised:#1d1d22;--border:#26262b;--rule:#1c1c21;
  --text:#fff;--muted:#8f919a;--faint:#5f6169;
  --accent:#4a8ad6;--positive:#44a282;--negative:#e5566f;--warning:#d9a441;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --gap:24px;--pad:40px;--radius:6px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--text);font:13px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:1160px;margin:0 auto;padding:52px var(--pad) 96px}
.mast{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--border)}
.mark{font:600 13px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase}
.mark i{display:inline-block;width:7px;height:7px;background:var(--accent);margin-right:8px;vertical-align:1px}
.scope{font:400 12px/1 var(--mono);color:var(--muted)}
.stamp{margin-left:auto;font:400 11.5px/1 var(--mono);color:var(--faint);white-space:nowrap}
h1{font:600 26px/1.25 var(--sans);letter-spacing:-.01em;margin:30px 0 10px}
.finding{max-width:74ch;font-size:14px;color:var(--muted);margin:0}
.finding b{color:var(--text);font-weight:600}
.finding em{font-style:normal;color:var(--warning)}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:26px 0 0}
.kpi{padding:16px 18px;border-left:1px solid var(--border)}
.kpi:first-child{border-left:0;padding-left:0}
.kpi:last-child{padding-right:0}
.kpi u{display:block;font:500 11.5px/1.4 var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--faint);text-decoration:none;margin-bottom:7px}
.kpi b{display:block;font:500 26px/1.1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi b.lead{font-size:38px;letter-spacing:-.03em}
.kpi s{display:block;font:400 11.5px/1.5 var(--sans);text-decoration:none;color:var(--faint);margin-top:5px}
.kpi s.warn{color:var(--warning)}
.kpi s.bad{color:var(--negative)}
.strip{margin:32px 0 0;padding-bottom:2px}
.legend{display:flex;align-items:center;gap:18px;font:400 11px/1 var(--sans);color:var(--faint);flex-wrap:wrap}
.legend span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.legend i{display:inline-block;width:9px;height:9px;border-radius:1px;background:var(--raised)}
.legend i.k2{background:var(--accent)}
.legend i.k3{background:var(--negative);opacity:.35}
.legend .scale{color:var(--muted)}
.strip .head{display:flex;justify-content:space-between;align-items:baseline;gap:20px;margin-bottom:12px;flex-wrap:wrap}
.strip .head h2{margin:0}
.days{display:flex;gap:2px;align-items:stretch;height:88px;position:relative}
.days .d{flex:1 1 0;min-width:3px;display:flex;flex-direction:column;justify-content:flex-end;position:relative}
.days .d i{display:block;background:var(--raised);border-radius:1px;min-height:2px;width:100%}
.days .d.sub i{background:var(--accent)}
.days .d i.dropped{background:var(--negative);position:absolute;left:0;right:0;bottom:0;opacity:.22}
.days .d.live::after{content:"";position:absolute;left:-1px;right:-1px;bottom:0;height:2px;background:var(--accent)}
.axis{display:flex;justify-content:space-between;gap:16px;font:400 11px/1 var(--mono);color:var(--faint);border-top:1px solid var(--rule);padding-top:8px}
.axis span:nth-child(2){color:var(--muted);text-align:center;flex:1}
.axis span:nth-child(3){text-align:right}
h2{font:400 12px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:44px 0 0}
.sect-note{font-size:12.5px;color:var(--faint);margin:7px 0 0;max-width:82ch}
table{width:100%;border-collapse:collapse;margin:14px 0 0}
th{font:500 11px/1 var(--sans);letter-spacing:.09em;text-transform:uppercase;color:var(--faint);text-align:left;padding:0 12px 9px;border-bottom:1px solid var(--border)}
th.n,td.n{text-align:right}
td{padding:9px 12px;border-bottom:1px solid var(--rule);vertical-align:middle}
tr:last-child td{border-bottom:0}
td.n{font:400 12.5px/1.4 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.id{font:400 12.5px/1.45 var(--mono);word-break:break-word}
td.k{font:400 12.5px/1.45 var(--mono);white-space:nowrap}
.id small{display:block;font:400 11.5px/1.5 var(--mono);color:var(--faint);word-break:break-all}
.bar{height:3px;background:var(--raised);border-radius:2px;margin-top:6px;overflow:hidden;max-width:260px}
.bar i{display:block;height:100%;background:var(--accent);border-radius:2px}
.bar.grey i{background:var(--faint)}
.tag{display:inline-block;font:500 10.5px/1.9 var(--sans);letter-spacing:.05em;text-transform:uppercase;padding:0 7px;border-radius:3px;white-space:nowrap;border:1px solid var(--border);color:var(--muted)}
.tag.ok{color:var(--positive);border-color:#1f3a30}
.tag.warn{color:var(--warning);border-color:#3d3218}
.tag.bad,.tag.fail{color:var(--negative);border-color:#43222a}
.tag.un{color:var(--faint)}
.dash{color:var(--faint)}
.note{border-left:1px solid var(--faint);padding:2px 0 2px 14px;margin:18px 0;font-size:12.5px;color:var(--muted);max-width:90ch}
.note.warn{border-left-color:var(--warning)}
.note.bad{border-left-color:var(--negative)}
.note b{display:block;font:600 12px/1.6 var(--sans);letter-spacing:.06em;text-transform:uppercase;margin-bottom:3px;color:var(--text)}
.note.warn b{color:var(--warning)}
.note.bad b{color:var(--negative)}
.note code{font:400 11.5px/1 var(--mono);color:var(--text)}
.pair{display:grid;grid-template-columns:1.35fr 1fr;gap:var(--gap);align-items:start}
footer{margin-top:64px;padding-top:16px;border-top:1px solid var(--border);font-size:11.5px;line-height:1.7;color:var(--faint);max-width:88ch}
footer code{font:400 11px/1 var(--mono);color:var(--muted)}
@media (max-width:940px){.kpis{grid-template-columns:repeat(3,1fr)}.kpi:nth-child(4){border-left:0;padding-left:0}.pair{grid-template-columns:1fr}}
@media (max-width:640px){main{padding:32px 20px 64px}h1{font-size:21px}.kpis{grid-template-columns:repeat(2,1fr)}.kpi:nth-child(odd){border-left:0;padding-left:0}.kpi b{font-size:22px}.days{height:60px}}
@media print{body{background:#fff;color:#111}.note,table,.kpis{border-color:#ddd}}
`;

const tone = (level) => (level === 'fail' || level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : level === 'unknown' ? 'un' : 'ok');

/** A missing value is a grey dash; a real zero prints as zero (§7.5). */
export const num = (value, digits = 0) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '<span class="dash">—</span>';
  return value.toFixed(digits);
};

export const pctOf = (n) => (n === null || n === undefined ? '<span class="dash">—</span>' : n.toFixed(1) + '%');

/** Short day label: 2026-11-13 → 13 Nov. The axis needs 4-8 labels, never 30. */
export function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()];
}

/**
 * The one-line finding.
 *
 * A screen answers one question first (§2.2), and the finding sits where it is read
 * first. It is derived from the data, never written by hand: if the numbers change,
 * this sentence changes with them.
 */
export function findingOf(atlas) {
  const t = atlas.totals;
  const parts = [];
  const sub = atlas.substitutions[0];
  if (sub) {
    parts.push('<b>' + escapeHtml(String(sub.turns)) + '</b> turns were answered by <b>' + escapeHtml(sub.actual) + '</b>, not the model you asked for');
  }
  if (t.dropped > 0 && atlas.compactions.length > 0) {
    const biggest = atlas.compactions.reduce((a, b) => ((b.dropped || 0) > (a.dropped || 0) ? b : a), atlas.compactions[0]);
    parts.push('compaction discarded <b>' + fmtTokens(t.dropped) + '</b> tokens across <b>' + atlas.compactions.length + '</b> boundaries, the largest on ' + escapeHtml(String(biggest.at || '').slice(0, 10)));
  }
  if (t.costIsPlaceholder) parts.push('every spend figure rests on a <em>placeholder price</em>');
  else if (t.costUnpriced > 0) parts.push('<em>' + t.costUnpriced + ' of ' + t.costSessions + '</em> spend records use a placeholder price');
  if (parts.length === 0) return 'Nothing worth flagging in this window.';
  return parts.join('; ') + '.';
}

export function renderHtml(atlas) {
  const L = [];
  const t = atlas.totals;
  const fam = atlas.familiarity;

  L.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  L.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  L.push('<title>Claude Code forensics — ' + escapeHtml(atlas.window) + '</title>');
  L.push('<style>' + CSS + '</style></head><body><main>');

  // masthead
  L.push('<div class="mast"><div class="mark"><i></i>Claude Code forensics</div>');
  L.push('<div class="scope">' + escapeHtml(atlas.configRoot || 'no config directory') + ' · ' + escapeHtml(atlas.window) + '</div>');
  L.push('<div class="stamp">' + escapeHtml(atlas.generatedAt.slice(0, 19).replace('T', ' ')) + ' · ' + t.sessions + ' sessions</div></div>');

  // question, then finding
  L.push('<h1>What actually ran on this machine</h1>');
  L.push('<p class="finding">' + findingOf(atlas) + '</p>');

  if (fam.verdict === 'unrecognised') {
    L.push('<div class="note bad"><b>Not measured — unrecognised log format</b>' +
      'Assistant records exist but none carried ' + escapeHtml(fam.missing.join(' or ')) + '. ' +
      'Claude Code changed its log shape. Every number below would be empty because nothing could be read, ' +
      'not because nothing happened.</div>');
    L.push('<footer>Update the tool, then regenerate.</footer></main></body></html>');
    return L.join('\n');
  }
  if (t.sessions === 0) {
    L.push('<div class="note bad"><b>Not measured — no sessions</b>Nothing was read in this window. That is not a clean week.</div>');
    L.push('<footer>Nothing to report.</footer></main></body></html>');
    return L.join('\n');
  }
  if (fam.verdict === 'degraded') {
    L.push('<div class="note warn"><b>Partial format match — ' + Math.round(fam.ratio * 100) + '%</b>' +
      'Missing ' + escapeHtml(fam.missing.join(', ')) + '. Every count below is a lower bound.</div>');
  }
  if (t.costIsPlaceholder) {
    L.push('<div class="note warn"><b>Spend is a placeholder, not an estimate</b>' +
      'The client itself flags ' + t.costUnpriced + ' of ' + t.costSessions + ' cost records as an unknown model price ' +
      '(<code>hasUnknownModelCost</code>). No rate exists for those model ids, so the dollar figure is arithmetic on a ' +
      'placeholder. Compare it with your provider invoice — never treat it as an amount owed.</div>');
  }
  if (fam.substitution === 'unmeasured') {
    L.push('<div class="note warn"><b>Substitution not measurable</b>' +
      'No assistant record carries the model the client asked for, so this page cannot tell whether a model was ' +
      'substituted. That is not the same as none happening.</div>');
  }

  // KPI strip — no tiles, dividers only, the answer figure leads
  const lead = t.dropped > 0 ? fmtTokens(t.dropped) : t.turns.toLocaleString('en-US');
  L.push('<div class="kpis">');
  const kpi = (label, value, note, cls = '', valueCls = '') =>
    L.push('<div class="kpi"><u>' + escapeHtml(label) + '</u><b class="' + valueCls + '">' + value + '</b>' +
      (note ? '<s class="' + cls + '">' + note + '</s>' : '') + '</div>');
  kpi('Prompts', t.prompts.toLocaleString('en-US'), 'from you');
  kpi('Turns', t.turns.toLocaleString('en-US'), t.sidechain ? t.sidechain.toLocaleString('en-US') + ' in subagents' : 'no subagents');
  kpi('Prompt tokens', fmtTokens(t.tokens.input + t.tokens.cacheRead), pctOf(t.cacheRate) + ' from cache');
  kpi('Compacted away', lead, atlas.compactions.length + ' boundaries', '', 'lead');
  kpi('Est. spend', t.costUSD === null ? '<span class="dash">—</span>' : '$' + Math.round(t.costUSD).toLocaleString('en-US'),
    t.costIsPlaceholder ? 'placeholder pricing' : t.costUnpriced > 0 ? t.costUnpriced + '/' + t.costSessions + ' unpriced' : 'not a bill',
    t.costIsPlaceholder ? 'bad' : t.costUnpriced > 0 ? 'warn' : '');
  kpi('Substitutions', atlas.substitutions.reduce((n, s) => n + s.turns, 0).toLocaleString('en-US'),
    atlas.substitutions.length ? atlas.substitutions.length + ' model pairs' : 'none observed');
  L.push('</div>');

  // signature element: the day strip
  if (atlas.daily && atlas.daily.length > 1) {
    const maxTurns = Math.max(...atlas.daily.map((d) => d.turns), 1);
    const maxDrop = Math.max(...atlas.daily.map((d) => d.dropped || 0), 1);
    // Square-root scale, stated on the strip. One measured day carries 6,099 turns
    // against a median of 22; on a linear axis every other day collapses to 2px and
    // the month reads as a single spike. A disclosed transform beats a flattering one.
    const root = (v) => Math.sqrt(Math.max(0, v));
    const peak = atlas.daily.reduce((a, b) => (b.turns > a.turns ? b : a), atlas.daily[0]);
    const median = [...atlas.daily.map((d) => d.turns)].sort((a, b) => a - b)[Math.floor(atlas.daily.length / 2)];
    const quietDays = atlas.daily.filter((d) => d.turns === 0).length;
    L.push('<div class="strip"><div class="head"><h2>Every day in the window</h2>' +
      '<div class="legend"><span><i class="k1"></i>turns</span><span><i class="k2"></i>a day with a substitution</span>' +
      '<span><i class="k3"></i>tokens compacted away</span><span class="scale">square-root scale</span></div></div>');
    L.push('<div class="days">');
    atlas.daily.forEach((d, i) => {
      const live = i === atlas.daily.length - 1;
      const h = Math.max(d.turns > 0 ? 4 : 1, Math.round((root(d.turns) / root(maxTurns)) * 100));
      const dh = Math.max(0, Math.round((root(d.dropped || 0) / root(maxDrop)) * 100));
      L.push('<div class="d' + (d.substitutions > 0 ? ' sub' : '') + (live ? ' live' : '') + '" title="' +
        escapeHtml(d.day) + ' — ' + d.turns + ' turns, ' + fmtTokens(d.dropped || 0) + ' dropped' + (d.substitutions ? ', ' + d.substitutions + ' substitutions' : '') + '">' +
        (dh > 0 ? '<i class="dropped" style="height:' + dh + '%"></i>' : '') +
        '<i style="height:' + h + '%"></i></div>');
    });
    L.push('</div>');
    const first = atlas.daily[0].day;
    const last = atlas.daily[atlas.daily.length - 1].day;
    L.push('<div class="axis"><span>' + escapeHtml(dayLabel(first)) + '</span>' +
      '<span>peak ' + escapeHtml(dayLabel(peak.day)) + ' · ' + peak.turns.toLocaleString('en-US') + ' turns · median ' + median + ' · ' + quietDays + ' quiet ' + (quietDays === 1 ? 'day' : 'days') + '</span>' +
      '<span>' + escapeHtml(dayLabel(last)) + '</span></div>');
    L.push('</div>');
  }

  // projects
  L.push('<h2>Projects</h2>');
  L.push('<div class="sect-note">Ranked by assistant turns. The model column names who answered, not who was asked.</div>');
  if (atlas.projects.length === 0) {
    L.push('<div class="note">No project activity in this window.</div>');
  } else {
    const maxTurns = Math.max(...atlas.projects.map((p) => p.turns), 1);
    L.push('<table><thead><tr><th>Project</th><th>Answered by</th><th class="n">Sessions</th><th class="n">Turns</th><th class="n">Size</th><th class="n">Spend</th><th class="n">Compactions</th><th class="n">Errors</th></tr></thead><tbody>');
    for (const p of atlas.projects.slice(0, 12)) {
      const top = p.models[0];
      L.push('<tr><td><div class="id">' + escapeHtml(p.name) + (p.cwd ? '<small>' + escapeHtml(p.cwd) + '</small>' : '') + '</div>' +
        '<div class="bar grey"><i style="width:' + barWidth(p.turns, maxTurns) + '%"></i></div></td>' +
        '<td class="id">' + escapeHtml(top ? top[0] : '—') + '</td>' +
        '<td class="n">' + p.sessions + '</td>' +
        '<td class="n">' + p.turns.toLocaleString('en-US') + '</td>' +
        '<td class="n">' + fmtBytes(p.bytes) + '</td>' +
        '<td class="n">' + (p.costKnown ? '$' + Math.round(p.costUSD).toLocaleString('en-US') + (p.costUnpriced === p.costSessions ? ' <span class="tag warn">unpriced</span>' : '') : '<span class="dash">—</span>') + '</td>' +
        '<td class="n">' + p.compactions + '</td>' +
        '<td class="n">' + p.errors + '</td></tr>');
    }
    L.push('</tbody></table>');
  }

  // models + substitution, side by side: they are one question
  L.push('<div class="pair" style="margin-top:44px">');
  L.push('<div><h2 style="margin-top:0">Who answered</h2>');
  L.push('<div class="sect-note">Assistant turns per model id, as written in the log.</div>');
  if (atlas.models.length === 0) {
    L.push('<div class="note">No assistant turns.</div>');
  } else {
    const maxTurns = Math.max(...atlas.models.map((m) => m.turns), 1);
    const total = atlas.models.reduce((n, m) => n + m.turns, 0) || 1;
    L.push('<table><thead><tr><th>Model</th><th class="n">Turns</th><th class="n">Share</th></tr></thead><tbody>');
    for (const m of atlas.models.slice(0, 8)) {
      L.push('<tr><td><div class="id">' + escapeHtml(m.model) + '</div><div class="bar"><i style="width:' + barWidth(m.turns, maxTurns) + '%"></i></div></td>' +
        '<td class="n">' + m.turns.toLocaleString('en-US') + '</td><td class="n">' + ((m.turns / total) * 100).toFixed(0) + '%</td></tr>');
    }
    L.push('</tbody></table>');
  }
  L.push('</div>');

  L.push('<div><h2 style="margin-top:0">Asked for → answered by</h2>');
  L.push('<div class="sect-note">A family alias resolving to a dated snapshot is excluded. A row here means the id you asked for did not answer.</div>');
  if (atlas.substitutions.length === 0) {
    L.push('<div class="note' + (fam.substitution === 'unmeasured' ? ' warn' : '') + '">' +
      (fam.substitution === 'unmeasured' ? 'Not measurable: no record carries the requested model id.' : 'None observed in this window.') + '</div>');
  } else {
    const maxTurns = Math.max(...atlas.substitutions.map((s) => s.turns), 1);
    L.push('<table><thead><tr><th>Requested</th><th>Answered</th><th class="n">Turns</th></tr></thead><tbody>');
    for (const s of atlas.substitutions.slice(0, 8)) {
      L.push('<tr><td class="id">' + escapeHtml(s.requested) + '</td>' +
        '<td><div class="id">' + escapeHtml(s.actual) + '</div><div class="bar"><i style="width:' + barWidth(s.turns, maxTurns) + '%"></i></div></td>' +
        '<td class="n">' + s.turns.toLocaleString('en-US') + '</td></tr>');
    }
    L.push('</tbody></table>');
  }
  L.push('</div></div>');

  // compaction
  if (atlas.compactions.length > 0) {
    L.push('<h2>Context compaction</h2>');
    L.push('<div class="sect-note">Per-event loss is before − after. The log also carries a session-cumulative figure; summing that over boundaries would report this total as roughly twenty times larger.</div>');
    L.push('<table><thead><tr><th>When</th><th>Project</th><th>Trigger</th><th class="n">Before</th><th class="n">After</th><th class="n">Dropped</th></tr></thead><tbody>');
    for (const c of atlas.compactions.slice(0, 12)) {
      L.push('<tr><td class="id">' + escapeHtml(String(c.at || '').slice(0, 16).replace('T', ' ')) + '</td>' +
        '<td class="id">' + escapeHtml(c.project) + '</td><td>' + escapeHtml(c.trigger) + '</td>' +
        '<td class="n">' + fmtTokens(c.pre) + '</td><td class="n">' + fmtTokens(c.post) + '</td>' +
        '<td class="n">' + (c.dropped === null || c.dropped === undefined ? '<span class="dash">—</span>' : fmtTokens(c.dropped)) + '</td></tr>');
    }
    L.push('</tbody></table>');
    if (atlas.compactions.length > 12) L.push('<div class="sect-note">Showing the most recent 12 of ' + atlas.compactions.length + '.</div>');
  }

  // errors
  if (atlas.errors.length > 0) {
    L.push('<h2>Upstream errors</h2>');
    L.push('<div class="sect-note">The provider\'s own words. A turn that was retried and recovered looks identical to a clean one in the UI — this is why it was slow.</div>');
    L.push('<table><thead><tr><th class="n">Status</th><th>Message</th><th class="n">Count</th><th class="n">Retried</th></tr></thead><tbody>');
    for (const e of atlas.errors.slice(0, 10)) {
      L.push('<tr><td class="n">' + escapeHtml(String(e.status === null || e.status === undefined ? 'n/a' : e.status)) + '</td>' +
        '<td class="id">' + escapeHtml(e.message.slice(0, 150)) + '</td>' +
        '<td class="n">' + e.count + '</td><td class="n">' + e.retried + '</td></tr>');
    }
    L.push('</tbody></table>');
  }

  // install checks
  if (atlas.checks.length > 0) {
    L.push('<h2>Installation</h2>');
    L.push('<div class="sect-note">Every check here covers something that fails without an error message. Unmeasured is not a pass.</div>');
    L.push('<table><thead><tr><th>Check</th><th>State</th><th>Detail</th></tr></thead><tbody>');
    for (const c of atlas.checks) {
      L.push('<tr><td class="k">' + escapeHtml(c.id) + '</td>' +
        '<td style="width:64px"><span class="tag ' + tone(c.level) + '">' + escapeHtml(c.level) + '</span></td>' +
        '<td style="color:var(--muted);font-size:12px">' + escapeHtml(c.detail) + '</td></tr>');
    }
    L.push('</tbody></table>');
  }

  L.push('<footer><b style="color:var(--muted)">Where these numbers come from.</b> ' +
    'Claude Code writes one JSONL file per session under its config directory; this page only reads them. ' +
    'Resumed sessions replay their history into a new file, so files are de-duplicated by session id before anything is summed. ' +
    'Nothing was uploaded, no API was called, and the page carries no scripts, fonts or images from anywhere else. ' +
    'A count that could not be taken is labelled unmeasured, never zero.<br><br>' +
    '<b style="color:var(--muted)">Format knowledge.</b> Checked ' + escapeHtml(atlas.provenance.verifiedOn) + ' against ' +
    escapeHtml(atlas.provenance.observedWith) + '. The file format is undocumented, so this is a dated observation, not a contract: ' +
    'if Claude Code changes the shape, this page reports <em>unmeasured</em> and prints no totals. ' +
    'Re-check it yourself with <code>' + escapeHtml(atlas.provenance.recheck) + '</code>.<br><br>' +
    'Regenerate: <code>node src/cf-atlas.mjs --since ' + escapeHtml(atlas.window) + '</code>' +
    (atlas.level === 'unknown' ? ' · overall level: <span style="color:var(--negative)">unknown</span>' : '') +
    '</footer>');
  L.push('</main></body></html>');
  return L.join('\n');
}


async function scanSessions(windowSpec) {
  const projectsDir = locateProjects();
  if (!projectsDir) return { summaries: [], meta: { scanned: 0, bytes: 0 }, configRoot: null };
  const sinceMs = Date.now() - windowToMs(windowSpec);
  const sessions = listSessions(projectsDir).filter((s) => s.mtimeMs >= sinceMs);
  const summaries = [];
  let bytes = 0;
  let skipped = 0;
  for (const s of sessions) {
    const records = [];
    try {
      await readSession(s.path, async (r) => {
        if (r.timestamp && Date.parse(r.timestamp) < sinceMs) return;
        records.push(r);
      });
    } catch { skipped++; continue; }
    bytes += s.size;
    const sum = summarizeSession(records);
    if (!sum.sessionId) sum.sessionId = s.session;
    sum.size = s.size;
    sum.project = s.project;
    summaries.push(sum);
  }
  // Same rule as the CLI: a resumed session replays its history into a new file, and
  // counting both multiplies that session's spend. Two tools disagreeing about the
  // total is worse than either being wrong alone.
  return { summaries: dedupeResumed(summaries), meta: { scanned: sessions.length, bytes, skipped } };
}

export function writeAtlas(html, outPath) {
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html, 'utf8');
  return abs;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const window = opts.since || '30d';
  const out = opts.out || 'atlas.html';
  const { summaries, meta } = await scanSessions(window);
  const doctor = runChecks();
  const atlas = buildAtlas(summaries, {
    window,
    days: Number(opts.days) || 0,
    meta,
    checks: doctor.checks,
    configRoot: doctor.settings.root,
  });
  const html = renderHtml(atlas);
  const abs = writeAtlas(html, out);
  const bytes = Buffer.byteLength(html);
  console.log('atlas -> ' + abs + ' (' + (bytes / 1024).toFixed(1) + ' KB, ' + atlas.totals.sessions + ' sessions, ' + atlas.totals.turns + ' turns)');
  if (atlas.level === 'unknown') console.log('note: level is UNKNOWN — see the banner at the top of the page.');
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();