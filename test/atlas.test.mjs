/**
 * The atlas aggregates — and aggregation is where a wrong number hides.
 *
 * Two real defects from this machine's own logs are pinned here:
 *   1. `cumulativeDroppedTokens` is cumulative per Session, so summing it over
 *      boundaries inflated 7.7M of real drops into 26.2M.
 *   2. A resumed session replays its history into a new file. 398 files held only
 *      330 ids, one session appeared in 17 files with the same cumulative cost in
 *      each, and summing them turned ~$397 into $3,566.
 *
 * Neither produced an error. Both produced a confident, plausible, wrong total.
 */
import { describe, it, expect } from 'vitest';
import { buildAtlas, escapeHtml, barWidth } from '../src/cf-atlas.mjs';
import { summarizeSession, dedupeResumed } from '../src/cf-analyze.mjs';

const boundary = (pre, post, cumulative, at = '2026-11-14T10:00:00Z') => ({
  type: 'system', subtype: 'compact_boundary', timestamp: at,
  compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, cumulativeDroppedTokens: cumulative },
});

const asst = (model = 'm', requested = 'r') => ({
  type: 'assistant', timestamp: '2026-11-14T09:00:00Z', requestedModel: requested,
  message: { role: 'assistant', model, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 }, content: [] },
});

const costState = (usd, unknown = false) => ({ type: 'cost-state', totalCostUSD: usd, modelUsage: {}, hasUnknownModelCost: unknown });

const session = (id, records, over = {}) => {
  const s = summarizeSession(records);
  s.sessionId = id;
  s.size = 1000;
  s.project = 'p';
  Object.assign(s, over);
  return s;
};

describe('compaction drop accounting', () => {
  it('should count the per-event drop, not the session cumulative', () => {
    // Real shape: pre 169880 / post 20278 with cumulative 297801 (two boundaries so far)
    const s = summarizeSession([boundary(169880, 20278, 297801)]);
    expect(s.compactions[0].dropped).toBe(149602);
    expect(s.compactions[0].cumulativeDropped).toBe(297801);
  });

  it('should not multiply a session drops count by its boundary count', () => {
    const a = session('s1', [boundary(169880, 20278, 149602), boundary(166837, 18774, 297801, '2026-11-14T11:00:00Z')]);
    const atlas = buildAtlas([a], { window: '30d' });
    // 149602 + 148063, not 149602 + 297801
    expect(atlas.totals.dropped).toBe(297665);
  });
});

describe('resumed sessions', () => {
  it('should keep only the newest file per session id', () => {
    // One session replayed into three files, each carrying the same cumulative cost.
    const files = [
      session('dup', [asst()], { mtimeMs: 100 }),
      session('dup', [asst()], { mtimeMs: 300 }),
      session('dup', [asst()], { mtimeMs: 200 }),
    ];
    const kept = dedupeResumed(files);
    expect(kept).toHaveLength(1);
    expect(kept[0].mtimeMs).toBe(300);
  });

  it('should not multiply the spend of a resumed session', () => {
    const files = [
      session('dup', [asst(), costState(10)], { mtimeMs: 100 }),
      session('dup', [asst(), costState(10)], { mtimeMs: 200 }),
      session('dup', [asst(), costState(10)], { mtimeMs: 300 }),
    ];
    const atlas = buildAtlas(dedupeResumed(files), { window: '30d' });
    expect(atlas.totals.costUSD).toBe(10);
  });
});

describe('forked session replays', () => {
  /**
   * The defect this pins: a fork writes a NEW session id but replays the parent's
   * boundary records verbatim. Dedupe-by-id cannot see that, so the page counted
   * each replay while the CLI deduped at the rollup layer — same 30-day window,
   * 120 boundaries / 19.4M on the page against 119 / 19.2M in the terminal.
   */
  const err = (at, status = 429, message = 'exceed quota limit') => ({
    type: 'system', subtype: 'api_error', timestamp: at,
    error: { status, message: JSON.stringify({ error: { message } }) }, retryAttempt: 1,
  });

  it('should count a replayed boundary once even under a different session id', () => {
    const at = '2026-11-14T10:00:00Z';
    const parent = session('parent', [boundary(169880, 20278, 149602, at)]);
    const fork = session('fork', [boundary(169880, 20278, 149602, at)]); // same record, new id
    const atlas = buildAtlas([parent, fork], { window: '30d' });
    expect(atlas.compactions).toHaveLength(1);
    expect(atlas.totals.dropped).toBe(149602);
  });

  it('should keep two genuinely distinct boundaries on the same day', () => {
    const a = session('a', [boundary(169880, 20278, 149602, '2026-11-14T10:00:00Z')]);
    const b = session('b', [boundary(166837, 18774, 148063, '2026-11-14T11:00:00Z')]);
    const atlas = buildAtlas([a, b], { window: '30d' });
    expect(atlas.compactions).toHaveLength(2);
    expect(atlas.totals.dropped).toBe(297665);
  });

  it('should count a replayed error once', () => {
    const at = '2026-11-14T10:00:00Z';
    const atlas = buildAtlas([session('a', [err(at)]), session('b', [err(at)])], { window: '30d' });
    expect(atlas.errors).toHaveLength(1);
    expect(atlas.errors[0].count).toBe(1);
  });

  it('should apply the same rule to the day strip', async () => {
    const { dailyRows } = await import('../src/cf-atlas.mjs');
    const at = '2026-11-14T10:00:00Z';
    const rows = dailyRows([session('a', [boundary(169880, 20278, 149602, at)]), session('b', [boundary(169880, 20278, 149602, at)])], 0);
    const day = rows.find((r) => r.day === '2026-11-14');
    expect(day.compactions).toBe(1);
    expect(day.dropped).toBe(149602);
  });
});

describe('cost reliability', () => {
  it('should mark a total built entirely on unknown-model prices as a placeholder', () => {
    const s = session('s', [asst(), costState(5, true)]);
    const atlas = buildAtlas([s], { window: '30d' });
    expect(atlas.totals.costIsPlaceholder).toBe(true);
    expect(atlas.totals.costUnpriced).toBe(1);
  });

  it('should not mark a priced total as a placeholder', () => {
    const s = session('s', [asst(), costState(5, false)]);
    const atlas = buildAtlas([s], { window: '30d' });
    expect(atlas.totals.costIsPlaceholder).toBe(false);
  });

  it('should count a session with no cost record as unknown, not as zero', () => {
    const atlas = buildAtlas([session('s', [asst()])], { window: '30d' });
    expect(atlas.totals.costUSD).toBeNull();
  });
});

describe('project rollup', () => {
  it('should attribute turns and the top model per project', () => {
    const a = session('s1', [asst('alpha'), asst('alpha'), asst('beta')], { project: 'proj-a' });
    const atlas = buildAtlas([a], { window: '30d' });
    expect(atlas.projects[0].name).toBe('proj-a');
    expect(atlas.projects[0].turns).toBe(3);
    expect(atlas.projects[0].models[0][0]).toBe('alpha');
  });

  it('should track unpriced cost per project', () => {
    const a = session('s1', [asst(), costState(4, true)], { project: 'proj-a' });
    const atlas = buildAtlas([a], { window: '30d' });
    expect(atlas.projects[0].costUnpriced).toBe(1);
    expect(atlas.projects[0].costSessions).toBe(1);
  });
});

describe('rendering safety', () => {
  it('should escape a model id that contains markup', () => {
    // Model ids come from a log file; a relay could name one <img onerror=...>.
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(escapeHtml("it's")).toContain('&#39;');
  });

  it('should cap a bar so a runaway value cannot overflow the cell', () => {
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(1e9, 100)).toBe(100);
    expect(barWidth(0, 100)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
  });

  it('should emit no script tag and no remote reference', async () => {
    // A local report that phones home, or runs code, is not a local report.
    const { renderHtml } = await import('../src/cf-atlas.mjs');
    const html = renderHtml(buildAtlas([session('s', [asst(), costState(1, true)])], { window: '30d' }));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
