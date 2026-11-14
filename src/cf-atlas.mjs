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

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Fold per-session summaries into the shape the page renders.
 *
 * Pure: the caller supplies the summaries and the clock, so a test can pin both.
 */
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
      const k = String(e.status || 'n/a') + ' ' + String(e.formatted || e.message || '').replace(/\s+/g, ' ').slice(0, 120);
      const rec = errors.get(k) || { key: k, status: e.status, message: String(e.formatted || e.message || '').slice(0, 200), count: 0, retried: 0 };
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
    level: levelOf(agg),
    checks: opts.checks || [],
    configRoot: opts.configRoot || null,
  };
}

const CSS = [
  ':root{color-scheme:dark;--bg:#0d1117;--panel:#151b23;--line:#232c38;--ink:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}',
  'main{max-width:1080px;margin:0 auto;padding:32px 24px 64px}',
  'h1{font-size:22px;margin:0 0 4px}',
  'h2{font-size:15px;margin:34px 0 10px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}',
  '.sub{color:var(--dim);font-size:12.5px}',
  '.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0 8px}',
  '.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}',
  '.kpi b{display:block;font-size:22px;font-weight:650;letter-spacing:-.01em}',
  '.kpi span{color:var(--dim);font-size:12px}',
  'table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}',
  'th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}',
  'th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:600}',
  'tr:last-child td{border-bottom:none}',
  'td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.track{background:#0b0f14;border-radius:3px;height:6px;margin-top:5px;overflow:hidden}',
  '.fill{display:block;height:100%;background:var(--acc);border-radius:3px}',
  '.fill.warn{background:var(--warn)}.fill.bad{background:var(--bad)}.fill.ok{background:var(--ok)}',
  '.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);margin-right:6px}',
  '.tag.warn{color:var(--warn);border-color:#4a3a12}.tag.bad{color:var(--bad);border-color:#552222}.tag.ok{color:var(--ok);border-color:#1c3d26}',
  '.note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 14px;margin:14px 0;color:var(--dim);font-size:13px}',
  '.note.bad{border-left-color:var(--bad)}.note.warn{border-left-color:var(--warn)}',
  '.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}',
  'footer{margin-top:44px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:14px}',
  '@media print{body{background:#fff;color:#111}.kpi,table,.note{background:#fff;border-color:#ddd}}',
].join('');

const tone = (level) => (level === 'fail' || level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : 'ok');

/** Render the whole page. Static HTML: no script tags, nothing to execute. */
export function renderHtml(atlas) {
  const L = [];
  const t = atlas.totals;
  L.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  L.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  L.push('<title>Local workbench atlas</title><style>' + CSS + '</style></head><body><main>');

  L.push('<h1>Local workbench atlas</h1>');
  L.push('<p class="sub">Generated ' + escapeHtml(atlas.generatedAt.slice(0, 19).replace('T', ' ')) + ' from ' +
    escapeHtml(String(t.sessions)) + ' session file(s) over the last ' + escapeHtml(atlas.window) +
    (atlas.configRoot ? ' &middot; config ' + escapeHtml(atlas.configRoot) : '') + '</p>');

  // --- honesty banner, above every number ---
  const fam = atlas.familiarity;
  if (fam.verdict === 'unrecognised') {
    L.push('<div class="note bad"><b>UNRECOGNISED TRANSCRIPT FORMAT.</b> ' +
      'The session files exist but carried none of the fields this build reads (' + escapeHtml(fam.missing.join(', ')) + '). ' +
      'Every number below would be empty because nothing could be read, not because nothing happened. Update the tool.</div>');
  } else if (fam.verdict === 'degraded') {
    L.push('<div class="note warn"><b>PARTIAL FORMAT MATCH.</b> ' +
      Math.round(fam.ratio * 100) + '% of assistant records matched this build; missing ' + escapeHtml(fam.missing.join(', ')) +
      '. Every count below is a lower bound.</div>');
  }
  if (t.sessions === 0) {
    L.push('<div class="note bad"><b>Nothing measured.</b> No session files in this window. This page reports nothing, which is not the same as a clean week.</div>');
  }
  if (t.costUSD !== null && t.costUnpriced > 0) {
    const all = t.costIsPlaceholder;
    L.push('<div class="note ' + (all ? 'bad' : 'warn') + '"><b>' + (all ? 'SPEND IS A PLACEHOLDER.' : 'PART OF THE SPEND IS UNPRICED.') + '</b> ' +
      t.costUnpriced + ' of ' + t.costSessions + ' sessions carry a cost computed from a model id the client has no price for ' +
      '(it sets <span class="mono">hasUnknownModelCost</span> on those records itself). ' +
      (all
        ? 'The dollar figure below is arithmetic on that placeholder: it is not an estimate of what you were charged, and it must not be compared to an invoice.'
        : 'Treat the total as a lower bound with an unknown error, not as an amount.') + '</div>');
  }
  if (fam.substitution === 'unmeasured' && t.sessions > 0) {
    L.push('<div class="note warn"><b>Substitution unmeasured.</b> No assistant record carries the model the client asked for, ' +
      'so this page cannot tell whether a model was substituted. That is not the same as none happening.</div>');
  }

  // --- headline ---
  L.push('<div class="hero">');
  const kpi = (value, label) => L.push('<div class="kpi"><b>' + escapeHtml(value) + '</b><span>' + escapeHtml(label) + '</span></div>');
  kpi(String(t.prompts), 'prompts from you');
  kpi(String(t.turns), 'assistant turns');
  kpi(fmtTokens(t.tokens.input + t.tokens.cacheRead), 'prompt tokens');
  kpi(t.cacheRate === null ? '—' : t.cacheRate.toFixed(1) + '%', 'served from cache');
  kpi(
    t.costUSD === null ? '—' : '$' + t.costUSD.toFixed(0),
    t.costUSD === null ? 'spend (not recorded)'
      : t.costIsPlaceholder ? 'spend — PLACEHOLDER pricing, not usable'
      : t.costUnpriced > 0 ? 'spend — ' + t.costUnpriced + '/' + t.costSessions + ' unpriced'
      : 'estimated spend',
  );
  kpi(fmtTokens(t.dropped), 'tokens compacted away');
  L.push('</div>');

  // --- projects ---
  L.push('<h2>Projects, by activity</h2>');
  if (atlas.projects.length === 0) {
    L.push('<div class="note">No projects in this window.</div>');
  } else {
    const maxTurns = Math.max(...atlas.projects.map((p) => p.turns), 1);
    L.push('<table><thead><tr><th>project</th><th>top model</th><th class="num">sessions</th><th class="num">turns</th>' +
      '<th class="num">size</th><th class="num">est. $</th><th class="num">compactions</th><th class="num">errors</th></tr></thead><tbody>');
    for (const p of atlas.projects) {
      const top = p.models[0];
      L.push('<tr><td><div class="mono">' + escapeHtml(p.name) + '</div>' +
        (p.cwd ? '<div class="sub">' + escapeHtml(p.cwd) + '</div>' : '') +
        '<div class="track"><span class="fill" style="width:' + barWidth(p.turns, maxTurns) + '%"></span></div></td>' +
        '<td class="mono">' + escapeHtml(top ? top[0] : '—') + '</td>' +
        '<td class="num">' + p.sessions + '</td>' +
        '<td class="num">' + p.turns + '</td>' +
        '<td class="num">' + fmtBytes(p.bytes) + '</td>' +
        '<td class="num">' + (p.costKnown ? p.costUSD.toFixed(0) + (p.costUnpriced === p.costSessions ? ' <span class="tag warn">unpriced</span>' : '') : '—') + '</td>' +
        '<td class="num">' + p.compactions + '</td>' +
        '<td class="num">' + p.errors + '</td></tr>');
    }
    L.push('</tbody></table>');
    L.push('<p class="sub">Projects are the encoded working directory Claude Code stores per session. ' +
      'Spend is the client pricing-table estimate and covers only sessions that carried a cost record.</p>');
  }

  // --- models ---
  L.push('<h2>Which model actually answered</h2>');
  if (atlas.models.length === 0) {
    L.push('<div class="note">No assistant turns recorded.</div>');
  } else {
    const maxTurns = Math.max(...atlas.models.map((m) => m.turns), 1);
    L.push('<table><thead><tr><th>model</th><th class="num">turns</th><th class="num">share</th></tr></thead><tbody>');
    const total = atlas.models.reduce((sum, m) => sum + m.turns, 0) || 1;
    for (const m of atlas.models) {
      L.push('<tr><td><div class="mono">' + escapeHtml(m.model) + '</div>' +
        '<div class="track"><span class="fill" style="width:' + barWidth(m.turns, maxTurns) + '%"></span></div></td>' +
        '<td class="num">' + m.turns + '</td>' +
        '<td class="num">' + ((m.turns / total) * 100).toFixed(0) + '%</td></tr>');
    }
    L.push('</tbody></table>');
  }

  // --- substitutions ---
  L.push('<h2>Model substitution</h2>');
  if (atlas.substitutions.length === 0) {
    const unmeasured = atlas.familiarity.substitution === 'unmeasured';
    L.push('<div class="note ' + (unmeasured ? 'warn' : '') + '">' +
      (unmeasured
        ? 'Not measurable: no record carries the requested model id.'
        : 'None observed: every turn that named a requested model was answered by a compatible one.') +
      '</div>');
  } else {
    const maxTurns = Math.max(...atlas.substitutions.map((s) => s.turns), 1);
    L.push('<table><thead><tr><th>requested</th><th>answered by</th><th class="num">turns</th><th>projects</th></tr></thead><tbody>');
    for (const s of atlas.substitutions) {
      L.push('<tr><td class="mono">' + escapeHtml(s.requested) + '</td>' +
        '<td class="mono">' + escapeHtml(s.actual) + '<div class="track"><span class="fill warn" style="width:' + barWidth(s.turns, maxTurns) + '%"></span></div></td>' +
        '<td class="num">' + s.turns + '</td>' +
        '<td class="sub">' + escapeHtml(s.projects.slice(0, 3).join(', ')) + (s.projects.length > 3 ? ' +' + (s.projects.length - 3) : '') + '</td></tr>');
    }
    L.push('</tbody></table>');
    L.push('<p class="sub">An alias you chose yourself (a family name resolving to a dated snapshot) is excluded. ' +
      'A row here means the id you asked for did not answer; pricing and cache identity follow the answer.</p>');
  }

  // --- compaction ---
  if (atlas.compactions.length > 0) {
    L.push('<h2>Context compaction</h2>');
    L.push('<table><thead><tr><th>when</th><th>project</th><th>trigger</th><th class="num">before</th><th class="num">after</th><th class="num">dropped</th></tr></thead><tbody>');
    for (const c of atlas.compactions.slice(0, 25)) {
      L.push('<tr><td class="mono">' + escapeHtml(String(c.at || '').slice(0, 16).replace('T', ' ')) + '</td>' +
        '<td class="mono">' + escapeHtml(c.project) + '</td>' +
        '<td>' + escapeHtml(c.trigger) + '</td>' +
        '<td class="num">' + fmtTokens(c.pre) + '</td>' +
        '<td class="num">' + fmtTokens(c.post) + '</td>' +
        '<td class="num">' + fmtTokens(c.dropped) + '</td></tr>');
    }
    L.push('</tbody></table>');
    L.push('<p class="sub">' + atlas.compactions.length + ' boundary record(s); showing the most recent 25. ' +
      'Everything above a boundary is gone from the model view, so anything it read earlier has to be re-read from disk.</p>');
  }

  // --- errors ---
  if (atlas.errors.length > 0) {
    L.push('<h2>Upstream errors</h2>');
    L.push('<table><thead><tr><th>status</th><th>message</th><th class="num">count</th><th class="num">retried</th></tr></thead><tbody>');
    for (const e of atlas.errors.slice(0, 15)) {
      L.push('<tr><td class="num">' + escapeHtml(String(e.status === null || e.status === undefined ? 'n/a' : e.status)) + '</td>' +
        '<td class="mono">' + escapeHtml(e.message.slice(0, 160)) + '</td>' +
        '<td class="num">' + e.count + '</td>' +
        '<td class="num">' + e.retried + '</td></tr>');
    }
    L.push('</tbody></table>');
    L.push('<p class="sub">A retried turn that recovered looks identical to a clean one in the UI. It is why the turn was slow.</p>');
  }

  // --- install checks ---
  if (atlas.checks.length > 0) {
    L.push('<h2>Installation</h2>');
    L.push('<table><thead><tr><th>check</th><th>state</th><th>detail</th></tr></thead><tbody>');
    for (const c of atlas.checks) {
      L.push('<tr><td class="mono">' + escapeHtml(c.id) + '</td>' +
        '<td><span class="tag ' + tone(c.level) + '">' + escapeHtml(c.level) + '</span></td>' +
        '<td class="sub">' + escapeHtml(c.detail) + '</td></tr>');
    }
    L.push('</tbody></table>');
  }

  // --- footer ---
  L.push('<footer>');
  L.push('<b>Where these numbers come from.</b> Claude Code writes one JSONL file per session under its ' +
    'config directory; this page only reads them. Nothing was uploaded and no API was called. ' +
    'Spend is the client pricing-table estimate, never a bill. A count that could not be taken is labelled ' +
    'unmeasured, not zero.');
  L.push('<br><br>Static page: no scripts, no fonts, no network. Regenerate with ' +
    '<span class="mono">node src/cf-atlas.mjs --since ' + escapeHtml(atlas.window) + '</span>.</footer>');
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
