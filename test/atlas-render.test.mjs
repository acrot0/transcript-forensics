/**
 * Presentation contracts for the atlas.
 *
 * Design decisions that a screenshot cannot verify: the page must stay offline,
 * the numbers must be derived from the data (never written by hand), and the
 * grouping must not split one fault into several rows.
 */
import { describe, it, expect } from 'vitest';
import { renderHtml, buildAtlas, errorCause, findingOf, dailyRows, num, pctOf, dayLabel } from '../src/cf-atlas.mjs';
import { summarizeSession } from '../src/cf-analyze.mjs';

const asst = (model = 'a', requested = 'b') => ({
  type: 'assistant', timestamp: '2026-11-14T09:00:00Z', requestedModel: requested,
  message: { role: 'assistant', model, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 }, content: [] },
});

const err = (message, status = 429, retry = 1) => ({
  type: 'system', subtype: 'api_error', timestamp: '2026-11-14T09:00:00Z',
  error: { message, status, formatted: status + ' ' + message }, retryAttempt: retry, maxRetries: 10,
});

const session = (id, records, over = {}) => {
  const s = summarizeSession(records);
  s.sessionId = id; s.size = 1000; s.project = 'p';
  Object.assign(s, over);
  return s;
};

describe('errorCause', () => {
  it('should reduce repeated occurrences of one fault to the same cause', () => {
    // A provider echoes a per-request id inside the message. Grouping on the raw
    // string printed one quota fault as five separate rows of 2.
    const a = errorCause({ formatted: '429 ZCode: quota [2026111401452010a311c8ecf24e59]' });
    const b = errorCause({ formatted: '429 ZCode: quota [2026111401452337540c79bb8248ad]' });
    expect(a).toBe(b);
    expect(a).not.toMatch(/2026111/);
  });

  it('should drop the status, which has its own column', () => {
    expect(errorCause({ formatted: '429 429 ZCode: exceed quota limit' })).toBe('ZCode: exceed quota limit');
    expect(errorCause({ formatted: '429 ZCode: exceed quota limit' })).toBe('ZCode: exceed quota limit');
  });

  it('should strip trace and request id forms', () => {
    expect(errorCause({ message: 'boom request_id=trace_8e86a28d-6966-4efe-bd85-ef9f86838191' })).toBe('boom');
  });

  it('should keep errors that really differ apart', () => {
    expect(errorCause({ formatted: '429 exceed quota' })).not.toBe(errorCause({ formatted: '429 no left credit' }));
  });

  it('should not throw on an empty record', () => {
    expect(errorCause({})).toBe('');
    expect(errorCause(null)).toBe('');
  });
});

describe('numbers', () => {
  it('should print a real zero as zero and a missing value as a dash', () => {
    // A zero and "not measured" must never look alike (§7.5).
    expect(num(0)).toBe('0');
    expect(num(null)).toContain('—');
    expect(pctOf(0)).toBe('0.0%');
    expect(pctOf(null)).toContain('—');
  });

  it('should label a day without a leading zero', () => {
    expect(dayLabel('2026-11-07')).toBe('7 Nov');
    expect(dayLabel('2026-01-31')).toBe('31 Jan');
  });
});

describe('dailyRows', () => {
  it('should emit interior days with no activity instead of closing the gap', () => {
    // Skipping empty days turns a two-week pause into continuous work.
    const a = session('a', [asst()], { startsAt: '2026-11-01T10:00:00Z', endsAt: '2026-11-01T11:00:00Z' });
    const b = session('b', [asst()], { startsAt: '2026-11-04T10:00:00Z', endsAt: '2026-11-04T11:00:00Z' });
    const rows = dailyRows([a, b], 0);
    expect(rows.map((r) => r.day)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(rows[1].turns).toBe(0);
  });
});

describe('findingOf', () => {
  it('should derive the sentence from the data, not from a constant', () => {
    const one = buildAtlas([session('s', [asst('x', 'y'), err('quota')])], { window: '7d' });
    const two = buildAtlas([session('s', [asst(), asst()])], { window: '7d' });
    expect(findingOf(one)).toContain('x');
    expect(findingOf(two)).not.toContain('compaction discarded');
  });

  it('should say so plainly when there is nothing to flag', () => {
    expect(findingOf({ totals: { dropped: 0, costIsPlaceholder: false, costUnpriced: 0 }, substitutions: [], compactions: [] }))
      .toMatch(/Nothing worth flagging/);
  });
});

describe('the page', () => {
  const atlas = buildAtlas([session('s', [asst('answered', 'requested'), err('quota [deadbeefdeadbeef]')])], { window: '7d' });

  it('should stay offline: no script, no remote asset, no font link', () => {
    const html = renderHtml(atlas);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import/);
  });

  it('should carry the product name and the scope in the masthead', () => {
    const html = renderHtml(atlas);
    expect(html).toContain('Claude Code forensics');
    expect(html).toMatch(/class="scope"/);
  });

  it('should answer a question with an h1 and a finding', () => {
    const html = renderHtml(atlas);
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toMatch(/class="finding"/);
  });

  it('should print a placeholder-price warning instead of a bare estimate', () => {
    const withCost = buildAtlas([session('s', [asst(), { type: 'cost-state', totalCostUSD: 9, modelUsage: {}, hasUnknownModelCost: true }])], { window: '7d' });
    const html = renderHtml(withCost);
    expect(html).toMatch(/placeholder/i);
  });

  it('should stop and say so when the log format is unrecognised', () => {
    const s = summarizeSession([{ type: 'assistant', message: { modelId: 'm' } }]);
    s.sessionId = 'x'; s.size = 1; s.project = 'p';
    const html = renderHtml(buildAtlas([s], { window: '7d' }));
    expect(html).toMatch(/Not measured/i);
    // and it must not go on to print a table of zeroes underneath
    expect(html).not.toMatch(/<table/);
  });

  it('should say it measured nothing when there are no sessions', () => {
    const html = renderHtml(buildAtlas([], { window: '7d' }));
    expect(html).toMatch(/no sessions/i);
    expect(html).not.toMatch(/<table/);
  });
});
